// The way back to the music.
//
// A producer opening this screen after two weeks has one question the Timeline
// has never answered: *how do I get back to that?* Everything on the surface
// points further into Recall — the Report, the workspace, the breakdown — and
// nothing points back at Ableton. The set's name is shown; where it actually
// lives on disk is not, and has never been.
//
// WHAT RECALL CAN HONESTLY OFFER
//
// It knows which file the work happened in. It does NOT hold the contents of
// that file, so it cannot put the set back the way it was that night. Those are
// very different promises and the surface must not blur them.
//
// The useful, honest thing is therefore two facts:
//
//   1. the file this work happened in, so it can be opened
//   2. whether that file has been worked SINCE — because if it has, opening it
//      will not show you this. That is the part a producer cannot know on their
//      own, and getting it wrong wastes a real trip into Ableton.
//
// Both are read off captured sessions. Nothing is inferred from the filename.

import type { ProjectCommit } from "./projectCommits";
import { setKeyForCommit } from "./projectSets";

export type WayBack = {
  /** The set this work happened in. */
  setName: string | null;
  /** Full path on disk, when the session was anchored to a file. */
  path: string | null;
  /** Just the file, for reading. */
  fileName: string | null;
  /**
   * Later captured sessions in the same set.
   *
   * Above zero means the file has moved on: opening it will not show the work
   * you are looking at. Zero means the file is still where this session left
   * it, as far as Recall saw.
   */
  workedSince: number;
  /** The last time Recall saw work in this set, when it moved on. */
  lastTouchedMs: number | null;
};

/** The last path segment, for Windows or POSIX separators. */
export function fileNameOf(path: string | null): string | null {
  if (!path) return null;
  const parts = path.split(/[\\/]/);
  const last = parts[parts.length - 1];
  return last && last.length > 0 ? last : null;
}

/**
 * What Recall can say about returning to one session's set.
 *
 * `commits` is the whole project, not the focused set: "worked since" has to
 * count every later session in that file, including ones the list is currently
 * hiding.
 */
export function wayBack(commit: ProjectCommit, commits: ProjectCommit[]): WayBack {
  const key = setKeyForCommit(commit);

  const later = commits.filter(
    (other) =>
      other.id !== commit.id &&
      setKeyForCommit(other) === key &&
      // Strictly after. A session that began at the same instant carries no
      // evidence of coming later, and counting it would overstate the drift.
      other.atMs > commit.atMs,
  );

  // The RAW path off the session, never `commit.alsPath`. That one is
  // normalized — lowercased, separators flipped — because it exists to group
  // sessions by set. Showing it would print "c:/music/breaking point
  // project/..." where the producer's folder is "C:\Music\Breaking Point
  // Project", and handing it to the file opener risks it not resolving at all.
  const path = commit.session.als_path;

  return {
    setName: commit.setName,
    path,
    fileName: fileNameOf(path),
    workedSince: later.length,
    lastTouchedMs: later.reduce<number | null>(
      (latest, other) => (latest === null ? other.endedAtMs : Math.max(latest, other.endedAtMs)),
      null,
    ),
  };
}

/**
 * How to describe the trip back, in plain words.
 *
 * Never promises the set will look the way it did. Recall does not hold the
 * file's contents and cannot restore a moment — saying "go back to this" would
 * be the overclaim §1 forbids. It says where the work was and whether the file
 * has moved on, and lets the producer decide.
 */
export function describeWayBack(way: WayBack): string {
  if (!way.path) {
    return "This work was in a set that was never saved, so there is no file to go back to.";
  }
  if (way.workedSince === 0) {
    return "Nothing has been captured in this set since, so the file should still be roughly where this left it.";
  }
  const times =
    way.workedSince === 1 ? "once since" : `${way.workedSince} times since`;
  return `You have worked this set ${times}, so opening it will not show you this — the file has moved on. Recall keeps the record, not the audio.`;
}
