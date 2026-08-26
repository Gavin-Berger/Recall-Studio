// Where versions came from — the parent edge the version graph draws.
//
// THE PROBLEM THIS SOLVES
//
// `projectVersions()` already answers "which .als files does this project have,
// and what work happened against each." That is a list. What it cannot answer
// is the question a producer actually asks when they open a two-month-old
// project: *which file came from which?*
//
//     pers ep nightfall.als
//     pers ep nightfall v2.als
//     pers ep nightfall v3.als
//     pers ep nightfall v3 alt.als
//     pers ep nightfall v4.als
//
// Sorted by date that is a flat list of five things. As a lineage it is a
// shape: a straight run to v3, a fork where you tried something else, and a
// trunk that carried on to v4. The fork is the interesting part and the list
// cannot show it, because a list has no second dimension.
//
// WHY THIS IS A GUESS, AND WHY THAT IS OK
//
// Nothing in `SavedSessionMetadata` records that v4 was saved *from* v3 —
// there is no parent column, because Live never told us. Until the backend
// observes a save-as directly (a new `.als` path appearing while another was
// live), parentage is inferred here from the file names and the clock.
//
// DESIGN.md §11 makes that shippable rather than dishonest: an inferred edge
// renders dashed and says in plain language what it guessed. Recall never
// pretends (§1). When the observed edge arrives it slots in as
// `basis: "observed"`, renders solid, and this inference becomes the fallback
// for everything captured before that existed.

import type { ProjectVersion } from "./projectVersions";

/**
 * How confident the parent edge is, in the order we would prefer to have it.
 *
 * - `observed` — Recall watched the save happen. Renders solid. Not produced
 *   yet; the backend has nowhere to record it. Handled here so the graph does
 *   not need changing when it lands.
 * - `filename` — the names carry version numbers off a shared stem, so `v4`
 *   follows `v3`. A good guess, and the one producers would make themselves.
 * - `chronological` — nothing in the name to go on, so the most recent earlier
 *   version is assumed to be the parent. A weak guess, and it is labelled as one.
 */
export type ParentageBasis = "observed" | "filename" | "chronological";

export type VersionNode = {
  /** Same id as the underlying version: the normalized `.als` path. */
  id: string;
  version: ProjectVersion;
  /** The version this one descends from, or null for a root. */
  parentId: string | null;
  /** Null only for a root, which has nothing to justify. */
  basis: ParentageBasis | null;
  /**
   * Whether the edge was guessed. Drives the dashed stroke in §11 — the graph
   * must never draw a guess the same way it draws a fact.
   */
  inferred: boolean;
  /**
   * Plain language, shown on hover. Producer vocabulary, no jargon (§10), and
   * it says outright when it is guessing.
   */
  reason: string;
};

/** A file name split into the part that names the song and the part that counts. */
export type VersionStem = {
  /** Normalized name with any trailing version number removed. */
  stem: string;
  /** The trailing version number, or null when the name does not carry one. */
  ordinal: number | null;
};

/**
 * Pull a version number off the end of a set name.
 *
 * Only a *trailing* number counts. `nightfall v4` and `nightfall 4` are the
 * fourth version of `nightfall`; `nightfall v4 alt` is not the fourth version
 * of anything — the trailing word means the producer deliberately branched off
 * and named the branch. Treating it as a separate stem is what puts it on its
 * own lane, which is exactly where it belongs.
 *
 * Separators are normalized because the same song is written `nightfall_v4`,
 * `nightfall-v4`, and `Nightfall V4` depending on who saved it and when.
 */
export function parseVersionName(name: string): VersionStem {
  const normalized = name
    .trim()
    .replace(/\.als$/i, "")
    .replace(/[_\-\s]+/g, " ")
    .trim()
    .toLocaleLowerCase();

  const match = /^(.*?)\s*v?(\d+)$/.exec(normalized);
  if (!match) return { stem: normalized, ordinal: null };

  const stem = match[1]!.trim();
  // "v4" on its own has no song in front of it. There is nothing to group by,
  // so keep the whole string as the stem rather than inventing an empty one.
  if (!stem) return { stem: normalized, ordinal: null };

  return { stem, ordinal: Number(match[2]) };
}

/** The one-line justification shown when a producer hovers an edge. */
function reasonFor(basis: ParentageBasis, child: ProjectVersion, parent: ProjectVersion): string {
  switch (basis) {
    case "observed":
      return `Saved from ${parent.name} while Recall was capturing.`;
    case "filename":
      return `${child.name} follows ${parent.name} — read from the file names, not observed.`;
    case "chronological":
      return `Opened after ${parent.name}. No version number to follow, so this link is a guess.`;
  }
}

type Candidate = { version: ProjectVersion; stem: VersionStem };

/**
 * Pick the parent for one version out of everything that came before it.
 *
 * Filename lineage wins when it exists: among earlier versions sharing a stem,
 * the one with the highest number below ours. A tie — two files claiming the
 * same number, which happens the moment someone saves `v3` twice — breaks to
 * the one worked on most recently, because that is the one that was in front
 * of the producer.
 *
 * Otherwise fall back to the clock. It is a weak guess and it is labelled as
 * one, but it is better than a root: five disconnected roots is not a history,
 * and the producer can see the dashed line and correct it later.
 */
function pickParent(
  child: Candidate,
  earlier: Candidate[],
): { parent: ProjectVersion; basis: ParentageBasis } | null {
  if (earlier.length === 0) return null;

  if (child.stem.ordinal !== null) {
    // An unnumbered file is version one of its own stem. Producers do not name
    // the first save `v1` — the folder holds `nightfall.als` and then
    // `nightfall v2.als`, and those are obviously the same song. Reading the
    // bare stem as ordinal 0 keeps that first hop on the filename lineage
    // instead of demoting the most obvious link in the project to a guess.
    const sameLine = earlier
      .map((other) => ({ ...other, ordinal: other.stem.ordinal ?? 0 }))
      .filter((other) => other.stem.stem === child.stem.stem && other.ordinal < child.stem.ordinal!);
    if (sameLine.length > 0) {
      const best = sameLine.reduce((a, b) => {
        if (b.ordinal !== a.ordinal) return b.ordinal > a.ordinal ? b : a;
        return b.version.startedAtMs > a.version.startedAtMs ? b : a;
      });
      return { parent: best.version, basis: "filename" };
    }
  }

  const mostRecent = earlier.reduce((a, b) =>
    b.version.startedAtMs > a.version.startedAtMs ? b : a,
  );
  return { parent: mostRecent.version, basis: "chronological" };
}

/**
 * Build the version DAG for one project.
 *
 * Versions arrive oldest first from `projectVersions()` and stay that way: a
 * node can only descend from something that already existed, so processing in
 * time order means every candidate parent has been seen by the time we need it,
 * and a cycle is not representable.
 */
export function versionGraph(versions: ProjectVersion[]): VersionNode[] {
  const ordered = [...versions].sort((a, b) => a.startedAtMs - b.startedAtMs);
  const candidates: Candidate[] = ordered.map((version) => ({
    version,
    stem: parseVersionName(version.name),
  }));

  return candidates.map((candidate, index) => {
    const picked = pickParent(candidate, candidates.slice(0, index));
    if (!picked) {
      return {
        id: candidate.version.id,
        version: candidate.version,
        parentId: null,
        basis: null,
        inferred: false,
        reason: "The first version Recall knows about.",
      };
    }
    return {
      id: candidate.version.id,
      version: candidate.version,
      parentId: picked.parent.id,
      basis: picked.basis,
      inferred: picked.basis !== "observed",
      reason: reasonFor(picked.basis, candidate.version, picked.parent),
    };
  });
}

/**
 * How much an edge is worth believing, high to low.
 *
 * The layout uses this to decide which child carries the trunk: between a
 * version whose name follows its parent and one that merely happened next,
 * the named one is the continuation and the other is the branch.
 */
export function parentageStrength(basis: ParentageBasis | null): number {
  switch (basis) {
    case "observed":
      return 2;
    case "filename":
      return 1;
    default:
      return 0;
  }
}

/** Children of each node, oldest first. The fork test the layout runs on. */
export function childrenByParent(nodes: VersionNode[]): Map<string, VersionNode[]> {
  const children = new Map<string, VersionNode[]>();
  for (const node of nodes) {
    if (node.parentId === null) continue;
    children.set(node.parentId, [...(children.get(node.parentId) ?? []), node]);
  }
  for (const [parentId, group] of children) {
    children.set(
      parentId,
      [...group].sort((a, b) => a.version.startedAtMs - b.version.startedAtMs),
    );
  }
  return children;
}
