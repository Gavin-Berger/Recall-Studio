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
