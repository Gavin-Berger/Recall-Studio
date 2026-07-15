// Recall Studio — local UDP stress harness (DEV TOOL, not shipped).
//
// Simulates the Max for Live bridge so the Rust pipeline can be load-tested
// without Ableton, and VERIFIES what actually landed. Sends recall.v2 packets
// to 127.0.0.1:9000, then reads the app's SQLite file and asserts that every
// protected event survived.
//
// Usage:
//   node scripts/stress-sender.mjs --burst 2000 --mode critical --verify
//   node scripts/stress-sender.mjs --rate 100 --seconds 10 --verify
//   node scripts/stress-sender.mjs --burst 20000 --verify        # past the 4096 queue
//   node scripts/stress-sender.mjs --mode malformed --rate 50 --seconds 5
//
// Flags:
//   --burst N        fire N packets as fast as the OS accepts them
//   --rate N         paced sends per second (with --seconds)
//   --seconds N      duration for paced mode
//   --verify         read the DB and assert sent == persisted, zero gaps.
//                    Exits NON-ZERO on any loss of a protected event.
//   --db <path>      override the database location
//
// Modes:
//   mixed     (default) realistic mix — 1 protected creative per 10 noisy
//   critical  Critical events only — the strongest assertion available
//   params    repeated parameter_changed (Important — protected, must not shed)
//   snapshots repeated transport_snapshot (Coalescible — MAY shed under load)
//   malformed truncated / non-JSON packets (must be counted, never crash)
//   oversized payloads past the bridge cap (must not truncate-corrupt)
//
// WHY THIS FILE WAS REWRITTEN (2026-07-15, eng review task E1)
// The previous version could not verify anything, and PRD §8 cited it as proof
// of "zero critical-event loss". Three defects, all measured:
//   1. `sent` was incremented at CALL time, not in the dgram send callback.
//      dgram.send is async and queues — "sent 20000" meant "enqueued 20000".
//   2. socket.close() fired on a 500ms timer after firing N async sends, so any
//      backlog was discarded AT THE SENDER and misread as app-side loss.
//   3. mixed mode fired creative on `seq % 10 === 0` then indexed
//      CREATIVE[seq % 4]. A multiple of 10 mod 4 is always 0 or 2, so
//      clip_created and device_chain_changed were NEVER sent. Not once.
// It also asserted nothing, which is how a 29% loss rate hid inside the
// "verified" test. Measured after this rewrite: 2,000 Critical, OS-confirmed
// 2,000/2,000 sends — burst ~80k/s persisted 407 (80% lost); paced ~500/s
// persisted 2,000 (0% lost).

import dgram from "node:dgram";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import process from "node:process";

const HOST = "127.0.0.1";
const PORT = 9000;

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, cur, i, arr) => {
    if (cur.startsWith("--")) acc.push([cur.slice(2), arr[i + 1]]);
    return acc;
  }, []),
);

const mode = args.mode ?? "mixed";
const rate = Number(args.rate ?? 100);
const seconds = Number(args.seconds ?? 10);
const burst = args.burst ? Number(args.burst) : 0;
const verify = "verify" in args;
const DEFAULT_DB = path.join(
  process.env.APPDATA ?? "",
  "com.gberg.recall-studio",
  "recall-studio.sqlite",
);
const dbPath = args.db ?? DEFAULT_DB;

// Priority per src-tauri/src/event_catalog.rs. Only Coalescible may be shed
// under load; Critical and Important must survive or the pipeline is broken.
// NOTE: parameter_changed is Important, NOT Coalescible — it is protected.
const PRIORITY = {
  device_added: "Critical",
  clip_created: "Critical",
  track_created: "Critical",
  device_chain_changed: "Critical",
  parameter_changed: "Important",
  transport_snapshot: "Coalescible",
  track_selected: "Coalescible",
  beat_time_changed: "Coalescible",
};
const isProtected = (t) => PRIORITY[t] === "Critical" || PRIORITY[t] === "Important";

// One device_id per run. The app's gap detection is per-device_id (the bridge's
// sequence resets to 0 on device reload), and this also isolates a run's rows
// from every prior run's, so verification needs no baseline arithmetic.
const RUN_ID = `stress-${Date.now().toString(36)}-${process.pid}`;

const socket = dgram.createSocket("udp4");
let seq = 0;
let creativeIndex = 0;
let enqueued = 0;
let confirmed = 0;
let sendErrors = 0;
const errorKinds = {};
const sentByType = {};

function envelope(eventType, fields = {}, payload = {}) {
  seq += 1;
  sentByType[eventType] = (sentByType[eventType] ?? 0) + 1;
  return JSON.stringify({
    protocol: "recall.v2",
    source: "stress_sender",
    event_type: eventType,
    timestamp_ms: Date.now(),
    title: eventType,
    description: "stress",
    payload: {
      ...payload,
      _bridge: { device_id: RUN_ID, bridge_version: "0.17.0", sequence: seq },
    },
    session_id: null,
    ...fields,
  });
}

const CREATIVE = [
  () => envelope("device_added", { track_name: "Bass", device_name: "Serum 2", device_chain: "Serum 2 : Saturator" }),
  () => envelope("clip_created", { track_name: "Drums", clip_name: "Loop A" }),
  () => envelope("track_created", { track_name: "Vocal " + seq }),
  () => envelope("device_chain_changed", { track_name: "Lead", device_chain: "Operator : EQ Eight : Reverb" }),
];
const NOISY = [
  () => envelope("parameter_changed", { parameter_name: "Cutoff", parameter_value: Math.random() }),
  () => envelope("transport_snapshot", {}, { tempo: 120 + (seq % 5), playing: true }),
  () => envelope("track_selected", { track_name: "Track " + (seq % 40) }),
  () => envelope("beat_time_changed", {}, { beat_time: seq % 16 }),
];

function nextPacket() {
  switch (mode) {
    case "malformed":
      return seq++ % 2 === 0 ? "this is not json at all" : '{"protocol":"recall.v2","event_t';
    case "oversized":
      return envelope("live_set_snapshot", {}, { blob: "x".repeat(20000) });
    case "critical":
      // Dedicated counter — NOT seq % 4. That was the bug that meant
      // clip_created never sent.
      return CREATIVE[creativeIndex++ % CREATIVE.length]();
    case "params":
      return NOISY[0]();
    case "snapshots":
      return NOISY[1]();
    case "mixed":
    default:
      return seq % 10 === 0 ? CREATIVE[creativeIndex++ % CREATIVE.length]() : NOISY[seq % NOISY.length]();
  }
}

// Resolves only when the OS has accepted (or rejected) the datagram. Counting
// here rather than at call time is the whole point of the rewrite.
function sendOne(msg) {
  return new Promise((resolve) => {
    enqueued += 1;
    socket.send(Buffer.from(msg), PORT, HOST, (err) => {
      if (err) {
        sendErrors += 1;
        const k = err.code ?? String(err);
        errorKinds[k] = (errorKinds[k] ?? 0) + 1;
      } else {
        confirmed += 1;
      }
      resolve();
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Open the app's DB for reading, retrying while it's busy.
//
// The app writes in WAL mode. Right after a burst it is committing hard, and a
// reader attaching mid-recovery gets SQLITE_BUSY_RECOVERY (261) rather than
// waiting politely. readOnly also blocks the reader from performing WAL
// recovery itself, so a plain readOnly open can fail outright. Retry with
// backoff, then fall back to a read-write handle which is allowed to recover.
async function openDbWithRetry(p, attempts = 12) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    for (const readOnly of [true, false]) {
      try {
        const db = new DatabaseSync(p, { readOnly });
        db.exec("PRAGMA busy_timeout = 5000;");
        db.prepare("SELECT 1").get(); // prove the handle actually works
        return db;
      } catch (e) {
        lastErr = e;
      }
    }
    await sleep(250 * (i + 1));
  }
  throw lastErr;
}

// Poll until the row count stops climbing, so we measure a settled pipeline
// rather than racing the persistence worker.
async function waitForDrain(db, maxMs = 15000) {
  let last = -1;
  let stable = 0;
  const started = Date.now();
  const stmt = db.prepare(
    `SELECT COUNT(*) AS n FROM events WHERE json_extract(payload,'$._bridge.device_id') = ?`,
  );
  while (Date.now() - started < maxMs) {
    await sleep(400);
    const n = stmt.get(RUN_ID).n;
    if (n === last) {
      if (++stable >= 3) return n;
    } else {
      stable = 0;
      last = n;
    }
  }
  return last;
}

function report(persistedByType, gaps, persistedTotal) {
  const rows = [];
  let protectedSent = 0;
  let protectedLost = 0;

  for (const [type, sent] of Object.entries(sentByType).sort()) {
    const got = persistedByType[type] ?? 0;
    const lost = sent - got;
    const pri = PRIORITY[type] ?? "?";
    if (isProtected(type)) {
      protectedSent += sent;
      protectedLost += Math.max(0, lost);
    }
    const flag = lost > 0 ? (isProtected(type) ? "<-- PROTECTED LOSS" : "(sheddable)") : "";
    rows.push(
      `  ${type.padEnd(22)} ${pri.padEnd(12)} sent ${String(sent).padStart(6)}   got ${String(got).padStart(6)}   lost ${String(lost).padStart(6)}  ${flag}`,
    );
  }

  console.log("\n" + "=".repeat(78));
  console.log(`  run ${RUN_ID}   mode=${mode}   ${burst ? `burst=${burst}` : `rate=${rate}/s x ${seconds}s`}`);
  console.log("=".repeat(78));
  console.log(`  enqueued        ${enqueued}`);
  console.log(`  OS-confirmed    ${confirmed}${sendErrors ? `   send errors ${sendErrors} ${JSON.stringify(errorKinds)}` : ""}`);
  console.log(`  persisted       ${persistedTotal}`);
  console.log(`  sequence gaps   ${gaps.total}${gaps.total ? `   ranges: ${gaps.ranges.slice(0, 6).join(", ")}${gaps.ranges.length > 6 ? " ..." : ""}` : ""}`);
  console.log("-".repeat(78));
  console.log(rows.join("\n"));
  console.log("-".repeat(78));

  if (sendErrors > 0) {
    console.log(`  NOTE: ${sendErrors} datagrams were rejected by the OS. Sender-side loss is`);
    console.log(`        NOT app loss — investigate before blaming the pipeline.`);
  }

  if (protectedLost > 0) {
    const pct = ((protectedLost / protectedSent) * 100).toFixed(1);
    console.log(`  FAIL: ${protectedLost}/${protectedSent} protected events lost (${pct}%).`);
    console.log(`        Critical and Important events must never be dropped (PRD §8).`);
    return 1;
  }
  console.log(`  PASS: all ${protectedSent} protected events survived. ${gaps.total} sequence gaps.`);
  return 0;
}

async function run() {
  console.log(
    `[stress] mode=${mode} ${burst ? `burst=${burst}` : `rate=${rate}/s for ${seconds}s`} -> ${HOST}:${PORT}${verify ? "  (verify on)" : ""}`,
  );

  const t0 = Date.now();
  if (burst > 0) {
    const pending = [];
    for (let i = 0; i < burst; i++) pending.push(sendOne(nextPacket()));
    await Promise.all(pending); // drain fully — never close mid-flush
  } else {
    const intervalMs = 1000 / rate;
    const endAt = Date.now() + seconds * 1000;
    const pending = [];
    while (Date.now() < endAt) {
      pending.push(sendOne(nextPacket()));
      await sleep(intervalMs);
    }
    await Promise.all(pending);
  }
  const elapsed = Date.now() - t0;
  socket.close();

  console.log(
    `[stress] enqueued ${enqueued}, OS-confirmed ${confirmed}, errors ${sendErrors} in ${elapsed}ms (${Math.round(confirmed / (elapsed / 1000))}/s)`,
  );

  if (!verify) {
    console.log("[stress] no --verify: nothing was checked. Pass --verify to assert.");
    return 0;
  }
  if (mode === "malformed" || mode === "oversized") {
    console.log(`[stress] mode=${mode} is a crash/robustness probe — nothing should persist.`);
    console.log("[stress] check the app's metrics for malformed/oversized counters.");
    return 0;
  }

  let db;
  try {
    db = await openDbWithRetry(dbPath);
  } catch (e) {
    console.error(`[stress] cannot open DB at ${dbPath}: ${e.message}`);
    console.error("[stress] is the app running? pass --db <path> to override.");
    return 2;
  }

  const persistedTotal = await waitForDrain(db);
  const rows = db.prepare(
    `SELECT event_type,
            CAST(json_extract(payload,'$._bridge.sequence') AS INTEGER) AS seq
     FROM events
     WHERE json_extract(payload,'$._bridge.device_id') = ?`,
  ).all(RUN_ID);

  const persistedByType = {};
  const seen = new Set();
  for (const r of rows) {
    persistedByType[r.event_type] = (persistedByType[r.event_type] ?? 0) + 1;
    if (r.seq !== null) seen.add(r.seq);
  }

  // Gaps against the contiguous range this run actually sent.
  const gaps = { total: 0, ranges: [] };
  let runStart = null;
  for (let i = 1; i <= seq; i++) {
    if (seen.has(i)) {
      if (runStart !== null) {
        gaps.ranges.push(runStart === i - 1 ? `${runStart}` : `${runStart}-${i - 1}`);
        runStart = null;
      }
    } else {
      gaps.total += 1;
      if (runStart === null) runStart = i;
    }
  }
  if (runStart !== null) gaps.ranges.push(runStart === seq ? `${runStart}` : `${runStart}-${seq}`);

  const code = report(persistedByType, gaps, persistedTotal);
  db.close();
  return code;
}

process.exitCode = await run();
