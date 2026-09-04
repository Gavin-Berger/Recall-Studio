// @vitest-environment jsdom

// The selected commit's expanded panel, with the backend answering.
//
// The other screen suite runs with no backend at all, which proves navigation
// but leaves the panel permanently in its loading state. This one stubs the
// four calls so the parts that only exist once data arrives — the diff against
// the parent, the rack contents, the derived headline — are actually rendered
// and asserted rather than assumed.

import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
  return { session_id: "s", name: "nightfall", has_snapshot: true, signature_numerator: 4, signature_denominator: 4, meter_changed: false, tracks };
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
  // The selected session opens in the information pane on arrival. This guard
  // keeps the suite tolerant of the first render while React applies that
  // selection effect.
  const details = screen.queryByRole("button", { name: "Details" });
  if (details) fireEvent.click(details);
}

beforeEach(() => {
  vi.clearAllMocks();
  materializeSessionSchema.mockResolvedValue(undefined);
  getNoteEdits.mockResolvedValue([]);
  getTimelineClipEvents.mockResolvedValue([]);
  // Spread across the session on purpose: steps are cut on the pauses between
  // work, so changes seconds apart collapse into ONE step and the expanded
  // graph would look identical to the collapsed one.
  getParameterChanges.mockResolvedValue(
    [0, 95, 190].map((offsetMinutes, index) => ({
      id: `pc${index}`,
      event_type: "parameter_changed",
      track_name: "Drums",
      track_id: "t1",
      device_id: "d1",
      device_name: "Saturator",
      parameter_name: "Drive",
      before_display_value: "0.0 dB",
      after_display_value: "4.2 kHz",
      changed_at_ms: start + offsetMinutes * minute,
    })),
  );
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

  it("reveals the named items behind a counted tail", async () => {
    getParameterChanges.mockResolvedValue(
      Array.from({ length: 6 }, (_, index) => ({
        id: `parameter-${index}`,
        event_type: "parameter_changed",
        track_name: "Drums",
        track_id: "t1",
        device_id: "d1",
        device_name: "Saturator",
        parameter_name: `Parameter ${index + 1}`,
        before_display_value: "0.0 dB",
        after_display_value: "4.2 kHz",
        changed_at_ms: start + index * minute,
      })),
    );
    renderScreen();

    const more = await screen.findByRole("button", { name: "+6 more" });
    fireEvent.click(more);

    expect(screen.getByRole("button", { name: "Show fewer" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.getByText("Parameter 6")).toBeInTheDocument();
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

  it("lets the clock say when, without restating it as a gap", async () => {
    // Each step already carries its own time, and the steps read in order, so
    // "1m later" under 8:16 PM beneath 8:15 PM says the same thing twice in two
    // units — on every row of a list that is nothing but rows.
    renderScreen();
    const steps = await screen.findByLabelText("What happened, in order");

    expect(within(steps).queryByText(/\d+[mhd] later/)).not.toBeInTheDocument();
    // The times themselves stay: removing the noise must not remove the fact.
    expect(within(steps).getAllByText(/\d?\d:\d\d/).length).toBeGreaterThan(0);
  });

  it("shows where a control was left, not just that it moved", async () => {
    renderScreen();
    const steps = await screen.findByLabelText("What happened, in order");
    // The landing point is the decision worth reading back.
    expect(within(steps).getAllByText(/4.2 kHz/).length).toBeGreaterThan(0);
  });

  it("draws the open session as its steps, and the rest as one node each", async () => {
    // A whole session as one node was too coarse; one node per change would be
    // a log. A step is the unit, and only the session you have open is drawn
    // that finely — the others stay one node so the overview keeps its shape.
    renderScreen();
    await screen.findByLabelText("What happened, in order");

    const graph = within(screen.getByLabelText(/Project map/));
    const nodes = graph.getAllByRole("button");
    // c2 is open and expands into its steps; c1 stays collapsed as one node.
    expect(nodes.length).toBeGreaterThan(2);
    expect(nodes.some((node) => /part of the session you have open/.test(node.getAttribute("aria-label") ?? ""))).toBe(true);
  });

  it("keeps a collapsed session clickable to open it", async () => {
    renderScreen();
    await screen.findByLabelText("What happened, in order");

    const graph = within(screen.getByLabelText(/Project map/));
    const collapsed = graph
      .getAllByRole("button")
      .filter((node) => !/part of the session/.test(node.getAttribute("aria-label") ?? ""));
    expect(collapsed.length).toBeGreaterThan(0);
  });

  it("says where the work lives, so there is a way back to the music", async () => {
    // Every other action on this screen leads further INTO Recall. A producer
    // opening it after two weeks wants the opposite: how do I get back to that?
    renderScreen();
    const back = await screen.findByLabelText("Where this work lives");
    expect(within(back).getByText("nightfall.als")).toBeInTheDocument();
  });

  it("shows the producer's real path, not the normalised one", async () => {
    // The grouping path is lowercased with its separators flipped. Printing it
    // would show a folder the producer does not recognise, and the file opener
    // may not resolve it. Compared as plain text: a regex here would need
    // escaped backslashes, and getting that wrong silently matches nothing.
    renderScreen();
    const back = await screen.findByLabelText("Where this work lives");
    const shown = back.textContent ?? "";
    expect(shown).toContain("C:\\Music\\nightfall");
    expect(shown).not.toContain("c:/music/nightfall");
  });

  it("warns that the set has been worked since, so opening it will not show this", async () => {
    // c1 is the older session; c2 came after it in the same set. Recall holds
    // the record, not the audio, and must not imply the file still looks the
    // way it did that night.
    renderScreen();
    await screen.findByLabelText("Where this work lives");

    const rows = Array.from(
      screen.getByLabelText("Sessions").querySelectorAll<HTMLElement>(".ph-row"),
    );
    fireEvent.click(rows[rows.length - 1]!.querySelector(".ph-row__hit") as HTMLElement);
    // Choosing a row closes the breakdown, so open it again on the new one.
    const details = screen.queryByRole("button", { name: "Details" });
    if (details) fireEvent.click(details);

    await waitFor(() => {
      const back = screen.getByLabelText("Where this work lives");
      expect(back.textContent ?? "").toMatch(/will not show you this/);
    });
  });

  it("never promises the set can be restored", async () => {
    renderScreen();
    const back = await screen.findByLabelText("Where this work lives");
    expect(back.textContent ?? "").not.toMatch(/restore|revert|as it was/i);
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
