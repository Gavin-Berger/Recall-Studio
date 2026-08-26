import { describe, expect, it } from "vitest";
import type { SavedSessionMetadata } from "../../types/recall";
import { layoutCommits } from "./commitLayout";
import { projectCommits, type ProjectCommit } from "./projectCommits";

const minute = 60 * 1000;
const hour = 60 * minute;
const start = 1_720_000_000_000;

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
    project_path: "C:\\Music\\nightfall",
    als_path: `C:\\Music\\nightfall\\${set}.als`,
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

function commitsOf(captures: SavedSessionMetadata[]): ProjectCommit[] {
  return projectCommits(captures).commits;
}

function laneOf(layout: ReturnType<typeof layoutCommits>, id: string): number {
  return layout.placements.find((placement) => placement.nodeId === id)!.lane;
}

describe("layoutCommits", () => {
  it("keeps a straight run on one lane", () => {
    const layout = layoutCommits(
      commitsOf([work("c1", "nightfall", 0), work("c2", "nightfall", 5), work("c3", "nightfall", 9)]),
    );
    expect(layout.lanes).toHaveLength(1);
    expect(layout.lanes[0]!.depth).toBe(0);
  });

  it("opens a lane only where a commit has a second child", () => {
    // Worked `nightfall`, moved to v2, then came back to `nightfall`. c1 now
    // has two children, and only then does a second lane exist.
    const layout = layoutCommits(
      commitsOf([
        work("c1", "nightfall", 0),
        work("c2", "nightfall v2", 3),
        work("c3", "nightfall", 8),
      ]),
    );
    expect(layout.lanes).toHaveLength(2);
    expect(laneOf(layout, "c2")).not.toBe(laneOf(layout, "c3"));
  });

  it("gives the trunk to work that continued the same set", () => {
    // `continued` is observed and outranks `branched`, which is a guess. The
    // song carrying on in the file you were already in is the mainline.
    const layout = layoutCommits(
      commitsOf([
        work("c1", "nightfall", 0),
        work("c2", "nightfall v2", 3),
        work("c3", "nightfall", 8),
      ]),
    );
    expect(laneOf(layout, "c3")).toBe(0);
    expect(layout.lanes[laneOf(layout, "c2")]!.depth).toBeGreaterThan(0);
  });

  it("breaks a tie toward the line still being worked, not the older one", () => {
    // Both children branched off (different sets, neither continues c1), so
    // strength ties and liveliness decides. c3's line was pushed on later.
    const layout = layoutCommits(
      commitsOf([
        work("c1", "one", 0),
        work("c2", "two", 3),
        work("c3", "three", 4),
        work("c4", "three", 40),
      ]),
    );
    // c4 continues `three`, so that line is alive most recently and holds the
    // trunk past the fork.
    expect(laneOf(layout, "c4")).toBe(laneOf(layout, "c3"));
  });

  it("puts a branch off a branch one level dimmer again", () => {
    const layout = layoutCommits(
      commitsOf([
        work("c1", "a", 0),
        work("c2", "b", 2),
        work("c3", "a", 4),
        work("c4", "c", 6),
        work("c5", "b", 8),
      ]),
    );
    expect(Math.max(...layout.lanes.map((lane) => lane.depth))).toBeGreaterThanOrEqual(1);
  });

  it("draws one edge per parent link and carries the guess flag through", () => {
    const commits = commitsOf([work("c1", "nightfall", 0), work("c2", "nightfall v2", 3)]);
    const layout = layoutCommits(commits);
    expect(layout.edges).toHaveLength(1);
    expect(layout.edges[0]).toMatchObject({ fromId: "c1", toId: "c2", inferred: true });
  });

  it("leaves an observed link solid", () => {
    const layout = layoutCommits(
      commitsOf([work("c1", "nightfall", 0), work("c2", "nightfall", 5)]),
    );
    expect(layout.edges[0]!.inferred).toBe(false);
  });

  it("gives every root its own lane", () => {
    // Equal timestamps produce no parentage, so both are roots and neither may
    // be stacked onto the other's line.
    const layout = layoutCommits(commitsOf([work("a", "one", 0), work("b", "two", 0)]));
    expect(layout.lanes).toHaveLength(2);
    expect(layout.edges).toHaveLength(0);
  });

  it("places every commit exactly once", () => {
    const commits = commitsOf([
      work("c1", "a", 0),
      work("c2", "b", 2),
      work("c3", "a", 4),
      work("c4", "b", 6),
    ]);
    const layout = layoutCommits(commits);
    const placed = layout.placements.map((placement) => placement.nodeId).sort();
    expect(placed).toEqual(commits.map((commit) => commit.id).sort());
    const onLanes = layout.lanes.flatMap((lane) => lane.nodeIds).sort();
    expect(onLanes).toEqual(placed);
  });

  it("carries no sitting ticks, because a commit is already one stretch of work", () => {
    // The old model hung every session off a file node as a tick. Those are
    // commits now, so a tick would draw the same fact twice.
    const layout = layoutCommits(commitsOf([work("c1", "nightfall", 0)]));
    expect(layout.placements[0]!.sittingsMs).toEqual([]);
  });

  it("handles a project with no commits", () => {
    const layout = layoutCommits([]);
    expect(layout).toEqual({ lanes: [], placements: [], edges: [] });
  });
});
