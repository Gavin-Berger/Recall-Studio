# Recall

Local-first **session memory for Ableton Live**. Recall watches what you do in a
session — tracks, devices, parameters, clips, tempo — and turns it into a structured,
reviewable timeline. Version control for music production, not just the final `.als`.

```
Ableton Live  →  Python control surface  →  TCP  →  Recall (Tauri · Rust · React)  →  local SQLite
```

Everything stays on your machine. No account, no cloud, nothing leaves your computer.

## The idea

A session becomes a browsable schema — `Project → Track → Device → Parameter` — and you
pin **creative moments** (confidence: rough → working → keeper → final) onto its
timeline. The raw event log is the source of truth; the schema is rebuilt from it.

## What it looks like

The project, captured as a tree:

```
Group: Bass
└─ Track 19 · Bass 1              [MIDI]
   ├─ Serum         [Instrument]    Waveform: Sine · Cutoff: 22%
   ├─ Saturator     [Audio FX]      Drive: 24% · Dry/Wet: 40%
   └─ Pro-L 2       [Audio FX]      Modern limiting
```

The timeline — factual parameter changes interleaved with moments you pin:

```
00:04:12   Cutoff   18% → 22%         Serum · Bass 1
00:05:01   ★ Found the bass tone      keeper
00:07:33   Drive    0% → 24%          Saturator · Bass 1
```

## How it captures

Ableton Live's Python scripting API — a **Control Surface**, the same mechanism Live
uses to talk to hardware controllers like Push — reports what changes in the set:
tracks, devices, parameter moves, clip note edits, tempo. `remote-script/Recall/` is
that script. It runs inside Live's own embedded interpreter, so nothing is polled or
scraped from outside the process.

It reports over a local **TCP** connection to `127.0.0.1:9001` rather than UDP, because
a whole-set snapshot on project load can exceed a single UDP datagram's size limit and
would be silently dropped; TCP has no such ceiling and confirms delivery. The Rust
backend listens, normalizes, and persists to SQLite.

The Recall app has no idea any of this happened until Live tells it — there is no
polling loop watching the `.als` file from outside.

## Getting started

**Requires:** Ableton Live 11 or 12, Windows or macOS, [Rust](https://rustup.rs) and
[Node.js](https://nodejs.org) if you're running from source.

1. **Clone and install**
   ```bash
   git clone https://github.com/Gavin-Berger/Recall-Studio.git
   cd Recall-Studio
   npm install
   ```

2. **Install the control surface into Ableton.** From a source checkout:
   ```bash
   node scripts/deploy-remote-script.mjs
   ```
   By default this looks for your User Library at `Documents/Ableton/User Library`
   (macOS: `Music/Ableton/User Library`). If yours lives somewhere else, point at it:
   ```bash
   RECALL_USER_LIBRARY="/path/to/your/User Library" node scripts/deploy-remote-script.mjs
   ```
   This writes into `<User Library>/Remote Scripts/Recall/` — the folder Ableton scans
   for control surfaces at startup.

3. **Restart Ableton Live.** It only looks for new control surfaces when it starts up;
   a script dropped into place while Live is already running won't be offered.

4. **Select it in Ableton.** Preferences → Link/Tempo/MIDI → in an empty
   **Control Surface** slot, choose **Recall**.

5. **Run the app**
   ```bash
   npm run tauri dev
   ```
   Open a saved set in Ableton. The connection indicator turns green once Live's
   heartbeat reaches the app — that's your confirmation the whole chain is wired up,
   not just that the files landed in the right folder.

The in-app Setup screen walks through steps 2–4 with detection, install, and a live
connection check, so you don't need the terminal for it day to day — the commands above
are for running from source.

## Tech stack

- **Desktop:** Tauri v2 · React · TypeScript
- **Backend:** Rust · SQLite (rusqlite) · TCP listener on `127.0.0.1:9001`
- **Ableton:** Python Control Surface (Live's own embedded interpreter) ·
  Recall Protocol v2 (newline-delimited JSON over TCP)
- **Tooling:** Node · Cargo · Vitest · pytest

## Status

**Working:** native app, TCP capture via the Python control surface, local session
storage, normalized schema + creative moments, in-app setup and install.
**Next:** finer clip capture, richer `.als` version history, AI session summaries.

A Max for Live bridge (`m4l/`) exists in this repo as the original capture path and is
retained for reference; the Python control surface above is what ships and what the
in-app Setup screen installs.

## Docs

- [`docs/PRD.md`](docs/PRD.md) — product requirements
- [`docs/SPEC.md`](docs/SPEC.md) — feature spec
- [`docs/ROADMAP.md`](docs/ROADMAP.md) — what's shipped and what's next
- [`docs/recall-schema-map.md`](docs/recall-schema-map.md) — the data-division plan: every
  entity and event, and how mature each one is (`live` / `defined` / `proposed`)
- [`docs/recall-protocol-v2.md`](docs/recall-protocol-v2.md) — the control surface ↔ app
  wire contract
- [`docs/ableton-bridge-architecture.md`](docs/ableton-bridge-architecture.md) — how
  Ableton state reaches the app

## License

MIT
