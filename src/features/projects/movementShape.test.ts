import { describe, expect, it } from "vitest";
import type { NoteEdit, ParameterChange, TimelineClipEvent } from "../../types/schema";
import type { ProducerMemoryEvent } from "../../components/schema/timeline/eventMemory";
import type { ReportDecision } from "./sessionReport";
import { movementShape } from "./movementShape";

const start = 1_720_000_000_000;

function change(over: Partial<ParameterChange> = {}): ParameterChange {
  return {
    id: "p1",
    event_type: "parameter_changed",
    parameter_id: "filter",
    track_name: "Bass",
    track_id: "t1",
    device_id: "d1",
    device_name: "Serum",
    parameter_name: "Cutoff",
    before_value: 0.1,
    after_value: 0.6,
    before_value_percent: 10,
    after_value_percent: 60,
    unit: null,
    before_display_value: "220 Hz",
    after_display_value: "4.1 kHz",
    is_quantized: false,
    reason: null,
    automation_start_ms: null,
    automation_start_position: null,
    automation_end_position: null,
    changed_at_ms: start,
    ...over,
  };
}

function decision(over: Partial<ReportDecision> = {}): ReportDecision {
  const first = change();
  return {
    id: "d1",
    key: "k",
    kind: "control",
    workKind: "sound",
    atMs: start,
    endMs: start,
    track: "Bass",
    subject: "Serum · Cutoff",
    outcome: "220 Hz → 4.1 kHz",
    count: 1,
    evidenceIds: ["e1"],
    facts: { of: "control", first, last: first },
    ...over,
  };
}

function memory(over: Partial<ProducerMemoryEvent> = {}): ProducerMemoryEvent {
  return {
    id: "m1",
    eventType: "device_toggled",
    atMs: start,
    trackId: "t1",
    trackName: "Bass",
    title: "EQ Eight",
    summary: "Turned off",
    category: "sound",
    observedArrangementPosition: null,
    observedArrangementBeats: null,
    evidence: null,
    ...over,
  };
}

describe("movementShape · a switch is on or off, never 'changed'", () => {
  it("reads Device On as the state it landed in", () => {
    const on = change({
      parameter_name: "Device On",
      before_value: 1,
      after_value: 0,
      before_display_value: "On",
      after_display_value: "Off",
      is_quantized: true,
    });
    const shape = movementShape(decision({ facts: { of: "control", first: on, last: on } }));

    expect(shape).toEqual({ shape: "binary", on: false, from: true, label: "Device On" });
  });

  it("reads a raw 0/1 switch even with no display value", () => {
    const arm = change({
      parameter_name: "Arm",
      before_value: 0,
      after_value: 1,
      before_display_value: null,
      after_display_value: null,
    });
    const shape = movementShape(decision({ facts: { of: "control", first: arm, last: arm } }));

    expect(shape).toMatchObject({ shape: "binary", on: true, from: false });
  });

  it("reads a device-specific Enable parameter as an on-off state", () => {
    const enable = change({
      parameter_name: "Arp Enable",
      before_value: 1,
      after_value: 0,
      before_display_value: "On",
      after_display_value: "Off",
      is_quantized: true,
    });
    const shape = movementShape(decision({ facts: { of: "control", first: enable, last: enable } }));

    expect(shape).toEqual({ shape: "binary", on: false, from: true, label: "Arp Enable" });
  });

  it("reads a device_toggled event as a state, not a sentence", () => {
    const shape = movementShape(
      decision({
        kind: "structure",
        facts: {
          of: "structure",
          eventType: "device_toggled",
          event: memory({ title: "Device bypassed", summary: "EQ Eight on Bass" }),
        },
      }),
    );

    expect(shape).toMatchObject({ shape: "binary", on: false, label: "EQ Eight on Bass" });
  });
});

describe("movementShape · a mode is a choice, not a magnitude", () => {
  it("reads a quantized parameter as one named option replacing another", () => {
    const mode = change({
      parameter_name: "Filter Type",
      is_quantized: true,
      before_display_value: "Sinefold",
      after_display_value: "Ripple",
      before_value_percent: 20,
      after_value_percent: 60,
    });
    const shape = movementShape(decision({ facts: { of: "control", first: mode, last: mode } }));

    // Crucially NOT a scalar: the percentages exist and mean nothing here.
    expect(shape).toEqual({ shape: "enum", from: "Sinefold", to: "Ripple", note: null });
  });

  it("keeps captured option indices when Live omits their names", () => {
    const mode = change({
      parameter_name: "LFO Shape",
      is_quantized: true,
      before_value: 3,
      after_value: 5,
      before_display_value: null,
      after_display_value: null,
    });
    const shape = movementShape(decision({ facts: { of: "control", first: mode, last: mode } }));

    expect(shape).toEqual({
      shape: "enum",
      from: "3",
      to: "5",
      note: "Option names were not captured by Live.",
    });
  });

  it("does not mistake a three-way crossfade assignment for an on-off switch", () => {
    const assignment = change({
      parameter_name: "Crossfade Assign",
      is_quantized: true,
      before_display_value: "A",
      after_display_value: "B",
    });

    expect(movementShape(decision({ facts: { of: "control", first: assignment, last: assignment } })))
      .toEqual({ shape: "enum", from: "A", to: "B", note: null });
  });
});

describe("movementShape · a continuous value has a unit and a direction", () => {
  it("prefers Live's own rendering over the raw number", () => {
    const shape = movementShape(decision());

    expect(shape).toMatchObject({
      shape: "scalar",
      fromLabel: "220 Hz",
      toLabel: "4.1 kHz",
      fromFraction: 0.1,
      toFraction: 0.6,
      rose: true,
    });
  });

  it("carries the gesture's landing place, not its first step", () => {
    const first = change({ before_display_value: "220 Hz", after_display_value: "1 kHz", after_value_percent: 30 });
    const last = change({ before_display_value: "1 kHz", after_display_value: "8 kHz", after_value_percent: 90 });
    const shape = movementShape(decision({ count: 4, facts: { of: "control", first, last } }));

    expect(shape).toMatchObject({ fromLabel: "220 Hz", toLabel: "8 kHz", toFraction: 0.9 });
  });

  it("gives no bar position to an unbounded value rather than inventing one", () => {
    // A frequency in Hz has no 0-1 position. Drawing one states a magnitude
    // that does not exist.
    const hz = change({
      before_value: 220,
      after_value: 4100,
      before_value_percent: null,
      after_value_percent: null,
    });
    const shape = movementShape(decision({ facts: { of: "control", first: hz, last: hz } }));

    expect(shape).toMatchObject({ shape: "scalar", fromFraction: null, toFraction: null, rose: null });
  });

  it("does not invent a percentage merely because a raw value falls between zero and one", () => {
    const tiny = change({
      before_value: 0.1,
      after_value: 0.4,
      before_value_percent: null,
      after_value_percent: null,
      before_display_value: "0.10 dB",
      after_display_value: "0.40 dB",
    });

    expect(movementShape(decision({ facts: { of: "control", first: tiny, last: tiny } })))
      .toMatchObject({ shape: "scalar", fromFraction: null, toFraction: null, rose: null });
  });

  it("says the value was not captured rather than drawing an empty bar", () => {
    const blind = change({
      before_display_value: null,
      after_display_value: null,
      before_value: null,
      after_value: null,
      before_value_percent: null,
      after_value_percent: null,
    });
    const shape = movementShape(decision({ facts: { of: "control", first: blind, last: blind } }));

    expect(shape.shape).toBe("text");
  });
});

describe("movementShape · position, structure and set-wide values", () => {
  function clip(over: Partial<TimelineClipEvent> = {}): TimelineClipEvent {
    return {
      id: "c1",
      event_type: "midi_clip_created",
      track_name: "Bass",
      track_id: "t1",
      clip_name: null,
      sample_name: null,
      changed_at_ms: start,
      ...over,
    };
  }

  it("reads a clip with an arrangement range as a span on the beat grid", () => {
    const shape = movementShape(
      decision({
        kind: "clip",
        facts: {
          of: "clip",
          event: clip({ arrangement_start_beats: 16, arrangement_end_beats: 32 }),
        },
      }),
    );

    expect(shape).toEqual({ shape: "span", startBeats: 16, endBeats: 32 });
  });

  it("reads a clip with no range as something that arrived", () => {
    const shape = movementShape(
      decision({
        kind: "clip",
        outcome: "Added MIDI clip",
        facts: { of: "clip", event: clip() },
      }),
    );

    expect(shape).toEqual({ shape: "tree", sign: "+", text: "Added MIDI clip" });
  });

  it("signs structural changes by whether the thing arrived or left", () => {
    const added = movementShape(
      decision({
        kind: "structure",
        facts: { of: "structure", eventType: "device_added", event: memory({ title: "Serum 2" }) },
      }),
    );
    const removed = movementShape(
      decision({
        kind: "structure",
        facts: { of: "structure", eventType: "track_deleted", event: memory({ title: "Old lead" }) },
      }),
    );
    const renamed = movementShape(
      decision({
        kind: "structure",
        facts: { of: "structure", eventType: "track_renamed", event: memory({ title: "Bass" }) },
      }),
    );

    expect(added).toMatchObject({ shape: "tree", sign: "+" });
    expect(removed).toMatchObject({ shape: "tree", sign: "−" });
    expect(renamed).toMatchObject({ shape: "tree", sign: "~" });
    expect(added).toMatchObject({ text: "Turned off" });
  });

  it("reads tempo as a set-wide value, not a track's", () => {
    const shape = movementShape(
      decision({
        kind: "structure",
        track: null,
        facts: {
          of: "structure",
          eventType: "tempo_changed",
          event: memory({ eventType: "tempo_changed", summary: "140 → 142 BPM" }),
        },
      }),
    );

    expect(shape).toEqual({ shape: "global", label: "Tempo", from: "140", to: "142 BPM" });
  });

  it("reads routing as a pair of endpoints", () => {
    const shape = movementShape(
      decision({
        kind: "structure",
        facts: {
          of: "structure",
          eventType: "track_routing_changed",
          event: memory({
            eventType: "track_routing_changed",
            summary: "Bass now feeds Resampling instead of Ext. In",
          }),
        },
      }),
    );

    expect(shape).toEqual({ shape: "endpoints", from: "Ext. In", to: "Resampling" });
  });

  it("does not parse 'Set to 7/8' as a before-and-after transition", () => {
    const shape = movementShape(
      decision({
        kind: "structure",
        track: null,
        facts: {
          of: "structure",
          eventType: "time_signature_changed",
          event: memory({ summary: "Set to 7/8" }),
        },
      }),
    );

    expect(shape).toEqual({ shape: "global", label: "Time signature", from: null, to: "Set to 7/8" });
  });

  it("falls back to the sentence for anything it cannot prove a shape for", () => {
    const shape = movementShape(
      decision({
        kind: "structure",
        facts: {
          of: "structure",
          eventType: "something_new_from_the_bridge",
          event: memory({ summary: "Did a thing" }),
        },
      }),
    );

    expect(shape).toEqual({ shape: "text", text: "Did a thing" });
  });
});

describe("movementShape · MIDI stays a pattern", () => {
  it("hands the whole note edit to the piano roll", () => {
    const edit = { id: "n1", clip_name: "Hook" } as NoteEdit;
    const shape = movementShape(
      decision({ kind: "midi", facts: { of: "midi", edit } }),
    );

    expect(shape).toEqual({ shape: "pattern", edit });
  });
});
