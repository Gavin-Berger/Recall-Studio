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

/**
 * How many movements a track has to hold before leaving it counts as a section.
 *
 * Without this, one move on another track and back puts a divider between every
 * other card. Three is the smallest run that reads as "I was working here"
 * rather than "I looked at this".
 */
export const MIN_FOCUS_RUN = 3;

export type TrailEntry =
  | { kind: "movement"; key: string; decision: ReportDecision }
  /** A save the control surface watched. Everything before it is in that state. */
  | { kind: "save"; key: string; atMs: number }
  /** Drawn silence. Named, never implied. */
  | { kind: "gap"; key: string; fromMs: number; toMs: number; durationMs: number }
  /**
   * The producer moved to a different track.
   *
   * Miller: a busy hour with no pauses in it is one undifferentiated run of two
   * hundred cards, and the reader has nowhere to hold their place. Gaps and
   * saves already chunk the trail, but a continuous stretch has neither.
   *
   * Track is the chunk that already exists in the work — `SessionBlock` calls it
   * "a contiguous stretch of work on one track" and says why: producers work in
   * sections ("I was on the lead for a while"), not in isolated tweaks. So the
   * boundary is not invented for the layout; it is where the producer actually
   * turned their attention, which makes it information rather than decoration.
   */
  | { kind: "focus"; key: string; track: string; atMs: number };

export type TrackGroup = {
  /** The track's name, or null for work that belongs to no single track. */
  track: string | null;
  decisions: ReportDecision[];
};

export type SittingSave = { savedAtMs: number };

/**
 * Which movements begin a real stretch of work on a track.
 *
 * The verdict cannot be made at the moment the track changes, because whether a
 * change is a section or a glance depends on what comes AFTER it: one move on
 * another track and straight back is not somewhere the producer went. Deciding
 * on the way past marked the glance and missed the return, which put a divider
 * between every other card — the opposite of chunking.
 *
 * So the runs are measured first, and only a run long enough to have been worked
 * in earns a divider. The first run is never marked: there was nothing to move
 * away from.
 *
 * Movements with no track (tempo, the set's own structure) belong to no lane and
 * neither break a run nor start one — a divider there would be a boundary the
 * producer never crossed.
 */
function focusRunStarts(ordered: ReportDecision[]): Set<string> {
  const starts = new Set<string>();
  let run: { track: string; first: ReportDecision; length: number } | null = null;
  // The last track the producer actually settled on. Compared against, rather
  // than "the previous run", so coming back from a glance is not announced as
  // arriving somewhere new — you never left.
  let settledTrack: string | null = null;

  const close = () => {
    if (run && run.length >= MIN_FOCUS_RUN) {
      // The first settled track establishes where the sitting started; every one
      // after it is somewhere the producer moved TO.
      if (settledTrack !== null && run.track !== settledTrack) starts.add(run.first.id);
      settledTrack = run.track;
    }
    run = null;
  };

  for (const decision of ordered) {
    const track = decision.track?.trim() || null;
    if (track === null) continue;

    if (run && run.track === track) {
      run.length += 1;
      continue;
    }
    close();
    run = { track, first: decision, length: 1 };
  }
  close();

  return starts;
}

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
  const focusStarts = focusRunStarts(ordered);

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

    if (focusStarts.has(decision.id)) {
      const track = decision.track!.trim();
      entries.push({
        kind: "focus",
        key: `focus:${track}:${decision.atMs}`,
        track,
        atMs: decision.atMs,
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

/**
 * Which movements a producer spent themselves on.
 *
 * FOR THE REPORT, NOT THE TIMELINE. Ranking is a verdict about what mattered,
 * and verdicts are the Report's job — it exists to break the comparisons down.
 * The Timeline states what happened and lets the producer read it, so nothing
 * there is emphasised over anything else.
 *
 * Kept here because it is the same sitting model the trail is built from, it is
 * tested, and the Report will want it: a control ridden forty times and one
 * nudged once are not the same fact.
 *
 * Weight is RELATIVE TO THE SITTING, deliberately. A quiet evening's busiest
 * control is still that evening's story, and judging it against a marathon
 * session would flatten the quiet one into nothing. The question is "where did
 * this evening go", not "how does it compare to my best".
 */
export type MovementWeight = "heavy" | "medium" | "light";

/**
 * A movement has to account for at least this share of the busiest one to read
 * as heavy. Not a fixed count: forty passes is a lot in an evening of fifties
 * and unremarkable in an evening of four hundreds.
 */
const HEAVY_SHARE = 0.5;
const MEDIUM_SHARE = 0.15;

export function movementWeights(decisions: ReportDecision[]): Map<string, MovementWeight> {
  const weights = new Map<string, MovementWeight>();
  const busiest = decisions.reduce((most, decision) => Math.max(most, decision.count), 0);

  // Everything moved once: there is no ranking to report, and picking a winner
  // would invent one. Same rule the ranked content groups already follow.
  if (busiest <= 1) {
    for (const decision of decisions) weights.set(decision.id, "medium");
    return weights;
  }

  for (const decision of decisions) {
    const share = decision.count / busiest;
    weights.set(
      decision.id,
      share >= HEAVY_SHARE ? "heavy" : share >= MEDIUM_SHARE ? "medium" : "light",
    );
  }
  return weights;
}
