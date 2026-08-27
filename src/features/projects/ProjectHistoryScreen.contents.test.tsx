// @vitest-environment jsdom

// The selected commit's expanded panel, with the backend answering.
//
// The other screen suite runs with no backend at all, which proves navigation
// but leaves the panel permanently in its loading state. This one stubs the
// four calls so the parts that only exist once data arrives — the diff against
// the parent, the rack contents, the derived headline — are actually rendered
// and asserted rather than assumed.

import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import type { SavedProject, SavedSessionMetadata } from "../../types/recall";
import type { DeviceObj, ProjectSchema, RackObj, TrackObj } from "../../types/schema";

const getParameterChanges = vi.fn();
const getNoteEdits = vi.fn();
const getTimelineClipEvents = vi.fn();
const getProjectSchema = vi.fn();
const materializeSessionSchema = vi.fn();

vi.mock("../../lib/schema/api", () => ({
  getParameterChanges: (...args: unknown[]) => getParameterChanges(...args),
  getNoteEdits: (...args: unknown[]) => getNoteEdits(...args),
  getTimelineClipEvents: (...args: unknown[]) => getTimelineClipEvents(...args),
  getProjectSchema: (...args: unknown[]) => getProjectSchema(...args),
  materializeSessionSchema: (...args: unknown[]) => materializeSessionSchema(...args),
}));

const { ProjectHistoryScreen } = await import("./ProjectHistoryScreen");

const minute = 60 * 1000;
const hour = 60 * minute;
const start = 1_720_000_000_000;

function work(id: string, set: string, atHours: number): SavedSessionMetadata {
  const startedAt = start + atHours * hour;
  return {
    id,
    name: "capture",
    project_id: "p",
    capture_name: null,
    capture_status: "ended",
    project_name: "nightfall",
    project_path: "C:\\Music\\nightfall",
    als_path: `C:\\Music\\nightfall\\${set}.als`,
    take_origin: "recorded",
    display_name: null,
    started_at_ms: startedAt,
    ended_at_ms: startedAt + 45 * minute,
    last_updated_at_ms: startedAt + 45 * minute,
    event_count: 120,
    creative_event_count: 30,
    heartbeat_count: 0,
  };
}

const project: SavedProject = {
  id: "p",
  display_name: "Nightfall",
  ableton_name: "Nightfall",
  ableton_path: "C:\\Music\\nightfall",
  archived_at_ms: null,
  created_at_ms: start,
  updated_at_ms: start + 5 * hour,
  last_updated_at_ms: start + 5 * hour,
  capture_count: 2,
  active_capture_count: 0,
  // c2 is the newest, so it is selected on arrival and c1 is its parent.
  captures: [work("c1", "nightfall", 0), work("c2", "nightfall", 3)],
};

function device(name: string, rack: RackObj | null = null): DeviceObj {
  return {
    id: `dev-${name}`,
    track_id: "t",
    ableton_id: name,
    name,
    role: "audio_effect",
    chain_index: 0,
    enabled: true,
    initial_enabled: true,
    host_parameter_count: 0,
    class_name: null,
    preset_name: null,
    parameters: [],
    rack,
  };
}

function track(name: string, devices: DeviceObj[] = []): TrackObj {
  return {
    id: `track-${name}`,
    ableton_id: name,
    name,
    number: 1,
    type: "midi",
    color: null,
    group_id: null,
    chain_index: 0,
    devices,
  };
}

function schema(tracks: TrackObj[]): ProjectSchema {
  return { session_id: "s", name: "nightfall", has_snapshot: true, tracks };
}

const drumRack: RackObj = {
  chains: [],
  drum_pads: [
    { ableton_id: "p1", name: "Kick", note: 36 },
    { ableton_id: "p2", name: "Snare", note: 38 },
  ],
};

// c1 had Drums with a Drum Rack. c2 added a Bass track and a Saturator.
const parentStructure = schema([track("Drums", [device("Drum Rack", drumRack)])]);
const commitStructure = schema([
  track("Drums", [device("Drum Rack", drumRack), device("Saturator")]),
  track("Bass"),
]);

function renderScreen() {
  render(
    <ProjectHistoryScreen
      projects={[project]}
      projectId="p"
      onSelectProject={vi.fn()}
      onOpenReport={vi.fn()}
      onOpenWorkspace={vi.fn()}
      onOpenProjects={vi.fn()}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  materializeSessionSchema.mockResolvedValue(undefined);
  getNoteEdits.mockResolvedValue([]);
  getTimelineClipEvents.mockResolvedValue([]);
  getParameterChanges.mockResolvedValue([
    {
      id: "pc1",
      event_type: "parameter_changed",
      track_name: "Drums",
      track_id: "t1",
      device_id: "d1",
      device_name: "Saturator",
      parameter_name: "Drive",
      before_display_value: "0.0 dB",
      after_display_value: "4.2 kHz",
      changed_at_ms: start,
    },
    {
      id: "pc2",
      event_type: "parameter_changed",
      track_name: "Drums",
      track_id: "t1",
      device_id: "d1",
      device_name: "Saturator",
      parameter_name: "Drive",
      before_display_value: "0.0 dB",
      after_display_value: "4.2 kHz",
      changed_at_ms: start + 1000,
    },
  ]);
  getProjectSchema.mockImplementation(async (sessionId: string) =>
    sessionId === "c1" ? parentStructure : commitStructure,
  );
});

describe("ProjectHistoryScreen · the loaded panel", () => {
  it("shows what changed in the set since the parent commit", async () => {
    renderScreen();
    const diff = await screen.findByLabelText("What changed in the set");
    expect(within(diff).getByText("Bass")).toBeInTheDocument();
    expect(within(diff).getByText("Saturator")).toBeInTheDocument();
  });

  it("compares against the PARENT, not against nothing", async () => {
    renderScreen();
    await screen.findByLabelText("What changed in the set");
    // Both sides are fetched, or there is no comparison to make.
    expect(getProjectSchema).toHaveBeenCalledWith("c2");
    expect(getProjectSchema).toHaveBeenCalledWith("c1");
  });

  it("materializes before reading, or the snapshot reports as missing", async () => {
    renderScreen();
    await screen.findByLabelText("What changed in the set");
    expect(materializeSessionSchema).toHaveBeenCalledWith("c2");
  });

  it("shows what is inside a rack on a track the commit touched", async () => {
    renderScreen();
    const racks = await screen.findByLabelText("Racks on the tracks you worked");
    expect(within(racks).getByText("Drum Rack")).toBeInTheDocument();
    expect(within(racks).getByText("Kick")).toBeInTheDocument();
    // Live's own note naming, which is how a producer finds the pad they mean.
    expect(within(racks).getByText("C1")).toBeInTheDocument();
  });

  it("says outright that the controls inside a rack are not watched", async () => {
    // Listing the contents while implying their moves were captured is the
    // overclaim §1 forbids.
    renderScreen();
    const racks = await screen.findByLabelText("Racks on the tracks you worked");
    expect(within(racks).getByText(/does not watch the controls inside/)).toBeInTheDocument();
  });

  it("derives the commit's headline from what the work concentrated on", async () => {
    renderScreen();
    await waitFor(() => {
      // Every row gets one, not just the open one — a list of bare change
      // counts says nothing about the work.
      expect(screen.getAllByText(/Worked Drums/).length).toBeGreaterThan(0);
    });
  });

  it("gives every row a headline, not only the selected one", async () => {
    renderScreen();
    await waitFor(() => {
      const rows = Array.from(
        screen.getByLabelText("Sessions").querySelectorAll<HTMLElement>(".ph-row__name"),
      );
      expect(rows).toHaveLength(2);
      expect(rows.every((row) => /Worked/.test(row.textContent ?? ""))).toBe(true);
    });
  });

  it("says it cannot tell when a snapshot is missing, rather than 'nothing changed'", async () => {
    getProjectSchema.mockResolvedValue({ ...commitStructure, has_snapshot: false });
    renderScreen();
    expect(await screen.findByText(/can.t say what changed/)).toBeInTheDocument();
  });

  it("opens the session's work in place, without sending you elsewhere", async () => {
    // This is what used to mean leaving for the old workspace. A history is
    // only useful if the detail of any step opens where you are standing.
    renderScreen();
    const steps = await screen.findByLabelText("What happened, in order");
    expect(within(steps).getAllByRole("listitem").length).toBeGreaterThan(0);
  });

  it("shows where a control was left, not just that it moved", async () => {
    renderScreen();
    const steps = await screen.findByLabelText("What happened, in order");
    // The landing point is the decision worth reading back.
    expect(within(steps).getAllByText(/4.2 kHz/).length).toBeGreaterThan(0);
  });

  it("shows no diff at all for the root commit", async () => {
    renderScreen();
    await screen.findByLabelText("What changed in the set");

    // Select the oldest commit, which has no parent.
    const rows = Array.from(
      screen.getByLabelText("Sessions").querySelectorAll<HTMLElement>(".ph-row"),
    );
    (rows[rows.length - 1]!.querySelector(".ph-row__hit") as HTMLElement).click();

    await waitFor(() => {
      expect(
        screen.queryByLabelText("What changed in the set"),
      ).not.toBeInTheDocument();
    });
  });
});
