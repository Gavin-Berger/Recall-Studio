// The commit history as rows, and the rail geometry that draws it like git.
//
// The overview graph and this list are built from the SAME commit model
// (`projectCommits`) and the same lane assignment (`layoutCommits`), so they
// cannot disagree about the shape of the history — only about how much of it
// they show. The graph draws time; the list draws structure and detail.
//
// The rail is the part that has to look like git. A row is not a dot: it is a
// point on a lane, with vertical runs for every lane alive beside it and an
// ELBOW to its parent when the parent sits on a different lane. Without the
// elbow a fork is invisible in the list — two lanes just start existing next to
// each other with nothing saying they are related.

import type { SavedSessionMetadata } from "../../types/recall";
import { layoutCommits } from "./commitLayout";
import {
  commitChildren,
  projectCommits,
  type ProjectArtifact,
  type ProjectCommit,
} from "./projectCommits";

export type HistoryRow = {
  commit: ProjectCommit;
  /** Lane index — which line this commit sits on. */
  lane: number;
  /** Forks from the trunk. Drives `--lane-0…3`. */
  depth: number;
  /** The most recent work in the project. */
  latest: boolean;
  /** Capture is still running against this commit. */
  live: boolean;
  /** The history forks here: more than one commit continued from this one. */
  branchPoint: boolean;
  /** Row index of the parent, or null for a root. */
  parentRow: number | null;
  /** Lane the parent sits on, or null for a root. */
  parentLane: number | null;
  /** Lanes with a line running through this row, this row's own included. */
  railLanes: number[];
};

export type ProjectHistory = {
  rows: HistoryRow[];
  /** Sets found on disk that Recall never watched. Never linked into history. */
  artifacts: ProjectArtifact[];
  /** Sessions that recorded nothing, counted rather than silently dropped. */
  emptyCheckpoints: number;
};

/**
 * Build the history for one project, most recent work first.
 *
 * Most-recent-first because the question a producer opens this with is "where
 * am I", the same reason a commit list puts HEAD at the top.
 */
export function projectHistory(captures: SavedSessionMetadata[]): ProjectHistory {
  const model = projectCommits(captures);
  if (model.commits.length === 0) {
    return { rows: [], artifacts: model.artifacts, emptyCheckpoints: model.emptyCheckpoints };
  }

  const layout = layoutCommits(model.commits);
  const children = commitChildren(model.commits);

  const laneOf = new Map<string, { lane: number; depth: number }>();
  for (const lane of layout.lanes) {
    for (const nodeId of lane.nodeIds) {
      laneOf.set(nodeId, { lane: lane.index, depth: lane.depth });
    }
  }

  let latestId: string | null = null;
  let latestAt = -Infinity;
  for (const commit of model.commits) {
    if (commit.endedAtMs > latestAt) {
      latestAt = commit.endedAtMs;
      latestId = commit.id;
    }
  }

  const rows: HistoryRow[] = model.commits.map((commit) => {
    const placed = laneOf.get(commit.id);
    return {
      commit,
      lane: placed?.lane ?? 0,
      depth: placed?.depth ?? 0,
      latest: commit.id === latestId,
      live: commit.live,
      branchPoint: (children.get(commit.id)?.length ?? 0) > 1,
      parentRow: null,
      parentLane: null,
      railLanes: [],
    };
  });

  rows.sort((a, b) => b.commit.endedAtMs - a.commit.endedAtMs);

  const rowOf = new Map(rows.map((row, index) => [row.commit.id, index]));
  for (const row of rows) {
    const parentId = row.commit.parentId;
    if (parentId === null) continue;
    const parentIndex = rowOf.get(parentId);
    if (parentIndex === undefined) continue;
    row.parentRow = parentIndex;
    row.parentLane = rows[parentIndex]!.lane;
  }

  // A lane is drawn at every row between its newest and oldest commit, even
  // where the rows in between belong to other lanes. That is what keeps a
  // branch visibly open beside the trunk instead of vanishing between its own
  // commits.
  const span = new Map<number, { from: number; to: number }>();
  rows.forEach((row, index) => {
    const seen = span.get(row.lane);
    if (!seen) span.set(row.lane, { from: index, to: index });
    else span.set(row.lane, { from: Math.min(seen.from, index), to: Math.max(seen.to, index) });
  });

  // A fork's elbow leaves the child's lane and lands on the parent's, so the
  // parent's lane has to be drawn up as far as the child row or the elbow ends
  // in mid-air.
  for (const row of rows) {
    if (row.parentRow === null || row.parentLane === null) continue;
    if (row.parentLane === row.lane) continue;
    const childIndex = rowOf.get(row.commit.id)!;
    const seen = span.get(row.parentLane);
    if (seen) {
      span.set(row.parentLane, {
        from: Math.min(seen.from, childIndex),
        to: Math.max(seen.to, row.parentRow),
      });
    }
  }

  rows.forEach((row, index) => {
    row.railLanes = [...span.entries()]
      .filter(([, range]) => index >= range.from && index <= range.to)
      .map(([lane]) => lane)
      .sort((a, b) => a - b);
  });

  return { rows, artifacts: model.artifacts, emptyCheckpoints: model.emptyCheckpoints };
}

/** Horizontal pitch between lane columns, and the drawn height of one row. */
export const RAIL_COL = 16;
export const RAIL_ROW_H = 84;
/** Where the node sits down the row. */
export const RAIL_NODE_Y = 26;
/** Corner radius on an elbow. Orthogonal with one rounded corner (§11). */
export const RAIL_ELBOW_R = 7;

export type RailShape = {
  columns: number;
  /** Depth per lane index, for `laneColorVar`. */
  depthOf: Map<number, number>;
  /** Row index holding each lane's most recent commit. */
  headRow: Map<number, number>;
  /** Row index holding each lane's oldest commit. */
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

  const columns = rows.reduce(
    (max, row) => Math.max(max, ...row.railLanes.map((lane) => lane + 1)),
    1,
  );

  return { columns, depthOf, headRow, tailRow };
}

/** Centre of a lane column, in the rail's own pixels. */
export function laneX(lane: number): number {
  return lane * RAIL_COL + RAIL_COL / 2;
}

/**
 * The connector from a row down to its parent, when the parent is on another
 * lane.
 *
 * The list runs newest-first, so a parent is always BELOW its child. The path
 * leaves the child's node, drops down the child's own lane, turns once with a
 * rounded corner, and runs across to the parent's lane — orthogonal with one
 * corner, never a bezier (§11), the same vocabulary the overview graph uses.
 *
 * Returns null when parent and child share a lane: the lane's own vertical run
 * already connects them and a second line on top would be noise.
 */
export function elbowPath(row: HistoryRow): string | null {
  if (row.parentRow === null || row.parentLane === null) return null;
  if (row.parentLane === row.lane) return null;

  const from = laneX(row.lane);
  const to = laneX(row.parentLane);
  const turn = RAIL_ROW_H - RAIL_ELBOW_R;
  const rightwards = to > from;
  const sweep = rightwards ? 0 : 1;
  const corner = from + (rightwards ? RAIL_ELBOW_R : -RAIL_ELBOW_R);

  return [
    `M ${from} ${RAIL_NODE_Y}`,
    `L ${from} ${turn}`,
    `A ${RAIL_ELBOW_R} ${RAIL_ELBOW_R} 0 0 ${sweep} ${corner} ${RAIL_ROW_H}`,
    `L ${to} ${RAIL_ROW_H}`,
  ].join(" ");
}

/**
 * The rows split into calendar days, newest first.
 *
 * A commit is now a stretch of work rather than a file, so a busy week produces
 * a lot of them and an undivided list stops being scannable. Git logs and
 * GitHub both group by day for the same reason: the date is how anyone
 * actually navigates back to "that thing I did on Tuesday".
 *
 * Rows keep their ORIGINAL index. The rail is indexed by position in the whole
 * list, so renumbering inside a group would break every lane's head/tail and
 * the lines would stop meeting across a day boundary.
 */
export type HistoryDay = {
  /** Stable key: the local calendar day the work started. */
  key: string;
  /** Milliseconds at the start of that day, for formatting. */
  atMs: number;
  entries: { row: HistoryRow; index: number }[];
};

export function groupByDay(rows: HistoryRow[]): HistoryDay[] {
  const days: HistoryDay[] = [];
  rows.forEach((row, index) => {
    const date = new Date(row.commit.atMs);
    const key = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
    const last = days[days.length - 1];
    if (last && last.key === key) {
      last.entries.push({ row, index });
      return;
    }
    days.push({
      key,
      atMs: new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime(),
      entries: [{ row, index }],
    });
  });
  return days;
}

/** The session a producer expects to open when they pick a commit. */
export function landingSessionId(row: HistoryRow): string {
  return row.commit.id;
}
