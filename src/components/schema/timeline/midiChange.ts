// Turning a note-edit record into something a producer recognises.
//
// WHY THIS EXISTS: the timeline used to print the raw fields — "1 → 1 notes ·
// 1 pitches · F#4 · vel 100 · 20 beats". Every number is true and none of it
// says what happened. A producer does not think "distinct_pitches went from 1 to
// 4", they think "I turned that into a chord". Counting notes is the note-edit
// equivalent of measuring a mix in samples.
//
// So: one plain-language headline that names the MUSICAL act, and a short detail
// line carrying the numbers for anyone who wants them. The headline is what the
// eye lands on; the detail is evidence, not the story.
//
// WHAT IT REFUSES TO DO: guess. Every statement below is derivable from the
// before/after fields the bridge captures. Exact note snapshots are rendered by
// VersionTimelineScreen; this summary stays conservative instead of inventing a
// musical intention from a visual difference in the piano roll.

import type { NoteEdit } from "../../../types/schema";

export type MidiChangeSummary = {
  /** The musical act, in plain language. Always present. */
  headline: string;
  /** Supporting numbers, or null when they'd only repeat the headline. */
  detail: string | null;
};

const SEMITONES_PER_OCTAVE = 12;

function noteCount(count: number): string {
  return count === 1 ? "1 note" : `${count} notes`;
}

function plural(value: number, word: string): string {
  return value === 1 ? `1 ${word}` : `${value} ${word}s`;
}

/**
 * How far the whole part moved in pitch, or null if it didn't move as a block.
 *
 * Both ends must shift by the SAME amount. If the bottom moved and the top
 * didn't, the producer re-voiced the part rather than transposing it, and
 * calling that "moved up an octave" would be wrong in the way that matters —
 * it describes an act they didn't perform.
 */
function blockShift(edit: NoteEdit): number | null {
  const { pitch_min, pitch_max, previous_pitch_min, previous_pitch_max } = edit;
  if (
    pitch_min === null ||
    pitch_max === null ||
    previous_pitch_min === null ||
    previous_pitch_max === null
  ) {
    return null;
  }

  const lowShift = pitch_min - previous_pitch_min;
  const highShift = pitch_max - previous_pitch_max;
  if (lowShift !== highShift || lowShift === 0) return null;
  return lowShift;
}

function describeShift(shift: number): string {
  const direction = shift > 0 ? "up" : "down";
  const distance = Math.abs(shift);

  if (distance % SEMITONES_PER_OCTAVE === 0) {
    const octaves = distance / SEMITONES_PER_OCTAVE;
    return `Moved ${direction} ${plural(octaves, "octave")}`;
  }
  if (distance > SEMITONES_PER_OCTAVE) {
    const octaves = Math.floor(distance / SEMITONES_PER_OCTAVE);
    const semitones = distance % SEMITONES_PER_OCTAVE;
    return `Transposed ${direction} ${plural(octaves, "octave")} and ${plural(semitones, "semitone")}`;
  }
  return `Transposed ${direction} ${plural(distance, "semitone")}`;
}

/** A bridge summary without Live's placeholder clip name or log punctuation. */
function readableBridgeSummary(edit: NoteEdit): string | null {
  let summary = edit.summary?.trim();
  if (!summary) return null;

  const clip = namedMidiClip(edit);
  if (clip && summary.toLocaleLowerCase().startsWith(`${clip.toLocaleLowerCase()} `)) {
    summary = summary.slice(clip.length).trim();
  }
  summary = summary
    .replace(/^untitled clip(?:\s*[:—-]\s*|\s+)/i, "")
    .replace(/\s*(?:->|→)\s*/g, " → ")
    .replace(/\b([A-G](?:#|b)?-?\d+)\s+to\s+([A-G](?:#|b)?-?\d+)\b/gi, "$1 → $2")
    .trim();
  if (!summary) return null;
  return summary.charAt(0).toLocaleUpperCase() + summary.slice(1);
}

function isFingerprintSummary(summary: string): boolean {
  // The bridge's compact "3 notes (+3), E3-A3" line is evidence, not a
  // producer-facing description. The structured card shows every one of these
  // fields more clearly, so let the derived musical headline lead instead.
  return /^\d+\s+notes?(?:\s+\([+-]\d+\))?\s*(?:,|·|$)/i.test(summary);
}

/** The pitch range, shown as a move only when it actually moved. */
function rangeDetail(edit: NoteEdit): string | null {
  const { pitch_range, previous_pitch_range } = edit;
  if (!pitch_range) return null;
  if (previous_pitch_range && previous_pitch_range !== pitch_range) {
    return `${previous_pitch_range} → ${pitch_range}`;
  }
  return pitch_range;
}

function countDetail(before: number | null, after: number): string | null {
  if (before === null || before === after) return noteCount(after);
  return `${before} → ${noteCount(after)}`;
}

/**
 * What the producer did to a clip's notes.
 *
 * Ordered by musical significance, first match wins: clearing and writing a part
 * outrank everything, a block transposition outranks the note count changing
 * (moving a part up an octave IS the change, even if a note came along with it),
 * and "rewritten" is the honest fallback when the count held steady but the
 * content did not.
 */
export function describeMidiChange(edit: NoteEdit): MidiChangeSummary {
  const after = edit.note_count ?? 0;
  const before = edit.previous_note_count;

  // The bridge sometimes sends its own summary. It knows things this doesn't,
  // but it also used to prefix nearly every row with the nonexistent proper
  // noun "Untitled clip". Keep the musical fact and remove the placeholder.
  const bridgeSummary = readableBridgeSummary(edit);
  if (bridgeSummary && !isFingerprintSummary(bridgeSummary)) {
    const range = rangeDetail(edit);
    const repeatsRange = Boolean(
      range && bridgeSummary.toLocaleLowerCase().includes(range.toLocaleLowerCase()),
    );
    return { headline: bridgeSummary, detail: repeatsRange ? null : range };
  }

  if (edit.change_kind === "cleared" || (after === 0 && (before ?? 0) > 0)) {
    return {
      headline: "Cleared the part",
      detail: before ? `${noteCount(before)} removed` : null,
    };
  }

  if ((before === null || before === 0) && after > 0) {
    return {
      headline: "Wrote a new part",
      detail: [noteCount(after), rangeDetail(edit)].filter(Boolean).join(" · "),
    };
  }

  const shift = blockShift(edit);
  if (shift !== null) {
    return { headline: describeShift(shift), detail: rangeDetail(edit) };
  }

  if (before !== null && after > before) {
    const added = after - before;
    return {
      headline: `Added ${noteCount(added)}`,
      detail: [countDetail(before, after), rangeDetail(edit)].filter(Boolean).join(" · "),
    };
  }

  if (before !== null && after < before) {
    const removed = before - after;
    return {
      headline: `Removed ${noteCount(removed)}`,
      detail: [countDetail(before, after), rangeDetail(edit)].filter(Boolean).join(" · "),
    };
  }

  // Same number of notes, but an edit fired — the content changed underneath.
  // The one case where the count genuinely says nothing.
  return {
    headline: "Rewrote the part",
    detail: [noteCount(after), rangeDetail(edit)].filter(Boolean).join(" · "),
  };
}

/**
 * What to call the thing that changed.
 *
 * Never "Untitled clip". Most MIDI clips in Live are never named, so that label
 * was on nearly every row, and it reads as a specific object the producer should
 * be able to find — they go looking for a clip called "Untitled" and there isn't
 * one. The track is the thing they actually recognise, so when there is no real
 * clip name, name the track and say plainly that these were MIDI changes.
 */
export function namedMidiClip(edit: NoteEdit): string | null {
  const clip = edit.clip_name?.trim();
  // "0" and "Untitled clip" are Live/bridge absence sentinels, not names the
  // producer can find in the set.
  if (!clip || clip === "0" || /^untitled clip$/i.test(clip)) return null;
  return clip;
}

export function midiChangeSubject(edit: NoteEdit, fallbackTrack?: string | null): string {
  const track = edit.track_name?.trim();
  return namedMidiClip(edit) ?? (track || fallbackTrack?.trim() || "MIDI changes");
}
