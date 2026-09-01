// The order a sitting is read in.
//
// A flat list of movement cards answers "what did I do" and loses two things a
// producer needs to retrace their steps:
//
//   WHEN. Cards carry a clock stamp but sit at even spacing, so twenty minutes
//   of silence in the middle of an evening looks exactly like twenty seconds.
//   The same dishonesty the version axis has: a gap that is not drawn is a gap
//   the reader cannot know about. Drawn gaps NAME what they removed.
//
//   WHERE THE SAVES WERE. A save is the punctuation of a sitting — everything
//   above one is in that saved state, and "what did I do since I last saved" is
//   the question asked after a crash. Recall watches saves already (the control
//   surface polls the open .als's modification stamp), so this is a fact, not a
//   guess.
//
// There is also a second reading order. Chronological answers "what happened at
// 10:34"; grouped by track answers "what did I do to the bass". Both are real
// questions and the producer should not have to pick one forever, so both are
// built here from the same decisions.
//
// Pure: takes decisions and saves, returns what to draw.

import type { ReportDecision } from "./sessionReport";

/**
 * Silence longer than this is drawn as a break rather than as even spacing.
 *
 * Two minutes: long enough that stepping away and coming back reads as a real
 * pause, short enough not to swallow the rhythm of ordinary work. The same
 * number `BLOCK_GAP_MS` already uses to end an activity block, so the app has
 * one answer to "was that a pause".
 */
export const TRAIL_GAP_MS = 120_000;

export type TrailEntry =
  | { kind: "movement"; key: string; decision: ReportDecision }
  /** A save the control surface watched. Everything before it is in that state. */
  | { kind: "save"; key: string; atMs: number }
  /** Drawn silence. Named, never implied. */
  | { kind: "gap"; key: string; fromMs: number; toMs: number; durationMs: number };

export type TrackGroup = {
  /** The track's name, or null for work that belongs to no single track. */
  track: string | null;
  decisions: ReportDecision[];
};

export type SittingSave = { savedAtMs: number };

/**
 * The chronological reading: movements in order, with saves and silences in
 * their real places.
 */
export function sittingTrail(
  decisions: ReportDecision[],
  saves: SittingSave[] = [],
): TrailEntry[] {
  const ordered = [...decisions].sort((a, b) => a.atMs - b.atMs);
  const savePoints = [...saves]
    .map((save) => save.savedAtMs)
    .sort((a, b) => a - b);

  const entries: TrailEntry[] = [];
  let previousEndMs: number | null = null;
  let nextSave = 0;

  for (const decision of ordered) {
    // Saves that happened before this movement land above it, in order.
    while (nextSave < savePoints.length && savePoints[nextSave]! <= decision.atMs) {
      const atMs = savePoints[nextSave]!;
      // A save inside a silence is the reason the silence ended, so it goes
      // after the gap that precedes it — hence the gap check runs first below
      // only for movements, and a save simply takes its own place here.
      entries.push({ kind: "save", key: `save:${atMs}:${nextSave}`, atMs });
      previousEndMs = Math.max(previousEndMs ?? atMs, atMs);
      nextSave += 1;
    }

    if (previousEndMs !== null && decision.atMs - previousEndMs >= TRAIL_GAP_MS) {
      entries.push({
        kind: "gap",
        key: `gap:${previousEndMs}:${decision.atMs}`,
        fromMs: previousEndMs,
        toMs: decision.atMs,
        durationMs: decision.atMs - previousEndMs,
      });
    }

    entries.push({ kind: "movement", key: decision.id, decision });
    // A gesture occupies a range; the next gap is measured from where it ended.
    previousEndMs = Math.max(previousEndMs ?? decision.endMs, decision.endMs);
  }

  // A save after the last movement still matters: it is what the work was
  // written into, and its absence is exactly what the save reminder is about.
  while (nextSave < savePoints.length) {
    const atMs = savePoints[nextSave]!;
    entries.push({ kind: "save", key: `save:${atMs}:${nextSave}`, atMs });
    nextSave += 1;
  }

  return entries;
}

/**
 * The by-track reading: every movement gathered under the track it happened on.
 *
 * Tracks are ordered by when they were LAST touched, newest first, because a
 * producer retracing their steps is usually looking for what they were on when
 * they stopped. Work with no track (tempo, the set's own structure) collects
 * under a null track and always sorts last — it is context, not a lane.
 */
export function sittingByTrack(decisions: ReportDecision[]): TrackGroup[] {
  const groups = new Map<string, TrackGroup & { lastMs: number }>();

  for (const decision of decisions) {
    const track = decision.track?.trim() || null;
    const key = track ?? "\u0000no-track";
    const found = groups.get(key);
    if (found) {
      found.decisions.push(decision);
      found.lastMs = Math.max(found.lastMs, decision.endMs);
      continue;
    }
    groups.set(key, { track, decisions: [decision], lastMs: decision.endMs });
  }

  return [...groups.values()]
    .sort((a, b) => {
      if ((a.track === null) !== (b.track === null)) return a.track === null ? 1 : -1;
      return b.lastMs - a.lastMs;
    })
    .map(({ track, decisions: rows }) => ({
      track,
      decisions: [...rows].sort((a, b) => a.atMs - b.atMs),
    }));
}

/** "18 minutes", "2 hours" — a break has to say what it removed. */
export function gapLabel(durationMs: number): string {
  const minutes = Math.round(durationMs / 60_000);
  if (minutes < 60) return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  const hours = Math.round(minutes / 60);
  return `${hours} ${hours === 1 ? "hour" : "hours"}`;
}
