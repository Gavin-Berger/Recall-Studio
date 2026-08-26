# Recall Studio — Design System

*v2.1 · 2026-08-25 · companion to [PRD.md](docs/PRD.md) / [SPEC.md](docs/SPEC.md).
The PRD says **what and why**, SPEC says **how**, this says **what it looks like and
why it looks that way**.*

> **v2.0 is a professional redesign** (`/design-consultation`, 2026-08-04). Two things
> changed and everything else was kept: **typography** moved to IBM Plex, and **color**
> went fully monochrome — one signal, one moment accent, no entity-color rainbow. The
> motion tense-rule, spacing, layout, component patterns, and voice are unchanged; they
> were already right. See the Decisions Log for the full rationale.

> **v2.1 adds a vocabulary the system was missing: structure.** v1 and v2 both described
> a system of *rows* — lists of facts stacked vertically. The version graph (§11) is not
> a list; it is a two-dimensional drawing of how one song's `.als` files descend from each
> other. Three rules were written for rows and had to be scoped, not deleted: the 1px
> hairline (§5), the single-column layout (§8), and "hue does almost nothing" (§2 → §11).
> **Nothing was loosened for aesthetics.** Monochrome holds, the motion tense-rule holds,
> and the entity-color system stays retired.

**`src/styles/tokens.css` has been rebuilt to match this doc (2026-08-04):** IBM Plex
bundled via `@fontsource`, monochrome palette, `--signal` / `--moment` added, and the v1
entity-color tokens kept as aliases pointing at the monochrome set. All hardcoded teal /
violet / warm color literals across `components.css`, `SchemaTimeline.css`, `motion.css`,
and the organizer were swept to the single signal blue. Remaining cleanup: retire the
~100 `var(--track|--device|--parameter|…)` call sites in favour of type-based
differentiation, then delete the alias tokens.

---

## 1 · What Recall should feel like

A producer opens Recall between takes, at 1am, next to Ableton. It is a **precision
instrument that keeps a record**, not a productivity app and not a toy. Four consequences:

1. **Dark, always.** Not a theme choice — it sits beside Live's dark UI on a dim desk.
   There is no light mode in the app. (Exported documents get a light print variant; see §8.)
2. **Calm surface hierarchy.** The producer's attention belongs to the music. Recall
   never competes for it. No dashboard mosaics, no thick borders, no decorative
   gradients, no ornamental icons, no colored chip rainbow.
3. **Dense but readable.** A session is thousands of small facts. The UI's job is to let
   the eye scan them, not to pad them into cards.
4. **It reads like an instrument's readout, not an app's dashboard.** The look is a
   logbook: monospaced values, hairline rules, near-monochrome. Precision *is* the brand,
   because the product's whole claim is that this record is exact and captured live.

**Governing rule: Recall never pretends.** Where data is missing or uncertain, the UI
says so in place, in plain language. This is a *design* rule, not just a copy rule — it
is why honest-degradation rows have a visual treatment (see §7).

## 2 · Color — monochrome, one signal, one moment

**v2.0 retired the entity-color system.** In v1, color was a type signal: track blue,
device violet, parameter teal, and so on. It read as playful plugin-UI, not as a
professional record. In v2 **hue does almost nothing; luminance, weight, and monospace
carry the work.** The palette is a graphite ramp plus exactly two accents.

All values are documentation until tokens.css is rebuilt to match.

### Surfaces — a cool graphite ramp

| Token | Value | Use |
|---|---|---|
| `--ink` | `#0d0f13` | Page base. Body applies a vertical gradient to `--ink-2` and back to `#090b0f`. |
| `--ink-2` | `#12141a` | Gradient midpoint only. |
| `--panel` | `#161922` | Primary panel / sidebar / card. |
| `--panel-2` | `#1c2029` | Raised panel, row hover. |
| `--panel-3` | `#232833` | Active nav item, badges, inline chips (`N×` run counts). |
| `--line` | `#2a2f3a` | Hairline borders. **Always 1px** as a border or divider. Drawn graph geometry uses the stroke scale in §5. |
| `--line-soft` | `#21262f` | Internal dividers inside a panel. |

The neutrals carry a slight cool/blue bias so they read as chosen, not as a default grey,
and so the one signal accent sits in the same family.

### Text

| Token | Value | Use | Contrast on `--panel` |
|---|---|---|---|
| `--paper-strong` | `#f3f5fa` | Headings, settled/after values, track names — the thing you want read. | ~15:1 |
| `--paper` | `#d6dae4` | Body. | ~11:1 |
| `--muted` | `#8b91a0` | Secondary text, parameter names, detail after a `·`. | ~5.6:1 ✅ |
| `--faint-aa` | `#868d9c` | Small metadata: timestamps, hints, labels, take dates, `N×` badges. | ~4.6:1 ✅ |
| `--faint` | `#666d7c` | **Large text only (≥19px, or ≥15px bold).** Decorative. | ~3.3:1 ❌ AA for body |

> **`--faint` fails WCAG AA for body text.** Never put `--faint` on text under 19px.
> Small metadata uses `--faint-aa`. This rule survives from v1 and still holds.

### The two accents — the only color in the system

| Token | Value | Means | Rule |
|---|---|---|---|
| `--signal` | `#5e93ff` | **The live/active/interactive fact.** Focus ring (2px), current selection, the primary action, links, the connection dot. | The single cool accent. If something is interactive or *now*, it may be `--signal`. Nothing else is blue. |
| `--moment` | `#e3b667` | **A pinned moment — the producer's own mark.** | The single warm accent, and the loudest thing on any screen it appears on. It earns that because the producer made it. Nothing else is warm. |
| `--danger` | `#dc5a6a` | Removal, destructive action, error. | A *state*, not an entity accent. Used only for destructive/error, never for emphasis. |

**Do not introduce a third accent, and do not bring entity colors back.** If something
needs emphasis it is either interactive (`--signal`), the producer's own mark
(`--moment`), or it uses **weight, monospace, and position** — never a new hue.

### How types are told apart without color

What v1 did with hue, v2 does with type:

| Type | Treatment |
|---|---|
| **Track** | `--font-sans` 600, `--paper-strong`. The heaviest label in a row. |
| **Device** | `--font-mono`, `--paper`. Monospace marks it as an equipment name. |
| **Parameter** | `--font-mono`, `--muted`. Same mono, one step quieter. |
| **Value** | `--font-mono` 500, `--paper-strong`, `tabular-nums`. The number is the brightest mono. |
| **Moment** | `--font-sans` 600, `--moment`. The one warm thing. |

The eye scans a session by luminance and by sans-vs-mono, not by a color legend.

## 3 · Typography

**IBM Plex, bundled with the app.** Plex is an engineering typeface — it reads like
instrumentation, which is exactly the register v2 wants. It replaces Bahnschrift and Aptos
entirely. **Never `system-ui`, `-apple-system`, Inter, Roboto, Arial, or Bahnschrift** —
a default or consumer stack is the "gave up on typography" signal and Recall is not that.

| Token | Stack | Use |
|---|---|---|
| `--font-sans` | IBM Plex Sans → Segoe UI Variable Text → Segoe UI | Headings, track names, moment text, all UI and body text. Display is the same face at 600. |
| `--font-mono` | IBM Plex Mono → Cascadia Code → Consolas | **Every number, every `.als` filename, every parameter value, every timestamp.** Non-negotiable: values align vertically with `tabular-nums` so a column of knob rides scans cleanly. |

There is no separate display face. A condensed grotesque (v1's Bahnschrift) was the main
thing reading as "consumer" — one clean, well-set family across the whole app is more
professional than a display/body split.

**Loading:** the Tauri app self-hosts IBM Plex Sans + Mono as bundled `woff2` (`@font-face`
in tokens.css) — never a CDN. Exported documents and web previews may load Plex from Google
Fonts, since they render outside the app.

### Type scale

| Token | Size | Use |
|---|---|---|
| `--t-display` | 28px | Screen title (track name in Sound Story). Plex Sans 600. |
| `--t-h1` | 20px | Section heading, moment text. |
| `--t-h2` | 15px | Sub-heading, nav label, chapter filename. |
| `--t-body` | 15px | Body. |
| `--t-meta` | 13px | Rows, secondary detail. |
| `--t-micro` | 11px | Uppercase labels, timestamps, badges. `--font-mono`, `letter-spacing: .08–.12em`. |

**Body text is never below 13px, and 13px is only for dense rows with `--muted` or
lighter.**

## 4 · Spacing

Unchanged from v1 — the scale was already right.

| Token | Value | Typical use |
|---|---|---|
| `--s1` | 4px | Icon-to-text, inline caret |
| `--s2` | 8px | Inside a chip/badge, tight row gap |
| `--s3` | 12px | Row padding, nav item padding |
| `--s4` | 16px | Panel inner padding (compact) |
| `--s5` | 24px | Panel inner padding (default), section gap |
| `--s6` | 32px | Between story chapters |
| `--s7` | 48px | Content gutter, major section break |
| `--s8` | 64px | Empty-state vertical breathing room |

**Rule: no raw pixel padding or margin in new components.** If a value isn't on the scale,
either the scale is wrong (change it here) or the component is (change it there).

## 5 · Shape and depth

- `--radius: 10px` — panels, cards, empty states.
- `--radius-sm: 6px` — buttons, rows, chips, badges.
- `--shadow` — **one** shadow, for genuinely floating things (dialogs). Depth otherwise
  comes from the `--panel` → `--panel-2` → `--panel-3` ramp plus a `--line` hairline.
  **A screen must look right with every shadow removed.**

### Stroke — chrome vs. geometry

The "always 1px" rule governs **chrome**: borders, dividers, panel edges. A line that
*separates* things is always a hairline, and that is unchanged.

A line that *is* the content — a graph edge, a lane, a connector — is geometry, and
geometry needs weight to carry hierarchy. Three widths, no more:

| Token | Value | Use |
|---|---|---|
| `--stroke-hair` | `1px` | Chrome. Borders, dividers, the `--line` hairline. |
| `--stroke-edge` | `1.5px` | A branch lane and its edges — the ordinary case. |
| `--stroke-trunk` | `2.5px` | The mainline lane only. One per graph. |

**Weight is a structural claim, not emphasis.** `--stroke-trunk` means "this is the lane
the song actually lives on," never "look at this." If you want attention, use position or
`--signal`, not thickness.

## 6 · Motion — the tense rule

*Unchanged from v1. This is the best part of the system and it stays exactly as written.*

### The principle

**Recall shows the past. Its motion must not say "now."**

Every visual convention in music-production software is **realtime** — waveforms, meters,
knob positions glow and move because something is *happening*. Recall is the only tool in
the studio visualizing what already happened. Borrowing that vocabulary makes the interface
lie about tense. Think **developed film, not a live meter.** Memory surfaces, resolves, and
settles; it does not pulse.

### Two registers, and only two

| Register | Means | Where |
|---|---|---|
| **Arrival** | Content resolving into place, once, and holding. | Story rows, chapters, panels, skeleton→content swaps. |
| **Recognition** | The thing you were looking for landing. | A pinned moment coming into view; a search/filter match; a relinked take snapping in. |

If a motion is neither of these, it does not ship.

### Banned

- **Infinite loops on anything historical** — no `pulse`, `breathe`, `float`, `drift`,
  `sweep`, `scan`, `travel`. These are the vocabulary of a living signal.
- **`linear` easing.** Nothing physical moves at constant velocity; linear reads as a
  machine mid-operation. Your history is not in progress.
- **Decorative motion with no referent** (v1's `.ecosystem-background` drifting blobs).
  Cut it, don't tune it.

### The one exception

**The connection-status dot may pulse** — and it may use `--signal`. It is the single
element that reports a genuinely live fact (is Ableton talking to us *right now*). It has
earned the living vocabulary precisely because everything else gave it up.

### Tokens

| Token | Value | Use |
|---|---|---|
| `--m-settle` | `120ms` | Hover, focus, small state changes. |
| `--m-arrive` | `220ms` | A row, panel, or chapter arriving. |
| `--m-develop` | `420ms` | The one-shot reveal of a whole story or spark. Like film developing. |
| `--ease-arrive` | `cubic-bezier(0.16, 1, 0.3, 1)` | **The default.** Fast start, long settle. |
| `--ease-exit` | `cubic-bezier(0.4, 0, 1, 1)` | Leaving. Things exit faster than they arrive. |

### ActivitySpark

Draws once with `--m-develop` + `--ease-arrive`, then holds forever — that is *arrival*,
the session's shape resolving. A spark that loops or re-animates on scroll is a heartbeat,
which is a lie. The glow stays (luminosity is how this category renders data); what Recall
gives up is the pulse. Under `prefers-reduced-motion` it renders at its final state
immediately.

## 7 · Component patterns to reuse, not reinvent

**Before → after value** — class `tl-ba`. Mono, `before → after`, with the direction shown
by the values themselves and the **after value in `--paper-strong`** (the brightest thing
in the row); the arrow/caret sits in `--faint-aa`. `N×` badge in `--panel-3` for a collapsed
run. **v2 change: no warm/cool direction color** — direction is legible from the numbers
(`144 Hz → 104 Hz` is obviously down), so hue is not spent on it. **Do not build a second
value style.**

**Empty state** — class `tl-scan`. Icon, a specific heading that names *what* is waiting,
one sentence on what the producer does next, a primary action (`--signal`), ghost skeleton
bars. The copy names the situation ("Waiting for your first move"), never the absence ("No
items found").

**Honest degradation** — a row in `--muted` italic with a `?` glyph in `--faint-aa`, stating
what isn't known and why: *"preset changed — name not exposed by the plugin."* Wherever
Recall doesn't know, it says so in place.

**Ghost skeleton** — `tl-scan__ghost`, staggered-width bars at ~30% opacity. Loading, not
just empty.

## 8 · Layout

**Recall lives beside Ableton, not instead of it.** The primary target is **~900px wide**
(roughly half a 1080p display), not fullscreen. Fullscreen is the bonus case.

- **Sidebar:** 208px fixed. Below ~860px it collapses to an icon rail; the connection
  status stays visible at every width — the one thing that must never be hidden.
- **Reading surfaces:** single column, `max-width: 1080px`, `--s7` gutter. Sound Story and
  the Report are single-column at every width — they are prose and rows, and prose has a
  comfortable measure.
- **Graph surfaces are exempt.** The version graph (§11) is a drawing, not a column. It is
  two-dimensional by nature, it fills the available width, and it **scrolls horizontally**
  past that. It has no `max-width`.
- **Nothing that encodes time may compress.** The bars/beats ruler scrolls horizontally and
  never squeezes; the version graph's time axis obeys the same rule. A squeezed ruler is a
  lying ruler, and a squeezed graph is a lying graph — both claim events were closer
  together than they were.
- **Exported documents** (the contribution record and any studio-facing export) render dark
  on screen like the app, and carry a **light print variant** (`@media print`, ink-on-paper,
  accents darkened for AA) so they hand off and print cleanly.

## 9 · Accessibility bars

Checkable before merge.

- **Contrast:** body text ≥ 4.5:1, large text ≥ 3:1. `--faint` on small text fails and is
  banned (§2). Monochrome makes this easier — most text is high-luminance on graphite.
- **Keyboard:** every surface reachable and operable without a mouse. Timeline and Sound
  Story are arrow-key navigable, `Enter` to open, visible focus ring (`--signal`, 2px).
  Never a hover-only affordance.
- **Semantics:** `aria-label` on landmarks; `aria-hidden` on decorative elements; never a
  placeholder as the only label on a field.
- **Motion:** honour `prefers-reduced-motion` — kill the spark draw-in, keep the content.
- **Color is never the only signal.** Because v2 leans on luminance/weight/mono rather than
  hue, type differentiation already survives color-blindness; keep it that way.

## 10 · Voice

Producer vocabulary, always: **takes, moments, sessions, rides, chain.** Never packets,
events, schemas, entities, projections, or queue depth.

Utility language: orientation, status, action. Not mood, not aspiration, not congratulation.
Diagnostics says *"3 parameter ticks were thinned during a burst — nothing important was
lost"*, never *"Optimized!"*.

If deleting 30% of a string improves it, keep deleting.

## 11 · Graph and structure

*New in v2.1, for the version graph. Rows describe what happened; the graph describes
how versions descend from each other. Everything here is subordinate to §2 and §6 —
this section adds vocabulary, it does not create exceptions.*

### Why this needed new rules

§2 says hue does almost nothing because **hue was being spent on type** — track blue,
device violet — which made a record of work look like a plugin skin. That reasoning is
about *entities*, and it still holds completely.

A lane is not an entity. It is a **position in a structure**, like an indent level or a
column. Nothing in the type system encodes position, so the graph needed its own axis —
and it gets **luminance depth**, not hue. The rainbow does not come back.

### Lanes — depth by luminance

One lane per **lineage**, not per version. A chain of versions where each has a single
child stays on one lane — `v1 → v2 → v3` is one line with three nodes, the same way a
run of commits is one line. A lane is only created when a version has a **second** child.

**Which child keeps the trunk is decided by the strongest edge, not the earliest.** Git
draws first-parent as the trunk because git is told which parent is first; nothing tells
Recall. Taking the eldest child gets the ordinary case backwards — open `v3`, try
something weird and save it as `v3 alt`, sleep on it, carry on in `v4`. The alt is older,
so "eldest wins" puts the abandoned experiment on the mainline and pushes the song onto a
branch.

Edges rank **observed > filename > activity > chronological**. Ties go to whichever
child's descendants were worked on most recently — in a project whose files carry no
version numbers every edge is `activity` and therefore ties, so "eldest wins" would hand
the trunk to whichever fork was opened first and then abandoned. The line the song is
still alive on is the mainline, which is what `--lane-0` claims to be.

**Where the forks come from.** Not the file names — most producers do not number their
sets, and a graph inferred from names alone is a straight ladder. A fork is evidence that
two lineages were alive at once, and the strongest available evidence is that the producer
*went back*: worked `v3`, saved `v4`, then returned to `v3` and kept pushing it. That is
already provable from sitting timestamps, with no naming convention and no new capture.
A version's parent is therefore the file the producer had open when it appeared, and the
name only wins when it agrees — because when the two disagree, the disagreement IS the
branch.

The trunk is brightest; each fork step away from it is one step dimmer. Four levels, then
cycle.

| Token | Value | Means |
|---|---|---|
| `--lane-0` | `#d6dae4` | The trunk — the root lineage, the file the song started as and everything that directly continues it. |
| `--lane-1` | `#98a0b1` | One branch off the trunk. |
| `--lane-2` | `#6f7686` | Two steps out. |
| `--lane-3` | `#4d5462` | Three or more. Cycles back to `--lane-1` beyond this. |

**Dimmer means further from the mainline, never less important.** An abandoned experiment
that produced the best sound in the song is still on `--lane-2`; the graph reports
structure, not judgement.

**Density cap: 6 lanes.** Past that the graph stops being readable as a shape. Collapse
the oldest inactive lanes into a single "+N earlier versions" rail that expands on click.
Do not shrink the lane gap to fit more in.

### Nodes

| State | Treatment |
|---|---|
| **Version with captured work** | Filled dot, `--radius-node: 7px`, lane color. |
| **Version with no captured work** | Hollow ring, `--stroke-edge`, lane color. Honest degradation (§7): the file exists, Recall was not running. |
| **Selected** | `--signal` 2px ring, offset 3px. Same ring as focus — selection and focus are one visual idea. |
| **Live (capturing now)** | `--signal` fill. **Static.** The connection dot is still the only thing in the app that may pulse (§6). |
| **Sitting** | A 3px tick on the lane, `--faint-aa`. Many per node. |

Node size is fixed. **Do not scale a node by event count** — it invites reading area as
importance, and 400 automation ticks is not four times the work of 100.

### Edges

An edge means *this version descends from that one*. It leaves the parent lane
vertically, turns once with a `--radius-sm` corner, and runs along the child lane.
**Orthogonal with one rounded corner — never a bezier.** Curved spaghetti reads as
decoration and stops being traceable the moment three edges cross.

- **Inferred parentage renders dashed** (`4 2`). Recall never pretends (§1): if the link
  was guessed from a filename rather than observed, the line says so, and the tooltip
  states the guess in plain language.
- **Observed parentage renders solid.**

### Tags

An export or bounce is a tag on the lane: a `--panel-3` chip, `--t-micro`, `--font-mono`,
connected by a `--stroke-hair` leader. No color — an export is a fact, not a mark.

**`--moment` appears on the graph in exactly one place:** a moment the producer pinned
themselves. It stays the loudest thing on the screen, and it stays rare.

### Time

The x-axis is **real elapsed time, always**, shared with the Report so the two surfaces
agree. Long idle gaps between versions collapse to a fixed `--s6` break marked with a
hairline and a mono label (`3 weeks`) — a break that **names what it removed** is honest;
silently rescaling the axis is not.

### Motion

The graph resolves once: lanes and edges draw in over `--m-develop` with `--ease-arrive`,
then hold. **Edges must not animate along their own path** — that is `travel`, banned by
§6, and it would make a two-year-old branch look like it is happening now. Under
`prefers-reduced-motion` the graph renders complete immediately.

## Decisions Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-07-15 | Initial design system (v1.0) | `/plan-design-review` — dark studio instrument, entity-color system, Bahnschrift/Aptos, the motion tense-rule. |
| 2026-08-04 | **v2.0 professional redesign** | `/design-consultation`. The v1 look read as playful/consumer, not as a professional record. Two changes: (1) typography → **IBM Plex Sans + Mono**, bundled — an engineering face that reads like instrumentation; (2) color → **fully monochrome**, a graphite ramp plus one signal blue (`--signal`, interactive/now) and one warm moment accent (`--moment`). The entity-color system (track/device/parameter hues) was **retired**; type is now told apart by weight, monospace, and luminance. Motion tense-rule, spacing, layout, component patterns, and voice were kept — they were already right. Chosen direction: "Technical record / the instrument's logbook." |
| 2026-08-25 | **v2.1 — structure vocabulary (§11)** | The system described rows, and the version graph is not a row. Three rules written for rows were **scoped, not repealed**: the 1px hairline now governs chrome while drawn geometry gets a 3-step stroke scale (§5); single-column now governs reading surfaces while graph surfaces are 2D and horizontally scrollable (§8); "hue does almost nothing" is unchanged for *entities*, and lanes are differentiated by **luminance depth** instead (§11). Monochrome, the retired entity-color system, and the motion tense-rule all hold — the graph draws once and never travels. |

*Next: retire the ~100 remaining `var(--track|--device|--parameter|…)` alias call sites in
favour of the type-based differentiation in §2, then delete the alias tokens. For v2.1, add
the §5 stroke scale and the §11 lane ramp (`--lane-0…3`, `--radius-node`) to
`src/styles/tokens.css` before building the version graph.*
