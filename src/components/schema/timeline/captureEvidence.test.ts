import { describe, expect, it } from "vitest";
import type { SavedSessionEvent } from "../../../types/recall";
import { captureEvidence, rawEventId } from "./captureEvidence";

function event(payload: Record<string, unknown>, over: Partial<SavedSessionEvent> = {}): SavedSessionEvent {
  return {
    id: "42",
    type: "clip_notes_changed",
    timestamp_ms: 1,
    summary: null,
    title: "Notes changed",
    description: "Notes changed",
    source: "control_surface",
    payload: JSON.stringify(payload),
    session_id: "session",
    track: "Bass",
    track_type: "midi",
    device: null,
    device_chain: null,
    parameter: null,
    parameter_value: null,
    previous_parameter_value: null,
    parameter_value_percent: null,
    previous_parameter_value_percent: null,
    parameter_display_value: null,
    previous_parameter_display_value: null,
    parameter_is_quantized: null,
    clip_name: "Bassline",
    sample_name: null,
    file_path: null,
    bpm: null,
    playing: null,
    is_heartbeat: false,
    ...over,
  };
}

describe("captureEvidence", () => {
  it("preserves the MIDI summary Recall already stores", () => {
    const evidence = captureEvidence(event({
      note_count: 12,
      distinct_pitches: 5,
      pitch_range: "C1-G2",
      velocity_mean: 96.7,
      length_beats: 8,
    }));

    expect(evidence?.facts).toEqual(expect.arrayContaining([
      { label: "Notes", value: "12" },
      { label: "Pitch range", value: "C1-G2" },
      { label: "Average velocity", value: "96.7" },
      { label: "Clip length", value: "8 quarter-note beats" },
    ]));
  });

  it("accepts forward automation points, MIDI onsets, and warp markers", () => {
    const automation = captureEvidence(event({
      automation_points: [{ beat: 41, value: 0.2 }, { beat: 49, value: 0.8 }],
    }, { type: "automation_edited" }));
    const midi = captureEvidence(event({
      midi_notes: [{ pitch: 36, start_time: 0, duration: 0.5, velocity: 110, probability: 0.8 }],
    }));
    const warp = captureEvidence(event({ warp_markers: [[0, 0], [4, 1.94]] }, { type: "warp_mode_changed" }));

    expect(automation?.automationPoints).toHaveLength(2);
    expect(midi?.midiNotes[0]).toMatchObject({ pitch: 36, startBeats: 0, durationBeats: 0.5, probability: 0.8 });
    expect(warp?.warpMarkers).toEqual([{ beat: 0, sampleTime: 0 }, { beat: 4, sampleTime: 1.94 }]);
  });

  // The bridge caps each of these reads and reports that it did. Rendering the
  // captured count without the cap turns a partial read into a claim about the
  // whole envelope, pattern, or warp map.
  it("says so when a capped read stopped short of the whole thing", () => {
    const automation = captureEvidence(event({
      automation_points: [{ beat: 0, value: 0.1 }, { beat: 1, value: 0.2 }],
      automation_points_truncated: true,
    }, { type: "automation_edited" }));
    const warp = captureEvidence(event({
      warp_markers: [[0, 0], [4, 1.94]],
      warp_markers_truncated: true,
    }, { type: "warp_mode_changed" }));
    const midi = captureEvidence(event({
      midi_notes: [{ pitch: 36, start_time: 0, duration: 0.5 }],
      midi_notes_truncated: true,
    }));

    expect(automation?.facts).toEqual(expect.arrayContaining([
      { label: "Envelope limit", value: "Showing the first 2 points" },
    ]));
    expect(warp?.facts).toEqual(expect.arrayContaining([
      { label: "Warping limit", value: "Showing the first 2 markers" },
    ]));
    expect(midi?.facts).toEqual(expect.arrayContaining([
      { label: "Pattern limit", value: "Showing the first 1 notes" },
    ]));
  });

  it("claims no limit when the read completed", () => {
    const automation = captureEvidence(event({
      automation_points: [{ beat: 0, value: 0.1 }],
    }, { type: "automation_edited" }));

    expect(automation?.facts.some((fact) => fact.label.endsWith("limit"))).toBe(false);
  });

  it("links normalized rows back to their immutable source event", () => {
    expect(rawEventId("pc::42")).toBe("42");
    expect(rawEventId("note-edit-42")).toBe("42");
    expect(rawEventId("clip-event-42")).toBe("42");
    expect(rawEventId("producer-note")).toBeNull();
  });
});
