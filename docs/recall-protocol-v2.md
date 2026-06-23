# Recall Protocol v2

This document is the canonical contract between the Max for Live bridge and Recall Studio.
The Rust backend and TypeScript frontend both rely on this spec. Do not add synonyms or
alternative field names — pick one and use it everywhere.

> **Audience note.** This is the engineering wire contract — `event_type` strings and field
> names are technical on purpose; producers never see them. The **"What the producer sees"**
> column shows the plain-language, musical phrasing the timeline renders from each event.
> That column is the source of truth for tone: anything producer-facing must read like a
> producer wrote it, never like a debug log.

Implemented by bridge **v0.9.0**. When the bridge and this doc disagree, the bridge is
right and this doc is a bug — update it.

## Packet format

Every event is a flat JSON object sent over UDP to `127.0.0.1:9000`.

```json
{
  "protocol":        "recall.v2",
  "source":          "max_for_live",
  "event_type":      "sample_added",
  "timestamp_ms":    1716900000000,
  "title":           "Sample Added",
  "description":     "Sample \"Deep_House_Vocal_120bpm.wav\" was added to \"Vocals\".",
  "track_name":      "Vocals",
  "sample_name":     "Deep_House_Vocal_120bpm.wav",
  "file_path":       "C:/Splice/samples/Deep_House_Vocal_120bpm.wav",
  "clip_name":       "Deep_House_Vocal_120bpm",
  "payload":         { "...": "raw detail, debugging only" },
  "session_id":      null
}
```

## Envelope fields

| Field | Type | Who sets it | Notes |
|---|---|---|---|
| `protocol` | `"recall.v2"` | bridge | Version gate. `recall.v1` / `recall.protocol.v1` still accepted (see bottom). |
| `source` | string | bridge | `"max_for_live"` for the M4L bridge, `"ableton_extension_sdk"` for the experimental SDK path. |
| `event_type` | string | bridge | From the vocabulary below — exact, lowercase. |
| `timestamp_ms` | integer | bridge | Milliseconds since Unix epoch. |
| `title` | string | bridge or backend | Human title. If omitted, the backend generates one from `event_type`. |
| `description` | string | bridge or backend | Human description. Backend generates a fallback if omitted. |
| `payload` | object | bridge | Raw detail for debugging. Flattened to a string at storage. Never relied on for canonical fields. |
| `session_id` | null | **backend** | Ableton must NOT assign session ownership — Recall Studio stamps this when a session is active. |

The bridge also tucks `payload._bridge = { device_id, bridge_version, sequence }` into every
packet. `sequence` increments per event and is the hook for future drop-detection.

## Canonical fields

These are lifted to the **top level** of the packet (not buried in `payload`) so the backend
reads them directly. Send only what's relevant to the event; send `null` or omit the rest.
**Never send a stale value carried over from a previous event.**

| Field | Type | When to send | What the producer sees it as |
|---|---|---|---|
| `track_name` | string | any event about a specific track | which track they were working on |
| `device_name` | string | `device_added` / `device_removed` | the instrument or effect, e.g. "Serum 2" |
| `device_chain` | string | `device_*` | the full signal chain, e.g. "Serum 2 : Saturator : Vocoder" |
| `parameter_name` | string | `automation_created` / `parameter_changed` | the knob/control, e.g. "Filter Cutoff" |
| `parameter_value` | number | `parameter_changed` | the settled value |
| `previous_parameter_value` | number | `parameter_changed` | the previous value seen on the selected-track scan |
| `parameter_value_percent` / `previous_parameter_value_percent` | number | `parameter_changed` | before/after value normalized to the parameter range, 0-100 |
| `parameter_value_min` / `_max` | number | `parameter_changed` | the range swept during a move |
| `clip_name` | string | `clip_*`, `sample_added`, `*_clip_*` | the clip's name |
| `sample_name` | string | `sample_added` | the actual sample file, e.g. "Deep_House_Vocal_120bpm.wav" |
| `file_path` | string | `sample_added` | where the sample came from on disk (Splice folder, etc.) |
| `bpm` | number | `tempo_changed`, snapshots | the project tempo |
| `playing` | boolean | `transport_play/stop`, snapshots | whether the set is playing |

## Event vocabulary

Exact, lowercase strings. The backend maps them to internal categories; unknown strings are
logged but not classified. The **Shown?** column is how the event surfaces (see "How events
surface" below).

### Bridge lifecycle (connection health — not shown in the timeline)

| `event_type` | Shown? | What the producer sees |
|---|---|---|
| `heartbeat` | hidden | (drives the "Connected" light only; sent every 2s) |
| `device_loaded` | hidden | bridge came online |
| `bridge_started` | hidden | capture started |
| `bridge_stopped` | hidden | capture stopped |

### Transport & tempo

| `event_type` | Shown? | What the producer sees |
|---|---|---|
| `transport_play` | analytics | (counted as playbacks, not a timeline row) |
| `transport_stop` | analytics | (counted, not a row — producers hit stop constantly) |
| `transport_snapshot` | context | (internal state diff; only surfaces if something real changed) |
| `tempo_changed` | **shown** | "Changed the tempo to 124 BPM" |

### Track work

| `event_type` | Shown? | What the producer sees |
|---|---|---|
| `track_selected` | context (hidden) | (navigation — deliberately not a creative moment) |
| `selected_track_focus_snapshot` | context (hidden) | (internal detail scan of the focused track) |
| `track_created` | **shown** | "Made a new track" |
| `track_deleted` | **shown** | "Deleted a track" |
| `track_name_changed` | **shown** | "Renamed the track to Bass" |
| `track_muted` / `track_unmuted` | **shown** | "Muted the Drums" / "Unmuted the Drums" |
| `track_soloed` / `track_unsoloed` | **shown** | "Soloed the Bass" / "Took the Bass off solo" |
| `track_armed` / `track_unarmed` | **shown** | "Armed the Bass to record" |

### Instruments & effects

| `event_type` | Shown? | What the producer sees |
|---|---|---|
| `device_added` | **shown** | "Added Serum 2 to the Bass" |
| `device_removed` | **shown** | "Removed Saturator from the Bass" |
| `device_chain_changed` | **shown** | "Reworked the chain on the Bass: Serum 2 : Saturator" |

### Sounds, samples & clips

| `event_type` | Shown? | What the producer sees |
|---|---|---|
| `sample_added` | **shown** | "Dropped in Deep_House_Vocal_120bpm.wav" |
| `audio_clip_added` | **shown** | "Added an audio clip" (recorded/resampled, no source file) |
| `midi_clip_created` | **shown** | "Started a new MIDI clip" |
| `clip_created` | **shown** | "Created a clip" (type unknown) |
| `clip_deleted` | **shown** | "Deleted a clip" |

### Automation

| `event_type` | Shown? | What the producer sees |
|---|---|---|
| `automation_created` | **shown** | "Automated the Filter Cutoff on Serum 2 at Bar 12" |

### Session snapshots

| `event_type` | Shown? | What the producer sees |
|---|---|---|
| `live_set_snapshot` | context | (full set state; only surfaces on a meaningful change) |
| `session_snapshot` | context | (manual deep capture of the whole set) |

### Manual entry points (sent only when a Max message is fired into the `js` object)

These exist for testing/extension and are **not** part of automatic capture:
`tempo`, `playing`, `beat_time`, `track_name`, `clip_event`, `device_event`,
`parameter_event`, `deep_snapshot`, plus `raw_max_message` (catch-all for debugging).

## How events surface to the producer

The backend sorts every event into one of four roles. This is the line between "raw
telemetry" and "the session story."

| Role | Meaning | Example |
|---|---|---|
| **hidden** | health/navigation only; never stored as a moment | heartbeat, track selection |
| **analytics** | counted for stats, not shown as a row | play/stop counts |
| **context** | informs grouping; only shown if it represents a real change | snapshots |
| **shown** | a deliberate creative move — always in the timeline | added a device, dropped a sample, wrote automation |

The marketable surface — the session document and activity blocks — is built from the
**shown** events. Everything else is plumbing.

## Known capture gaps (read before alpha)

The bridge **polls and diffs** Ableton; it is not told what changed. That makes some things
structurally hard or impossible to catch. State these plainly to testers so a miss reads as
a known limit, not a broken promise.

1. **Sub-poll actions are invisible.** Anything done and undone between two scans (~2–4s,
   slower while playing) is never seen. Fast undo/redo flurries won't all register.
2. **Background-track automation is not captured.** Automation writing is read only on the
   **selected** track — reading every parameter on every track is the documented Ableton
   crash trigger. Automate a track you're not looking at and it won't be logged.
3. **Live knob/fader moves are selected-track only.** The bridge polls the focused
   track's bounded device/parameter set and emits settled `parameter_changed` moves
   with before/after values and normalized percentages. Background tracks are not
   parameter-scanned.
4. **Session View clip slots only — Arrangement timeline clips are not diffed yet.** Sample
   and clip detection watches Session View clip slots. Dropping a sample onto the
   **Arrangement** timeline may not register. (High-priority gap to close.)
5. **Background-track adds have latency.** The all-track scan is round-robin (a few tracks
   per tick), so a device/sample added to a non-focused track can take a few seconds — up to
   a full sweep — to appear.
6. **No arrangement edits.** Split, crop, consolidate, warp, nudge, fades — LiveAPI doesn't
   expose these, so they aren't captured.
7. **No MIDI note editing.** Adding/moving/velocity of individual notes isn't captured.
8. **Clip moves / renames / duplicates** aren't tracked (only created/deleted via slot diff).

## Parameter rate-limiting

`parameter_changed` is auto-emitted only from the selected-track focus scan. The scan cadence
is the rate limit: a continuous knob ride collapses to one settled event per scan, carrying
`previous_parameter_value`, `parameter_value`, optional swept `parameter_value_min` /
`parameter_value_max`, and normalized before/after percentages.

Sending per-frame parameter events is still a hard no.

## Heartbeat

Send every 2 seconds while Ableton is open. Recall Studio shows "Connected" if a heartbeat
arrived within the last 5 seconds.

```json
{
  "protocol":     "recall.v2",
  "event_type":   "heartbeat",
  "timestamp_ms": 1716900000000
}
```

Heartbeats are **not** persisted and **not** shown — connection health only. The bridge
version travels in the heartbeat payload so the app can show which build is connected.

## Backwards compatibility

The backend also accepts `"recall.v1"` and `"recall.protocol.v1"` for events without these
structured fields. Those are still processed, but the frontend falls back to heuristic field
guessing and saved-session fields are recovered from `payload`. New patches should always use
`"recall.v2"` and the canonical field names above.
