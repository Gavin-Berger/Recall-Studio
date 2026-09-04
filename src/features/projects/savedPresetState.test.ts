import { describe, expect, it } from "vitest";
import type { StoredTrackPreset } from "../../lib/schema/api";
import { compareSavedPresets } from "./savedPresetState";

function preset(
  track: string,
  name: string,
  hash: string | null,
  overrides: Partial<StoredTrackPreset> = {},
): StoredTrackPreset {
  return {
    track_name: track,
    plugin_name: "Serum 2",
    preset_name: name,
    preset_author: null,
    preset_bank: null,
    state_hash: hash,
    plugin_version: "2.0.24",
    ...overrides,
  };
}

describe("compareSavedPresets", () => {
  it("uses the hash to separate edits, renames, and actual patch changes", () => {
    const previous = [
      preset("Lead", "Glass", "same-1"),
      preset("Bass", "Reese", "old-2"),
      preset("Pad", "Cloud", "old-3"),
      preset("Keys", "Soft", "same-4"),
    ];
    const current = [
      preset("Lead", "Glass renamed", "same-1"),
      preset("Bass", "Reese", "new-2"),
      preset("Pad", "Brass", "new-3"),
      preset("Keys", "Soft", "same-4"),
      preset("Arp", "Pulse", "new-5"),
    ];

    expect(compareSavedPresets(current, previous).map((row) => row.relation)).toEqual([
      "renamed",
      "edited",
      "changed",
      "same",
      "added",
    ]);
  });

  it("does not claim a comparison when the parent file was unreadable", () => {
    expect(compareSavedPresets([preset("Lead", "Glass", "1")], null)[0]?.relation)
      .toBe("uncompared");
  });

  it("keeps duplicate Serum devices on one track separate by occurrence", () => {
    const previous = [preset("Layer", "Low", "1"), preset("Layer", "High", "2")];
    const current = [preset("Layer", "Low", "1"), preset("Layer", "Air", "3")];

    const rows = compareSavedPresets(current, previous);
    expect(rows.map((row) => row.relation)).toEqual(["same", "changed"]);
    expect(rows[1]?.previous?.preset_name).toBe("High");
    expect(new Set(rows.map((row) => row.key)).size).toBe(2);
  });
});
