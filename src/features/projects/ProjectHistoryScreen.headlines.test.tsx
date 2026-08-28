// @vitest-environment jsdom

// Whether every row in the list gets to say what the work was.
//
// The list prefetches a headline per row and falls back to the set's file name
// when it has none. That fallback is fine for a moment and wrong as a resting
// state: three rows of one real library sat on it permanently and read as
// three sessions that did nothing, next to rows that described themselves.
//
// What made them permanent was the prefetch being interrupted — switching set,
// a capture landing — while one row's read was in flight. This suite holds one
// read open across exactly that interruption.

import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import type { SavedProject, SavedSessionMetadata } from "../../types/recall";

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

// Two sets, so the list can be switched away and back — which is the ordinary
// gesture that tore the prefetch down mid-read.
const project: SavedProject = {
  id: "p",
  display_name: "Nightfall",
  ableton_name: "Nightfall",
  ableton_path: "C:\\Music\\nightfall",
  archived_at_ms: null,
  created_at_ms: start,
  updated_at_ms: start + 20 * hour,
  last_updated_at_ms: start + 20 * hour,
  capture_count: 4,
  active_capture_count: 0,
  captures: [
    work("c1", "nightfall", 0),
    work("c2", "nightfall v2", 8),
    work("c3", "nightfall", 12),
    work("c4", "nightfall", 20),
  ],
};

/**
 * Two moves on one track, which is the least that produces a NAMED headline.
 *
 * One move each and the summary reports the work as evenly spread and counts
 * tracks instead of naming one — correct, but it would not tell this suite's
 * rows apart.
 */
function changesOn(track: string) {
  return [0, 20].map((offsetMinutes, index) => ({
    id: `pc${index}`,
    event_type: "parameter_changed",
    track_name: track,
    track_id: `t-${track}`,
    device_id: "d1",
    device_name: "Saturator",
    parameter_name: index === 0 ? "Drive" : "Output",
    before_display_value: "0.0 dB",
    after_display_value: "4.2 dB",
    changed_at_ms: start + 12 * hour + offsetMinutes * minute,
  }));
}

function rows(): HTMLElement[] {
  return Array.from(
    screen.getByLabelText("Sessions").querySelectorAll<HTMLElement>(".ph-row"),
  );
}

function rowFor(id: string): HTMLElement {
  // c3 is the middle row of the `nightfall` set: newest first is c4, c3, c1.
  const order = ["c4", "c3", "c1"];
  return rows()[order.indexOf(id)]!;
}

beforeEach(() => {
  vi.clearAllMocks();
  materializeSessionSchema.mockResolvedValue(undefined);
  getNoteEdits.mockResolvedValue([]);
  getTimelineClipEvents.mockResolvedValue([]);
  getProjectSchema.mockResolvedValue({
    session_id: "s",
    name: "nightfall",
    has_snapshot: true,
    tracks: [],
  });
});

describe("ProjectHistoryScreen · every row says what the work was", () => {
  it("still names a row whose read was interrupted mid-flight", async () => {
    // c3's first read never settles until we say so. Every other row answers
    // immediately, so the walk is sitting on c3 when the interruption lands.
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let c3Reads = 0;
    getParameterChanges.mockImplementation(async (id: string) => {
      if (id !== "c3") return changesOn("Bass");
      c3Reads += 1;
      if (c3Reads === 1) await held;
      return changesOn("Drums");
    });

    const { rerender } = render(
      <ProjectHistoryScreen
        projects={[project]}
        projectId="p"
        onSelectProject={vi.fn()}
        onOpenReport={vi.fn()}
        onOpenWorkspace={vi.fn()}
        onOpenProjects={vi.fn()}
      />,
    );

    await waitFor(() => expect(c3Reads).toBe(1));

    // The interruption: the project arrives again while c3's read is still
    // out. Every poll for a landing capture does this, and so does switching
    // set — anything that rebuilds the rows tears the walk down where it
    // stands, and the row it was standing on was the row that lost its name.
    rerender(
      <ProjectHistoryScreen
        projects={[{ ...project }]}
        projectId="p"
        onSelectProject={vi.fn()}
        onOpenReport={vi.fn()}
        onOpenWorkspace={vi.fn()}
        onOpenProjects={vi.fn()}
      />,
    );
    release();

    await waitFor(() => {
      expect(within(rowFor("c3")).getByText(/Worked Drums/)).toBeInTheDocument();
    });
  });

  it("does not leave a row resting on the set's file name as its title", async () => {
    getParameterChanges.mockImplementation(async () => changesOn("Drums"));

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

    await waitFor(() => {
      for (const row of rows()) {
        const title = row.querySelector(".ph-row__name")!;
        expect(title.textContent).toMatch(/^Worked Drums/);
      }
    });
  });

  it("asks once per row and does not spin when a read fails", async () => {
    getParameterChanges.mockRejectedValue(new Error("no backend"));

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

    // A failure is an answer too: the row keeps its change count rather than
    // being asked again on every render.
    await waitFor(() => expect(getParameterChanges).toHaveBeenCalled());
    const after = getParameterChanges.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(getParameterChanges.mock.calls.length).toBe(after);
  });
});
