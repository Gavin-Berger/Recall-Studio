# Ableton → Bridge → JSON → Rust → Storage: Architecture & Data Path

**Audience:** a senior backend / integration engineer reviewing this pipeline cold.
**Purpose:** explain *how* Ableton state actually reaches the app, what crosses each
boundary, the threading model, and — bluntly — where the design is weak.

This is the mechanism doc. The wire *contract* (field names, event vocabulary) lives in
[`recall-protocol-v2.md`](./recall-protocol-v2.md) and is not repeated here.

---

## 0. One-paragraph summary

Recall Studio captures a producer's creative activity in Ableton Live. A Max for Live
(M4L) device runs a JavaScript bridge that **polls** Ableton's object model on timers,
**diffs** each reading against the last known value, and emits discrete JSON events over
**UDP** to a local Rust listener (Tauri desktop app). Rust normalizes, classifies,
queues, batch-writes to SQLite, and pushes to the React UI. There is **no event-driven
push from Ableton** and **no delivery guarantee on the wire** — both are deliberate, and
both are the first things a reviewer should pressure-test.

```
┌──────────┐  LiveAPI.get/getcount  ┌──────────────┐  outlet→udpsend  ┌──────────────┐
│ Ableton  │ ─────(poll, pull)────▶ │  bridge JS   │ ───UDP :9000───▶ │ Rust listener│
│ Live LOM │ ◀─── array-wrapped ─── │ (in Max/M4L) │  fire-and-forget │  (Tauri app) │
└──────────┘     scalar values      └──────────────┘                  └──────┬───────┘
                                                                              │
                                            normalize → classify → bounded queue
                                                                              │
                                                              ┌───────────────▼────────┐
                                                              │ persistence worker     │
                                                              │ batch txn → SQLite(WAL) │
                                                              │ + emit "recall-event"  │
                                                              └───────────────┬────────┘
                                                                              │
                                                                     React timeline UI
```

Key source files:
- Bridge: [`m4l/recall_m4l_bridge.js`](../m4l/recall_m4l_bridge.js)
- UDP + normalize + queue + worker: [`src-tauri/src/udp_listener.rs`](../src-tauri/src/udp_listener.rs)
- Typed event: [`src-tauri/src/protocol.rs`](../src-tauri/src/protocol.rs)
- SQLite: [`src-tauri/src/storage.rs`](../src-tauri/src/storage.rs)

---

## 1. The boundary that surprises people: Ableton does not emit events

Max for Live exposes Ableton's running state through a single host object, **`LiveAPI`**,
which is a read-on-demand window into the **Live Object Model (LOM)**. The bridge *pulls*;
Ableton is passive. Nothing in Ableton says "the user selected a track." The bridge finds
out by reading the selected-track id on its next timer tick and noticing it differs from
the previous tick.

**Consequences a reviewer must weigh:**
- **Completeness is bounded by poll cadence.** Anything that happens and reverts between
  two ticks is never observed.
- **There is no causality** — the bridge infers "what changed" by diffing, it is not told.
- **The LOM *does* support property observers** (callbacks on change). This bridge
  deliberately does **not** use them for the hot paths; see §7 for the trade-off.

### 1.1 The two read primitives

Everything the bridge captures is built from exactly two LiveAPI calls:

| Call | Wrapper | What it does |
|---|---|---|
| `api.get("prop")` | [`get_prop`](../m4l/recall_m4l_bridge.js) (~L412) | Read one property of an LOM node |
| `api.getcount("child")` | [`get_count`](../m4l/recall_m4l_bridge.js) (~L434) | Count children of a type (tracks, scenes…) |

A `LiveAPI` handle is created by **path** into the LOM. Paths used here:

| Path | Node |
|---|---|
| `live_set` | the song (tempo, `is_playing`, counts) |
| `live_set view` | UI/view state — e.g. `selected_track` |
| `live_set tracks N` | the Nth track |
| `id N` | any node by its persistent numeric id |

`safe_path(path)` (~L408) wraps handle construction so a bad path returns null instead of
throwing.

### 1.2 The data Ableton hands back is loose and array-wrapped

This is the single most important low-level fact for a reviewer:

> **`LiveAPI.get()` returns an array even for a scalar.** `tempo` comes back as `[120]`.
> `selected_track` comes back as `["id", 47]`. Booleans arrive as `1`/`0`/`"1"`.

So the bridge's first job is taming it:
- `get_prop` unwraps single-element arrays (~L424).
- `value_to_number` / `value_to_bool` coerce mixed types (~L492, ~L502).
- `normalize_id` digs the numeric id out of `["id", 47]` shapes (~L446).

If you are reviewing for correctness, **this normalization layer is where silent data
corruption would hide** (e.g. a property that sometimes returns a 2-element array).

---

## 2. How a reading becomes a JSON event (worked example: track selection)

**Step 1 — Read current state into a plain object.**
`collect_transport_snapshot()` (~L518) reads `live_set` properties plus the selected
track. Note `selected_track_name` is a **second hop**: read the id from `live_set view`,
then build `safe_path("id <n>")` and read its `name` (`get_selected_track_name` ~L740 →
`collect_selected_track_basic` ~L750). One "selection" = several LiveAPI reads stitched
together.

```js
{ available:true, playing:false, tempo:120, current_song_time:16,
  signature_numerator:4, track_count:8, scene_count:4,
  selected_track_id:47, selected_track_name:"Bass" }
```

**Step 2 — Diff against remembered state.**
`send_transport_delta_if_changed()` (~L550) does *not* trust Ableton to report deltas:

1. `fingerprint(snapshot)` = `JSON.stringify` (~L506). If it equals the last fingerprint,
   return immediately — an unchanged tick emits nothing.
2. Otherwise compare specific fields to module-level globals (`lastSelectedTrackId`,
   `lastTempo`, `lastPlayingState`) and emit a **distinct event per kind of change**.

```js
if (snapshot.selected_track_id !== lastSelectedTrackId) {
  emit("track_selected", "...", { selected_track_id, selected_track_name },
                                 { track_name: snapshot.selected_track_name });
}
```

**Step 3 — `emit()` assembles + ships the packet** (~L1500). It builds the flat object,
**promotes canonical fields to the top level** (the 5th arg; `CANONICAL_FIELDS` ~L52),
increments a per-packet `sequence`, attaches a `_bridge` block, enforces a hard size cap,
then `outlet(0, json)` → the patcher's `udpsend 127.0.0.1 9000`.

```json
{
  "protocol": "recall.v2",
  "source": "max_for_live",
  "event_type": "track_selected",
  "timestamp_ms": 1716900000000,
  "title": "Track Selected",
  "description": "Selected Ableton track changed.",
  "track_name": "Bass",
  "payload": {
    "selected_track_id": 47,
    "selected_track_name": "Bass",
    "_bridge": { "device_id": "recall-m4l-bridge-dev", "bridge_version": "0.7.3", "sequence": 42 }
  },
  "session_id": null
}
```

The same value (`track_name`) appears **both** promoted at top level and inside `payload`.
That redundancy is intentional: top level is the canonical read path; `payload` is the
verbatim capture preserved for debugging and never overwritten.

---

## 3. The polling model in full

The device's load chain (`live.thisdevice → deferlow → delay 1000 → js`) fires the JS
~1s after the device instantiates, then `start_bridge` schedules self-re-arming tasks
(each tick calls `.schedule(...)` again):

| Task | Interval | Reads | Emits (on diff) |
|---|---|---|---|
| `heartbeat_tick` (~L311) | 2000 ms | nothing | `heartbeat` (health only) |
| `transport_tick` (~L320) | 2000 ms | `live_set` transport + selection | `transport_play/stop`, `tempo_changed`, `track_selected`, `transport_snapshot` |
| `focus_tick` (~L336) | 4000 ms | selected track → devices → clips | `device_*`, `clip_*`, focus snapshot |
| `live_set_tick` (~L366) | off by default | every track/scene | `live_set_snapshot` |

Notable runtime behavior:
- **`focus_tick` throttles while playing** (~L344): `FOCUS_SKIP_TICKS_WHILE_PLAYING = 2`,
  so the heavy scan runs ~every 3rd tick during playback and resumes full cadence the
  instant transport stops. Rationale: leave the audio thread headroom.
- **`captureLiveSet = false` by default** (~L82): the full-set walk is the heaviest single
  synchronous scan and the dominant native-crash trigger on large sets.
- **`MAX_*` limits** (~L85) cap how many tracks/devices/params/clips a single scan
  serializes.
- **Capture toggles** (`captureTransport`, `captureFocus`, `captureLiveSet`) can be flipped
  at runtime by sending messages into the `js` object — a `safe_mode` for isolating a crash
  without editing the file.

---

## 4. The wire: UDP loopback, fire-and-forget

`udpsend` throws one datagram at `127.0.0.1:9000`. No handshake, no ack, no retransmit.
If the app is not listening, the packet vanishes and **Max never blocks and never errors**.

This is the deciding design property: **zero crash surface and zero backpressure inside
Ableton's process.** A blocking transport (TCP/WS) could stall Max's main thread and take
the audio engine — and the user's session — down with it. The cost is **no delivery
guarantee**.

Mitigations / instrumentation:
- Each packet carries a monotonic `_bridge.sequence`. This makes loss **detectable**
  (gaps in the sequence) — but **nothing currently recovers or even checks for gaps** on
  the Rust side. (Flagged as the highest-value cheap improvement; see §7.)
- Hard size cap in the bridge: a packet serializing larger than `MAX_EVENT_BYTES` (8192)
  is **dropped at the outlet, not sent** (~L1544), because pushing an oversized symbol
  into `udpsend` can natively crash Max. 8 KB stays inside a single loopback datagram.

---

## 5. Rust ingestion (single receive thread, no DB, no UI)

`start_udp_listener` (udp_listener.rs L597) spawns two threads. The **receive thread**
(L619) loops on `recv_from` into a 16 KB buffer and, per packet:

1. **`extract_json_object`** (L92) — slice first `{` … last `}`. Tolerates junk framing.
   Malformed → counted (`incr_malformed`), dropped, `continue`.
2. **`serde_json` parse** → `Value`. Failure → dropped.
3. **`normalize_udp_json`** (L307):
   - Reject unsupported `protocol` (accepts `recall.v1/v2/protocol.v1`).
   - Fill defaults: `source`, `timestamp_ms` (stamp `now_ms()` if missing), `title`/
     `description` from lookup tables, `session_id = null`.
   - **Resolve canonical fields** with `find_string/f64/bool` (L232+): try the v2 name at
     top level, then v1 synonyms, then inside the parsed `payload`. Write results back as
     real top-level keys or explicit `null`. **All field-name guessing is consolidated
     here so the frontend never guesses.**
4. **Heartbeats terminate here** (L671): update `ConnectionState.last_heartbeat_ms` and
   `bridge_version`, then `continue`. They are never queued, persisted, or shown.
   ("Connected" = a heartbeat within the last 5 s, `get_status` L703.)
5. **`from_value::<RecallEvent>`** into the typed struct (protocol.rs), stamp the active
   `session_id` (Rust owns session identity, not Max), then **enqueue** and go straight
   back to listening.

---

## 6. Backpressure, persistence, and the live buffer

### 6.1 Bounded queue with priority shedding
A `sync_channel` of capacity **4096** (L605) decouples receive from disk. `enqueue_event`
(L569) implements graceful overload via `classify_priority` (L48):

| Priority | Examples | On queue-full |
|---|---|---|
| **Critical** | track/clip/device created/deleted, snapshots, bridge lifecycle | **block** until the worker drains room — never dropped |
| **Important** | tempo/transport/scene/clip launched, device selected | (same channel; blocks via the critical path) |
| **Coalescible** | everything else (high-freq / re-derivable) | **dropped**, counted in metrics |

Rationale: creative actions are rare, so briefly blocking on them cannot itself cause a
storm; high-frequency telemetry is the only thing shed under pressure.

### 6.2 Persistence worker (second thread, L505)
Blocks for one event, then **opportunistically drains up to 256** more and writes the
whole batch as **one SQLite transaction** (`save_events_batch`, storage.rs L367). Per
insert it captures `last_insert_rowid()` and **stamps it back onto the in-memory event**
(`event.id = Some(rowid)`), so the about-to-be-displayed live event already carries the
identity it will have when the session is reloaded from disk. After persisting, it pushes
to the live buffer and `app_handle.emit("recall-event", &event)` to the UI.

Ordering guarantee: an event is **persisted before it is shown** — no flicker, no
duplicate-on-reload.

### 6.3 SQLite configuration (storage.rs L625)
- **WAL** journal + `synchronous = NORMAL`: batched writes don't block reads
  (saved-session loads, curation queries) and throughput holds under bursts.
- Schema: `sessions`, `events` (raw `payload` preserved verbatim), and two **layer**
  tables that never mutate the capture — `event_curation` and `session_notes`. This is the
  core data rule enforced structurally: **raw telemetry is immutable; user edits are a
  separate layer.**
- In-memory live buffer is capped at 50_000 (oldest trimmed); the **DB is authoritative**,
  the UI reloads saved sessions from SQLite.

---

## 7. Honest weak points (where to focus a review)

1. **Poll-and-diff, not event-driven.** Fidelity is capped by tick rate; fast or reverted
   changes are never seen. The LOM supports property observers (push) — a real alternative
   with its own cost (more callbacks contending with the audio thread, and observer
   lifecycle management). This is the central architectural question.
2. **Silent UDP loss.** `sequence` makes gaps *detectable* but nothing detects or recovers
   them today. Adding sequence-gap counting in the Rust receive loop (surfaced via the
   existing metrics) is the single highest-value, lowest-cost integrity instrument.
3. **Snapshots can be dropped at the size cap.** A large Live Set's `live_set_snapshot` can
   silently exceed 8 KB and never leave the bridge. That's a real data gap, not theoretical.
4. **Two clocks.** `timestamp_ms` is set in JS (Max's clock) and only falls back to Rust's
   `now_ms()` if absent. Ordering trusts the JS clock — fine for a single local machine,
   worth stating explicitly.
5. **`parameter_changed` is effectively dormant.** The v2 contract specifies debounced
   parameter capture, but the current bridge does not stream parameters from a continuous
   gesture (focus scans intentionally exclude parameter values). There is no live parameter
   flood today; building a coalescer now would be speculative.
6. **Normalization is the corruption surface.** Any LOM property that returns an unexpected
   shape (multi-element array, locale-formatted number) would be silently coerced or
   dropped by `get_prop`/`value_to_*`. Worth a targeted audit if a field ever looks wrong.

---

## 8. Quick reference for the reviewer

| Concern | Where | Line(s) |
|---|---|---|
| LiveAPI read primitives | `recall_m4l_bridge.js` | ~408–444 |
| Loose-value normalization | `recall_m4l_bridge.js` | ~446–504 |
| Snapshot + diff + emit (transport) | `recall_m4l_bridge.js` | ~518–619 |
| Packet assembly + size cap | `recall_m4l_bridge.js` | ~1500–1558 |
| Poll cadence / toggles / limits | `recall_m4l_bridge.js` | ~74–134 |
| UDP recv + malformed handling | `udp_listener.rs` | 619–700 |
| Normalize + canonical field resolution | `udp_listener.rs` | 232–426 |
| Heartbeat → connection state | `udp_listener.rs` | 428–468, 703–718 |
| Priority classify + enqueue policy | `udp_listener.rs` | 48–65, 569–595 |
| Batch persist + rowid stamping | `udp_listener.rs` / `storage.rs` | 505–564 / 367–424 |
| Schema + WAL + layer tables | `storage.rs` | 625–690 |
| Typed event struct | `protocol.rs` | whole file |

> Line numbers are approximate and drift as the code changes; treat them as starting
> points, not anchors. The protocol contract is authoritative in `recall-protocol-v2.md`.
