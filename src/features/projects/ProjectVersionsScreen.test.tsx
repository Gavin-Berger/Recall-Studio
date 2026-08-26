// @vitest-environment jsdom

// Integration tests for the versions screen — specifically the seam between the
// version graph and the rest of the screen.
//
// The four pure suites (versionGraph, versionGraphLayout, versionGraphGeometry,
// VersionGraphView) each prove their own module in isolation. None of them
// touches the wiring: that the screen rolls its captures up into versions,
// hands them to the graph, and that picking a node moves the rest of the screen
// to that version. That round trip only exists here, and checking it by hand
// means opening a real project in Ableton — which is the thing these tests
// exist to avoid.

import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { SavedProject, SavedSessionMetadata } from "../../types/recall";
import { ProjectVersionsScreen } from "./ProjectVersionsScreen";

// The screen materializes a schema and reads parameter changes for the selected
// take and the one before it. Both are Tauri round trips with nothing to say
// about lineage, so they are stubbed to the quietest honest answer.
vi.mock("../../lib/schema/api", () => ({
  getParameterChanges: vi.fn(async () => []),
  getProjectSchema: vi.fn(async () => ({ has_snapshot: false, tracks: [] })),
  materializeSessionSchema: vi.fn(async () => undefined),
}));

const minute = 60 * 1000;
const day = 24 * 60 * minute;
const start = 1_720_000_000_000;
const folder = "C:\\Music\\nightfall";

function capture(over: Partial<SavedSessionMetadata> & { id: string }): SavedSessionMetadata {
  return {
    name: "capture",
    project_id: "project-1",
    capture_name: null,
    capture_status: "ended",
    project_name: "nightfall",
    project_path: folder,
    als_path: `${folder}\\nightfall.als`,
    take_origin: "recorded",
    display_name: null,
    started_at_ms: start,
    ended_at_ms: start + minute,
    last_updated_at_ms: start + minute,
    event_count: 10,
    creative_event_count: 8,
    heartbeat_count: 0,
    ...over,
  };
}

/** A sitting against one `.als`, `days` after the project began. */
function sitting(
  id: string,
  file: string,
  days: number,
  over: Partial<SavedSessionMetadata> = {},
): SavedSessionMetadata {
  return capture({
    id,
    als_path: `${folder}\\${file}.als`,
    started_at_ms: start + days * day,
    ended_at_ms: start + days * day + 30 * minute,
    last_updated_at_ms: start + days * day + 30 * minute,
    ...over,
  });
}

// The branch's headline case, as a fixture: a straight run to v3, then the
// producer goes BACK to v3 after v4 already exists and keeps pushing it. v3
// therefore has two sittings, which is both the evidence a fork is inferred
// from and the reason the rail and the graph disagree about how many rows there
// are. Five captures, four versions.
function forkedProject(): SavedProject {
  const captures = [
    sitting("s1", "nightfall v1", 0),
    sitting("s2", "nightfall v2", 1),
    sitting("s3", "nightfall v3", 2),
    sitting("s4", "nightfall v4", 3),
    // Back into v3, after v4 already existed.
    sitting("s5", "nightfall v3", 4, { creative_event_count: 40, event_count: 55 }),
  ];
  return {
    id: "project-1",
    display_name: "nightfall",
    ableton_name: "nightfall",
    ableton_path: folder,
    archived_at_ms: null,
    created_at_ms: start,
    updated_at_ms: start + 4 * day,
    last_updated_at_ms: start + 4 * day,
    capture_count: captures.length,
    active_capture_count: 0,
    captures,
  };
}

function renderScreen(project: SavedProject = forkedProject()) {
  const onOpenTimeline = vi.fn();
  const onOpenRecap = vi.fn();
  render(
    <ProjectVersionsScreen
      project={project}
      connection={{
        connected: false,
        last_heartbeat_ms: null,
        last_message: null,
        bridge_version: null,
      }}
      onBack={vi.fn()}
      onOpenProject={vi.fn(async () => undefined)}
      onRescanFolder={vi.fn(async () => 0)}
      onConnectFolder={vi.fn(async () => 0)}
      onOpenTimeline={onOpenTimeline}
      onOpenRecap={onOpenRecap}
      onDeleteCapture={vi.fn(async () => undefined)}
      onListProjectAlsFiles={vi.fn(async () => [])}
      onRelinkTake={vi.fn(async () => undefined)}
    />,
  );
  return { onOpenTimeline, onOpenRecap };
}

/** The drawn graph, scoped away from the rail so names cannot collide. */
function graph() {
  return within(screen.getByRole("group", { name: "Version lineage" }));
}

function nodeFor(name: string): HTMLElement {
  return graph().getByRole("button", { name: new RegExp(`^${name}\\.`) });
}

function railRowFor(name: string): HTMLElement {
  const row = screen
    .getAllByRole("button", { name: new RegExp(name) })
    .find((element) => element.classList.contains("vr-item"));
  if (!row) throw new Error(`no rail row for ${name}`);
  return row;
}

describe("ProjectVersionsScreen · version graph wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("draws the graph from the project's own captures", () => {
    renderScreen();
    // Four files, not five captures — the screen must hand the graph versions
    // rather than sessions, or the surface collapses back into the rail it was
    // built to replace.
    expect(graph().getAllByRole("button")).toHaveLength(4);
  });

  it("rolls repeat sittings against one file into a single node", () => {
    renderScreen();
    // v3 was worked twice: one node on the graph, two rows on the rail. That
    // difference is the whole reason there are two surfaces.
    expect(nodeFor("nightfall v3")).toBeInTheDocument();
    expect(
      screen
        .getAllByRole("button", { name: /nightfall v3/ })
        .filter((element) => element.classList.contains("vr-item")),
    ).toHaveLength(2);
  });

  it("moves the detail pane to the version picked on the graph", async () => {
    const user = userEvent.setup();
    renderScreen();
    // Newest capture wins by default, so the screen opens on v3's return visit.
    expect(screen.getByRole("region", { name: "Version nightfall v3" })).toBeInTheDocument();

    await user.click(nodeFor("nightfall v1"));

    expect(screen.getByRole("region", { name: "Version nightfall v1" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Version nightfall v3" })).not.toBeInTheDocument();
  });

  it("lands on the most recent sitting of a version, not its first", async () => {
    const user = userEvent.setup();
    const { onOpenTimeline } = renderScreen();

    await user.click(nodeFor("nightfall v1"));
    await user.click(nodeFor("nightfall v3"));
    await user.click(screen.getByRole("button", { name: "Open timeline" }));

    // s5 is the return visit; s3 was the first pass. Picking a version the
    // producer already came back to should open where they left off.
    expect(onOpenTimeline).toHaveBeenCalledWith("s5");
  });

  it("moves the graph selection when the version is picked from the rail", async () => {
    const user = userEvent.setup();
    renderScreen();
    expect(nodeFor("nightfall v3")).toHaveAttribute("aria-pressed", "true");

    await user.click(railRowFor("nightfall v2"));

    // The return trip: the rail selects a capture, the screen maps it back to
    // the file it belongs to, and that node lights up.
    expect(nodeFor("nightfall v2")).toHaveAttribute("aria-pressed", "true");
    expect(nodeFor("nightfall v3")).toHaveAttribute("aria-pressed", "false");
  });

  it("keeps the graph reachable from the keyboard", async () => {
    const user = userEvent.setup();
    renderScreen();

    nodeFor("nightfall v2").focus();
    await user.keyboard("{Enter}");

    expect(screen.getByRole("region", { name: "Version nightfall v2" })).toBeInTheDocument();
  });

  it("draws a version found on disk rather than recorded", () => {
    const project = forkedProject();
    project.captures = [
      ...project.captures,
      sitting("s6", "nightfall v5", 5, {
        take_origin: "scanned",
        event_count: 0,
        creative_event_count: 0,
      }),
    ];
    renderScreen(project);

    // Honest degradation (DESIGN.md §7): the file is real even though Recall
    // never watched it being made, so it belongs on the graph.
    expect(nodeFor("nightfall v5")).toBeInTheDocument();
    expect(graph().getAllByRole("button")).toHaveLength(5);
  });

  it("says why each version hangs where it does", () => {
    renderScreen();
    // Every node carries its parentage reason in its accessible name, so the
    // graph explains itself to a screen reader and not only on hover.
    for (const node of graph().getAllByRole("button")) {
      expect(node.getAttribute("aria-label") ?? "").toMatch(/^nightfall v\d\. .+/);
    }
  });

  it("draws no graph before a folder is connected", () => {
    const project = forkedProject();
    project.ableton_path = null;
    project.captures = [];
    renderScreen(project);

    expect(screen.queryByRole("group", { name: "Version lineage" })).not.toBeInTheDocument();
  });
});
