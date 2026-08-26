import { describe, expect, it } from "vitest";
import { compareSchemas, countDevices, diffIsEmpty } from "./versionDiff";
import type { DeviceObj, ProjectSchema, TrackObj } from "../../types/schema";

function device(name: string, index = 0): DeviceObj {
  return {
    id: `device-${name}-${index}`,
    track_id: "",
    ableton_id: null,
    name,
    role: "audio_effect",
    chain_index: index,
    enabled: true,
    initial_enabled: true,
    host_parameter_count: 0,
    class_name: null,
    preset_name: null,
    rack: null,
    parameters: [],
  };
}

function track(name: string, devices: DeviceObj[] = [], number = 1): TrackObj {
  return {
    id: `track-${name}`,
    ableton_id: null,
    name,
    number,
    type: "audio",
    color: null,
    group_id: null,
    chain_index: number,
    devices,
  };
}

function schema(tracks: TrackObj[]): ProjectSchema {
  return { session_id: "s", name: "Set", has_snapshot: true, tracks };
}

describe("compareSchemas", () => {
  it("reports no changes for identical structures", () => {
    const a = schema([track("Bass", [device("Serum 2"), device("Saturator")])]);
    const b = schema([track("Bass", [device("Serum 2"), device("Saturator")])]);
    expect(diffIsEmpty(compareSchemas(a, b))).toBe(true);
  });

  it("detects added and removed tracks by name", () => {
    const before = schema([track("Bass"), track("Drums")]);
    const after = schema([track("Bass"), track("Pad 3")]);
    const diff = compareSchemas(before, after);
    expect(diff.addedTracks).toEqual(["Pad 3"]);
    expect(diff.removedTracks).toEqual(["Drums"]);
  });

  it("detects device changes on a matched track, tolerating duplicates", () => {
    const before = schema([track("Bass", [device("Serum 2"), device("Saturator")])]);
    const after = schema([
      track("Bass", [device("Serum 2"), device("Saturator"), device("Saturator", 1), device("Reverb")]),
    ]);
    const diff = compareSchemas(before, after);
    expect(diff.addedDevices).toEqual([
      { device: "Saturator", track: "Bass" },
      { device: "Reverb", track: "Bass" },
    ]);
    expect(diff.removedDevices).toEqual([]);
  });

  it("does not double-report devices on an added track", () => {
    const before = schema([]);
    const after = schema([track("Lead", [device("Operator")])]);
    const diff = compareSchemas(before, after);
    expect(diff.addedTracks).toEqual(["Lead"]);
    expect(diff.addedDevices).toEqual([]);
  });

  it("falls back to track numbers for unnamed tracks", () => {
    const before = schema([]);
    const after = schema([track("", [], 4)]);
    expect(compareSchemas(before, after).addedTracks).toEqual(["Track 4"]);
  });
});

describe("countDevices", () => {
  it("sums devices across tracks", () => {
    const value = schema([
      track("Bass", [device("Serum 2")]),
      track("Drums", [device("Drum Rack"), device("Glue Compressor")]),
    ]);
    expect(countDevices(value)).toBe(3);
  });
});
