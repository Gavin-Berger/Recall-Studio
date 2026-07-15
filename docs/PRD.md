# Recall Studio — Product Requirements Document

*v1.1 draft · 2026-07-15 · owner: Gavin Berger · status: pre-beta*

---

## 1 · Product statement

**Recall Studio is session memory for Ableton Live.** It captures what a producer
actually does in a session — tracks, devices, parameters, clips, tempo, takes — and
turns it into a structured, reviewable timeline. Version control for music
production, not just the final `.als`.

A `.als` file remembers the *result*. Recall remembers the *work*: the knob ride
that found the bass tone, the device that got deleted at 2am, which version of the
project each decision happened in.

## 2 · Problem

Music production is a long series of small, forgettable decisions made in a tool
that keeps no history. Producers experience this as:

- **"How did I get this sound?"** — a patch or chain rebuilt from memory, badly.
- **"Which bounce / which version was the good one?"** — `song_final_v7_REAL.als`
  as a versioning strategy.
- **Lost session context in collaboration** — a writing camp or mix room where
  nobody can say what changed between Tuesday and Thursday.
- **No record of the creative arc** — the moments that mattered are indistinguishable
  from hours of noodling.

Existing answers fail this audience: cloud DAW-collab tools require accounts and
uploads (non-starters in major-label rooms with unreleased material), and manual
note-taking dies the moment the session gets good.

## 3 · Target users

| Persona | Situation | What Recall must do for them |
| --- | --- | --- |
| **Solo producer** (primary, beta audience) | Works alone in Live daily; loses sounds and versions to their own pace | Capture invisibly; answer "what did I do last session?" in one glance |
| **Producer room / writing camp** | Multiple sessions/day, shared projects, unreleased material | Per-project history that never leaves the machine; producer attribution on notes |
| **Mix engineer** | Receives projects, makes hundreds of parameter moves | A defensible record of what changed, exportable as a recap |

**Environment (v1):** Windows 10/11 · Ableton Live 11/12 with Max for Live ·
no assumption of technical skill beyond installing an app.

## 4 · Goals and non-goals

### Goals (v1.0)

1. A producer installs the app and the bridge **without a terminal** and, in under 5
   minutes, **sees their own project history** — not just a green connection light.
   *(Revised 2026-07-15, design review.) Recall's value compounds with history depth:
   "how did I make this bass?" is unanswerable until there is a bass with a past. A
   green light proves the wiring works and shows the producer nothing worth having, so
   optimising for it optimises for the wrong moment. The cure already exists —
   `rescan_project_takes` reads a folder of `.als` files — so first run offers to scan
   the producer's music folder and Recall arrives already knowing their versions,
   before capturing a single event. See §7.3 (First run).*
2. Capture runs for a full working session (4+ hours) with **no audible or felt
   impact on Ableton** and no loss of critical creative events.
3. Every project has a browsable history: **versions (takes) anchored to `.als`
   files**, a curated timeline of what happened, and pinnable creative moments.
4. A producer can open any track and read its **Sound Story**: the full lineage of
   how that sound was made — devices added and removed, presets, parameter rides,
   samples, and pinned moments — across every take of the project. "How did I make
   this bass?" is answerable in one view.
5. A session can be **recapped and exported** (Markdown / text / JSON / PDF) to
   share with a collaborator who doesn't have the app.
6. Everything lives **on the producer's machine**. No account, no cloud, no
   telemetry of musical content.

### Non-goals (v1.0)

- **No cloud, no accounts, no sync.** Local-first is the product, not a limitation.
- **No audio capture or bounce management.** Recall records decisions, not sound.
- **No DAW besides Ableton Live**, and no Live-without-M4L support.
- **No macOS** (needs signing/notarization and a separate install path — v1.x).
- **No auto-updater in v1.0** (passive "new version available" check only).
- **No AI summaries** (candidate for post-1.0; the recap export is the foundation).
- **No editing history rewriting** — the raw event log is append-only truth.

## 5 · Product principles

1. **Invisible during creation.** Recall must never ask for attention while music is
   being made. If the producer thinks about Recall mid-session, we failed.
2. **Never slow Ableton.** The bridge sheds its own load before it burdens Live.
   An audible glitch is a release blocker by definition.
3. **The raw log is the source of truth.** The schema, timeline, and versions are
   rebuildable projections. Curation hides noise; it never deletes signal.
4. **Trust through locality.** Unreleased music is radioactive. Nothing leaves the
   machine unless the producer explicitly exports it.
5. **Producer vocabulary, not plumbing.** The UI says takes, moments, sessions —
   never packets, events, schemas.

## 6 · Core user stories

1. *As a producer,* I open Ableton and my project, and Recall — already running —
   resumes the right take for the version I have open, without me touching it.
2. *As a producer,* after a session I open the timeline and see the story: parameter
   rides, devices added/removed, clips, tempo changes — curated, not a firehose.
3. *As a producer,* when something sounds right I pin a **moment** with a confidence
   level (rough → working → keeper → final) so future-me can find it.
4. *As a producer,* I save my project as a new file ("v2") and Recall anchors a new
   take to it; when I rename or move the file, I can **relink** the history.
5. *As a producer,* I open Versions and see what changed between takes — tracks and
   devices added or removed — like a diff for the project.
6. *As a producer,* I select a track — say, the bass — and read its **Sound Story**:
   every device that ever sat in its chain, the parameter rides that shaped it, the
   samples dropped into it, and the moments I pinned, in order, across takes.
7. *As a producer,* I flip the timeline into **Arrangement view** and see my changes
   placed on the song's own ruler — bars and beats — so I know I spent two hours
   shaping the drop at bar 64, not just "two hours on Tuesday." *(v1.1 — needs
   song-position capture; see §10.)*
8. *As a producer,* I export a session recap and send it to a collaborator.
9. *As a producer,* I jot notes (ideas, todos, references) inside the app so session
   context and reflections live next to the history.
10. *As a producer,* if capture ever degrades, a diagnostics view tells me plainly:
    connected or not, bridge version, whether anything was dropped.

## 7 · Functional requirements

### 7.1 Capture (bridge → app)

- Max for Live device (RECALL.amxd) observes Live and streams **changes only** over
  local UDP (Recall Protocol v2); deep initial snapshot on load.
- Coverage per the schema map ledger: tracks (audio/MIDI/return/group), devices,
  parameters (incl. deep plugin params via focused-device polling), clips, transport,
  tempo, project file path. VST preset opacity is a **documented limitation**, not a bug.
- Bridge self-limits (adaptive, time-budgeted polling) so Live's UI thread is never
  the victim of capture.

### 7.2 Pipeline (app)

- Local-only listener; malformed or oversized packets are counted, never crash.
- Overload policy: critical creative events are guaranteed durable; coalescible
  noise (repeated param ticks, transport spam) is shed first, and shedding is visible
  in metrics.
- All history in a single local SQLite file, transactional, with additive migrations
  so an old database always survives an app update.

### 7.3 Surfaces

- **Home / setup:** connection status, bridge install + version verify, one-look health.
- **First run (the cold-start answer):** after the green light, offer to scan the
  producer's music folder. Recall reports what it found in producer terms — "Found 9
  projects, 41 versions, going back to March 2023" — and lands them in Projects with
  real history. This is the install-day aha moment and the reason Goal 1 is measured
  as history-visible, not light-green. Scanning is opt-in and reads only `.als` file
  metadata; nothing leaves the machine.
- **Projects:** captured projects grouped automatically by Ableton project. Track rows
  carry a **Sound Story** affordance (see below) so the core promise is discoverable
  without knowing to drill.
- **Versions:** takes anchored to `.als` files; scan a folder for versions; resume-on-open;
  relink dialog for moved/renamed files; take-to-take diff.
- **Timeline:** curated event stream + pinned moments; hands-on time; navigation
  noise (e.g. track selection) captured but hidden.
- **Sound Story:** per-track (and per-device) provenance view — chain evolution,
  parameter rides with before/after values, samples, presets, and pinned moments,
  ordered across takes. Entered from the timeline's entity tree or a take's diff.
- **Recap / export:** story-so-far summary; Markdown / text / JSON / PDF. A Sound
  Story is exportable through the same pipeline.
- **Notes:** per-producer notes with autosave (SQLite-backed by v1.0).
- **Diagnostics:** bridge metrics (received / persisted / dropped), log access
  ("Help → Open log folder").

### 7.4 Install & update

- Signed NSIS installer; bridge files ship inside the app and install to the Ableton
  User Library from within the UI — **no npm, no terminal, no Max editing**.
- Passive update check against the release feed; download is a browser action.

## 8 · Non-functional requirements

| Requirement | Bar |
| --- | --- |
| Ableton impact | No audible glitch, no felt UI lag attributable to the bridge, ever |
| Critical-event durability | Zero loss under stress (burst 500+, malformed, oversized) — verified by the stress suite |
| Marathon sessions | 4+ hours / 50k+ events with bounded memory and a responsive timeline |
| Crash posture | No single failure zombifies the app; capture failures degrade to "disconnected," never to data corruption |
| Privacy | No network egress except the update check; no content telemetry |
| Observability | Every field failure is diagnosable from the log file + metrics screenshot |
| Data longevity | The SQLite file is the producer's; old DBs open forever (additive migrations) |

## 9 · Release criteria (v1.0)

1. Beta exit met: ≥3 testers × ≥4 real sessions; zero data-loss and zero
   Ableton-performance blockers in the final week.
2. At least one unprompted "the recall was genuinely useful" from a tester.
3. Clean-machine install test passes with no developer assistance — and the tester
   **sees their own project history within 5 minutes** of finishing the installer
   (first-run scan; §7.3). An install that ends on an empty app has not passed.
4. Every surface meets the accessibility bars in [DESIGN.md](../DESIGN.md) §9:
   body-text contrast ≥ 4.5:1, keyboard-operable, no hover-only affordances.
5. Signed installer; DB migration tested against real beta databases.
6. Quickstart + known-limitations doc (VST opacity, Windows-only) published.

## 10 · Later (explicitly deferred)

- **v1.1 (committed): Arrangement anchoring.** The bridge stamps every event with
  the song position (beats) and the current loop region; the timeline gains an
  **Arrangement view** that places changes on a bars/beats ruler and derives
  "section focus" ("you spent most of tonight looping bars 32–40"). Requires a
  Protocol v2.1 bridge release plus a live-validation cycle — that's why it is
  committed but post-1.0. Specified now in [SPEC.md](SPEC.md) §F5 so the schema
  slots exist on day one.
- **v1.1:** auto-updater; diagnostics expansion from beta learnings.
- **v1.x:** macOS; Ableton Extensions SDK tier as a non-realtime complement to the
  M4L bridge (probe already proven); master-track as a typed node; locators.
- **Post-1.0 candidates:** AI session summaries built on the recap; richer
  collaboration exports; routing capture.

## 11 · Open questions

- Pricing/licensing posture for public release (free beta is decided; after that?).
- Product name collision check + domain before the website ships.
- How much curation control to expose (hide/show event classes) before it becomes
  a settings swamp — current stance: strong defaults, minimal knobs.

---

*Companion docs: [SPEC.md](SPEC.md) (functional & technical spec) ·
[ROADMAP.md](ROADMAP.md) (phased path to the end goal) ·
[recall-schema-map.md](recall-schema-map.md) (capture coverage ledger) ·
[recall-protocol-v2.md](recall-protocol-v2.md) (wire contract).*
