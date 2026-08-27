// What the graph draws: sessions collapsed, and the open one as its steps.
//
// THE UNIT IS A STEP
//
// A whole session as one node is too coarse — an evening and a thousand changes
// summarised as a number, which is why every row read alike. One node per
// change is too fine: a thousand nodes for one evening is a log, and a log is
// what Recall had before any of this. A STEP — one stretch of one kind of work
// on one area — is the closest thing in the capture to a decision the producer
// actually made, which is what a commit is.
//
// SO WHY ARE SESSIONS STILL NODES
//
// Because drawing every step of every session at once is unreadable, and
// because the steps are not free: working them out needs that session's
// changes, notes and clips fetched. A song with forty sessions would mean forty
// round trips to draw a picture nobody has looked at yet.
//
// So the graph draws each session as one node carrying its step count, and the
// session you OPEN expands into its steps in place while its neighbours stay
// collapsed. Same cost as today — one session's detail — and the overview stays
// about the shape of the song.
//
// The chain is continuous either way: the first step of an opened session takes
// the node before it as its parent, and the session after it takes the last
// step. Expanding must never break the line.

import type { ProjectCommit } from "./projectCommits";
import type { SessionStep } from "./sessionSteps";

export type TimelineNode = {
  /** Unique across the graph. A step's id is already unique; a session uses its own. */
  id: string;
  kind: "session" | "step";
  /** The session this belongs to, collapsed or not. */
  sessionId: string;
  /** What it is called on screen. */
  label: string;
  atMs: number;
  endMs: number;
  parentId: string | null;
  /** The link to the parent was a guess, so it draws dashed. */
  inferred: boolean;
  /** Steps inside a collapsed session, or null when Recall has not read them. */
  stepCount: number | null;
  /** Recorded changes. On a step, the changes in that step. */
  changes: number;
  live: boolean;
};

function sessionNode(commit: ProjectCommit, parentId: string | null): TimelineNode {
  return {
    id: commit.id,
    kind: "session",
    sessionId: commit.id,
    label: commit.setName ?? "Unsaved set",
    atMs: commit.atMs,
    endMs: commit.endedAtMs,
    parentId,
    inferred: commit.inferred,
    stepCount: null,
    changes: commit.changes,
    live: commit.live,
  };
}

/**
 * Build the nodes for one project's graph.
 *
 * `openSteps` is the steps of `openSessionId`, when they have been read. Passing
 * an empty list collapses that session like any other, which is what happens
 * while its detail is still loading — the graph must not flicker between two
 * shapes on the way.
 */
export function timelineNodes(
  commits: ProjectCommit[],
  openSessionId: string | null,
  openSteps: SessionStep[],
): TimelineNode[] {
  const ordered = [...commits].sort((a, b) => a.atMs - b.atMs);
  const nodes: TimelineNode[] = [];

  // The last node of each session, so the session after it can chain on. For a
  // collapsed session that is the session node; for an expanded one it is its
  // final step.
  const tailOf = new Map<string, string>();

  for (const commit of ordered) {
    // Whatever the parent session ended on. A parent that is not in this
    // project's commits leaves this a root.
    const parentTail = commit.parentId ? tailOf.get(commit.parentId) ?? null : null;

    const expand = commit.id === openSessionId && openSteps.length > 0;
    if (!expand) {
      nodes.push(sessionNode(commit, parentTail));
      tailOf.set(commit.id, commit.id);
      continue;
    }

    let previous = parentTail;
    openSteps.forEach((step, index) => {
      nodes.push({
        id: step.id,
        kind: "step",
        sessionId: commit.id,
        label: step.title,
        atMs: step.startMs,
        endMs: step.endMs,
        parentId: previous,
        // Only the FIRST step inherits the session's uncertainty — it is the
        // one whose link crosses from another session. The steps after it
        // follow each other inside one sitting, which Recall watched happen.
        inferred: index === 0 ? commit.inferred : false,
        stepCount: null,
        changes: step.moves + step.noteEdits + step.clipEvents,
        live: commit.live && index === openSteps.length - 1,
      });
      previous = step.id;
    });
    tailOf.set(commit.id, previous ?? commit.id);
  }

  return nodes;
}

/** How many steps a collapsed session holds, once they are known. */
export function withStepCount(
  nodes: TimelineNode[],
  sessionId: string,
  count: number,
): TimelineNode[] {
  return nodes.map((node) =>
    node.kind === "session" && node.sessionId === sessionId
      ? { ...node, stepCount: count }
      : node,
  );
}
