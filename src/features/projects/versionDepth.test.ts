import { describe, expect, it } from "vitest";
import type {
  NoteEdit,
  ParameterChange,
  ProjectSchema,
  TimelineClipEvent,
} from "../../types/schema";
import type { SavedSession, SavedSessionEvent } from "../../types/recall";
import type { SessionReportInput } from "./sessionReport";
import { buildVersionDepth } from "./versionDepth";

const start = 1_720_000_000_000;
const minute = 60_000;

function rawEvent(atMs: number): SavedSessionEvent {
  return {
    id: `event-${atMs}`,
    type: "parameter_changed",
    timestamp_ms: atMs,
    summary: null,
    title: "Parameter changed",
    description: "Bass",
    source: "control_surface",
    payload: null,
    session_id: "s",
    track: "Bass",
    track_type: "midi",
    device: "Serum",
    device_chain: null,
    parameter: "Cutoff",
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
  };
}

function session(id: string, startedAtMs: number): SavedSession {
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
    started_at_ms: startedAtMs,
    ended_at_ms: startedAtMs + 20 * minute,
    last_updated_at_ms: startedAtMs + 20 * minute,
    event_count: 1,
    creative_event_count: 1,
    heartbeat_count: 0,
    events: [rawEvent(startedAtMs + minute)],
  };
}

/** A schema carrying exactly the tracks (and their devices) it is given. */
function schema(sessionId: string, tracks: { name: string; devices: string[] }[]): ProjectSchema {
  return {
    session_id: sessionId,
    name: "Nightdrive",
    has_snapshot: true,
    tracks: tracks.map((track, index) => ({
      id: `track-${track.name}`,
      ableton_id: `track-${track.name}`,
      name: track.name,
      number: index + 1,
      type: "midi",
      color: null,
      group_id: null,
      chain_index: index,
      devices: track.devices.map((device, position) => ({
        id: `device-${track.name}-${device}`,
        track_id: `track-${track.name}`,
        ableton_id: `device-${track.name}-${device}`,
        name: device,
        role: "instrument" as const,
        chain_index: position,
        enabled: true,
        initial_enabled: true,
        host_parameter_count: 0,
        class_name: device,
        preset_name: null,
        parameters: [],
        rack: null,
      })),
    })),
  };
}

function change(id: string, atMs: number, trackName: string): ParameterChange {
  return {
    id,
    event_type: "parameter_changed",
    parameter_id: `${trackName}-cutoff`,
    track_name: trackName,
    track_id: `track-${trackName}`,
    device_id: `device-${trackName}`,
    device_name: "Serum",
    parameter_name: "Cutoff",
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
    changed_at_ms: atMs,
  };
}

function capture(
  id: string,
  startedAtMs: number,
  tracks: { name: string; devices: string[] }[],
  changes: ParameterChange[],
  noteEdits: NoteEdit[] = [],
  clipEvents: TimelineClipEvent[] = [],
): SessionReportInput {
  return {
    session: session(id, startedAtMs),
    schema: schema(id, tracks),
    changes,
    noteEdits,
    clipEvents,
    moments: [],
  };
}

describe("buildVersionDepth", () => {
  it("diffs the version's FINAL state against the parent, not its first", () => {
    // A version worked across two sittings ends as whatever the last sitting
    // left it. Diffing the first sitting's snapshot would compare against a
    // state that was already superseded inside the same file.
    const depth = buildVersionDepth({
      captures: [
        capture("late", start + 5 * minute, [
          { name: "Bass", devices: ["Serum"] },
          { name: "Lead", devices: ["Serum"] },
        ], [change("c2", start + 6 * minute, "Lead")]),
        capture("early", start, [{ name: "Bass", devices: ["Serum"] }], [
          change("c1", start + minute, "Bass"),
        ]),
      ],
      parent: {
        name: "Nightdrive v1.als",
        capture: capture("parent", start - 60 * minute, [
          { name: "Bass", devices: ["Serum"] },
        ], []),
      },
    });

    expect(depth.diff.status).toBe("changed");
    if (depth.diff.status !== "changed") throw new Error("expected a changed diff");
    expect(depth.diff.diff.addedTracks).toEqual(["Lead"]);
    expect(depth.parentName).toBe("Nightdrive v1.als");
  });

  it("reports the root version as root rather than as 'nothing changed'", () => {
    const depth = buildVersionDepth({
      captures: [capture("only", start, [{ name: "Bass", devices: [] }], [])],
      parent: null,
    });

    expect(depth.diff.status).toBe("root");
    expect(depth.parentName).toBeNull();
  });

  it("refuses to claim a diff when a snapshot is missing", () => {
    // "No snapshot" and "nothing changed" are different facts. Printing the
    // second when the first is true is the failure this codebase keeps undoing.
    const withoutSnapshot = capture("blind", start, [], []);
    withoutSnapshot.schema = { ...withoutSnapshot.schema!, has_snapshot: false };

    const depth = buildVersionDepth({
      captures: [withoutSnapshot],
      parent: { name: "v1.als", capture: capture("parent", start - minute, [], []) },
    });

    expect(depth.diff.status).toBe("unknown");
  });

  it("summarises what every sitting in the version touched, together", () => {
    const depth = buildVersionDepth({
      captures: [
        capture("one", start, [{ name: "Bass", devices: ["Serum"] }], [
          change("a", start + minute, "Bass"),
          change("b", start + 2 * minute, "Bass"),
        ]),
        capture("two", start + 60 * minute, [{ name: "Lead", devices: ["Serum"] }], [
          change("c", start + 61 * minute, "Lead"),
        ]),
      ],
      parent: null,
    });

    // Two distinct tracks across the version, not one per sitting.
    expect(depth.contents.totals.tracks).toBe(2);
    expect(depth.contents.empty).toBe(false);
  });

  it("keeps the sittings separate and newest first", () => {
    // A version spanning two evenings is two returns to the desk. Flattening
    // them into one list hides the boundary that makes the version legible,
    // and the newest is the one being resumed.
    const depth = buildVersionDepth({
      captures: [
        capture("older", start, [{ name: "Bass", devices: [] }], [change("a", start + minute, "Bass")]),
        capture("newer", start + 60 * minute, [{ name: "Bass", devices: [] }], [
          change("b", start + 61 * minute, "Bass"),
        ]),
      ],
      parent: null,
    });

    expect(depth.sittings.map((sitting) => sitting.sessionId)).toEqual(["newer", "older"]);
    expect(depth.sittings[0]!.startedAtMs).toBeGreaterThan(depth.sittings[1]!.startedAtMs);
    // Each sitting's contents are its own, not the version's.
    expect(depth.sittings[0]!.contents.totals.parameters).toBe(1);
  });

  it("refuses to build a version with no captures at all", () => {
    expect(() => buildVersionDepth({ captures: [], parent: null })).toThrow();
  });
});

describe("sittings are not captures", () => {
  // The real screen showed nine sitting rows for one version, four of them
  // reading "0 changes · 0 sec hands-on" and four more all dated "Aug 19, 2026".
  // Those are Recall's bookkeeping objects, not the producer's evenings.
  it("folds captures split milliseconds apart into one sitting", () => {
    const first = capture("split-a", start, [{ name: "Bass", devices: [] }], [
      change("a", start + minute, "Bass"),
    ]);
    // A rotation fired 12ms after the first capture's last event. Nobody closes
    // and reopens a set in 12ms.
    const second = capture(
      "split-b",
      first.session.last_updated_at_ms + 12,
      [{ name: "Bass", devices: [] }],
      [change("b", first.session.last_updated_at_ms + minute, "Bass")],
    );
    second.session.als_path = first.session.als_path;

    const depth = buildVersionDepth({ captures: [first, second], parent: null });

    expect(depth.sittings).toHaveLength(1);
    expect(depth.sittings[0]!.merged).toBe(true);
    expect(depth.sittings[0]!.captureIds).toEqual(["split-a", "split-b"]);
    // Read as one unit of work, not as a third of an evening.
    expect(depth.sittings[0]!.contents.totals.parameters).toBe(1);
  });

  it("counts captures that recorded nothing instead of listing them", () => {
    const real = capture("real", start, [{ name: "Bass", devices: [] }], [
      change("a", start + minute, "Bass"),
    ]);
    const empty = capture("empty", start + 10 * 60 * minute, [], []);
    empty.session.creative_event_count = 0;
    empty.session.event_count = 0;

    const depth = buildVersionDepth({ captures: [real, empty], parent: null });

    expect(depth.sittings.map((sitting) => sitting.sessionId)).toEqual(["real"]);
    expect(depth.recordedNothing).toBe(1);
  });

  it("ends a sitting at its last event, never at the rotation that closed it", () => {
    // One real capture read "1h 45m" for 62 events that all landed within three
    // seconds: Live was open and nothing happened for the remaining hour.
    const capture_ = capture("long", start, [{ name: "Bass", devices: [] }], [
      change("a", start + minute, "Bass"),
    ]);
    capture_.session.last_updated_at_ms = start + 3_000;
    capture_.session.ended_at_ms = start + 105 * minute;

    const depth = buildVersionDepth({ captures: [capture_], parent: null });

    expect(depth.sittings[0]!.endedAtMs).toBe(start + 3_000);
  });
});
