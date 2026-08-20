import { describe, expect, it } from "vitest";
import { memoryCable } from "./memoryCable";

describe("memoryCable", () => {
  it("plugs into the left edge when the card is beside the gesture", () => {
    const cable = memoryCable(100, 80, 130, 40, 260, 76);
    expect(cable.anchorX).toBe(130);
    expect(cable.anchorY).toBe(80);
    expect(cable.path).toMatch(/^M 100 80 C /);
  });

  it("plugs into the top when the card overlaps horizontally below the gesture", () => {
    const cable = memoryCable(200, 30, 120, 60, 260, 76);
    expect(cable.anchorX).toBe(200);
    expect(cable.anchorY).toBe(60);
  });

  it("keeps the receiving jack away from rounded card corners", () => {
    const cable = memoryCable(100, -20, 90, 40, 260, 76);
    expect(cable.anchorX).toBe(102);
    expect(cable.anchorY).toBe(40);
  });
});
