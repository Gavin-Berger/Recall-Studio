# Recall Studio

Recall Studio is a local first desktop application for Ableton Live producers that captures structured session activity, stores local session history, and helps producers review what happened during a creative session.

The goal is to bring a scientific, version-control-inspired layer to music production. Instead of only saving the final Ableton project file, Recall Studio tracks what changed, when it changed, and how the session evolved over time.

Recall Studio is not a generic AI chatbot. It is a hybrid creative telemetry and session memory platform that connects Ableton Live, Max for Live, a native desktop app, local storage, and future AI-assisted session review.

---

## Product Vision

Music producers make hundreds of small creative decisions during a session:

- Selecting tracks
- Changing devices
- Adjusting parameters
- Launching clips
- Changing tempo
- Arranging sections
- Testing sound design ideas
- Muting, soloing, and arming tracks
- Moving between creative directions

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

```text
Max for Live Device
        ↓
Recall Studio Native App

The AI vision and screen recording features are part of the long-term direction, but they come later.

Right now, the priority is building a reliable Ableton telemetry foundation because future AI summaries will only be useful if the app first captures accurate session data.

Current MVP Status

Current working features:

Tauri v2 native desktop application
React + TypeScript frontend
Rust backend
UDP listener on 127.0.0.1:9000
Recall Protocol v1 JSON event model
Heartbeat connection detection
Live connection state in the UI
In-memory event queue
Live session timeline UI
Session start/stop lifecycle
Active session ownership for events
SQLite local storage foundation
SQLite persistence for session-owned events
Fake Node UDP sender for development testing
Early Max for Live bridge direction
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
Shared application state with Arc<Mutex<...>>
Local-first storage design
Ableton Integration
Ableton Live
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
High-Level Architecture
Ableton Live
    ↓
Max for Live Device
    ↓
UDP Localhost
    ↓
Recall Studio Rust Backend
    ↓
Recall Protocol Parser
    ↓
Session Ownership Layer
    ↓
SQLite Local Storage
    ↓
React Timeline UI
Project Structure
Recall-Studio/
├── src/
│   ├── App.tsx
│   └── App.css
│
├── src-tauri/
│   ├── src/
│   │   ├── main.rs
│   │   ├── lib.rs
│   │   ├── protocol.rs
│   │   ├── udp_listener.rs
│   │   ├── session.rs
│   │   └── storage.rs
│   │
│   ├── Cargo.toml
│   ├── Cargo.lock
│   └── tauri.conf.json
│
├── m4l/
│   └── RecallStudioBridge/
│       ├── RecallStudioBridge.amxd
│       └── recall_m4l_bridge.js
│
├── send-heartbeat.cjs
├── package.json
└── README.md
System Responsibilities
Max for Live Device

The Max for Live device should stay lightweight and focused.

Responsibilities:

Observe Ableton Live state
Send heartbeat events
Send structured Recall Protocol events
Report transport, tempo, track, clip, device, and parameter changes
Avoid owning session storage or AI logic

Why: Max for Live should collect Ableton telemetry, while the native app owns memory, storage, review, and analysis.

Rust / Tauri Backend

Responsibilities:

Run the local UDP listener
Receive Recall Protocol events
Validate event structure
Update connection status
Manage session lifecycle
Attach events to the active session
Persist session-owned events to SQLite
Expose backend state to the React frontend through Tauri commands

Why: The backend turns raw Ableton events into durable local session memory.

React Frontend

Responsibilities:

Display connection state
Display active session state
Show storage status
Render the live session timeline
Allow users to start and stop session tracking

Why: The frontend is the producer-facing control and review surface.

SQLite Storage

Responsibilities:

Store sessions
Store session-owned events
Support future saved session review
Support future AI summaries
Preserve local-first history

Why: Recall Studio should preserve session history on the producer’s machine without requiring cloud storage.

Core Backend Files
main.rs

Minimal Tauri entry point.

fn main() {
    recall_studio_lib::run()
}

Why: The main file should stay small. The real backend wiring belongs in lib.rs.

lib.rs

Backend coordinator.

Responsibilities:

Initialize app state
Initialize SQLite
Start the UDP listener
Register Tauri commands
Connect session, storage, events, and frontend state

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

Why: Every event from Max for Live or a development sender must follow a predictable structure before the app can parse, store, and review session activity reliably.

udp_listener.rs

Runs the UDP listener on:

127.0.0.1:9000

Responsibilities:

Receive UDP messages
Parse Recall Protocol JSON
Validate protocol version
Update heartbeat connection state
Attach active session ownership
Persist session-owned events
Push events into the live timeline queue

Why: This is the bridge between Ableton/Max and the native app.

session.rs

Manages session lifecycle.

Not Started → Start Session → Tracking → Stop Session

Responsibilities:

Create a session ID
Track whether a session is active
Expose current session status
Provide active session ownership to incoming events

Why: Events need to belong to a real production session before they can become useful history.

storage.rs

Initializes SQLite and stores local session history.

Responsibilities:

Create/open the local SQLite database
Create the sessions table
Create the events table
Save session starts
Save session stops
Save session-owned events

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

Current and Planned Event Types
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

Relationship:

One session → many events

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
Timeline receives structured events
Session-owned events are attached when a session is active
SQLite persists events during active sessions

Why: The fake sender lets the backend be tested before the real Max for Live device is finished.

Testing With the Real Max for Live Device

When testing the real Max for Live device:

Start Recall Studio:
npm run tauri dev
Open Ableton Live.
Load the Recall Studio Max for Live device.
Do not run:
node send-heartbeat.cjs

Why: When testing the real device, Ableton/Max should be the only sender.

Max for Live Bridge

The next major focus is replacing the fake Node sender with a real Max for Live device.

Development location:

m4l/RecallStudioBridge/

Expected files:

RecallStudioBridge.amxd
recall_m4l_bridge.js

The Max for Live device should send Recall Protocol JSON over UDP to:

127.0.0.1:9000

Why: The direct Max for Live connection is the foundation of the product.

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

Status: Mostly complete.

Goals:

Create Tauri app
Create React frontend
Create Rust backend
Create UDP listener
Create connection state
Create event timeline

Why: This phase proves the native app can receive and display local telemetry.

Phase 2 — Recall Protocol Foundation

Status: Mostly complete.

Goals:

Define Recall Protocol v1
Parse structured JSON events
Support multiple event types
Preserve payload flexibility
Keep protocol stable enough for Max for Live

Why: This phase creates the event contract between Ableton and the native app.

Phase 3 — Session Lifecycle

Status: Mostly complete.

Goals:

Start session
Stop session
Track active session state
Assign session IDs
Attach incoming events to active sessions

Why: Session ownership is required before storing, reviewing, or summarizing producer history.

Phase 4 — Local Storage

Status: In progress.

Goals:

Initialize SQLite
Create sessions and events tables
Persist session starts
Persist session stops
Persist session-owned events
Later load saved sessions into the UI

Why: Local persistence turns live telemetry into durable session memory.

Phase 5 — Max for Live Telemetry Bridge

Status: Current major focus.

Goals:

Build Max for Live bridge device
Send heartbeat from Ableton
Send device loaded/unloaded events
Read and send tempo changes
Read and send transport state
Read and send selected track changes
Read and send selected device changes
Send parameter changes with rate limiting

Why: This phase turns Recall Studio from a simulated event system into a real Ableton-connected product.

Phase 6 — Session Review UI

Status: Planned.

Goals:

Show saved sessions
Open past sessions
Display persisted event history
Group events by time/category
Prepare summaries from saved data

Why: Producers need to review completed sessions, not only watch live events.

Phase 7 — File Watching

Status: Planned.

Goals:

Watch Ableton project files
Detect .als save changes
Detect project folder changes
Attach file changes to sessions

Why: Project file changes are part of the session history and help reconstruct workflow.

Phase 8 — AI Review Layer

Status: Planned for later.

Goals:

Generate session summaries
Summarize track/device activity
Highlight major creative decisions
Optionally combine structured events with recordings or screenshots

Why: AI should sit on top of reliable session telemetry, not replace it.

Development Source of Truth

The project repo should be the source of truth for the Max for Live bridge.

Recommended structure:

m4l/
└── RecallStudioBridge/
    ├── RecallStudioBridge.amxd
    └── recall_m4l_bridge.js

During development, Ableton can load the device from this repo folder.

Why: Editing random copies inside Ableton’s User Library can cause version confusion and lost work.

What This Project Is Not

Recall Studio is not:

A generic chatbot
A simple note-taking app
Just a screen recorder
Just an Ableton plugin
Just an AI wrapper
Just a timeline UI

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
Avoid Noisy Telemetry

The Max for Live device should not spam every tiny parameter value at high frequency.

Why: Noisy event data makes SQLite large, makes the timeline harder to read, and makes future AI summaries worse.

Keep Max for Live Lightweight

Max for Live should observe Ableton and send events.

Why: The native app should own storage, AI, review, and session reconstruction.

Keep Storage Local-First

Session data should be stored locally.

Why: Producers may be working on private unreleased music, so local-first architecture matters.

Keep Protocol Flexible

The event payload is stored as a stringified JSON object.

Why: Different Ableton events need different payload shapes, and the database should not need a schema change for every new event type.

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

Saved session browser
Session replay timeline
Track/device activity summaries
Parameter change summaries
Clip launch history
Project file change detection
Screen recording or screenshot context
AI-generated session summaries
Searchable local session memory
Exportable producer logs

The foundation is the direct Ableton telemetry bridge. Everything else builds on top of that.

Repository Description

Track Ableton activity, review session history, and turn production work into clean session logs.

License

MIT
```
