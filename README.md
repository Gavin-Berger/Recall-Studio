Copy this into README.md:

# Recall Studio

Recall Studio is a native desktop application for Ableton Live producers that captures structured session activity, stores local session history, and helps producers review what happened during a creative session.

Recall Studio brings a scientific, version-control-inspired layer to music production. Instead of only saving the final Ableton project file, the app tracks what changed, when it changed, and how the session evolved over time.

The goal is to give producers a structured memory system for creative decisions, sound design changes, workflow history, and session review.

This project is not a generic AI chatbot. The core idea is a hybrid creative telemetry and session memory platform that connects Ableton Live, a Max for Live device, a native desktop app, local storage, and future AI-assisted session review.

---

## Product Vision

Music producers make hundreds of small decisions during a session:

- selecting tracks
- changing devices
- adjusting parameters
- launching clips
- changing tempo
- arranging sections
- testing sound design ideas
- muting, soloing, and arming tracks
- moving between creative directions

Most of that history disappears once the session is over.

Recall Studio is designed to help producers answer:

- What happened during this session?
- What did I change?
- What track or device was I working on?
- What creative decisions did I make?
- How did the session evolve over time?
- What can I review later?

The long-term goal is to give producers a structured session memory system similar to version control, but designed for music production instead of code.

---

## Current Development Focus

The current focus is the direct connection between:

Max for Live Device
→ Recall Studio Native App

The AI vision and screen recording features are part of the long-term direction, but they come later.

Right now, the priority is building a reliable Ableton telemetry foundation because future AI summaries will only be useful if the app first captures accurate session data.

Current MVP Status

Current working features:

Tauri v2 native desktop application
React + TypeScript frontend
Rust backend
UDP listener on 127.0.0.1:9000
Recall Protocol v1 JSON event model
heartbeat connection detection
live connection state in the UI
in-memory event queue
live session timeline UI
session start/stop lifecycle
active session ownership for events
SQLite local storage foundation
SQLite persistence for session-owned events
fake Node UDP sender for development testing
early Max for Live bridge direction
Tech Stack
Desktop App
Tauri v2
Rust backend
React frontend
TypeScript
CSS
Backend / Systems
Rust
UDP localhost communication
SQLite
rusqlite
shared application state with Arc<Mutex<...>>
local-first storage design
Ableton Integration
Max for Live
Node for Max
UDP bridge from Max for Live to native app
Recall Protocol v1 JSON events
Development Tools
Node.js
npm
Cargo
Git / GitHub
VS Code
Ableton Live
Max for Live
High-Level Architecture
Ableton Live
↓
Max for Live Device
↓ UDP localhost
Recall Studio Rust Backend
↓
Recall Protocol Parser
↓
Session Ownership Layer
↓
SQLite Local Storage
↓
React Timeline UI
System Responsibilities
Max for Live Device

The Max for Live device should stay lightweight and focused.

Responsibilities:

observe Ableton Live state
send heartbeat events
send structured Recall Protocol events
report transport, tempo, track, clip, device, and parameter changes
avoid owning session storage or AI logic

Why: Max for Live should collect Ableton telemetry, while the native app owns memory, storage, review, and analysis.

Rust / Tauri Backend

Responsibilities:

run the local UDP listener
receive Recall Protocol events
validate event structure
update connection status
manage session lifecycle
attach events to the active session
persist session-owned events to SQLite
expose backend state to the React frontend through Tauri commands

Why: the backend is the system layer that turns raw Ableton events into durable local session memory.

React Frontend

Responsibilities:

display connection state
display active session state
show storage status
render the live session timeline
allow users to start and stop session tracking

Why: the frontend is the producer-facing control and review surface.

SQLite Storage

Responsibilities:

store sessions
store session-owned events
support future saved session review
support future AI summaries
support local-first history

Why: Recall Studio should preserve session history on the producer’s machine without requiring cloud storage.

Project Structure
Recall-Studio/
├── src/
│ ├── App.tsx
│ └── App.css
│
├── src-tauri/
│ ├── src/
│ │ ├── main.rs
│ │ ├── lib.rs
│ │ ├── protocol.rs
│ │ ├── udp_listener.rs
│ │ ├── session.rs
│ │ └── storage.rs
│ │
│ ├── Cargo.toml
│ ├── Cargo.lock
│ └── tauri.conf.json
│
├── m4l/
│ └── RecallStudioBridge/
│ ├── RecallStudioBridge.amxd
│ └── recall_m4l_bridge.js
│
├── send-heartbeat.cjs
├── package.json
└── README.md
Core Backend Files
main.rs

Minimal Tauri entry point.

fn main() {
recall_studio_lib::run()
}

Why: the main file should stay small. The real backend wiring belongs in lib.rs.

lib.rs

Backend coordinator.

Responsibilities:

initialize app state
initialize SQLite
start the UDP listener
register Tauri commands
connect session, storage, events, and frontend state

Why: lib.rs wires the system together without forcing all logic into one file.

protocol.rs

Defines the Recall Protocol event model.

pub struct RecallEvent {
pub protocol: String,
pub source: String,
pub event_type: String,
pub timestamp_ms: u64,
pub title: String,
pub description: String,
pub payload: Option<String>,
pub session_id: Option<String>,
}

Why: every event from Max for Live or a development sender must follow a predictable structure before the app can parse, store, and review session activity reliably.

udp_listener.rs

Runs the UDP listener on:

127.0.0.1:9000

Responsibilities:

receive UDP messages
parse Recall Protocol JSON
validate protocol version
update heartbeat connection state
attach active session ownership
persist session-owned events
push events into the live timeline queue

Why: this is the bridge between Ableton/Max and the native app.

session.rs

Manages session lifecycle.

Not Started
→ Start Session
→ Tracking
→ Stop Session

Responsibilities:

create a session ID
track whether a session is active
expose current session status
provide active session ownership to incoming events

Why: events need to belong to a real production session before they can become useful history.

storage.rs

Initializes SQLite and stores local session history.

Responsibilities:

create/open the local SQLite database
create the sessions table
create the events table
save session starts
save session stops
save session-owned events

Why: Recall Studio is local-first. Producer history should live on the user’s machine and survive after the app closes.

Recall Protocol v1

Recall Studio receives structured JSON events.

Example:

{
"protocol": "recall.v1",
"source": "max_for_live",
"event_type": "tempo_changed",
"timestamp_ms": 1779251337349,
"title": "Tempo Changed",
"description": "Tempo changed to 140 BPM.",
"payload": "{\"bpm\":140,\"previous_bpm\":128}",
"session_id": null
}

The native app assigns session_id when a session is active.

Why: Max for Live should report Ableton activity, while the native app should own session tracking and persistence.

Current Event Types

Current and planned event types include:

heartbeat
device_loaded
device_unloaded
session_started
transport_play
transport_stop
tempo_changed
track_selected
device_selected
parameter_changed
clip_launched
automation_changed
file_changed
session_marker
Local Storage Model

Recall Studio currently stores:

sessions
events

The relationship is:

one session
→ many events

This matters because future session review and AI summaries need to reconstruct what happened during a specific production session.

sessions

Planned/current fields:

id
started_at_ms
ended_at_ms
created_at_ms
events

Planned/current fields:

id
session_id
protocol
source
event_type
timestamp_ms
title
description
payload
created_at_ms
Running the App

Install dependencies:

npm install

Run the Tauri app:

npm run tauri dev

This launches both the React frontend and the Rust/Tauri backend.

Testing With the Fake UDP Sender

The fake Node sender is used for backend testing before the Max for Live device is complete.

In a second terminal:

node send-heartbeat.cjs

Expected behavior:

Max for Live status turns connected
timeline receives structured events
session-owned events are attached when a session is active
SQLite persists events during active sessions

Why: the fake sender lets the backend be tested before the real Max for Live device is finished.

Testing With the Real Max for Live Device

When testing the real Max for Live device:

Start Recall Studio:
npm run tauri dev
Open Ableton Live.
Load the Recall Studio Max for Live device.
Do not run send-heartbeat.cjs.

Why: when testing the real device, Ableton/Max should be the only sender.

Max for Live Bridge

The next major focus is replacing the fake Node sender with a real Max for Live device.

Development location:

m4l/RecallStudioBridge/

Expected files:

RecallStudioBridge.amxd
recall_m4l_bridge.js

The Max for Live device should send Recall Protocol JSON over UDP to:

127.0.0.1:9000

Why: the direct Max for Live connection is the foundation of the product.

Max for Live Development Plan

The first real Max for Live milestones are:

Send heartbeat from Max for Live
Send device loaded event
Send tempo changes
Send transport play/stop
Send selected track changes
Send selected device changes
Send parameter changes with rate limiting
Send session snapshots

This order matters because each step proves one Ableton capability without overloading the system too early.

Development Roadmap
Phase 1 — Native App Foundation

Status: mostly complete.

Goals:

create Tauri app
create React frontend
create Rust backend
create UDP listener
create connection state
create event timeline

Why: this phase proves the native app can receive and display local telemetry.

Phase 2 — Recall Protocol Foundation

Status: mostly complete.

Goals:

define Recall Protocol v1
parse structured JSON events
support multiple event types
preserve payload flexibility
keep protocol stable enough for Max for Live

Why: this phase creates the event contract between Ableton and the native app.

Phase 3 — Session Lifecycle

Status: mostly complete.

Goals:

start session
stop session
track active session state
assign session IDs
attach incoming events to active sessions

Why: session ownership is required before storing, reviewing, or summarizing producer history.

Phase 4 — Local Storage

Status: in progress.

Goals:

initialize SQLite
create sessions and events tables
persist session starts
persist session stops
persist session-owned events
later load saved sessions into the UI

Why: local persistence turns live telemetry into durable session memory.

Phase 5 — Max for Live Telemetry Bridge

Status: current major focus.

Goals:

build Max for Live bridge device
send heartbeat from Ableton
send device loaded/unloaded events
read and send tempo changes
read and send transport state
read and send selected track changes
read and send selected device changes
send parameter changes with rate limiting

Why: this phase turns Recall Studio from a simulated event system into a real Ableton-connected product.

Phase 6 — Session Review UI

Status: planned.

Goals:

show saved sessions
open past sessions
display persisted event history
group events by time/category
prepare summaries from saved data

Why: producers need to review completed sessions, not only watch live events.

Phase 7 — File Watching

Status: planned.

Goals:

watch Ableton project files
detect .als save changes
detect project folder changes
attach file changes to sessions

Why: project file changes are part of the session history and help reconstruct workflow.

Phase 8 — AI Review Layer

Status: planned for later.

Goals:

generate session summaries
summarize track/device activity
highlight major creative decisions
optionally combine structured events with recordings or screenshots

Why: AI should sit on top of reliable session telemetry, not replace it.

Development Source of Truth

The project repo should be the source of truth for the Max for Live bridge.

Recommended structure:

m4l/
└── RecallStudioBridge/
├── RecallStudioBridge.amxd
└── recall_m4l_bridge.js

During development, Ableton can load the device from this repo folder.

Why: editing random copies inside Ableton’s User Library can cause version confusion and lost work.

What This Project Is Not

Recall Studio is not:

a generic chatbot
a simple note-taking app
just a screen recorder
just an Ableton plugin
just an AI wrapper
just a timeline UI

Recall Studio is a hybrid session memory system for music producers.

Current Development Priorities
Stabilize Max for Live → native app connection
Expand Ableton telemetry collection
Improve Recall Protocol event definitions
Persist and review local session history
Add saved session loading
Add project file watching
Add screen recording / AI vision context later
Add AI-assisted session summaries later
Key Engineering Concerns
Avoid noisy telemetry

The Max for Live device should not spam every tiny parameter value at high frequency.

Why: noisy event data makes SQLite large, makes the timeline harder to read, and makes future AI summaries worse.

Keep Max for Live lightweight

Max for Live should observe Ableton and send events.

Why: the native app should own storage, AI, review, and session reconstruction.

Keep storage local-first

Session data should be stored locally.

Why: producers may be working on private unreleased music, so local-first architecture matters.

Keep protocol flexible

The event payload is stored as a stringified JSON object.

Why: different Ableton events need different payload shapes, and the database should not need a schema change for every new event type.

Git Commit Style

Commits should explain both what changed and why it matters.

Preferred style:

git commit -m "Attach events to active sessions for reliable session reconstruction"

Good examples:

git commit -m "Add SQLite storage foundation for local-first session history"
git commit -m "Persist session-owned events for local Ableton history"
git commit -m "Add Max for Live UDP bridge for native app connection"
git commit -m "Define Max for Live telemetry contract for Recall Protocol events"

Avoid vague commits like:

git commit -m "update files"
git commit -m "fix stuff"
git commit -m "changes"
Long-Term Vision

The long-term version of Recall Studio should allow a producer to open Ableton, start a tracked session, create music, and later review a structured timeline of what happened.

The product should help producers understand the evolution of their creative work, not just the final result.

Future Recall Studio features may include:

saved session browser
session replay timeline
track/device activity summaries
parameter change summaries
clip launch history
project file change detection
screen recording or screenshot context
AI-generated session summaries
searchable local session memory
exportable producer logs

The foundation is the direct Ableton telemetry bridge. Everything else builds on top of that.

Commit it with:

```bash
git add README.md
git commit -m "Document technical roadmap for Recall Studio completion"
git push
```
