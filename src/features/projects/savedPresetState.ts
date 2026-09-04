// Compare the Serum state stored in two saved `.als` files.
//
// This is version evidence, not a live-event model. Serum gives Recall a name
// and a state hash only when Live serializes the plug-in into the set. The hash
// is the sound identity: it separates an edited patch from a renamed one.

import type { StoredTrackPreset } from "../../lib/schema/api";

export type SavedPresetRelation =
  | "uncompared"
  | "same"
  | "edited"
  | "renamed"
  | "changed"
  | "added";

export type ComparedSavedPreset = {
  /** Stable within one snapshot, including duplicate Serum devices on a track. */
  key: string;
  preset: StoredTrackPreset;
  previous: StoredTrackPreset | null;
  relation: SavedPresetRelation;
};

function normalized(value: string | null): string {
  return value?.trim().toLocaleLowerCase() ?? "";
}

/**
 * Match devices conservatively by track, plug-in, and occurrence on that track.
 *
 * The saved header has no Live device id. Matching by hash would be tempting,
 * but two tracks can deliberately use the same patch; that would merge distinct
 * devices. A track rename therefore reads as a new placement rather than a
 * fabricated cross-track identity.
 */
function indexed(presets: StoredTrackPreset[]): Array<{ key: string; preset: StoredTrackPreset }> {
  const occurrences = new Map<string, number>();
  return presets.map((preset) => {
    const base = `${normalized(preset.track_name)}\u0000${normalized(preset.plugin_name)}`;
    const occurrence = (occurrences.get(base) ?? 0) + 1;
    occurrences.set(base, occurrence);
    return { key: `${base}\u0000${occurrence}`, preset };
  });
}

function relation(
  current: StoredTrackPreset,
  previous: StoredTrackPreset,
): SavedPresetRelation {
  const sameName = current.preset_name === previous.preset_name;
  const comparableHash = Boolean(current.state_hash && previous.state_hash);
  const sameHash = comparableHash && current.state_hash === previous.state_hash;

  if (sameName) {
    return comparableHash && !sameHash ? "edited" : "same";
  }
  return sameHash ? "renamed" : "changed";
}

/** Current saved Serum state, annotated against the parent version when known. */
export function compareSavedPresets(
  current: StoredTrackPreset[],
  previous: StoredTrackPreset[] | null,
): ComparedSavedPreset[] {
  const previousByKey = previous === null
    ? null
    : new Map(indexed(previous).map((entry) => [entry.key, entry.preset]));

  return indexed(current).map(({ key, preset }) => {
    if (previousByKey === null) {
      return { key, preset, previous: null, relation: "uncompared" };
    }
    const before = previousByKey.get(key) ?? null;
    return {
      key,
      preset,
      previous: before,
      relation: before ? relation(preset, before) : "added",
    };
  });
}
