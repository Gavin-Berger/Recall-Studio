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
 * - `activity` — the producer was working in this version when the new one
 *   appeared. Weaker than a name they chose, but stronger than the clock,
 *   because it is evidence about what was actually in front of them.
 * - `chronological` — nothing to go on but the order files appeared. The
 *   weakest link in the system, and it is labelled as a guess.
 */
export type ParentageBasis = "observed" | "filename" | "activity" | "chronological";

/**
 * How long a version stays "the one you are working in" after its last sitting.
 *
 * Past this, coming back to the project is a fresh start rather than a
 * continuation, and what you had open last week says nothing about what you
 * branched from today.
 *
 * Deliberately the same three days as `DEFAULT_GAP_MS` in the layout, so the
 * span the axis collapses as dead air is the same span that stops counting as
 * a continuation — a gap the graph draws as a break should not still be
 * producing parent edges. They are separate constants because they answer
 * different questions; if you tune one, look at the other. The timeline's own
 * thresholds are unrelated and much shorter (`SESSION_SITTING_GAP_MS` is four
 * hours).
 */
export const ACTIVE_WINDOW_MS = 1000 * 60 * 60 * 24 * 3;

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
 * Split a set name into the song and the version number.
 *
 * An explicit `v4` token counts wherever it appears, not just at the end. Real
 * names put it in the middle — `Breaking Point v3 mixdown` next to
 * `Breaking Point v2 mixdown` — and an end-anchored rule reads both as
 * unnumbered and loses the most obvious lineage in the folder. Removing the
 * token rather than truncating at it is what makes those two share a stem
 * (`breaking point mixdown`) instead of splitting on the trailing word.
 *
 * A bare trailing number is the weaker fallback: `nightfall 4` is version four,
 * but only when nothing more explicit is present, because a trailing digit is
 * as likely to be part of the name.
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

  const token = /(?:^|\s)v(\d+)(?=\s|$)/.exec(normalized);
  if (token) {
    const stem = (
      normalized.slice(0, token.index) +
      " " +
      normalized.slice(token.index + token[0].length)
    )
      .replace(/\s+/g, " ")
      .trim();
    // "v4" on its own has no song in front of it. There is nothing to group by,
    // so keep the whole string rather than inventing an empty stem.
    if (stem) return { stem, ordinal: Number(token[1]) };
    return { stem: normalized, ordinal: null };
  }

  const trailing = /^(.*?)\s*(\d+)$/.exec(normalized);
  const trailingStem = trailing?.[1]?.trim();
  if (trailing && trailingStem) {
    return { stem: trailingStem, ordinal: Number(trailing[2]) };
  }

  return { stem: normalized, ordinal: null };
}

/** The one-line justification shown when a producer hovers an edge. */
function reasonFor(basis: ParentageBasis, child: ProjectVersion, parent: ProjectVersion): string {
  switch (basis) {
    case "observed":
      return `Saved from ${parent.name} while Recall was capturing.`;
    case "filename":
      return `${child.name} follows ${parent.name} — read from the file names, not observed.`;
    case "activity":
      return `You were working in ${parent.name} when ${child.name} appeared — inferred from when each was open, not observed.`;
    case "chronological":
      return `Opened after ${parent.name}. Nothing to follow but the order they appeared, so this link is a guess.`;
  }
}

type Candidate = { version: ProjectVersion; stem: VersionStem };

/**
 * The last time work happened in this version at or before some moment.
 *
 * Not `lastUpdatedAtMs`, which is the version's whole life. The question is
 * what the producer had open *then*, so sittings after that moment are exactly
 * the ones that must not count.
 *
 * A SCANNED TAKE IS NOT A SITTING. When a folder is connected, the backend
 * writes one row per `.als` with `started_at_ms` set to the file's modified
 * time and no events (`storage.rs::add_scanned_takes`). That is a fact about
 * the filesystem, not about the producer — Recall was not running. Counting it
 * here made the `activity` rule fire on projects nobody ever captured, and the
 * graph then said "You were working in X when Y appeared" beside a node drawn
 * hollow precisely because it knows it watched nothing. §1: Recall never
 * pretends. Names still carry lineage on scanned files, so `filename` is
 * unaffected; what is withdrawn is only the claim about behaviour.
 */
function lastWorkedAtOrBefore(version: ProjectVersion, atMs: number): number | null {
  let latest: number | null = null;
  for (const session of version.sessions) {
    if (session.take_origin === "scanned") continue;
    if (session.started_at_ms > atMs) continue;
    if (latest === null || session.started_at_ms > latest) latest = session.started_at_ms;
  }
  return latest;
}

/**
 * Which version the producer was working in when this one appeared.
 *
 * THIS IS WHERE BRANCHES COME FROM. Everything else in this file produces a
 * chain, because "the newest file" is always the one just before you, so every
 * version descends from the previous one and the graph is a ladder.
 *
 * Work does not go in a line. You take `v3` somewhere, save `v4`, then go back
 * to `v3` and keep pushing it. When `v5` appears, the newest file is `v4` — but
 * you were in `v3`, and `v5` came off `v3`. That is a genuine fork, it is the
 * shape a producer would draw themselves, and it is provable from sitting
 * timestamps that are already in the database. No naming convention, no new
 * capture, and it works on every project already recorded.
 */
function recentlyWorked(child: Candidate, earlier: Candidate[]): ProjectVersion | null {
  const bornAt = child.version.startedAtMs;
  let best: { version: ProjectVersion; workedAt: number } | null = null;

  for (const other of earlier) {
    const workedAt = lastWorkedAtOrBefore(other.version, bornAt);
    if (workedAt === null) continue;
    // Cold return: what you had open a month ago says nothing about what you
    // branched from today.
    if (bornAt - workedAt > ACTIVE_WINDOW_MS) continue;
    if (!best || workedAt > best.workedAt) best = { version: other.version, workedAt };
  }

  return best?.version ?? null;
}

/** Among earlier versions on the same stem, the highest number below ours. */
function filenameParent(child: Candidate, earlier: Candidate[]): ProjectVersion | null {
  if (child.stem.ordinal === null) return null;

  // An unnumbered file is version one of its own stem. Producers do not name
  // the first save `v1` — the folder holds `nightfall.als` and then
  // `nightfall v2.als`, and those are obviously the same song. Reading the
  // bare stem as ordinal 0 keeps that first hop on the filename lineage
  // instead of demoting the most obvious link in the project to a guess.
  //
  // The first save is also the one least likely to carry the later suffixes.
  // A real folder held `Breaking Point.als` and `Breaking Point v2 mixdown.als`
  // — stems `breaking point` and `breaking point mixdown`, which do not match,
  // so the most obvious lineage in the project fell through to a guess and
  // drew backwards. An UNNUMBERED stem that is a whole-word prefix of the
  // child's therefore counts as the same line: the words a producer adds later
  // ("mixdown", "master") describe what the file became, they do not rename the
  // song. Restricted to the unnumbered case on purpose — two numbered files
  // that disagree about their suffix are two lines, not one.
  const sameLine = earlier
    .map((other) => ({ ...other, ordinal: other.stem.ordinal ?? 0 }))
    .filter((other) => {
      if (other.ordinal >= child.stem.ordinal!) return false;
      if (other.stem.stem === child.stem.stem) return true;
      return (
        other.stem.ordinal === null && child.stem.stem.startsWith(`${other.stem.stem} `)
      );
    });
  if (sameLine.length === 0) return null;

  // A tie — two files claiming the same number, which happens the moment
  // someone saves `v3` twice — breaks to the one worked on most recently
  // BEFORE this version appeared. Recency here means the last sitting, not the
  // first: a file opened in January and pushed hard all March is the one the
  // producer was living in, and `startedAtMs` would rank it behind a file
  // touched once in February. Same definition `recentlyWorked` uses above and
  // `latestWorkUnder` uses in the layout, so all three tie-breaks in this
  // feature agree on what "recent" means.
  const bornAt = child.version.startedAtMs;
  return sameLine.reduce((a, b) => {
    if (b.ordinal !== a.ordinal) return b.ordinal > a.ordinal ? b : a;
    const workedA = lastWorkedAtOrBefore(a.version, bornAt) ?? a.version.startedAtMs;
    const workedB = lastWorkedAtOrBefore(b.version, bornAt) ?? b.version.startedAtMs;
    if (workedA !== workedB) return workedB > workedA ? b : a;
    return b.version.startedAtMs > a.version.startedAtMs ? b : a;
  }).version;
}

/**
 * Pick the parent for one version out of everything that came before it.
 *
 * The names a producer chose and the file they actually had open usually agree,
 * and when they do the name is the better label to show. When they DISAGREE,
 * behaviour wins: a numbering scheme is a convention, but having `v3` open when
 * `v5` appeared is evidence. That disagreement is precisely the branch case —
 * it only happens when you went back to something older — so deferring to the
 * name there would erase the fork the graph exists to show.
 *
 * With neither, fall back to the clock. It is a weak guess and it is labelled
 * as one, but it beats a root: five disconnected roots is not a history, and
 * the producer can see the dashed line and correct it.
 */
function pickParent(
  child: Candidate,
  earlier: Candidate[],
): { parent: ProjectVersion; basis: ParentageBasis } | null {
  if (earlier.length === 0) return null;

  const worked = recentlyWorked(child, earlier);
  const named = filenameParent(child, earlier);

  if (named && worked) {
    return named.id === worked.id
      ? { parent: named, basis: "filename" }
      : { parent: worked, basis: "activity" };
  }
  if (named) return { parent: named, basis: "filename" };
  if (worked) return { parent: worked, basis: "activity" };

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
      return 3;
    case "filename":
      return 2;
    case "activity":
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
