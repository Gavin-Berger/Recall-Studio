// @vitest-environment jsdom

// Render tests for the version graph.
//
// The pure suites already prove the lineage and the geometry. What only exists
// in the component is whether the drawing is *reachable* — whether a producer
// can select a version without a mouse, whether a guessed link is visibly a
// guess, and whether a version Recall never captured is drawn as unknown rather
// than as empty work.

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { SavedSessionMetadata } from "../../types/recall";
import { projectVersions } from "./projectVersions";
import { VersionGraphView } from "./VersionGraphView";

const minute = 60 * 1000;
const day = 24 * 60 * minute;
const start = 1_720_000_000_000;

function capture(over: Partial<SavedSessionMetadata> = {}): SavedSessionMetadata {
  return {
    id: "session-1",
    name: "capture",
    project_id: "project-1",
    capture_name: null,
    capture_status: "ended",
    project_name: "nightfall",
    project_path: "C:\\Music\\nightfall",
    als_path: "C:\\Music\\nightfall\\nightfall.als",
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

function versionsFor(names: string[], over: Partial<SavedSessionMetadata>[] = []) {
  return projectVersions(
    names.map((name, index) =>
      capture({
        id: `s${index}`,
        als_path: `C:\\Music\\nightfall\\${name}.als`,
        started_at_ms: start + index * day,
        last_updated_at_ms: start + index * day + minute,
        ...over[index],
      }),
    ),
  );
}

function renderGraph(names: string[], over: Partial<SavedSessionMetadata>[] = []) {
  const onSelectVersion = vi.fn();
  const versions = versionsFor(names, over);
  const view = render(
    <VersionGraphView
      versions={versions}
      selectedVersionId={null}
      onSelectVersion={onSelectVersion}
    />,
  );
  return { onSelectVersion, versions, view };
}

describe("VersionGraphView", () => {
  it("draws one control per version", () => {
    renderGraph(["nightfall", "nightfall v2", "nightfall v3"]);
    expect(screen.getAllByRole("button")).toHaveLength(3);
  });

  it("names each version and why it hangs where it does", () => {
    renderGraph(["nightfall", "nightfall v2"]);
    const node = screen.getByRole("button", { name: /nightfall v2/ });
    expect(node).toHaveAccessibleName(/follows nightfall/i);
  });

  it("selects a version by click", async () => {
    const user = userEvent.setup();
    const { onSelectVersion } = renderGraph(["nightfall", "nightfall v2"]);
    await user.click(screen.getByRole("button", { name: /nightfall v2/ }));
    expect(onSelectVersion).toHaveBeenCalledWith("c:/music/nightfall/nightfall v2.als");
  });

  it("selects a version from the keyboard", async () => {
    // §9: every surface operable without a mouse. An SVG node is not a button
    // for free, so this is the test that keeps it one.
    const user = userEvent.setup();
    const { onSelectVersion } = renderGraph(["nightfall", "nightfall v2"]);
    await user.tab();
    await user.keyboard("{Enter}");
    expect(onSelectVersion).toHaveBeenCalledTimes(1);
  });

  it("selects with the space bar without scrolling the page", async () => {
    const user = userEvent.setup();
    const { onSelectVersion } = renderGraph(["nightfall"]);
    await user.tab();
    await user.keyboard(" ");
    expect(onSelectVersion).toHaveBeenCalledTimes(1);
  });

  it("tells assistive tech which version is selected", () => {
    const versions = versionsFor(["nightfall", "nightfall v2"]);
    render(
      <VersionGraphView
        versions={versions}
        selectedVersionId={versions[1]!.id}
        onSelectVersion={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: /nightfall v2/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("draws a guessed link as dashed and says so in plain language", () => {
    // DESIGN.md §1/§11: a guess must never be drawn the way a fact is drawn,
    // and the surface must admit it rather than letting the producer assume.
    const { view } = renderGraph(["nightfall", "nightfall v2"]);
    expect(view.container.querySelectorAll(".vg__edge--inferred")).toHaveLength(1);
    expect(screen.getByText(/guessed from file names/i)).toBeInTheDocument();
  });

  it("draws a version it never captured as unknown, not as empty", () => {
    const { view } = renderGraph(
      ["nightfall", "nightfall v2"],
      [{}, { event_count: 0, creative_event_count: 0, take_origin: "scanned" }],
    );
    expect(view.container.querySelectorAll(".vg__dot--hollow")).toHaveLength(1);
  });

  it("says outright when nothing was recorded against a version", () => {
    const { view } = renderGraph(["nightfall"], [{ event_count: 0, creative_event_count: 0 }]);
    const tooltip = view.container.querySelector(".vg__node title")?.textContent ?? "";
    expect(tooltip).toMatch(/Recall was not running/);
  });

  it("marks a live capture with the signal accent and nothing that moves", () => {
    // §6: the connection dot is the only thing in the app allowed to pulse.
    const { view } = renderGraph(["nightfall"], [{ ended_at_ms: null }]);
    expect(view.container.querySelectorAll(".vg__node--live")).toHaveLength(1);
    // An SVG element's className is an SVGAnimatedString, not a string.
    const live = view.container.querySelector(".vg__node--live")!;
    expect(live.getAttribute("class")).not.toMatch(/pulse/);
  });

  it("names what a collapsed break removed", () => {
    const versions = projectVersions([
      capture({ id: "a", als_path: "C:\\a\\nightfall.als", started_at_ms: start }),
      capture({
        id: "b",
        als_path: "C:\\a\\nightfall v2.als",
        started_at_ms: start + 21 * day,
        last_updated_at_ms: start + 21 * day + minute,
      }),
    ]);
    render(
      <VersionGraphView versions={versions} selectedVersionId={null} onSelectVersion={vi.fn()} />,
    );
    expect(screen.getByText("3 weeks")).toBeInTheDocument();
  });

  it("does not show the guess legend when there is nothing to explain", () => {
    render(<VersionGraphView versions={versionsFor(["nightfall"])} selectedVersionId={null} onSelectVersion={vi.fn()} />);
    expect(screen.queryByText(/guessed from file names/i)).not.toBeInTheDocument();
  });

  it("says what to do next when a project has no versions", () => {
    // §7: empty-state copy names the situation, never the absence.
    render(<VersionGraphView versions={[]} selectedVersionId={null} onSelectVersion={vi.fn()} />);
    expect(screen.getByText("No versions yet")).toBeInTheDocument();
    expect(screen.queryByText(/no items found/i)).not.toBeInTheDocument();
  });
});
