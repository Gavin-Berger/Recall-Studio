import { describe, it, expect } from "vitest";
import { buildCreativeTimeline } from "./creativeTimeline";
import type { RecallEventType, RecallTimelineMoment } from "../../types/recall";

let seq = 0;
function moment(
  overrides: Partial<RecallTimelineMoment> & {
    type: RecallEventType;
    rawEventType: string;
  },
): RecallTimelineMoment {
  seq += 1;
  return {
    id: `e-${seq}`,
    timestamp: 1_710_000_000_000 + seq,
    sessionTimecode: "00:00:00",
    summary: "",
    timelineRole: "creative",
    ...overrides,
  };
}

const rawTypes = (events: RecallTimelineMoment[]) =>
  events.map((e) => e.rawEventType);

describe("buildCreativeTimeline — device chain de-duplication", () => {
  it("drops the chain-change echo that follows a device add on the same track", () => {
    const base = 1_710_000_100_000;
    const added = moment({
      type: "device",
      rawEventType: "device_added",
      trackName: "Bass",
      deviceName: "Serum 2",
      timestamp: base,
      metadata: { track: "Bass", device: "Serum 2", deviceChain: "Serum 2" },
    });
    const chain = moment({
      type: "device",
      rawEventType: "device_chain_changed",
      trackName: "Bass",
      timestamp: base + 5, // same tick
      metadata: { track: "Bass", deviceChain: "Serum 2" },
    });

    const out = buildCreativeTimeline([added, chain]);
    expect(rawTypes(out)).toEqual(["device_added"]);
  });

  it("keeps a standalone chain rework (no recent add/remove)", () => {
    const chain = moment({
      type: "device",
      rawEventType: "device_chain_changed",
      trackName: "Bass",
      metadata: { track: "Bass", deviceChain: "Serum 2 : Saturator" },
    });
    const out = buildCreativeTimeline([chain]);
    expect(rawTypes(out)).toEqual(["device_chain_changed"]);
  });

  it("keeps a chain change on a different track than the recent add", () => {
    const base = 1_710_000_200_000;
    const added = moment({
      type: "device",
      rawEventType: "device_added",
      trackName: "Bass",
      timestamp: base,
      metadata: { track: "Bass", device: "Serum 2" },
    });
    const chainElsewhere = moment({
      type: "device",
      rawEventType: "device_chain_changed",
      trackName: "Drums",
      timestamp: base + 5,
      metadata: { track: "Drums", deviceChain: "Drum Buss" },
    });
    const out = buildCreativeTimeline([added, chainElsewhere]);
    expect(rawTypes(out)).toEqual(["device_added", "device_chain_changed"]);
  });

  it("keeps a chain change that lands well after the add (window expired)", () => {
    const base = 1_710_000_300_000;
    const added = moment({
      type: "device",
      rawEventType: "device_added",
      trackName: "Bass",
      timestamp: base,
      metadata: { track: "Bass", device: "Serum 2" },
    });
    const laterChain = moment({
      type: "device",
      rawEventType: "device_chain_changed",
      trackName: "Bass",
      timestamp: base + 30_000, // 30s later — a deliberate later rework
      metadata: { track: "Bass", deviceChain: "Serum 2 : Saturator" },
    });
    const out = buildCreativeTimeline([added, laterChain]);
    expect(rawTypes(out)).toEqual(["device_added", "device_chain_changed"]);
  });
});

describe("buildCreativeTimeline — keeps the timeline clean", () => {
  it("hides transport spam and heartbeats but keeps the creative move", () => {
    const base = 1_710_000_400_000;
    const events: RecallTimelineMoment[] = [
      moment({ type: "heartbeat", rawEventType: "heartbeat", timelineRole: "debug", timestamp: base }),
      moment({ type: "transport", rawEventType: "transport_play", timelineRole: "transport", timestamp: base + 1, metadata: { playing: true } }),
      moment({ type: "transport", rawEventType: "transport_snapshot", timelineRole: "context", timestamp: base + 2, metadata: { playing: true } }),
      moment({ type: "transport", rawEventType: "transport_stop", timelineRole: "transport", timestamp: base + 3, metadata: { playing: false } }),
      moment({
        type: "device",
        rawEventType: "device_added",
        trackName: "Bass",
        deviceName: "Serum 2",
        timestamp: base + 4,
        metadata: { track: "Bass", device: "Serum 2" },
      }),
    ];

    const out = buildCreativeTimeline(events);
    expect(rawTypes(out)).toEqual(["device_added"]);
  });

  it("keeps a full creative sequence: add track, rename, add device", () => {
    const base = 1_710_000_500_000;
    const events: RecallTimelineMoment[] = [
      moment({ type: "track", rawEventType: "track_created", trackName: "1-MIDI", timestamp: base, metadata: { track: "1-MIDI" } }),
      moment({ type: "track", rawEventType: "track_name_changed", trackName: "Bass", timestamp: base + 10, metadata: { track: "Bass" } }),
      moment({ type: "track", rawEventType: "track_selected", trackName: "Bass", timelineRole: "creative", timestamp: base + 20, metadata: { track: "Bass" } }),
      moment({ type: "device", rawEventType: "device_added", trackName: "Bass", deviceName: "Serum 2", timestamp: base + 30, metadata: { track: "Bass", device: "Serum 2" } }),
    ];

    const out = buildCreativeTimeline(events);
    // track_selected is navigation and is dropped; the three creative moves remain.
    expect(rawTypes(out)).toEqual([
      "track_created",
      "track_name_changed",
      "device_added",
    ]);
  });
});
