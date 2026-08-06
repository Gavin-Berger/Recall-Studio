import { describe, expect, it } from "vitest";
import type { ParameterChange } from "../../types/schema";
import {
  buildSittings,
  cutTracks,
  groupByTrack,
  humanTracks,
  netChanges,
  SITTING_GAP_MS,
  sittingWork,
  splitBySurvival,
  splitTracksBySurvival,
  storyLedger,
  type NetChange,
  type Sitting,
  type StoryActivity,
  type TrackContribution,
} from "./songStory";

function change(over: Partial<ParameterChange>): ParameterChange {
  return {
    id: Math.random().toString(36),
    parameter_id: null,
    track_name: null,
    track_id: null,
    device_name: null,
    parameter_name: null,
    before_value: null,
    after_value: null,
    before_value_percent: null,
    after_value_percent: null,
    unit: null,
    before_display_value: null,
    after_display_value: null,
    is_quantized: null,
    reason: null,
    changed_at_ms: 0,
    ...over,
  };
}

function activity(over: Partial<StoryActivity>): StoryActivity {
  return {
    atMs: 0,
    trackName: null,
    trackId: null,
    deviceName: null,
    role: null,
    trackType: null,
    kind: "move",
    ...over,
  };
}

describe("netChanges", () => {
  it("collapses to earliest before and latest after per param, ranked by count", () => {
    const hp = { track_name: "9-Serum 2", device_name: "EQ Eight", parameter_name: "high-pass" };
    const changes = [
      change({ ...hp, changed_at_ms: 200, before_display_value: "60 Hz", after_display_value: "135 Hz" }),
      change({ ...hp, changed_at_ms: 100, before_display_value: "30 Hz", after_display_value: "60 Hz" }),
      change({ ...hp, changed_at_ms: 150, before_display_value: "48 Hz", after_display_value: "60 Hz" }),
      change({
        track_name: "sub",
        device_name: "Basslane",
        parameter_name: "Freq",
        changed_at_ms: 120,
        before_display_value: "300 Hz",
        after_display_value: "77 Hz",
      }),
    ];

    const net = netChanges(changes);
    expect(net).toHaveLength(2);
    // Most moves first.
    expect(net[0]).toMatchObject({
      trackName: "9-Serum 2",
      paramName: "high-pass",
      beforeDisplay: "30 Hz", // earliest
      afterDisplay: "135 Hz", // latest
      count: 3,
    });
    expect(net[1]).toMatchObject({ trackName: "sub", count: 1 });
  });

  it("drops params that ended where they started (labour, not a result)", () => {
    const net = netChanges([
      change({
        track_name: "12-Serum 2",
        device_name: "Delay",
        parameter_name: "wet",
        before_display_value: "0.0 dB",
        after_display_value: "-6 dB",
        changed_at_ms: 1,
      }),
      change({
        track_name: "12-Serum 2",
        device_name: "Delay",
        parameter_name: "wet",
        before_display_value: "-6 dB",
        after_display_value: "0.0 dB",
        changed_at_ms: 2,
      }),
    ]);
    expect(net).toHaveLength(0);
  });

  it("falls back to raw value + unit when no display string is present", () => {
    const net = netChanges([
      change({ track_name: "sub", parameter_name: "gain", before_value: 0, after_value: 4.96, unit: "dB", changed_at_ms: 1 }),
    ]);
    expect(net[0].beforeDisplay).toBe("0 dB");
    expect(net[0].afterDisplay).toBe("4.96 dB");
  });

  it("skips changes with no track name", () => {
    expect(netChanges([change({ track_name: null, after_display_value: "x" })])).toHaveLength(0);
  });

  it("does not merge two different tracks that share a name", () => {
    // Ableton auto-names a track after its first device, so two separate
    // tracks can both end up called "Serum 2". track_id is what tells them
    // apart; without it they'd wrongly read as one track's before/after chain.
    const net = netChanges([
      change({
        track_name: "Serum 2",
        track_id: "111",
        device_name: "Serum 2",
        parameter_name: "Cutoff",
        changed_at_ms: 1,
        before_display_value: "200 Hz",
        after_display_value: "800 Hz",
      }),
      change({
        track_name: "Serum 2",
        track_id: "222",
        device_name: "Serum 2",
        parameter_name: "Cutoff",
        changed_at_ms: 2,
        before_display_value: "1 kHz",
        after_display_value: "3 kHz",
      }),
    ]);
    expect(net).toHaveLength(2);
    expect(net.map((n) => n.trackId)).toEqual(expect.arrayContaining(["111", "222"]));
    // Each keeps its own before/after — neither absorbed the other's move.
    const byId = new Map(net.map((n) => [n.trackId, n]));
    expect(byId.get("111")).toMatchObject({ beforeDisplay: "200 Hz", afterDisplay: "800 Hz", count: 1 });
    expect(byId.get("222")).toMatchObject({ beforeDisplay: "1 kHz", afterDisplay: "3 kHz", count: 1 });
  });
});

describe("humanTracks", () => {
  it("reads naturally at each size", () => {
    expect(humanTracks([])).toBe("");
    expect(humanTracks(["A"])).toBe("A");
    expect(humanTracks(["A", "B"])).toBe("A and B");
    expect(humanTracks(["A", "B", "C", "D"])).toBe("A, B and 2 more");
  });
});

describe("sittingWork", () => {
  const base: Sitting = {
    id: "s", index: 0, startMs: 0, endMs: 0, activeMs: 0, moveCount: 0, noteEditCount: 0,
    tracksTouched: [], newTracks: [], reworkedTracks: [], kind: "session", label: "a work session",
  };

  it("names new parts brought in and parts reworked", () => {
    expect(sittingWork({ ...base, newTracks: ["Lead"], reworkedTracks: ["sub"], tracksTouched: ["Lead", "sub"] }))
      .toBe("brought in Lead, reworked sub");
  });

  it("says shaped when nothing new was introduced", () => {
    expect(sittingWork({ ...base, reworkedTracks: ["16-Serum 2", "9-Serum 2"], tracksTouched: ["16-Serum 2", "9-Serum 2"] }))
      .toBe("shaped 16-Serum 2 and 9-Serum 2");
  });
});

describe("groupByTrack", () => {
  const hp = { track_name: "Main", device_name: "EQ Eight", parameter_name: "high-pass" };
  it("rolls changes up per track: raw count, distinct devices, net params ranked", () => {
    const changes = [
      change({ ...hp, changed_at_ms: 1, before_display_value: "30 Hz", after_display_value: "60 Hz" }),
      change({ ...hp, changed_at_ms: 2, before_display_value: "60 Hz", after_display_value: "135 Hz" }),
      change({ track_name: "Main", device_name: "Utility", parameter_name: "gain", changed_at_ms: 3, before_display_value: "-2 dB", after_display_value: "0 dB" }),
      // A wiggle that ends where it started: counts toward changeCount, but is not a net param.
      change({ track_name: "Main", device_name: "Glue", parameter_name: "thr", changed_at_ms: 4, before_display_value: "0", after_display_value: "-5" }),
      change({ track_name: "Main", device_name: "Glue", parameter_name: "thr", changed_at_ms: 5, before_display_value: "-5", after_display_value: "0" }),
      change({ track_name: "sub", device_name: "Pro-L", parameter_name: "gain", changed_at_ms: 6, before_display_value: "0", after_display_value: "5" }),
    ];
    const groups = groupByTrack(changes);
    expect(groups.map((g) => g.trackName)).toEqual(["Main", "sub"]); // Main most-worked first
    const main = groups[0];
    expect(main.changeCount).toBe(5); // every move, wiggles included
    expect(main.deviceCount).toBe(3); // EQ Eight, Utility, Glue
    // net params drop the Glue wiggle, keep high-pass (30 → 135) + gain
    expect(main.params.map((p) => p.paramName)).toEqual(["high-pass", "gain"]);
    expect(main.params[0]).toMatchObject({ beforeDisplay: "30 Hz", afterDisplay: "135 Hz", count: 2 });
  });

  it("keeps two same-named tracks as separate entries when track_id differs", () => {
    const changes = [
      change({ track_name: "Serum 2", track_id: "111", device_name: "Serum 2", parameter_name: "Cutoff", changed_at_ms: 1 }),
      change({ track_name: "Serum 2", track_id: "222", device_name: "Serum 2", parameter_name: "Cutoff", changed_at_ms: 2 }),
      change({ track_name: "Serum 2", track_id: "222", device_name: "Serum 2", parameter_name: "Reso", changed_at_ms: 3 }),
    ];
    const groups = groupByTrack(changes);
    expect(groups).toHaveLength(2);
    expect(new Set(groups.map((g) => g.trackKey))).toEqual(new Set(["111", "222"]));
    // Both display the same name — that's correct, they really are two
    // "Serum 2" tracks — but they're not the same entry.
    expect(groups.every((g) => g.trackName === "Serum 2")).toBe(true);
    const byKey = new Map(groups.map((g) => [g.trackKey, g]));
    expect(byKey.get("111")?.changeCount).toBe(1);
    expect(byKey.get("222")?.changeCount).toBe(2);
  });
});

describe("splitTracksBySurvival", () => {
  const g = (trackName: string): TrackContribution => ({
    trackKey: trackName,
    trackName,
    trackId: null,
    changeCount: 1,
    deviceCount: 1,
    params: [],
  });
  it("splits track groups into credited vs cut by the delivered track set", () => {
    const { survived, cut } = splitTracksBySurvival([g("Lead"), g("Pizz Strings")], new Set(["lead"]));
    expect(survived.map((t) => t.trackName)).toEqual(["Lead"]);
    expect(cut.map((t) => t.trackName)).toEqual(["Pizz Strings"]);
  });
  it("credits everything when the current shape is unknown", () => {
    expect(splitTracksBySurvival([g("Lead")], new Set()).cut).toHaveLength(0);
  });
});

describe("splitBySurvival / cutTracks", () => {
  const net = (trackName: string, count: number): NetChange => ({
    trackName,
    trackId: null,
    deviceName: "EQ",
    paramName: "gain",
    beforeDisplay: "0",
    afterDisplay: "1",
    count,
    firstMs: 0,
    lastMs: 0,
  });

  it("credits work on surviving tracks and files removed tracks as labour", () => {
    const recap = [net("Lead", 5), net("Pizz Strings", 3), net("Sub", 2)];
    const current = new Set(["lead", "sub"]); // Pizz Strings was cut from the latest take
    const { survived, cut } = splitBySurvival(recap, current);
    expect(survived.map((n) => n.trackName)).toEqual(["Lead", "Sub"]);
    expect(cut.map((n) => n.trackName)).toEqual(["Pizz Strings"]);
  });

  it("treats everything as survived when the current shape is unknown", () => {
    const recap = [net("Lead", 5)];
    expect(splitBySurvival(recap, new Set()).cut).toHaveLength(0);
    expect(splitBySurvival(recap, new Set()).survived).toHaveLength(1);
  });

  it("rolls cut changes up to one entry per track, most-worked first", () => {
    const cut = [net("Pizz Strings", 3), net("Pizz Strings", 4), net("Old Pad", 10)];
    expect(cutTracks(cut)).toEqual([
      { name: "Old Pad", moves: 10 },
      { name: "Pizz Strings", moves: 7 },
    ]);
  });
});

describe("buildSittings", () => {
  it("reads a same-named track in a later sitting as newly brought in when its track_id differs", () => {
    // Sitting 1 brings in a track named "Serum 2" (track_id "111"). Long gap.
    // Sitting 2 brings in a DIFFERENT track that Ableton also auto-named
    // "Serum 2" (track_id "222"). Without track_id, the name match would read
    // this as reworking the first track; it's actually a new one.
    const sittings = buildSittings([
      activity({ atMs: 0, trackName: "Serum 2", trackId: "111" }),
      activity({ atMs: SITTING_GAP_MS + 1000, trackName: "Serum 2", trackId: "222" }),
    ]);
    expect(sittings).toHaveLength(2);
    expect(sittings[0].newTracks).toEqual(["Serum 2"]);
    expect(sittings[1].newTracks).toEqual(["Serum 2"]);
    expect(sittings[1].reworkedTracks).toEqual([]);
  });

  it("still reads a genuine repeat (same track_id) as reworked", () => {
    const sittings = buildSittings([
      activity({ atMs: 0, trackName: "Serum 2", trackId: "111" }),
      activity({ atMs: SITTING_GAP_MS + 1000, trackName: "Serum 2", trackId: "111" }),
    ]);
    expect(sittings[1].newTracks).toEqual([]);
    expect(sittings[1].reworkedTracks).toEqual(["Serum 2"]);
  });
});

describe("storyLedger", () => {
  it("sums effort across sittings and counts distinct tracks", () => {
    const sittings = buildSittings([
      activity({ atMs: 0, trackName: "A" }),
      activity({ atMs: 1000, trackName: "B" }),
      // A long gap opens a second sitting.
      activity({ atMs: 5 * 60 * 60 * 1000, trackName: "A" }),
    ]);
    const ledger = storyLedger(sittings);
    expect(ledger.sittings).toBe(2);
    expect(ledger.moves).toBe(3);
    expect(ledger.tracksShaped).toBe(2);
    expect(ledger.firstMs).toBe(0);
  });
});
