import { describe, expect, it } from "vitest";
import type { DeviceObj, ProjectSchema, RackObj, TrackObj } from "../../types/schema";
import { commitRacks, noteName, RACK_CONTENTS_LIMIT } from "./commitRacks";

function device(name: string, rack: RackObj | null): DeviceObj {
  return {
    id: `dev-${name}`,
    track_id: "t1",
    ableton_id: name,
    name,
    role: "instrument",
    chain_index: 0,
    enabled: true,
    initial_enabled: true,
    host_parameter_count: 0,
    class_name: null,
    preset_name: null,
    parameters: [],
    rack,
  };
}

function track(name: string, devices: DeviceObj[]): TrackObj {
  return {
    id: `track-${name}`,
    ableton_id: name,
    name,
    number: 1,
    type: "midi",
    color: null,
    group_id: null,
    chain_index: 0,
    devices,
  };
}

function schema(tracks: TrackObj[]): ProjectSchema {
  return { session_id: "s1", name: "nightfall", has_snapshot: true, tracks };
}

const drumRack: RackObj = {
  chains: [],
  drum_pads: [
    { ableton_id: "p1", name: "Kick", note: 36 },
    { ableton_id: "p2", name: "Snare", note: 38 },
    { ableton_id: "p3", name: "", note: 40 },
  ],
};

const instrumentRack: RackObj = {
  chains: [
    {
      ableton_id: "c1",
      name: "Sub",
      index: 0,
      devices: [
        { ableton_id: "n1", name: "Operator", class_name: null },
        { ableton_id: "n2", name: "Saturator", class_name: null },
      ],
    },
    { ableton_id: "c2", name: null, index: 1, devices: [] },
  ],
  drum_pads: [],
};

describe("commitRacks", () => {
  it("reports what a Drum Rack contains", () => {
    const racks = commitRacks(
      schema([track("13-Drum Rack", [device("Drum Rack", drumRack)])]),
      new Set(["13-Drum Rack"]),
    );
    expect(racks).toHaveLength(1);
    expect(racks[0]!.name).toBe("Drum Rack");
    expect(racks[0]!.contents.map((entry) => entry.label)).toEqual(["Kick", "Snare"]);
  });

  it("names the pad's note the way Ableton does", () => {
    const racks = commitRacks(
      schema([track("13-Drum Rack", [device("Drum Rack", drumRack)])]),
      new Set(["13-Drum Rack"]),
    );
    expect(racks[0]!.contents[0]!.detail).toBe("C1");
  });

  it("skips pads with no name, because an empty pad is not content", () => {
    const racks = commitRacks(
      schema([track("13-Drum Rack", [device("Drum Rack", drumRack)])]),
      new Set(["13-Drum Rack"]),
    );
    expect(racks[0]!.total).toBe(2);
  });

  it("lists a chain's devices, which say more than the chain's name", () => {
    const racks = commitRacks(
      schema([track("Bass", [device("Instrument Rack", instrumentRack)])]),
      new Set(["Bass"]),
    );
    expect(racks[0]!.contents[0]!.label).toBe("Sub");
    expect(racks[0]!.contents[0]!.detail).toBe("Operator › Saturator");
  });

  it("gives an unnamed chain its position rather than a blank", () => {
    const racks = commitRacks(
      schema([track("Bass", [device("Instrument Rack", instrumentRack)])]),
      new Set(["Bass"]),
    );
    expect(racks[0]!.contents[1]!.label).toBe("Chain 2");
  });

  it("prefers pads over chains so a Drum Rack is not listed twice", () => {
    // A Drum Rack's pads ARE its chains. Showing both lists the same thing
    // under two names.
    const both: RackObj = {
      chains: [{ ableton_id: "c1", name: "Kick", index: 0, devices: [] }],
      drum_pads: [{ ableton_id: "p1", name: "Kick", note: 36 }],
    };
    const racks = commitRacks(
      schema([track("Drums", [device("Drum Rack", both)])]),
      new Set(["Drums"]),
    );
    expect(racks[0]!.contents).toHaveLength(1);
    expect(racks[0]!.contents[0]!.detail).toBe("C1");
  });

  it("caps a big rack and reports the true total", () => {
    const big: RackObj = {
      chains: [],
      drum_pads: Array.from({ length: RACK_CONTENTS_LIMIT + 9 }, (_, index) => ({
        ableton_id: `p${index}`,
        name: `Pad ${index}`,
        note: 36 + index,
      })),
    };
    const racks = commitRacks(
      schema([track("Drums", [device("Drum Rack", big)])]),
      new Set(["Drums"]),
    );
    expect(racks[0]!.contents).toHaveLength(RACK_CONTENTS_LIMIT);
    expect(racks[0]!.total).toBe(RACK_CONTENTS_LIMIT + 9);
  });

  it("ignores racks on tracks the commit never touched", () => {
    // A set can hold dozens of racks. A commit that never went near them
    // should not list them.
    const racks = commitRacks(
      schema([
        track("Drums", [device("Drum Rack", drumRack)]),
        track("Bass", [device("Instrument Rack", instrumentRack)]),
      ]),
      new Set(["Bass"]),
    );
    expect(racks.map((rack) => rack.name)).toEqual(["Instrument Rack"]);
  });

  it("ignores a device that is not a rack", () => {
    const racks = commitRacks(
      schema([track("Bass", [device("Serum", null)])]),
      new Set(["Bass"]),
    );
    expect(racks).toEqual([]);
  });

  it("ignores a rack with nothing in it", () => {
    const racks = commitRacks(
      schema([track("Bass", [device("Drum Rack", { chains: [], drum_pads: [] })])]),
      new Set(["Bass"]),
    );
    expect(racks).toEqual([]);
  });

  it("survives having no schema at all", () => {
    expect(commitRacks(null, new Set(["Bass"]))).toEqual([]);
  });
});

describe("noteName", () => {
  it("uses Live's octave numbering, where 60 is C3", () => {
    expect(noteName(60)).toBe("C3");
    expect(noteName(36)).toBe("C1");
    expect(noteName(38)).toBe("D1");
  });

  it("names a sharp", () => {
    expect(noteName(37)).toBe("C#1");
  });

  it("says nothing when Live reported no note", () => {
    expect(noteName(null)).toBeNull();
  });
});
