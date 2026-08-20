import { describe, expect, it } from "vitest";
import { activityPhrasePath } from "./activityPhrase";

describe("activityPhrasePath", () => {
  it("returns no shape without gestures", () => {
    expect(activityPhrasePath([], 20, 400)).toBeNull();
  });

  it("gives a single gesture a visible phrase width", () => {
    const path = activityPhrasePath([100], 20, 400);
    expect(path).toContain("M92");
    expect(path).toContain("108");
    expect(path).toMatch(/Z$/);
  });

  it("keeps phrase geometry inside the canvas", () => {
    const path = activityPhrasePath([1, 199], 20, 200);
    expect(path).not.toMatch(/M-/);
    expect(path).not.toContain("204");
  });

  it("makes repeated gestures thicker than one gesture", () => {
    const one = activityPhrasePath([100], 20, 400) ?? "";
    const many = activityPhrasePath([100, 100, 100, 100], 20, 400) ?? "";
    expect(one).not.toEqual(many);
  });
});
