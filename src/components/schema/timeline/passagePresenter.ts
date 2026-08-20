// The one place a session-path step turns into words.
//
// The screen and the exported record were each phrasing passages themselves, and
// they drifted: the export carried the arrangement position, the first and last
// action, and the structural evidence count, while the screen showed a bare
// action tally and dropped the device name off every control it listed. A
// producer reading the app saw strictly less than a producer reading the file
// the app wrote. Both surfaces now render from here, so a fact added for one
// arrives in the other.
//
// Pure and presentation-only: no counting, no clustering, no judgement about
// what happened. Everything here comes straight from a SessionPassage.

import type { PassageControl, SessionPassage } from "./sessionAnalysis";
import { producerWorkDefinition, type ProducerWorkKind } from "./producerWork";

export type PresentedControl = {
  // "EQ Eight · Filter 1 Freq" — the device is half the fact. "Filter 1 Freq"
  // alone does not say which of the four EQs on the track moved.
  name: string;
  // The track the control sits on, or null when it matches the step's headline
  // track and repeating it would only add noise. Never null merely because the
  // capture was thin — see `presentPassage`.
  trackName: string | null;
  // "400 Hz → 2.1 kHz" when the capture carried readable values, else null.
  outcome: string | null;
  count: number;
};

export type PresentedPassage = {
  /** Headline: what the producer did, and to what. */
  title: string;
  /** "26 control changes · 7 MIDI edits" — volume of work. */
  breakdown: string | null;
  /** Leading controls with their net before → after. */
  controls: PresentedControl[];
  /** "Bar 33 · Beat 2 → Bar 41 · Beat 1", or a single position, or null. */
  where: string | null;
  /** Saved-note titles attached to this step. */
  markerTitles: string[];
  /** Structural reports (routing, tempo, track adds) supporting this step. */
  structureEventCount: number;
};

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

export function presentedControl(control: PassageControl, headlineTrack: string | null = null): PresentedControl {
  const name = [control.deviceName, control.parameterName].filter(Boolean).join(" · ");
  // Only claim a move when both ends are known AND they differ. A control whose
  // display value reads the same at both ends settled back where it started as
  // far as the producer could see, and printing "0.0 dB → 0.0 dB" invents a
  // decision out of rounding.
  const outcome =
    control.beforeDisplay && control.afterDisplay && control.beforeDisplay !== control.afterDisplay
      ? `${control.beforeDisplay} → ${control.afterDisplay}`
      : null;
  return {
    name,
    // Say the track whenever it is not the one already in the headline.
    trackName: control.trackName && control.trackName !== headlineTrack ? control.trackName : null,
    outcome,
    count: control.count,
  };
}

/**
 * The track a step is about — but only when one track really carries it.
 *
 * A step that spent half its moves on Drum Group and half on Bass Main is not
 * "on Bass Main"; naming the busiest track by a single move told the producer
 * something untrue about their own session. When no track holds a majority the
 * step names the tracks it spans, or says nothing.
 */
export function passageFocus(passage: SessionPassage): string | null {
  const tracks = passage.primaryTrackNames;
  if (tracks.length === 0) return null;
  if (tracks.length === 1) return tracks[0] ?? null;
  const total = passage.primaryTrackCounts.reduce((sum, entry) => sum + entry.count, 0);
  const leader = passage.primaryTrackCounts[0];
  // Two thirds: enough that a reader who sees only this track's name is not
  // being misled about where the step's work actually went.
  if (leader && total > 0 && leader.count / total >= 2 / 3) return leader.name;
  return tracks.length === 2 ? tracks.join(" and ") : `${tracks.length} tracks`;
}

function passageTitle(passage: SessionPassage): string {
  const focus = passageFocus(passage);
  const on = focus ? ` on ${focus}` : "";
  switch (passage.kind) {
    case "writing":
      return `Worked on MIDI${on}`;
    case "recording":
      return `Recorded or performed${on}`;
    case "sound":
      return `Shaped sound and samples${on}`;
    case "arrangement":
      return `Changed the arrangement${on}`;
    case "mixing":
      // Counted from tracks with a real move on them, never from every track
      // some piece of evidence happened to name.
      return passage.primaryTrackNames.length > 1
        ? `Mixed ${plural(passage.primaryTrackNames.length, "track")}`
        : `Mixed${on}`;
    case "project":
      return "Changed project setup";
    case "moment":
      return passage.markers[0]?.title ?? "Marked a moment";
    default: {
      const labels = passage.workKinds.slice(0, 3).map((kind) => producerWorkDefinition(kind).phrase);
      const work = labels.length > 1
        ? `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}`
        : labels[0] ?? "multiple work areas";
      return `Worked across ${work}${on}`;
    }
  }
}

function workCountLabel(kind: ProducerWorkKind, count: number): string {
  switch (kind) {
    case "writing": return plural(count, "MIDI edit");
    case "recording": return plural(count, "recording / performance event");
    case "sound": return plural(count, "sound change");
    case "arrangement": return plural(count, "arrangement change");
    case "mixing": return plural(count, "mix change");
    case "project": return plural(count, "project change");
    case "moment": return plural(count, "marked moment");
  }
}

function passageBreakdown(passage: SessionPassage): string | null {
  const parts = passage.workKinds
    .filter((kind) => passage.workCounts[kind] > 0)
    .map((kind) => workCountLabel(kind, passage.workCounts[kind]));
  return parts.length > 0 ? parts.join(" · ") : null;
}

// Where in the song the work landed. One observed position reads as a point;
// several read as the span the producer moved through. These are transport
// observations taken while the action happened — not envelope breakpoints — so
// the wording stays "observed" wherever it is introduced.
function passageWhere(passage: SessionPassage): string | null {
  const positions = passage.observedArrangementPositions;
  if (positions.length === 0) return null;
  if (positions.length === 1) return positions[0] ?? null;
  return `${positions[0]} → ${positions[positions.length - 1]}`;
}

export function presentPassage(passage: SessionPassage, controlLimit = 3): PresentedPassage {
  // A control only drops its track name when the headline already said it.
  // When the headline is a spread ("3 tracks", or nothing at all), every
  // control has to carry its own address.
  const headlineTrack = passage.primaryTrackNames.length === 1 ? passage.primaryTrackNames[0] ?? null : null;
  return {
    title: passageTitle(passage),
    breakdown: passageBreakdown(passage),
    controls: passage.controls.slice(0, controlLimit).map((control) => presentedControl(control, headlineTrack)),
    where: passageWhere(passage),
    markerTitles: passage.markers.map((marker) => marker.title),
    structureEventCount: passage.structureEventCount,
  };
}

/**
 * The evidence-handling footnote: what the analysis collapsed or set aside on
 * the producer's behalf. Stating it is what makes the rest of the path
 * trustworthy — silence here reads as "nothing was filtered", which is false.
 */
export function describePathCleanup(input: {
  duplicateReportCount: number;
  openingStateEventCount: number;
}): string[] {
  return [
    input.duplicateReportCount > 0
      ? `${plural(input.duplicateReportCount, "repeated report")} collapsed`
      : null,
    input.openingStateEventCount > 0
      ? `${plural(input.openingStateEventCount, "opening-state observation")} excluded`
      : null,
  ].filter((item): item is string => item !== null);
}
