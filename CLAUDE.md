# gstack

gstack provides a suite of workflow skills. Install it with:
`git clone --single-branch --depth 1 https://github.com/garrytan/gstack.git ~/.claude/skills/gstack && cd ~/.claude/skills/gstack && ./setup`

**Web browsing:** Use the `/browse` skill from gstack for **all** web browsing. **Never**
use the `mcp__claude-in-chrome__*` tools.

**Available skills:**
`/office-hours`, `/plan-ceo-review`, `/plan-eng-review`, `/plan-design-review`,
`/design-consultation`, `/design-shotgun`, `/design-html`, `/review`, `/ship`,
`/land-and-deploy`, `/canary`, `/benchmark`, `/browse`, `/connect-chrome`, `/qa`,
`/qa-only`, `/design-review`, `/setup-browser-cookies`, `/setup-deploy`, `/setup-gbrain`,
`/retro`, `/investigate`, `/document-release`, `/document-generate`, `/codex`, `/cso`,
`/autoplan`, `/plan-devex-review`, `/devex-review`, `/careful`, `/freeze`, `/guard`,
`/unfreeze`, `/gstack-upgrade`, `/learn`

## Skill routing

When the user's request matches an available skill, invoke it via the Skill tool. When in doubt, invoke the skill.

Key routing rules:
- Product ideas/brainstorming → invoke /office-hours
- Strategy/scope → invoke /plan-ceo-review
- Architecture → invoke /plan-eng-review
- Design system/plan review → invoke /design-consultation or /plan-design-review
- Full review pipeline → invoke /autoplan
- Bugs/errors → invoke /investigate
- QA/testing site behavior → invoke /qa or /qa-only
- Code review/diff check → invoke /review
- Visual polish → invoke /design-review
- Ship/deploy/PR → invoke /ship or /land-and-deploy
- Save progress → invoke /context-save
- Resume context → invoke /context-restore
- Author a backlog-ready spec/issue → invoke /spec

## Design

[DESIGN.md](DESIGN.md) is the design source of truth: tokens, spacing/type scales,
component patterns to reuse, motion, and the accessibility bars. Read it before building
or restyling any surface. Three rules that catch people out:

- **Entity colors are a type signal, not styling.** A device is `--device` violet in
  the timeline, in Sound Story, in a diff, in an export. Never recolor for emphasis.
- **`--faint` is banned on text under 19px** (3.36:1, fails WCAG AA). Use `--faint-aa`.
- **Motion is past tense** (DESIGN.md §6). Recall shows what already happened, so nothing
  historical may pulse, breathe, float, drift, sweep, or scan — that's the plugin world's
  *realtime* vocabulary and using it makes the UI say "now" when it means "then". Motion
  has two registers only: **arrival** and **recognition**. `linear` easing is banned; use
  `--ease-arrive`. The connection-status dot is the sole exception — it may pulse because
  it is the only genuinely live fact on screen.

## Frontend skills

Installed in `~/.claude/skills/` (personal, not vendored here):
`taste-skill`, `image-to-code`, `web-design-guidelines`, `awesome-design-md`.

**[DESIGN.md](DESIGN.md) outranks all four.** They are general-purpose web skills
written against assumptions Recall does not share, so where they disagree with
DESIGN.md, DESIGN.md wins — silently following the skill is a bug, not a judgement call.

Known conflicts, so they are not rediscovered each time:

- **`taste-skill` hardcodes `MOTION_INTENSITY: 6`** and a matching motion vocabulary.
  DESIGN.md §6 bans it outright: Recall shows what already happened, so nothing
  historical may pulse, breathe, float, drift, sweep, or scan. Ignore the motion
  section entirely. The connection-status dot remains the sole exception.
- **`taste-skill` mandates Tailwind and Next.js/RSC.** Recall is Vite + React with
  plain CSS and design tokens. There is no Tailwind and no server components. Take its
  reasoning about hierarchy and density; discard the stack directives.
- **`taste-skill` sets `DESIGN_VARIANCE: 8`** ("artsy"). Recall's system is
  deliberately monochrome with one signal and one moment accent. Do not reintroduce
  colour for emphasis — entity colours were retired on purpose.
- **`web-design-guidelines` is the safe one.** It is mechanical craft review
  (tabular numerals, focus rings, hit targets, empty/sparse/dense/error states) and
  does not carry an aesthetic. Use it freely; it is the best fit of the four for
  the data-dense timeline and report surfaces.
- **`awesome-design-md` is reference only.** Never copy a brand's identity into Recall.

## End-to-end tests

`npm run test:e2e` drives the real browser against the Vite dev server. It runs
serially on purpose — see the comment in [playwright.config.ts](playwright.config.ts).

These cover the layer `npm test` cannot reach: that each surface actually paints.
`isTauri()` is false in a plain browser and App.tsx treats that as a supported
preview path, so the shell and every empty state are reachable with no Rust backend.
Anything needing real capture data belongs in vitest instead.

The console-error guard in [e2e/smoke.spec.ts](e2e/smoke.spec.ts) asserts an empty
array with no exemptions. Do not widen it to silence a failure — a clean boot really
does produce zero console errors, so anything appearing there is a regression.
