// The project's history as commits.
//
// WHAT CHANGED, AND WHY THE OLD MODEL WAS WRONG
//
// The Timeline used to graph `.als` FILES: one node per filename, parentage
// inferred from version numbers in the name and from the clock. That made the
// filename the identity of the history, which is backwards. A producer's
// project is the repository; the files are working states of it. Naming is a
// convention people follow inconsistently or not at all, so a graph built on
// it was guessing at exactly the moments it most needed to be right, and it
// could not show the thing that matters most — that you went back and kept
// working.
//
// Here the project is the repository and a captured stretch of work is a
// commit. The `.als` path is metadata ON a commit, the way a branch name is
// metadata on a git commit: useful as a label, never the identity.
//
// THE COMMIT BOUNDARY
//
// A commit is one capture session that recorded work. The boundary is not
// invented here — the backend already ends a session when the app closes, when
// four hours pass idle (`STALE_SESSION_IDLE_MS`, session.rs), or when Ableton
// opens a different set (`rotate_session_if_project_changed`, udp_listener.rs).
// That is precisely "a continuous stretch of work against one state of the
// project", which is what a commit is. Using it means no new grouping rule to
// tune and no risk of the graph disagreeing with the Report about where one
// piece of work ended and the next began.
//
// A session that recorded nothing is a checkpoint, not a commit. Recall opened
// a take, watched, and saw no work; there is nothing to put in the history and
// a node for it would claim otherwise.
//
// WHERE BRANCHES COME FROM
//
// Only from captured activity. Two rules, no filename parsing and no bare
// chronology:
//
//   continued — the most recent earlier commit against the SAME set. You
//     reopened that state and kept going. Recall watched both stretches; this
//     is observed and draws solid.
//
//   branched — this is the first work Recall has seen against this set, and it
//     was capturing a different set right before. The new state came off the
//     one you had open. That is inference, so it draws dashed and says so.
//
// The fork falls out of the first rule rather than being detected specially.
// Work set A, save B and work it, then reopen A and carry on: the new A commit
// takes the older A commit as its parent, because that is the state it
// continued, so that commit now has two children and the history forks. It is
// provable from what Recall captured and needs no naming convention at all.
//
// When neither rule applies there is no parent. Multiple roots are correct and
// expected — a project Recall only started watching halfway through genuinely
// has several beginnings, and inventing one trunk would be a lie.

import type { SavedSessionMetadata } from "../../types/recall";
import { alsSetName } from "../sessionFormat";
import { normalizeAlsPath } from "./projectVersions";

/**
 * How the parent link was established.
 *
 * `continued` is observed: Recall captured work against this set before, and
 * this is more of it. `branched` is inferred: a new set appeared while Recall
 * was capturing another, so this probably came off it.
 */
export type CommitBasis = "continued" | "branched";

/**
 * How long a captured stretch stays a plausible origin for a NEW set.
 *
 * Only `branched` consults this. Continuing the same set needs no window:
 * reopening a file after six months is still literally continuing that state,
 * and the gap says nothing about whether it happened.
 *
 * Past this, a new set appearing is a fresh start rather than a save-as, and
 * the honest answer is a root with no parent at all.
 *
 * Was three days, and the first real project broke it: a four-day gap between
 * sessions is an ordinary week, not a fresh start, and it stranded a commit as
 * a root that plainly continued the work before it. Two weeks is the interval
 * at which a producer genuinely has to reopen the project and remember where
 * they were. It stays well short of "any earlier commit", which would be the
 * bare chronology this model exists to avoid — and whatever it links is drawn
 * dashed and says outright that it was not observed.
 */
export const CONTINUATION_WINDOW_MS = 1000 * 60 * 60 * 24 * 14;

export type ProjectCommit = {
  /** The capture session's id. Stable, and what the Report and workspace key on. */
  id: string;
  session: SavedSessionMetadata;
  parentId: string | null;
  basis: CommitBasis | null;
  /** Dashed when true. A guess must never be drawn the way a fact is. */
  inferred: boolean;
  /** Plain language, accurate about which evidence was actually used. */
  reason: string;
  /** Metadata, not identity: which set was open while this work happened. */
  alsPath: string | null;
  /** The set's display name, when there is one. */
  setName: string | null;
  /** When this stretch of work began. */
  atMs: number;
  /** Last moment work landed against it. */
  endedAtMs: number;
  /** Recorded changes in this commit — its contents. */
  changes: number;
  /** Changes Recall judged creative rather than incidental. */
  creativeChanges: number;
  /** Still capturing. */
  live: boolean;
};

/**
 * A set found on disk that Recall never watched being made.
 *
 * Deliberately NOT a commit and deliberately unlinked. A scanned file is a fact
 * about the filesystem — `storage.rs::add_scanned_takes` writes one row per
 * `.als` with the file's modified time and no events. Forcing it into the
 * history would mean inventing work that was never observed, which is the exact
 * failure this rewrite exists to remove. It is shown, and shown as unlinked.
 */
export type ProjectArtifact = {
  id: string;
  session: SavedSessionMetadata;
  alsPath: string | null;
  setName: string | null;
  /** The file's modified time. Not a claim about when work happened. */
  atMs: number;
};

export type ProjectHistoryModel = {
  commits: ProjectCommit[];
  artifacts: ProjectArtifact[];
  /**
   * Sessions that recorded nothing. Counted so the surface can say so rather
   * than silently dropping them, but never drawn as history.
   */
  emptyCheckpoints: number;
};

function setNameOf(session: SavedSessionMetadata): string | null {
  return alsSetName(session.als_path) ?? session.display_name?.trim() ?? null;
}

function label(commit: { setName: string | null }): string {
  return commit.setName ?? "an unsaved set";
}

/** Did this session record any work at all? */
function recordedWork(session: SavedSessionMetadata): boolean {
  return session.event_count > 0 || session.creative_event_count > 0;
}

/**
 * Build the commit history for one project.
 *
 * Captures arrive in any order and are sorted by start. Ties are handled by
 * refusing to link rather than by picking one: two commits that began at the
 * same instant carry no evidence about which continued which, and choosing
 * arbitrarily would invent a parentage the data does not support.
 */
export function projectCommits(captures: SavedSessionMetadata[]): ProjectHistoryModel {
  const artifacts: ProjectArtifact[] = [];
  const working: SavedSessionMetadata[] = [];
  let emptyCheckpoints = 0;

  for (const session of captures) {
    if (session.take_origin === "scanned") {
      artifacts.push({
        id: session.id,
        session,
        alsPath: normalizeAlsPath(session.als_path),
        setName: setNameOf(session),
        atMs: session.started_at_ms,
      });
      continue;
    }
    if (!recordedWork(session)) {
      emptyCheckpoints += 1;
      continue;
    }
    working.push(session);
  }

  const ordered = [...working].sort((a, b) => a.started_at_ms - b.started_at_ms);

  const commits: ProjectCommit[] = ordered.map((session) => ({
    id: session.id,
    session,
    parentId: null,
    basis: null,
    inferred: false,
    reason: "",
    alsPath: normalizeAlsPath(session.als_path),
    setName: setNameOf(session),
    atMs: session.started_at_ms,
    endedAtMs: session.ended_at_ms ?? session.last_updated_at_ms,
    changes: session.event_count,
    creativeChanges: session.creative_event_count,
    live: session.ended_at_ms === null,
  }));

  commits.forEach((commit, index) => {
    // Only commits that STARTED strictly earlier are candidates. Equal starts
    // are not evidence of order, so they never establish parentage.
    const earlier = commits.slice(0, index).filter((other) => other.atMs < commit.atMs);
    if (earlier.length === 0) {
      commit.reason = "The first work Recall captured in this project.";
      return;
    }

    // 1. Same set: this continues a state Recall already watched. Observed.
    const sameSet =
      commit.alsPath === null
        ? null
        : [...earlier].reverse().find((other) => other.alsPath === commit.alsPath) ?? null;

    if (sameSet) {
      commit.parentId = sameSet.id;
      commit.basis = "continued";
      commit.inferred = false;
      commit.reason = `Picked up ${label(commit)} where the earlier session left it.`;
      return;
    }

    // 2. New set, and Recall was capturing another one recently enough that
    //    this state plausibly came off it. Inference, and it says so.
    const previous = earlier[earlier.length - 1]!;
    const gap = commit.atMs - previous.endedAtMs;
    if (gap <= CONTINUATION_WINDOW_MS) {
      commit.parentId = previous.id;
      commit.basis = "branched";
      commit.inferred = true;
      commit.reason =
        `Recall was capturing ${label(previous)} just before work on ${label(commit)} ` +
        `began, so this most likely came off it. Not observed directly.`;
      return;
    }

    // 3. Nothing to go on. A root, and better than an invented parent.
    commit.reason =
      `Recall had not captured anything for a while when this began, ` +
      `so there is no evidence of what it came from.`;
  });

  return { commits, artifacts, emptyCheckpoints };
}

/**
 * How much a parent link is worth believing, high to low.
 *
 * The layout uses this to pick which child keeps the lane: work that continued
 * the same set is the mainline, and a new set coming off it is the branch.
 */
export function commitStrength(basis: CommitBasis | null): number {
  switch (basis) {
    case "continued":
      return 2;
    case "branched":
      return 1;
    default:
      return 0;
  }
}

/** Children of each commit, oldest first. The fork test the layout runs on. */
export function commitChildren(commits: ProjectCommit[]): Map<string, ProjectCommit[]> {
  const children = new Map<string, ProjectCommit[]>();
  for (const commit of commits) {
    if (commit.parentId === null) continue;
    children.set(commit.parentId, [...(children.get(commit.parentId) ?? []), commit]);
  }
  for (const [parentId, group] of children) {
    children.set(parentId, [...group].sort((a, b) => a.atMs - b.atMs));
  }
  return children;
}
