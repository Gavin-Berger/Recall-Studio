// Recall Studio — local UDP stress sender (DEV TOOL, not shipped).
//
// Simulates the Max for Live bridge so the Rust pipeline can be load-tested
// without Ableton. Sends recall.v2 packets to 127.0.0.1:9000.
//
// Usage:
//   node scripts/stress-sender.mjs --rate 100 --seconds 10
//   node scripts/stress-sender.mjs --burst 500
//   node scripts/stress-sender.mjs --mode malformed --rate 50 --seconds 5
//   node scripts/stress-sender.mjs --mode oversized --rate 20 --seconds 5
//   node scripts/stress-sender.mjs --mode params --rate 200 --seconds 10
//   node scripts/stress-sender.mjs --mode snapshots --rate 100 --seconds 10
//
// Modes:
//   mixed     (default) realistic mix of creative + noisy events
//   params    repeated parameter_changed (coalescible — should shed under load)
//   snapshots repeated transport/focus snapshots (coalescible)
//   malformed truncated / non-JSON packets (must be counted, never crash)
//   oversized payloads larger than the bridge cap (must not truncate-corrupt)
//
// Start a capture session in the app first, then read /metrics via the
// get_bridge_metrics Tauri command to validate.

import dgram from "node:dgram";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, cur, i, arr) => {
    if (cur.startsWith("--")) acc.push([cur.slice(2), arr[i + 1]]);
    return acc;
  }, []),
);

const HOST = "127.0.0.1";
const PORT = 9000;
const mode = args.mode ?? "mixed";
const rate = Number(args.rate ?? 100); // events per second
const seconds = Number(args.seconds ?? 10);
const burst = args.burst ? Number(args.burst) : 0;

const socket = dgram.createSocket("udp4");
let sent = 0;
let seq = 0;

function envelope(eventType, fields = {}, payload = {}) {
  seq += 1;
  return JSON.stringify({
    protocol: "recall.v2",
    source: "stress_sender",
    event_type: eventType,
    timestamp_ms: Date.now(),
    title: eventType,
    description: "stress",
    payload: { ...payload, _bridge: { sequence: seq } },
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
      // Half non-JSON garbage, half truncated JSON.
      return seq++ % 2 === 0 ? "this is not json at all" : '{"protocol":"recall.v2","event_t';
    case "oversized": {
      const huge = "x".repeat(20000); // > bridge 8192 cap and > 16384 recv buffer
      return envelope("live_set_snapshot", {}, { blob: huge });
    }
    case "params":
      return NOISY[0]();
    case "snapshots":
      return NOISY[1]();
    case "mixed":
    default:
      // ~1 creative per 10 noisy, like a real session.
      return seq % 10 === 0
        ? CREATIVE[seq % CREATIVE.length]()
        : NOISY[seq % NOISY.length]();
  }
}

function send(msg) {
  const buf = Buffer.from(msg);
  socket.send(buf, PORT, HOST, (err) => {
    if (err) console.error("send error", err);
  });
  sent += 1;
}

async function run() {
  console.log(
    `[stress] mode=${mode} ${burst ? `burst=${burst}` : `rate=${rate}/s for ${seconds}s`} -> ${HOST}:${PORT}`,
  );

  if (burst > 0) {
    for (let i = 0; i < burst; i++) send(nextPacket());
    console.log(`[stress] burst sent ${sent} packets`);
    setTimeout(() => socket.close(), 500);
    return;
  }

  const intervalMs = 1000 / rate;
  const endAt = Date.now() + seconds * 1000;
  const timer = setInterval(() => {
    if (Date.now() >= endAt) {
      clearInterval(timer);
      console.log(`[stress] done — sent ${sent} packets`);
      setTimeout(() => socket.close(), 500);
      return;
    }
    send(nextPacket());
  }, intervalMs);
}

run();
