// The version history as a list of rows, to sit beneath the graph.
//
// WHY A LIST AS WELL AS A GRAPH
//
// DESIGN.md §11 fixes the graph's x-axis to real elapsed time. That is the
// right call — it is what stops the drawing from claiming a steady cadence the
// producer never had — but it also means the graph cannot be a table. Nodes sit
// where their timestamps put them, so two versions made a minute apart overlap
// and a version from last year is off at the edge. There is nowhere to hang a
// name, a count, and two buttons.
//
// GitHub has the same problem and solves it the same way: the network graph
// draws the shape, and the commit list underneath carries the detail. Neither
// is a worse version of the other — the graph answers "what happened to this
// song" and the list answers "what is this version". They share a selection so
// they never disagree about what you are looking at.
//
// This module is the list's model. It is pure so the ordering, the refs, and
// the fork detection can be tested without rendering anything.

import type { ProjectVersion } from "./projectVersions";
import { childrenByParent, versionGraph, type VersionNode } from "./versionGraph";
import { layoutVersionGraph } from "./versionGraphLayout";

export type HistoryRow = {
  node: VersionNode;
  /** Lane index from the layout — ties the row to the line it sits on. */
  lane: number;
  /** Forks from the trunk. Drives `--lane-0…3`, same as the graph. */
  depth: number;
  /** The newest version in the project. Renders the `latest` ref. */
  latest: boolean;
  /** A sitting is still open against this version. Renders the `live` ref. */
  live: boolean;
  /**
   * The song forked here — this version has more than one child. Worth a ref
   * of its own because it is the one structural fact a flat list normally
   * cannot show, and it is the reason the graph exists.
   */
  branchPoint: boolean;
  /** How many times the producer sat down with this file. */
  sittings: number;
  /** Recorded moves across every sitting. Zero means Recall was not running. */
  moves: number;
  /** Row index of this version's parent, or null for a root. */
  parentRow: number | null;
  /** The parent edge was a guess, so its connector renders dashed. */
  inferred: boolean;
  /**
   * Lanes with a line running through this row, this row's own lane included.
   *
   * This is what turns the list into a git graph rather than a column of dots:
   * a lane is drawn at every row between its first and last version, so a
   * branch stays visibly open while the trunk carries on beside it.
   */
  railLanes: number[];
};

/**
 * Build the history rows for one project, newest first.
 *
 * Newest first because the question a producer opens this with is "where am I",
 * not "where did I start" — the same reason a commit list puts HEAD at the top.
 * The graph above keeps time running left to right, so the two read in
 * different directions on purpose: one is a shape, the other is a stack.
 */
export function versionHistoryRows(versions: ProjectVersion[]): HistoryRow[] {
  if (versions.length === 0) return [];

  const nodes = versionGraph(versions);
  const layout = layoutVersionGraph(nodes);
  const children = childrenByParent(nodes);

  const laneOf = new Map<string, { lane: number; depth: number }>();
  for (const lane of layout.lanes) {
    for (const nodeId of lane.nodeIds) {
      laneOf.set(nodeId, { lane: lane.index, depth: lane.depth });
    }
  }

  // "Latest" is by when work last happened, not when the file first appeared.
  // Going back to an older version makes it the one you are on, and the ref
  // has to follow that or it points at an abandoned file.
  let latestId: string | null = null;
  let latestAt = -Infinity;
  for (const node of nodes) {
    if (node.version.lastUpdatedAtMs > latestAt) {
      latestAt = node.version.lastUpdatedAtMs;
      latestId = node.id;
    }
  }

  const rows: HistoryRow[] = nodes.map((node) => {
    const placed = laneOf.get(node.id);
    return {
      node,
      lane: placed?.lane ?? 0,
      depth: placed?.depth ?? 0,
      latest: node.id === latestId,
      live: node.version.live,
      branchPoint: (children.get(node.id)?.length ?? 0) > 1,
      sittings: node.version.sessions.length,
      moves: node.version.eventCount,
      parentRow: null,
      inferred: node.inferred,
      railLanes: [],
    };
  });

  // Most recently WORKED first. Ordering by when a file first appeared put the
  // `latest` ref halfway down the list, because going back to an older version
  // makes it the newest thing in the project without changing when it was
  // born — so the list disagreed with its own badge.
  rows.sort((a, b) => b.node.version.lastUpdatedAtMs - a.node.version.lastUpdatedAtMs);

  const rowOf = new Map(rows.map((row, index) => [row.node.id, index]));
  for (const row of rows) {
    const parentId = row.node.parentId;
    row.parentRow = parentId !== null ? rowOf.get(parentId) ?? null : null;
  }

  // A lane runs from its earliest row to its latest, so it is drawn at every
  // row in between even where it has no version of its own.
  const span = new Map<number, { from: number; to: number }>();
  rows.forEach((row, index) => {
    const seen = span.get(row.lane);
    if (!seen) span.set(row.lane, { from: index, to: index });
    else span.set(row.lane, { from: Math.min(seen.from, index), to: Math.max(seen.to, index) });
  });

  rows.forEach((row, index) => {
    row.railLanes = [...span.entries()]
      .filter(([, range]) => index >= range.from && index <= range.to)
      .map(([lane]) => lane)
      .sort((a, b) => a - b);
  });

  return rows;
}

/** How many lane columns the rail needs to draw. */
export function railWidth(rows: HistoryRow[]): number {
  return rows.reduce((max, row) => Math.max(max, ...row.railLanes.map((lane) => lane + 1)), 1);
}

/**
 * Everything the rail needs that is a property of the LIST, not of one row.
 *
 * A rail line has to be coloured by the depth of the lane it draws, not by the
 * depth of the row it happens to pass — a trunk line running alongside a branch
 * row is still the trunk. And a lane's line has to stop at its newest and
 * oldest version rather than running the full height of the list.
 */
export type RailShape = {
  columns: number;
  /** Depth per lane index, for `laneColorVar`. */
  depthOf: Map<number, number>;
  /** Row index holding each lane's most recent version. */
  headRow: Map<number, number>;
  /** Row index holding each lane's oldest version. */
  tailRow: Map<number, number>;
};

export function railShape(rows: HistoryRow[]): RailShape {
  const depthOf = new Map<number, number>();
  const headRow = new Map<number, number>();
  const tailRow = new Map<number, number>();

  rows.forEach((row, index) => {
    depthOf.set(row.lane, row.depth);
    if (!headRow.has(row.lane)) headRow.set(row.lane, index);
    tailRow.set(row.lane, index);
  });

  return { columns: railWidth(rows), depthOf, headRow, tailRow };
}

/** The sitting a producer expects to land on when they pick a version. */
export function landingSessionId(row: HistoryRow): string | null {
  const sessions = row.node.version.sessions;
  return sessions[sessions.length - 1]?.id ?? null;
}
