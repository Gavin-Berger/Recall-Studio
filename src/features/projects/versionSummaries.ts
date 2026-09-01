// What a version row says about itself, without being opened.
//
// A row that reads `Aug 30, 2026 · 1 sitting` is a file listing. `git log` is
// useful because the subject line is IN the log — you scan the column and know
// the shape of the project without opening a single commit. Recall already
// computes both halves of that line and neither reached this surface:
//
//   `commitHeadline`  — what the work was ("Worked Bass and 3 other tracks · 12 devices")
//   `commitDiff`      — what it did to the set (+2 −1)
//
// This walks the versions once and fills both in.
//
// COST
//
// Local SQLite, so a query is cheap, but a two-year project can hold hundreds
// of versions and firing hundreds of queries to fill a list nobody scrolled to
// is still wrong. The walk stops at a budget; rows past it keep their date and
// sitting count, which is honest and costs nothing.

import {
  getNoteEdits,
  getParameterChanges,
  getProjectSchema,
  getTimelineClipEvents,
} from "../../lib/schema/api";
import type { ProjectSchema } from "../../types/schema";
import { commitHeadline, summarizeCommit } from "./commitContents";
import { commitDiff } from "./commitDiff";
import type { ProjectVersion } from "./projectVersions";

/** How many versions get a headline without being opened. */
export const SUMMARY_BUDGET = 40;

export type VersionSummary = {
  /** The subject line: what the producer did in this version. */
  headline: string;
  /** Structural change against the parent version. Null until both are known. */
  structure: { added: number; removed: number } | null;
};

/**
 * The sitting whose schema represents the version's final state.
 *
 * The LAST one: a version's structure is what it was when the producer stopped
 * working on it, which is what the next version descends from.
 */
export function finalSittingId(version: ProjectVersion): string | null {
  return version.sessions.at(-1)?.id ?? null;
}

/** The headline for one version, from everything captured across its sittings. */
export async function loadVersionHeadline(version: ProjectVersion): Promise<string> {
  const sessionIds = version.sessions.map((session) => session.id);
  if (sessionIds.length === 0) return "Never opened while Recall was listening";

  const parts = await Promise.all(
    sessionIds.map(async (id) => ({
      changes: await getParameterChanges(id),
      noteEdits: await getNoteEdits(id),
      clipEvents: await getTimelineClipEvents(id),
    })),
  );

  return commitHeadline(
    summarizeCommit(
      parts.flatMap((part) => part.changes),
      parts.flatMap((part) => part.noteEdits),
      parts.flatMap((part) => part.clipEvents),
    ),
  );
}

/** The version's final structure snapshot, for diffing against its parent. */
export async function loadVersionSchema(version: ProjectVersion): Promise<ProjectSchema | null> {
  const id = finalSittingId(version);
  if (!id) return null;
  return getProjectSchema(id);
}

/**
 * Structural change between a version and its parent, as two counts.
 *
 * Counts, not a list: the row is a subject line and the list belongs in the
 * detail. Returns null rather than zeroes when either snapshot is missing —
 * "Recall cannot say" and "nothing changed" are different facts and a row that
 * prints `+0 −0` for the first one is lying quietly.
 */
export function structureCounts(
  parentSchema: ProjectSchema | null | undefined,
  schema: ProjectSchema | null | undefined,
  hasParent: boolean,
): { added: number; removed: number } | null {
  const diff = commitDiff(parentSchema ?? null, schema ?? null, hasParent);
  if (diff.status !== "changed") return null;
  return {
    added: diff.diff.addedTracks.length + diff.diff.addedDevices.length,
    removed: diff.diff.removedTracks.length + diff.diff.removedDevices.length,
  };
}
