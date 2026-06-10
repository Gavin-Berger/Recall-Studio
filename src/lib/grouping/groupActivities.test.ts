import { describe, it, expect } from "vitest";
import { groupIntoActivities } from "./groupActivities";
import type { RecallEventType, RecallTimelineMoment } from "../../types/recall";

// Minimal RecallTimelineMoment fixture for grouping tests.
function moment(
  overrides: Partial<RecallTimelineMoment> & {
    type: RecallEventType;
    rawEventType: string;
    timestamp: number;
  },
): RecallTimelineMoment {
  return {
    id: `e-${overrides.timestamp}`,
    sessionTimecode: "00:00:00",
    summary: "",
    timelineRole: "creative",
    ...overrides,
  };
}

describe("activity-block summarization", () => {
  // A tight creative sequence on one track: load a synth, drop a sample, write
  // automation. The block should summarize each of those as its own creative act.
  const base = 1_710_000_000_000;
  const events: RecallTimelineMoment[] = [
    moment({
      type: "track",
      rawEventType: "track_created",
      timestamp: base,
      trackName: "Bass",
      metadata: { track: "Bass" },
    }),
    moment({
      type: "device",
      rawEventType: "device_added",
      timestamp: base + 1_000,
      trackName: "Bass",
      deviceName: "Serum 2",
      metadata: { track: "Bass", device: "Serum 2" },
    }),
    moment({
      type: "clip",
      rawEventType: "sample_added",
      timestamp: base + 2_000,
      trackName: "Bass",
      metadata: { track: "Bass", sample: "Deep_House_Vocal_120bpm.wav" },
    }),
    moment({
      type: "parameter",
      rawEventType: "automation_created",
      timestamp: base + 3_000,
      trackName: "Bass",
      deviceName: "Serum 2",
      metadata: { track: "Bass", device: "Serum 2", parameter: "Filter Cutoff" },
    }),
  ];

  const blocks = groupIntoActivities(events);

  it("groups the tight sequence into a single block on the Bass track", () => {
    expect(blocks).toHaveLength(1);
    expect(blocks[0].primaryTrack).toBe("Bass");
  });

  it("categorizes a device/sample/automation block as sound design", () => {
    // Loading a synth, choosing a sample, and writing automation are all
    // sound-shaping — not arrangement, even though a sample is clip-typed.
    expect(blocks[0].category).toBe("sound_design");
  });

  it("surfaces devices, samples, and automation as distinct analytics", () => {
    const { analytics } = blocks[0];
    expect(analytics.devicesAdded).toContain("Serum 2");
    expect(analytics.samplesAdded).toContain("Deep_House_Vocal_120bpm.wav");
    expect(analytics.automationTargets).toContain("Filter Cutoff");
  });

  it("does not double-count a dropped sample as a created clip", () => {
    const { analytics } = blocks[0];
    expect(analytics.clipsCreated).not.toContain("Deep_House_Vocal_120bpm.wav");
    // The only clip-typed event was the sample, so clipsCreated should be empty.
    expect(analytics.clipsCreated).toHaveLength(0);
  });

  it("does not fold automation into the raw parameter-change count", () => {
    // The only parameter-typed event was automation_created, which is now its
    // own creative act — not a generic tweak.
    expect(blocks[0].analytics.parameterChangeCount).toBe(0);
  });

  it("lists each creative act in the block's key actions", () => {
    const actions = blocks[0].keyActions;
    expect(actions).toContain("Added Serum 2");
    expect(actions).toContain("Dropped in Deep_House_Vocal_120bpm.wav");
    expect(actions).toContain("Automated Filter Cutoff");
  });

  it("writes a producer-readable summary mentioning the sample and automation", () => {
    const { summary } = blocks[0];
    expect(summary).toContain("Deep_House_Vocal_120bpm.wav");
    expect(summary).toContain("Filter Cutoff");
    expect(summary).toContain("Serum 2");
  });
});

describe("activity-block categorization", () => {
  const base = 1_710_010_000_000;

  it("calls a clip-building block 'arrangement'", () => {
    const events: RecallTimelineMoment[] = [0, 1, 2].map((i) =>
      moment({
        type: "clip",
        rawEventType: "midi_clip_created",
        timestamp: base + i * 1_000,
        trackName: "Keys",
        metadata: { track: "Keys", clip: `Idea ${i + 1}` },
      }),
    );
    const [block] = groupIntoActivities(events);
    expect(block.category).toBe("arrangement");
  });

  it("calls a sample-only block 'sound_design', not 'arrangement'", () => {
    // Three Splice drops are sound selection, even though clips are involved.
    const events: RecallTimelineMoment[] = [0, 1, 2].map((i) =>
      moment({
        type: "clip",
        rawEventType: "sample_added",
        timestamp: base + i * 1_000,
        trackName: "Drums",
        metadata: { track: "Drums", sample: `hit_${i + 1}.wav` },
      }),
    );
    const [block] = groupIntoActivities(events);
    expect(block.category).toBe("sound_design");
  });

  it("calls a recording-dominated block 'tracking' and titles it 'Recorded …'", () => {
    const events: RecallTimelineMoment[] = [
      moment({
        type: "clip",
        rawEventType: "clip_recording_started",
        timestamp: base + 1,
        trackName: "Vocals",
        metadata: { track: "Vocals" },
      }),
      moment({
        type: "clip",
        rawEventType: "clip_recording_stopped",
        timestamp: base + 2,
        trackName: "Vocals",
        metadata: { track: "Vocals" },
      }),
    ];
    const [block] = groupIntoActivities(events);
    expect(block.category).toBe("tracking");
    expect(block.title).toBe("Recorded Vocals");
  });
});
