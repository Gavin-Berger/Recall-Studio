import { describe, expect, it } from "vitest";
import { buildActivityScale } from "./activityScale";

describe("buildActivityScale", () => {
  it("gives hours of silence no more width than any other gap", () => {
    const scale = buildActivityScale([
      Date.parse("2026-08-13T11:36:00"),
      Date.parse("2026-08-13T15:19:00"),
      Date.parse("2026-08-13T16:15:00"),
    ]);

    expect(scale.slots).toHaveLength(3);
    expect(scale.fraction(scale.slots[0])).toBeCloseTo(1 / 6);
    expect(scale.fraction(scale.slots[1])).toBeCloseTo(3 / 6);
    expect(scale.fraction(scale.slots[2])).toBeCloseTo(5 / 6);
  });

  it("puts a burst of simultaneous track moves in one activity column", () => {
    const scale = buildActivityScale([1_000, 1_100, 1_800, 2_501]);

    expect(scale.slots).toEqual([1_000, 2_501]);
    expect(scale.fraction(1_800)).toBe(scale.fraction(1_000));
    expect(scale.fraction(2_501)).toBeCloseTo(0.75);
  });

  it("limits ruler labels while retaining the first and last activity", () => {
    const scale = buildActivityScale(Array.from({ length: 20 }, (_, index) => index * 10_000));

    expect(scale.ticks).toHaveLength(5);
    expect(scale.ticks[0].atMs).toBe(0);
    expect(scale.ticks.at(-1)?.atMs).toBe(190_000);
  });
});
