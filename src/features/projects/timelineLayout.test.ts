import { describe, expect, it } from "vitest";
import { layoutTimeline, MAX_LANES } from "./timelineLayout";
import type { TimelineNode } from "./timelineNodes";

const minute = 60 * 1000;
const hour = 60 * minute;
const start = 1_720_000_000_000;

function node(
  id: string,
  atHours: number,
  parentId: string | null,
  over: Partial<TimelineNode> = {},
): TimelineNode {
  return {
    id,
    kind: "session",
    sessionId: id,
    label: id,
    atMs: start + atHours * hour,
    endMs: start + atHours * hour + 30 * minute,
    parentId,
    inferred: false,
    stepCount: null,
    changes: 10,
    live: false,
    ...over,
  };
}

/** A straight run: each node continues the one before. */
const chain = [node("a", 0, null), node("b", 2, "a"), node("c", 4, "b")];

describe("layoutTimeline", () => {
  it("keeps a straight run on one lane", () => {
    const layout = layoutTimeline(chain);
    expect(layout.lanes).toHaveLength(1);
  });

  it("opens a lane only where a node has a second child", () => {
    const forked = [...chain, node("d", 6, "a")];
    expect(layoutTimeline(forked).lanes).toHaveLength(2);
  });

  it("gives the trunk to the watched link over the guessed one", () => {
    // A step following another inside one sitting was watched. A link crossing
    // from another session was inferred. Watched beats guessed.
    const layout = layoutTimeline([
      node("a", 0, null),
      node("guess", 2, "a", { inferred: true }),
      node("watched", 4, "a"),
    ]);
    const laneOf = (id: string) =>
      layout.placements.find((placement) => placement.nodeId === id)!.lane;
    expect(laneOf("watched")).toBe(0);
    expect(laneOf("guess")).not.toBe(0);
  });

  it("draws one edge per link and carries the guess through", () => {
    const layout = layoutTimeline([node("a", 0, null), node("b", 2, "a", { inferred: true })]);
    expect(layout.edges).toHaveLength(1);
    expect(layout.edges[0]).toMatchObject({ fromId: "a", toId: "b", inferred: true });
  });

  it("carries each node's end so the graph can draw its duration", () => {
    const layout = layoutTimeline(chain);
    expect(layout.placements.every((placement) => placement.endAtMs !== undefined)).toBe(true);
  });

  it("handles an empty graph", () => {
    const layout = layoutTimeline([]);
    expect(layout.lanes).toEqual([]);
    expect(layout.foldedLanes).toEqual([]);
  });
});

describe("layoutTimeline · the six-lane cap (DESIGN.md §11)", () => {
  /** A root with `count` children, each starting its own lane. */
  function fan(count: number): TimelineNode[] {
    const nodes = [node("root", 0, null)];
    for (let index = 0; index < count; index += 1) {
      // Later index means more recent work, so the oldest lanes fold first.
      nodes.push(node(`branch-${index}`, 1 + index, "root"));
    }
    return nodes;
  }

  it("leaves a graph inside the cap completely alone", () => {
    const layout = layoutTimeline(fan(3));
    expect(layout.foldedLanes).toEqual([]);
    expect(layout.foldedNodeIds).toEqual([]);
  });

  it("never draws more than six lanes", () => {
    // §11: past six the graph stops reading as a shape.
    const layout = layoutTimeline(fan(12));
    expect(layout.lanes.length).toBeLessThanOrEqual(MAX_LANES);
  });

  it("folds the oldest lanes, not the newest", () => {
    // A line you are still working is never folded away, however old it is.
    // Folding the line the song is alive on would hide the present.
    const layout = layoutTimeline(fan(10));
    const survivingIds = new Set(layout.placements.map((placement) => placement.nodeId));
    // branch-9 is the most recently worked; branch-0 the oldest.
    expect(survivingIds.has("branch-9")).toBe(true);
    expect(survivingIds.has("branch-0")).toBe(false);
  });

  it("reports what it folded so the surface can offer it back", () => {
    // Folded is not deleted. "+N earlier" has to be able to name them.
    const layout = layoutTimeline(fan(10));
    expect(layout.foldedLanes.length).toBeGreaterThan(0);
    expect(layout.foldedNodeIds.length).toBeGreaterThan(0);
    expect(layout.foldedNodeIds).toContain("branch-0");
  });

  it("draws no node that sits on a folded lane", () => {
    const layout = layoutTimeline(fan(10));
    const drawn = new Set(layout.placements.map((placement) => placement.nodeId));
    for (const hidden of layout.foldedNodeIds) {
      expect(drawn.has(hidden)).toBe(false);
    }
  });

  it("draws no edge that would land on nothing", () => {
    // An edge into a folded lane has nowhere to arrive.
    const layout = layoutTimeline(fan(10));
    const drawn = new Set(layout.placements.map((placement) => placement.nodeId));
    for (const edge of layout.edges) {
      expect(drawn.has(edge.fromId)).toBe(true);
      expect(drawn.has(edge.toId)).toBe(true);
    }
  });

  it("keeps the trunk whatever else folds", () => {
    // Lane 0 is the line the song is on. It can never be the thing folded.
    const layout = layoutTimeline(fan(10));
    expect(layout.lanes.some((lane) => lane.depth === 0)).toBe(true);
    const drawn = new Set(layout.placements.map((placement) => placement.nodeId));
    expect(drawn.has("root")).toBe(true);
  });
});
