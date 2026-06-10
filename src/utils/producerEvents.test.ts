import { describe, it, expect } from "vitest";
import {
  formatProducerMoment,
  isProducerTimelineEvent,
  categoryForEvent,
  labelForCategory,
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

  it("surfaces freeze / flatten / duplicate readably (not as 'Track selected')", () => {
    const cases: Array<[string, RegExp]> = [
      ["track_frozen", /froze/i],
      ["track_flattened", /flattened/i],
      ["track_duplicated", /duplicated/i],
    ];

    for (const [rawEventType, titlePattern] of cases) {
      const event = moment({
        type: "track",
        rawEventType,
        trackName: "Bass",
        metadata: { track: "Bass" },
      });

      expect(isProducerTimelineEvent(event)).toBe(true);
      expect(classifyEvent(event)).toBe("visible");

      const presentation = formatProducerMoment(event);
      // Regression guard: the track case used to fall through to "Track selected".
      expect(presentation.title).not.toMatch(/selected/i);
      expect(presentation.title).toMatch(titlePattern);
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

  it("excludes transport_snapshot even though it carries the 'context' role", () => {
    // Regression: transport_snapshot resolves to type "transport" but role
    // "context", so it used to slip past the transport filter and render as
    // "Playback stopped". Transport must be rejected regardless of role.
    const event = moment({
      type: "transport",
      rawEventType: "transport_snapshot",
      timelineRole: "context",
      metadata: { playing: false, songTime: 0 },
    });

    expect(isProducerTimelineEvent(event)).toBe(false);
  });
});

describe("scene / clip / device formatting is raw-type aware", () => {
  it("labels scene_created and scene_renamed distinctly from launch", () => {
    const created = formatProducerMoment(
      moment({ type: "scene", rawEventType: "scene_created" }),
    );
    expect(created.title).toMatch(/created a scene/i);
    expect(created.title).not.toMatch(/launched/i);

    const renamed = formatProducerMoment(
      moment({ type: "scene", rawEventType: "scene_renamed" }),
    );
    expect(renamed.title).toMatch(/renamed a scene/i);

    const launched = formatProducerMoment(
      moment({ type: "scene", rawEventType: "scene_launched" }),
    );
    expect(launched.title).toMatch(/launched a scene/i);
  });

  it("labels clip rename/duplicate/move/warp without saying 'Launched'", () => {
    const cases: Array<[string, RegExp]> = [
      ["clip_renamed", /renamed/i],
      ["clip_duplicated", /duplicated/i],
      ["clip_moved", /moved/i],
      ["warp_mode_changed", /warp/i],
    ];
    for (const [rawEventType, pattern] of cases) {
      const presentation = formatProducerMoment(
        moment({
          type: "clip",
          rawEventType,
          trackName: "Drums",
          metadata: { track: "Drums", clip: "Loop 1" },
        }),
      );
      expect(presentation.title).toMatch(pattern);
      expect(presentation.title).not.toMatch(/launched/i);
    }
  });

  it("labels grouping/ungrouping, not 'Group focus changed'", () => {
    const grouped = formatProducerMoment(
      moment({
        type: "group",
        rawEventType: "tracks_grouped",
        groupName: "Drum Bus",
        metadata: { group: "Drum Bus" },
      }),
    );
    expect(grouped.title).toMatch(/grouped/i);
    expect(grouped.title).not.toMatch(/focus/i);

    const ungrouped = formatProducerMoment(
      moment({ type: "group", rawEventType: "track_ungrouped", groupName: "Drum Bus" }),
    );
    expect(ungrouped.title).toMatch(/ungrouped/i);
  });

  it("labels a return track add, not 'Track selected'", () => {
    const event = moment({
      type: "track",
      rawEventType: "return_track_added",
      trackName: "Reverb",
      metadata: { track: "Reverb" },
    });
    expect(isProducerTimelineEvent(event)).toBe(true);
    const presentation = formatProducerMoment(event);
    expect(presentation.title).toMatch(/return track/i);
    expect(presentation.title).not.toMatch(/selected/i);
  });

  it("labels clip recording as recording, not 'Launched'", () => {
    const started = formatProducerMoment(
      moment({
        type: "clip",
        rawEventType: "clip_recording_started",
        trackName: "Vocals",
        metadata: { track: "Vocals" },
      }),
    );
    expect(started.title).toMatch(/started recording/i);
    expect(started.title).not.toMatch(/launched/i);

    const stopped = formatProducerMoment(
      moment({
        type: "clip",
        rawEventType: "clip_recording_stopped",
        trackName: "Vocals",
        metadata: { track: "Vocals" },
      }),
    );
    expect(stopped.title).toMatch(/stopped recording/i);
  });

  it("labels device toggle/preset/macro readably, not 'Worked on'", () => {
    const toggled = formatProducerMoment(
      moment({
        type: "device",
        rawEventType: "device_toggled",
        deviceName: "Reverb",
        metadata: { device: "Reverb" },
      }),
    );
    expect(toggled.title).toMatch(/toggled reverb/i);

    const preset = formatProducerMoment(
      moment({
        type: "device",
        rawEventType: "device_preset_changed",
        deviceName: "Serum 2",
        metadata: { device: "Serum 2" },
      }),
    );
    expect(preset.title).toMatch(/preset/i);
    expect(preset.title).toMatch(/serum 2/i);

    const macro = formatProducerMoment(
      moment({ type: "device", rawEventType: "macro_mapped", deviceName: "Bass Rack" }),
    );
    expect(macro.title).toMatch(/macro/i);
  });
});

describe("producer-facing categories", () => {
  it("surfaces samples as their own 'Sample' category, not 'Clip'", () => {
    expect(categoryForEvent("clip", "sample_added")).toBe("sample");
    expect(categoryForEvent("clip", "audio_clip_added")).toBe("sample");
    expect(labelForCategory("sample")).toBe("Sample");
  });

  it("surfaces automation as its own 'Automation' category, not 'Parameter'", () => {
    expect(categoryForEvent("parameter", "automation_created")).toBe("automation");
    expect(categoryForEvent("parameter", "automation_edited")).toBe("automation");
    expect(labelForCategory("automation")).toBe("Automation");
  });

  it("leaves non-sample clips and non-automation parameters in their base category", () => {
    expect(categoryForEvent("clip", "midi_clip_created")).toBe("clip");
    expect(categoryForEvent("clip", "clip_launched")).toBe("clip");
    expect(categoryForEvent("parameter", "parameter_changed")).toBe("parameter");
  });

  it("falls back to the technical type when no rawEventType is given", () => {
    expect(categoryForEvent("device")).toBe("device");
    expect(categoryForEvent("track")).toBe("track");
  });

  it("a Splice sample moment reports the Sample category end-to-end", () => {
    const presentation = formatProducerMoment(
      moment({
        type: "clip",
        rawEventType: "sample_added",
        trackName: "Vocals",
        metadata: { track: "Vocals", sample: "Deep_House_Vocal_120bpm.wav" },
      }),
    );
    expect(presentation.category).toBe("sample");
    expect(presentation.categoryLabel).toBe("Sample");
  });
});
