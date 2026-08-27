import { describe, expect, it } from "vitest";
import type { NoteEdit, ParameterChange, TimelineClipEvent } from "../../types/schema";
import {
  describeGap,
  sessionSteps,
  STEP_CONTROL_LIMIT,
  STEP_TRACK_LIMIT,
} from "./sessionSteps";

const minute = 60 * 1000;
const start = 1_720_000_000_000;

function change(over: Partial<ParameterChange> = {}): ParameterChange {
  return {
    id: `p${Math.random()}`,
    event_type: "parameter_changed",
    parameter_id: null,
    track_name: "Drums",
    track_id: "t1",
    device_id: "d1",
    device_name: "Serum",
    parameter_name: "Cutoff",
    before_value: 0,
    after_value: 1,
    before_value_percent: null,
    after_value_percent: null,
    unit: null,
    before_display_value: "200 Hz",
    after_display_value: "4.2 kHz",
    is_quantized: null,
    reason: null,
    automation_start_ms: null,
    automation_start_position: null,
    automation_end_position: null,
    changed_at_ms: start,
    ...over,
  };
}

function note(over: Partial<NoteEdit> = {}): NoteEdit {
  return {
    id: `n${Math.random()}`,
    track_name: "Bass",
    track_id: "t2",
    clip_name: "Verse",
    clip_id: "c1",
    change_kind: null,
    note_count: 8,
    previous_note_count: 4,
    distinct_pitches: 3,
    pitch_min: null,
    pitch_max: null,
    previous_pitch_min: null,
    previous_pitch_max: null,
    pitch_range: null,
    previous_pitch_range: null,
    velocity_mean: null,
    length_beats: null,
    summary: "Added 4 notes",
    changed_at_ms: start,
    ...over,
  };
}

const noClips: TimelineClipEvent[] = [];

describe("sessionSteps", () => {
  it("turns captured work into steps in the order it happened", () => {
    const steps = sessionSteps(
      [
        change({ changed_at_ms: start }),
        change({ changed_at_ms: start + minute }),
        // A long pause, which is where one step ends and the next begins.
        change({ changed_at_ms: start + 90 * minute, parameter_name: "Resonance" }),
      ],
      [],
      noClips,
      start,
    );
    expect(steps.length).toBeGreaterThan(1);
    for (let index = 1; index < steps.length; index += 1) {
      expect(steps[index]!.startMs).toBeGreaterThanOrEqual(steps[index - 1]!.startMs);
    }
  });

  it("carries where a control started and where it was left", () => {
    // The landing point is the decision. A count alone cannot tell a nudge
    // from searching the whole range and committing.
    const steps = sessionSteps([change(), change()], [], noClips, start);
    const control = steps[0]!.controls[0]!;
    expect(control.from).toBe("200 Hz");
    expect(control.to).toBe("4.2 kHz");
  });

  it("names the track a control lives on", () => {
    // A step can span tracks while its title names only the busiest, so a
    // control listed underneath has to say where it is.
    const steps = sessionSteps([change({ track_name: "Drums" })], [], noClips, start);
    expect(steps[0]!.controls[0]!.track).toBe("Drums");
  });

  it("caps the controls it lists and reports how many are left", () => {
    const many = Array.from({ length: STEP_CONTROL_LIMIT + 3 }, (_, index) =>
      change({ parameter_name: `Knob ${index}`, changed_at_ms: start + index * 1000 }),
    );
    const steps = sessionSteps(many, [], noClips, start);
    const step = steps[0]!;
    expect(step.controls.length).toBeLessThanOrEqual(STEP_CONTROL_LIMIT);
    if (step.moreControls > 0) {
      expect(step.controls).toHaveLength(STEP_CONTROL_LIMIT);
    }
  });

  it("caps the tracks it names", () => {
    const many = Array.from({ length: STEP_TRACK_LIMIT + 4 }, (_, index) =>
      change({
        track_name: `Track ${index}`,
        track_id: `t${index}`,
        changed_at_ms: start + index * 1000,
      }),
    );
    const steps = sessionSteps(many, [], noClips, start);
    for (const step of steps) {
      expect(step.tracks.length).toBeLessThanOrEqual(STEP_TRACK_LIMIT);
    }
  });

  it("counts note edits as work, not only control moves", () => {
    const steps = sessionSteps([], [note(), note()], noClips, start);
    expect(steps.length).toBeGreaterThan(0);
    expect(steps.some((step) => step.noteEdits > 0)).toBe(true);
  });

  it("gives every step a title in the producer's language", () => {
    const steps = sessionSteps([change(), change()], [note()], noClips, start);
    for (const step of steps) {
      expect(step.title.length).toBeGreaterThan(0);
      // Nothing from the model's own vocabulary reaches a producer (§10).
      expect(step.title.toLowerCase()).not.toContain("passage");
      expect(step.title.toLowerCase()).not.toContain("event");
    }
  });

  it("returns nothing for a session with no captured work", () => {
    expect(sessionSteps([], [], noClips, start)).toEqual([]);
  });
});

describe("describeGap", () => {
  it("says minutes, hours and days as a producer would", () => {
    expect(describeGap(20 * minute)).toBe("20m later");
    expect(describeGap(3 * 60 * minute)).toBe("3h later");
    expect(describeGap(50 * 60 * minute)).toBe("2d later");
  });
});
