// @vitest-environment jsdom

// Render tests for the Timeline.
//
// The commit model and the rail geometry are proved in projectCommits.test.ts
// and projectHistory.test.ts. What only exists here is whether the surface is
// navigable: that the overview and the list share one selection, that a commit
// reaches its Report and workspace session, that unobserved files are visibly
// set apart from the history, and that the rail actually renders connectors.

import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
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
  return within(screen.getByLabelText(/Project map/));
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
    screen.getByLabelText("Sessions").querySelectorAll<HTMLElement>(".ph-row"),
  );
}

describe("ProjectHistoryScreen", () => {
  it("draws every session in the project on the graph", () => {
    // The graph is the whole project — that IS the relationship between the
    // sets, and it is why the list can afford to narrow.
    renderScreen();
    expect(graph().getAllByRole("button")).toHaveLength(5);
  });

  it("narrows the list to the set being worked", () => {
    // A producer sits down inside ONE set and makes decisions there. Pouring
    // every set's work into one stream read as one undifferentiated day.
    // `nightfall` holds c1, c4 and c5; `nightfall v2` holds c2 and c3.
    renderScreen();
    expect(commitRows()).toHaveLength(3);
  });

  it("opens on the set worked most recently", () => {
    renderScreen();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Nightfall");
    expect(screen.getByRole("heading", { name: "Capture record for nightfall" })).toBeInTheDocument();
  });

  it("switches the list when another set is chosen", async () => {
    const user = userEvent.setup();
    renderScreen();
    const picker = screen.getByLabelText("Sets in this project");

    await user.click(within(picker).getByRole("button", { name: /nightfall v2/ }));

    expect(commitRows()).toHaveLength(2);
  });

  it("says where the set came from, without listing it as work", () => {
    // The relationship between sets is context for the decisions below, not
    // another entry in the list.
    renderScreen();
    const picker = screen.getByLabelText("Sets in this project");
    expect(picker).toBeInTheDocument();
  });

  it("puts the full captured-event count in the metadata, once", () => {
    // The count is the one fact a commit has that is not worth reading twice.
    // It lives in the meta line; the headline says what the work WAS.
    renderScreen();
    expect(within(commitRows()[0]!).getAllByText(/120 captured events/)).toHaveLength(1);
  });

  it("does not repeat the default parentage line on every row", () => {
    // "Picked up X where the earlier session left it" is what CONTINUING looks
    // like, which is most rows. Printing it on all of them buried the rows
    // where the lineage is actually a guess.
    renderScreen();
    // Scoped to the list: the graph's hover titles still carry the full
    // reason, which is the right place for it.
    const repeated = within(screen.getByLabelText("Sessions")).queryAllByText(
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

  it("keeps the fork between sets on the graph, where it belongs", () => {
    // Within one set the sessions are a straight chain — you keep going in the
    // file you are in. The branching is between SETS, which is the graph's
    // job and the reason it still draws the whole project.
    renderScreen();
    const edges = document.body.querySelectorAll(".vg__edge");
    expect(edges.length).toBeGreaterThan(0);
  });

  it("draws the rail as one line when the set never forked", () => {
    // A focused set is a straight chain by construction, so there is nothing
    // to connect across lanes. The elbow geometry is still proved directly in
    // projectHistory.test.ts, where rows can span sets.
    renderScreen();
    expect(document.body.querySelectorAll(".ph-rail__elbow")).toHaveLength(0);
    expect(document.body.querySelectorAll(".ph-rail__line").length).toBeGreaterThan(0);
  });

  it("moves the graph selection when a row is picked", async () => {
    const user = userEvent.setup();
    renderScreen();
    const nodes = () => graph().getAllByRole("button");
    const pressedBefore = nodes().filter((node) => node.getAttribute("aria-pressed") === "true");
    expect(pressedBefore).toHaveLength(1);

    // Each row carries three buttons (select, Report, Workspace); the row
    // itself is the select target.
    await user.click(commitRows()[2]!.querySelector(".ph-row__hit") as HTMLElement);

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

  it("opens the selected session's information in the reading pane", () => {
    renderScreen();
    expect(screen.getByRole("button", { name: "Hide details" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });

  it("allows the selected session's detail to be closed and reopened", async () => {
    const user = userEvent.setup();
    renderScreen();
    const details = screen.getByRole("button", { name: "Hide details" });

    await user.click(details);
    expect(screen.getByRole("button", { name: "Details" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );

    await user.click(screen.getByRole("button", { name: "Details" }));
    expect(screen.getByRole("button", { name: "Hide details" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });

  it("follows a graph point into the set where that work happened", async () => {
    const user = userEvent.setup();
    renderScreen();

    const v2Point = graph()
      .getAllByRole("button")
      .find((point) => /^nightfall v2\. A stretch/i.test(point.getAttribute("aria-label") ?? ""));
    expect(v2Point).toBeDefined();
    await user.click(v2Point!);

    expect(commitRows()).toHaveLength(2);
    expect(
      within(screen.getByLabelText("Sets in this project")).getByRole("button", {
        name: /nightfall v2/,
      }),
    ).toHaveAttribute("aria-current", "true");

    await waitFor(() => {
      const selected = commitRows().find((row) => row.className.includes("is-selected"));
      expect(document.activeElement).toBe(selected?.querySelector(".ph-row__hit"));
    });
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

  it("walks back through what a session came from", async () => {
    const user = userEvent.setup();
    renderScreen();

    // The focused set runs c5, c4, c1 — a straight chain, because inside one
    // set you keep going in the file you are in. So here `p` and the down
    // arrow agree; the case where they DIVERGE needs rows spanning sets and is
    // proved directly in historyKeys.test.ts.
    await user.click(commitRows()[1]!.querySelector(".ph-row__hit") as HTMLElement);
    await user.keyboard("p");

    const rows = commitRows();
    expect(rows.findIndex((row) => row.className.includes("is-selected"))).toBe(2);
  });

  it("does nothing on p at a root", async () => {
    const user = userEvent.setup();
    renderScreen();

    // The last row is the first work Recall captured in this set; it has
    // nothing before it, and silence beats moving somewhere arbitrary.
    await user.click(commitRows()[2]!.querySelector(".ph-row__hit") as HTMLElement);
    await user.keyboard("p");

    expect(commitRows()[2]!.className).toContain("is-selected");
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
    expect(screen.getByText(/came from/)).toBeInTheDocument();
  });

  it("uses no git or programming words on screen", () => {
    // DESIGN.md §10: producer vocabulary, always. This surface is modelled on
    // a git history, which makes it the easiest place in the app for "commit",
    // "branch", "repository" and "projection" to leak out of the code and into
    // what a producer reads. Named here so they cannot creep back.
    //
    // Whole words, compared against a split of the rendered text rather than
    // with regex boundaries — the point is that "commit" never appears, not
    // that some pattern happens to miss it.
    renderScreen();
    const shown = new Set(
      (document.body.textContent ?? "").toLowerCase().split(/[^a-z]+/),
    );
    const banned = [
      "commit",
      "commits",
      "branch",
      "branches",
      "branched",
      "repository",
      "projection",
      "schema",
      "parent",
      "node",
      "nodes",
    ];
    expect(banned.filter((word) => shown.has(word))).toEqual([]);
  });

  it("says what the uncounted sittings were, not just that they exist", () => {
    // "2 empty" told a producer nothing. These are sittings Recall opened and
    // watched without seeing work — worth counting so the numbers add up, and
    // meaningless unless the line says what they were.
    const withEmpties = project("nightfall", "Nightfall", [
      ...nightfall.captures,
      work("e1", "nightfall", 6, { event_count: 0, creative_event_count: 0 }),
    ]);
    renderScreen([withEmpties], "nightfall");
    expect(screen.getByText(/recorded nothing/)).toBeInTheDocument();
    expect(screen.queryByText(/\d+ empty/)).not.toBeInTheDocument();
  });

  it("names the set an origin claim is about", () => {
    // The title is the PROJECT and the chips saying which set is focused sit
    // below, so a bare "Came off X" reached the reader before its subject.
    const twoSets = project("nightfall", "Nightfall", [
      work("a1", "nightfall", 0),
      work("a2", "nightfall v2", 3),
    ]);
    renderScreen([twoSets], "nightfall");
    const origin = document.body.querySelector(".ph__origin");
    expect(origin).not.toBeNull();
    const text = origin!.textContent ?? "";
    // Subject, claim, source — in that order, all in one sentence.
    expect(text).toMatch(/nightfall v2.*came off.*nightfall/i);
  });

  it("never leaves a separator able to wrap onto a line of its own", () => {
    // The metadata is a wrapping flex line, so a dot rendered BETWEEN two
    // values is an item that can wrap like any other: every second line of a
    // selected row opened with an orphaned "· 1w ago". A separator has to
    // travel with the value it follows, which means it must never be a child
    // of its own.
    renderScreen();
    const meta = commitRows()[0]!.querySelector(".ph-row__meta")!;
    for (const child of Array.from(meta.children)) {
      expect((child.textContent ?? "").replace(/[\s·]/g, "")).not.toBe("");
    }
  });

  it("says what to do when there are no projects at all", () => {
    renderScreen([], "nothing");
    expect(screen.getByText(/No projects yet/)).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Project history" })).not.toBeInTheDocument();
  });
});
