import { describe, expect, it } from "vitest";
import type { SavedSessionMetadata } from "../../types/recall";
import { projectVersions } from "./projectVersions";
import { versionGraph, type VersionNode } from "./versionGraph";
import { collapseGaps, layoutVersionGraph } from "./versionGraphLayout";
import {
  fitLabel,
  graphGeometry,
  laneColorVar,
  LANE_HEIGHT,
  MIN_NODE_GAP,
  PAD_X,
  PAD_Y,
} from "./versionGraphGeometry";

const minute = 60 * 1000;
const hour = 60 * minute;
const day = 24 * hour;
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

function graphFromNames(names: string[], gapMs = day): VersionNode[] {
  return versionGraph(
    projectVersions(
      names.map((name, index) =>
        capture({
          id: `s${index}`,
          als_path: `C:\\Music\\nightfall\\${name}.als`,
          started_at_ms: start + index * gapMs,
          last_updated_at_ms: start + index * gapMs + minute,
        }),
      ),
    ),
  );
}

function geometryFor(names: string[], containerWidth = 1200, gapMs = day) {
  const nodes = graphFromNames(names, gapMs);
  const layout = layoutVersionGraph(nodes);
  const scale = collapseGaps(layout.placements.flatMap((p) => [p.atMs, ...p.sittingsMs]));
  return { geometry: graphGeometry(layout, scale, { containerWidth }), nodes, layout };
}

describe("graphGeometry", () => {
  it("places lanes down the page at a fixed rhythm", () => {
    const { geometry } = geometryFor(["nightfall", "nightfall v2", "nightfall alt", "nightfall v3"]);
    const trunk = geometry.nodes.filter((node) => node.lane === 0);
    const branch = geometry.nodes.filter((node) => node.lane === 1);
    expect(trunk.every((node) => node.y === PAD_Y)).toBe(true);
    expect(branch.every((node) => node.y === PAD_Y + LANE_HEIGHT)).toBe(true);
  });

  it("keeps time left to right", () => {
    const { geometry } = geometryFor(["nightfall", "nightfall v2", "nightfall v3"]);
    const xs = geometry.nodes.map((node) => node.x);
    expect(xs).toEqual([...xs].sort((a, b) => a - b));
  });

  it("grows wider rather than squeezing nodes together", () => {
    // DESIGN.md §8: nothing that encodes time may compress. Twenty versions in
    // a narrow pane must scroll, not bunch.
    const names = Array.from({ length: 20 }, (_, index) => `nightfall v${index + 1}`);
    const { geometry } = geometryFor(names, 600);
    expect(geometry.width).toBeGreaterThan(600);
    expect(geometry.width).toBe(PAD_X * 2 + 19 * MIN_NODE_GAP);
  });

  it("fills the container when there is room to spare", () => {
    const { geometry } = geometryFor(["nightfall", "nightfall v2"], 1200);
    expect(geometry.width).toBe(1200);
  });

  it("grows taller with each lane", () => {
    const flat = geometryFor(["nightfall", "nightfall v2"]).geometry;
    const forked = geometryFor([
      "nightfall",
      "nightfall v2",
      "nightfall alt",
      "nightfall v3",
    ]).geometry;
    expect(forked.height).toBe(flat.height + LANE_HEIGHT);
  });

  it("centres a lone version instead of pinning it to the left edge", () => {
    const { geometry } = geometryFor(["nightfall"], 1000);
    expect(geometry.nodes[0]!.x).toBe(500);
  });

  it("draws a same-lane edge as a straight horizontal run", () => {
    const { geometry } = geometryFor(["nightfall", "nightfall v2"]);
    expect(geometry.edges).toHaveLength(1);
    expect(geometry.edges[0]!.d).toMatch(/^M [\d.]+ [\d.]+ H [\d.]+$/);
  });

  it("draws a fork as one vertical drop, one corner, then the child lane", () => {
    // §11: orthogonal with a single rounded corner. Never a bezier between lanes.
    const { geometry } = geometryFor([
      "nightfall",
      "nightfall v2",
      "nightfall alt",
      "nightfall v3",
    ]);
    const fork = geometry.edges.find((edge) => /V/.test(edge.d))!;
    expect(fork.d).toMatch(/^M [\d.]+ [\d.]+ V [\d.]+ Q [\d.]+ [\d.]+ [\d.]+ [\d.]+ H [\d.]+$/);
  });

  it("starts a fork at the parent and ends it at the child", () => {
    const { geometry } = geometryFor([
      "nightfall",
      "nightfall v2",
      "nightfall alt",
      "nightfall v3",
    ]);
    const fork = geometry.edges.find((edge) => /V/.test(edge.d))!;
    const parent = geometry.nodes.find((node) => node.id === fork.fromId)!;
    const child = geometry.nodes.find((node) => node.id === fork.toId)!;
    expect(fork.d.startsWith(`M ${parent.x} ${parent.y}`)).toBe(true);
    expect(fork.d.endsWith(`H ${child.x}`)).toBe(true);
  });

  it("never lets the corner overshoot a tight fork", () => {
    // Two versions moments apart: the corner radius must shrink rather than
    // curving past the child and doubling back.
    const { geometry } = geometryFor(
      ["nightfall", "nightfall v2", "nightfall alt", "nightfall v3"],
      1200,
      minute,
    );
    for (const edge of geometry.edges) {
      const child = geometry.nodes.find((node) => node.id === edge.toId)!;
      const parent = geometry.nodes.find((node) => node.id === edge.fromId)!;
      const turn = /Q [\d.]+ [\d.]+ ([\d.]+)/.exec(edge.d);
      if (!turn) continue;
      expect(Number(turn[1])).toBeLessThanOrEqual(Math.max(child.x, parent.x));
    }
  });

  it("carries the inferred flag through to the drawn edge", () => {
    const { geometry } = geometryFor(["nightfall", "nightfall v2"]);
    expect(geometry.edges[0]!.inferred).toBe(true);
  });

  it("puts a sitting tick on its version's lane", () => {
    const versions = projectVersions([
      capture({ id: "a", started_at_ms: start }),
      capture({ id: "b", started_at_ms: start + 2 * hour }),
    ]);
    const layout = layoutVersionGraph(versionGraph(versions));
    const scale = collapseGaps(layout.placements.flatMap((p) => p.sittingsMs));
    const geometry = graphGeometry(layout, scale, { containerWidth: 800 });
    expect(geometry.sittings).toHaveLength(2);
    expect(geometry.sittings.every((tick) => tick.y === PAD_Y)).toBe(true);
  });

  it("reports each collapsed break so the label can name it", () => {
    const { geometry } = geometryFor(["nightfall", "nightfall v2"], 1200, 30 * day);
    expect(geometry.breaks).toHaveLength(1);
    expect(geometry.breaks[0]!.durationMs).toBe(30 * day);
  });

  it("spans each lane from its first version to its last", () => {
    const { geometry } = geometryFor(["nightfall", "nightfall v2", "nightfall v3"]);
    const lane = geometry.lanes[0]!;
    const xs = geometry.nodes.map((node) => node.x);
    expect(lane.x1).toBe(Math.min(...xs));
    expect(lane.x2).toBe(Math.max(...xs));
  });

  it("survives an empty project", () => {
    const geometry = graphGeometry(
      { lanes: [], placements: [], edges: [] },
      collapseGaps([]),
      { containerWidth: 900 },
    );
    expect(geometry.nodes).toEqual([]);
    expect(geometry.edges).toEqual([]);
    expect(geometry.height).toBeGreaterThan(0);
  });
});

describe("fitLabel", () => {
  it("leaves a name that fits alone", () => {
    expect(fitLabel("nightfall v4", 200)).toBe("nightfall v4");
  });

  it("truncates with an ellipsis so the producer knows there is more", () => {
    const fitted = fitLabel("pers ep nightfall v4 mixdown", 60);
    expect(fitted.endsWith("…")).toBe(true);
    expect(fitted.length).toBeLessThan("pers ep nightfall v4 mixdown".length);
  });

  it("draws nothing rather than a bare ellipsis", () => {
    // "…" on its own tells the producer nothing they cannot already see.
    expect(fitLabel("nightfall v4", 8)).toBe("");
    expect(fitLabel("nightfall v4", 0)).toBe("");
  });

  it("does not leave a dangling space before the ellipsis", () => {
    expect(fitLabel("nightfall v4", 60)).not.toMatch(/ …$/);
  });
});

describe("node labels", () => {
  it("gives a name the room up to the next version on its lane", () => {
    const { geometry } = geometryFor(["nightfall", "nightfall v2", "nightfall v3"], 1200);
    const [first, second] = geometry.nodes;
    expect(first!.labelMaxPx).toBeGreaterThan(0);
    expect(first!.labelMaxPx).toBeLessThan(second!.x - first!.x);
  });

  it("gives the last version on a lane the rest of the graph", () => {
    const { geometry } = geometryFor(["nightfall", "nightfall v2"], 1200);
    const last = geometry.nodes[geometry.nodes.length - 1]!;
    expect(last.labelMaxPx).toBeGreaterThan(0);
  });
});

describe("laneColorVar", () => {
  it("gives the trunk the brightest step", () => {
    expect(laneColorVar(0)).toBe("var(--lane-0)");
  });

  it("dims one step per fork", () => {
    expect(laneColorVar(1)).toBe("var(--lane-1)");
    expect(laneColorVar(2)).toBe("var(--lane-2)");
    expect(laneColorVar(3)).toBe("var(--lane-3)");
  });

  it("cycles rather than running out, and never returns to the trunk step", () => {
    // A deep branch must stay visibly a branch; falling back to --lane-0 would
    // claim it is the mainline.
    expect(laneColorVar(4)).toBe("var(--lane-1)");
    expect(laneColorVar(7)).toBe("var(--lane-1)");
    expect(laneColorVar(9)).toBe("var(--lane-3)");
    for (let depth = 1; depth < 30; depth += 1) {
      expect(laneColorVar(depth)).not.toBe("var(--lane-0)");
    }
  });
});
