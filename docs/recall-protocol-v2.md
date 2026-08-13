# Recall Protocol v2

This document is the canonical contract between Ableton-side capture and Recall. The
Rust backend and TypeScript frontend both rely on this spec. Do not add synonyms or
alternative field names — pick one and use it everywhere.

> **Audience note.** This is the engineering wire contract — `event_type` strings and
> field names are technical on purpose; producers never see them. The **"What the
> producer sees"** column shows the plain-language, musical phrasing the timeline renders
> from each event. That column is the source of truth for tone: anything producer-facing
> must read like a producer wrote it, never like a debug log.

Two capture tiers currently share this protocol, told apart by `source`:

| `source` | What it is | Transport | Status |
|---|---|---|---|
| `"control_surface"` | `remote-script/Recall/`, a Python Control Surface running inside Live's embedded interpreter | TCP, `127.0.0.1:9001` | **What ships** — installed by the app's Setup screen |
| `"max_for_live"` | The original Max for Live device, `m4l/` | UDP, `127.0.0.1:9000` | Retained in the repo for reference; not installed by the app |

Implemented by control surface **v0.5.7**. This document's packet shapes remain a useful
wire reference, but several historical coverage notes below predate the current script.
For the current capture surface and the claims each data source is allowed to make, read
[`capture-evidence.md`](capture-evidence.md) first. When the script and either document
disagree, the script is right and the documentation is a bug — update it.

## Packet format

Every event is one line of newline-delimited JSON, sent over the persistent TCP
connection. The control surface's `_emit()` sends exactly this shape — no more:

```json
{
  "protocol":     "recall.v2",
  "source":       "control_surface",
  "event_type":   "parameter_changed",
  "timestamp_ms": 1716900000000,
  "payload":      { "track_name": "Bass", "parameter_name": "Filter Cutoff", "...": "..." }
}
```

**Notably absent: `title` and `description`.** The control surface never sends them —
verified by reading `_emit()` — so for every event from this tier, the human-facing
title and description come entirely from the fallback table in `event_catalog.rs`
(Rust). This is a real behavioral difference from the old M4L doc's assumption that the
bridge usually supplies its own copy; here, it never does. See "Event vocabulary" below
for which events currently have good fallback copy and which don't.

**Canonical fields live under `payload`, not the top level.** The control surface always
nests them (see the `parameter_changed` payload above). The Rust backend resolves fields
by checking the top level *first*, then `payload` — see "Canonical fields" — so this
works, but any new code emitting events should follow the same convention: put canonical
data in `payload`, let the Rust normalizer promote it.

## Envelope fields

| Field | Type | Who sets it | Notes |
|---|---|---|---|
| `protocol` | `"recall.v2"` | sender | Version gate. `recall.v1` / `recall.protocol.v1` still accepted (see bottom). |
| `source` | string | sender | `"control_surface"` for the Python script, `"max_for_live"` for the retained M4L bridge. Defaults to `"max_for_live"` if omitted — the control surface always sends its own explicitly. |
| `event_type` | string | sender | From the vocabulary below — exact, lowercase. |
| `timestamp_ms` | integer | sender | Milliseconds since Unix epoch. Backend stamps `now_ms()` if omitted. |
| `title` | string | backend (see above) | Human title. The control surface never sends one; the backend always generates it from `event_type` via `event_catalog.rs`. |
| `description` | string | backend (see above) | Human description. Same as `title` — always backend-generated for this tier. |
| `payload` | object → string | sender → backend | Where the control surface puts everything. Flattened to a JSON string at storage; the raw form is what canonical-field resolution reads from before that flattening happens. |
| `session_id` | null → string | **backend** | The control surface must NOT and does not assign session ownership — Recall stamps this when a session is active. |

There is no `_bridge.sequence` field in this tier. The old M4L bridge stamped a
per-packet sequence number for (never-implemented) gap detection; the control surface
sends nothing equivalent, and there is currently no way to detect a dropped event on
this path — see the architecture doc's "Honest weak points."

## Canonical fields

These are lifted to the **top level** of the packet (not left buried in `payload`) by
`normalize_udp_json` in `udp_listener.rs`, so the backend and frontend always read a flat
shape regardless of what the sender nested. Every row below is checked in this order —
canonical name at top level, then canonical name in `payload`, then each listed synonym —
so this is also the exhaustive list of every field name either capture tier has ever used
for the same concept.

| Field | Type | Sent by control surface for | What the producer sees it as |
|---|---|---|---|
| `track_name` | string | any event about a specific track | which track they were working on |
| `track_id` | string | most track/device/parameter events | Live's stable per-track pointer (`track._live_ptr`) — the identity used to attribute a move to a lane even if the track is later renamed |
| `track_type` | string | *(not currently sent by the control surface)* | — |
| `device_name` | string | `device_toggled`, `parameter_changed`, `focus_changed` | the instrument or effect, e.g. "Serum 2" |
| `device_chain` | string | `focus_changed` | the full signal chain on the selected track |
| `parameter_name` | string | `parameter_changed` | the knob/control, e.g. "Filter Cutoff" |
| `parameter_value` | number | `parameter_changed` | the settled value (raw, device units) |
| `previous_parameter_value` | number | `parameter_changed` | the value before this gesture began |
| `parameter_value_percent` / `previous_parameter_value_percent` | number | `parameter_changed` | before/after normalized to the parameter's own range, 0-100 |
| `parameter_value_min` / `parameter_value_max` | number | `parameter_changed` | the full range swept during the gesture — not recoverable from before/after alone |
| `parameter_display_value` / `previous_parameter_display_value` | string | `parameter_changed` | the value as Ableton's own UI would show it, units included, e.g. "500 Hz" — from `parameter.str_for_value()` |
| `parameter_is_quantized` | bool | *(not currently sent)* | — |
| `clip_name` | string | `midi_clip_created`, `audio_clip_added`, `clip_deleted`, `clip_notes_changed` | the clip's name, or `null` if Live has none (see `_safe_name` in the architecture doc) |
| `sample_name` / `file_path` | string | *(not currently sent by the control surface — was an M4L-tier field)* | — |
| `project_name` / `project_path` | string | *(not currently sent — see the known gap below)* | — |
| `bpm` | number | `tempo_changed` | the project tempo |
| `playing` | boolean | *(not currently sent by the control surface)* | — |

**Known gap, verified:** `project_path` is in this table because the backend resolves
it and depends on it (`ConnectionState.open_als_path`, used by
`rotate_session_if_project_changed` to split a take when the producer opens a different
song) — but the control surface never sends it. Confirmed by grepping
`remote-script/Recall/__init__.py` for `project_path`: zero matches. Session rotation
between projects is consequently dead code. Tracked as GitHub issue #10 (the missing
field) and #11 (the attribution damage it causes — work silently filed under the wrong
project).

**Fields the control surface sends that are *not* in this canonical list**, and
therefore only ever reach storage inside the flattened `payload` string, never as a real
column or a typed field: `clip_id`, `clip_slot_index`, `length_beats`, `note_count`,
`previous_note_count`, `change_kind`, `distinct_pitches`, `pitch_min`/`pitch_max`,
`previous_pitch_min`/`previous_pitch_max`, `pitch_range`/`previous_pitch_range`,
`velocity_mean`, `span_beats`, `summary`, `is_active`, `device_count`,
`parameter_count`, `clip_slot_count`, `midi_clips_watched`, `track_count`,
`track_names`, `python_ok`, `return_count`, `has_master`, `moves_seen`,
`note_edits_seen`, `bridge_version` (heartbeat only), `script_version`
(`bridge_started` only). Anything one of these events needs that isn't in the canonical
table above has to be read out of the stored `payload` string — it is not queryable as
a column today.

## Event vocabulary

Exact, lowercase strings. `event_catalog.rs` is the single source of truth for priority
and fallback title/description, and it is intentionally a **superset**: it lists events
the control surface emits today *and* events planned for future capture (mixer moves,
scenes, freeze/flatten, warp changes…) so that the day capture starts sending one, the
backend already classifies and titles it correctly with zero code changes. **The table
below marks only the events the control surface actually emits right now** — verified
by reading every `self._emit(...)` call site in `__init__.py`. Everything else in the
catalog is vocabulary reserved for capture that doesn't exist yet; do not assume a row
appearing in `event_catalog.rs` means it's currently being sent.

### Bridge lifecycle (connection health — not shown in the timeline)

| `event_type` | Catalog priority | Shown? | What the producer sees |
|---|---|---|---|
| `bridge_started` | Critical | hidden | capture started (fires once, on script load) |
| `bridge_stopped` | Critical | hidden | capture stopped (fires on script teardown, carries `moves_seen`/`note_edits_seen`) |
| `heartbeat` | Coalescible | hidden | drives the "Connected" indicator only; sent every 2s from `update_display`, never persisted |

### Transport & tempo

| `event_type` | Catalog priority | Shown? | What the producer sees |
|---|---|---|---|
| `tempo_changed` | Important | **shown** | "Changed the tempo to 124 BPM" |

### Track & structure

| `event_type` | Catalog priority | Shown? | What the producer sees |
|---|---|---|---|
| `live_set_snapshot` | Important | context | (full set state; only surfaces on a real change — see the architecture doc §3) |
| `track_list_changed` | **not in catalog → Coalescible fallback** | generic fallback title | ⚠️ verified gap — see below |
| `focus_changed` | **not in catalog → Coalescible fallback** | generic fallback title | ⚠️ verified gap — see below |

**Both of these are real, frequently-fired events with no catalog row** — confirmed by
grepping `event_catalog.rs` for both strings and finding nothing. Each gets
`Coalescible` priority (shed first under any queue pressure) and a title of
`"Recall Event: track_list_changed"` / `"Recall Event: focus_changed"` rather than
readable copy. Cheap to fix — add two rows to the catalog — not yet done.

### Instruments & effects

| `event_type` | Catalog priority | Shown? | What the producer sees |
|---|---|---|---|
| `device_toggled` | Important | **shown** | a device was bypassed or re-enabled |

### Clips & notes

| `event_type` | Catalog priority | Shown? | What the producer sees |
|---|---|---|---|
| `midi_clip_created` | Critical | **shown** | "Started a new MIDI clip" |
| `audio_clip_added` | Critical | **shown** | "Added an audio clip" |
| `clip_deleted` | Critical | **shown** | "Deleted a clip" |
| `clip_notes_changed` | Critical | **shown** | pre-rendered summary, e.g. "14 notes (+3), C1-G2" — see `_note_summary` in the architecture doc |

### Parameters

| `event_type` | Catalog priority | Shown? | What the producer sees |
|---|---|---|---|
| `parameter_changed` | Important | **shown** | before → after, with the device's own unit formatting |

## How events surface to the producer

The frontend sorts every event into one of four roles. This is the line between "raw
telemetry" and "the session story," and it is unchanged by the capture-tier rewrite.

| Role | Meaning | Example |
|---|---|---|
| **hidden** | health/lifecycle only; never stored as a moment | heartbeat, bridge_started |
| **context** | informs grouping; only shown if it represents a real change | live_set_snapshot |
| **shown** | a deliberate creative move — always in the timeline | device toggled, clip created, parameter moved |

The marketable surface — the session document and activity blocks — is built from the
**shown** events. Everything else is plumbing.

## Known capture gaps (verified against the current control surface)

Unlike the old bridge, capture here is event-driven, not polled — so "missed a sub-poll
change" is no longer the shape of the gaps. The current gaps are scope and coverage
decisions, all verified by reading `__init__.py`:

1. **Only the selected track's parameters and clips are listened to.** A move on any
   other track is not captured, at any fidelity, until that track is selected. This is a
   deliberate, load-bearing scope bound — a prior attempt to widen it crashed Live — not
   an oversight. See the architecture doc §1.0.
2. **No cross-project rotation.** `project_path` is never sent (see "Known gap" under
   Canonical fields above), so a producer who opens a different song mid-session has
   their new work filed into whatever take was already active. Tracked as #10 / #11.
3. **No mixer, scene, or arrangement-edit capture.** Volume/pan/send moves, scene
   launches, and arrangement operations (split, crop, warp, nudge, fades) are in the
   planned `event_catalog.rs` vocabulary but the control surface does not emit any of
   them today.
4. **Automation-vs-manual is not distinguished.** A value listener fires identically
   whether a parameter moved because the producer rode it or because recorded automation
   is driving it during playback — so automation playback currently re-records itself as
   fabricated `parameter_changed` moves, one per pass over the automated region. Tracked
   as #9, with a candidate fix (`DeviceParameter.automation_state`) pending verification
   against the running Live build.
5. **`MAX_PARAMS_PER_DEVICE` (128) and `MAX_CLIPS_PER_TRACK` (64) are hard caps.** A
   device or track exceeding either silently stops registering listeners past the limit
   — there is no signal to the producer that some parameters or clips on a very large
   device/track aren't covered.
6. **The read window for note content starts at beat 0.** `_read_notes` reads a clip's
   notes from beat 0 across its length; notes sitting before the start marker (an
   anacrusis dragged left of bar 1) are outside that window. Bounded and known, not
   unbounded.

## Parameter rate-limiting

`parameter_changed` is emitted only by the gesture-settling path in
`update_display`/`_flush_settled_gestures` — see the architecture doc §2. A continuous
knob ride, no matter how many raw `add_value_listener` callbacks it triggers (observed
in practice near-continuously during a fast sweep), collapses to exactly one event once
350ms (`GESTURE_SETTLE_SEC`) passes with no further movement. Sending per-callback
parameter events is a hard no — it would put dozens of writes per second through the
pipeline for a single producer gesture.

## Heartbeat

Sent from `update_display` at most once every 2 seconds (`HEARTBEAT_INTERVAL_SEC`), and
immediately on the very first tick after load (`_last_heartbeat_at` starts at `0.0`
specifically so the producer doesn't wait through a full interval to see "Connected"
right after selecting Recall in Preferences). Recall shows "Connected" if a heartbeat
arrived within the last 5 seconds — see `get_status` in the architecture doc.

```json
{
  "protocol":     "recall.v2",
  "source":       "control_surface",
  "event_type":   "heartbeat",
  "timestamp_ms": 1716900000000,
  "payload":      { "bridge_version": "0.3.0" }
}
```

Heartbeats are **not** persisted and **not** shown — connection health only. The script
version travels in the heartbeat payload's `bridge_version` key (the field name predates
the control-surface rewrite and was kept rather than renamed, since the Rust side already
reads it there) so the app can show which build is connected and, since this version,
detect when the running script is older than the one the app ships.

## Backwards compatibility

The backend also accepts `"recall.v1"` and `"recall.protocol.v1"` for events without
these structured fields — a holdover from the M4L tier, still exercised by any `m4l/`
device still in use. Those are still processed, and the frontend falls back to heuristic
field guessing for anything not resolved by `normalize_udp_json`. New capture code should
always use `"recall.v2"`, `source: "control_surface"`, and the canonical field names
above, nested under `payload`.
