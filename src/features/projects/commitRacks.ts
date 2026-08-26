// Racks a commit touched, and what is inside them.
//
// WHY THIS EXISTS
//
// A producer whose drums live in a Drum Rack saw "Drum Rack" in a commit and
// nothing under it — no kick, no snare, no Simpler. The contents were never
// missing from the capture: `_serialize_device` in the control surface walks
// `chains` and `visible_drum_pads` on every snapshot and has done all along.
// Nothing downstream read them, so they were parsed, transmitted, and dropped.
//
// WHAT THIS CAN AND CANNOT SAY
//
// Structure, and only structure. The listener path
// (`_attach_to_focused_device`) iterates `track.devices` and never descends
// into a rack's chains, so a knob turned on a Simpler inside a drum pad is not
// observed. This module therefore reports what a rack CONTAINS and says
// plainly that the insides were not watched. Listing the contents while
// implying their moves were captured is the overclaim DESIGN.md §1 forbids —
// and it is the same mistake the Report's trust banner already made once.

import type { ProjectSchema, RackObj } from "../../types/schema";

/** A rack a commit touched, flattened for display. */
export type CommitRack = {
  key: string;
  /** The rack device's own name, e.g. "Drum Rack". */
  name: string;
  /** The track it sits on. */
  track: string | null;
  /** Named chains or pads inside it, in Live's order. */
  contents: { key: string; label: string; detail: string | null }[];
  /** How many entries exist in total, before the display cap. */
  total: number;
};

/** Top N, so a 128-pad Drum Rack stays a glance rather than a wall. */
export const RACK_CONTENTS_LIMIT = 6;

/** Live's note numbering, so a pad reads the way it does in Ableton. */
const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

export function noteName(note: number | null): string | null {
  if (note === null || !Number.isFinite(note)) return null;
  // Live shows C3 for MIDI 60, so the octave is floor(n/12) - 2.
  const name = NOTE_NAMES[((note % 12) + 12) % 12];
  return name ? `${name}${Math.floor(note / 12) - 2}` : null;
}

/**
 * Flatten one rack into rows worth showing.
 *
 * Drum pads win over chains when both are present: a Drum Rack's pads ARE its
 * chains, and showing both lists the same thing twice under two names. Pads
 * also carry the note, which is how a producer finds the one they mean.
 */
function flatten(rack: RackObj): { rows: CommitRack["contents"]; total: number } {
  if (rack.drum_pads.length > 0) {
    const named = rack.drum_pads.filter((pad) => (pad.name ?? "").trim().length > 0);
    return {
      total: named.length,
      rows: named.slice(0, RACK_CONTENTS_LIMIT).map((pad, index) => ({
        key: pad.ableton_id ?? `pad-${index}`,
        label: pad.name!.trim(),
        detail: noteName(pad.note),
      })),
    };
  }

  return {
    total: rack.chains.length,
    rows: rack.chains.slice(0, RACK_CONTENTS_LIMIT).map((chain, index) => ({
      key: chain.ableton_id ?? `chain-${index}`,
      label: chain.name?.trim() || `Chain ${chain.index + 1}`,
      // What is actually in the chain is the useful part — a chain called
      // "Kick" containing a Simpler and a Saturator says more than its name.
      detail:
        chain.devices.length > 0
          ? chain.devices
              .map((device) => device.name?.trim())
              .filter(Boolean)
              .join(" › ")
          : null,
    })),
  };
}

/**
 * The racks on tracks this commit actually touched.
 *
 * Scoped to touched tracks on purpose: a set can hold dozens of racks, and a
 * commit that never went near them should not list them. `touchedTracks` is
 * the track names the commit's own changes name.
 */
export function commitRacks(
  schema: ProjectSchema | null,
  touchedTracks: Set<string>,
): CommitRack[] {
  if (!schema) return [];

  const racks: CommitRack[] = [];
  for (const track of schema.tracks) {
    const trackName = track.name?.trim() ?? null;
    if (trackName === null || !touchedTracks.has(trackName)) continue;

    for (const device of track.devices) {
      if (!device.rack) continue;
      const { rows, total } = flatten(device.rack);
      if (total === 0) continue;
      racks.push({
        key: device.id,
        name: device.name?.trim() || "Rack",
        track: trackName,
        contents: rows,
        total,
      });
    }
  }
  return racks;
}
