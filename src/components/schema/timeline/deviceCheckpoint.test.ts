import { describe, expect, it } from "vitest";
import type { ParameterObj } from "../../../types/schema";
import { checkpointValue, flattenCheckpointParameters } from "./deviceCheckpoint";

function parameter(overrides: Partial<ParameterObj> = {}): ParameterObj {
  return {
    id: "p1",
    device_id: "d1",
    parent_parameter_id: null,
    name: "Arp",
    value: 0,
    display_value: null,
    initial_value: 0,
    initial_display_value: null,
    default_value: null,
    unit: null,
    min: 0,
    max: 1,
    normalized_value: 0,
    is_quantized: true,
    value_items: ["Off", "On"],
    automation_state: 0,
    state: 0,
    is_enabled: true,
    children: [],
    ...overrides,
  };
}

describe("device checkpoints", () => {
  it("prefers Live's own readable value", () => {
    expect(checkpointValue(parameter(), 1, "Enabled")).toBe("Enabled");
  });

  it("resolves an enum label when an older checkpoint lacks display text", () => {
    expect(checkpointValue(parameter(), 1, null)).toBe("On");
  });

  it("flattens nested device parameters without losing their order", () => {
    const child = parameter({ id: "child", name: "Rate" });
    const parent = parameter({ id: "parent", children: [child] });
    expect(flattenCheckpointParameters([parent]).map((item) => item.id)).toEqual([
      "parent",
      "child",
    ]);
  });
});
