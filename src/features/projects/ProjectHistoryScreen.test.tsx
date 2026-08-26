// @vitest-environment jsdom

// Render tests for the Timeline surface.
//
// The row model is proved in projectHistory.test.ts. What only exists here is
// whether the surface is navigable: that the graph and the list agree about
// what is selected, that a row can reach the Report and the workspace, and
// that switching project actually switches what is drawn.

import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { SavedProject, SavedSessionMetadata } from "../../types/recall";
import { ProjectHistoryScreen } from "./ProjectHistoryScreen";

const minute = 60 * 1000;
const day = 24 * 60 * minute;
const start = 1_720_000_000_000;

function sitting(
  id: string,
  folder: string,
  file: string,
  days: number,
  over: Partial<SavedSessionMetadata> = {},
): SavedSessionMetadata {
  return {
    id,
    name: "capture",
    project_id: folder,
    capture_name: null,
    capture_status: "ended",
    project_name: folder,
    project_path: `C:\\Music\\${folder}`,
    als_path: `C:\\Music\\${folder}\\${file}.als`,
    take_origin: "recorded",
    display_name: null,
    started_at_ms: start + days * day,
    ended_at_ms: start + days * day + 30 * minute,
    last_updated_at_ms: start + days * day + 30 * minute,
    event_count: 12,
    creative_event_count: 8,
    heartbeat_count: 0,
    ...over,
  };
}

function project(id: string, name: string, captures: SavedSessionMetadata[]): SavedProject {
  return {
    id,
    display_name: name,
    ableton_name: name,
    ableton_path: `C:\\Music\\${id}`,
    archived_at_ms: null,
    created_at_ms: start,
    updated_at_ms: start + 5 * day,
    last_updated_at_ms: start + 5 * day,
    capture_count: captures.length,
    active_capture_count: 0,
    captures,
  };
}

const nightfall = project("nightfall", "Nightfall", [
  sitting("s1", "nightfall", "nightfall v1", 0),
  sitting("s2", "nightfall", "nightfall v2", 1),
  sitting("s3", "nightfall", "nightfall v3", 2),
  sitting("s4", "nightfall", "nightfall v4", 3),
  sitting("s5", "nightfall", "nightfall v3", 4),
  sitting("s6", "nightfall", "nightfall v5", 5),
]);

const otherSong = project("breaking", "Breaking Point", [
  sitting("b1", "breaking", "breaking point", 0),
]);

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
  return within(screen.getByRole("group", { name: "Version lineage" }));
}

function rows(): HTMLElement[] {
  return within(screen.getByRole("list")).getAllByRole("listitem");
}

describe("ProjectHistoryScreen", () => {
  it("draws the graph and the list from the same project", () => {
    renderScreen();
    // Six captures, five files. Both surfaces are per-version.
    expect(graph().getAllByRole("button")).toHaveLength(5);
    expect(rows()).toHaveLength(5);
  });

  it("puts the newest version at the top of the list", () => {
    renderScreen();
    expect(within(rows()[0]!).getByText("nightfall v5")).toBeInTheDocument();
  });

  it("selects the newest version on arrival", () => {
    renderScreen();
    expect(
      graph().getByRole("button", { name: /^nightfall v5\./ }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  it("moves the graph selection when a row is picked", async () => {
    const user = userEvent.setup();
    renderScreen();

    await user.click(within(rows()[3]!).getByRole("button", { name: /nightfall v2/ }));

    expect(graph().getByRole("button", { name: /^nightfall v2\./ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(graph().getByRole("button", { name: /^nightfall v5\./ })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("moves the row selection when a node is picked", async () => {
    const user = userEvent.setup();
    renderScreen();

    await user.click(graph().getByRole("button", { name: /^nightfall v1\./ }));

    // The two surfaces are one selection, so the row must follow the node just
    // as the node follows the row.
    const selected = rows().filter((row) => row.className.includes("is-selected"));
    expect(selected).toHaveLength(1);
    expect(within(selected[0]!).getByText("nightfall v1")).toBeInTheDocument();
  });

  it("opens the Report for the version's most recent sitting", async () => {
    const user = userEvent.setup();
    const { onOpenReport } = renderScreen();

    const v3 = rows().find((row) => within(row).queryByText("nightfall v3"))!;
    await user.click(within(v3).getByRole("button", { name: "Report" }));

    // s5 is the return visit; s3 was the first pass.
    expect(onOpenReport).toHaveBeenCalledWith("s5");
  });

  it("opens the per-capture workspace from a row", async () => {
    const user = userEvent.setup();
    const { onOpenWorkspace } = renderScreen();

    const v1 = rows().find((row) => within(row).queryByText("nightfall v1"))!;
    await user.click(within(v1).getByRole("button", { name: "Workspace" }));

    expect(onOpenWorkspace).toHaveBeenCalledWith("s1");
  });

  it("says which version the song forked at", () => {
    renderScreen();
    const v3 = rows().find((row) => within(row).queryByText("nightfall v3"))!;
    expect(within(v3).getByText("forked here")).toBeInTheDocument();
  });

  it("explains in plain language why each version hangs where it does", () => {
    renderScreen();
    // The row is the only place this sentence is readable; on the graph it is
    // a hover. It must also admit when it guessed.
    expect(screen.getAllByText(/not observed|Nothing to follow/).length).toBeGreaterThan(0);
  });

  it("switches project from the picker", async () => {
    const user = userEvent.setup();
    const { onSelectProject } = renderScreen([nightfall, otherSong]);

    await user.selectOptions(screen.getByLabelText("Project"), "breaking");

    expect(onSelectProject).toHaveBeenCalledWith("breaking");
  });

  it("does not offer a picker for a single project", () => {
    renderScreen();
    expect(screen.queryByLabelText("Project")).not.toBeInTheDocument();
  });

  it("says what to do when there are no projects at all", () => {
    renderScreen([], "nothing");
    expect(screen.getByText(/No projects yet/)).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Version lineage" })).not.toBeInTheDocument();
  });
});
