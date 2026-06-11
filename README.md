# Recall Studio

**Local-first session memory for Ableton Live.** Recall Studio captures what you
actually do in a session — tracks, devices, parameters, clips, tempo — and turns it
into a structured, reviewable timeline. Think version control for music production:
not just the final `.als`, but *what changed, when, and how the session evolved*.

It connects Ableton Live → Max for Live → a native desktop app → local storage.
AI-assisted review is a later layer; the foundation is accurate capture.

## The model

A session is a **normalized schema** you can browse and annotate:

```
Project (one per session)
└─ Track             midi · audio · return · group
   └─ Device         instrument · midi_effect · audio_effect
      └─ Parameter   value, min/max, normalized

CreativeMoment   pinned by you — confidence: rough → working → keeper → final
ParameterChange  before → after, derived from the event stream
```

The raw event log is the **system of record**; the schema above is a *rebuildable
projection* of it, so the model can evolve and be re-derived without losing data.
Creative moments are user-authored and never overwritten by a rebuild.

## Architecture

```
Ableton Live → Max for Live (recall_m4l_bridge.js) → UDP 127.0.0.1:9000
            → Rust backend (normalize → session ownership → SQLite → schema projection)
            → React schema timeline
```

| Layer | Job |
|---|---|
| **Max for Live** | Observe Ableton; send heartbeats, lifecycle events, and deep snapshots. Stays thin — no storage or AI. |
| **Rust / Tauri** | UDP intake, validate the protocol, own session lifecycle, persist to SQLite, materialize the normalized schema, expose Tauri commands. |
| **React** | The three surfaces: **Project Schema**, **Timeline** (entity tree + change/moment stream + detail), **Reference**. |
| **SQLite** | Local-first: the event log (system of record) + the normalized projection + curation/notes. |

## Recall Protocol (v2)

Events are JSON over UDP. The backend assigns `session_id` when a session is active and
promotes canonical fields (track/device/parameter/…) to the top level so the UI never
digs through payloads. (v1 events are still accepted for older captures.)

```json
{
  "protocol": "recall.v2",
  "source": "max_for_live",
  "event_type": "device_added",
  "timestamp_ms": 1779251337349,
  "title": "Device Added",
  "description": "Added a device to Bass 1.",
  "track_name": "Bass 1",
  "device_name": "Operator",
  "device_chain": "Operator : Saturator : EQ Eight",
  "payload": "{ ... }",
  "session_id": null
}
```

## Project structure

```
recall-studio/
├─ src/                        React + TypeScript frontend
│  ├─ App.tsx                  Shell: Project Schema / Timeline / Reference
│  ├─ components/schema/       Entity tree, change+moment stream, detail panel
│  ├─ lib/schema/              Tauri command wrappers + stream/tree helpers
│  ├─ types/                   recall.ts (events) + schema.ts (normalized model)
│  └─ features/home/           Landing + Max for Live bridge setup
├─ src-tauri/src/              Rust backend
│  ├─ main.rs / lib.rs         Entry point + Tauri command registration
│  ├─ udp_listener.rs          UDP intake + normalize + connection state
│  ├─ protocol.rs              RecallEvent model
│  ├─ event_catalog.rs         Event vocabulary + priority (drop policy)
│  ├─ session.rs               Session lifecycle + ownership
│  ├─ storage.rs               SQLite: event log + normalized projection
│  ├─ schema_projection.rs     Snapshot → Track/Device/Parameter, before/after
│  └─ metrics.rs / install.rs  Bridge metrics + device install
├─ m4l/
│  ├─ recall_m4l_bridge.js     Max for Live bridge (telemetry + deep snapshots)
│  └─ *.amxd                   Max for Live device
├─ send-heartbeat.cjs          Dev-only fake UDP sender
└─ package.json
```

## SQLite model

- **`sessions`, `events`** — the immutable log; events carry canonical
  track/device/parameter columns alongside the raw payload.
- **`tracks` / `devices` / `parameters` / `parameter_changes`** — the normalized
  projection, rebuilt from the log on demand.
- **`creative_moments` / `creative_moment_targets`** — user-authored, persistent.
- **`event_curation` / `session_notes`** — hide/rename events, attach notes.

## Run

```bash
npm install
npm run tauri dev        # React frontend + Rust/Tauri backend
```

Backend test without Ableton:

```bash
node send-heartbeat.cjs  # fake UDP sender
```

With the real device: open Ableton, load the Max for Live bridge from
`m4l/recall_m4l_bridge.js`, and don't run the fake sender at the same time.

## Roadmap

- ✅ Native app, UDP intake, Recall Protocol, session lifecycle
- ✅ Local SQLite with canonical event columns
- ✅ Max for Live telemetry bridge (lifecycle, devices, deep snapshots)
- ✅ Normalized schema projection + user-created creative moments + confidence
- ⏳ Richer capture: routing, clips, return-track parameters
- ⏳ Ableton project (`.als`) file watching
- 🔜 AI session summaries layered on the captured schema

## Design principles

- **Keep telemetry quiet** — no high-frequency parameter spam; it bloats SQLite and
  muddies the timeline.
- **Bridge stays thin** — Max observes, the app owns storage, projection, and review.
- **Local-first** — unreleased music stays on the producer's machine.
- **Flexible payloads** — event payload is stringified JSON, so new event types don't
  force a schema migration.

## Commits

Explain *what* changed and *why* it matters:

```
git commit -m "Persist session-owned events for local Ableton history"
git commit -m "Materialize a normalized schema projection from the event log"
```

Avoid `update files`, `fix stuff`, `changes`.

## License

MIT
