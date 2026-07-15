# Recall Studio — TODOs

Design debt and deferred work. Created 2026-07-15 by `/plan-design-review`.
Items here are **not** on the 1.0 critical path unless marked otherwise — see
[ROADMAP.md](docs/ROADMAP.md) §6 for the ordered checklist.

---

## D1 · Keyboard navigation for the timeline and Sound Story

**What:** Arrow-key navigation, `Enter` to open, and a visible focus ring
(`--track`, 2px) on the timeline event list and the Sound Story chronology.

**Why:** Both surfaces are long, scannable lists — the exact thing a keyboard is good
at — and both are currently mouse-only. [DESIGN.md](DESIGN.md) §9 now requires it and
[PRD.md](docs/PRD.md) §9 criterion 4 makes it a release gate, so it is committed in the
docs. This item is what stops that commitment from being a sentence nobody scheduled.

**Pros:** Makes the release criterion real. A producer scanning 300 knob rides for the
one they half-remember is doing keyboard work; today they can only click. Building it
into Sound Story as it's written costs a fraction of retrofitting it later.

**Cons:** Real work on the timeline, which already carries complex interaction state.
Not a beta blocker by the blocker table in ROADMAP §4.

**Context (for whoever picks this up in 3 months):** Recall's surfaces are fundamentally
lists of small facts. The product's core loop is *scan → recognise → pin*, and scanning
is faster with a keyboard than a mouse. The reason this isn't beta-blocking is that beta
testers are producers who will reach for the mouse by habit; the reason it still matters
is that PRD §9 says it ships in 1.0, and hover-only affordances are banned by DESIGN.md
§9 for the same underlying reason (a thing you must hover to discover is a thing that
can't be scanned).

**Depends on / blocked by:** Sound Story (ROADMAP §6 item 8). Timeline half can start
any time.

---

## D2 · Diagnostics panel — visual design

**What:** Specify the Diagnostics panel's information hierarchy, its interaction
states, and where it lives in the navigation.

**Why:** [SPEC.md](docs/SPEC.md) §F8 gets the hard part right — the voice ("3 parameter
ticks were thinned during a burst — nothing important was lost") — and says nothing
about what is on the screen. It's ROADMAP §6 item 2 (~½ day), so it gets built within
days, well before Sound Story. ROADMAP §1 names the gap it closes: *"When a tester says
'it crashed,' there is nothing to look at."*

**Pros:** About to be built, so specifying it is nearly free right now. This panel is
what makes every beta bug report legible instead of anecdotal.

**Cons:** A utility surface a producer sees rarely, and only when already worried.
Over-designing it is waste.

**Context (for whoever picks this up in 3 months):** Diagnostics carries trust weight far
out of proportion to how often it's opened, because it is opened precisely when the
producer already suspects the app is lying to them. That argues for plain, dense, and
calm — not reassuring. Two specific open points: (1) it has **no nav home**, the same
problem Sound Story had (resolved there as a drill-in under Projects with a breadcrumb —
Diagnostics may want to live under Home/setup instead); (2) §F8's plain-language rule
means the numbers need translating at render time, so the layout has to give the sentence
more room than the counter.

**Depends on / blocked by:** `get_bridge_metrics` exists in `metrics.rs` but has no
frontend consumer. Nothing blocks this.

---

## D3 · Retire `--faint` from small text *(live accessibility bug)*

**What:** Add `--faint-aa: #7d84a0` to `tokens.css` and replace `--faint` wherever it
carries text under 19px.

**Why:** `--faint` (`#636a82`) on `--panel` (`#14161f`) computes to **3.36:1**, below the
WCAG AA bar of 4.5:1 for body text. It is currently used on exactly the small text that
bar exists to protect: timestamps, hints, take labels. `--muted` is fine (5.69:1).

**Pros:** ~1 hour. Fixes a real, measurable defect before Sound Story adds a lot more
small metadata text that would inherit it.

**Cons:** Touches many call sites in `components.css`. Slightly reduces the contrast
*range* available for de-emphasis.

**Context:** Caught by `/plan-design-review` 2026-07-15. See [DESIGN.md](DESIGN.md) §2
for the full contrast table. `--faint` is not deleted — it stays legal for large text
(≥19px, or ≥15px bold), where 3.36:1 clears the 3:1 large-text bar.

**Depends on / blocked by:** Nothing. Pairs naturally with landing the DESIGN.md spacing
and type scales (ROADMAP §6 item 10).

---

## D4 · Fix the motion tense — retire the living-motion vocabulary

**What:** Land the [DESIGN.md](DESIGN.md) §6 motion tokens in `motion.css`, replace all
51 `linear` easings with `--ease-arrive`, and retire the looping keyframes on historical
data: `tl-pip-pulse`, `playheadBreathe`, `nodeFloat`, `signalSweep`, `chamberScan`,
`projectNoticeScan`, `gridTravel`, `pxPulse`.

**Why:** Recall's motion currently speaks the music-plugin world's **realtime** language —
pulse, breathe, float, drift, scan — on data about the past. Every tool in that category
glows and moves because something is *happening now*; Recall is the only one showing what
already happened, so the borrowed vocabulary makes the interface lie about tense. The
memorable thing is "it remembered something I forgot," and memory settles rather than
pulses.

**Pros:** It's the only part of the design system that contradicts the product's core
claim. Banning `linear` alone shifts the whole register for a few hours' work. Also names
`--m-settle: 120ms`, which is already the de facto constant (24 uses, unnamed).

**Cons:** Touches a lot of CSS across two large files. `ActivitySpark` needs judgement, not
a find-and-replace — it survives *if* it develops once and holds, and dies if it loops.

**Context (for whoever picks this up in 3 months):** This came out of screenshotting Serum
and Ozone. Both use identical grammar: neutral chrome, luminous *moving* data, where the
movement means live. Recall should keep the glow (that's how this category renders data)
and give up the pulse (that's how it renders *now*). The one deliberate exception is the
connection-status dot, which may pulse precisely because it's the only genuinely live fact
on screen — when the only breathing thing is the connection, breathing *means* connection.

**Depends on / blocked by:** Nothing. Do it before Sound Story so the new surface is built
in the right register rather than retrofitted.

---

## D5 · Cut the `.ecosystem-background` drifting blobs

**What:** Remove `.ecosystem-background` (three `<span>`s in `AppShell.tsx:49`) and its
`ecosystemDrift` keyframe.

**Why:** Decorative floating blobs are a recognised AI-slop pattern and, more to the point,
they're motion with no referent — they move because they can, not because anything
happened. That contradicts DESIGN.md §1 (calm surface hierarchy; Recall never competes for
the producer's attention) and §6 (motion means arrival or recognition, nothing else).

**Pros:** Pure subtraction. Removes code, removes a slop tell, removes an animation running
forever behind a tool for remembering things.

**Cons:** It's presumably there because the shell felt empty without it. If a screen feels
empty, that's a content problem, not a decoration problem — but expect the shell to look
barer before it looks better.

**Context:** Missed in the first design review's AI-slop pass (which scored the app 8/10);
caught while inventorying keyframes during the design consultation the same day. If the
background genuinely needs presence, the answer is the `--panel` ramp and a hairline, not
drifting shapes.

**Depends on / blocked by:** Nothing. Pairs with D4.

---

## D6 · Light install page

**What:** The download page goes light and warm rather than inheriting the app's dark
palette. One page: what it is, one screenshot, download button, the SmartScreen
"More info → Run anyway" note, known limitations.

**Why:** Ableton themselves split brand from tool — ableton.com is pastel green, cream, and
brown while Live's UI is flat grey. The marketing is human and creative; the instrument
gets out of the way. Recall's install page has no obligation to be dark, and going light
means it can't be mistaken for the app while signalling that people made this, not a
compiler.

**Pros:** ~4 hours. Distinguishes page from product. Follows the strongest precedent in the
category.

**Cons:** Two aesthetics to hold in your head. Needs its own small set of decisions, since
DESIGN.md documents the dark tool only.

**Context:** Recall is a native local app — this page exists *only* so producers can
download and install it (ROADMAP §5). It is not a marketing site and must not grow into
one.

**Depends on / blocked by:** ROADMAP Phase 5. Not before beta.
