import { describe, expect, it } from "vitest";
import type { CreativeMoment, NoteEdit, ParameterChange, ProjectSchema, TimelineClipEvent } from "../../types/schema";
import type { SavedSession, SavedSessionEvent } from "../../types/recall";
import {
  buildSessionReport,
  compareSessionReports,
  reportInvariants,
  type SessionReportInput,
} from "./sessionReport";

const start = 1_720_000_000_000;

function rawEvent(overrides: Partial<SavedSessionEvent> = {}): SavedSessionEvent {
  return {
    id: "event-1",
    type: "focus_changed",
    timestamp_ms: start,
    summary: null,
    title: "Focus changed",
    description: "Bass",
    source: "control_surface",
    payload: JSON.stringify({ truncated_devices: [] }),
    session_id: "take-2",
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
    clip_name: null,
    sample_name: null,
    file_path: null,
    bpm: null,
    playing: null,
    is_heartbeat: false,
    ...overrides,
  };
}

function session(id = "take-2", events: SavedSessionEvent[] = [rawEvent()]): SavedSession {
  return {
    id,
    name: id,
    project_id: "project-1",
    capture_name: null,
    capture_status: "ended",
    project_name: "Nightdrive",
    project_path: null,
    als_path: `C:\\Music\\Nightdrive\\${id}.als`,
    take_origin: "recorded",
    display_name: id,
    started_at_ms: start,
    ended_at_ms: start + 20 * 60_000,
    last_updated_at_ms: start + 20 * 60_000,
    event_count: events.length,
    creative_event_count: events.filter((event) => !event.is_heartbeat).length,
    heartbeat_count: events.filter((event) => event.is_heartbeat).length,
    events,
  };
}

function schema(sessionId = "take-2"): ProjectSchema {
  return {
    session_id: sessionId,
    name: "Nightdrive",
    has_snapshot: true,
    tracks: [{
      id: "track-1",
      ableton_id: "track-1",
      name: "Bass",
      number: 2,
      type: "midi",
      color: null,
      group_id: null,
      chain_index: 1,
      devices: [],
    }],
  };
}

function change(id: string, atMs: number, before: number, after: number): ParameterChange {
  return {
    id,
    event_type: "parameter_changed",
    parameter_id: "filter",
    track_name: "Bass",
    track_id: "track-1",
    device_name: "Serum",
    parameter_name: "Cutoff",
    before_value: before,
    after_value: after,
    before_value_percent: before * 100,
    after_value_percent: after * 100,
    unit: null,
    before_display_value: `${before * 100}%`,
    after_display_value: `${after * 100}%`,
    is_quantized: false,
    reason: null,
    automation_start_ms: null,
    automation_start_position: null,
    automation_end_position: null,
    changed_at_ms: atMs,
  };
}

function noteEdit(): NoteEdit {
  return {
    id: "midi-1",
    track_name: "Bass",
    track_id: "track-1",
    clip_name: "Hook",
    clip_id: "clip-1",
    change_kind: "notes_added",
    note_count: 8,
    previous_note_count: 4,
    distinct_pitches: 4,
    pitch_min: 36,
    pitch_max: 48,
    previous_pitch_min: 36,
    previous_pitch_max: 43,
    pitch_range: "C1-C2",
    previous_pitch_range: "C1-G1",
    velocity_mean: 92,
    length_beats: 8,
    summary: "8 notes (+4), C1-C2",
    changed_at_ms: start + 120_000,
  };
}

function clipEvent(): TimelineClipEvent {
  return {
    id: "clip-1",
    event_type: "sample_added",
    track_name: "Bass",
    track_id: "track-1",
    clip_name: "Bass texture",
    sample_name: "texture.wav",
    changed_at_ms: start + 180_000,
  };
}

function moment(): CreativeMoment {
  return {
    id: "moment-1",
    session_id: "take-2",
    title: "Keep the bass tone",
    type: "sound_design",
    timeline_start_ms: start + 150_000,
    timeline_end_ms: null,
    note: "The low mids are right here.",
    tags: ["bass"],
    confidence: "keeper",
    created_at_ms: start + 150_000,
    updated_at_ms: start + 150_000,
    targets: [{ target_type: "track", target_id: "track-1" }],
  };
}

function input(overrides: Partial<SessionReportInput> = {}): SessionReportInput {
  return {
    session: session(),
    schema: schema(),
    changes: [
      change("move-1", start + 60_000, 0.1, 0.3),
      change("move-2", start + 90_000, 0.3, 0.42),
    ],
    noteEdits: [noteEdit()],
    clipEvents: [clipEvent()],
    moments: [moment()],
    ...overrides,
  };
}

describe("session report", () => {
  it("turns repeated movements into one decision while preserving each evidence row", () => {
    const report = buildSessionReport(input());

    expect(report.analysis).toMatchObject({
      actionCount: 4,
      controlMoveCount: 2,
      midiEditCount: 1,
      clipEventCount: 1,
      markerCount: 1,
      trackCount: 1,
    });
    expect(report.trust.level).toBe("clear");
    expect(report.ledger.decisionCount).toBe(4);
    expect(report.decisions.find((decision) => decision.kind === "control")).toMatchObject({
      workKind: "sound",
      subject: "Serum · Cutoff",
      outcome: "10% → 42%",
      count: 2,
      evidenceIds: ["move:move-1", "move:move-2"],
    });
    expect(report.tracks.find((track) => track.name === "Bass")).toMatchObject({
      actionCount: 4,
      sourceEventCount: 5,
      moveCount: 2,
      midiCount: 1,
      clipCount: 1,
      controlCount: 1,
      workKinds: ["sound", "writing", "moment"],
    });
    expect(report.workSections.find((section) => section.kind === "sound")).toMatchObject({
      label: "Sound & samples",
      decisionCount: 2,
      sourceEventCount: 3,
    });
    expect(report.workSections.find((section) => section.kind === "recording")).toMatchObject({
      decisionCount: 0,
      sourceEventCount: 0,
    });
    expect(Object.keys(report.evidence)).toHaveLength(5);
    expect(report.series.reduce((total, bucket) => total + bucket.total, 0)).toBe(5);
    expect(report.lessons).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "focus",
        title: "Bass",
        evidenceIds: expect.arrayContaining(["move:move-1", "midi:midi-1"]),
      }),
      expect.objectContaining({
        id: "iteration",
        title: "Serum · Cutoff",
        detail: "You moved it 2 times before settling on 10% → 42%.",
      }),
      expect.objectContaining({
        id: "carry",
        title: "Keep the bass tone",
      }),
    ]));
  });

  it("surfaces partial capture instead of treating unwatched controls as inactivity", () => {
    const partial = rawEvent({
      payload: JSON.stringify({
        truncated_devices: [{ device_name: "Serum", watched: 128, available: 256 }],
      }),
    });
    const report = buildSessionReport(input({ session: session("take-2", [partial]) }));

    expect(report.trust).toMatchObject({
      level: "partial",
      label: "Some controls were out of view",
    });
    expect(report.trust.detail).toContain("128 controls");
  });

  it("places song-section changes in the arrangement and explains the movement", () => {
    const moved = rawEvent({
      id: "section-moved",
      type: "cue_point_moved",
      timestamp_ms: start + 240_000,
      payload: JSON.stringify({
        cue_name: "Drop",
        previous_cue_time: 64,
        cue_time: 68,
      }),
      track: null,
    });
    const report = buildSessionReport(input({
      session: session("take-2", [rawEvent(), moved]),
      changes: [],
      noteEdits: [],
      clipEvents: [],
      moments: [],
    }));

    expect(report.decisions).toContainEqual(expect.objectContaining({
      kind: "structure",
      workKind: "arrangement",
      track: "Whole set",
      subject: "Song section moved: Drop",
      outcome: "beat 64 → beat 68",
    }));
    expect(Object.values(report.evidence)).toContainEqual(expect.objectContaining({
      track: "Whole set",
      subject: "Song section moved: Drop",
    }));
  });

  it("compares descriptive differences without producing an overall score", () => {
    const current = buildSessionReport(input());
    const baseline = buildSessionReport(input({
      session: session("take-1"),
      schema: schema("take-1"),
      changes: [change("baseline-move", start + 60_000, 0.1, 0.2)],
      noteEdits: [],
      clipEvents: [],
      moments: [],
    }));
    const comparison = compareSessionReports(current, baseline);

    expect(comparison.metrics.find((metric) => metric.label === "Changes captured")).toMatchObject({
      current: 5,
      baseline: 1,
      delta: 4,
    });
    expect(comparison.onlyCurrent.some((decision) => decision.kind === "midi")).toBe(true);
    expect(comparison).not.toHaveProperty("score");
  });
});

// Every case below is a defect the report actually shipped: a number that
// contradicted another number on the same page, or a row filed under the wrong
// place. They are regression tests, not coverage.
describe("session report data integrity", () => {
  function mixerMove(id: string, atMs: number, before: string, after: string): ParameterChange {
    return {
      ...change(id, atMs, 0, 0),
      event_type: "volume_changed",
      parameter_id: "volume",
      device_name: "Mixer",
      parameter_name: "Volume",
      before_display_value: before,
      after_display_value: after,
    };
  }

  it("counts the mixer strip as mixing, never as a device in the chain", () => {
    // The remote script reports volume/pan/sends under a device literally named
    // "Mixer". Counting it as a device inflated "devices shaped" by one on
    // every session that touched a fader.
    const report = buildSessionReport(input({
      changes: [
        change("move-1", start + 60_000, 0.1, 0.3),
        mixerMove("move-2", start + 90_000, "−5.0 dB", "−3.6 dB"),
      ],
    }));

    expect(report.ledger.deviceCount).toBe(1);
    expect(report.ledger.mixerTouched).toBe(true);
    expect(report.decisions.find((decision) => decision.subject === "Mixer · Volume")).toMatchObject({
      workKind: "mixing",
    });
    const bass = report.tracks.find((track) => track.name === "Bass");
    expect(bass).toMatchObject({ shapedDeviceCount: 1, mixerTouched: true });
  });

  it("files a saved moment under the track it was pinned to", () => {
    // The moment arrives from the analysis with a track id but no track name,
    // so the Where column read "Project" while the track table correctly rolled
    // the same moment up under Bass. One event, two answers.
    const report = buildSessionReport(input());

    expect(report.decisions.find((decision) => decision.kind === "moment")).toMatchObject({
      subject: "Keep the bass tone",
      track: "Bass",
    });
    expect(report.evidence["moment:moment-1"]).toMatchObject({ track: "Bass" });
    expect(report.tracks.find((track) => track.name === "Bass")?.momentCount).toBe(1);
  });

  it("reports a track's chain length and how much of it was shaped as separate facts", () => {
    // These were collapsed with Math.max, so a track with three devices in its
    // chain and two touched reported "3 devices observed".
    const report = buildSessionReport(input({
      schema: {
        ...schema(),
        tracks: [{
          ...schema().tracks[0]!,
          devices: ["Serum", "Saturator", "EQ Eight"].map((name, index) => ({
            id: `device-${index}`,
            track_id: "track-1",
            ableton_id: `device-${index}`,
            name,
            role: index === 0 ? "instrument" as const : "audio_effect" as const,
            chain_index: index,
            enabled: true,
            initial_enabled: true,
            host_parameter_count: 8,
            class_name: name,
            preset_name: null,
            parameters: [],
          })),
        }],
      },
    }));

    const bass = report.tracks.find((track) => track.name === "Bass");
    expect(bass).toMatchObject({ chainDeviceCount: 3, shapedDeviceCount: 1 });
  });

  it("keeps every headline number reconcilable with the others", () => {
    const report = buildSessionReport(input());
    const { ledger } = report;

    expect(ledger.handsOnCount + ledger.reportedCount + ledger.momentCount).toBe(ledger.capturedCount);
    // A decision groups captured rows; it can never outnumber them. The screen
    // used to print 18 decisions beside 14 actions.
    expect(ledger.decisionCount).toBeLessThanOrEqual(ledger.capturedCount);
    expect(ledger.capturedCount - ledger.decisionCount).toBe(ledger.groupedCount);
    expect(ledger.tracksTouched).toBeLessThanOrEqual(ledger.tracksInSet ?? Infinity);
    expect(Object.keys(report.evidence)).toHaveLength(ledger.capturedCount);
  });

  it("passes its own audit on a full session, an empty one, and one with no snapshot", () => {
    const full = buildSessionReport(input());
    const empty = buildSessionReport(input({ changes: [], noteEdits: [], clipEvents: [], moments: [] }));
    const unsnapshotted = buildSessionReport(input({ schema: null }));

    expect(reportInvariants(full)).toEqual([]);
    expect(reportInvariants(empty)).toEqual([]);
    expect(reportInvariants(unsnapshotted)).toEqual([]);
  });

  it("reports the audit failure rather than staying quiet when a number drifts", () => {
    // The audit is only worth having if it catches something. Corrupt one count
    // and it has to say so in words a person can act on.
    const report = buildSessionReport(input());
    const drifted = { ...report, ledger: { ...report.ledger, capturedCount: report.ledger.capturedCount + 3 } };

    expect(reportInvariants(drifted).join(" ")).toContain("do not add up");
  });

  it("keeps work-area percentages summing to the whole", () => {
    const report = buildSessionReport(input());
    const shares = report.workSections.reduce((total, section) => total + section.sourceEventCount, 0);

    expect(shares).toBe(report.ledger.capturedCount);
  });
});

describe("session chapters", () => {
  function soundMove(id: string, minute: number, trackId: string, trackName: string, device: string): ParameterChange {
    return {
      ...change(id, start + minute * 60_000, 0.2, 0.4),
      track_id: trackId,
      track_name: trackName,
      device_name: device,
      parameter_id: `${trackId}:${device}`,
    };
  }

  it("joins neighbouring stretches of the same work on the same track", () => {
    // Twelve numbered steps for one evening, nine of them a single change
    // stamped "0 sec", is not a session shape a producer can read.
    const report = buildSessionReport(input({
      changes: [
        soundMove("a", 5, "track-1", "Bass", "Serum"),
        soundMove("b", 8, "track-1", "Bass", "Serum"),
        soundMove("c", 12, "track-1", "Bass", "Saturator"),
      ],
      noteEdits: [],
      clipEvents: [],
      moments: [],
    }));

    expect(report.analysis.passages.length).toBeGreaterThan(1);
    expect(report.chapters).toHaveLength(1);
    expect(report.chapters[0]).toMatchObject({ order: 1, kind: "sound", primaryTrackNames: ["Bass"] });
  });

  it("does not join stretches separated by a real break", () => {
    const report = buildSessionReport(input({
      changes: [
        soundMove("a", 5, "track-1", "Bass", "Serum"),
        soundMove("b", 45, "track-1", "Bass", "Serum"),
      ],
      noteEdits: [],
      clipEvents: [],
      moments: [],
    }));

    expect(report.chapters).toHaveLength(2);
    expect(report.chapters.map((chapter) => chapter.order)).toEqual([1, 2]);
  });

  it("carries the net outcome of a control across a joined chapter", () => {
    const report = buildSessionReport(input({
      changes: [
        { ...soundMove("a", 5, "track-1", "Bass", "Serum"), before_display_value: "10%", after_display_value: "20%" },
        { ...soundMove("b", 9, "track-1", "Bass", "Serum"), before_display_value: "20%", after_display_value: "55%" },
      ],
      noteEdits: [],
      clipEvents: [],
      moments: [],
    }));

    const [chapter] = report.chapters;
    expect(chapter?.controls[0]).toMatchObject({
      parameterName: "Cutoff",
      beforeDisplay: "10%",
      afterDisplay: "55%",
      count: 2,
    });
  });

  it("leaves the underlying passages alone for the surfaces that want them", () => {
    const report = buildSessionReport(input());

    expect(report.analysis.passages.every((passage) => passage.order > 0)).toBe(true);
    expect(report.chapters.length).toBeLessThanOrEqual(report.analysis.passages.length);
  });
});
