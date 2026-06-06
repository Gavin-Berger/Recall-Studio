import { describe, it, expect } from "vitest";
import {
  formatProducerMoment,
  isProducerTimelineEvent,
} from "./producerEvents";
import { classifyEvent } from "../lib/classification/classifyEvent";
import type { RecallEventType, RecallTimelineMoment } from "../types/recall";

// Build a RecallTimelineMoment fixture with sensible defaults. Mirrors the shape
// produced by normalizeBackendEvent in App.tsx so these tests exercise the same
// classification/formatting the live timeline uses.
function moment(
  overrides: Partial<RecallTimelineMoment> & {
    type: RecallEventType;
    rawEventType: string;
  },
): RecallTimelineMoment {
  return {
    id: "test-1",
    timestamp: 1_710_000_000_000,
    sessionTimecode: "00:00:00",
    summary: "",
    timelineRole: "creative",
    ...overrides,
  };
}

describe("sample additions", () => {
  it("preserves the actual sample file name dragged from Splice", () => {
    const event = moment({
      type: "clip",
      rawEventType: "sample_added",
      trackName: "Vocals",
      metadata: {
        track: "Vocals",
        sample: "Deep_House_Vocal_120bpm.wav",
        filePath: "C:/Splice/samples/Deep_House_Vocal_120bpm.wav",
      },
    });

    expect(isProducerTimelineEvent(event)).toBe(true);

    const presentation = formatProducerMoment(event);
    expect(presentation.title).toContain("Deep_House_Vocal_120bpm.wav");
    // The sample name is surfaced as a pill so the producer sees it at a glance.
    expect(
      presentation.metadataPills.some(
        (p) => p.label === "Sample" && p.value === "Deep_House_Vocal_120bpm.wav",
      ),
    ).toBe(true);
  });

  it("labels recorded audio (no file) as an audio clip, not a sample", () => {
    const event = moment({
      type: "clip",
      rawEventType: "audio_clip_added",
      trackName: "Guitar",
      metadata: { track: "Guitar" },
    });

    const presentation = formatProducerMoment(event);
    expect(presentation.title.toLowerCase()).toContain("audio clip");
  });

  it("labels a new MIDI clip distinctly", () => {
    const event = moment({
      type: "clip",
      rawEventType: "midi_clip_created",
      trackName: "Bass",
      metadata: { track: "Bass", clip: "Bassline" },
    });

    const presentation = formatProducerMoment(event);
    expect(presentation.title.toLowerCase()).toContain("midi clip");
  });
});

describe("device / plugin additions", () => {
  it("names the plugin when Serum 2 is added", () => {
    const event = moment({
      type: "device",
      rawEventType: "device_added",
      trackName: "Bass",
      deviceName: "Serum 2",
      deviceChain: "Serum 2",
      metadata: { track: "Bass", device: "Serum 2", deviceChain: "Serum 2" },
    });

    expect(isProducerTimelineEvent(event)).toBe(true);
    const presentation = formatProducerMoment(event);
    expect(presentation.title).toContain("Serum 2");
  });
});

describe("track lifecycle", () => {
  it("tracks a rename to 'Bass'", () => {
    const event = moment({
      type: "track",
      rawEventType: "track_name_changed",
      trackName: "Bass",
      metadata: { track: "Bass" },
    });

    expect(isProducerTimelineEvent(event)).toBe(true);
    expect(classifyEvent(event)).toBe("visible");
  });

  it("treats track selection as navigation, not a creative moment", () => {
    const event = moment({
      type: "track",
      rawEventType: "track_selected",
      trackName: "Bass",
      metadata: { track: "Bass" },
    });

    expect(isProducerTimelineEvent(event)).toBe(false);
    expect(classifyEvent(event)).toBe("context");
  });

  it("surfaces created / muted / armed as visible moments", () => {
    for (const rawEventType of [
      "track_created",
      "track_muted",
      "track_soloed",
      "track_armed",
    ]) {
      const event = moment({
        type: "track",
        rawEventType,
        trackName: "Drums",
        metadata: { track: "Drums" },
      });
      expect(isProducerTimelineEvent(event)).toBe(true);
      expect(classifyEvent(event)).toBe("visible");
    }
  });
});

describe("automation", () => {
  it("includes the parameter and owning device/track", () => {
    const event = moment({
      type: "parameter",
      rawEventType: "automation_created",
      trackName: "Lead",
      deviceName: "Serum 2",
      metadata: {
        track: "Lead",
        device: "Serum 2",
        parameter: "Filter Cutoff",
        position: "Bar 12 Beat 1",
      },
    });

    expect(isProducerTimelineEvent(event)).toBe(true);
    expect(classifyEvent(event)).toBe("visible");

    const presentation = formatProducerMoment(event);
    expect(presentation.title).toContain("Filter Cutoff");
    expect(presentation.detail).toContain("Serum 2");
    expect(presentation.detail).toContain("Bar 12 Beat 1");
  });
});

describe("noise filtering", () => {
  it("excludes transport play/stop from the curated timeline", () => {
    const event = moment({
      type: "transport",
      rawEventType: "transport_stop",
      timelineRole: "transport",
      metadata: { playing: false },
    });

    expect(isProducerTimelineEvent(event)).toBe(false);
  });

  it("excludes heartbeats", () => {
    const event = moment({
      type: "heartbeat",
      rawEventType: "heartbeat",
      timelineRole: "debug",
    });

    expect(isProducerTimelineEvent(event)).toBe(false);
  });
});
