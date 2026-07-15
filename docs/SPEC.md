# Recall Studio — Functional & Technical Specification

*v1.0 draft · 2026-07-15 · companion to [PRD.md](PRD.md) — the PRD says **what and why**;
this doc says **how, exactly**. Where this spec and the running code disagree, the code is
right and this doc is a bug.*

Related contracts this spec builds on (it does not repeat them):

- [recall-protocol-v2.md](recall-protocol-v2.md) — the bridge↔app wire contract
- [recall-schema-map.md](recall-schema-map.md) — the entity/event coverage ledger
- [ableton-bridge-architecture.md](ableton-bridge-architecture.md) — the capture mechanism
- [DESIGN.md](../DESIGN.md) — the design system: tokens, scales, component patterns,
  a11y bars. Where this spec describes a surface, DESIGN.md says what it looks like.

---

## 1 · System overview

```
Ableton Live
  └─ RECALL.amxd (Max for Live, JS bridge)          — observes, diffs, emits changes only
       │  UDP · 127.0.0.1:9000 · Recall Protocol v2 (flat JSON, one event per packet)
       ▼
Recall Studio (Tauri v2 desktop app)
  ├─ Rust backend (src-tauri/)
  │    udp_listener.rs   — non-blocking recv → bounded channel (4,096) → priority shed
  │    storage.rs        — batched transactional writes → single SQLite file (WAL)
  │    schema_projection.rs — pure derivation: events → entity tree
  │    event_catalog.rs  — event vocabulary, classification, producer-facing titles
  │    metrics.rs        — received / malformed / dropped / persisted counters
  │    install.rs        — bridge install into the Ableton User Library
  │    lib.rs            — Tauri command surface
  └─ React frontend (src/)
       App.tsx → AppShell — surfaces: projects · recap · timeline · glossary
       features/          — ProjectManagerScreen, SessionRecapScreen, StartupScreen, BridgeSetup
       components/schema/ — SchemaTimeline + timeline/ pure modules (format, graph, share)
       lib/schema/api.ts  — typed Tauri command wrappers
```

**One process, one file.** All history lives in a single local SQLite database.
The app makes no network connection except an optional passive update check.

## 2 · Data model

Two layers, never conflated (this is the load-bearing architectural rule):

| Layer | Tables | Mutability |
|---|---|---|
| **Event log** (verbs — what the producer did) | `events` | **Immutable, append-only.** The system of record. |
| **Entity projection** (nouns — what the set contains) | `tracks`, `devices`, `parameters`, `parameter_changes` | **Rebuildable.** `materialize_session_schema(session_id)` deletes and re-derives them from the latest deep snapshot + the event stream. |

Three things live *outside* both layers and are never touched by re-materialization:

- **`sessions` (takes).** A take == one `.als` file. `als_path` is the durable anchor;
  `take_origin ∈ {recorded, scanned}` distinguishes captured takes from versions found
  on disk. Scan / resume-on-open / relink semantics per the `takes-file-anchoring` work.
- **`creative_moments` + `creative_moment_targets`.** User-authored pins with a
  confidence ladder (rough → working → keeper → final), targeting a change, track,
  or device.
- **Notes.** Per-producer free text with autosave (moving from localStorage to SQLite
  before beta — see ROADMAP Phase 3).

**Migration rule:** additive only. An old database must open in every future app version.

## 3 · Functional specs

### F1 · Capture & reliability (live today — bars to hold)

- Bridge emits **changes only** (poll → diff), deep snapshot on load, heartbeat every
  2s carrying `project_path` (this feeds resume-on-open).
- Deep plugin parameters via the focused-device poller — adaptive and time-budgeted
  (bridge 0.17.0) so Live's UI thread is never the victim.
- Listener: malformed/oversized packets are counted, never crash. Overload sheds
  coalescible noise first; **critical creative events are never dropped** — verified
  by `scripts/stress-sender.mjs` (burst 500+, malformed, oversized modes).
- **Known limitation, documented not fixed:** VST preset loads are invisible to the
  Live API (proven with Serum); only "Device On" is exposed for some plugins. The
  timeline must degrade honestly ("preset changed — name not exposed by the plugin")
  rather than pretend coverage.

### F2 · Versions (takes)

Live today on branch `takes-file-anchoring`; needs live validation before merge.

- **Scan:** `rescan_project_takes` walks a project folder's top-level `.als` (skips
  `Backup/`), inserts a `scanned` take per unanchored file, idempotent, ordered by
  file mtime, dated by the file's own mtime.
- **Resume-on-open:** `activate_take_for_open_file` resumes the take anchored to the
  `.als` Ableton actually has open (from the heartbeat's `project_path`), promoting
  scanned → recorded on first touch; creates a take for a never-seen file.
- **Relink:** `relink_take` repoints a take's `als_path` after a rename/move; absorbs
  a scanned placeholder; **refuses** to steal a path owned by a recorded take (no
  silent merges).
- **Diff:** take-to-take comparison of the entity projection — tracks and devices
  added/removed. v1.0 diff is structural; parameter-level diff is a v1.x candidate.

### F3 · Curated timeline

- Renders the classified event stream per take: parameter rides (with before/after
  and swept range), devices added/removed, clips, samples (with source path — the
  Splice-crate answer), tempo, plus pinned moments inline.
- **Curation hides, never deletes.** Navigation noise (`track_selected`, transport
  spam) is captured but hidden; heartbeats are health-only. The raw log stays intact
  underneath.
- Header shows **hands-on time** (active work), not wall-clock span.
- Producer vocabulary everywhere: takes, moments, sessions — never packets or schemas.

### F4 · Sound Story (new — v1.0)

*The "how did I make this bass?" view. This is the product's core promise made into
a surface.*

**Where it lives:** a drill-in surface under **Projects**, exactly as `versions`
already is (`AppSurface` in `AppShell.tsx` — a sub-surface sharing its parent's nav
item). Breadcrumb carries wayfinding: `Projects / Nightdrive / Bass / Sound Story`.
It gets **no sidebar nav item** — a Sound Story without a track selected is
meaningless — but track rows in Projects and Versions carry an explicit "Sound Story"
affordance so it is discoverable without knowing to drill.

**Entry points:** a track row in Projects / Versions; a track (or a single device) in
the timeline's entity tree; a device row in a take diff ("when did this arrive?").

**Visual hierarchy — destination first, then path.** The producer asked "how did I
make this bass?", so the screen answers before it narrates. Order is load-bearing:

1. **Identity + the answer.** Track name (`--font-display`, `--t-display`) and
   **Chain now** — the device chain as it stands today, with removed devices struck
   through. This *is* the recipe; everything below explains how it got here.
2. **Stats:** hands-on time · change count · moment count.
3. **The story:** take chapters (spine), with moments pulled out large and changes
   as dense scannable rows.

The five content types below are what the story *contains*; they are not a rendering
order. Moments outrank changes visually — they are the producer's own marks, in
`--session` amber, the loudest thing on the screen.

**What it assembles** — a filtered, ordered projection over data that already exists;
no new capture required:

1. **Chain evolution:** every `device_added` / `device_removed` for the track, across
   all takes of the project, with the chain state after each change (`device_chain`
   is already a canonical field).
2. **Parameter rides:** `parameter_changes` for the track's devices — settled value,
   before-value (derived by time-order walking, first change has `before = None`),
   and swept min/max. Grouped per device, collapsible.
3. **Material:** `sample_added` events (sample name + source file path) and clip
   events on the track.
4. **Moments:** pinned moments targeting the track or its devices, shown at full
   size — they are the producer's own "this was it" markers.
5. **Take boundaries:** vertical separators labeled with the `.als` version name, so
   the story reads "born in v2, filter ride found in v4, resampled in v7."

**Cross-take identity (the hard part):** entities are re-materialized per take, so
the story needs a stable way to say "this is the same bass track in v2 and v7."
v1.0 rule: match track by name within a project, with a visible "also known as"
affordance when a rename breaks the chain (the producer confirms the link; the
confirmation is stored user-side like a moment, never inferred destructively).
This is deliberately the same shape as take-relinking: **the producer resolves
identity ambiguity; Recall never guesses silently.**

**When the producer ignores the prompt** (the common case — they are making music):
the story renders what it is *sure* of and states the break **inline, where the gap
is**, using the same honest-degradation treatment as VST opacity:
`── story may continue as "Bass 2" before this point · [Link them] ──`. It never
silently renders a fragment as if it were whole. One rule, one treatment: wherever
Recall doesn't know, it says so in place. *(Resolves open question 1 in §6.)*

**Honest degradation:** where a VST hides its state, the story says so inline rather
than showing a gap.

**Interaction states.** What the producer SEES, not backend behaviour:

| State | Sound Story shows |
|---|---|
| **Loading** | Header (name + Chain now + stats) paints immediately from the cheap projection query; the chronology renders behind ghost skeleton bars (`tl-scan__ghost`) while assembly walks the event stream. The producer's answer is never behind a spinner. |
| **Thin** (few changes, 0 moments — *the common case during dogfood*) | Identical layout at honest scale. No collapsed variants. Where moments would sit, an inline `--session` prompt: "Nothing pinned on this track yet — pin a moment when it sounds right." Thin must read as *a short story*, never as *broken*. |
| **Empty** (track exists, nothing shaped it) | `tl-scan` shape per DESIGN.md §7: "Nothing shaped this sound yet" · "Recall has seen the Pad track, but no devices, rides, or moments have landed on it. Tweak something in Ableton and its story starts here." · primary action opens the project · ghost bars. Names the situation, never the absence. |
| **Partial** | Honest-degradation rows inline (VST opacity; unresolved identity). |
| **Error** (assembly/DB read fails) | A real error state inside the surface's error boundary (§F8) naming what failed and offering the log folder. Never a blank panel. |

**Export:** a Sound Story flows through the existing share pipeline (`timeline/share`)
to Markdown / text / JSON / PDF — "send the bass recipe to a collaborator."

### F5 · Arrangement anchoring (new — v1.1, specified now)

*Changes placed on the song's own ruler, not just the clock.*

**Capture (Protocol v2.1 — bridge minor release):** the bridge stamps three new
canonical fields on **every** event:

| Field | Type | Source |
|---|---|---|
| `song_time_beats` | number | `current_song_time` (already read for snapshots) |
| `loop_start_beats` / `loop_length_beats` | number | the arrangement loop brace |

Cost analysis: these are three cached scalars appended at send time — no extra Live
API observers on the hot path. Time-signature context already flows in snapshots, so
the app can format beats → `bars.beats`.

**Derived: section focus.** The app clusters events by loop region over time into
**focus blocks**: "20:40–22:10 · looping bars 32–40 (the drop) · 214 changes, mostly
Bass / Serum." This is the single highest-value insight of the feature and is pure
derivation — spec'd as part of the projection layer, unit-testable.

**Surface:** the timeline gains a view toggle — **Session view** (wall-clock, today's
view) ↔ **Arrangement view** (horizontal bars/beats ruler; events and moments plotted
at their song position; focus blocks as shaded spans). Events with no meaningful
position (project-level: tempo, transport) sit in a gutter lane, not faked onto the
ruler.

**Explicit non-goal:** Recall does not *write* into Ableton (no locator injection).
Capture stays read-only; write-back would change the product's trust posture and is
at most a far-future opt-in.

**Schema posture:** columns land with the v1.1 migration (additive), but the event
catalog names the fields now, per the "named-but-empty slots are free" rule in the
schema map.

### F6 · Recap & export

- Story-so-far summary per take/session; export to Markdown / text / JSON / PDF via
  the pure `buildShareData` path (explicit input, unit-tested).
- Export is the **only** way musical content leaves the machine, and it is always an
  explicit producer action.

### F7 · Notes

Per-producer notes with autosave; producer attribution (name) for room/camp use.
Storage moves to SQLite before beta (localStorage is OS-wipeable) using the existing
`migrate_*` column-sniffing pattern.

### F8 · Diagnostics & observability

- File logging via `tauri-plugin-log`; every `eprintln!` converted. "Help → Open log
  folder" in-app.
- Diagnostics panel rendering `get_bridge_metrics`: connected state, bridge version
  (via heartbeat), received / persisted / dropped counters. Plain language: "3
  parameter ticks were thinned during a burst — nothing important was lost."
- React error boundary around every surface; a crash in one surface never blanks the
  app. DB-init failure gets a real error screen, not a zombie window.
- Mutex posture: `parking_lot` (no poisoning) — one panic must not zombify every
  subsequent command.

### F9 · Install & update

- Signed NSIS installer (unsigned acceptable for friend beta only). Bridge ships in
  app resources; `install.rs` + BridgeSetup place RECALL.amxd into the User Library
  (handles relocated/OneDrive-redirected libraries) and verify the connected bridge
  version via heartbeat. **No terminal, no npm, no Max editing.**
- Passive update check against GitHub Releases (banner); `tauri-plugin-updater` in v1.1.
- Version discipline: package.json / Cargo.toml / tauri.conf.json bumped together;
  `BRIDGE_VERSION` independent and displayed in-app.

## 4 · Non-functional bars

Inherited from PRD §8, restated as test obligations:

| Bar | How it's verified |
|---|---|
| No audible/felt Ableton impact | Weekly "did Live feel slower?" question in beta; any yes = blocker |
| Zero critical-event loss under stress | `stress-sender.mjs` full matrix against a live capture session |
| 4-hour / 50k-event sessions stay responsive | Marathon dogfood session; timeline render measured, windowed only if slow |
| No zombie states | Error-boundary + mutex work in ROADMAP Phase 1; kill-and-restart drills |
| Old DBs always open | Migrations tested against real beta database backups before each release |
| Privacy | Code-level: the only egress is the update check; verifiable by inspection |

## 5 · Testing strategy

- **Rust:** storage + projection unit tests (38 today) grow with each F4/F5 derivation
  (story assembly and focus-block clustering are pure functions — test them there).
- **Frontend:** vitest for pure modules (timeline math, version diff, share building —
  31 today); Sound Story assembly gets the same treatment.
- **Pipeline:** stress matrix (burst / malformed / oversized / params) with the app
  running against a real project.
- **Live validation:** every bridge or capture change gets a real-Ableton session
  before it's called done — the `/run` manual check. Bridge 0.17.0 and file-anchoring
  are currently in this queue.
- **Install:** clean-machine test (no dev tools) before beta invites.

## 6 · Open questions

1. ~~**Sound Story cross-take track identity**~~ — **partly resolved (design review,
   2026-07-15).** The *UX* of an unresolved match is decided: show the break inline
   with the honest-degradation treatment, never a silent fragment (§F4). Whether the
   projection needs a persistent track identity column earlier than v1.x remains open
   and is an engineering call — name-matching is good enough for v1.0 *given* the
   inline-gap behaviour, because the producer can always see when it failed. (Leans on
   the stable-event-identity work already flagged as a priority.)
2. **Arrangement view while stopped** — the playhead position when editing stopped is
   weaker signal than the loop brace; v1.1 may plot only loop-region focus and leave
   per-event positions to a later pass. Decide from real captured data.
3. **How much curation control to expose** (from PRD) — strong defaults, minimal
   knobs; revisit only if beta testers ask.
