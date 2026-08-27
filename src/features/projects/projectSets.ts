// The sets in a project, and how each one came about.
//
// WHY THE SET IS THE UNIT, NOT THE PROJECT
//
// A project holds several `.als` files, and pouring all of their work into one
// stream reads as one long undifferentiated day. It is not: a producer sits
// down inside ONE set and makes decisions there. "Breaking Point v2 mixdown"
// is where the work happened; "Breaking Point" is where it came from.
//
// So the list focuses on a set, and the relationship between sets stays as
// context — a line saying where this one came off, and the graph above, which
// has always drawn every set and is exactly the picture of how they relate.
//
// The lineage is not recomputed here. A set's origin is read off the session
// lineage already established in `projectCommits`: the first session in this
// set has a parent, and if that parent was captured against a different set,
// that is where this one came from. Same evidence, same honesty about whether
// it was watched or inferred.

import type { ProjectCommit } from "./projectCommits";

export type ProjectSet = {
  /** Stable: the normalized path, or the name when there is no path. */
  key: string;
  name: string;
  /** How many times the producer sat down in this set. */
  sessions: number;
  /** Recorded changes across all of them. */
  changes: number;
  firstAtMs: number;
  lastAtMs: number;
  /** Still capturing into this set. */
  live: boolean;
  /**
   * The set this one came off, when the work that started it continued from
   * somewhere else.
   */
  cameFrom: string | null;
  /** True when that origin was inferred rather than watched. */
  cameFromInferred: boolean;
};

function keyOf(commit: ProjectCommit): string {
  return commit.alsPath ?? commit.setName ?? "unsaved";
}

/**
 * Group a project's sessions by the set they happened in.
 *
 * Ordered by most recent work first, so the set a producer is currently in is
 * the one the list opens on.
 */
export function projectSets(commits: ProjectCommit[]): ProjectSet[] {
  const byKey = new Map<string, ProjectCommit[]>();
  for (const commit of commits) {
    const key = keyOf(commit);
    byKey.set(key, [...(byKey.get(key) ?? []), commit]);
  }

  const setOfCommit = new Map(commits.map((commit) => [commit.id, keyOf(commit)]));
  const nameOfKey = new Map<string, string>();
  for (const [key, group] of byKey) {
    nameOfKey.set(key, group[0]?.setName ?? "Unsaved set");
  }

  const sets: ProjectSet[] = [];
  for (const [key, group] of byKey) {
    const ordered = [...group].sort((a, b) => a.atMs - b.atMs);
    const earliest = ordered[0]!;

    // Where this set came from: the parent of its FIRST session, when that
    // parent lived in a different set. A parent in the same set means the
    // producer simply kept going, which is not an origin.
    let cameFrom: string | null = null;
    let cameFromInferred = false;
    if (earliest.parentId) {
      const parentKey = setOfCommit.get(earliest.parentId);
      if (parentKey && parentKey !== key) {
        cameFrom = nameOfKey.get(parentKey) ?? null;
        cameFromInferred = earliest.inferred;
      }
    }

    sets.push({
      key,
      name: nameOfKey.get(key) ?? "Unsaved set",
      sessions: ordered.length,
      changes: ordered.reduce((total, commit) => total + commit.changes, 0),
      firstAtMs: earliest.atMs,
      lastAtMs: ordered.reduce((latest, commit) => Math.max(latest, commit.endedAtMs), 0),
      live: ordered.some((commit) => commit.live),
      cameFrom,
      cameFromInferred,
    });
  }

  return sets.sort((a, b) => b.lastAtMs - a.lastAtMs);
}

/** The set a producer should land on: the one worked most recently. */
export function defaultSetKey(sets: ProjectSet[]): string | null {
  return sets[0]?.key ?? null;
}

/** Only the work that happened in one set. */
export function commitsInSet(commits: ProjectCommit[], setKey: string | null): ProjectCommit[] {
  if (setKey === null) return commits;
  return commits.filter((commit) => keyOf(commit) === setKey);
}
