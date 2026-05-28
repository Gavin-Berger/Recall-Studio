# Recall Protocol v2

This document is the canonical contract between the Max for Live bridge and Recall Studio.
The Rust backend and TypeScript frontend both rely on this spec. Do not add synonyms or
alternative field names — pick one and use it everywhere.

## Packet format

Every event is a flat JSON object sent over UDP to `127.0.0.1:9000`.

```json
{
  "protocol":        "recall.v2",
  "event_type":      "track_selected",
  "timestamp_ms":    1716900000000,
  "track_name":      "Vocals",
  "device_name":     null,
  "parameter_name":  null,
  "parameter_value": null,
  "clip_name":       null,
  "bpm":             128.0,
  "playing":         false
}
```

## Required fields

| Field | Type | Description |
|---|---|---|
| `protocol` | `"recall.v2"` | Literal string — used for version gating |
| `event_type` | string | From the vocabulary below — exact match, lowercase |
| `timestamp_ms` | integer | Milliseconds since Unix epoch from Ableton's clock |

## Optional fields

Send these only when relevant to the event type. Send `null` or omit when not applicable.
**Do not send stale values from a previous event.**

| Field | Type | When to send |
|---|---|---|
| `track_name` | string | Any event where a specific track is the subject |
| `device_name` | string | `device_*` events |
| `parameter_name` | string | `parameter_changed` |
| `parameter_value` | number | `parameter_changed` — the settled final value |
| `parameter_value_min` | number | `parameter_changed` — lowest value during the gesture |
| `parameter_value_max` | number | `parameter_changed` — highest value during the gesture |
| `clip_name` | string | `clip_*` events |
| `bpm` | number | `tempo_changed`, `live_set_snapshot` |
| `playing` | boolean | `transport_play`, `transport_stop`, `live_set_snapshot` |

## Event type vocabulary

Use these exact strings. The Rust backend maps them to internal types; unknown strings
are logged but not classified.

### System (not persisted, not shown in timeline)
- `heartbeat` — Max for Live bridge keepalive, send every 2 seconds

### Transport (analytics only — counted but not shown in timeline)
- `transport_play` — user pressed play
- `transport_stop` — user pressed stop
- `tempo_changed` — BPM value changed (include `bpm` field)

### Track context (context only — informs grouping but not shown)
- `track_selected` — user clicked a different track (include `track_name`)

### Creative actions (shown in timeline)
- `device_added` — a device was added to a track's chain
- `device_removed` — a device was removed
- `clip_created` — a new clip was created
- `clip_launched` — a clip was triggered
- `clip_deleted` — a clip was deleted
- `scene_launched` — a scene was triggered
- `group_focused` — user expanded/focused a group track
- `live_set_snapshot` — periodic full session state dump

### Special
- `parameter_changed` — a device parameter value changed (see rate-limiting below)

## Parameter rate-limiting (critical for performance)

**Do NOT send `parameter_changed` on every automation frame.** At 60fps this is 3600 events/minute per parameter — it will saturate both Ableton's M4L thread and the UDP socket.

Instead, in Max for Live:
1. Start a timer on first change
2. Reset the timer on each subsequent change
3. When the timer fires (100ms of silence), send ONE `parameter_changed` event with:
   - `parameter_value`: the final settled value
   - `parameter_value_min`: lowest value during the gesture (optional)
   - `parameter_value_max`: highest value during the gesture (optional)

This turns 50 micro-events into 1 meaningful event.

## Heartbeat

Send every 2 seconds while Ableton is open. Recall Studio shows "connected" if a heartbeat
arrived within the last 5 seconds.

```json
{
  "protocol":    "recall.v2",
  "event_type":  "heartbeat",
  "timestamp_ms": 1716900000000
}
```

Heartbeats are **not** persisted to the database and **not** shown in the timeline.
They are connection health signals only.

## Backwards compatibility

The Rust backend also accepts `"recall.v1"` and `"recall.protocol.v1"` protocol strings
for events that don't include these structured fields. Those events are still processed
but the frontend will have to fall back to heuristic field guessing.

New Max for Live patches should always use `"recall.v2"` and the canonical field names above.
