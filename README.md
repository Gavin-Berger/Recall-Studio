# Recall Studio

Local-first **session memory for Ableton Live**. Recall Studio captures what you do in a
session — tracks, devices, parameters, clips, tempo — and turns it into a structured,
reviewable timeline. Version control for music production, not just the final `.als`.

`Ableton Live → Max for Live → native app (Tauri · Rust · React) → local SQLite`

## The idea

A session becomes a browsable schema:

```
Project → Track (midi · audio · return · group)
        → Device (instrument · midi FX · audio FX)
        → Parameter
```

You pin **creative moments** (confidence: rough → working → keeper → final) onto the
timeline. The raw event log is the source of truth; the schema is rebuilt from it.

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

## License

MIT
