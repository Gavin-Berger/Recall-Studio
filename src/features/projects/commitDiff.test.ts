import { describe, expect, it } from "vitest";
import type { DeviceObj, ProjectSchema, TrackObj } from "../../types/schema";
import { commitDiff, diffHeadline, diffLines, DIFF_LIMIT } from "./commitDiff";
import { compareSchemas } from "./versionDiff";

function device(name: string): DeviceObj {
  return {
    id: `dev-${name}`,
    track_id: "t",
    ableton_id: name,
    name,
    role: "audio_effect",
    chain_index: 0,
    enabled: true,
    initial_enabled: true,
    host_parameter_count: 0,
    class_name: null,
    preset_name: null,
    parameters: [],
    rack: null,
  };
}

function track(name: string, devices: string[] = []): TrackObj {
  return {
    id: `track-${name}`,
    ableton_id: name,
    name,
    number: 1,
    type: "midi",
    color: null,
    group_id: null,
    chain_index: 0,
    devices: devices.map(device),
  };
}

function schema(tracks: TrackObj[], hasSnapshot = true): ProjectSchema {
  return { session_id: "s", name: "nightfall", has_snapshot: hasSnapshot, signature_numerator: 4, signature_denominator: 4, meter_changed: false, tracks };
}

describe("commitDiff", () => {
  it("says nothing for the first work Recall captured", () => {
    expect(commitDiff(null, schema([track("Drums")]), false)).toEqual({ status: "root" });
  });

  it("refuses to claim anything when a snapshot is missing", () => {
    // "Cannot say" and "nothing changed" are different facts and must not look
    // alike. Reporting no-change on an absent snapshot is a confident claim on
    // top of nothing.
    expect(commitDiff(schema([], false), schema([track("Drums")]), true)).toEqual({
      status: "unknown",
    });
    expect(commitDiff(schema([track("Drums")]), schema([], false), true)).toEqual({
      status: "unknown",
    });
    expect(commitDiff(null, schema([track("Drums")]), true)).toEqual({ status: "unknown" });
  });

  it("reports an unchanged structure as unchanged, not as unknown", () => {
    const before = schema([track("Drums", ["EQ Eight"])]);
    const after = schema([track("Drums", ["EQ Eight"])]);
    expect(commitDiff(before, after, true)).toEqual({ status: "unchanged" });
  });

  it("reports what arrived", () => {
    const before = schema([track("Drums")]);
    const after = schema([track("Drums", ["Saturator"]), track("Bass")]);
    const result = commitDiff(before, after, true);
    expect(result.status).toBe("changed");
    if (result.status !== "changed") return;
    expect(result.diff.addedTracks).toContain("Bass");
    expect(result.diff.addedDevices.map((change) => change.device)).toContain("Saturator");
  });

  it("reports what left", () => {
    const before = schema([track("Drums", ["Saturator"])]);
    const after = schema([track("Drums")]);
    const result = commitDiff(before, after, true);
    expect(result.status).toBe("changed");
    if (result.status !== "changed") return;
    expect(result.diff.removedDevices.map((change) => change.device)).toContain("Saturator");
  });
});

describe("diffLines", () => {
  it("puts additions before removals", () => {
    // A history is read forwards: what a commit BROUGHT is the reason it
    // exists, and what it removed is supporting detail.
    const diff = compareSchemas(
      schema([track("Old"), track("Keep")]),
      schema([track("Keep"), track("New")]),
    );
    const { lines } = diffLines(diff);
    expect(lines[0]!.sign).toBe("+");
    expect(lines[lines.length - 1]!.sign).toBe("−");
  });

  it("names the track a device arrived on", () => {
    const diff = compareSchemas(schema([track("Drums")]), schema([track("Drums", ["Serum"])]));
    const { lines } = diffLines(diff);
    expect(lines[0]).toMatchObject({ sign: "+", label: "Serum", context: "Drums" });
  });

  it("caps the list but reports the true total", () => {
    // A commit that added forty tracks is a number, not a list.
    const many = Array.from({ length: DIFF_LIMIT + 6 }, (_, index) => track(`T${index}`));
    const diff = compareSchemas(schema([]), schema(many));
    const { lines, total } = diffLines(diff);
    expect(lines).toHaveLength(DIFF_LIMIT);
    expect(total).toBe(DIFF_LIMIT + 6);
  });

  it("gives every line a distinct key", () => {
    // The same device name on two tracks is two lines, and React needs to tell
    // them apart.
    const diff = compareSchemas(
      schema([track("A"), track("B")]),
      schema([track("A", ["EQ Eight"]), track("B", ["EQ Eight"])]),
    );
    const { lines } = diffLines(diff);
    expect(new Set(lines.map((line) => line.key)).size).toBe(lines.length);
  });
});

describe("diffHeadline", () => {
  it("counts both directions", () => {
    const diff = compareSchemas(
      schema([track("Gone")]),
      schema([track("New"), track("Also")]),
    );
    expect(diffHeadline(diff)).toBe("2 added · 1 removed");
  });

  it("says only what happened", () => {
    const diff = compareSchemas(schema([]), schema([track("New")]));
    expect(diffHeadline(diff)).toBe("1 added");
  });
});
