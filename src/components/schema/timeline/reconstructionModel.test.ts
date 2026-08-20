import { describe, expect, it } from "vitest";
import type { TrackObj } from "../../../types/schema";
import type { Activity } from "./types";
import { buildBuildSteps, buildRecipe, buildReconstructionEvents, parseMusicalPosition } from "./reconstructionModel";

const track: TrackObj = {
  id: "bass", ableton_id: "1", name: "Bass", number: 1, type: "midi", color: null,
  group_id: null, chain_index: 0,
  devices: [{ id: "serum", track_id: "bass", ableton_id: "2", name: "Serum 2", role: "instrument", chain_index: 0, enabled: true, initial_enabled: true, host_parameter_count: 0, class_name: "PluginDevice", preset_name: null, parameters: [] }],
};

const move = (id: string, atMs: number): Activity => ({
  id, kind: "move", trackId: "bass", atMs, deviceName: "Serum 2", paramName: "Cutoff",
  before: 0.31, after: 0.68, beforePercent: 31, afterPercent: 68, unit: "%",
  automation: true, automationStartPosition: "Bar 49 · Beat 1", automationEndPosition: "Bar 57 · Beat 1",
});

describe("reconstruction model", () => {
  it("parses bar and beat evidence without inventing a position", () => {
    expect(parseMusicalPosition("Bar 49 · Beat 3")?.bar).toBe(49);
    expect(parseMusicalPosition("unknown")).toBeNull();
  });

  it("groups consecutive work on one track into a build step", () => {
    const events = buildReconstructionEvents([move("a", 1_000), move("b", 40_000)], [track]);
    expect(buildBuildSteps(events)).toHaveLength(1);
    expect(buildBuildSteps(events)[0].events).toHaveLength(2);
  });

  it("keeps work on different tracks in separate build steps", () => {
    const other = { ...move("b", 2_000), trackId: "lead" };
    const events = buildReconstructionEvents([move("a", 1_000), other], [track]);
    expect(buildBuildSteps(events)).toHaveLength(2);
  });

  it("builds a factual recipe with chain and musical location", () => {
    const event = buildReconstructionEvents([move("a", 1_000)], [track])[0];
    const recipe = buildRecipe(event);
    expect(recipe.where).toContain("Bar 49");
    expect(recipe.context[0]).toContain("Serum 2");
    expect(recipe.evidence).toContain("not the full envelope");
  });

  it("uses the universally observed playhead for an ordinary move", () => {
    const observedMove: Activity = {
      ...move("observed", 2_000),
      automation: false,
      automationStartPosition: undefined,
      automationEndPosition: undefined,
      observedArrangementPosition: "Bar 33 · Beat 2",
      observedArrangementBeats: 129,
    };

    const event = buildReconstructionEvents([observedMove], [track])[0];
    const recipe = buildRecipe(event);
    expect(recipe.where).toBe("Bar 33 · Beat 2 · playhead observed");
    expect(recipe.evidence).toContain("recorded this move");
  });

  it("prefers an object's exact Arrangement range over the observed playhead", () => {
    const clip: Activity = {
      id: "clip",
      kind: "clip",
      trackId: "bass",
      atMs: 3_000,
      eventType: "sample_added",
      assetName: "drums_14_kick.wav",
      observedArrangementPosition: "Bar 41 · Beat 3",
      observedArrangementBeats: 162,
      arrangementStartBeats: 128,
      arrangementEndBeats: 132,
    };

    const event = buildReconstructionEvents([clip], [track])[0];
    const recipe = buildRecipe(event);
    expect(recipe.where).toBe("Arrangement beats 128–132");
    expect(recipe.evidence).toContain("exact Arrangement beat range");
  });

  it("puts factual song changes into the story without irrelevant device-chain context", () => {
    const tempo: Activity = {
      id: "tempo",
      kind: "memory",
      trackId: "bass",
      atMs: 4_000,
      memoryCategory: "song",
      memoryTitle: "Tempo changed",
      memorySummary: "124 BPM → 128 BPM",
      observedArrangementPosition: "Bar 65 · Beat 1",
    };

    const event = buildReconstructionEvents([tempo], [track])[0];
    const recipe = buildRecipe(event);
    expect(event.category).toBe("song");
    expect(event.title).toBe("Tempo changed");
    expect(recipe.change).toBe("124 BPM → 128 BPM");
    expect(recipe.context).toEqual([]);
    expect(recipe.where).toContain("Bar 65");
  });

  it("stops claiming recreation detail is missing once exact evidence is present", () => {
    const automated: Activity = {
      ...move("curve", 5_000),
      evidence: {
        facts: [{ label: "Envelope", value: "2 captured points" }],
        automationPoints: [
          { beat: 41, value: 0.2, displayValue: null },
          { beat: 49, value: 0.8, displayValue: null },
        ],
        midiNotes: [],
        warpMarkers: [],
      },
    };

    const recipe = buildRecipe(buildReconstructionEvents([automated], [track])[0]);
    expect(recipe.missing).not.toContain("The automation envelope points were not stored");
  });
});
