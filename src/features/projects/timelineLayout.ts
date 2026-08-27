// Timeline nodes → lanes, with the density cap DESIGN.md §11 asks for.
//
// Emits the same `GraphLayout` the earlier models emitted, so `graphGeometry`
// and `collapseGaps` are reused untouched. Those modules are about time and
// pixels, not about what a node means; they have now survived two changes of
// model without an edit, which is the point of keeping them separate.
//
// THE CAP
//
// §11: six lanes maximum, fold the oldest INACTIVE lanes into one rail, and
// never shrink the lane gap to fit more in. It was deferred twice as premature
// because real projects showed two lanes — but a session expanding into its
// steps can open lanes per step rather than per file, so the cap is reachable
// in an ordinary project now and ships with the change that makes it so.
//
// Oldest INACTIVE, not oldest: a line you are still working is never folded
// away however old it is. Folding the line the song is alive on would hide the
// present to make room for the past.

import type { GraphLane, GraphLayout } from "./versionGraphLayout";
import type { TimelineNode } from "./timelineNodes";

/** §11: past this the graph stops reading as a shape. */
export const MAX_LANES = 6;

export type TimelineLayout = GraphLayout & {
  /** Lanes folded away by the cap, oldest-inactive first. */
  foldedLanes: number[];
  /** Nodes on those lanes, so the surface can offer them behind a "+N" rail. */
  foldedNodeIds: string[];
};

/**
 * Which links are worth believing, so the trunk follows the strongest.
 *
 * A step following another step inside one sitting was watched happen. A link
 * that crosses from another session was inferred. Watched beats guessed.
 */
function strength(node: TimelineNode): number {
  return node.inferred ? 1 : 2;
}

export function layoutTimeline(nodes: TimelineNode[]): TimelineLayout {
  const byId = new Map(nodes.map((node) => [node.id, node]));

  const children = new Map<string, TimelineNode[]>();
  for (const node of nodes) {
    if (node.parentId === null) continue;
    children.set(node.parentId, [...(children.get(node.parentId) ?? []), node]);
  }
  for (const [parentId, group] of children) {
    children.set(parentId, [...group].sort((a, b) => a.atMs - b.atMs));
  }

  const roots = nodes
    .filter((node) => node.parentId === null || !byId.has(node.parentId))
    .sort((a, b) => a.atMs - b.atMs);

  const lanes: GraphLane[] = [];
  const laneOf = new Map<string, number>();

  const liveliness = new Map<string, number>();
  function latestUnder(node: TimelineNode): number {
    const cached = liveliness.get(node.id);
    if (cached !== undefined) return cached;
    const under = (children.get(node.id) ?? []).map(latestUnder);
    const latest = Math.max(node.endMs, ...under);
    liveliness.set(node.id, latest);
    return latest;
  }

  function openLane(depth: number): number {
    const lane: GraphLane = { index: lanes.length, depth, nodeIds: [] };
    lanes.push(lane);
    return lane.index;
  }

  function walk(node: TimelineNode, lane: number) {
    lanes[lane]!.nodeIds.push(node.id);
    laneOf.set(node.id, lane);

    const kids = children.get(node.id) ?? [];
    if (kids.length === 0) return;

    const heir = kids.reduce((a, b) => {
      const byStrength = strength(b) - strength(a);
      if (byStrength !== 0) return byStrength > 0 ? b : a;
      const byLife = latestUnder(b) - latestUnder(a);
      if (byLife !== 0) return byLife > 0 ? b : a;
      return b.atMs < a.atMs ? b : a;
    });

    walk(heir, lane);
    for (const child of kids) {
      if (child === heir) continue;
      walk(child, openLane(lanes[lane]!.depth + 1));
    }
  }

  for (const root of roots) walk(root, openLane(0));

  // Apply the cap. Lanes are ranked by when work on them last happened; the
  // most recent MAX_LANES survive, the rest fold. Ties keep the lower lane
  // index, which is the one nearer the trunk.
  const lastWorkOn = (lane: GraphLane): number =>
    lane.nodeIds.reduce((latest, id) => {
      const node = byId.get(id);
      return node ? Math.max(latest, node.endMs) : latest;
    }, 0);

  const foldedLanes: number[] = [];
  if (lanes.length > MAX_LANES) {
    const ranked = [...lanes].sort(
      (a, b) => lastWorkOn(b) - lastWorkOn(a) || a.index - b.index,
    );
    for (const lane of ranked.slice(MAX_LANES)) foldedLanes.push(lane.index);
  }
  const folded = new Set(foldedLanes);
  const foldedNodeIds = lanes
    .filter((lane) => folded.has(lane.index))
    .flatMap((lane) => lane.nodeIds);
  const hidden = new Set(foldedNodeIds);

  const keptLanes = lanes.filter((lane) => !folded.has(lane.index));

  return {
    lanes: keptLanes,
    placements: nodes
      .filter((node) => !hidden.has(node.id))
      .map((node) => ({
        nodeId: node.id,
        lane: laneOf.get(node.id) ?? 0,
        atMs: node.atMs,
        sittingsMs: [],
        endAtMs: node.endMs,
      })),
    edges: nodes
      .filter(
        (node) =>
          node.parentId !== null &&
          byId.has(node.parentId) &&
          !hidden.has(node.id) &&
          // An edge into a folded lane has nowhere to land.
          !hidden.has(node.parentId),
      )
      .map((node) => ({
        fromId: node.parentId!,
        toId: node.id,
        fromLane: laneOf.get(node.parentId!) ?? 0,
        toLane: laneOf.get(node.id) ?? 0,
        atMs: node.atMs,
        inferred: node.inferred,
      })),
    foldedLanes,
    foldedNodeIds,
  };
}
