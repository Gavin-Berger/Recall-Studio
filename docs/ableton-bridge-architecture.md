# Ableton → Control Surface → TCP → Rust → Storage: Architecture & Data Path

**Audience:** a senior backend / integration engineer reviewing this pipeline cold.
**Purpose:** explain *how* Ableton state actually reaches the app, what crosses each
boundary, the threading model, and — bluntly — where the design is weak.

This is the mechanism doc. The wire *contract* (field names, event vocabulary) lives in
[`recall-protocol-v2.md`](./recall-protocol-v2.md) and is not repeated here.

> **History note.** This pipeline previously ran through a Max for Live device that
> polled Ableton's object model on a timer, diffed against remembered state, and sent
> UDP to `127.0.0.1:9000`. That bridge (`m4l/`) is retained in the repo for reference but
> is no longer what ships. Everything below describes the Python control surface that
> replaced it, which is event-driven rather than polled and pushes over TCP.

---

## 0. One-paragraph summary

Recall captures a producer's creative activity in Ableton Live through
`remote-script/Recall/`, a **Control Surface** — the same extension mechanism Live uses
to talk to hardware controllers like Push. It runs inside Live's own embedded Python
interpreter and registers **listeners** on the objects it cares about: the selected
track's parameters, its clips, the tempo, the track list. When one of those objects
changes, Live calls the listener directly. There is no poll loop reading the object model
on a timer and no diffing against a remembered snapshot to notice a change — the change
is what triggers the callback.

The script pushes newline-delimited JSON to a local Rust listener over **TCP** at
`127.0.0.1:9001` (not UDP — see §4 for why). Rust normalizes, classifies, queues,
batch-writes to SQLite, and pushes to the React UI.

```
┌───────────┐  listener callback  ┌──────────────────┐   TCP     ┌──────────────┐
│ Ableton   │ ───(event-driven)──▶│ Recall/__init__.py│──:9001──▶│ Rust listener│
│ Live LOM  │                     │ (control surface) │  queued  │  (Tauri app) │
└───────────┘                     └──────────────────┘  socket   └──────┬───────┘
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
- Control surface: [`remote-script/Recall/__init__.py`](../remote-script/Recall/__init__.py)
- TCP + normalize + queue + worker: [`src-tauri/src/udp_listener.rs`](../src-tauri/src/udp_listener.rs)
  (name predates the TCP rewrite — it still binds a legacy UDP socket for the retained
  M4L path, and spawns the TCP listener alongside it; see §4)
- Static event vocabulary (priority, fallback title/description):
  [`src-tauri/src/event_catalog.rs`](../src-tauri/src/event_catalog.rs)
- Typed event: [`src-tauri/src/protocol.rs`](../src-tauri/src/protocol.rs)
- SQLite: [`src-tauri/src/storage.rs`](../src-tauri/src/storage.rs)

---

## 1. The boundary that used to surprise people no longer applies

The M4L bridge pulled: nothing in Ableton said "the user moved a knob," the bridge found
out by reading the value on its next timer tick and noticing it differed. The control
surface is the opposite. Live's `ableton.v2.control_surface` framework calls
**registered listener methods directly** when the thing they're watching changes —
`parameter.add_value_listener(...)`, `track.add_devices_listener(...)`,
`song.add_tempo_listener(...)`, `clip.add_notes_listener(...)`. There is no tick, no
snapshot-and-diff, and nothing sub-poll-interval can be missed, because there is no poll
interval.

**What replaces the old poll-cadence trade-off:** the callback fires the instant the
value changes, but the callback carries **no argument and no previous value** — Live
tells you *that* something changed, not *what* it was before or *what* it settled at.
The script has to remember the "before" side itself (`_last_values` for parameters,
`_clip_prints` for note content) and decide when a burst of callbacks has *settled* into
one reportable move (see §2). That settling logic is the direct descendant of the old
bridge's debounce — moved from "read on a timer" to "wait for callbacks to go quiet."

### 1.0 Scope is one track, not the whole set

`Recall.__init__` calls `_listen_to_selection()`, which attaches to the **selected
track's** devices and clips, plus set-wide listeners for tempo and the track list
(`song.add_tempo_listener`, `song.add_tracks_listener`). It does **not** walk every
track and register a listener on every parameter of every device in the set.

This is a hard-learned scope decision, not a shortcut. A prior attempt to widen capture
by walking every track crashed Live (documented in `_listen_to_selection`'s own
docstring: *"the equivalent mistake here would be listening to every parameter in the
set"*). The bound holds even within the selected track: `MAX_PARAMS_PER_DEVICE = 128`
caps how many parameters one device can register listeners for, because a wavetable
synth can expose thousands.

**Consequence:** a parameter move on a track that is not currently selected is not
captured. To capture a track live, select it. Structure (which tracks/devices exist) is
covered separately by the whole-set snapshot (§3), which is cheap; per-parameter
listening is what stays scoped to one track.

### 1.1 Selection changes re-point every listener

`_on_selection_changed` runs on load and on every `selected_track` change. It tears down
the previous track's parameter, device, and clip listeners (flushing any in-flight
gesture or note edit first — see §2, "settle before you switch") and re-attaches to the
newly selected track. `_on_devices_changed` does the same at device-chain granularity:
if a plugin is added or removed on the selected track, listeners are re-pointed without
touching the parameter registrations on any *other* track — because there are none.

### 1.2 Values are read directly; there is no array-unwrapping layer

The old bridge's biggest low-level hazard was that `LiveAPI.get()` returned everything
wrapped in an array (`tempo` came back as `[120]`) and needed a normalization layer to
tame it. The control surface reads LOM objects' properties directly in Python
(`parameter.value`, `device.name`, `track.devices`) — there is no array-wrapping
convention to unwrap, because this is the typed Python API, not the JS `LiveAPI` proxy.

The equivalent hazard here is narrower and specific: **Live's "no value" sentinels are
not `None`.** `_safe_name` exists because an unnamed object's `.name` can come back as
`""` or as the integer `0` — the latter being what Live returns for an absent *text*
property, and `0` stringifies to a truthy `"0"` if passed through raw. This produced a
real bug: a blank clip name rendered as `"· notes"` with nothing in front of it before
`_safe_name` was written to catch both cases.

---

## 2. How a callback becomes a JSON event (worked example: a knob ride)

**Step 1 — the value listener fires, possibly many times per second.**
`parameter.add_value_listener` triggers `_on_value` on every LOM-level change during a
continuous ride. The callback does the minimum possible: record the current value, the
running min/max of the sweep, and the timestamp, into an in-flight `_gestures[key]` dict.
It does **not** emit anything yet.

```python
gesture["last"] = current
gesture["at"] = now
gesture["min"] = min(gesture["min"], current)
gesture["max"] = max(gesture["max"], current)
```

**Step 2 — `update_display` decides when the gesture is done.**
Live calls `update_display` roughly every 100ms regardless of what's happening in the
set. `_flush_settled_gestures` walks every in-flight gesture and closes any that hasn't
received a new sample in `GESTURE_SETTLE_SEC` (350ms). This is the direct replacement for
the old bridge's timer-driven debounce, except the settle window starts from the *last
real event*, not from a fixed clock tick — a ride that pauses for 200ms and resumes reads
as one continuous gesture, not two.

**Step 3 — the settled gesture is compared against where it started, and emitted.**
`_emit_settled` compares `start` (the last known value *before* this gesture began,
seeded from `_last_values`) against `last` (where it landed). A gesture that returns
exactly to its starting value emits nothing — "rode the filter up and back down" is not a
change to the set, and logging it would fill the timeline with decisions nobody made.
Otherwise:

```json
{
  "protocol": "recall.v2",
  "source": "control_surface",
  "event_type": "parameter_changed",
  "timestamp_ms": 1716900000000,
  "payload": {
    "track_name": "Bass",
    "track_id": "47",
    "device_name": "Serum 2",
    "parameter_name": "Filter Cutoff",
    "parameter_value": 0.501,
    "previous_parameter_value": 0.377,
    "parameter_value_percent": 50.1,
    "previous_parameter_value_percent": 37.7,
    "parameter_display_value": "2 kHz",
    "previous_parameter_display_value": "500 Hz",
    "parameter_value_min": 0.377,
    "parameter_value_max": 0.612
  }
}
```

`parameter_display_value` comes from `parameter.str_for_value(value)` — the same
formatting Live's own UI uses, units included, so the app can show "500 Hz → 2 kHz"
rather than a bare percentage.

**Note edits follow the identical three-step shape** (callback records dirty state →
`update_display` settles it after `NOTE_SETTLE_SEC` = 1.2s of quiet → the settled edit is
diffed against the clip's previous fingerprint and emitted as `clip_notes_changed`), with
one deliberate difference: the notes listener carries **no note data at all**, only "this
clip changed." Reading the actual note content is expensive enough that doing it on every
callback — which fires continuously during a record pass — would put a full note scan on
Live's thread dozens of times a second. So `_fingerprint(clip)` is called only once, when
a gesture settles: count, pitch range, mean velocity, and a hash of the sorted note
tuples, never the notes themselves. **Recall records decisions, not data** — the
authoritative note content lives in the `.als` for the take and is read from there when
needed, not shipped through this socket.

### "Settle before you switch"

Both settling paths are flushed **forcibly** — bypassing the settle timer — the instant
their listeners are about to be torn down: on track/device selection change
(`_clear_parameter_listeners`, `_clear_clip_listeners`) and on script teardown
(`disconnect`). Without this, the last tweak made right before clicking to another track,
or right before quitting Ableton, would be silently discarded rather than reported. This
is a load-bearing correctness property, not a nicety — it is the difference between "the
edit you were mid-gesture on when you moved on" being captured or lost.

---

## 3. The whole-set snapshot

Structure — which tracks and devices exist, their names, parameter ranges, clip slot
contents — is not built from per-track listeners; it's a single walk of `song.tracks`,
`song.return_tracks`, and `song.master_track`, done in `_send_snapshot()`. This is sent
**once on load**, and again whenever the track list changes (`_on_tracks_changed`, fired
by `song.add_tracks_listener`) or the open set changes (`refresh_state`, called by Live —
see below).

It is deliberately **not** a periodic scan. `refresh_state()` — Live's own hook, called
for more reasons than "the set changed" (its own docstring says so) — would otherwise
re-send the *entire* snapshot, every track's every device's every parameter, on every one
of those extra calls. `_snapshot_fingerprint()` (`json.dumps(payload, sort_keys=True)`)
guards against this: an unchanged snapshot is a no-op.

Reading the LOM this way — direct Python attribute access on objects Live already holds —
is cheap in a way the old bridge's per-property `LiveAPI` proxy calls were not, which is
what made a full-set walk dangerous in Max but safe here. The one governor that still
exists is `MAX_CLIPS_PER_TRACK` (64), capping how many clip slots one track's structural
description serializes — a defensive bound, not a response to an observed cost.

---

## 4. The wire: TCP loopback, queued and reconnecting

**Why TCP and not the old bridge's UDP.** A whole-set snapshot of a large project can
exceed a single UDP datagram's practical ceiling (the old bridge enforced an 8KB
`MAX_EVENT_BYTES` cap at the outlet specifically to avoid this) and would be dropped
entire, with no error visible to the producer. TCP has no such ceiling and confirms
delivery at the transport level.

**Why a background thread and a queue, when the old design needed neither.** UDP
`sendto` either completed immediately or failed immediately — there was nothing to wait
for. TCP connects, can block on a slow reader, and can stall — and none of that may
happen on Live's own thread, which must never wait on I/O. So `_emit()` only ever does a
non-blocking `queue.put_nowait()`; a separate daemon thread (`_sender_loop`) owns the
actual socket, the connecting, and the reconnecting.

```python
self._queue = queue.Queue(maxsize=SEND_QUEUE_MAX)  # 2048
```

`_sender_loop` runs forever: if not connected, try to connect; pull one line off the
queue (0.5s timeout so it can notice a stop signal); `sendall` it. Any exception —
connection refused because the app isn't open yet, connection dropped, anything — closes
the socket, waits `RECONNECT_DELAY_SEC` (2.0s), and retries. **This is expected, steady-
state behavior when Recall isn't running**, not an error condition from Live's point of
view.

If the app is closed for a while, events queue up client-side. Past `SEND_QUEUE_MAX`
(2048), the **oldest** queued event is dropped to make room for the newest — the current
state of the set is worth more than the start of a backlog nobody will ever see live.

**Framing.** Each event is one line of JSON followed by `\n` — TCP is a byte stream with
no message boundaries of its own, so the receiver splits on newlines
(`read_bounded_line`, capped at `MAX_TCP_LINE_BYTES` = 32KB per line, discarding and
resynchronizing past that ceiling rather than growing a buffer without limit).

**On teardown**, `disconnect()` flushes any in-flight gesture, emits `bridge_stopped`
with counters (`moves_seen`, `note_edits_seen`), signals the sender thread to stop, and
gives it up to 1 second to drain the queue and close cleanly — a courtesy, not a
guarantee, since the daemon thread dies with the process regardless.

---

## 5. Rust ingestion: two listeners, one shared pipeline

`start_udp_listener` (the function name predates this design and was not renamed) spawns
**both** a legacy UDP socket on `127.0.0.1:9000` — retained for the M4L bridge path,
which still exists in the repo — and a TCP listener on `127.0.0.1:9001` for the control
surface, each on its own thread, both feeding the same downstream pipeline (normalize →
classify → queue → persist). Whichever bridge a given producer has installed determines
which socket carries real traffic; the app doesn't need to know or care which.

The TCP accept loop (`udp_listener.rs`, around L1253) handles one connection at a time,
reading lines with `read_bounded_line` and, per line:

1. **`extract_json_object`** — slice from the first `{` to the last `}`. Tolerant of
   stray framing bytes (a defense that mattered more for the UDP/Max path than it does
   here, but shared by both).
2. **`serde_json` parse** into a `Value`. Failure → counted (`incr_malformed`), dropped.
3. **`normalize_udp_json`**:
   - Reject unsupported `protocol` (`recall.v1` / `recall.v2` / `recall.protocol.v1` are
     accepted).
   - Fill envelope defaults: `source` (defaults to `"max_for_live"` if absent — the
     control surface always sends `"control_surface"` explicitly so the two capture
     tiers are told apart in storage), `timestamp_ms` (stamps `now_ms()` if missing),
     `title`/`description` from the event catalog's fallback text (see §6 — the control
     surface never sends its own title or description, so **every** event's title and
     description come from this fallback), `session_id = null`.
   - **Resolve canonical fields** with `find_string`/`find_f64`/`find_bool`: try the
     top-level key, then inside the parsed `payload` object. This is why the control
     surface can send everything nested under `payload` (§ of the protocol doc) and the
     Rust side still finds `track_name`, `parameter_value`, and so on — **all field-name
     resolution is consolidated here so the frontend never guesses.**
4. **Heartbeats terminate here**: `update_connection_if_heartbeat` sets
   `ConnectionState.last_heartbeat_ms` and `bridge_version`, then processing stops for
   that line. Heartbeats are never queued, persisted, or shown. ("Connected" = a
   heartbeat seen within the last 5 seconds, `get_status`.)
5. Also here, before heartbeats are dropped: `update_open_file` reads `project_path` off
   the event (if present — see the open gap in §7) to track which `.als` is open, and
   `rotate_session_if_project_changed` uses that to decide whether the active session
   needs to rotate to a different take.
6. **`from_value::<RecallEvent>`** into the typed struct (`protocol.rs`), stamp the
   active `session_id` (Rust owns session identity, never the bridge), then **enqueue**.

---

## 6. Backpressure, persistence, and the live buffer

### 6.1 Bounded queue with priority shedding
A `sync_channel` of capacity **4096** (`EVENT_QUEUE_CAPACITY`) decouples ingestion from
disk. `enqueue_event` implements graceful overload via `classify_priority`, driven by the
static table in `event_catalog.rs`:

| Priority | Examples | On queue-full |
|---|---|---|
| **Critical** | track/clip/device created/deleted, note edits, snapshots, bridge lifecycle | **block** until the worker drains room — never dropped |
| **Important** | tempo, parameter moves, device toggles, snapshots | (same channel; blocks via the critical path) |
| **Coalescible** | heartbeats, and any `event_type` **not present in the catalog** | **dropped**, counted in metrics |

Two things worth being explicit about, verified against the current control surface's
actual emitted event types (§ below): `track_list_changed` and `focus_changed` — both
real events the script sends on every track-list change and every selection change — are
**not rows in `event_catalog.rs`**. An event not in the catalog falls back to
`Coalescible` priority (shed first under load) and a generic title
(`"Recall Event: track_list_changed"`) rather than anything readable. This is a real,
verified gap, not a hypothetical one — see §7.

### 6.2 Persistence worker
Blocks for one event, then opportunistically drains up to `PERSIST_BATCH_MAX` (256) more
and writes the whole batch as **one SQLite transaction**. Per insert it captures
`last_insert_rowid()` and stamps it back onto the in-memory event (`event.id =
Some(rowid)`), so the live event already carries the identity it will have on reload.
**An event is persisted before it is shown** to the UI — no flicker, no
duplicate-on-reload.

### 6.3 SQLite configuration
- **WAL** journal, persistent (set once, lives in the database file) + `synchronous =
  NORMAL` and `busy_timeout = 5000ms`, both **per-connection** settings applied on every
  `open_connection()` call — not a one-time init, because SQLite resets them to defaults
  on every fresh connection otherwise. (This repo previously shipped a bug where
  `synchronous` was set only on a throwaway init connection and every real write ran at
  the SQLite default `FULL` — a full fsync per batch commit — with WAL's durability
  partner silently not applying. Fixed; documented here as the reason this pragma lives
  where it does rather than in `initialize_database`.)
- Schema: `sessions`, `events` (raw `payload` preserved verbatim as a string), plus two
  **layer** tables that never mutate the capture — `event_curation` and `session_notes`.
  The structural rule: **raw telemetry is immutable; user edits are a separate layer.**
- In-memory live buffer capped at 50,000 events (oldest trimmed); the **database is
  authoritative** — the UI reloads saved sessions from SQLite, not from the live buffer.

---

## 7. Honest weak points (where to focus a review)

1. **Two events are unclassified.** `track_list_changed` and `focus_changed` are real,
   frequently-emitted events with no `event_catalog.rs` row — verified by reading the
   catalog against the control surface's actual `_emit()` call sites. They are shed
   first under any queue pressure and render with a generic fallback title everywhere the
   catalog's title/description would otherwise be used. Cheap fix: add the two rows.
2. **No delivery-loss signal, client-side or server-side.** The old bridge at least had a
   `_bridge.sequence` field for (unused, but present) gap detection. The control surface
   sends no sequence number at all. If the local send queue overflows during a
   disconnect (§4), the oldest queued events are silently dropped with **zero** signal
   reaching the app — no counter, no gap, nothing. TCP guarantees ordering and delivery
   *within* an open connection; it guarantees nothing about what was queued before the
   connection existed.
3. **`project_path` is never sent.** `update_open_file` (§5, step 5) reads `project_path`
   off every event to learn which `.als` is open, which is what
   `rotate_session_if_project_changed` needs to split takes correctly when a producer
   switches songs. The control surface never sends this field — confirmed by grep, zero
   matches. Session rotation between projects is consequently dead code that never
   executes its body. Tracked as GitHub issue #10, with the attribution damage it causes
   tracked as #11.
4. **Every event's title and description are the generic fallback.** The control surface
   never sends `title` or `description` — confirmed by reading `_emit()`, which sends
   exactly `protocol`, `source`, `event_type`, `timestamp_ms`, `payload`. The old M4L
   bridge generated human copy per event; here, 100% of that copy comes from
   `event_catalog.rs`'s fallback strings. That's fine where the catalog has a good
   fallback and silently generic where it doesn't (see point 1).
5. **Structure capture is set-scoped; parameter/note capture is one-track-scoped.** By
   design (§1.0), not oversight — but worth restating plainly: a parameter ridden on a
   track that isn't selected, or a clip edited on an unselected track, is not captured
   at all, not even at reduced fidelity.
6. **`refresh_state()` firing reasons are undocumented by Live itself.** The control
   surface's own comment on `refresh_state` notes it fires "among other times" beyond an
   obvious set-open — Live's own API docs don't fully enumerate when. The snapshot
   fingerprint (§3) protects against redundant sends but the underlying trigger surface
   is not fully understood.
7. **One TCP connection at a time.** The accept loop handles connections sequentially. In
   practice only one Recall app instance and one Ableton instance are expected on a given
   machine, so this has not been a problem, but it's an implicit assumption rather than
   an enforced one.

---

## 8. Quick reference for the reviewer

| Concern | Where |
|---|---|
| Listener scope (one track) & re-pointing on selection | `remote-script/Recall/__init__.py` — `_listen_to_selection`, `_on_selection_changed` |
| Gesture settling (parameters) | `__init__.py` — `_make_parameter_listener`, `_flush_settled_gestures`, `update_display` |
| Note-edit settling & fingerprinting | `__init__.py` — `_make_notes_listener`, `_flush_settled_note_edits`, `_fingerprint` |
| Whole-set snapshot + dedup | `__init__.py` — `_send_snapshot`, `_snapshot_fingerprint` |
| Sender thread, queue, reconnect | `__init__.py` — `_open_socket`, `_sender_loop`, `_emit` |
| Heartbeat | `__init__.py` — `_send_heartbeat_if_due`, `_heartbeat_due` |
| TCP + UDP dual listener spawn | `udp_listener.rs` — `start_udp_listener` |
| TCP framing / bounded line read | `udp_listener.rs` — `read_bounded_line`, `MAX_TCP_LINE_BYTES` |
| Normalize + canonical field resolution | `udp_listener.rs` — `normalize_udp_json`, `find_string`/`find_f64`/`find_bool` |
| Heartbeat → connection state | `udp_listener.rs` — `update_connection_if_heartbeat`, `get_status` |
| Priority classify + enqueue policy | `event_catalog.rs` (data) / `udp_listener.rs` — `classify_priority`, `enqueue_event` |
| Batch persist + rowid stamping | `udp_listener.rs` / `storage.rs` — `run_persistence_worker` / `save_events_batch` |
| Schema + WAL + layer tables | `storage.rs` — `open_connection`, `initialize_database` |
| Typed event struct | `protocol.rs` |

> The protocol contract — exact field names and the event vocabulary — is authoritative
> in [`recall-protocol-v2.md`](./recall-protocol-v2.md).
