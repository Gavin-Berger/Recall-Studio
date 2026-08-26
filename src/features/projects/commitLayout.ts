// Commits → lanes. The structural layer, shared by the overview graph and the
// list, so the two can never disagree about the shape of the history.
//
// It emits the same `GraphLayout` the file-version graph emitted, which means
// `graphGeometry` and `collapseGaps` are reused untouched: those modules are
// about pixels and time, not about what a node means, and they were already
// right. Only the model underneath them changed.
//
// WHICH CHILD KEEPS THE LANE
//
// Git draws first-parent as the trunk because git is told which parent is
// first. Nothing tells Recall, so the lane follows the strongest evidence:
// work that CONTINUED the same set is the mainline, and a new set coming off it
// is the branch. That matches what a producer means — carrying on in the file
// you were in is the song moving forward; saving a copy and trying something is
// the departure.
//
// Ties break to whichever child has the most recent work anywhere beneath it.
// The line the song is still alive on is the mainline, which is what --lane-0
// claims to be (DESIGN.md §11). Age is deliberately NOT the tiebreak: it would
// hand the trunk to whichever fork was opened first and then abandoned.

import { commitChildren, commitStrength, type ProjectCommit } from "./projectCommits";
import type { GraphLayout, GraphLane } from "./versionGraphLayout";

export function layoutCommits(commits: ProjectCommit[]): GraphLayout {
  const byId = new Map(commits.map((commit) => [commit.id, commit]));
  const children = commitChildren(commits);

  // A commit whose parent is missing is a root too, not an orphan to drop.
  const roots = commits
    .filter((commit) => commit.parentId === null || !byId.has(commit.parentId))
    .sort((a, b) => a.atMs - b.atMs);

  const lanes: GraphLane[] = [];
  const laneOf = new Map<string, number>();

  // Most recent work anywhere below a commit, memoised because the heir test
  // asks for it at every fork on the way down.
  const liveliness = new Map<string, number>();
  function latestWorkUnder(commit: ProjectCommit): number {
    const cached = liveliness.get(commit.id);
    if (cached !== undefined) return cached;
    const under = (children.get(commit.id) ?? []).map(latestWorkUnder);
    const latest = Math.max(commit.endedAtMs, ...under);
    liveliness.set(commit.id, latest);
    return latest;
  }

  function openLane(depth: number): number {
    const lane: GraphLane = { index: lanes.length, depth, nodeIds: [] };
    lanes.push(lane);
    return lane.index;
  }

  function walk(commit: ProjectCommit, lane: number) {
    lanes[lane]!.nodeIds.push(commit.id);
    laneOf.set(commit.id, lane);

    const kids = children.get(commit.id) ?? [];
    if (kids.length === 0) return;

    const heir = kids.reduce((a, b) => {
      const strength = commitStrength(b.basis) - commitStrength(a.basis);
      if (strength !== 0) return strength > 0 ? b : a;
      const alive = latestWorkUnder(b) - latestWorkUnder(a);
      if (alive !== 0) return alive > 0 ? b : a;
      return b.atMs < a.atMs ? b : a;
    });

    // Trunk first so lane indices read top-down: the line the song is on, then
    // its branches in the order they were taken.
    walk(heir, lane);
    for (const child of kids) {
      if (child === heir) continue;
      walk(child, openLane(lanes[lane]!.depth + 1));
    }
  }

  for (const root of roots) walk(root, openLane(0));

  return {
    lanes,
    placements: commits.map((commit) => ({
      nodeId: commit.id,
      lane: laneOf.get(commit.id) ?? 0,
      atMs: commit.atMs,
      // A commit is one stretch of work, so its own span is the only tick it
      // carries. The old model put every sitting on one file node here, which
      // is exactly the detail that is now a node of its own.
      sittingsMs: [],
    })),
    edges: commits
      .filter((commit) => commit.parentId !== null && byId.has(commit.parentId))
      .map((commit) => ({
        fromId: commit.parentId!,
        toId: commit.id,
        fromLane: laneOf.get(commit.parentId!) ?? 0,
        toLane: laneOf.get(commit.id) ?? 0,
        atMs: commit.atMs,
        inferred: commit.inferred,
      })),
  };
}
