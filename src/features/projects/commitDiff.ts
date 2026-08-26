// What changed in the set between a commit and the one it came from.
//
// This is `git show`. A commit already says what the producer DID inside it —
// which tracks, which devices, how many moves. What it could not say is what
// the project looked like before and after, which is the other half of reading
// a history: not "I turned some knobs" but "this commit is where the second
// Serum arrived".
//
// The comparison is against the PARENT, not against the row printed underneath.
// On a fork those are different commits, and the parent is the one that
// actually preceded this state. Following the lineage here is the same choice
// the `p` key makes, for the same reason.
//
// WHAT IT REFUSES TO CLAIM
//
// `compareSchemas` is deliberately coarse — tracks and devices added or
// removed, nothing finer — because that is all two snapshots can prove.
// Parameter-level compare would need per-commit parameter snapshots that do not
// exist, and inventing it is the failure mode this codebase keeps having to
// undo. A commit with no snapshot on either side reports that it cannot say,
// rather than reporting "nothing changed", because those are different facts.

import type { ProjectSchema } from "../../types/schema";
import { compareSchemas, diffIsEmpty, type VersionDiff } from "./versionDiff";

export type CommitDiff =
  /** The first work Recall captured; there is nothing before it to compare. */
  | { status: "root" }
  /** One side has no structure snapshot, so no honest comparison is possible. */
  | { status: "unknown" }
  /** Both snapshots exist and the set's structure is identical. */
  | { status: "unchanged" }
  | { status: "changed"; diff: VersionDiff };

/** Top N per list. A commit that added forty tracks is a number, not a list. */
export const DIFF_LIMIT = 5;

export function commitDiff(
  parentSchema: ProjectSchema | null,
  schema: ProjectSchema | null,
  hasParent: boolean,
): CommitDiff {
  if (!hasParent) return { status: "root" };
  // `has_snapshot` false means the session recorded work but never captured
  // the set's structure. Treating that as "nothing changed" would put a
  // confident claim on top of an absence.
  if (!parentSchema?.has_snapshot || !schema?.has_snapshot) return { status: "unknown" };

  const diff = compareSchemas(parentSchema, schema);
  return diffIsEmpty(diff) ? { status: "unchanged" } : { status: "changed", diff };
}

export type DiffLine = {
  key: string;
  /** "+" for arrived, "−" for gone. */
  sign: "+" | "−";
  label: string;
  context: string | null;
};

/**
 * The diff as lines, additions first.
 *
 * Additions lead because a history is read forwards: what a commit BROUGHT is
 * the reason it exists, and what it removed is the supporting detail.
 */
export function diffLines(diff: VersionDiff): { lines: DiffLine[]; total: number } {
  const all: DiffLine[] = [
    ...diff.addedTracks.map((track) => ({
      key: `+t:${track}`,
      sign: "+" as const,
      label: track,
      context: "track",
    })),
    ...diff.addedDevices.map((change) => ({
      key: `+d:${change.track}/${change.device}`,
      sign: "+" as const,
      label: change.device,
      context: change.track,
    })),
    ...diff.removedTracks.map((track) => ({
      key: `-t:${track}`,
      sign: "−" as const,
      label: track,
      context: "track",
    })),
    ...diff.removedDevices.map((change) => ({
      key: `-d:${change.track}/${change.device}`,
      sign: "−" as const,
      label: change.device,
      context: change.track,
    })),
  ];

  return { lines: all.slice(0, DIFF_LIMIT), total: all.length };
}

/** One line summarising the diff, in the producer's terms. */
export function diffHeadline(diff: VersionDiff): string {
  const added = diff.addedTracks.length + diff.addedDevices.length;
  const removed = diff.removedTracks.length + diff.removedDevices.length;
  const parts: string[] = [];
  if (added > 0) parts.push(`${added} added`);
  if (removed > 0) parts.push(`${removed} removed`);
  return parts.join(" · ");
}
