// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { ProjectCommit } from "./projectCommits";
import { CommitGraphView } from "./CommitGraphView";

const minute = 60 * 1000;
const start = 1_720_000_000_000;

function stretch(id: string, hours: number, parentId: string | null = null): ProjectCommit {
  return {
    id,
    session: {} as ProjectCommit["session"],
    parentId,
    basis: parentId ? "continued" : null,
    inferred: false,
    reason: "",
    alsPath: null,
    setName: "Nightfall",
    atMs: start + hours * 60 * minute,
    endedAtMs: start + hours * 60 * minute + 45 * minute,
    changes: 12,
    creativeChanges: 8,
    live: false,
  };
}

function renderMap() {
  render(
    <CommitGraphView
      commits={[stretch("s1", 0), stretch("s2", 4, "s1")]}
      openSessionId="s2"
      openSteps={[]}
      onSelectSession={vi.fn()}
    />,
  );
}

describe("CommitGraphView controls", () => {
  it("provides a scale control and restores the fitted view", () => {
    renderMap();
    const controls = within(screen.getByRole("group", { name: "Map controls" }));
    const scale = controls.getByRole("slider", { name: "Timeline scale" });

    expect(scale).toHaveAttribute("aria-valuetext", "100%");
    fireEvent.change(scale, { target: { value: "1.4" } });
    expect(scale).toHaveAttribute("aria-valuetext", "140%");

    fireEvent.click(controls.getByRole("button", { name: "Fit" }));
    expect(scale).toHaveAttribute("aria-valuetext", "100%");
  });

  it("pans the revision tree by dragging its empty space", () => {
    const { container } = render(
      <CommitGraphView
        commits={[stretch("s1", 0), stretch("s2", 4, "s1")]}
        openSessionId="s2"
        openSteps={[]}
        onSelectSession={vi.fn()}
      />,
    );
    const viewport = container.querySelector<HTMLDivElement>(".vg__scroll")!;
    viewport.scrollLeft = 100;
    viewport.scrollTop = 80;

    fireEvent.pointerDown(viewport, { button: 0, pointerId: 1, clientX: 240, clientY: 260 });
    fireEvent.pointerMove(viewport, { pointerId: 1, clientX: 180, clientY: 220 });
    fireEvent.pointerUp(viewport, { pointerId: 1, clientX: 180, clientY: 220 });

    expect(viewport.scrollLeft).toBe(160);
    expect(viewport.scrollTop).toBe(120);
  });

  it("does not pan when a session information row is being picked", () => {
    const { container } = render(
      <CommitGraphView
        commits={[stretch("s1", 0), stretch("s2", 4, "s1")]}
        openSessionId="s2"
        openSteps={[]}
        onSelectSession={vi.fn()}
      />,
    );
    const viewport = container.querySelector<HTMLDivElement>(".vg__scroll")!;
    const record = container.querySelector<HTMLElement>(".vg__record")!;
    viewport.scrollLeft = 100;
    viewport.scrollTop = 80;

    fireEvent.pointerDown(record, { button: 0, pointerId: 1, clientX: 240, clientY: 260 });
    fireEvent.pointerMove(viewport, { pointerId: 1, clientX: 180, clientY: 220 });

    expect(viewport.scrollLeft).toBe(100);
    expect(viewport.scrollTop).toBe(80);
  });

  it("opens space between rows when the scale increases", () => {
    const { container } = render(
      <CommitGraphView
        commits={[stretch("s1", 0), stretch("s2", 4, "s1")]}
        openSessionId="s2"
        openSteps={[]}
        onSelectSession={vi.fn()}
      />,
    );
    const controls = within(screen.getByRole("group", { name: "Map controls" }));
    const canvas = container.querySelector<SVGSVGElement>(".vg__canvas")!;
    const before = Number(canvas.getAttribute("height"));
    fireEvent.change(controls.getByRole("slider", { name: "Timeline scale" }), {
      target: { value: "1.4" },
    });
    expect(Number(canvas.getAttribute("height"))).toBeGreaterThan(before);
  });

  it("zooms directly with the mouse wheel over the map", () => {
    const { container } = render(
      <CommitGraphView
        commits={[stretch("s1", 0), stretch("s2", 4, "s1")]}
        openSessionId="s2"
        openSteps={[]}
        onSelectSession={vi.fn()}
      />,
    );
    const controls = within(screen.getByRole("group", { name: "Map controls" }));
    const scale = controls.getByRole("slider", { name: "Timeline scale" });
    const viewport = container.querySelector<HTMLDivElement>(".vg__scroll")!;

    fireEvent.wheel(viewport, { deltaY: -40 });
    expect(scale).toHaveAttribute("aria-valuetext", "110%");

    fireEvent.wheel(viewport, { deltaY: 40 });
    expect(scale).toHaveAttribute("aria-valuetext", "100%");
  });
});


describe("CommitGraphView keyboard (DESIGN.md §9)", () => {
  function map() {
    return screen.getByLabelText(/Project map/);
  }

  function nodes() {
    return Array.from(document.body.querySelectorAll<HTMLElement>("[data-map-node]"));
  }

  it("is one tab stop, not one per stretch of work", () => {
    // A map of thirty steps must not cost thirty presses to cross.
    renderMap();
    expect(map().tabIndex).toBe(0);
    expect(nodes().length).toBeGreaterThan(1);
    expect(nodes().every((node) => node.getAttribute("tabindex") === "-1")).toBe(true);
  });

  it("moves between stretches of work with the arrow keys", () => {
    renderMap();
    fireEvent.keyDown(map(), { key: "ArrowRight" });
    expect(document.body.querySelectorAll(".vg__record.is-focused")).toHaveLength(1);

    const first = document.body.querySelector(".vg__record.is-focused");
    fireEvent.keyDown(map(), { key: "ArrowRight" });
    expect(document.body.querySelector(".vg__record.is-focused")).not.toBe(first);
  });

  it("lands on a point rather than stepping past one on the first press", () => {
    renderMap();
    fireEvent.keyDown(map(), { key: "ArrowRight" });
    const focused = document.body.querySelector("[data-map-node].is-focused");
    expect(focused).toBe(nodes()[0]);
  });

  it("jumps to the current and first captured work", () => {
    renderMap();
    fireEvent.keyDown(map(), { key: "End" });
    expect(document.body.querySelector(".vg__record.is-focused")).toBe(nodes()[nodes().length - 1]);
    fireEvent.keyDown(map(), { key: "Home" });
    expect(document.body.querySelector(".vg__record.is-focused")).toBe(nodes()[0]);
  });

  it("opens the focused stretch of work with Enter", () => {
    const onSelectSession = vi.fn();
    render(
      <CommitGraphView
        commits={[stretch("s1", 0), stretch("s2", 4, "s1")]}
        openSessionId="s2"
        openSteps={[]}
        onSelectSession={onSelectSession}
      />,
    );
    fireEvent.keyDown(screen.getByLabelText(/Project map/), { key: "Home" });
    fireEvent.keyDown(screen.getByLabelText(/Project map/), { key: "Enter" });
    expect(onSelectSession).toHaveBeenCalledWith("s2");
  });

  it("places the newest stretch above older work", () => {
    renderMap();
    const dots = Array.from(document.body.querySelectorAll<SVGCircleElement>(".vg__dot"));
    expect(Number(dots[0]?.getAttribute("cy"))).toBeLessThan(Number(dots[1]?.getAttribute("cy")));
  });

  it("scales with plus and minus and fits with zero", () => {
    renderMap();
    const scale = () => screen.getByLabelText("Timeline scale") as HTMLInputElement;
    const before = scale().value;

    fireEvent.keyDown(map(), { key: "+" });
    expect(scale().value).not.toBe(before);

    fireEvent.keyDown(map(), { key: "0" });
    expect(scale().value).toBe(before);
  });

  it("leaves the browser's own zoom alone", () => {
    // Ctrl +/- zooms the whole app. Taking it would be surprising and there is
    // no way to hand it back.
    renderMap();
    const scale = () => screen.getByLabelText("Timeline scale") as HTMLInputElement;
    const before = scale().value;
    fireEvent.keyDown(map(), { key: "+", ctrlKey: true });
    expect(scale().value).toBe(before);
  });

  it("says how to drive it without a mouse", () => {
    renderMap();
    const label = map().getAttribute("aria-label") ?? "";
    expect(label).toMatch(/Arrow keys/);
    expect(label).toMatch(/Enter/);
  });
});
