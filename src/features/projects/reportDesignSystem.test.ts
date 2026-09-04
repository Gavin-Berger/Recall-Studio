import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// DESIGN.md conformance, checked against the stylesheet itself.
//
// These rules drifted silently once already: the report page had labels down at
// 9px, sixteen of its twenty visible numbers rendering proportional, an
// animation that ignored prefers-reduced-motion, and a 620ms bespoke bezier
// nowhere near the motion scale. None of it was catchable by a render test,
// because the violations live in CSS that jsdom never applies — so the guard has
// to read the stylesheet as text.
const cssPath = fileURLToPath(new URL("./SessionRecapScreen.css", import.meta.url));
const css = readFileSync(cssPath, "utf8");

/** Strip comments so prose about a rule can never be mistaken for the rule. */
const code = css.replace(/\/\*[\s\S]*?\*\//g, "");

describe("report page · DESIGN.md §3 type floor", () => {
  it("sets no type below the 11px --t-micro floor", () => {
    // px values under 11, and rem values that resolve under 11 at a 16px root.
    const px = [...code.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g)]
      .map((m) => Number(m[1]))
      .filter((value) => value < 11);
    const rem = [...code.matchAll(/font-size:\s*(\d*\.?\d+)rem/g)]
      .map((m) => Number(m[1]) * 16)
      .filter((value) => value < 11);

    expect({ px, rem }).toEqual({ px: [], rem: [] });
  });

  it("renders numerals tabular so columns of counts line up", () => {
    expect(code).toMatch(/\.session-report\s*\{[^}]*font-variant-numeric:\s*tabular-nums/);
  });
});

describe("report page · DESIGN.md §6 motion", () => {
  /** Selectors that own an `animation:` shorthand, in source order. */
  function animatedSelectors(): string[] {
    const found: string[] = [];
    // Match "<selector> { ... animation: ... }" one rule block at a time.
    for (const block of code.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
      const [, selector, body] = block;
      if (!/animation:\s*[a-zA-Z]/.test(body)) continue;
      if (/animation:\s*none/.test(body)) continue;
      for (const part of selector.split(",")) {
        const trimmed = part.trim();
        if (trimmed.startsWith("@") || trimmed.startsWith("from") || trimmed.startsWith("to")) continue;
        if (trimmed.includes("%")) continue; // keyframe stop
        if (trimmed) found.push(trimmed);
      }
    }
    return [...new Set(found)];
  }

  it("uses the motion tokens rather than raw durations or bespoke easing", () => {
    const rawDuration = [...code.matchAll(/animation:\s*[\w-]+\s+(\d+m?s)/g)].map((m) => m[1]);
    expect(rawDuration).toEqual([]);

    // --ease-arrive / --ease-exit are the only curves; linear is banned outright.
    const bespokeEasing = [...code.matchAll(/animation:[^;]*?(cubic-bezier\([^)]*\)|\blinear\b)/g)]
      .map((m) => m[1]);
    expect(bespokeEasing).toEqual([]);
  });

  it("lets prefers-reduced-motion switch every animation off", () => {
    // Split on the media-query opener and keep what follows, rather than trying
    // to balance braces with a regex.
    const reduceBlocks = code
      .split(/@media\s*\(prefers-reduced-motion:\s*reduce\)/)
      .slice(1)
      .join("\n");

    expect(reduceBlocks, "no prefers-reduced-motion block at all").not.toBe("");

    // Compared as a list so a failure names the offending selector rather than
    // just flipping a boolean.
    const missing = animatedSelectors().filter((selector) => !reduceBlocks.includes(selector));
    expect(missing).toEqual([]);
  });
});

/** The rule blocks whose selector list mentions the session-score panel. */
function scoreRules(): string[] {
  return [...code.matchAll(/([^{}]+)\{([^}]*)\}/g)]
    .filter((block) => block[1].includes(".report-score"))
    .map((block) => block[0]);
}

describe("report page · the accent points at the data", () => {
  // The score panel used to spend the page's only accent on chrome: a bloom
  // behind the panel, a halo on the transcript node, a 24px text-shadow on the
  // hero figure, two concentric rings around it. A shadow with no offset and a
  // blur is a glow, and once everything glows nothing is emphasised.
  it("draws no offsetless glows", () => {
    // A shadow layer is [inset] <x> <y> [blur] [spread] <color>. Read the
    // leading lengths rather than pattern-matching the string, so that an inset
    // ring (`inset 0 0 0 9px`, blur zero) is not mistaken for a halo.
    const lengthsOf = (layer: string): number[] => {
      const lengths: number[] = [];
      for (const token of layer.trim().replace(/^inset\s+/, "").split(/\s+/)) {
        const match = /^(-?\d+(?:\.\d+)?)(?:px|rem|em)?$/.exec(token);
        if (!match) break;
        lengths.push(Number(match[1]));
      }
      return lengths;
    };

    const glows: string[] = [];
    for (const decl of code.matchAll(/(?:box|text)-shadow:\s*([^;]+);/g)) {
      for (const layer of decl[1]!.split(",")) {
        const [x, y, blur] = lengthsOf(layer);
        if (x === 0 && y === 0 && (blur ?? 0) > 0) glows.push(layer.trim());
      }
    }
    expect(glows).toEqual([]);
  });

  // Hover feedback on the old donuts animated box-shadow, which the compositor
  // cannot handle — every frame repainted the whole panel.
  it("never transitions box-shadow", () => {
    const offenders = [...code.matchAll(/transition:[^;]*\bbox-shadow\b[^;]*;/g)].map((m) => m[0]);
    expect(offenders).toEqual([]);
  });

  // A data mark's colour must come from the measurement, never from the kind of
  // work it happens to be: --work-accent gave the smallest area the loudest hue
  // whenever mixing happened to place third.
  it("keeps entity colour out of the score panel", () => {
    const offenders = scoreRules().filter((rule) => rule.includes("--work-accent"));
    expect(offenders).toEqual([]);
  });

  // The hero figure wears the page sans. The old one was a 92px monospace
  // numeral at 10% alpha with a 1px stroke — a shape, not a number.
  it("draws the hero figure in the page sans with proportional numerals", () => {
    const hero = scoreRules().filter((rule) => rule.trim().startsWith(".report-score__hero"));
    expect(hero.length).toBeGreaterThan(0);
    const value = hero.find((rule) => !rule.includes("__hero-note"))!;
    expect(value).not.toMatch(/font-family/);
    expect(value).not.toMatch(/text-stroke/);
    expect(value).toMatch(/font-variant-numeric:\s*proportional-nums/);
  });
});

// ── The same floor, everywhere else (issue #18) ────────────────────────────
//
// The report page was brought to the floor first and guarded above, which left
// 226 declarations below 11px in the rest of the app — 143 of them in the
// timeline alone, the smallest at 8px. DESIGN.md §1 puts the reader at a dim
// desk at 1am next to Live; an 8px label is not readable there, which is the
// entire use case.
//
// The guard is widened rather than duplicated, so there is one definition of
// the floor and no stylesheet can be added outside it.
const APP_STYLESHEETS = [
  "../../styles/components.css",
  "../../components/schema/SchemaTimeline.css",
  "../planner/PlannerScreen.css",
  "./ProjectBriefingScreen.css",
  "./ProjectHistoryScreen.css",
  "./VersionGraphView.css",
  "./VersionTimelineScreen.css",
];

describe("the whole app · DESIGN.md §3 type floor", () => {
  it.each(APP_STYLESHEETS)("sets no type below the 11px floor in %s", (relative) => {
    const sheet = readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "");

    // Reported as file-relative "0.58rem -> 9.28px" strings so a failure names
    // the value to fix rather than only a count.
    const offenders: string[] = [];
    for (const match of sheet.matchAll(/font-size:\s*(\d*\.?\d+)(rem|px)/g)) {
      const px = match[2] === "rem" ? Number(match[1]) * 16 : Number(match[1]);
      if (px < 11) offenders.push(`${match[1]}${match[2]} -> ${px}px`);
    }
    expect(offenders).toEqual([]);
  });
});

describe("version timeline · producer-readable work trail", () => {
  const timeline = readFileSync(
    fileURLToPath(new URL("./VersionTimelineScreen.css", import.meta.url)),
    "utf8",
  ).replace(/\/\*[\s\S]*?\*\//g, "");

  function rule(selector: string): string {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return timeline.match(new RegExp(`${escaped}\\s*\\{[^}]*\\}`))?.[0] ?? "";
  }

  it("keeps the graph and retrace on the same centered reading measure", () => {
    expect(rule(".vt")).toMatch(/--vt-reading-width:\s*1080px/);
    expect(timeline).toMatch(/\.vt__surface\s*\{[^}]*max-width:\s*var\(--vt-reading-width\)/);
    expect(timeline).toMatch(/\.vt__surface\s*\{[^}]*margin-inline:\s*auto/);
    expect(rule(".vt__surface-head")).toMatch(/max-width:\s*none/);
    expect(rule(".vt__body")).toMatch(
      /grid-template-columns:\s*minmax\(520px, 2fr\) minmax\(360px, 1fr\)/,
    );
    expect(rule(".vt__body")).toMatch(/max-width:\s*none/);
    expect(rule(".vt-depth")).toMatch(/max-width:\s*var\(--vt-reading-width\)/);
    expect(rule(".vt-depth__head")).not.toMatch(/border-left:/);
  });

  it("makes every movement card's subject and result readable body text", () => {
    expect(rule(".vt-movement-card__head h4")).toMatch(/color:\s*var\(--paper-strong\)/);
    expect(rule(".vt-movement-card__head h4")).toMatch(/font-size:\s*var\(--t-body\)/);
    expect(rule(".vt-movement-card__facts dd")).toMatch(/color:\s*var\(--paper-strong\)/);
    expect(rule(".vt-movement-card__facts dd")).toMatch(/font-size:\s*var\(--t-meta\)/);
  });

  it("lays track, result, and movement count out as labelled facts", () => {
    const facts = rule(".vt-movement-card__facts");
    expect(facts).toMatch(/display:\s*grid/);
    expect(facts).toMatch(/grid-template-columns:\s*1fr/);
    expect(timeline).toMatch(/\.vt-movement-card__facts dt[\s\S]*?color:\s*var\(--muted\)/);
  });

  it("aligns the icon, title, facts, and visual on one explicit card grid", () => {
    expect(rule(".vt-movement-card__content")).toMatch(
      /grid-template-columns:\s*44px minmax\(190px, 248px\) minmax\(240px, 520px\)/,
    );
    expect(rule(".vt-movement-card__identity")).toMatch(
      /grid-template-columns:\s*44px minmax\(0, 1fr\)/,
    );
    expect(rule(".vt-movement-card__facts")).toMatch(/grid-column:\s*2/);
    expect(timeline).toMatch(
      /\.vt-movement-card__content > \.vt-shape,[\s\S]*?grid-column:\s*3/,
    );
    expect(rule(".vt-movement-card__positions")).toMatch(/grid-column:\s*2 \/ -1/);
  });

  it("shows sound parameters as knobs and mix levels as monochrome vertical meters", () => {
    expect(rule(".vt-shape--scalar")).toMatch(/display:\s*inline-flex/);
    expect(rule(".vt-scalar__knob")).toMatch(/width:\s*78px/);
    expect(rule(".vt-scalar__knob-travel")).toMatch(/stroke:/);
    expect(rule(".vt-scalar__knob-hand.is-from")).toMatch(/stroke-dasharray:/);
    expect(rule(".vt-scalar__knob-hand.is-to")).toMatch(/stroke-width:\s*3/);
    expect(rule(".vt-scalar__meter")).toMatch(/grid-template-rows:\s*auto 104px auto/);
    expect(rule(".vt-scalar__meter-rail")).toMatch(/height:\s*104px/);
    expect(rule(".vt-scalar__meter-comparison")).toMatch(/display:\s*flex/);
    expect(rule(".vt-scalar__meter-fill.is-after")).toMatch(/var\(--paper-strong\)/);
    expect(timeline).toMatch(/\.vt-scalar__meter-change\s*\{\s*z-index:[\s\S]*?min-height:\s*6px/);
    expect(timeline).not.toContain(".vt-scalar__track");
  });

  it("draws captured frequencies on a logarithmic Hz scale", () => {
    expect(rule(".vt-shape--frequency")).toMatch(/display:\s*grid/);
    expect(rule(".vt-frequency__scale")).toMatch(/position:\s*relative/);
    expect(rule(".vt-frequency__range")).toMatch(/position:\s*absolute/);
    expect(rule(".vt-frequency__marker.is-before")).toMatch(/background:\s*var\(--faint-aa\)/);
    expect(rule(".vt-frequency__marker.is-after")).toMatch(/background:\s*var\(--paper-strong\)/);
  });

  it("separates song position and expandable raw evidence from the result", () => {
    const positions = rule(".vt-movement-card__positions");
    expect(positions).toMatch(/border-top:/);
    expect(positions).toMatch(/grid-template-columns:/);
    expect(rule(".vt-movement-card__evidence > ol")).toMatch(/display:\s*grid/);
    expect(rule(".vt-movement-card__evidence-detail")).toMatch(/font-size:\s*var\(--t-meta\)/);
  });

  it("uses one static reading highlight while preserving a keyboard focus ring", () => {
    expect(rule(".vt-movement-card")).not.toMatch(/transition:/);
    expect(rule(".vt-movement-card:focus-within")).toMatch(/outline:\s*2px solid var\(--signal\)/);
    expect(timeline).not.toMatch(/\.vt-movement-card:hover[\s\S]*?translateY/);
    expect(rule(".vt-movement-card")).toMatch(/opacity:\s*var\(--vt-scroll-opacity, 1\)/);
    const active = rule('.vt-movement-card[data-timeline-active="true"]');
    expect(active).toMatch(/border-color:\s*rgb\(var\(--signal-rgb\) \/ 0\.72\)/);
    expect(active).toMatch(/inset 3px 0 0 var\(--signal\)/);
  });

  it("keeps long-sitting navigation out of the timeline card lane", () => {
    expect(timeline).not.toMatch(/\.vt-navigator/);
    expect(timeline).not.toMatch(/\.vt-jumpbar/);
    expect(rule(".vt-trail-layout")).toMatch(/grid-template-columns:\s*minmax\(0, 1fr\) 164px/);
    expect(rule(".vt-location")).toMatch(/position:\s*sticky/);
    expect(timeline).not.toMatch(/Jump to a movement in this timeline/);
  });

  it("does not turn the after state of a mode into a badge or headline", () => {
    const after = rule(".vt-enum__is");
    expect(after).toMatch(/font-weight:\s*400/);
    expect(after).not.toMatch(/background:/);
    expect(after).not.toMatch(/border:/);
  });

  it("does not give set administration a misleading song position", () => {
    const screen = readFileSync(
      fileURLToPath(new URL("./VersionTimelineScreen.tsx", import.meta.url)),
      "utf8",
    );
    expect(screen).toMatch(/isSetAdministration[\s\S]*?\btrack\|device\b/);
    expect(screen).toMatch(/showTopLevelPositions = showSongPositions && !isSetAdministration/);
  });

  it("uses icon luminance rather than category colour or pill badges", () => {
    expect(timeline).not.toMatch(/data-work-kind=["'][^"']+["']\]\s*\{[^}]*--vt-card-accent/);
    expect(timeline).toMatch(
      /\.vt-movement-card__kind,\s*\.vt-movement-card__shape-badge\s*\{[^}]*border:\s*0/,
    );
    expect(timeline).toMatch(
      /\.vt-movement-card__icon\.is-midi,\s*\.vt-movement-card__icon\.is-clip\s*\{[^}]*color:\s*var\(--paper-strong\)/,
    );
    expect(timeline).toMatch(
      /\.vt-movement-card__icon\.is-structure,\s*\.vt-movement-card__icon\.is-moment\s*\{[^}]*color:\s*var\(--muted\)/,
    );
  });

  it("draws MIDI before and after on one shared pitch scale", () => {
    expect(rule(".vt-midi-scale__row")).toMatch(/display:\s*grid/);
    expect(rule(".vt-midi-scale__lane")).toMatch(/repeating-linear-gradient/);
    expect(rule(".vt-midi-scale__bar.is-before")).toMatch(/border:/);
    expect(rule(".vt-midi-scale__bar.is-after")).toMatch(/background:\s*var\(--paper-strong\)/);
  });

  it("draws exact MIDI notes across pitch and beat when the snapshot exists", () => {
    expect(rule(".vt-midi-pattern__row svg")).toMatch(
      /height:\s*clamp\(176px,\s*13vw,\s*232px\)/,
    );
    expect(rule(".vt-midi-roll__key.is-white")).toMatch(/fill:/);
    expect(rule(".vt-midi-roll__key.is-black")).toMatch(/fill:/);
    expect(rule(".vt-midi-roll__note.is-before")).toMatch(/stroke:/);
    expect(rule(".vt-midi-roll__note.is-after")).toMatch(/fill:/);
    expect(rule(".vt-midi-note-list li")).toMatch(/flex-wrap:\s*wrap/);
  });
});

// ── Scroll cost, everywhere a long list is rendered ────────────────────────
//
// The report banned transitioned box-shadows because the compositor cannot
// animate one — every frame repaints the element. That rule was scoped to the
// report stylesheet, so when the Timeline grew a card list it reintroduced the
// same bug, plus `will-change: transform` on a row that renders about 400 times
// in one version. Both are only a problem at volume, which is exactly when
// nobody is looking at the stylesheet.
const LIST_HEAVY_STYLESHEETS = [
  "./SessionRecapScreen.css",
  "./VersionTimelineScreen.css",
  "./ProjectHistoryScreen.css",
  "../../components/schema/SchemaTimeline.css",
];

describe("long lists · scroll cost", () => {
  it.each(LIST_HEAVY_STYLESHEETS)("never transitions box-shadow in %s", (relative) => {
    const sheet = readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "");
    const offenders = [...sheet.matchAll(/transition:[^;]*box-shadow[^;]*;/g)].map((m) => m[0]);
    expect(offenders).toEqual([]);
  });

  it.each(LIST_HEAVY_STYLESHEETS)("does not promote repeated rows to layers in %s", (relative) => {
    // `will-change` is for the one element about to animate. On a list item it
    // multiplies by the row count: 400 rows, 400 compositor layers.
    const sheet = readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "");
    const offenders = [...sheet.matchAll(/will-change:\s*(?!auto)[^;]+;/g)].map((m) => m[0]);
    expect(offenders).toEqual([]);
  });
});
