# Recall Studio — Road to Public Release (and the end goal beyond it)

*Written 2026-07-14, updated 2026-07-15 · status as of `main` @ `c701394` (bridge 0.17.0)*

**The one-line verdict:** the capture pipeline is architecturally sound; what stands
between here and other people's machines is **observability, validation, and release
infrastructure** — not a rewrite. Roughly **6 weeks to a friend beta, ~3 months to
public release** at focused pace.

**Scope note (2026-07-15):** the PRD now commits to two product features beyond the
original release scope — **Sound Story** ("how did I make this bass?", v1.0, built
during the dogfood window from data we already capture) and **Arrangement anchoring**
(changes on a bars/beats ruler, v1.1, needs a bridge protocol bump). Both are specified
in [SPEC.md](SPEC.md) §F4/§F5. Sound Story adds ~1 week before beta; arrangement
anchoring is deliberately **after** 1.0 so it never blocks the release. §7 below is
the phase map past release.

---

## 1 · Where the project stands

### Solid today

| Area | Evidence |
| --- | --- |
| Ingest pipeline | `udp_listener.rs`: bounded 4,096-slot channel, priority shedding (critical events guaranteed), 256-event transactional batches, WAL, 16KB recv buffer, 50k live-buffer cap |
| Load tooling | `scripts/stress-sender.mjs` — mixed / params / malformed / oversized / burst modes |
| Metrics | `metrics.rs` counts received / malformed / dropped / persisted / queue depth |
| Install flow | `install.rs` + `BridgeSetup.tsx`: detects User Library (incl. relocated drives), installs RECALL.amxd, verifies connected bridge version via heartbeat |
| Tests | 38 Rust (storage) + 31 frontend (timeline math, version diff) |
| Docs | Protocol v2, bridge architecture, schema map with live/defined/proposed ledger |

### Gaps that bite

- **Zero field observability.** Errors go to `eprintln!` — invisible in a bundled
  build. No log file, no React error boundary, and `get_bridge_metrics` has **no
  frontend consumer**. When a tester says "it crashed," there is nothing to look at.
- **Mutex poisoning.** ~40 `lock().expect(...)` in `lib.rs`. One panic while holding
  a lock turns every later command into a panic — the app becomes a zombie.
- **Unvalidated recent work.** Bridge 0.17.0 (adaptive poller) and the
  takes-file-anchoring flow have not been live-tested; the deployed bridge is 0.16.1.
- **localStorage** for Notes + producer name (`NotesScreen.tsx`) — OS can wipe it.
- **No release machinery.** No CI, no signing, no updater, three unsynced `0.1.0`s
  (package.json / Cargo.toml / tauri.conf.json), `"csp": null`.
- **Window sizing is a design gap, not a config chore.** Recall lives *beside* Ableton,
  which owns the screen — so the real target is ~900px wide (half a 1080p display), not
  fullscreen. The 208px fixed sidebar and the §F5 bars/beats ruler have no specified
  behaviour there. Min-size must be derived from what stays readable, not guessed at
  packaging time. See [DESIGN.md](../DESIGN.md) §8.
- **`--faint` fails WCAG AA** (3.36:1 on `--panel`, below the 4.5:1 body bar) and is
  currently used on small metadata. Live accessibility bug; fix is `--faint-aa`
  (DESIGN.md §2).
- **Windows-only in practice.** macOS = signing/notarization, a separate project.

---

## 2 · Critical path

What blocks what — in order:

1. **Observability** (logging, metrics panel, error boundary) — ~2 days that
   multiply the value of every step after.
2. **Live validation** of bridge 0.17.0 + file-anchoring in real projects.
3. **Crash-proofing** (mutex poisoning, startup failure paths) — alongside #2.
4. **Dogfood** — every real session for 2+ weeks.
5. **Sound Story** (SPEC §F4) — built *during* dogfood; it needs no new capture, and
   beta testers must get to test the core promise, not just the plumbing.
6. **CI + installer + versioning** — parallel with #4.
7. **Friend beta** — blocked by 2, 4, 5, 6.
8. **Website + signing + release notes** — build *during* beta.
9. **Public release** — blocked by beta exit criteria.
10. **Arrangement anchoring** (SPEC §F5) — v1.1, first post-release cycle; needs a
    bridge protocol bump + its own live-validation loop, so it stays off the 1.0 path.

**Not on the 1.0 path:** the Extensions SDK tier (`recall-studio-extension/`), macOS,
new capture types (arrangement anchoring included), notes features beyond the SQLite
migration.

---

## 3 · Phases

### Phase 1 — Stabilization · 2–3 weeks

- File logging (`tauri-plugin-log`), convert `eprintln!`s in `udp_listener.rs` / `lib.rs`
- Diagnostics panel rendering `get_bridge_metrics`
- `parking_lot::Mutex` swap; error screen for `initialize_database` failure
- React error boundary around the surfaces in `AppShell.tsx`
- Deploy 0.17.0 to the live User Library; capture 2–3 real projects incl. one big one
- Full stress matrix against a running capture session; timeline windowing **only if measured slow**

**Done when:** a 4-hour real session captures with zero critical-event drops,
Ableton feels normal, and the log file tells the session's story afterward.
**Risk:** live test reveals Ableton slowdown → budget one bridge iteration.
**Avoid:** new capture types, new surfaces, the extension tier.

### Phase 2 — Internal testing (dogfood) + Sound Story · 2–3 weeks, overlaps Phase 3

- Use Recall for every real session; keep a bug list — every "eh, I'll restart it" is a beta bug
- GitHub Actions: `cargo test` + `vitest` + `tsc` on push
- Version discipline: bump all three manifests together to `0.2.0`
- **Build Sound Story (SPEC §F4)** — the one new surface allowed before beta.
  Assembly is a pure projection over existing tables (unit-test it like the timeline
  math); cross-take track identity uses name-matching + producer-confirmed relink.
  Dogfood it on your own bass: if it can't reconstruct a sound *you* made last month,
  it isn't done.

**Done when:** two weeks of daily use, no data loss, no restart-requiring failure —
and Sound Story answers "how did I make this?" on ≥2 real tracks from your own projects.
**Avoid:** redesigning surfaces you're merely bored of; parameter-level take diffs
(v1.x); starting arrangement anchoring "while you're in there."

### Phase 3 — Beta preparation · 1–2 weeks

- CI-built NSIS installer; test on a machine that has never run dev tools —
  installer + bridge setup must work **with no terminal**
- One-page quickstart (incl. the SmartScreen "More info → Run anyway" note)
- Notes → SQLite (reuse the `migrate_*` column-sniffing pattern in `storage.rs`)
- Feedback channel: private Discord / group chat

**Done when:** a non-developer friend installs from a link and reaches a green
connection light without help.
**Risk:** first-run breaks in bridge install (OneDrive-redirected Documents, relocated libraries).
**Avoid:** the website — not yet.

### Phase 4 — Friend beta · 3–4 weeks

See §4 below.

### Phase 5 — Release candidate + website · 2 weeks, overlaps late beta

- Fix beta blockers; landing page + download link
- Signing: Azure Trusted Signing (~$10/mo) or SignPath (free for OSS)
- Set a real `csp` in `tauri.conf.json`; release notes
- Update check against GitHub Releases (banner only; `tauri-plugin-updater` in v1.1)

**Done when:** RC runs one full week across testers with zero blockers.

### Phase 6 — Public release · 1 week

Tag → GitHub Release with installer → website live → announce (r/ableton, producer
Discords, a 30-second screen-capture of the timeline filling during a real session).

---

## 4 · Beta test plan

- **Who / how long:** 3–8 producer friends · 3–4 weeks · Windows, Ableton 11/12 + M4L.
- **Ask testers to:** install unaided **and run the first-run scan on their own music
  folder before anything else** (this is the install-day aha and the thing most likely
  to decide whether they keep the app — watch it happen if you can); run Recall during every *real* session; weekly,
  check a project's Versions view against their memory; try one relink after renaming an `.als`;
  open a **Sound Story** on one track they actually care about and say whether the
  story matches how they remember making it.
- **Collect:** install friction · "did Ableton feel slower?" (ask weekly — silent killer) ·
  log file + metrics screenshot after weirdness · and the product-truth question:
  **"did the timeline show you something you'd forgotten you did?"**

### Release blockers

| Blocker | Not a blocker |
| --- | --- |
| Loses captured data | Cosmetic issues |
| Ableton audibly stutters / feels sticky | Missing capture types (document VST opacity instead) |
| Requires restart to keep working | Feature requests |
| Installer / bridge setup fails on a supported machine | |
| Old DB fails to open after update (test migrations against backups) | |

**Beta succeeds when:** ≥3 testers complete ≥4 real sessions each; zero data-loss and
zero Ableton-performance blockers in the final week; ≥1 unprompted "the recall was
genuinely useful."

---

## 5 · Release plan

- **Build:** GitHub Actions + `tauri-action` on version tags → NSIS `.exe` (canonical
  download; MSI is a bonus). Bridge ships via existing `bundle.resources`.
- **Versioning:** semver; `0.x` through beta, `1.0.0` at public release. `BRIDGE_VERSION`
  stays independent, displayed in-app via heartbeat; release notes state which app
  bundles which bridge.
- **Signing:** unsigned for friend beta; signed for public (unsigned downloads bleed
  users at the SmartScreen wall).
- **Install page (not a marketing site):** Recall is a native local app; the page exists
  **only so a producer can download and install it**. Scope: what it is in one line, one
  screenshot, download button → latest GitHub Release asset, the SmartScreen
  "More info → Run anyway" note, known limitations (VST opacity, Windows-only), contact
  link. GitHub Pages / Netlify. *No hero composition, no feature grid, no marketing
  design pass — budget hours, not the two weeks Phase 5 previously implied.*
- **Support:** "Help → Open log folder" in-app + email/Discord. Enough for v1.
- **Updates:** v1.0 ships a passive update check; auto-updater in v1.1 once signing exists.

---

## 6 · Action checklist

In order — items 1–4 exist to make item 5 and the beta *legible*:

**Reordered 2026-07-15 by `/plan-eng-review`, against measured evidence.** The old order
built the diagnostics panel (item 2) *before* loss detection existed — the panel renders
`get_bridge_metrics`, which counts only userspace drops and would have displayed
**"0 dropped" during 80% packet loss**. Fix the sensor before building the dial.

**The measurement that reordered this** (real app, corrected harness, rows counted in SQLite):
2,000 `Critical` events, OS confirmed 2,000/2,000 sends both runs — **burst ~80k/s → 407
persisted (80% lost); paced ~500/s → 2,000 persisted (0% lost)**. Same packets, same code;
rate is the only variable. The queue is 4,096 and only 2,000 were sent, so it never filled
and `enqueue_event` never blocked: the loss is **upstream of the queue, at the kernel socket
buffer**, because the recv thread does a JSON parse per packet inline. Ableton never emits at
burst rate — **the deep snapshot on load (SPEC §F1) is the only real burst**, which is why
item 9 exists.

- [x] 1. ~~Corrected stress harness~~ **DONE 2026-07-15** (`5c5186d`). Counts in the send
      callback, drains before close, isolates each run by `device_id`, asserts
      `sent == persisted` + zero gaps, exits non-zero. Verified: paced → PASS (261/261, 0
      gaps); burst 2,000 → FAIL (402/2,000, 79.9% protected loss).
      **Its gap ranges located the root cause:** loss starts at sequence **239**, not 1 —
      1–238 survive contiguously, then dense gap runs. At 329 bytes average that's
      **78,302 bytes absorbed before the first drop vs Windows' 65,536 default `SO_RCVBUF`**
      (within 19%; the excess is the recv thread draining while the buffer floods). The
      kernel socket buffer is now *measured*, not inferred — that's what #2 targets.
      *Known limit: paced mode caps ~65/s (Windows `setTimeout` granularity ~15ms); use
      `--burst` for overload.*
- [x] 2. ~~`socket2` + `SO_RCVBUF`~~ **DONE** (`8a6e686`, `2e29bd9`). 8MB requested, 8MB applied (Windows did not clamp). Recv loop never blocks. **burst 2,000: 407 -> 2,000 persisted; burst 20,000: 2,724 -> 20,000, nothing shed.** Buffer absorbs ~28,000 packets, was 238.
      (Windows silently clamps); lean recv loop (parse off the recv thread); remove the
      blocking `sender.send` — drop-and-count instead (~1 day)
- [x] 3. ~~Sequence-gap detection~~ **DONE** (`a6bd925`). Cross-validated: app and harness independently agree (0 gaps at 20k; ~71k at 100k). The only loss measurement that
      cannot lie. The bridge already stamps it and the app ignores it (~½ day)
- [x] 4. ~~SQLite pragmas~~ **DONE** (`a6bd925`). `synchronous`/`busy_timeout` now set in `open_connection`, the only place that runs per connection. Note the per-batch `Connection::open` remains: measured irrelevant to burst loss (downstream of a queue that never fills). Was: make `synchronous = NORMAL` actually
      apply (it's per-connection and currently resets to `FULL` — an fsync per batch); add
      `busy_timeout` (~2 hrs)
- [x] 5. ~~`session_id.is_none()` silent discard~~ **DONE** (`a6bd925`). Counted at assignment and no longer queued. Was: currently uncounted, and
      gap detection would blame the transport for it (~2 hrs)
- [ ] 6. File logging via `tauri-plugin-log`; convert `eprintln!`s (~½ day)
- [ ] 7. Diagnostics panel rendering `get_bridge_metrics` **+ real gap counts** (~½ day)
- [ ] 8. Crash-proofing: `parking_lot::Mutex` in `lib.rs` (51 sites, not ~40) + startup error screen. **Partly done** (`19a61e0`, `8a6e686`): per-packet `catch_unwind` means the recv thread cannot die from a packet; bind failure reports instead of panicking. **Correction to the eng review:** the "14 hot-path unwraps that parking_lot won't fix" was wrong — that count included the test module. The real non-test panics are ~6 and almost all `lock().expect()`, which parking_lot *does* fix. `lib.rs` still needs the swap. Original text:
      screen; recv-thread `catch_unwind` + supervisor + counted errors for the 14 hot-path
      unwraps (`parking_lot` does **not** cover those); handle bind failure instead of
      `.expect` on `UdpSocket::bind` (~1 day)
- [ ] 9. React error boundary in `AppShell.tsx` (~1 hr)
- [ ] 10. Deploy bridge **0.17.0 alone**; real-project test with instruments on, then a
      marathon session alongside the harness. **Validate it by itself before pacing lands** —
      otherwise two unvalidated bridge changes ship together and a glitch can't be attributed
- [ ] 11. Bridge-side snapshot pacing (reuse the 0.17.0 time-budgeted `Task` pattern), then its
      own live-validation cycle. Blocked by #10
- [ ] 12. Fix what #10/#11 surface; measure timeline render, window only if slow
- [ ] 13. Two-week dogfood while standing up GitHub Actions + version bump discipline
      (wire the harness from #1 into CI — it's what keeps #2–#5 from regressing)
- [ ] 14. Build Sound Story (SPEC §F4) during the dogfood window; validate it on 2+ of your own tracks
- [ ] 15. First-run scan flow (PRD §7.3) — the cold-start answer; reuses `rescan_project_takes`
- [ ] 16. Land the DESIGN.md scales in `tokens.css`; retire `--faint` from small text (~1 hr)
- [ ] 17. Clean-machine installer test → quickstart → Notes → SQLite → invite first two friends

---

## 7 · Beyond 1.0 — to the end goal

The PRD's full vision, phased past release. Nothing here may pull work forward onto
the 1.0 critical path.

### Phase 7 — Arrangement anchoring (v1.1) · 2–3 weeks

The bars/beats view of the session (SPEC §F5), in strict order:

1. **Bridge → Protocol v2.1:** stamp `song_time_beats` + `loop_start_beats` /
   `loop_length_beats` on every event (three cached scalars at send time — measure,
   don't assume, that the hot path stays flat). Deploy to the live User Library.
2. **App:** additive migration for the new columns; catalog fields named in advance
   per the schema-map "free slots" rule.
3. **Derivation:** focus-block clustering (loop-region dwell) as a pure, unit-tested
   projection — this is the "you spent tonight looping the drop at bar 64" insight.
4. **Surface:** Session ↔ Arrangement view toggle in the timeline; ruler in bars/beats;
   positionless events in a gutter lane, never faked onto the ruler.
5. **Live validation cycle** — same bar as any bridge change: a real multi-hour
   session with instruments on before it ships.

Ship alongside the v1.1 auto-updater (signing exists by then).

### Phase 8 — Depth (v1.x, order by beta demand)

- Parameter-level take diffs ("what changed in the bass between v4 and v7" — closes
  the loop between Versions and Sound Story)
- Persistent track identity in the projection (replaces name-matching in Sound Story;
  builds on the stable-event-identity work)
- macOS (signing/notarization — its own project)
- Extensions SDK tier as a non-realtime complement to M4L (probe already proven)
- Master-track as a typed node; locators; routing capture

### Phase 9 — Post-1.x candidates (decide later, not now)

- AI session summaries built on the recap foundation
- Richer collaboration exports (per-producer attribution views for camps/rooms)
- Pricing/licensing posture (free beta is decided; revisit after real usage data)
