import { describe, expect, it } from "vitest";
import type { CreativeMoment, NoteEdit, ParameterChange, SavedSessionEvent, TimelineClipEvent } from "../../../types";
import type { ProducerMemoryEvent } from "./eventMemory";
import { analyzeSession, analyzeSessionSources, normalizedSessionActivities } from "./sessionAnalysis";
import { presentPassage } from "./passagePresenter";
import { buildShareData, buildShareDocument } from "./share";

const start = 1_700_000_000_000;

function change(overrides: Partial<ParameterChange> = {}): ParameterChange {
  return {
    id: "move-1",
    event_type: "parameter_changed",
    parameter_id: "parameter-1",
    track_name: "Lead",
    track_id: "track-1",
    device_name: "Serum",
    parameter_name: "Filter",
    before_value: 0.1,
    after_value: 0.4,
    before_value_percent: 10,
    after_value_percent: 40,
    unit: null,
    before_display_value: "10%",
    after_display_value: "40%",
    is_quantized: false,
    reason: null,
    automation_start_ms: null,
    automation_start_position: null,
    automation_end_position: null,
    changed_at_ms: start + 10_000,
    ...overrides,
  };
}

function midi(overrides: Partial<NoteEdit> = {}): NoteEdit {
  return {
    id: "midi-1",
    track_name: "Lead",
    track_id: "track-1",
    clip_name: "Hook",
    clip_id: "clip-1",
    change_kind: "notes_added",
    note_count: 4,
    previous_note_count: 2,
    distinct_pitches: 3,
    pitch_min: 48,
    pitch_max: 55,
    previous_pitch_min: 48,
    previous_pitch_max: 52,
    pitch_range: "C2-G2",
    previous_pitch_range: "C2-E2",
    velocity_mean: 96,
    length_beats: 4,
    summary: "4 notes (+2), C2-G2",
    changed_at_ms: start + 20_000,
    ...overrides,
  };
}

function clip(overrides: Partial<TimelineClipEvent> = {}): TimelineClipEvent {
  return {
    id: "clip-1",
    event_type: "midi_clip_created",
    track_name: "Lead",
    track_id: "track-1",
    clip_name: "Hook",
    sample_name: null,
    observed_arrangement_position: null,
    observed_arrangement_beats: null,
    arrangement_start_beats: null,
    arrangement_end_beats: null,
    changed_at_ms: start + 30_000,
    ...overrides,
  };
}

function memory(overrides: Partial<ProducerMemoryEvent> = {}): ProducerMemoryEvent {
  return {
    id: "memory-1",
    eventType: "track_routing_changed",
    atMs: start + 100,
    trackId: "track-1",
    trackName: "Lead",
    title: "Routing changed",
    summary: "Lead → Main",
    category: "structure",
    observedArrangementPosition: null,
    observedArrangementBeats: null,
    evidence: null,
    ...overrides,
  };
}

function marker(overrides: Partial<CreativeMoment> = {}): CreativeMoment {
  return {
    id: "marker-1",
    session_id: "take-1",
    title: "Keep this version",
    type: "idea_to_revisit",
    timeline_start_ms: start + 15_000,
    timeline_end_ms: null,
    note: "The hook is working.",
    tags: ["keeper"],
    confidence: "keeper",
    created_at_ms: start + 15_000,
    updated_at_ms: start + 15_000,
    targets: [],
    ...overrides,
  };
}

function rawMemory(overrides: Partial<SavedSessionEvent> = {}): SavedSessionEvent {
  return {
    id: "raw-memory-1",
    type: "track_routing_changed",
    timestamp_ms: start + 100,
    summary: null,
    title: "Routing changed",
    description: "Lead → Main",
    source: "control_surface",
    payload: JSON.stringify({ track_id: "track-1", output_routing: "Main" }),
    session_id: "take-1",
    track: "Lead",
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

describe("session analysis", () => {
  it("drops opening state, collapses duplicated reports, and keeps the evidence count honest", () => {
    const result = analyzeSession({
      changes: [change()],
      noteEdits: [midi(), midi({ id: "midi-duplicate" })],
      clipEvents: [clip(), clip({ id: "clip-duplicate" })],
      memoryEvents: [memory(), memory({ id: "memory-duplicate" })],
      sessionStartedAtMs: start,
    });

    expect(result).toMatchObject({
      actionCount: 3,
      controlMoveCount: 1,
      midiEditCount: 1,
      clipEventCount: 1,
      duplicateReportCount: 3,
      openingStateEventCount: 1,
      passages: [{ label: "Writing + Sound & samples + Arrangement", actionCount: 3 }],
    });
  });

  it("forms cross-track passages from time, rather than breaking every time focus changes", () => {
    const result = analyzeSession({
      changes: [
        change(),
        change({
          id: "move-2",
          parameter_id: "parameter-2",
          track_id: "track-2",
          track_name: "Bass",
          device_name: "Bass",
          parameter_name: "Drive",
          changed_at_ms: start + 80_000,
        }),
        change({
          id: "move-3",
          parameter_id: "parameter-3",
          track_id: "track-3",
          track_name: "Pad",
          changed_at_ms: start + 260_001,
        }),
      ],
      noteEdits: [],
      clipEvents: [],
      memoryEvents: [],
      sessionStartedAtMs: start,
    });

    expect(result.passages).toHaveLength(2);
    expect(result.passages[0]).toMatchObject({
      label: "Sound & samples",
      controlMoveCount: 2,
      trackNames: ["Bass", "Lead"],
    });
    expect(result.passages[1]?.trackNames).toEqual(["Pad"]);
  });

  it("replays a scrambled capture as one deterministic path from start through finish", () => {
    const input = {
      // Each source is deliberately in a different, non-chronological order.
      // This mirrors observers arriving independently from Live.
      changes: [
        change({
          id: "finish-bass",
          parameter_id: "parameter-finish-bass",
          track_id: "track-bass",
          track_name: "Bass",
          device_name: "Mixer",
          parameter_name: "Volume",
          changed_at_ms: start + 730_000,
        }),
        change({
          id: "middle-3",
          parameter_id: "parameter-middle-3",
          changed_at_ms: start + 400_000,
        }),
        change({
          id: "finish-lead",
          parameter_id: "parameter-finish-lead",
          device_name: "Mixer",
          parameter_name: "Volume",
          changed_at_ms: start + 720_000,
        }),
        change({ id: "middle-1", parameter_id: "parameter-middle-1", changed_at_ms: start + 360_000 }),
        change({ id: "middle-2", parameter_id: "parameter-middle-2", changed_at_ms: start + 380_000 }),
      ],
      noteEdits: [
        midi({ id: "start-midi-later", changed_at_ms: start + 50_000 }),
        midi({ id: "start-midi-first", changed_at_ms: start + 10_000 }),
      ],
      clipEvents: [clip({ id: "middle-clip", changed_at_ms: start + 370_000 }), clip({ id: "start-clip", changed_at_ms: start + 30_000 })],
      memoryEvents: [memory(), memory({ id: "opening-duplicate" })],
      sessionStartedAtMs: start,
    };

    expect(normalizedSessionActivities(input).map((activity) => activity.atMs)).toEqual([
      start + 10_000,
      start + 30_000,
      start + 50_000,
      start + 360_000,
      start + 370_000,
      start + 380_000,
      start + 400_000,
      start + 720_000,
      start + 730_000,
    ]);

    const result = analyzeSession(input);
    expect(result.passages.map((passage) => ({
      order: passage.order,
      position: passage.pathPosition,
      label: passage.label,
      startMs: passage.startMs,
      endMs: passage.endMs,
    }))).toEqual([
      { order: 1, position: "start", label: "Writing + Arrangement", startMs: start + 10_000, endMs: start + 50_000 },
      { order: 2, position: "middle", label: "Sound & samples", startMs: start + 360_000, endMs: start + 400_000 },
      { order: 3, position: "finish", label: "Mixing", startMs: start + 720_000, endMs: start + 730_000 },
    ]);
    expect(result.pathSummary).toMatch(/^This session focused on /);
    expect(result.pathSummary).toContain("It opened with writing and arrangement on Lead");
    expect(result.pathSummary).toContain("closed with mixing across Bass and Lead.");
    expect(result.passages[0]).toMatchObject({
      primaryTrackName: "Lead",
      firstAction: "MIDI edit · Hook",
      lastAction: "MIDI edit · Hook",
    });
    expect(result.passages[2]).toMatchObject({
      primaryTrackName: "Bass",
      firstAction: "Mixer · Volume",
      lastAction: "Mixer · Volume",
    });
    expect(result.passages.map((passage) => passage.gapBeforeMs)).toEqual([null, 310_000, 320_000]);

    const replayedWithDifferentArrivalOrder = analyzeSession({
      ...input,
      changes: [...input.changes].reverse(),
      noteEdits: [...input.noteEdits].reverse(),
      clipEvents: [...input.clipEvents].reverse(),
      memoryEvents: [...input.memoryEvents].reverse(),
    });
    expect(replayedWithDifferentArrivalOrder.passages).toEqual(result.passages);
  });

  it("keeps structural evidence without letting it change a producer-action boundary", () => {
    const result = analyzeSession({
      changes: [change({ changed_at_ms: start + 10_000 })],
      noteEdits: [],
      clipEvents: [],
      memoryEvents: [memory({
        id: "supporting-structure",
        eventType: "device_chain_changed",
        atMs: start + 1_000,
        title: "Device chain changed",
      })],
      sessionStartedAtMs: start,
    });

    expect(result.passages).toMatchObject([{
      startMs: start + 10_000,
      endMs: start + 10_000,
      firstAction: "Serum · Filter",
      structureEventCount: 1,
    }]);
  });

  it("carries only observed arrangement locations into the path", () => {
    const result = analyzeSession({
      changes: [
        change({ id: "arrangement-first", changed_at_ms: start + 10_000, observed_arrangement_position: "17.1.1" }),
        change({
          id: "arrangement-last",
          parameter_id: "arrangement-parameter",
          changed_at_ms: start + 20_000,
          observed_arrangement_position: "25.1.1",
        }),
      ],
      noteEdits: [],
      clipEvents: [],
      memoryEvents: [],
      sessionStartedAtMs: start,
    });

    expect(result.passages[0]?.observedArrangementPositions).toEqual(["17.1.1", "25.1.1"]);
  });

  it("attaches a producer marker to its nearest action passage without making it an action", () => {
    const result = analyzeSession({
      changes: [change({ changed_at_ms: start + 10_000 })],
      noteEdits: [],
      clipEvents: [],
      memoryEvents: [],
      moments: [marker()],
      sessionStartedAtMs: start,
    });

    expect(result).toMatchObject({
      actionCount: 1,
      markerCount: 1,
      passages: [{
        actionCount: 1,
        markerCount: 1,
        markers: [{ title: "Keep this version", note: "The hook is working." }],
      }],
    });
  });

  it("splits a long uninterrupted capture only at its largest observed pause", () => {
    const offsets = [0, 20_000, 40_000, 130_000, 150_000, 170_000, 240_000, 300_000, 360_000, 420_000, 480_000, 540_000];
    const result = analyzeSession({
      changes: offsets.map((offset, index) => change({
        id: `long-${index}`,
        parameter_id: `long-parameter-${index}`,
        changed_at_ms: start + offset,
      })),
      noteEdits: [],
      clipEvents: [],
      memoryEvents: [],
      sessionStartedAtMs: start,
    });

    expect(result.passages).toHaveLength(2);
    expect(result.passages.map((passage) => [passage.startMs, passage.endMs, passage.actionCount])).toEqual([
      [start, start + 40_000, 3],
      [start + 130_000, start + 540_000, 9],
    ]);
  });

  it("removes each take's opening snapshot before building a project-wide path", () => {
    const earlierStart = start - 86_400_000;
    const result = analyzeSessionSources([
      {
        sourceId: "earlier-take",
        sourceLabel: "Earlier take",
        changes: [change({ id: "earlier-action", changed_at_ms: earlierStart + 10_000 })],
        noteEdits: [],
        clipEvents: [],
        memoryEvents: [memory({ id: "earlier-opening", atMs: earlierStart + 100 })],
        sessionStartedAtMs: earlierStart,
      },
      {
        sourceId: "current-take",
        sourceLabel: "Current take",
        changes: [change({ id: "current-action", changed_at_ms: start + 10_000 })],
        noteEdits: [],
        clipEvents: [],
        memoryEvents: [memory({ id: "current-opening" })],
        sessionStartedAtMs: start,
      },
    ]);

    expect(result).toMatchObject({
      actionCount: 2,
      openingStateEventCount: 2,
      passages: [
        { order: 1, pathPosition: "start", startMs: earlierStart + 10_000, sourceLabels: ["Earlier take"] },
        { order: 2, pathPosition: "finish", startMs: start + 10_000, sourceLabels: ["Current take"] },
      ],
    });
  });

  it("uses source identity as a stable tie-breaker when observers report the same millisecond", () => {
    const sources = [
      {
        sourceId: "z-observer",
        sourceLabel: "Z observer",
        changes: [change({ id: "z-change", parameter_id: "z-parameter", changed_at_ms: start + 10_000, parameter_name: "Z filter" })],
        noteEdits: [],
        clipEvents: [],
        memoryEvents: [],
      },
      {
        sourceId: "a-observer",
        sourceLabel: "A observer",
        changes: [change({ id: "a-change", parameter_id: "a-parameter", changed_at_ms: start + 10_000, parameter_name: "A filter" })],
        noteEdits: [],
        clipEvents: [],
        memoryEvents: [],
      },
    ];

    expect(analyzeSessionSources(sources)).toEqual(analyzeSessionSources([...sources].reverse()));
  });

  it("keeps opening-state filtering and report deduplication in exports too", () => {
    const input = {
      changes: [],
      noteEdits: [],
      clipEvents: [],
      memoryEvents: [memory()],
      sessionStartedAtMs: start,
    };
    const activities = normalizedSessionActivities(input);
    expect(activities).toEqual([]);

    const data = buildShareData({
      title: "Test take",
      project: "Test project",
      duration: null,
      recordedAtMs: start,
      changes: [],
      stats: { moves: 0, characterMoves: 0, tracksTouched: 0, keepers: 0 },
      story: null,
      blocks: [],
      sessionStart: start,
      timelineSources: [{
        id: "take-1",
        label: "Test take",
        startedAtMs: start,
        changes: [],
        noteEdits: [],
        clipEvents: [clip(), clip({ id: "clip-duplicate" })],
        sessionEvents: [rawMemory(), rawMemory({ id: "raw-memory-duplicate" })],
      }],
    });
    expect(data.timeline).toHaveLength(1);
    expect(data.timeline[0]).toMatchObject({ kind: "clip", track: "Lead" });
    expect(data.sessionPath).toMatchObject({
      openingStateEventCount: 1,
      steps: [{ order: 1, position: "only", label: "Arrangement", firstAction: "Clip action · Hook" }],
    });
    expect(buildShareDocument(data, "md")).toContain("## Session path");
  });
});

describe("track identity", () => {
  // A routing report or a saved note names a track without the producer having
  // touched its fader. Counting those in the balance headline is how "Balanced
  // 31 tracks" outran the number of tracks anyone actually moved.
  it("counts only tracks the producer acted on as touched", () => {
    const result = analyzeSession({
      changes: [
        change({ id: "m1", track_id: "track-1", track_name: "Kick", device_name: "Mixer", parameter_name: "Volume" }),
        change({
          id: "m2",
          track_id: "track-2",
          track_name: "Snare",
          device_name: "Mixer",
          parameter_name: "Volume",
          changed_at_ms: start + 11_000,
        }),
      ],
      noteEdits: [],
      clipEvents: [],
      // Three more tracks appear only as structural evidence.
      memoryEvents: [
        memory({ id: "s1", eventType: "track_added", trackId: "track-9", trackName: "Pad", atMs: start + 12_000 }),
        memory({ id: "s2", eventType: "track_added", trackId: "track-8", trackName: "Bass", atMs: start + 12_500 }),
        memory({ id: "s3", eventType: "track_added", trackId: "track-7", trackName: "Keys", atMs: start + 13_000 }),
      ],
      sessionStartedAtMs: start,
    });

    const passage = result.passages[0];
    expect(passage.primaryTrackNames.sort()).toEqual(["Kick", "Snare"]);
    expect(passage.trackNames).toHaveLength(5);
    expect(result.trackCount).toBe(2);
  });

  // Live's track pointer is authoritative but not every row carries one. The
  // same track arriving with a pointer in one row and a bare name in another
  // must not count twice.
  it("folds a name-only row into the pointer identity for the same track", () => {
    const result = analyzeSession({
      changes: [
        change({ id: "m1", track_id: "track-1", track_name: "Lead" }),
        change({ id: "m2", track_id: null, track_name: "Lead", changed_at_ms: start + 11_000 }),
        change({ id: "m3", track_id: null, track_name: "lead", changed_at_ms: start + 12_000 }),
      ],
      noteEdits: [],
      clipEvents: [],
      memoryEvents: [],
      sessionStartedAtMs: start,
    });

    expect(result.trackCount).toBe(1);
    expect(result.passages[0].primaryTrackNames).toEqual(["Lead"]);
  });
});

describe("control outcomes", () => {
  it("reports where a control started the passage and where it ended it", () => {
    const result = analyzeSession({
      changes: [
        change({
          id: "m1",
          device_name: "EQ Eight",
          parameter_name: "1 Frequency A",
          before_display_value: "400 Hz",
          after_display_value: "900 Hz",
        }),
        change({
          id: "m2",
          device_name: "EQ Eight",
          parameter_name: "1 Frequency A",
          before_display_value: "900 Hz",
          after_display_value: "2.1 kHz",
          changed_at_ms: start + 11_000,
        }),
      ],
      noteEdits: [],
      clipEvents: [],
      memoryEvents: [],
      sessionStartedAtMs: start,
    });

    expect(result.passages[0].controls[0]).toMatchObject({
      deviceName: "EQ Eight",
      parameterName: "1 Frequency A",
      count: 2,
      beforeDisplay: "400 Hz",
      afterDisplay: "2.1 kHz",
    });
  });
});

describe("sittings", () => {
  it("splits the path where the producer was away long enough to be a new sitting", () => {
    const threeDays = 3 * 24 * 60 * 60 * 1000;
    const result = analyzeSession({
      changes: [
        change({ id: "m1" }),
        change({ id: "m2", changed_at_ms: start + 11_000 }),
        change({ id: "m3", changed_at_ms: start + threeDays }),
      ],
      noteEdits: [],
      clipEvents: [],
      memoryEvents: [],
      sessionStartedAtMs: start,
    });

    expect(result.passages).toHaveLength(2);
    expect(result.sittings).toHaveLength(2);
    expect(result.sittings[0].passages.map((passage) => passage.order)).toEqual([1]);
    expect(result.sittings[1].passages.map((passage) => passage.order)).toEqual([2]);
  });

  it("keeps steps separated by an ordinary work pause in one sitting", () => {
    const result = analyzeSession({
      changes: [
        change({ id: "m1" }),
        // Twenty minutes: a new passage, but plainly the same evening.
        change({ id: "m2", changed_at_ms: start + 20 * 60 * 1000 }),
      ],
      noteEdits: [],
      clipEvents: [],
      memoryEvents: [],
      sessionStartedAtMs: start,
    });

    expect(result.passages).toHaveLength(2);
    expect(result.sittings).toHaveLength(1);
    expect(result.sittings[0].passages).toHaveLength(2);
  });
});

describe("the export and the screen phrase a step the same way", () => {
  // These drifted before: the file carried the arrangement position and the
  // first/last action while the screen showed a bare tally and dropped the
  // device name off every control. Both now render from presentPassage, so this
  // asserts the shared fields survive the export boundary intact.
  it("carries the presenter's title, controls, and observed position into the record", () => {
    const sources = [{
      id: "take-1",
      label: "Test take",
      startedAtMs: start,
      changes: [
        change({
          id: "m1",
          device_name: "EQ Eight",
          parameter_name: "1 Frequency A",
          before_display_value: "400 Hz",
          after_display_value: "900 Hz",
          observed_arrangement_position: "Bar 33 · Beat 2",
        }),
        change({
          id: "m2",
          device_name: "EQ Eight",
          parameter_name: "1 Frequency A",
          before_display_value: "900 Hz",
          after_display_value: "2.1 kHz",
          observed_arrangement_position: "Bar 41 · Beat 1",
          changed_at_ms: start + 11_000,
        }),
      ],
      noteEdits: [],
      clipEvents: [],
      sessionEvents: [],
    }];

    const analysis = analyzeSessionSources(sources.map((source) => ({
      sourceId: source.id,
      sourceLabel: source.label,
      changes: source.changes,
      noteEdits: [],
      clipEvents: [],
      memoryEvents: [],
      sessionStartedAtMs: source.startedAtMs,
    })));
    const presented = presentPassage(analysis.passages[0]);

    const data = buildShareData({
      title: "Test take",
      project: "Test project",
      duration: null,
      recordedAtMs: start,
      changes: [],
      stats: { moves: 0, characterMoves: 0, tracksTouched: 0, keepers: 0 },
      story: null,
      blocks: [],
      sessionStart: start,
      timelineSources: sources,
    });

    const step = data.sessionPath.steps[0];
    expect(step.title).toBe(presented.title);
    expect(step.title).toBe("Shaped sound and samples on Lead");
    expect(step.where).toBe("Bar 33 · Beat 2 → Bar 41 · Beat 1");
    expect(step.controls).toEqual([
      { name: "EQ Eight · 1 Frequency A", outcome: "400 Hz → 2.1 kHz", count: 2, trackName: null },
    ]);

    const markdown = buildShareDocument(data, "md");
    expect(markdown).toContain("EQ Eight · 1 Frequency A 400 Hz → 2.1 kHz (2x)");
    expect(markdown).toContain("observed at Bar 33 · Beat 2 → Bar 41 · Beat 1");
  });
});
