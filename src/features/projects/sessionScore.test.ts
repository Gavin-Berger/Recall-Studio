// The arithmetic behind the "work that carried it" bars.
//
// The panel these replaced drew each area as an arc of `count / biggest count`,
// floored at 14%. That produced three numbers a producer could not reconcile
// with anything else on the page: the leader was always a full ring, a tiny area
// never fell below a seventh of the ring, and every area past third place was
// dropped silently. These tests pin the three properties that fix it: share is
// measured against the captured total, the printed percentages total exactly
// 100, and every area that saw work gets named.

import { describe, expect, it } from "vitest";
import { scoreBars, wholePercentages } from "./SessionRecapScreen";
import type { ReportWorkSection } from "./sessionReport";
import type { ProducerWorkKind } from "../../components/schema/timeline/producerWork";

function section(kind: ProducerWorkKind, label: string, sourceEventCount: number): ReportWorkSection {
  return {
    kind,
    label,
    description: "",
    evidenceRule: "",
    decisionCount: sourceEventCount,
    sourceEventCount,
    decisionIds: [],
    evidenceIds: Array.from({ length: sourceEventCount }, (_, index) => `${kind}-${index}`),
  };
}

describe("wholePercentages", () => {
  it("totals exactly 100 when naive rounding would not", () => {
    // 1/3 each rounds to 33, 33, 33 — a column that visibly fails to add up.
    const shares = wholePercentages([1, 1, 1], 3);
    expect(shares.reduce((sum, value) => sum + value, 0)).toBe(100);
    expect(shares).toEqual([34, 33, 33]);
  });

  it("gives the leftover points to the largest fractions, biggest first", () => {
    const shares = wholePercentages([5, 3, 3], 11);
    expect(shares).toEqual([46, 27, 27]);
    expect(shares.reduce((sum, value) => sum + value, 0)).toBe(100);
  });

  it("returns zeroes rather than dividing by nothing", () => {
    expect(wholePercentages([0, 0], 0)).toEqual([0, 0]);
  });
});

describe("scoreBars", () => {
  const sections = [
    section("arrangement", "Arrangement", 8),
    section("sound", "Sound & samples", 7),
    section("mixing", "Mixing", 2),
  ];

  it("measures each area against the captured total, not against the leader", () => {
    const bars = scoreBars(sections);

    // Under the old denominator these were 100 / 88 / 25 — the leader could
    // never be anything but full, so the bar carried no information about it.
    expect(bars.map((bar) => [bar.label, bar.count, bar.percent])).toEqual([
      ["Arrangement", 8, 47],
      ["Sound & samples", 7, 41],
      ["Mixing", 2, 12],
    ]);
    expect(bars.reduce((sum, bar) => sum + bar.percent, 0)).toBe(100);
  });

  it("ranks by captured changes and breaks ties by label", () => {
    const bars = scoreBars([
      section("mixing", "Mixing", 4),
      section("arrangement", "Arrangement", 4),
      section("sound", "Sound & samples", 9),
    ]);

    expect(bars.map((bar) => bar.label)).toEqual(["Sound & samples", "Arrangement", "Mixing"]);
  });

  it("names every area of a full taxonomy rather than summarising most of it", () => {
    // Producer work is seven kinds. A session that touched five of them shows
    // five bars: a folded row that outweighs the named rows below it would make
    // the ranked list look mis-sorted.
    const bars = scoreBars([
      ...sections,
      section("writing", "Writing & ideas", 2),
      section("recording", "Recording & performance", 1),
    ]);

    expect(bars.map((bar) => bar.label)).toEqual([
      "Arrangement",
      "Sound & samples",
      // Mixing and Writing both captured 2; the tie breaks on label.
      "Mixing",
      "Writing & ideas",
      "Recording & performance",
    ]);
    expect(bars.map((bar) => bar.percent)).toEqual([40, 35, 10, 10, 5]);
    expect(bars.reduce((sum, bar) => sum + bar.percent, 0)).toBe(100);
  });

  it("folds the tail into one row once the taxonomy outgrows the bar limit", () => {
    const bars = scoreBars([
      ...sections,
      section("writing", "Writing & ideas", 4),
      section("recording", "Recording & performance", 3),
      section("project", "Project & session", 2),
      section("moment", "Moments", 1),
    ]);

    expect(bars).toHaveLength(7);
    const rest = bars.at(-1)!;
    expect(rest.label).toBe("1 more area");
    expect(rest.count).toBe(1);
    expect(rest.subtitle).toBe("Moments");
    // The folded row stays inspectable: it carries the folded areas' evidence.
    expect(rest.evidenceIds).toHaveLength(1);
    // Still totals the whole session.
    expect(bars.reduce((sum, bar) => sum + bar.percent, 0)).toBe(100);
    expect(bars.reduce((sum, bar) => sum + bar.count, 0)).toBe(27);
  });

  it("says 'areas' in the plural when more than one area is folded away", () => {
    // Today's taxonomy is seven kinds against a limit of six, so only one area
    // can ever fold. This drives the branch that a growing taxonomy would hit,
    // which is the whole reason the limit exists.
    const bars = scoreBars([
      ...sections,
      section("writing", "Writing & ideas", 5),
      section("recording", "Recording & performance", 4),
      section("project", "Project & session", 3),
      section("moment", "First moment", 2),
      section("moment", "Second moment", 1),
    ]);

    expect(bars).toHaveLength(7);
    expect(bars.at(-1)!.label).toBe("2 more areas");
    expect(bars.at(-1)!.count).toBe(3);
    expect(bars.reduce((sum, bar) => sum + bar.percent, 0)).toBe(100);
  });

  it("ignores areas with nothing captured", () => {
    const bars = scoreBars([...sections, section("writing", "Writing & ideas", 0)]);
    expect(bars).toHaveLength(3);
    expect(bars.some((bar) => bar.key === "rest")).toBe(false);
  });

  it("returns nothing at all when no work was captured", () => {
    expect(scoreBars([section("writing", "Writing & ideas", 0)])).toEqual([]);
    expect(scoreBars([])).toEqual([]);
  });
});
