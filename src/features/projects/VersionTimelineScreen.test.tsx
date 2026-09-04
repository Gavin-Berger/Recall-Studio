// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { SavedProject, SavedSessionMetadata } from "../../types/recall";
import type { NoteEdit, ProjectSchema, ParameterChange } from "../../types/schema";
import type { SavedSession } from "../../types/recall";
import type { SessionReportInput } from "./sessionReport";
import { buildVersionDepth } from "./versionDepth";
import { loadVersionDepth } from "./versionReportLoader";
import { VersionTimelineScreen } from "./VersionTimelineScreen";

// The depth loader is IO. The tests that care about the graph let it reject —
// the surface must still render the lineage when the detail cannot be read —
// and the one that cares about depth resolves it with a real built model.
vi.mock("./versionReportLoader", () => ({
  loadVersionDepth: vi.fn(async () => {
    throw new Error("detail loading is covered separately");
  }),
}));

const hour = 60 * 60 * 1000;
const start = 1_720_000_000_000;

function sitting(
  id: string,
  file: string,
  atHours: number,
  overrides: Partial<SavedSessionMetadata> = {},
): SavedSessionMetadata {
  const started = start + atHours * hour;
  return {
    id,
    name: "capture",
    project_id: "pers",
    capture_name: null,
    capture_status: "ended",
    project_name: "Pers EP",
    project_path: "C:\\Music\\Pers EP",
    als_path: `C:\\Music\\Pers EP\\${file}.als`,
    take_origin: "recorded",
    display_name: null,
    started_at_ms: started,
    ended_at_ms: started + 35 * 60 * 1000,
    last_updated_at_ms: started + 35 * 60 * 1000,
    event_count: 90,
    creative_event_count: 42,
    heartbeat_count: 0,
    ...overrides,
  };
}

const project: SavedProject = {
  id: "pers",
  display_name: "Pers EP",
  ableton_name: "Pers EP",
  ableton_path: "C:\\Music\\Pers EP",
  archived_at_ms: null,
  created_at_ms: start,
  updated_at_ms: start + 20 * hour,
  last_updated_at_ms: start + 20 * hour,
  capture_count: 4,
  active_capture_count: 0,
  captures: [
    sitting("v1-first", "Pers EP", 0),
    sitting("v1-return", "Pers EP", 2),
    sitting("v2", "Pers EP v2", 4),
    sitting("v3", "Pers EP v3", 8),
  ],
};

function renderTimeline() {
  const onOpenReport = vi.fn();
  const view = render(
    <VersionTimelineScreen
      projects={[project]}
      projectId="pers"
      onSelectProject={vi.fn()}
      onOpenReport={onOpenReport}
      onOpenProjects={vi.fn()}
    />,
  );
  return { onOpenReport, ...view };
}
/** A capture shaped for the depth model: a schema, and one real move on it. */
function depthCapture(
  id: string,
  startedAtMs: number,
  tracks: { name: string; devices: string[] }[],
): SessionReportInput {
  const session: SavedSession = {
    ...sitting(id, "Pers EP", 0),
    id,
    started_at_ms: startedAtMs,
    ended_at_ms: startedAtMs + 30 * 60 * 1000,
    last_updated_at_ms: startedAtMs + 30 * 60 * 1000,
    events: [],
  };

  const schema: ProjectSchema = {
    session_id: id,
    name: "Pers EP",
    has_snapshot: true,
    signature_numerator: 4,
    signature_denominator: 4,
    meter_changed: false,
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

  const changes: ParameterChange[] = tracks.map((track, index) => ({
    id: `${id}-move-${index}`,
    event_type: "parameter_changed",
    parameter_id: `${track.name}-cutoff`,
    track_name: track.name,
    track_id: `track-${track.name}`,
    device_id: `device-${track.name}`,
    device_name: track.devices[0] ?? "Serum",
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
    changed_at_ms: startedAtMs + 60_000 * (index + 1),
  }));

  return { session, schema, changes, noteEdits: [], clipEvents: [], moments: [] };
}

describe("VersionTimelineScreen", () => {
  it("draws one graph row per .als version, not per sitting", () => {
    renderTimeline();

    const versions = screen.getByLabelText("Versions in this project");
    expect(within(versions).getAllByRole("button")).toHaveLength(3);
    expect(within(versions).getByRole("button", { name: /Pers EP v3\.als/ })).toBeInTheDocument();
    expect(within(versions).queryByRole("button", { name: /v1-return/ })).not.toBeInTheDocument();
  });

  it("does not turn returns to one version into days of empty graph rail", () => {
    const longRunningProject: SavedProject = {
      ...project,
      captures: [
        sitting("parent", "Breaking Point", 0),
        sitting("return-1", "Breaking Point v2 mixdown", 1),
        sitting("return-2", "Breaking Point v2 mixdown", 4 * 24),
        sitting("return-3", "Breaking Point v2 mixdown", 7 * 24),
        sitting("return-4", "Breaking Point v2 mixdown", 8 * 24),
      ],
    };
    const { container } = render(
      <VersionTimelineScreen
        projects={[longRunningProject]}
        projectId="pers"
        onSelectProject={vi.fn()}
        onOpenReport={vi.fn()}
        onOpenProjects={vi.fn()}
      />,
    );

    const graph = container.querySelector(".vt-graph__drawing");
    expect(Number(graph?.getAttribute("height"))).toBeLessThan(400);
    expect(container.querySelectorAll(".vt-graph__rows > li")).toHaveLength(2);
    // Return dates are already stated inside the version and its sittings. They
    // must not become overlapping labels on the version axis as well.
    expect(container.querySelectorAll(".vt-graph__axis-label").length).toBeLessThanOrEqual(2);
  });

  it("opens on the most recently worked version", () => {
    renderTimeline();

    expect(screen.getByRole("heading", { name: "Pers EP v3.als" })).toBeInTheDocument();

    // The inspector lists the version's LINEAGE, never its sittings. It used to
    // carry a second sitting list alongside the one in the detail below, in a
    // different unit ("work events" vs "changes") and a different length
    // (captures vs sittings) — two answers to one question on one screen.
    expect(screen.queryByLabelText("Sittings in this version")).toBeNull();
    expect(screen.getByLabelText("Versions in this project")).toHaveTextContent("1 return");
  });

  it("changes the selected version without turning sittings into graph nodes", async () => {
    const user = userEvent.setup();
    renderTimeline();

    await user.click(
      within(screen.getByLabelText("Versions in this project")).getByRole("button", {
        name: /Pers EP\.als/,
      }),
    );

    expect(screen.getByRole("heading", { name: "Pers EP.als" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Sittings in this version")).toBeNull();
    expect(within(screen.getByLabelText("Versions in this project")).getAllByRole("button")).toHaveLength(3);
  });

  it("opens a version-scoped report from the version's newest sitting", async () => {
    const user = userEvent.setup();
    const { onOpenReport } = renderTimeline();

    await user.click(
      within(screen.getByLabelText("Versions in this project")).getByRole("button", {
        name: /Pers EP\.als/,
      }),
    );
    await user.click(screen.getByRole("button", { name: "Open report" }));

    expect(onOpenReport).toHaveBeenCalledWith("v1-return", "version");

    // The per-capture workspace is stashed, not routed to. A button that opens
    // a second, competing answer to "what happened in this version" must not
    // come back without a deliberate decision.
    expect(screen.queryByRole("button", { name: "Open workspace" })).toBeNull();
  });

  it("retraces each return without a parent-version inventory", async () => {
    // The graph resolves ancestry. Retrace is the captured work trail, not a
    // second report of structural changes since the parent version.
    const depth = buildVersionDepth({
      captures: [
        depthCapture("v1-return", start, [
          { name: "Bass", devices: ["Serum"] },
          { name: "Lead", devices: ["Operator"] },
        ]),
      ],
      parent: {
        name: "Pers EP draft.als",
        capture: depthCapture("parent", start - 60 * hour, [{ name: "Bass", devices: ["Serum"] }]),
      },
    });
    vi.mocked(loadVersionDepth).mockResolvedValue(depth);

    renderTimeline();

    const detail = await screen.findByLabelText("Version detail");

    // One useful heading owns the section. The old stack made the trail read
    // like several nested reports before any work appeared.
    expect(within(detail).getByRole("heading", { name: "1 return, move by move" })).toBeInTheDocument();
    expect(within(detail).queryByText("From the first move to the last")).toBeNull();
    expect(within(detail).queryByText("The work in order")).toBeNull();

    expect(within(detail).queryByText("Changed in the set")).toBeNull();
    expect(within(detail).queryByText("Since Pers EP draft.als")).toBeNull();

    // No version-wide track/device/note rollup appears here. Capture identities
    // can be regenerated across reopens, so summing them would turn repeated
    // work on one track into several imaginary tracks.
    expect(within(detail).queryByLabelText("What the work touched")).toBeNull();
    expect(within(detail).queryByText(/tracks touched|note edits|work changes/i)).toBeNull();

    // And the sittings, each openable on its own trail. Counted as direct
    // children: the movement cards inside a sitting are a list too, so
    // counting every listitem would count the work as extra sittings.
    const sittings = screen.getByLabelText("Sittings in this version, in detail");
    expect(sittings.querySelectorAll(".vt-sittings > li")).toHaveLength(1);
    expect(within(sittings).getByText("Latest return")).toBeInTheDocument();
    expect(within(sittings).getByText("2 movements")).toBeInTheDocument();
    // The sitting opens as a disclosure, and carries its own reading toggle:
    // "what happened at 10:34" and "what did I do to the bass" are different
    // questions and a producer should not have to pick one forever.
    expect(sittings.querySelectorAll(".vt-sittings > li > details")).toHaveLength(1);
    expect(
      within(sittings).getByRole("group", { name: "How to read this sitting" }),
    ).toBeInTheDocument();
    // A producer needs every named move and result here, not the classifier's
    // tally of "sound changes". Each decision is a card, and the labels break
    // the old dot-delimited telemetry string into readable facts.
    const movements = within(sittings).getByLabelText("Every captured movement in this sitting");
    expect(movements.querySelectorAll(".vt-movement-card")).toHaveLength(2);
    expect(within(movements).getByText("Serum — Cutoff")).toBeInTheDocument();
    expect(within(movements).getByText("Operator — Cutoff")).toBeInTheDocument();
    expect(within(movements).getByText("Bass")).toBeInTheDocument();
    expect(within(movements).getByText("Lead")).toBeInTheDocument();
    expect(within(movements).getAllByText("Track")).toHaveLength(2);
    // A continuous value renders as a value, not as a "Result" sentence: its
    // own before and now values, plus a knob that mirrors the physical gesture
    // instead of presenting parameter movement as an unexplained progress bar.
    expect(within(movements).queryByText("Result")).toBeNull();
    expect(within(movements).getAllByText("10%")).toHaveLength(2);
    expect(within(movements).getAllByText("40%")).toHaveLength(2);
    expect(movements.querySelectorAll(".vt-shape--scalar")).toHaveLength(2);
    expect(movements.querySelectorAll(".vt-scalar__knob")).toHaveLength(2);
    expect(movements.querySelector(".vt-scalar__track")).toBeNull();
    expect(movements.querySelector(".vt-device-badge")).toBeNull();
    expect(movements.querySelectorAll("[data-movement-shape='scalar']")).toHaveLength(2);
    expect(movements).not.toHaveTextContent("Serum · Cutoff · Bass · 10% → 40%");
    expect(movements).not.toHaveTextContent("Also changed");
    // Time has its own stable region instead of floating at the far edge of
    // the title row, where it was easy to miss on a wide screen.
    expect(movements.querySelectorAll(".vt-movement-time")).toHaveLength(2);
    expect(within(movements).queryByText("At")).toBeNull();
    expect(within(movements).queryByText("Time")).toBeNull();
  });

  it("renders every decision as a card instead of stopping after three", async () => {
    const tracks = Array.from({ length: 5 }, (_, index) => ({
      name: `Track ${index + 1}`,
      devices: [`Device ${index + 1}`],
    }));
    vi.mocked(loadVersionDepth).mockResolvedValue(buildVersionDepth({
      captures: [depthCapture("complete", start, tracks)],
      parent: null,
    }));

    renderTimeline();

    const movements = await screen.findByLabelText("Every captured movement in this sitting");
    expect(movements.querySelectorAll(".vt-movement-card")).toHaveLength(5);
    tracks.forEach((track) => {
      expect(within(movements).getByText(track.name)).toBeInTheDocument();
      expect(within(movements).getByText(`${track.devices[0]} — Cutoff`)).toBeInTheDocument();
    });
  });

  it("keeps the plugin name in the title without duplicating it as a badge", async () => {
    const capture = depthCapture("serum-device", start, [{ name: "Lead", devices: ["Serum 2"] }]);
    vi.mocked(loadVersionDepth).mockResolvedValue(buildVersionDepth({ captures: [capture], parent: null }));

    renderTimeline();

    const movements = await screen.findByLabelText("Every captured movement in this sitting");
    expect(within(movements).getByRole("heading", { name: "Serum 2 — Cutoff" })).toBeInTheDocument();
    expect(movements.querySelector(".vt-device-badge")).toBeNull();
  });

  it("gives a repeated movement its own first-to-last time rail", async () => {
    const capture = depthCapture("timed-control", start, [{ name: "foley", devices: ["Mixer"] }]);
    capture.changes.push({
      ...capture.changes[0]!,
      id: "timed-control-later",
      before_value: 0.4,
      after_value: 0.7,
      before_value_percent: 40,
      after_value_percent: 70,
      before_display_value: "40%",
      after_display_value: "70%",
      changed_at_ms: start + 6 * 60_000,
    });
    vi.mocked(loadVersionDepth).mockResolvedValue(buildVersionDepth({ captures: [capture], parent: null }));

    renderTimeline();

    const movements = await screen.findByLabelText("Every captured movement in this sitting");
    const movement = movements.querySelector(".vt-movement-card article") as HTMLElement;
    expect(within(movement).getByLabelText(/Time from .* to .*/)).toBeInTheDocument();
    expect(within(movement).getByText("First")).toBeInTheDocument();
    expect(within(movement).getByText("Last")).toBeInTheDocument();
    expect(within(movement).getByText("5 min span")).toBeInTheDocument();
  });

  it("keeps every movement available with a local Timeline location rail", async () => {
    const tracks = Array.from({ length: 5 }, (_, index) => ({
      name: `Track ${index + 1}`,
      devices: [`Device ${index + 1}`],
    }));
    vi.mocked(loadVersionDepth).mockResolvedValue(buildVersionDepth({
      captures: [depthCapture("long-sitting", start, tracks)],
      parent: null,
    }));

    renderTimeline();

    const movements = await screen.findByLabelText("Every captured movement in this sitting");
    expect(movements.querySelectorAll(".vt-movement-card")).toHaveLength(5);
    expect(movements.querySelector('[data-timeline-active="true"]')).toBeInTheDocument();
    const location = screen.getByLabelText("Timeline location");
    expect(within(location).getByText("Movement 1 / 5")).toBeInTheDocument();
    expect(within(location).getByRole("button", { name: "Previous" })).toBeDisabled();
    expect(within(location).getByRole("button", { name: "Next" })).toBeEnabled();
    expect(within(location).queryByRole("combobox")).not.toBeInTheDocument();
  });

  it("keeps every repeated nudge available under its movement card", async () => {
    const capture = depthCapture("repeated", start, [{ name: "Bass", devices: ["Serum"] }]);
    const first = capture.changes[0]!;
    capture.changes = [
      { ...first, id: "nudge-1", before_display_value: "10%", after_display_value: "20%", observed_arrangement_position: "Bar 9 · Beat 1" },
      { ...first, id: "nudge-2", before_display_value: "20%", after_display_value: "30%", observed_arrangement_position: "Bar 9 · Beat 2", changed_at_ms: first.changed_at_ms + 1_000 },
      { ...first, id: "nudge-3", before_display_value: "30%", after_display_value: "40%", observed_arrangement_position: "Bar 9 · Beat 3", changed_at_ms: first.changed_at_ms + 2_000 },
    ];
    vi.mocked(loadVersionDepth).mockResolvedValue(buildVersionDepth({ captures: [capture], parent: null }));

    renderTimeline();

    const movements = await screen.findByLabelText("Every captured movement in this sitting");
    expect(movements.querySelectorAll(".vt-movement-card")).toHaveLength(1);
    expect(within(movements).getByText("All 3 captured movements")).toBeInTheDocument();
    expect(movements.querySelectorAll(".vt-movement-card__evidence li")).toHaveLength(3);
    expect(within(movements).getByText("10% → 20%")).toBeInTheDocument();
    expect(within(movements).getByText("20% → 30%")).toBeInTheDocument();
    expect(within(movements).getByText("30% → 40%")).toBeInTheDocument();
    expect(within(movements).getAllByText(/Song position: Bar 9, beat/)).toHaveLength(3);
  });

  it("renders MIDI as a musical change with a before-and-after pitch scale", async () => {
    const capture = depthCapture("midi", start, [{ name: "Bass", devices: ["Serum"] }]);
    const noteEdit: NoteEdit = {
      id: "pitch-move",
      track_name: "Bass",
      track_id: "track-Bass",
      clip_name: "Untitled clip",
      clip_id: "clip-1",
      change_kind: "notes_edited",
      note_count: 1,
      previous_note_count: 1,
      distinct_pitches: 1,
      pitch_min: 90,
      pitch_max: 90,
      previous_pitch_min: 77,
      previous_pitch_max: 77,
      pitch_range: "F#5",
      previous_pitch_range: "F4",
      velocity_mean: 100,
      length_beats: 20,
      previous_midi_notes: [{
        note_id: 1,
        pitch: 77,
        start_time: 0,
        duration: 1,
        velocity: 100,
        mute: false,
        probability: 1,
        velocity_deviation: 0,
        release_velocity: 64,
      }],
      midi_notes: [{
        note_id: 1,
        pitch: 90,
        start_time: 0,
        duration: 1,
        velocity: 100,
        mute: false,
        probability: 1,
        velocity_deviation: 0,
        release_velocity: 64,
      }],
      midi_notes_truncated: false,
      previous_midi_notes_truncated: false,
      note_snapshot_version: 2,
      summary: "Untitled clip moved F4 to F#5",
      observed_arrangement_position: "Bar 17 · Beat 2",
      changed_at_ms: start + 60_000,
    };
    capture.changes = [];
    capture.noteEdits = [noteEdit];
    vi.mocked(loadVersionDepth).mockResolvedValue(buildVersionDepth({ captures: [capture], parent: null }));

    renderTimeline();

    const movements = await screen.findByLabelText("Every captured movement in this sitting");
    expect(within(movements).getByText("MIDI note edit")).toBeInTheDocument();
    expect(movements.querySelector(".vt-movement-card[data-work-kind='writing'] .vt-movement-card__icon.is-midi"))
      .not.toBeNull();
    expect(within(movements).getByRole("heading", { name: "Moved F4 → F#5" })).toBeInTheDocument();
    expect(within(movements).getByText("Rewritten notes")).toBeInTheDocument();
    const facts = movements.querySelector(".vt-movement-card__facts");
    expect(facts).not.toBeNull();
    expect(within(facts as HTMLElement).getByText("1 note")).toBeInTheDocument();
    expect(within(movements).getByText("20 beats")).toBeInTheDocument();
    expect(within(movements).getByLabelText("Exact captured MIDI pattern")).toBeInTheDocument();
    expect(within(movements).getAllByText("Clip start").length).toBeGreaterThan(0);
    // The roll is captioned in bars now, not raw quarter-notes: Ableton's ruler
    // reads 1.1 · 1.2 · 1.3, and "20 quarter-note beats" is Live's internal unit
    // in the wrong language.
    expect(within(movements).getByText(/5 bars/)).toBeInTheDocument();
    expect(within(movements).queryByText(/quarter-note/)).toBeNull();
    expect(movements.querySelectorAll(".vt-midi-pattern__row svg")).toHaveLength(2);
    expect(movements.querySelectorAll(".vt-midi-roll__note")).toHaveLength(2);
    expect(movements.querySelectorAll(".vt-midi-roll__key").length).toBeGreaterThanOrEqual(24);
    expect(movements.querySelectorAll(".vt-midi-roll__beat-label").length).toBeGreaterThan(0);
    expect(within(movements).getByText("Piano roll")).toBeInTheDocument();
    expect(within(movements).getByText("Show all captured notes · 1 before · 1 after")).toBeInTheDocument();
    expect(movements).not.toHaveTextContent("Chance 100%");
    expect(movements).not.toHaveTextContent("Velocity variation 0");
    expect(movements).not.toHaveTextContent("Release velocity 64");
    expect(movements).toHaveTextContent("Bar 17, beat 2");
    expect(movements).toHaveTextContent("At");
    expect(movements).not.toHaveTextContent("Moved to");
    expect(within(movements).queryByLabelText(/Position context: this is Ableton's playhead/)).not.toBeInTheDocument();
    expect(movements).not.toHaveTextContent("Untitled clip");
  });

  it("names the exact pitches in a new MIDI part instead of showing only E3-A3", async () => {
    const capture = depthCapture("midi-part", start, [{ name: "14-MIDI", devices: ["Operator"] }]);
    capture.changes = [];
    capture.noteEdits = [{
      id: "new-part",
      track_name: "14-MIDI",
      track_id: "track-14-MIDI",
      clip_name: null,
      clip_id: "clip-2",
      change_kind: "notes_added",
      note_count: 3,
      previous_note_count: 0,
      distinct_pitches: 3,
      pitch_min: 64,
      pitch_max: 69,
      previous_pitch_min: null,
      previous_pitch_max: null,
      pitch_range: "E3-A3",
      previous_pitch_range: null,
      velocity_mean: 100,
      length_beats: 4,
      midi_notes: [64, 67, 69].map((pitch, index) => ({
        note_id: index + 1,
        pitch,
        start_time: index,
        duration: 0.5,
        velocity: 100,
        mute: false,
        probability: null,
        velocity_deviation: null,
        release_velocity: null,
      })),
      previous_midi_notes: [],
      midi_notes_truncated: false,
      previous_midi_notes_truncated: false,
      note_snapshot_version: 2,
      summary: "3 notes (+3), E3-A3",
      observed_arrangement_position: "Bar 93 · Beat 1",
      changed_at_ms: start + 60_000,
    }];
    vi.mocked(loadVersionDepth).mockResolvedValue(buildVersionDepth({ captures: [capture], parent: null }));

    renderTimeline();

    const movements = await screen.findByLabelText("Every captured movement in this sitting");
    expect(within(movements).getByRole("heading", { name: "Wrote a new part" })).toBeInTheDocument();
    // The piano-roll header already names the exact pitches; repeating the
    // same inventory in the facts grid only makes the card taller.
    expect(within(movements).queryByText("Pitches used (3)")).toBeNull();
    expect(within(movements).getByText("E3 · G3 · A3")).toBeInTheDocument();
    expect(movements.querySelectorAll(".vt-midi-roll__note.is-after")).toHaveLength(3);
    const midiFacts = movements.querySelector(".vt-midi-fact-stack");
    expect(midiFacts).not.toBeNull();
    expect(midiFacts?.querySelectorAll(":scope > div")[0]).toHaveTextContent("Clip length4 beats");
    expect(midiFacts?.querySelectorAll(":scope > div")[1]).toHaveTextContent("Notes0 → 3 notes");
    const factLabels = [...movements.querySelectorAll(".vt-movement-card__facts dt")]
      .map((label) => label.textContent);
    expect(factLabels).toEqual(["Track", "Edit", "Clip length", "Notes"]);
    expect(movements).not.toHaveTextContent("3 notes (+3), E3-A3");
  });

  it("explains a legacy min-max fingerprint as a lowest-to-highest span", async () => {
    const capture = depthCapture("legacy-midi", start, [{ name: "14-MIDI", devices: ["Operator"] }]);
    capture.changes = [];
    capture.noteEdits = [{
      id: "legacy-part",
      track_name: "14-MIDI",
      track_id: "track-14-MIDI",
      clip_name: null,
      clip_id: "clip-legacy",
      change_kind: "notes_added",
      note_count: 3,
      previous_note_count: 0,
      distinct_pitches: 3,
      pitch_min: 64,
      pitch_max: 69,
      previous_pitch_min: null,
      previous_pitch_max: null,
      pitch_range: "E3-A3",
      previous_pitch_range: null,
      velocity_mean: 100,
      length_beats: 4,
      summary: "3 notes (+3), E3-A3",
      observed_arrangement_position: "Bar 93 · Beat 1",
      changed_at_ms: start + 60_000,
    }];
    vi.mocked(loadVersionDepth).mockResolvedValue(buildVersionDepth({ captures: [capture], parent: null }));

    renderTimeline();

    const movements = await screen.findByLabelText("Every captured movement in this sitting");
    expect(within(movements).getByText("Pitch span · lowest to highest")).toBeInTheDocument();
    expect(within(movements).getByText("E3 to A3")).toBeInTheDocument();
    expect(movements).not.toHaveTextContent("E3-A3");
  });

  it("shows clip creation as location and length facts without a movement bar", async () => {
    const capture = depthCapture("placed-clip", start, [{ name: "Bass", devices: ["Operator"] }]);
    capture.changes = [];
    capture.clipEvents = [{
      id: "clip-at-16",
      event_type: "midi_clip_created",
      track_name: "Bass",
      track_id: "track-Bass",
      clip_name: "Hook",
      sample_name: null,
      arrangement_start_beats: 16,
      arrangement_end_beats: 32,
      observed_arrangement_position: "Bar 9 · Beat 1",
      changed_at_ms: start + 60_000,
    }];
    vi.mocked(loadVersionDepth).mockResolvedValue(buildVersionDepth({ captures: [capture], parent: null }));

    renderTimeline();

    const movements = await screen.findByLabelText("Every captured movement in this sitting");
    expect(within(movements).getByText("Created at")).toBeInTheDocument();
    expect(within(movements).getByText("Bar 9, beat 1")).toBeInTheDocument();
    expect(within(movements).getByText("Length")).toBeInTheDocument();
    expect(within(movements).getByText("16 beats")).toBeInTheDocument();
    expect(within(movements).getByLabelText("Clip created at Bar 9, beat 1; 16 beats long")).toBeInTheDocument();
    expect(movements.querySelector(".vt-span__grid")).toBeNull();
    expect(movements).not.toHaveTextContent("quarter-note beats");
    expect(movements).not.toHaveTextContent("Bar 5");
  });

  it("names an unnamed clip by the action that actually happened", async () => {
    const capture = depthCapture("unnamed-clip", start, [{ name: "14-MIDI", devices: ["Operator"] }]);
    capture.changes = [];
    capture.clipEvents = [{
      id: "new-midi-clip",
      event_type: "midi_clip_created",
      track_name: "14-MIDI",
      track_id: "track-14-MIDI",
      clip_name: null,
      sample_name: null,
      arrangement_start_beats: 368,
      arrangement_end_beats: 372,
      observed_arrangement_position: "Bar 93 · Beat 1",
      changed_at_ms: start + 60_000,
    }];
    vi.mocked(loadVersionDepth).mockResolvedValue(buildVersionDepth({ captures: [capture], parent: null }));

    renderTimeline();

    const movements = await screen.findByLabelText("Every captured movement in this sitting");
    expect(within(movements).getByRole("heading", { name: "MIDI clip created" })).toBeInTheDocument();
    expect(movements).not.toHaveTextContent("Clip action");
    expect(movements).not.toHaveTextContent("Untitled clip");
  });

  it("orients each row by real returns rather than cross-capture totals", () => {
    renderTimeline();

    const rows = screen.getByLabelText("Versions in this project");
    expect(within(rows).getAllByText(/^1 return ·/)).toHaveLength(3);
    expect(within(rows).queryByText(/other tracks|devices|note edits/i)).toBeNull();
  });

  it("calls a later return to the same file a return, not another track or capture", () => {
    const returningProject: SavedProject = {
      ...project,
      id: "returning",
      display_name: "Returning",
      captures: [
        { ...sitting("first", "Returning", 0), project_id: "returning" },
        { ...sitting("later", "Returning", 8), project_id: "returning" },
      ],
    };

    render(
      <VersionTimelineScreen
        projects={[returningProject]}
        projectId="returning"
        onSelectProject={vi.fn()}
        onOpenReport={vi.fn()}
        onOpenProjects={vi.fn()}
      />,
    );

    expect(screen.getByText(/^2 returns$/)).toBeInTheDocument();
    expect(screen.getByLabelText("Versions in this project")).not.toHaveTextContent("→");
  });

  it("keeps the graph to versions and nothing else", () => {
    // A "Retrace N sittings" disclosure used to open inside the lane, pushing
    // the version points apart and leaving a screen of empty rail behind
    // whichever row was open — and reading a whole version bundle per row on
    // top of the one the detail below was already reading.
    //
    // The graph is the navigator: which files exist, how they descend, when.
    // What happened inside a version belongs to the detail below.
    const { container } = renderTimeline();

    const rows = screen.getByLabelText("Versions in this project");
    expect(within(rows).queryByText(/Retrace/)).toBeNull();
    expect(rows.querySelector("details")).toBeNull();
    expect(container.querySelector(".vt-work__trail")).toBeNull();

    // The row still says how much work is in there — it just does not open it.
    expect(within(rows).getAllByText(/return/).length).toBeGreaterThan(0);
  });

  it("keeps the timeline rows independent of aggregate report loading", () => {
    renderTimeline();

    const rows = screen.getByLabelText("Versions in this project");
    expect(within(rows).getAllByRole("button")).toHaveLength(3);
    expect(within(rows).getAllByText(/^1 return ·/)).toHaveLength(3);
  });

  it("shows the Report's loader while it reads, not a bare sentence", () => {
    // A line of text above an empty half-screen read as a surface that had
    // finished and found nothing. The Report runs the same loader over the same
    // data, so the wait should look the same on both.
    vi.mocked(loadVersionDepth).mockImplementation(() => new Promise(() => {}));

    renderTimeline();

    expect(screen.getByLabelText("Reading the work inside this version")).toBeInTheDocument();
    expect(screen.queryByText(/Reading the work inside this version…/)).toBeNull();
  });

  it("reads a switch as a state, never as 'changed'", async () => {
    // The complaint that started this: a device turned off reported "changed",
    // which is the one thing a producer already knows and the one thing that
    // does not help them retrace.
    const capture = depthCapture("v1-return", start, [{ name: "Bass", devices: ["EQ Eight"] }]);
    capture.changes = [
      {
        ...capture.changes[0]!,
        id: "toggle",
        parameter_name: "Arp Enable",
        is_quantized: true,
        before_value: 1,
        after_value: 0,
        before_display_value: "On",
        after_display_value: "Off",
      },
    ];
    vi.mocked(loadVersionDepth).mockResolvedValue(
      buildVersionDepth({ captures: [capture], parent: null }),
    );

    renderTimeline();

    const detail = await screen.findByLabelText("Version detail");
    expect(detail.querySelector(".vt-shape--binary")).not.toBeNull();
    // Both states drawn, so the one it landed in reads as a position.
    expect(within(detail).getByText("Off")).toBeInTheDocument();
    expect(within(detail).getByText("On")).toBeInTheDocument();
    expect(detail.querySelectorAll(".vt-state-icon svg")).toHaveLength(2);
    expect(detail.querySelector(".vt-shape--scalar")).toBeNull();
  });

  it("uses a drawn structural-change icon instead of a raw sign", async () => {
    const capture = depthCapture("v1-return", start, [{ name: "Bass", devices: ["Serum"] }]);
    capture.changes = [];
    capture.session.events = [{
      id: "device-added",
      type: "device_added",
      timestamp_ms: start + 60_000,
      summary: "Added Serum",
      title: "Device added",
      description: "Serum was added to Bass",
      source: "test",
      payload: null,
      session_id: capture.session.id,
      track: "Bass",
      track_type: "midi",
      device: "Serum",
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
    }];
    vi.mocked(loadVersionDepth).mockResolvedValue(
      buildVersionDepth({ captures: [capture], parent: null }),
    );

    renderTimeline();

    const movement = (await screen.findByLabelText("Every captured movement in this sitting"))
      .querySelector(".vt-movement-card");
    expect(movement?.querySelector(".vt-change-icon svg")).not.toBeNull();
    expect(movement?.querySelector(".vt-diff__sign")).toBeNull();
  });

  it("marks where the work was written to disk", async () => {
    const capture = depthCapture("v1-return", start, [{ name: "Bass", devices: ["Serum"] }]);
    vi.mocked(loadVersionDepth).mockResolvedValue(
      buildVersionDepth({
        captures: [capture],
        parent: null,
        saves: [{ sessionId: "v1-return", savedAtMs: start + 90_000 }],
      }),
    );

    renderTimeline();

    const detail = await screen.findByLabelText("Version detail");
    expect(detail.querySelector(".vt-trail-save")).not.toBeNull();
    expect(within(detail).getByText(/^Saved · /)).toBeInTheDocument();
  });

  it("keeps the parent-version diff out of the retrace", async () => {
    renderTimeline();

    await screen.findByLabelText("Version detail");
    expect(screen.queryByLabelText("Changed since the parent version")).toBeNull();
    expect(screen.queryByText("Changed in the set")).toBeNull();
  });

  it("lets one sitting be read by track instead of by the clock", async () => {
    const user = userEvent.setup();
    const capture = depthCapture("v1-return", start, [
      { name: "Bass", devices: ["Serum"] },
      { name: "Lead", devices: ["Operator"] },
    ]);
    vi.mocked(loadVersionDepth).mockResolvedValue(
      buildVersionDepth({ captures: [capture], parent: null }),
    );

    renderTimeline();

    const detail = await screen.findByLabelText("Version detail");
    await user.click(within(detail).getByRole("button", { name: "By track" }));

    expect(
      within(detail).getByLabelText("Every captured movement, grouped by track"),
    ).toBeInTheDocument();
    expect(within(detail).getAllByText("1 movement")).toHaveLength(2);
    expect(
      within(detail).queryByLabelText("Every captured movement in this sitting"),
    ).toBeNull();
  });

  it("sorts a sitting into movement-type sections", async () => {
    const user = userEvent.setup();
    const capture = depthCapture("v1-return", start, [
      { name: "Bass", devices: ["Serum"] },
      { name: "Lead", devices: ["Mixer"] },
    ]);
    capture.changes[1] = {
      ...capture.changes[1]!,
      device_name: "Mixer",
      parameter_name: "Volume",
    };
    vi.mocked(loadVersionDepth).mockResolvedValue(
      buildVersionDepth({ captures: [capture], parent: null }),
    );

    renderTimeline();

    const detail = await screen.findByLabelText("Version detail");
    await user.click(within(detail).getByRole("button", { name: "By type" }));

    const byType = within(detail).getByLabelText("Every captured movement, grouped by type");
    expect(byType.querySelectorAll(":scope > li")).toHaveLength(2);
    expect(within(byType).getByText("Mixing")).toBeInTheDocument();
    expect(within(byType).getByText("Sound & samples")).toBeInTheDocument();
    const mixCard = byType.querySelector("[data-work-kind='mixing']");
    expect(mixCard).not.toBeNull();
    expect(mixCard?.querySelectorAll(".vt-scalar__meter")).toHaveLength(2);
    expect(byType.querySelectorAll(".vt-scalar__knob")).toHaveLength(1);
    expect(byType.querySelectorAll(".vt-scalar__meter-fill")).toHaveLength(2);
    expect(byType.querySelectorAll(".vt-scalar__meter-change")).toHaveLength(1);
    expect(mixCard?.querySelector(".vt-shape__arrow")).toBeNull();
    expect(within(mixCard as HTMLElement).getByText("Before")).toBeInTheDocument();
    expect(within(mixCard as HTMLElement).getByText("After")).toBeInTheDocument();
    expect(within(mixCard as HTMLElement).getAllByLabelText(/0 at the top and negative infinity at the bottom/)).toHaveLength(2);
    expect(
      within(detail).queryByLabelText("Every captured movement in this sitting"),
    ).toBeNull();
  });

  it("marks inferred lineage visibly on the graph", () => {
    const { container } = renderTimeline();
    expect(container.querySelectorAll(".vt-graph__drawing path.is-inferred").length).toBeGreaterThan(0);
    expect(screen.getByText(/Dashed links are inferred/)).toBeInTheDocument();
  });
});
