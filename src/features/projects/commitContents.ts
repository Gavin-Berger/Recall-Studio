// What a commit actually contains.
//
// A commit that says "481 recorded changes" and nothing else is a hollow
// commit. On GitHub the number of changed files is never the point — the point
// is which files, and a glance tells you whether that commit touched the thing
// you care about. The same question here is "what did I move", and the capture
// already knows: tracks, devices, parameters, note edits, clips.
//
// Pure on purpose. The screen fetches the rows; this decides what they mean, so
// the grouping rules can be tested without a backend.
//
// IDENTITY, NOT NAMES
//
// Grouping is keyed on Live's stable pointers (`track_id`, `device_id`) with
// the name only as a fallback. Ableton auto-names a track after its first
// device, so two separate "Serum 2" tracks are routine — keying on the name
// silently merges them into one, which is the bug that was already found and
// fixed once in the Contribution Record. It is not re-introduced here.

import type { NoteEdit, ParameterChange, TimelineClipEvent } from "../../types/schema";

/** Top N of anything. Longer lists stop being a glance and become a table. */
export const CONTENTS_LIMIT = 5;

/**
 * The mixer is not a device.
 *
 * The bridge reports fader, pan and send moves against a pseudo-device called
 * "mixer" so they have somewhere to live. Counting it as a device overstates
 * "devices touched" by one on every commit that moved a fader, which is nearly
 * all of them. Same rule the Report applies.
 */
const MIXER_PSEUDO_DEVICE = "mixer";

function isMixer(deviceName: string | null | undefined): boolean {
  return deviceName?.trim().toLocaleLowerCase() === MIXER_PSEUDO_DEVICE;
}

function identity(id: string | null | undefined, name: string | null | undefined): string | null {
  const stable = id?.trim();
  if (stable) return `id:${stable}`;
  const label = name?.trim().toLocaleLowerCase();
  return label ? `name:${label}` : null;
}

export type ContentsEntry = {
  key: string;
  label: string;
  /** Where it happened, when that is not the thing itself. */
  context: string | null;
  changes: number;
};

export type CommitContents = {
  /**
   * Groups where everything was touched exactly once, so there is nothing to
   * rank. The surface reports the size instead of naming five at random.
   */
  evenlySpread: { tracks: boolean; devices: boolean; parameters: boolean };
  tracks: ContentsEntry[];
  devices: ContentsEntry[];
  parameters: ContentsEntry[];
  /** Note edits, newest first, already summarised by the bridge. */
  notes: { key: string; label: string; context: string | null }[];
  /** Clips and samples brought into the set. */
  added: { key: string; label: string; context: string | null }[];
  totals: {
    tracks: number;
    devices: number;
    parameters: number;
    notes: number;
    added: number;
  };
  /** True when nothing at all was summarisable. */
  empty: boolean;
};

/**
 * Rank a group, and drop the long tail of things touched exactly once.
 *
 * Real data made the case: one commit moved 52 parameters, 47 of them a single
 * time, so the "top five" was five arbitrary EQ bands all showing 1. That is
 * not where the work went — it is the shape of a plugin. A row earns its place
 * by accounting for more than one change; when nothing does, the group reports
 * its size and says the touches were spread evenly rather than naming five at
 * random.
 */
function rank(map: Map<string, ContentsEntry>): ContentsEntry[] {
  const ordered = [...map.values()].sort(
    (a, b) => b.changes - a.changes || a.label.localeCompare(b.label),
  );
  const notable = ordered.filter((entry) => entry.changes > 1);
  return notable.slice(0, CONTENTS_LIMIT);
}

function bump(
  map: Map<string, ContentsEntry>,
  key: string | null,
  label: string,
  context: string | null,
) {
  if (!key) return;
  const seen = map.get(key);
  if (seen) seen.changes += 1;
  else map.set(key, { key, label, context, changes: 1 });
}

/**
 * Summarise one commit's captured work.
 *
 * Counts are of CHANGES, not of distinct things: a track that saw forty moves
 * ranks above one that saw two, because that is what "where did the work go"
 * means. The totals alongside are of distinct things, which is the other
 * question ("how much of the set did I touch") and a different number.
 */
export function summarizeCommit(
  changes: ParameterChange[],
  notes: NoteEdit[],
  clips: TimelineClipEvent[],
): CommitContents {
  const tracks = new Map<string, ContentsEntry>();
  const devices = new Map<string, ContentsEntry>();
  const parameters = new Map<string, ContentsEntry>();

  for (const change of changes) {
    const trackKey = identity(change.track_id, change.track_name);
    const trackLabel = change.track_name?.trim() || "Untitled track";
    bump(tracks, trackKey, trackLabel, null);

    if (!isMixer(change.device_name)) {
      const deviceKey = identity(change.device_id, change.device_name);
      // Scope the device to its track: the same plugin on two tracks is two
      // devices doing two jobs, and merging them hides where the work went.
      const scoped = deviceKey && trackKey ? `${trackKey}/${deviceKey}` : deviceKey;
      bump(devices, scoped, change.device_name?.trim() || "Untitled device", trackLabel);
    }

    const paramName = change.parameter_name?.trim();
    if (paramName) {
      const where = change.device_name?.trim() || trackLabel;
      bump(
        parameters,
        `${identity(change.track_id, change.track_name) ?? "?"}/${change.device_id ?? change.device_name ?? "?"}/${paramName.toLocaleLowerCase()}`,
        paramName,
        where,
      );
    }
  }

  const noteRows = [...notes]
    .sort((a, b) => b.changed_at_ms - a.changed_at_ms)
    .slice(0, CONTENTS_LIMIT)
    .map((note) => ({
      key: note.id,
      label: note.summary?.trim() || "Notes edited",
      context: note.track_name?.trim() || note.clip_name?.trim() || null,
    }));

  const addedRows = [...clips]
    .sort((a, b) => b.changed_at_ms - a.changed_at_ms)
    .slice(0, CONTENTS_LIMIT)
    .map((clip) => ({
      key: clip.id,
      label: clip.sample_name?.trim() || clip.clip_name?.trim() || "Clip added",
      context: clip.track_name?.trim() || null,
    }));

  const totals = {
    tracks: tracks.size,
    devices: devices.size,
    parameters: parameters.size,
    notes: notes.length,
    added: clips.length,
  };

  const spread = (map: Map<string, ContentsEntry>) =>
    map.size > 0 && [...map.values()].every((entry) => entry.changes === 1);

  return {
    evenlySpread: {
      tracks: spread(tracks),
      devices: spread(devices),
      parameters: spread(parameters),
    },
    tracks: rank(tracks),
    devices: rank(devices),
    parameters: rank(parameters),
    notes: noteRows,
    added: addedRows,
    totals,
    empty:
      totals.tracks === 0 &&
      totals.devices === 0 &&
      totals.parameters === 0 &&
      totals.notes === 0 &&
      totals.added === 0,
  };
}

/**
 * A one-line headline for a commit, in the producer's language.
 *
 * This is the commit "message" — the thing a git log shows before you open
 * anything. It is derived, never invented: it names what the work actually
 * concentrated on, and says plainly when there is not enough to characterise.
 */
export function commitHeadline(contents: CommitContents): string {
  if (contents.empty) return "Work with no detail kept";

  const parts: string[] = [];
  const lead = contents.tracks[0];

  if (lead) {
    parts.push(
      contents.totals.tracks === 1
        ? `Worked ${lead.label}`
        : `Worked ${lead.label} and ${contents.totals.tracks - 1} other ${
            contents.totals.tracks === 2 ? "track" : "tracks"
          }`,
    );
  } else if (contents.totals.tracks > 0) {
    // Nothing stood out — every track was touched once. Naming one would imply
    // the work concentrated there when it did not, so count them instead.
    parts.push(
      contents.totals.tracks === 1
        ? "Touched 1 track"
        : `Touched ${contents.totals.tracks} tracks`,
    );
  }

  if (contents.totals.devices > 0) {
    parts.push(
      `${contents.totals.devices} ${contents.totals.devices === 1 ? "device" : "devices"}`,
    );
  }
  if (contents.totals.notes > 0) {
    parts.push(`${contents.totals.notes} note ${contents.totals.notes === 1 ? "edit" : "edits"}`);
  }
  if (contents.totals.added > 0) {
    parts.push(`${contents.totals.added} added`);
  }

  return parts.join(" · ");
}
