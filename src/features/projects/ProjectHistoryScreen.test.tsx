// @vitest-environment jsdom

// Render tests for the Timeline.
//
// The commit model and the rail geometry are proved in projectCommits.test.ts
// and projectHistory.test.ts. What only exists here is whether the surface is
// navigable: that the overview and the list share one selection, that a commit
// reaches its Report and workspace session, that unobserved files are visibly
// set apart from the history, and that the rail actually renders connectors.

import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { SavedProject, SavedSessionMetadata } from "../../types/recall";
import { ProjectHistoryScreen } from "./ProjectHistoryScreen";

const minute = 60 * 1000;
const hour = 60 * minute;
const start = 1_720_000_000_000;

function work(
  id: string,
  set: string,
  atHours: number,
  over: Partial<SavedSessionMetadata> = {},
): SavedSessionMetadata {
  const startedAt = start + atHours * hour;
  return {
    id,
    name: "capture",
    project_id: "nightfall",
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
    ...over,
  };
}

function onDisk(id: string, set: string, atHours: number): SavedSessionMetadata {
  const at = start + atHours * hour;
  return work(id, set, atHours, {
    take_origin: "scanned",
    capture_status: "scanned",
    ended_at_ms: at,
    last_updated_at_ms: at,
    event_count: 0,
    creative_event_count: 0,
  });
}

function project(id: string, name: string, captures: SavedSessionMetadata[]): SavedProject {
  return {
    id,
    display_name: name,
    ableton_name: name,
    ableton_path: `C:\\Music\\${id}`,
    archived_at_ms: null,
    created_at_ms: start,
    updated_at_ms: start + 50 * hour,
    last_updated_at_ms: start + 50 * hour,
    capture_count: captures.length,
    active_capture_count: 0,
    captures,
  };
}

// Worked `nightfall`, moved to v2 and worked it, then went back to `nightfall`.
const nightfall = project("nightfall", "Nightfall", [
  work("c1", "nightfall", 0),
  work("c2", "nightfall v2", 3),
  work("c3", "nightfall v2", 8),
  work("c4", "nightfall", 12),
  work("c5", "nightfall", 20),
]);

const otherSong = project("breaking", "Breaking Point", [work("b1", "breaking point", 0)]);

function renderScreen(projects: SavedProject[] = [nightfall], projectId = "nightfall") {
  const onOpenReport = vi.fn();
  const onOpenWorkspace = vi.fn();
  const onSelectProject = vi.fn();
  render(
    <ProjectHistoryScreen
      projects={projects}
      projectId={projectId}
      onSelectProject={onSelectProject}
      onOpenReport={onOpenReport}
      onOpenWorkspace={onOpenWorkspace}
      onOpenProjects={vi.fn()}
    />,
  );
  return { onOpenReport, onOpenWorkspace, onSelectProject };
}

function graph() {
  return within(screen.getByRole("group", { name: "Project history" }));
}

/**
 * The commit rows only.
 *
 * The list nests: an <ol> of day groups, each holding a date divider and its
 * rows. `getAllByRole("listitem")` would sweep up the groups and dividers too,
 * so this selects the rows themselves.
 */
function commitRows(): HTMLElement[] {
  return Array.from(
    screen.getByLabelText("Commits").querySelectorAll<HTMLElement>(".ph-row"),
  );
}

describe("ProjectHistoryScreen", () => {
  it("draws one node and one row per captured stretch of work", () => {
    renderScreen();
    // Five commits across two sets. The old model drew two file nodes.
    expect(graph().getAllByRole("button")).toHaveLength(5);
    expect(commitRows()).toHaveLength(5);
  });

  it("puts the commit's size in the metadata, once", () => {
    // The count is the one fact a commit has that is not worth reading twice.
    // It lives in the meta line; the headline says what the work WAS.
    renderScreen();
    expect(within(commitRows()[0]!).getAllByText(/120 changes/)).toHaveLength(1);
  });

  it("does not repeat the default parentage line on every row", () => {
    // "Picked up X where the earlier session left it" is what CONTINUING looks
    // like, which is most rows. Printing it on all of them buried the rows
    // where the lineage is actually a guess.
    renderScreen();
    // Scoped to the list: the graph's hover titles still carry the full
    // reason, which is the right place for it.
    const repeated = within(screen.getByLabelText("Commits")).queryAllByText(
      /Picked up .* where the earlier session left it/,
    );
    expect(repeated).toHaveLength(0);
  });

  it("still explains a row whose parentage was guessed", () => {
    renderScreen();
    // The fixture forks, so at least one edge is inferred and must say so.
    expect(screen.getAllByText(/not observed|first work Recall/).length).toBeGreaterThan(0);
  });

  it("shows the set as a label on the commit", () => {
    renderScreen();
    expect(within(commitRows()[0]!).getByText("nightfall")).toBeInTheDocument();
  });

  it("puts the most recent work at the top with the latest badge", () => {
    renderScreen();
    expect(within(commitRows()[0]!).getByText("latest")).toBeInTheDocument();
  });

  it("says where the history branched", () => {
    renderScreen();
    const branchPoint = commitRows().find((row) => within(row).queryByText("branched here"));
    expect(branchPoint).toBeDefined();
  });

  it("renders a real elbow connector where a branch leaves its parent", () => {
    renderScreen();
    const container = document.body;
    // A vertical stripe is not a git graph. The fork has to be drawn as an
    // orthogonal path from the child's lane across to its parent's.
    const elbows = container.querySelectorAll(".ph-rail__elbow");
    expect(elbows.length).toBeGreaterThan(0);
    const d = elbows[0]!.getAttribute("d") ?? "";
    expect(d).toMatch(/^M .* L .* A .* L /);
  });

  it("dashes an inferred connector and leaves an observed one solid", () => {
    renderScreen();
    // `branched` is a guess and draws dashed; `continued` was watched.
    const inferred = document.body.querySelectorAll(".ph-rail__elbow--inferred");
    expect(inferred.length).toBeGreaterThan(0);
  });

  it("moves the graph selection when a row is picked", async () => {
    const user = userEvent.setup();
    renderScreen();
    const nodes = () => graph().getAllByRole("button");
    const pressedBefore = nodes().filter((node) => node.getAttribute("aria-pressed") === "true");
    expect(pressedBefore).toHaveLength(1);

    // Each row carries three buttons (select, Report, Workspace); the row
    // itself is the select target.
    await user.click(commitRows()[3]!.querySelector(".ph-row__hit") as HTMLElement);

    const pressed = nodes().filter((node) => node.getAttribute("aria-pressed") === "true");
    expect(pressed).toHaveLength(1);
    expect(pressed[0]).not.toBe(pressedBefore[0]);
  });

  it("moves the row selection when a node is picked", async () => {
    const user = userEvent.setup();
    renderScreen();

    await user.click(graph().getAllByRole("button")[0]!);

    const selected = commitRows().filter((row) => row.className.includes("is-selected"));
    expect(selected).toHaveLength(1);
  });

  it("opens the Report for the commit's own session", async () => {
    const user = userEvent.setup();
    const { onOpenReport } = renderScreen();

    await user.click(within(commitRows()[0]!).getByRole("button", { name: "Report" }));

    // Rows are most-recent-first, and c5 is the last stretch of work.
    expect(onOpenReport).toHaveBeenCalledWith("c5");
  });

  it("opens the workspace for the commit's own session", async () => {
    const user = userEvent.setup();
    const { onOpenWorkspace } = renderScreen();

    await user.click(within(commitRows()[0]!).getByRole("button", { name: "Workspace" }));

    expect(onOpenWorkspace).toHaveBeenCalledWith("c5");
  });

  it("explains each commit's parentage without claiming a filename told it", () => {
    renderScreen();
    const why = screen.getAllByText(/Picked up|Recall was capturing|first work Recall/);
    expect(why.length).toBeGreaterThan(0);
    expect(screen.queryByText(/read from the file names/)).not.toBeInTheDocument();
  });

  it("sets unobserved files apart from the history", () => {
    const scanned = project("scan", "Scanned", [
      work("c1", "nightfall", 0),
      onDisk("s1", "nightfall v9", 3),
    ]);
    renderScreen([scanned], "scan");

    const artifacts = screen.getByLabelText("Files found on disk");
    expect(within(artifacts).getByText("nightfall v9")).toBeInTheDocument();
    expect(within(artifacts).getByText(/not part of the history/)).toBeInTheDocument();
    // And it is not a commit.
    expect(commitRows()).toHaveLength(1);
  });

  it("says nothing was captured when a project has only files on disk", () => {
    const scanned = project("scan", "Scanned", [onDisk("s1", "one", 0)]);
    renderScreen([scanned], "scan");
    expect(screen.getByText(/Nothing captured yet/)).toBeInTheDocument();
  });

  it("switches project from the picker", async () => {
    const user = userEvent.setup();
    const { onSelectProject } = renderScreen([nightfall, otherSong]);

    await user.selectOptions(screen.getByLabelText("Project"), "breaking");

    expect(onSelectProject).toHaveBeenCalledWith("breaking");
  });

  it("moves the selection with the arrow keys", async () => {
    const user = userEvent.setup();
    renderScreen();

    const first = commitRows()[0]!.querySelector(".ph-row__hit") as HTMLElement;
    first.focus();
    await user.keyboard("{ArrowDown}");

    const selected = commitRows().filter((row) => row.className.includes("is-selected"));
    expect(selected).toHaveLength(1);
    expect(selected[0]).toBe(commitRows()[1]);
  });

  it("moves with j and k as well as the arrows", async () => {
    const user = userEvent.setup();
    renderScreen();

    (commitRows()[0]!.querySelector(".ph-row__hit") as HTMLElement).focus();
    await user.keyboard("jj");
    expect(commitRows()[2]!.className).toContain("is-selected");

    await user.keyboard("k");
    expect(commitRows()[1]!.className).toContain("is-selected");
  });

  it("follows the lineage with p instead of stepping down the page", async () => {
    const user = userEvent.setup();
    renderScreen();

    // Rows run c5, c4, c3, c2, c1. Row 1 is c4, which continued c1 — four rows
    // down — while c3 and c2 (the v2 branch) are printed in between. Stepping
    // down from row 1 lands on c3, a different lineage entirely. This is the
    // move a flat list cannot offer.
    await user.click(commitRows()[1]!.querySelector(".ph-row__hit") as HTMLElement);
    await user.keyboard("p");

    const rows = commitRows();
    const selectedIndex = rows.findIndex((row) => row.className.includes("is-selected"));
    expect(selectedIndex).toBe(4);
  });

  it("does nothing on p at a root", async () => {
    const user = userEvent.setup();
    renderScreen();

    // The last row is the first work Recall captured; it has no parent, and
    // silence beats moving somewhere arbitrary.
    await user.click(commitRows()[4]!.querySelector(".ph-row__hit") as HTMLElement);
    await user.keyboard("p");

    expect(commitRows()[4]!.className).toContain("is-selected");
  });

  it("opens the Report on Enter and the workspace on Shift+Enter", async () => {
    const user = userEvent.setup();
    const { onOpenReport, onOpenWorkspace } = renderScreen();

    (commitRows()[0]!.querySelector(".ph-row__hit") as HTMLElement).focus();
    await user.keyboard("{Enter}");
    expect(onOpenReport).toHaveBeenCalledWith("c5");

    await user.keyboard("{Shift>}{Enter}{/Shift}");
    expect(onOpenWorkspace).toHaveBeenCalledWith("c5");
  });

  it("keeps the list to a single tab stop", async () => {
    // A month of work must not cost sixty tab presses to step over.
    renderScreen();
    const reachable = commitRows()
      .map((row) => row.querySelector(".ph-row__hit") as HTMLElement)
      .filter((hit) => hit.tabIndex === 0);
    expect(reachable).toHaveLength(1);
  });

  it("tells the reader the shortcuts exist", () => {
    renderScreen();
    expect(screen.getByText(/parent/)).toBeInTheDocument();
  });

  it("says what to do when there are no projects at all", () => {
    renderScreen([], "nothing");
    expect(screen.getByText(/No projects yet/)).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Project history" })).not.toBeInTheDocument();
  });
});
