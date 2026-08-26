import { describe, expect, it } from "vitest";
import type { SavedSessionMetadata } from "../../types/recall";
import {
  elbowPath,
  groupByDay,
  laneX,
  projectHistory,
  RAIL_NODE_Y,
  RAIL_ROW_H,
  railShape,
} from "./projectHistory";

const minute = 60 * 1000;
const hour = 60 * minute;
const start = 1_720_000_000_000;
const folder = "C:\\Music\\nightfall";

function work(
  id: string,
  set: string,
  atHours: number,
  over: Partial<SavedSessionMetadata> = {},
): SavedSessionMetadata {
  const startedAt = start + atHours * hour;
  return {
    id,
    name: "capture",
    project_id: "project-1",
    capture_name: null,
    capture_status: "ended",
    project_name: "nightfall",
    project_path: folder,
    als_path: `${folder}\\${set}.als`,
    take_origin: "recorded",
    display_name: null,
    started_at_ms: startedAt,
    ended_at_ms: startedAt + 45 * minute,
    last_updated_at_ms: startedAt + 45 * minute,
    event_count: 120,
    creative_event_count: 30,
    heartbeat_count: 0,
    ...over,
  };
}

function onDisk(id: string, set: string, atHours: number): SavedSessionMetadata {
  const at = start + atHours * hour;
  return work(id, set, atHours, {
    take_origin: "scanned",
    capture_status: "scanned",
    ended_at_ms: at,
    last_updated_at_ms: at,
    event_count: 0,
    creative_event_count: 0,
  });
}

/** Linear: four stretches of work on one set. */
const linear = [
  work("c1", "nightfall", 0),
  work("c2", "nightfall", 5),
  work("c3", "nightfall", 30),
  work("c4", "nightfall", 50),
];

/** Went back: worked `nightfall`, moved to v2, then returned to `nightfall`. */
const returned = [
  work("c1", "nightfall", 0),
  work("c2", "nightfall v2", 3),
  work("c3", "nightfall v2", 8),
  work("c4", "nightfall", 12),
  work("c5", "nightfall", 20),
];

function rowsOf(captures: SavedSessionMetadata[]) {
  return projectHistory(captures).rows;
}

function rowFor(captures: SavedSessionMetadata[], id: string) {
  return rowsOf(captures).find((row) => row.commit.id === id)!;
}

describe("projectHistory · linear evolution", () => {
  it("puts a straight run on one lane", () => {
    const rows = rowsOf(linear);
    expect(rows).toHaveLength(4);
    expect(new Set(rows.map((row) => row.lane)).size).toBe(1);
    expect(rows.every((row) => row.depth === 0)).toBe(true);
  });

  it("lists the most recent work first", () => {
    expect(rowsOf(linear).map((row) => row.commit.id)).toEqual(["c4", "c3", "c2", "c1"]);
  });

  it("puts the latest badge on the first row", () => {
    const rows = rowsOf(linear);
    expect(rows[0]!.latest).toBe(true);
    expect(rows.filter((row) => row.latest)).toHaveLength(1);
  });

  it("marks no branch point when nothing forked", () => {
    expect(rowsOf(linear).some((row) => row.branchPoint)).toBe(false);
  });
});

describe("projectHistory · returning to an older state", () => {
  it("forks at the commit that was reopened", () => {
    const forks = rowsOf(returned).filter((row) => row.branchPoint);
    expect(forks.map((row) => row.commit.id)).toEqual(["c1"]);
  });

  it("puts the two lineages on different lanes", () => {
    const rows = rowsOf(returned);
    const laneOf = (id: string) => rows.find((row) => row.commit.id === id)!.lane;
    expect(laneOf("c3")).not.toBe(laneOf("c5"));
  });

  it("keeps the line still being worked on the trunk", () => {
    // c4/c5 continued the reopened set and are the most recent work, so they
    // are the mainline. The v2 line was left behind.
    const rows = rowsOf(returned);
    expect(rowFor(returned, "c5").depth).toBe(0);
    expect(rows.find((row) => row.commit.id === "c3")!.depth).toBeGreaterThan(0);
  });

  it("points every row at its parent's row", () => {
    const rows = rowsOf(returned);
    for (const row of rows) {
      if (row.commit.parentId === null) {
        expect(row.parentRow).toBeNull();
      } else {
        expect(rows[row.parentRow!]!.commit.id).toBe(row.commit.parentId);
      }
    }
  });

  it("shows every intermediate stretch of work", () => {
    // Five commits across two sets. Reopening and continuing is visible as its
    // own work, not as a tick mark on a file node.
    expect(rowsOf(returned)).toHaveLength(5);
  });
});

describe("projectHistory · unobserved files", () => {
  it("keeps scanned files out of the rows and lists them separately", () => {
    const history = projectHistory([
      work("c1", "nightfall", 0),
      onDisk("scan1", "nightfall v7", 3),
      onDisk("scan2", "nightfall v8", 4),
    ]);
    expect(history.rows.map((row) => row.commit.id)).toEqual(["c1"]);
    expect(history.artifacts.map((artifact) => artifact.id)).toEqual(["scan1", "scan2"]);
  });

  it("gives a project with no captured work no rows at all", () => {
    const history = projectHistory([onDisk("scan1", "one", 0), onDisk("scan2", "two", 3)]);
    expect(history.rows).toEqual([]);
    expect(history.artifacts).toHaveLength(2);
  });

  it("counts empty checkpoints rather than dropping them silently", () => {
    const history = projectHistory([
      work("c1", "nightfall", 0),
      work("empty", "nightfall", 2, { event_count: 0, creative_event_count: 0 }),
    ]);
    expect(history.rows).toHaveLength(1);
    expect(history.emptyCheckpoints).toBe(1);
  });
});

describe("projectHistory · equal timestamps", () => {
  it("does not link commits that began at the same instant", () => {
    const rows = rowsOf([work("a", "one", 0), work("b", "two", 0)]);
    expect(rows.every((row) => row.parentRow === null)).toBe(true);
  });

  it("gives tied roots their own lanes rather than stacking them", () => {
    const rows = rowsOf([work("a", "one", 0), work("b", "two", 0)]);
    expect(new Set(rows.map((row) => row.lane)).size).toBe(2);
  });
});

describe("railShape", () => {
  it("reserves a column for every lane", () => {
    expect(railShape(rowsOf(returned)).columns).toBeGreaterThanOrEqual(2);
  });

  it("colours each lane by its own depth, not the row it passes", () => {
    const shape = railShape(rowsOf(returned));
    expect(shape.depthOf.get(0)).toBe(0);
    expect([...shape.depthOf.values()].some((depth) => depth > 0)).toBe(true);
  });

  it("stops a lane at its newest and oldest commit", () => {
    const rows = rowsOf(returned);
    const shape = railShape(rows);
    for (const [lane, head] of shape.headRow) {
      expect(rows[head]!.lane).toBe(lane);
      expect(rows[shape.tailRow.get(lane)!]!.lane).toBe(lane);
    }
  });

  it("keeps a branch lane drawn across the rows between its commits", () => {
    const rows = rowsOf(returned);
    const branchLane = rows.find((row) => row.depth > 0)!.lane;
    expect(rows.filter((row) => row.railLanes.includes(branchLane)).length).toBeGreaterThan(1);
  });

  it("draws the parent's lane down to the forking child, so the elbow lands on it", () => {
    // The elbow leaves the child's lane and ends on the parent's. If the
    // parent's lane were not drawn at the child's row the connector would
    // arrive at nothing.
    const rows = rowsOf(returned);
    const forking = rows.find((row) => row.parentLane !== null && row.parentLane !== row.lane)!;
    const childIndex = rows.indexOf(forking);
    expect(rows[childIndex]!.railLanes).toContain(forking.parentLane);
  });
});

describe("elbowPath", () => {
  it("draws a connector when the parent is on another lane", () => {
    const rows = rowsOf(returned);
    const forking = rows.find((row) => row.parentLane !== null && row.parentLane !== row.lane)!;
    const path = elbowPath(forking);
    expect(path).not.toBeNull();
    // Orthogonal with one rounded corner (§11): straight runs and a single arc,
    // never a bezier.
    expect(path).toMatch(/^M .* L .* A .* L /);
    expect(path).not.toMatch(/[CQS]/);
  });

  it("starts at the child's node and ends on the parent's lane", () => {
    const rows = rowsOf(returned);
    const forking = rows.find((row) => row.parentLane !== null && row.parentLane !== row.lane)!;
    const path = elbowPath(forking)!;
    expect(path.startsWith(`M ${laneX(forking.lane)} ${RAIL_NODE_Y}`)).toBe(true);
    expect(path.endsWith(`L ${laneX(forking.parentLane!)} ${RAIL_ROW_H}`)).toBe(true);
  });

  it("draws nothing when parent and child share a lane", () => {
    // The lane's own vertical run already connects them; a second line on top
    // would be noise.
    const rows = rowsOf(linear);
    const sameLane = rows.find((row) => row.parentLane === row.lane)!;
    expect(elbowPath(sameLane)).toBeNull();
  });

  it("draws nothing for a root", () => {
    const rows = rowsOf(linear);
    expect(elbowPath(rows[rows.length - 1]!)).toBeNull();
  });
});

describe("groupByDay", () => {
  it("splits the rows into calendar days, newest first", () => {
    // linear runs 0h, 5h, 30h, 50h from the same start, so it spans three days.
    const days = groupByDay(rowsOf(linear));
    expect(days.length).toBeGreaterThan(1);
    expect(days[0]!.atMs).toBeGreaterThan(days[days.length - 1]!.atMs);
  });

  it("keeps commits from the same day together", () => {
    const days = groupByDay(rowsOf([work("a", "one", 0), work("b", "one", 2)]));
    expect(days).toHaveLength(1);
    expect(days[0]!.entries).toHaveLength(2);
  });

  it("keeps every row's ORIGINAL index", () => {
    // The rail is indexed by position in the whole list. Renumbering inside a
    // group would break every lane's head and tail, and the lines would stop
    // meeting across a day boundary.
    const rows = rowsOf(linear);
    const flat = groupByDay(rows).flatMap((day) => day.entries);
    expect(flat.map((entry) => entry.index)).toEqual(rows.map((_, index) => index));
    for (const entry of flat) {
      expect(rows[entry.index]).toBe(entry.row);
    }
  });

  it("loses no rows", () => {
    const rows = rowsOf(returned);
    const flat = groupByDay(rows).flatMap((day) => day.entries);
    expect(flat).toHaveLength(rows.length);
  });

  it("handles an empty history", () => {
    expect(groupByDay([])).toEqual([]);
  });
});
