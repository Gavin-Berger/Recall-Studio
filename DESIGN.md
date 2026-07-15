# Recall Studio — Design System

*v1.0 · 2026-07-15 · companion to [PRD.md](docs/PRD.md) / [SPEC.md](docs/SPEC.md).
The PRD says **what and why**, SPEC says **how**, this says **what it looks like and
why it looks that way**.*

**Source of truth is [`src/styles/tokens.css`](src/styles/tokens.css).** This document
explains the decisions behind those tokens and adds the two scales the file was missing.
Where this doc and `tokens.css` disagree, the CSS is right and this doc is a bug.

---

## 1 · What Recall should feel like

A producer opens Recall between takes, at 1am, next to Ableton. It is a **studio
instrument, not a productivity app**. Three consequences:

1. **Dark, always.** Not a theme choice — it sits beside Live's dark UI on a dim
   desk. There is no light mode and none is planned.
2. **Calm surface hierarchy.** The producer's attention belongs to the music. Recall
   never competes for it. No dashboard mosaics, no thick borders, no decorative
   gradients, no ornamental icons.
3. **Dense but readable.** A session is thousands of small facts. The UI's job is to
   let the eye scan them, not to pad them into cards.

**Governing rule: Recall never pretends.** Where data is missing or uncertain, the UI
says so in place, in plain language. This is a *design* rule, not just a copy rule —
it is why honest-degradation rows have a visual treatment (see §6).

## 2 · Color

All values are the existing tokens. Hex here is documentation, not a second source.

### Surfaces

| Token | Value | Use |
|---|---|---|
| `--ink` | `#0b0e18` | Page base. Body applies a vertical gradient to `--ink-2` and back down to `#080b13`. |
| `--ink-2` | `#10131f` | Gradient midpoint only. |
| `--panel` | `#14161f` | Primary panel / sidebar. |
| `--panel-2` | `#191c27` | Raised panel, row hover. |
| `--panel-3` | `#202432` | Active nav item, badges, inline chips. |
| `--line` | `#2a3041` | Hairline borders. **Always 1px.** Never thicker. |
| `--line-soft` | `#222838` | Internal dividers inside a panel. |

### Text

| Token | Value | Use | Contrast on `--panel` |
|---|---|---|---|
| `--paper-strong` | `#f4f6ff` | Headings, settled values, the thing you want read. | 15.1:1 |
| `--paper` | `#d8dcef` | Body. | 11.4:1 |
| `--muted` | `#8b90a3` | Secondary text, detail after a `·`. | 5.69:1 ✅ |
| `--faint` | `#636a82` | **Large text only (≥19px, or ≥15px bold).** | 3.36:1 ❌ AA for body |
| `--faint-aa` | `#7d84a0` | Small metadata: timestamps, hints, labels, take dates. | 4.6:1 ✅ |

> **`--faint` fails WCAG AA (4.5:1) for body text at 3.36:1.** It predates this
> document and is currently used on small metadata, which is a live accessibility bug.
> `--faint-aa` is its replacement for anything under 19px. `--faint` stays for large
> or decorative text only. **New code must not put `--faint` on small text.**

### Entity colors — semantic, never decorative

Each color means exactly one kind of thing, everywhere in the app. A device is violet
in the timeline, in Sound Story, in a take diff, in an export. This is the single most
important consistency rule in the system: **color is a type signal, not styling.**

| Token | Value | Means |
|---|---|---|
| `--track` | `#6382ff` | A track |
| `--device` | `#9c88ff` | A device |
| `--parameter` | `#5ab4a0` | A parameter / knob ride |
| `--clip` | `#aaccf0` | A clip |
| `--transport` | `#f0cfa0` | Transport & tempo |
| `--session` | `#ffd98a` | **A pinned moment.** The producer's own mark — the only warm color, and the loudest thing on any screen it appears on. |
| `--danger` | `#dc5a6a` | Removal, destructive action, error |

Aliases `--oxide` / `--sage` / `--brass` / `--smoke` are the same values under
palette names; prefer the semantic token in new code.

**Do not introduce a new accent color.** If something needs emphasis, it is one of the
seven things above, or it uses weight and position instead.

## 3 · Typography

Real typefaces, chosen for Windows, shipped with Windows. **Never `system-ui`,
`-apple-system`, Inter, Roboto, or Arial** — a default stack is the "gave up on
typography" signal and Recall is not that product.

| Token | Stack | Use |
|---|---|---|
| `--font-display` | Bahnschrift → Aptos Display → Segoe UI Variable Display | Headings, track names, moment text. A condensed grotesque — it reads like equipment labelling. |
| `--font-body` | Aptos → Segoe UI Variable Text → Segoe UI | All body and UI text. |
| `--font-mono` | Cascadia Code → JetBrains Mono → Consolas | **Every number, every `.als` filename, every parameter value.** Non-negotiable: values must align vertically so the eye can scan a column of knob rides. |

### Type scale *(new — no scale existed)*

| Token | Size | Use |
|---|---|---|
| `--t-display` | 30px | Screen title (track name in Sound Story) |
| `--t-h1` | 20px | Section heading, moment text |
| `--t-h2` | 15px | Sub-heading, nav label, chapter filename |
| `--t-body` | 15px | Body |
| `--t-meta` | 13px | Rows, secondary detail |
| `--t-micro` | 11px | Uppercase labels, timestamps, badges |

**Body text is never below 13px, and 13px is only for dense rows with `--muted` or
lighter.** Uppercase micro labels carry `letter-spacing: .08em–.1em`.

## 4 · Spacing *(new — no scale existed)*

`components.css` is 3,629 lines for six surfaces, because with no scale every component
invented its own padding. These values are derived from what the existing CSS already
gravitates toward.

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

**Rule: no raw pixel padding or margin in new components.** If a value isn't on the
scale, either the scale is wrong (change it here) or the component is (change it there).

## 5 · Shape and depth

- `--radius: 10px` — panels, cards, empty states.
- `--radius-sm: 6px` — buttons, rows, chips, badges.
- `--shadow` — **one** shadow, for genuinely floating things (dialogs). Depth otherwise
  comes from the `--panel` → `--panel-2` → `--panel-3` ramp plus a `--line` hairline.
  **A screen must look right with every shadow removed.**

## 6 · Motion — the tense rule

*This is the one part of the system that changed in the 2026-07-15 consultation. Everything
else was already right.*

### The principle

**Recall shows the past. Its motion must not say "now."**

Every visual convention in music-production software is **realtime**. Waveforms, spectrum
analyzers, meters, knob positions — they glow and move because something is *happening*.
In this category, luminosity and movement mean **live**. Serum and Ozone both work exactly
this way: neutral chrome, luminous moving data.

Recall is the only tool in the studio visualizing what already happened. So borrowing that
vocabulary makes the interface lie about tense. A timeline that pulses like a spectrum
analyzer tells the producer they're watching something live. They aren't. They're
remembering.

The product's memorable thing is **"it remembered something I forgot."** Memory doesn't
pulse. It surfaces, resolves, and settles. Think **developed film, not a live meter.**

### Two registers, and only two

| Register | Means | Where |
|---|---|---|
| **Arrival** | Content resolving into place, once, and holding. | Story rows, chapters, panels, skeleton→content swaps. |
| **Recognition** | The thing you were looking for landing. | A pinned moment coming into view; a search/filter match; a relinked take snapping into the story. |

If a motion is neither of these, it does not ship.

### Banned

- **Infinite loops on anything historical.** No `pulse`, `breathe`, `float`, `drift`,
  `sweep`, `scan`, `travel`. These are the vocabulary of a living signal. As of
  2026-07-15 the codebase had 13 keyframes and most were in this family — they were
  absorbed unconsciously from the plugin world and applied to data about the past.
- **`linear` easing.** 51 uses as of 2026-07-15. Nothing in the physical world moves at
  constant velocity; linear reads as a machine mid-operation — a scanner, a loading bar,
  something *in progress*. Your history is not in progress.
- **Decorative motion with no referent.** `.ecosystem-background` (three drifting spans in
  `AppShell.tsx`, animated by `ecosystemDrift`) is floating decorative blobs. It moves
  because it can, not because anything happened. It contradicts §1's calm-surface rule and
  the "as little design as possible" default. **Cut it, don't tune it.**

### The one exception

**The connection-status dot may pulse.** It is the single element on screen that
genuinely reports a live fact — is Ableton talking to us *right now*. It has earned the
living vocabulary precisely because everything else has given it up. That contrast is
the point: when the only breathing thing in the interface is the connection, breathing
*means* connection.

### Tokens *(new — motion.css held only the reduced-motion opt-out)*

| Token | Value | Use |
|---|---|---|
| `--m-settle` | `120ms` | Hover, focus, small state changes. **Already the de facto constant — it appeared 24 times before it had a name.** |
| `--m-arrive` | `220ms` | A row, panel, or chapter arriving. |
| `--m-develop` | `420ms` | The one-shot reveal of a whole story or spark. Like film developing. |
| `--ease-arrive` | `cubic-bezier(0.16, 1, 0.3, 1)` | **The default.** Fast start, long settle — the curve of something coming to rest. |
| `--ease-exit` | `cubic-bezier(0.4, 0, 1, 1)` | Leaving. Things exit faster than they arrive. |

### ActivitySpark — the hard case

[`timeline/parts.tsx:48`](src/components/schema/timeline/parts.tsx:48) draws a glowing
gradient waveform that animates in on mount. It is the best-looking thing in the codebase
and it sits exactly on the line this section draws.

**The verdict: it survives, with a condition.** A spark that **develops once and holds**
is *arrival* — it's the session's shape resolving, which is precisely the memorable thing.
A spark that loops, breathes, or re-animates on scroll is a *heartbeat*, which is a lie.
Draw it once with `--m-develop` and `--ease-arrive`, then leave it alone forever.

The glow itself is fine and should stay. Luminosity is how this category renders data, and
Recall's data deserves it. What Recall gives up is not the glow — it's the **pulse**.

### Reduced motion

`prefers-reduced-motion` kills all of it and keeps every pixel of content
(`motion.css` already does this correctly). Under reduced motion the spark renders at its
final state immediately — no draw, no fade.

## 7 · Component patterns to reuse, not reinvent

These already exist and are already right. New surfaces inherit them.

**Before → after value** — [`timeline/parts.tsx:114`](src/components/schema/timeline/parts.tsx:114),
class `tl-ba`. Mono, `before → after`, direction caret (`--transport` warm for up,
`--clip` cool for down), `N×` badge for a collapsed run, categorical pill for quantized
values. Sound Story's parameter rides use this exact component, extended with a swept
range in `--faint-aa` behind a `--line` divider. **Do not build a second value style.**

**Empty state** — [`timeline/parts.tsx:9`](src/components/schema/timeline/parts.tsx:9),
class `tl-scan`. Icon, a specific heading that names *what* is waiting, one sentence
explaining what the producer does next, a primary action, ghost skeleton bars. The
copy names the situation ("Waiting for your first move"), never the absence
("No items found"). Every empty state in the app follows this shape.

**Honest degradation** — a row rendered in `--muted` italic with a `?` glyph in
`--faint-aa`, stating what isn't known and why: *"preset changed — name not exposed by
the plugin."* Used for VST opacity (SPEC §F1) and for unresolved cross-take identity
(SPEC §F4). One rule, one treatment: **wherever Recall doesn't know, it says so in
place.**

**Ghost skeleton** — `tl-scan__ghost`, staggered-width bars at ~30% opacity. Used for
loading, not just empty.

## 8 · Layout

**Recall lives beside Ableton, not instead of it.** Live takes the screen; Recall gets
what's left. The primary target is **~900px wide** (roughly half of a 1080p display),
not fullscreen. Fullscreen is the *bonus* case.

- **Sidebar:** 208px fixed. Below ~860px it collapses to an icon rail; the connection
  status stays visible at every width — it is the one thing that must never be hidden.
- **Content:** single column, `max-width: 1080px`, `--s7` gutter. Sound Story and the
  timeline are single-column at every width — there is no two-column variant to break.
- **Arrangement view (§F5):** the bars/beats ruler **scrolls horizontally**; it never
  compresses. A squeezed ruler is a lying ruler.
- **Window min-size:** derived from the above — the floor is the narrowest width where
  the icon rail plus a readable row still work. Set it in `tauri.conf.json` from the
  measured value, not from a guess.

## 9 · Accessibility bars

Not aspirations — these are requirements, checkable before merge.

- **Contrast:** body text ≥ 4.5:1, large text ≥ 3:1. `--faint` on small text fails and
  is banned (§2).
- **Keyboard:** every surface reachable and operable without a mouse. The timeline and
  Sound Story are lists — arrow-key navigable, `Enter` to open, visible focus ring
  (`--track`, 2px). Never a hover-only affordance: a desktop app still has keyboard
  users, and hover hides things from scanning.
- **Semantics:** `aria-label` on landmarks (already done in
  [AppShell.tsx:56](src/components/AppShell.tsx:56)); `aria-hidden` on decorative
  elements (already done); never a placeholder as the only label on a field.
- **Motion:** honour `prefers-reduced-motion` — kill the spark draw-in, keep the content (§6).

## 10 · Voice

Producer vocabulary, always: **takes, moments, sessions, rides, chain.** Never packets,
events, schemas, entities, projections, or queue depth — those words exist in the code
and must never reach the UI.

Utility language: orientation, status, action. Not mood, not aspiration, not
congratulation. Diagnostics says *"3 parameter ticks were thinned during a burst —
nothing important was lost"*, never *"Optimized!"*.

If deleting 30% of a string improves it, keep deleting.

---

*Reviewed by `/plan-design-review` on 2026-07-15. Next: `/design-consultation` for a
full system pass over aesthetic, motion, and layout.*
