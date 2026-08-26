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
  MIN_NODE_SEPARATION,
  MIN_SPAN_PX,
  NODE_RADIUS,
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

/** Versions with explicit sittings: `[name, ...dayOffsets]`. A fork needs them. */
function graphFromSittings(specs: [string, ...number[]][]): VersionNode[] {
  const captures: SavedSessionMetadata[] = [];
  specs.forEach(([name, ...days], versionIndex) => {
    days.forEach((offset, sittingIndex) => {
      captures.push(
        capture({
          id: `s${versionIndex}-${sittingIndex}`,
          als_path: `C:\\Music\\nightfall\\${name}.als`,
          started_at_ms: start + offset * day,
          last_updated_at_ms: start + offset * day + minute,
        }),
      );
    });
  });
  return versionGraph(projectVersions(captures));
}

/** A trunk with one branch off it, which is the shape most of these assert on. */
function forkedGeometry(containerWidth = 1200) {
  const nodes = graphFromSittings([
    ["nightfall", 0],
    ["nightfall v2", 1, 4],
    ["nightfall alt", 2],
    ["nightfall v3", 5],
  ]);
  const layout = layoutVersionGraph(nodes);
  const scale = collapseGaps(layout.placements.flatMap((p) => [p.atMs, ...p.sittingsMs]));
  return { geometry: graphGeometry(layout, scale, { containerWidth }), nodes, layout };
}

function geometryFor(names: string[], containerWidth = 1200, gapMs = day) {
  const nodes = graphFromNames(names, gapMs);
  const layout = layoutVersionGraph(nodes);
  const scale = collapseGaps(layout.placements.flatMap((p) => [p.atMs, ...p.sittingsMs]));
  return { geometry: graphGeometry(layout, scale, { containerWidth }), nodes, layout };
}

describe("graphGeometry", () => {
  it("places lanes down the page at a fixed rhythm", () => {
    const { geometry } = forkedGeometry();
    const trunk = geometry.nodes.filter((node) => node.lane === 0);
    const branch = geometry.nodes.filter((node) => node.lane === 1);
    expect(trunk).toHaveLength(3);
    expect(branch).toHaveLength(1);
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
    const forked = forkedGeometry().geometry;
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
    const { geometry } = forkedGeometry();
    const fork = geometry.edges.find((edge) => /V/.test(edge.d))!;
    expect(fork.d).toMatch(/^M [\d.]+ [\d.]+ V [\d.]+ Q [\d.]+ [\d.]+ [\d.]+ [\d.]+ H [\d.]+$/);
  });

  it("starts a fork at the parent and ends it at the child", () => {
    const { geometry } = forkedGeometry();
    const fork = geometry.edges.find((edge) => /V/.test(edge.d))!;
    const parent = geometry.nodes.find((node) => node.id === fork.fromId)!;
    const child = geometry.nodes.find((node) => node.id === fork.toId)!;
    expect(fork.d.startsWith(`M ${parent.x} ${parent.y}`)).toBe(true);
    expect(fork.d.endsWith(`H ${child.x}`)).toBe(true);
  });

  it("never lets the corner overshoot a tight fork", () => {
    // Two versions moments apart: the corner radius must shrink rather than
    // curving past the child and doubling back.
    const { geometry } = forkedGeometry(1200);
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

describe("nodes that land on the same instant", () => {
  // The case a real library produced: "Breaking Point" and "Breaking Point v2
  // mixdown", both first captured within the hour but worked across weeks.
  //
  // The clustering comes from the SPAN, not from the two versions being close
  // in isolation: the axis is scaled to fit every sitting, so nine sittings
  // spread over a fortnight stretch it until an hour is worth about a pixel.
  // Two versions an hour apart with nothing else on the axis fill the whole
  // width and never collide, which is why a fixture has to carry the long
  // tail of sittings to reproduce this at all.
  function coincident(containerWidth = 940) {
    const nodes = graphFromSittings([
      ["breaking point v2 mixdown", 0, 1, 3, 7, 11, 14],
      ["breaking point", 0.04],
    ]);
    const layout = layoutVersionGraph(nodes);
    const scale = collapseGaps(layout.placements.flatMap((p) => [p.atMs, ...p.sittingsMs]));
    return graphGeometry(layout, scale, { containerWidth });
  }

  it("never draws two nodes on one lane closer than the separation floor", () => {
    const geometry = coincident();
    const onTrunk = geometry.nodes.filter((node) => node.lane === 0).sort((a, b) => a.x - b.x);
    expect(onTrunk.length).toBe(2);
    expect(onTrunk[1]!.x - onTrunk[0]!.x).toBeGreaterThanOrEqual(MIN_NODE_SEPARATION);
  });

  it("leaves every node room for a name once they are separated", () => {
    // labelMaxPx of 0 is what erased the second name: fitLabel returns "" below
    // four characters' worth of room, so the hidden version had no dot AND no
    // label — nothing on screen said it existed.
    const geometry = coincident();
    for (const node of geometry.nodes) {
      expect(node.labelMaxPx).toBeGreaterThan(0);
    }
  });

  it("keeps the two versions in the order they happened", () => {
    // A node may only ever be pushed later. If separation could move one
    // earlier, the graph would claim the wrong version came first.
    const nodes = graphFromSittings([
      ["breaking point v2 mixdown", 0, 1, 3, 7, 11, 14],
      ["breaking point", 0.04],
    ]);
    const layout = layoutVersionGraph(nodes);
    const scale = collapseGaps(layout.placements.flatMap((p) => [p.atMs, ...p.sittingsMs]));
    const geometry = graphGeometry(layout, scale, { containerWidth: 940 });
    const byId = new Map(geometry.nodes.map((node) => [node.id, node]));
    const ordered = [...layout.placements].sort((a, b) => a.atMs - b.atMs);
    expect(byId.get(ordered[0]!.nodeId)!.x).toBeLessThan(byId.get(ordered[1]!.nodeId)!.x);
  });

  it("leaves a well-spread graph exactly where time put it", () => {
    // The nudge must not touch a graph that was already legible, or every
    // spacing on a normal project would drift away from real elapsed time.
    const nodes = graphFromNames(["nightfall v1", "nightfall v2", "nightfall v3"]);
    const layout = layoutVersionGraph(nodes);
    const scale = collapseGaps(layout.placements.flatMap((p) => [p.atMs, ...p.sittingsMs]));
    const wide = graphGeometry(layout, scale, { containerWidth: 940 });
    const tiny = graphGeometry(layout, scale, { containerWidth: 940, minNodeSeparation: 0 });
    expect(wide.nodes.map((node) => node.x)).toEqual(tiny.nodes.map((node) => node.x));
  });

  it("grows the canvas rather than pushing a node past its right edge", () => {
    const geometry = coincident(120);
    for (const node of geometry.nodes) {
      expect(node.x).toBeLessThanOrEqual(geometry.width - PAD_X);
    }
  });
});

describe("label placement", () => {
  it("keeps the leftmost name inside the canvas", () => {
    // Labels are anchored left at the dot's left edge, so the earliest node —
    // which sits at PAD_X — starts its name at PAD_X - NODE_RADIUS and runs
    // rightwards. Centred text put it at negative x and the name was clipped.
    const { geometry } = geometryFor(["breaking point", "breaking point v2", "breaking point v3"]);
    const leftmost = geometry.nodes.reduce((a, b) => (b.x < a.x ? b : a));
    expect(leftmost.x - NODE_RADIUS).toBeGreaterThanOrEqual(0);
  });

  it("gives a name only the room to its right, which is where it grows", () => {
    const { geometry } = geometryFor(["breaking point", "breaking point v2"]);
    const sorted = [...geometry.nodes].sort((a, b) => a.x - b.x);
    const gap = sorted[1]!.x - sorted[0]!.x;
    // The run to the next node, less the gutter — never more, or two names
    // would overlap.
    expect(sorted[0]!.labelMaxPx).toBeLessThanOrEqual(gap);
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


describe("duration spans", () => {
  // The file-version model has no duration; the commit model does. Placements
  // carrying `endAtMs` get a bar, and those without get none.
  function withDurations(durations: number[], containerWidth = 900) {
    const placements = durations.map((ms, index) => ({
      nodeId: `c${index}`,
      lane: 0,
      atMs: start + index * hour * 6,
      sittingsMs: [],
      endAtMs: start + index * hour * 6 + ms,
    }));
    const layout = {
      lanes: [{ index: 0, depth: 0, nodeIds: placements.map((p) => p.nodeId) }],
      placements,
      edges: [],
    };
    const scale = collapseGaps(placements.flatMap((p) => [p.atMs, p.endAtMs]));
    return graphGeometry(layout, scale, { containerWidth });
  }

  it("draws a longer stretch of work as a longer bar", () => {
    // The whole point: a seven-hour session and a thirty-second one were
    // identical dots before this.
    const geometry = withDurations([4 * hour, 2 * minute]);
    const [long, brief] = geometry.spans;
    expect(long!.x2 - long!.x1).toBeGreaterThan(brief!.x2 - brief!.x1);
  });

  it("never lets a brief stretch shrink to nothing", () => {
    const geometry = withDurations([6 * hour, 20 * 1000]);
    const brief = geometry.spans[1]!;
    expect(brief.x2 - brief.x1).toBeGreaterThanOrEqual(MIN_SPAN_PX);
  });

  it("marks a widened bar so its width never claims to be to scale", () => {
    // "Brief" must not read as "absent", and the widened width must not read
    // as a real duration either. The flag is how the surface tells them apart.
    const geometry = withDurations([6 * hour, 20 * 1000]);
    expect(geometry.spans[1]!.clamped).toBe(true);
    expect(geometry.spans[0]!.clamped).toBe(false);
  });

  it("starts every bar at its own node", () => {
    // A node nudged right to clear a neighbour must take its bar with it, or
    // the bar detaches from the dot it describes.
    const geometry = withDurations([hour, hour, hour]);
    const nodeOf = new Map(geometry.nodes.map((node) => [node.id, node]));
    for (const span of geometry.spans) {
      expect(span.x1).toBe(nodeOf.get(span.nodeId)!.x);
    }
  });

  it("keeps every bar inside the canvas", () => {
    const geometry = withDurations([9 * hour, 3 * hour]);
    for (const span of geometry.spans) {
      expect(span.x2).toBeLessThanOrEqual(geometry.width);
    }
  });

  it("draws no bars for a model with no durations", () => {
    // The file-version graph still uses this module and has no end times.
    const { geometry } = geometryFor(["nightfall", "nightfall v2"]);
    expect(geometry.spans).toEqual([]);
  });
});

describe("dated axis", () => {
  it("dates the start of every stretch the scale kept at full width", () => {
    // One tick per segment: exactly where a collapsed gap has jumped the
    // reader forward and they need telling again.
    const { geometry, layout } = geometryFor(["a", "b", "c"], 1200, 30 * day);
    const scale = collapseGaps(layout.placements.map((p) => p.atMs));
    expect(geometry.axis).toHaveLength(scale.segments.length);
  });

  it("puts the axis below the last lane", () => {
    const { geometry } = forkedGeometry();
    const lowestLane = Math.max(...geometry.lanes.map((lane) => lane.y));
    expect(geometry.axisY).toBeGreaterThan(lowestLane);
    expect(geometry.axisY).toBeLessThanOrEqual(geometry.height);
  });

  it("leaves room for the axis rather than drawing over a lane", () => {
    const { geometry } = geometryFor(["a"]);
    expect(geometry.height).toBeGreaterThan(PAD_Y * 2);
  });
});
