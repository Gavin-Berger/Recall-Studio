# Recall Studio

Local-first **session memory for Ableton Live**. Recall Studio captures what you do in a
session — tracks, devices, parameters, clips, tempo — and turns it into a structured,
reviewable timeline. Version control for music production, not just the final `.als`.

`Ableton Live → Max for Live → native app (Tauri · Rust · React) → local SQLite`

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

## Tech stack

- **Desktop:** Tauri v2 · React · TypeScript
- **Backend:** Rust · SQLite (rusqlite) · UDP on `127.0.0.1:9000`
- **Ableton:** Max for Live (Node for Max) · Recall Protocol v2 (JSON over UDP)
- **Tooling:** Node · Cargo · Vitest

## Run

```bash
npm install
npm run tauri dev
```

Open Ableton and load the Max for Live device (`m4l/recall_m4l_bridge.js`). To test the
backend without Ableton: `node send-heartbeat.cjs`.

## Status

**Working:** native app, UDP capture, local session storage, Max for Live bridge,
normalized schema + creative moments.
**Next:** routing & clip capture, `.als` file watching, AI session summaries.

## Docs

- [`docs/recall-schema-map.md`](docs/recall-schema-map.md) — the data-division plan: every entity
  and event, and how mature each one is (`live` / `defined` / `proposed`)
- [`docs/recall-protocol-v2.md`](docs/recall-protocol-v2.md) — the bridge ↔ app wire contract
- [`docs/ableton-bridge-architecture.md`](docs/ableton-bridge-architecture.md) — how Ableton state
  reaches the app (poll → diff → UDP → Rust → SQLite)

## License

MIT
