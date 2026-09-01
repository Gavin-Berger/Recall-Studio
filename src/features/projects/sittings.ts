// A sitting: the unit a producer actually worked in.
//
// A CAPTURE is a Recall bookkeeping object. It starts and stops for reasons
// that have nothing to do with the producer — the bridge reconnecting, the app
// restarting, `maybe_rotate_take` firing on a file path it thought had changed.
// Measured on a real library, 13 of 31 capture boundaries inside a single set
// were 10 to 28 MILLISECONDS apart. Nobody closes a set and reopens it in 26ms.
//
// Showing captures to a producer therefore shows them the shape of Recall's
// plumbing and calls it their evening. One set produced nine capture rows for
// about five sittings, two of which recorded nothing at all, and two of which
// claimed 1h45m and 1h20m of work that were really 3 seconds and 4 minutes.
//
// This module is the one place that turns captures into sittings, so no surface
// has to decide for itself and no two surfaces can decide differently.
//
// It does NOT stop the splits happening — that belongs in `maybe_rotate_take`
// on the capture side. Splits already in the record cannot be un-recorded, so
// the read model has to be able to see through them.

import type { SavedSessionMetadata } from "../../types/recall";
import { SESSION_SITTING_GAP_MS } from "../../components/schema/timeline/sessionAnalysis";

// The gap that separates one sitting from the next is NOT invented here.
// `SESSION_SITTING_GAP_MS` (4 hours) already splits a session's passages into
// sittings, and `STALE_SESSION_IDLE_MS` in the Rust capture side is the same
// four hours. Adding a third number would have given the app three answers to
// "is this the same sitting" — which is the disease, not the cure.

export type Sitting = {
  /** The first capture's id. Stable, and already unique. */
  id: string;
  /** Every capture folded into this sitting, oldest first. */
  captureIds: string[];
  /** The capture the sitting starts in — the one that owns its identity. */
  first: SavedSessionMetadata;
  alsPath: string | null;
  setName: string | null;
  startMs: number;
  /**
   * When the work stopped, which is the last thing Recall SAW — never the
   * moment a rotation happened to fire.
   *
   * `ended_at_ms` is written when the capture is stopped, and a rotation stops
   * a capture the producer was not in. One real row read "1h 45m" for a capture
   * holding 62 events that all landed within three seconds of its start: Live
   * was open, and nothing happened for the remaining hour and three quarters.
   * Printing that as work is exactly what DESIGN.md §1 forbids.
   */
  endMs: number;
  /** Everything Recall recorded, across the merged captures. */
  events: number;
  /** The subset that counts as producer work. */
  work: number;
  /** True when Recall split this sitting across more than one capture. */
  merged: boolean;
};

export type SittingsResult = {
  sittings: Sitting[];
  /**
   * Captures that recorded nothing at all.
   *
   * Kept as a count rather than as rows: they are a fact about Recall watching,
   * not about the producer working, and a list of them reads as sessions where
   * nothing was achieved. The Timeline already reports these this way; this is
   * the same rule, in one place, for every surface.
   */
  recordedNothing: number;
};

/**
 * Did this capture record anything the PRODUCER did?
 *
 * Not "anything at all". Recall records plenty while a set merely sits open —
 * the routing enumeration at load, a snapshot, where the producer looked. Five
 * captures in a real library held events and zero work, and each got a row that
 * read like an evening that went nowhere. A sitting with no work in it is not a
 * short sitting; it is Recall watching an empty room.
 *
 * One moment still counts. Hiding a small thing because it is small is Recall
 * deciding the work was not important enough to remember, and duration is no
 * test either — one real sitting ran under a minute and held 54 moments.
 */
function recordedSomething(capture: SavedSessionMetadata): boolean {
  return capture.creative_event_count > 0;
}

/**
 * The last moment Recall saw something in this capture.
 *
 * `last_updated_at_ms` is the newest event's time, falling back to the capture's
 * own timestamps when it holds no events — which is why it is only trusted here
 * for captures that recorded something.
 */
function lastSeenMs(capture: SavedSessionMetadata): number {
  return Math.max(capture.started_at_ms, capture.last_updated_at_ms);
}

/**
 * Two captures belong to the same sitting when the WORK did not stop between
 * them.
 *
 * Measured from the last thing seen in the previous capture, never from its
 * `ended_at_ms`. A rotation writes `ended_at_ms` at the moment it fires, which
 * on a capture left open all afternoon is hours after the producer stopped —
 * so measuring from it reports a gap of nearly zero and welds two unrelated
 * afternoons together.
 *
 * The set has to match too: two files worked seconds apart are two pieces of
 * work, however quickly the producer moved between them.
 */
function sameSitting(previousEndMs: number, previousAls: string | null, next: SavedSessionMetadata): boolean {
  // An unfiled capture has no set to match on. Treating two nulls as "the same
  // set" would weld together captures Recall has no evidence are related — the
  // loose-takes list is full of them, and a merge there invents a sitting.
  if (previousAls === null || next.als_path === null) return false;
  if (previousAls !== next.als_path) return false;
  return next.started_at_ms - previousEndMs < SESSION_SITTING_GAP_MS;
}

/**
 * Group a project's captures into the sittings they really were.
 *
 * Captures arrive in any order and are sorted by start. Scanned takes are not
 * sittings — nobody sat down for them; they are files found on disk — so they
 * are left out entirely rather than counted as work or as nothing.
 */
export function sittings(captures: SavedSessionMetadata[]): SittingsResult {
  const recorded = captures.filter((capture) => capture.take_origin !== "scanned");
  const worked = recorded.filter(recordedSomething);
  const ordered = [...worked].sort((a, b) => a.started_at_ms - b.started_at_ms);

  const built: Sitting[] = [];
  for (const capture of ordered) {
    const open = built[built.length - 1];

    if (open && sameSitting(open.endMs, open.alsPath, capture)) {
      open.captureIds.push(capture.id);
      open.endMs = Math.max(open.endMs, lastSeenMs(capture));
      open.events += capture.event_count;
      open.work += capture.creative_event_count;
      open.merged = true;
      continue;
    }

    built.push({
      id: capture.id,
      captureIds: [capture.id],
      first: capture,
      alsPath: capture.als_path,
      setName: capture.project_name ?? capture.display_name,
      startMs: capture.started_at_ms,
      endMs: lastSeenMs(capture),
      events: capture.event_count,
      work: capture.creative_event_count,
      merged: false,
    });
  }

  return {
    sittings: built,
    recordedNothing: recorded.length - worked.length,
  };
}

/**
 * Every capture the given capture's sitting was split across.
 *
 * The Report opens from a row that stands for a sitting, so it has to read the
 * whole sitting or it prints a different number than the row that opened it.
 * Falls back to the capture itself when it belongs to no sitting — an empty
 * capture has none, and a report of nothing is still a report of that nothing.
 */
export function sittingCaptureIds(
  captures: SavedSessionMetadata[],
  sessionId: string | null,
): string[] {
  if (!sessionId) return [];
  const found = sittings(captures).sittings.find((sitting) =>
    sitting.captureIds.includes(sessionId),
  );
  return found ? [...found.captureIds] : [sessionId];
}

/**
 * Every capture in a project that a producer actually sat through.
 *
 * The widest a report goes: every sitting, in every set. A song that moved
 * from `breaking point.als` to `breaking point v2 mixdown.als` is ONE piece of
 * work in two files, and until now nothing could report on it as one — the
 * folder's Report button opened the single most active capture underneath it,
 * which looked like a project report and was one evening of one set.
 *
 * Captures that recorded no work are left out, for the same reason they get no
 * row: they are Recall watching, not the producer working.
 */
export function projectCaptureIds(captures: SavedSessionMetadata[]): string[] {
  return sittings(captures).sittings.flatMap((sitting) => sitting.captureIds);
}
