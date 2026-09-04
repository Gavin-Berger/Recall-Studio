import { describe, expect, it } from "vitest";
import type { ReportDecision } from "./sessionReport";
import {
  gapLabel,
  movementWeights,
  sittingByTrack,
  sittingTrail,
  TRAIL_GAP_MS,
} from "./sittingTrail";

const start = 1_720_000_000_000;
const minute = 60_000;

function decision(over: Partial<ReportDecision> = {}): ReportDecision {
  const atMs = over.atMs ?? start;
  return {
    id: `d${atMs}`,
    key: "k",
    kind: "structure",
    workKind: "sound",
    atMs,
    endMs: atMs,
    track: "Bass",
    subject: "Something",
    outcome: "Did a thing",
    count: 1,
    evidenceIds: [],
    facts: { of: "moment" },
    ...over,
  };
}

describe("sittingTrail", () => {
  it("puts the movements in time order", () => {
    // Inside the gap threshold, so ordering is the only thing under test here.
    const trail = sittingTrail([
      decision({ id: "late", atMs: start + minute }),
      decision({ id: "early", atMs: start }),
    ]);

    expect(trail.map((entry) => (entry.kind === "movement" ? entry.decision.id : entry.kind))).toEqual([
      "early",
      "late",
    ]);
  });

  it("draws a real silence rather than spacing it evenly", () => {
    // Twenty minutes of nothing in the middle of an evening looks exactly like
    // twenty seconds when every card is the same height.
    const trail = sittingTrail([
      decision({ id: "before", atMs: start }),
      decision({ id: "after", atMs: start + 20 * minute }),
    ]);

    const gap = trail.find((entry) => entry.kind === "gap");
    expect(gap).toBeDefined();
    if (gap?.kind !== "gap") throw new Error("expected a gap");
    expect(gap.durationMs).toBe(20 * minute);
  });

  it("does not interrupt ordinary working rhythm with breaks", () => {
    const trail = sittingTrail([
      decision({ id: "a", atMs: start }),
      decision({ id: "b", atMs: start + TRAIL_GAP_MS - 1 }),
    ]);

    expect(trail.some((entry) => entry.kind === "gap")).toBe(false);
  });

  it("measures the silence from where a gesture ENDED, not where it began", () => {
    // A four-minute filter ride followed a minute later is not a five-minute
    // pause. Measuring from atMs would invent one.
    const trail = sittingTrail([
      decision({ id: "ride", atMs: start, endMs: start + 4 * minute }),
      decision({ id: "next", atMs: start + 5 * minute }),
    ]);

    expect(trail.some((entry) => entry.kind === "gap")).toBe(false);
  });

  it("places saves where they actually happened", () => {
    // Everything above a save is in that saved state. This is the answer to
    // "what did I do since I last saved", which is the question after a crash.
    const trail = sittingTrail(
      [
        decision({ id: "before", atMs: start }),
        decision({ id: "after", atMs: start + 2 * minute }),
      ],
      [{ savedAtMs: start + minute }],
    );

    expect(trail.map((entry) => (entry.kind === "movement" ? entry.decision.id : entry.kind))).toEqual([
      "before",
      "save",
      "after",
    ]);
  });

  it("keeps a save that came after the last movement", () => {
    // Its absence is exactly what the save reminder exists to catch, so its
    // presence must be visible too.
    const trail = sittingTrail([decision({ id: "only", atMs: start })], [
      { savedAtMs: start + minute },
    ]);

    expect(trail.at(-1)?.kind).toBe("save");
  });

  it("handles a sitting with saves and no movements at all", () => {
    const trail = sittingTrail([], [{ savedAtMs: start }]);
    expect(trail).toHaveLength(1);
    expect(trail[0]!.kind).toBe("save");
  });
});

describe("sittingByTrack", () => {
  it("gathers movements under the track they happened on", () => {
    const groups = sittingByTrack([
      decision({ id: "a", track: "Bass", atMs: start }),
      decision({ id: "b", track: "Lead", atMs: start + minute }),
      decision({ id: "c", track: "Bass", atMs: start + 2 * minute }),
    ]);

    expect(groups).toHaveLength(2);
    expect(groups.find((group) => group.track === "Bass")!.decisions).toHaveLength(2);
  });

  it("puts the most recently touched track first", () => {
    // Retracing usually starts from what you were on when you stopped.
    const groups = sittingByTrack([
      decision({ id: "a", track: "Bass", atMs: start, endMs: start }),
      decision({ id: "b", track: "Lead", atMs: start + minute, endMs: start + minute }),
    ]);

    expect(groups.map((group) => group.track)).toEqual(["Lead", "Bass"]);
  });

  it("sorts set-wide work last, because it is context and not a lane", () => {
    const groups = sittingByTrack([
      decision({ id: "tempo", track: null, atMs: start + 10 * minute, endMs: start + 10 * minute }),
      decision({ id: "bass", track: "Bass", atMs: start, endMs: start }),
    ]);

    expect(groups.map((group) => group.track)).toEqual(["Bass", null]);
  });

  it("keeps each track's own movements in time order", () => {
    const groups = sittingByTrack([
      decision({ id: "late", track: "Bass", atMs: start + 5 * minute }),
      decision({ id: "early", track: "Bass", atMs: start }),
    ]);

    expect(groups[0]!.decisions.map((row) => row.id)).toEqual(["early", "late"]);
  });
});

describe("gapLabel", () => {
  it("names what the break removed", () => {
    expect(gapLabel(minute)).toBe("1 minute");
    expect(gapLabel(18 * minute)).toBe("18 minutes");
    expect(gapLabel(120 * minute)).toBe("2 hours");
  });
});

describe("movementWeights · a retrospective needs to show where the work went", () => {
  // The complaint this answers: a long trail is hard to read because every card
  // asserts the same importance, so none of them assert any. A control ridden
  // forty times and one nudged once are not the same fact.
  it("marks the movements a producer actually spent themselves on", () => {
    const weights = movementWeights([
      decision({ id: "ridden", count: 40 }),
      decision({ id: "nudged", count: 1 }),
    ]);

    expect(weights.get("ridden")).toBe("heavy");
    expect(weights.get("nudged")).toBe("light");
  });

  it("judges a sitting against itself, not against your best session", () => {
    // A quiet evening's busiest control is still that evening's story. Scoring
    // it against a marathon session would flatten the quiet one into nothing.
    const quiet = movementWeights([
      decision({ id: "top", count: 6 }),
      decision({ id: "rest", count: 1 }),
    ]);
    const busy = movementWeights([
      decision({ id: "top", count: 400 }),
      decision({ id: "rest", count: 60 }),
    ]);

    expect(quiet.get("top")).toBe("heavy");
    expect(busy.get("top")).toBe("heavy");
  });

  it("reports no ranking when everything moved once", () => {
    // Nothing stood out. Picking a winner would invent one — the same rule the
    // ranked content groups already follow.
    const weights = movementWeights([
      decision({ id: "a", count: 1 }),
      decision({ id: "b", count: 1 }),
    ]);

    expect([...weights.values()]).toEqual(["medium", "medium"]);
  });

  it("leaves the middle of a session legible rather than all-or-nothing", () => {
    const weights = movementWeights([
      decision({ id: "heavy", count: 100 }),
      decision({ id: "middle", count: 30 }),
      decision({ id: "tail", count: 2 }),
    ]);

    expect(weights.get("heavy")).toBe("heavy");
    expect(weights.get("middle")).toBe("medium");
    expect(weights.get("tail")).toBe("light");
  });

  it("handles a sitting with no movements at all", () => {
    expect(movementWeights([]).size).toBe(0);
  });
});

describe("sittingTrail · chunking a long run (Miller)", () => {
  function onTrack(id: string, track: string, atMs: number): ReportDecision {
    return decision({ id, track, atMs, endMs: atMs });
  }

  it("marks where the producer moved to another track", () => {
    // A busy hour with no pauses is one undifferentiated run of cards. Track is
    // the chunk already present in the work, not one invented for the layout.
    const trail = sittingTrail([
      onTrack("b1", "Bass", start),
      onTrack("b2", "Bass", start + 1_000),
      onTrack("b3", "Bass", start + 2_000),
      onTrack("l1", "Lead", start + 3_000),
      onTrack("l2", "Lead", start + 4_000),
      onTrack("l3", "Lead", start + 5_000),
    ]);

    const focus = trail.filter((entry) => entry.kind === "focus");
    expect(focus).toHaveLength(1);
    if (focus[0]?.kind !== "focus") throw new Error("expected a focus entry");
    expect(focus[0].track).toBe("Lead");
  });

  it("does not mark the first track — there was nothing to move away from", () => {
    const trail = sittingTrail([
      onTrack("b1", "Bass", start),
      onTrack("b2", "Bass", start + 1_000),
      onTrack("b3", "Bass", start + 2_000),
    ]);

    expect(trail.some((entry) => entry.kind === "focus")).toBe(false);
  });

  it("ignores a glance at another track between two runs on this one", () => {
    // One move elsewhere and back is not a section. Marking it would put a
    // divider between every other card, which is the opposite of chunking.
    const trail = sittingTrail([
      onTrack("b1", "Bass", start),
      onTrack("b2", "Bass", start + 1_000),
      onTrack("b3", "Bass", start + 2_000),
      onTrack("glance", "Lead", start + 3_000),
      onTrack("b4", "Bass", start + 4_000),
      onTrack("b5", "Bass", start + 5_000),
      onTrack("b6", "Bass", start + 6_000),
    ]);

    expect(trail.some((entry) => entry.kind === "focus")).toBe(false);
  });

  it("leaves work with no track alone rather than inventing a section for it", () => {
    // Tempo and set structure belong to no lane. A "null" divider would be a
    // boundary the producer never crossed.
    const trail = sittingTrail([
      onTrack("b1", "Bass", start),
      onTrack("b2", "Bass", start + 1_000),
      onTrack("b3", "Bass", start + 2_000),
      decision({ id: "tempo", track: null, atMs: start + 3_000, endMs: start + 3_000 }),
      onTrack("b4", "Bass", start + 4_000),
    ]);

    expect(trail.some((entry) => entry.kind === "focus")).toBe(false);
  });
});
