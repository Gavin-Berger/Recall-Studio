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
    };
  });

  return rows.sort((a, b) => b.node.version.startedAtMs - a.node.version.startedAtMs);
}

/** The sitting a producer expects to land on when they pick a version. */
export function landingSessionId(row: HistoryRow): string | null {
  const sessions = row.node.version.sessions;
  return sessions[sessions.length - 1]?.id ?? null;
}
