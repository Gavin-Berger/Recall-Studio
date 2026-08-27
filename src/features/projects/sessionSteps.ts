// A session's work, broken into the steps it actually happened in.
//
// WHY THIS IS HERE AND NOT A TRIP TO ANOTHER SCREEN
//
// Opening a session used to mean leaving for the old workspace — a different
// surface with a different look, a ruler, track lanes and a playhead. That is a
// second place to learn, and it breaks the one thing this list is good at: you
// are reading a history, and the detail of any step should open where you are
// standing.
//
// So a session opens in place. The summary above says WHAT the work touched;
// this says what happened, in order.
//
// NOTHING NEW IS COMPUTED
//
// `analyzeSession` already splits a session into passages — a step, its label,
// the kind of work, the tracks, and the controls with where each one started
// and ended. It is 800 lines of tested judgement about what counts as one step
// and how to name it. This module only chooses what a producer needs to read
// back and drops the rest.

import {
  analyzeSession,
  type SessionPassage,
} from "../../components/schema/timeline/sessionAnalysis";
import { producerWorkDefinition } from "../../components/schema/timeline/producerWork";
import type { NoteEdit, ParameterChange, TimelineClipEvent } from "../../types/schema";

/** One control the producer worked, and where they left it. */
export type StepControl = {
  key: string;
  /** "Filter 1 Freq", and the device it lives on when there is one. */
  label: string;
  /** The track, because a step can span tracks while its title names one. */
  track: string | null;
  /**
   * Where it started and where it ended.
   *
   * The count alone cannot tell a nudge from searching the whole range and
   * committing, and the landing point is the decision worth reading back.
   */
  from: string | null;
  to: string | null;
  moves: number;
};

export type SessionStep = {
  id: string;
  /** Already in the producer's language, from the analysis. */
  title: string;
  /** "Writing", "Mixing", "Sound" — what kind of work this was. */
  kind: string | null;
  startMs: number;
  endMs: number;
  /** Quiet time before this step began, when there was a noticeable pause. */
  gapBeforeMs: number | null;
  /** Tracks the producer actually acted on, busiest first. */
  tracks: string[];
  controls: StepControl[];
  /** Controls beyond the few shown. */
  moreControls: number;
  moves: number;
  noteEdits: number;
  clipEvents: number;
};

/** Controls shown per step before the list stops being readable. */
export const STEP_CONTROL_LIMIT = 4;
/** Tracks named per step. */
export const STEP_TRACK_LIMIT = 3;

function controlLabel(control: SessionPassage["controls"][number]): string {
  const device = control.deviceName?.trim();
  return device ? `${device} · ${control.parameterName}` : control.parameterName;
}

/**
 * Turn one session's captured work into readable steps.
 *
 * `memoryEvents` and `moments` are deliberately left empty: they need the raw
 * event log and the pinned-moment list, two more round trips, and the steps
 * read fine without them. Passing them later only adds detail — it changes
 * nothing about how the steps are cut.
 */
export function sessionSteps(
  changes: ParameterChange[],
  noteEdits: NoteEdit[],
  clipEvents: TimelineClipEvent[],
  sessionStartedAtMs: number | null,
): SessionStep[] {
  const analysis = analyzeSession({
    changes,
    noteEdits,
    clipEvents,
    memoryEvents: [],
    sessionStartedAtMs,
  });

  return analysis.passages.map((passage) => ({
    id: passage.id,
    title: passage.label,
    kind:
      passage.kind === "mixed" ? null : producerWorkDefinition(passage.kind).label,
    startMs: passage.startMs,
    endMs: passage.endMs,
    gapBeforeMs: passage.gapBeforeMs,
    tracks: passage.primaryTrackNames.slice(0, STEP_TRACK_LIMIT),
    controls: passage.controls.slice(0, STEP_CONTROL_LIMIT).map((control, index) => ({
      key: `${passage.id}-${index}`,
      label: controlLabel(control),
      track: control.trackName,
      from: control.beforeDisplay,
      to: control.afterDisplay,
      moves: control.count,
    })),
    moreControls: Math.max(0, passage.controls.length - STEP_CONTROL_LIMIT),
    moves: passage.controlMoveCount,
    noteEdits: passage.midiEditCount,
    clipEvents: passage.clipEventCount,
  }));
}

/** A pause worth naming, in the unit a producer would say. */
export function describeGap(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}m later`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h later`;
  return `${Math.round(hours / 24)}d later`;
}
