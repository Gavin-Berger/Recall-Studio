// Everything there is to know about one version, assembled in one place.
//
// The Timeline is version control, and the graph is the navigator — you pick a
// point in the lineage and the surface tells you what that point IS. Until now
// it answered with four counts, which is the one thing a producer can already
// feel without being told. A version's real content is three questions, and the
// pieces to answer all three already existed and were simply not wired up:
//
//   1. What changed in the SET versus the version this one came from
//      (`commitDiff` over two schema snapshots — this is `git show`).
//   2. What the work TOUCHED — which tracks, devices, controls, what arrived
//      (`summarizeCommit`, the same model the history rows use).
//   3. How the version UNFOLDED, sitting by sitting, not as one flat list —
//      because a version spanning three evenings is three separate returns to
//      the desk, and merging them hides that.
//
// Pure on purpose: the loader does the IO, this decides what it means, so the
// assembly can be tested without a backend.

import type { CommitDiff } from "./commitDiff";
import { commitDiff } from "./commitDiff";
import { summarizeCommit, type CommitContents } from "./commitContents";
import type { SessionReport, SessionReportInput } from "./sessionReport";
import { buildVersionReport } from "./sessionReport";
import { sittings as groupSittings } from "./sittings";

/**
 * One return to the desk inside this version.
 *
 * A sitting is NOT a capture. Recall splits captures for its own reasons — a
 * bridge reconnect, a rotation firing on a path it thought had changed — and
 * measured on a real library, thirteen of thirty-one within-set boundaries were
 * 10 to 28 milliseconds apart. Nine capture rows on one version were about four
 * evenings. `sittings.ts` is the one place that turns captures back into the
 * thing the producer did, and this uses it rather than deciding again.
 */
export type SittingDepth = {
  /** The sitting's identity: its first capture. */
  sessionId: string;
  /** Every capture folded into this sitting. */
  captureIds: string[];
  startedAtMs: number;
  /** The last thing Recall SAW, never the moment a rotation happened to fire. */
  endedAtMs: number;
  /** True when Recall had split this sitting across more than one capture. */
  merged: boolean;
  /** What this sitting alone touched. */
  contents: CommitContents;
  /** This sitting's own report, so its trail is its own and not the version's. */
  report: SessionReport;
  /**
   * Saves the control surface watched inside this sitting.
   *
   * The punctuation of the trail: everything before one is in that saved state,
   * and "what did I do since I last saved" is the question asked after a crash.
   */
  saves: { savedAtMs: number }[];
};

export type VersionDepth = {
  /** The version read as one unit of work — the headline numbers. */
  report: SessionReport;
  /** What the whole version touched, across every sitting in it. */
  contents: CommitContents;
  /** What changed in the set since the parent version. */
  diff: CommitDiff;
  /** The parent's display name, for the diff heading. Null at the root. */
  parentName: string | null;
  /**
   * The set's time signature, from the version's final snapshot.
   *
   * Live gives every position in quarter-notes; a producer reads bars. This is
   * what lets the surface say "Bar 33" and "1.3" instead of "beat 128" and
   * "beat 3". Null when the snapshot never reported one, or the set changed
   * meter — in which case the surface shows no bars at all rather than wrong
   * ones. See songPosition.ts.
   */
  meter: {
    signatureNumerator: number | null;
    signatureDenominator: number | null;
    meterChanged: boolean;
  } | null;
  /** Newest sitting first: the last thing you did is the thing you are resuming. */
  sittings: SittingDepth[];
  /**
   * Captures that recorded nothing at all, as a count.
   *
   * Never as rows. A capture with no work in it is Recall watching an empty
   * room, not an evening that went nowhere, and four rows reading
   * "0 changes · 0 sec hands-on" told the producer the second thing.
   */
  recordedNothing: number;
};

export type VersionDepthInput = {
  /** Every capture anchored to this version, in any order. */
  captures: SessionReportInput[];
  /** Every save watched across this version's captures, in any order. */
  saves?: { sessionId: string; savedAtMs: number }[];
  /** The newest capture of the parent version, if this version has a parent. */
  parent: { name: string; capture: SessionReportInput | null } | null;
};

/**
 * The schema that represents a version's final state.
 *
 * The LAST capture, not the first: a version's structure is what it was when
 * the producer stopped working on it, which is what the next version descends
 * from. Taking the first capture would diff against a state that was already
 * superseded inside the same file.
 */
function finalSchema(captures: SessionReportInput[]): SessionReportInput | null {
  const ordered = [...captures].sort(
    (left, right) => left.session.started_at_ms - right.session.started_at_ms,
  );
  return ordered.at(-1) ?? null;
}

export function buildVersionDepth({
  captures,
  parent,
  saves = [],
}: VersionDepthInput): VersionDepth {
  if (captures.length === 0) {
    throw new Error("A version's depth needs at least one capture");
  }

  const report = buildVersionReport(captures);

  const contents = summarizeCommit(
    captures.flatMap((capture) => capture.changes),
    captures.flatMap((capture) => capture.noteEdits),
    captures.flatMap((capture) => capture.clipEvents),
  );

  const diff = commitDiff(
    parent?.capture ? finalSchema([parent.capture])?.schema ?? null : null,
    finalSchema(captures)?.schema ?? null,
    parent !== null,
  );

  const byId = new Map(captures.map((capture) => [capture.session.id, capture]));
  const grouped = groupSittings(captures.map((capture) => capture.session));

  const sittings = grouped.sittings
    .map((sitting) => {
      // A merged sitting is read as ONE unit of work, because that is what it
      // was — building its report from a single capture would report a third
      // of the evening and call it the evening.
      const parts = sitting.captureIds
        .map((id) => byId.get(id))
        .filter((capture): capture is SessionReportInput => capture !== undefined);

      // A sitting can span several captures, so its saves are every save that
      // landed in any of them.
      const captureIds = new Set(sitting.captureIds);
      const sittingSaves = saves
        .filter((save) => captureIds.has(save.sessionId))
        .map((save) => ({ savedAtMs: save.savedAtMs }))
        .sort((left, right) => left.savedAtMs - right.savedAtMs);

      return {
        sessionId: sitting.id,
        captureIds: sitting.captureIds,
        saves: sittingSaves,
        startedAtMs: sitting.startMs,
        endedAtMs: sitting.endMs,
        merged: sitting.merged,
        contents: summarizeCommit(
          parts.flatMap((part) => part.changes),
          parts.flatMap((part) => part.noteEdits),
          parts.flatMap((part) => part.clipEvents),
        ),
        report: buildVersionReport(parts),
      };
    })
    .sort((left, right) => right.startedAtMs - left.startedAtMs);

  const finalCapture = finalSchema(captures);
  const schema = finalCapture?.schema ?? null;

  return {
    report,
    contents,
    diff,
    meter: schema
      ? {
          signatureNumerator: schema.signature_numerator,
          signatureDenominator: schema.signature_denominator,
          meterChanged: schema.meter_changed,
        }
      : null,
    parentName: parent?.name ?? null,
    sittings,
    recordedNothing: grouped.recordedNothing,
  };
}
