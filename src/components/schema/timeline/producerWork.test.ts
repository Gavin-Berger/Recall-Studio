import { describe, expect, it } from "vitest";
import {
  classifyProducerWork,
  dominantProducerWork,
  emptyProducerWorkCounts,
} from "./producerWork";

describe("producer work vocabulary", () => {
  it("classifies concrete Live evidence without guessing from arbitrary plugin names", () => {
    expect(classifyProducerWork({ kind: "midi" })).toBe("writing");
    expect(classifyProducerWork({ kind: "move", deviceName: "Mixer", parameterName: "Volume" })).toBe("mixing");
    expect(classifyProducerWork({ kind: "move", deviceName: "Serum", parameterName: "Cutoff" })).toBe("sound");
    expect(classifyProducerWork({ kind: "clip", eventType: "sample_added" })).toBe("sound");
    expect(classifyProducerWork({ kind: "clip", eventType: "audio_clip_recorded" })).toBe("recording");
    expect(classifyProducerWork({ kind: "memory", eventType: "notes_quantized", memoryCategory: "structure" })).toBe("writing");
    expect(classifyProducerWork({ kind: "memory", eventType: "cue_point_moved", memoryCategory: "structure" })).toBe("arrangement");
    expect(classifyProducerWork({ kind: "memory", eventType: "track_routing_changed", memoryCategory: "structure" })).toBe("mixing");
    expect(classifyProducerWork({ kind: "memory", eventType: "device_added", memoryCategory: "sound" })).toBe("sound");
    expect(classifyProducerWork({ kind: "memory", eventType: "track_created", memoryCategory: "structure" })).toBe("project");
    expect(classifyProducerWork({ kind: "moment" })).toBe("moment");
  });

  it("calls a passage mixed when another observed work area is at least half of the leader", () => {
    const mixed = emptyProducerWorkCounts();
    mixed.sound = 4;
    mixed.writing = 2;
    expect(dominantProducerWork(mixed)).toMatchObject({ kind: "mixed", observed: ["sound", "writing"] });

    const focused = emptyProducerWorkCounts();
    focused.sound = 5;
    focused.writing = 2;
    expect(dominantProducerWork(focused)).toMatchObject({ kind: "sound", observed: ["sound", "writing"] });
  });
});
