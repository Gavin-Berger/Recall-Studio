// Turning the version DAG into something drawable: lanes, edges, positions.
//
// This is the derived layer, and it is derived on purpose. DESIGN.md §11 puts
// a lane index on every node, but a lane index is not a fact about a version —
// it is a fact about the *shape of the whole graph at this moment*. Save one
// and it is wrong the first time an older file is relinked into the middle of
// the history: every lane below the insertion point shifts, and a stored index
// now points at the wrong line. So nothing here is persisted. It recomputes
// from the DAG on every render, which is cheap because a project has tens of
// versions, not thousands.
//
// The lane rule (§11): a lane is a lineage, not a version. A chain where each
// version has a single child stays on one line — `v1 → v2 → v3` is one lane
// with three nodes, the way a run of commits is one line. A new lane exists
// only where a version has a *second* child.
//
// WHICH CHILD KEEPS THE TRUNK
//
// Git renders first-parent as the trunk because git is *told* which parent is
// first. Nothing tells us. Taking the eldest child instead gets it backwards in
// the ordinary case: open `nightfall v3`, try something weird, save it as
// `nightfall v3 alt`, sleep on it, come back and carry on in `nightfall v4`.
// The alt is older, so "eldest wins" puts the abandoned experiment on the trunk
// and pushes the song onto a branch.
//
// So the trunk follows the *strongest* edge, not the earliest: a child whose
// name follows its parent continues the lineage, and one that merely happened
// next is the branch. Ties go to the eldest.

import { childrenByParent, parentageStrength, type VersionNode } from "./versionGraph";

/** A lineage: one drawn line, with the versions that sit on it. */
export type GraphLane = {
  /** Position from the top of the graph. Stable within one layout only. */
  index: number;
  /**
   * Forks between this lane and the root lineage. Drives `--lane-0…3`, which
   * cycles past 3. Depth means distance from the trunk, never importance —
   * an abandoned experiment can hold the best sound in the song (§11).
   */
  depth: number;
  /** Versions on this lane, oldest first. */
  nodeIds: string[];
};

export type GraphPlacement = {
  nodeId: string;
  lane: number;
  /** Real wall-clock time. The scale is applied later, by `collapseGaps`. */
  atMs: number;
  /** Sitting ticks along the lane — every capture against this version. */
  sittingsMs: number[];
};

export type GraphEdge = {
  fromId: string;
  toId: string;
  fromLane: number;
  toLane: number;
  atMs: number;
  /** Dashed when true (§11). A guess must never look like a fact. */
  inferred: boolean;
};

export type GraphLayout = {
  lanes: GraphLane[];
  placements: GraphPlacement[];
  edges: GraphEdge[];
};

/**
 * Assign every node a lane, then the edges that connect them.
 *
 * Walks each root depth-first in time order so a lane is laid out along its
 * own lineage rather than jumping between branches. The first child inherits
 * its parent's lane; later children open the next free lane down.
 */
export function layoutVersionGraph(nodes: VersionNode[]): GraphLayout {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const children = childrenByParent(nodes);
  const roots = nodes
    .filter((node) => node.parentId === null || !byId.has(node.parentId))
    .sort((a, b) => a.version.startedAtMs - b.version.startedAtMs);

  const lanes: GraphLane[] = [];
  const laneOf = new Map<string, number>();

  function openLane(depth: number): number {
    const lane: GraphLane = { index: lanes.length, depth, nodeIds: [] };
    lanes.push(lane);
    return lane.index;
  }

  function walk(node: VersionNode, lane: number) {
    lanes[lane]!.nodeIds.push(node.id);
    laneOf.set(node.id, lane);

    const kids = children.get(node.id) ?? [];
    if (kids.length === 0) return;

    const heir = kids.reduce((a, b) => {
      const strength = parentageStrength(b.basis) - parentageStrength(a.basis);
      if (strength !== 0) return strength > 0 ? b : a;
      return b.version.startedAtMs < a.version.startedAtMs ? b : a;
    });

    // Walk the trunk first so lane indices read top-down: the lineage the song
    // is on, then its branches in the order they were taken.
    walk(heir, lane);
    for (const child of kids) {
      if (child === heir) continue;
      walk(child, openLane(lanes[lane]!.depth + 1));
    }
  }

  for (const root of roots) walk(root, openLane(0));

  const placements: GraphPlacement[] = nodes.map((node) => ({
    nodeId: node.id,
    lane: laneOf.get(node.id) ?? 0,
    atMs: node.version.startedAtMs,
    sittingsMs: node.version.sessions.map((session) => session.started_at_ms),
  }));

  const edges: GraphEdge[] = nodes
    .filter((node) => node.parentId !== null && byId.has(node.parentId))
    .map((node) => ({
      fromId: node.parentId!,
      toId: node.id,
      fromLane: laneOf.get(node.parentId!) ?? 0,
      toLane: laneOf.get(node.id) ?? 0,
      atMs: node.version.startedAtMs,
      inferred: node.inferred,
    }));

  return { lanes, placements, edges };
}

/** A stretch of real time the graph draws at full scale. */
export type TimeSegment = { startMs: number; endMs: number };

/** A dead stretch between segments, replaced by a fixed-width break. */
export type TimeGap = { startMs: number; endMs: number; durationMs: number };

export type TimeScale = {
  segments: TimeSegment[];
  gaps: TimeGap[];
  /** Total drawn width in the scale's own units, gaps included. */
  spanMs: number;
  /** Map a real timestamp to its drawn position. */
  project: (atMs: number) => number;
};

export const DEFAULT_GAP_MS = 1000 * 60 * 60 * 24 * 3;
/** What a collapsed gap is drawn as, in the scale's own units. */
export const DEFAULT_BREAK_MS = 1000 * 60 * 60 * 6;

/**
 * Collapse dead air so a year of history fits without lying about the pace.
 *
 * A producer leaves a song for three weeks and comes back. Drawn to scale that
 * is a screen of nothing with two clusters pinned to the edges; rescaled to fit,
 * every version looks evenly spaced and the graph claims a steady cadence that
 * never happened.
 *
 * So: real time inside a working stretch, a fixed-width break across an idle
 * one. DESIGN.md §11 requires the break to *name what it removed* ("3 weeks"),
 * which is why the gaps are returned rather than silently folded in — the
 * caller has to render the label.
 */
export function collapseGaps(
  timesMs: number[],
  options: { gapMs?: number; breakMs?: number } = {},
): TimeScale {
  const gapMs = options.gapMs ?? DEFAULT_GAP_MS;
  const breakMs = options.breakMs ?? DEFAULT_BREAK_MS;
  const sorted = [...new Set(timesMs)].sort((a, b) => a - b);

  if (sorted.length === 0) {
    return { segments: [], gaps: [], spanMs: 0, project: () => 0 };
  }

  const segments: TimeSegment[] = [];
  const gaps: TimeGap[] = [];
  let start = sorted[0]!;
  let previous = sorted[0]!;

  for (const time of sorted.slice(1)) {
    if (time - previous > gapMs) {
      segments.push({ startMs: start, endMs: previous });
      gaps.push({ startMs: previous, endMs: time, durationMs: time - previous });
      start = time;
    }
    previous = time;
  }
  segments.push({ startMs: start, endMs: previous });

  // Where each segment begins once the gaps before it have been squeezed down
  // to `breakMs`, so projection is a lookup plus an offset rather than a scan.
  const offsets: number[] = [];
  let drawn = 0;
  segments.forEach((segment, index) => {
    offsets.push(drawn);
    drawn += segment.endMs - segment.startMs;
    if (index < gaps.length) drawn += breakMs;
  });

  function project(atMs: number): number {
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index]!;
      if (atMs <= segment.endMs) {
        // Before this segment means inside the gap in front of it: clamp to the
        // segment's start rather than drawing outside the graph.
        return offsets[index]! + Math.max(0, atMs - segment.startMs);
      }
    }
    return drawn;
  }

  return { segments, gaps, spanMs: drawn, project };
}
