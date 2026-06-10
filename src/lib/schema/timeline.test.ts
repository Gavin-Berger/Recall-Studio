import { describe, expect, it } from "vitest";
import {
  buildSchemaStream,
  formatParameterChange,
  formatValue,
  groupTracksByParent,
} from "./timeline";
import type {
  CreativeMoment,
  ParameterChange,
  ProjectSchema,
  TrackObj,
} from "../../types/schema";

function change(overrides: Partial<ParameterChange>): ParameterChange {
  return {
    id: "pc::1",
    parameter_id: null,
    track_name: "Bass 1",
    device_name: "Synth",
    parameter_name: "Cutoff",
    before_value: null,
    after_value: 0.5,
    unit: null,
    reason: null,
    changed_at_ms: 1_000,
    ...overrides,
  };
}

function moment(overrides: Partial<CreativeMoment>): CreativeMoment {
  return {
    id: "m1",
    session_id: "s1",
    title: "A moment",
    type: "sound_design",
    timeline_start_ms: null,
    timeline_end_ms: null,
    note: null,
    tags: [],
    confidence: "rough",
    created_at_ms: 500,
    updated_at_ms: 500,
    targets: [],
    ...overrides,
  };
}

function track(overrides: Partial<TrackObj>): TrackObj {
  return {
    id: "t1",
    ableton_id: "1",
    name: "Track",
    number: 1,
    type: "audio",
    color: null,
    group_id: null,
    chain_index: 0,
    devices: [],
    ...overrides,
  };
}

describe("buildSchemaStream", () => {
  it("merges changes and moments in chronological order", () => {
    const stream = buildSchemaStream(
      [change({ id: "c-late", changed_at_ms: 3_000 })],
      [moment({ id: "m-mid", timeline_start_ms: 2_000 })],
    );

    expect(stream.map((item) => item.id)).toEqual(["m-mid", "c-late"]);
    expect(stream[0].kind).toBe("moment");
    expect(stream[1].kind).toBe("change");
  });

  it("anchors a moment without a timeline range to its creation time", () => {
    const stream = buildSchemaStream(
      [change({ id: "c1", changed_at_ms: 800 })],
      [moment({ id: "m1", timeline_start_ms: null, created_at_ms: 400 })],
    );
    expect(stream.map((item) => item.id)).toEqual(["m1", "c1"]);
  });
});

describe("formatParameterChange", () => {
  it("renders before → after when both are known", () => {
    expect(
      formatParameterChange(change({ before_value: 0.2, after_value: 0.55 })),
    ).toBe("Cutoff: 0.2 → 0.55");
  });

  it("renders just the arrow + after when the pre-value is unknown", () => {
    expect(formatParameterChange(change({ before_value: null, after_value: 0.2 }))).toBe(
      "Cutoff → 0.2",
    );
  });
});

describe("formatValue", () => {
  it("trims trailing zeros and handles nulls", () => {
    expect(formatValue(1)).toBe("1");
    expect(formatValue(0.5)).toBe("0.5");
    expect(formatValue(null)).toBe("—");
  });
});

describe("groupTracksByParent", () => {
  it("nests member tracks under their group and keeps the rest flat", () => {
    const schema: ProjectSchema = {
      session_id: "s1",
      name: "Session",
      has_snapshot: true,
      tracks: [
        track({ id: "g1", name: "Bass", type: "group" }),
        track({ id: "t1", name: "Bass 1", type: "midi", group_id: "g1" }),
        track({ id: "t2", name: "Vox", type: "audio", group_id: null }),
        track({ id: "r1", name: "Reverb", type: "return", group_id: null }),
      ],
    };

    const { groups, ungrouped } = groupTracksByParent(schema);

    expect(groups).toHaveLength(1);
    expect(groups[0].group.name).toBe("Bass");
    expect(groups[0].children.map((t) => t.name)).toEqual(["Bass 1"]);
    expect(ungrouped.map((t) => t.name)).toEqual(["Vox", "Reverb"]);
  });
});
