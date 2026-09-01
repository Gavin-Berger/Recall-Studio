// Does the read model see through Recall's own bookkeeping?
//
// The fixture below is NOT invented. It is the nine captures a real library
// holds for `Breaking Point v2 mixdown`, timestamps and counts transcribed from
// the database, including the two that recorded nothing and the two whose
// `ended_at_ms` is over an hour past the last thing they saw. Fabricating a
// tidy fixture here would have proved only that the code agrees with itself —
// every one of these defects was invisible until real rows were looked at.

import { describe, expect, it } from "vitest";
import type { SavedSessionMetadata } from "../../types/recall";
import { sittings, sittingCaptureIds, projectCaptureIds } from "./sittings";
import { SESSION_SITTING_GAP_MS } from "../../components/schema/timeline/sessionAnalysis";

const SET = "M:\\Ableton Projects\\Breaking Point v2 mixdown Project\\Breaking Point v2 mixdown.als";

function capture(
  id: string,
  startedAtMs: number,
  endedAtMs: number | null,
  lastUpdatedAtMs: number,
  events: number,
  work: number,
  over: Partial<SavedSessionMetadata> = {},
): SavedSessionMetadata {
  return {
    id,
    name: "capture",
    project_id: "breaking-point",
    capture_name: null,
    capture_status: endedAtMs === null ? "active" : "complete",
    project_name: "Breaking Point v2 mixdown",
    project_path: "M:\\Ableton Projects\\Breaking Point v2 mixdown Project",
    als_path: SET,
    take_origin: "recorded",
    display_name: null,
    started_at_ms: startedAtMs,
    ended_at_ms: endedAtMs,
    last_updated_at_ms: lastUpdatedAtMs,
    event_count: events,
    creative_event_count: work,
    heartbeat_count: 0,
    ...over,
  };
}

/**
 * The real nine, oldest last — the order `list_saved_sessions` returns.
 *
 * Note the two shapes that matter:
 *   `midday-open` ends 1h45m after its last event, because a rotation fired
 *   while Live sat open. `aug15-open` does the same at 1h16m. Those two rows
 *   are what printed "1h 45m" and "1h 20m" in the capture list.
 */
const realLibrary: SavedSessionMetadata[] = [
  capture("evening", 1787191062446, 1787195025000, 1787195016000, 1014, 703),
  capture("nothing-aug19", 1787176661049, 1787176661049, 1787176661049, 0, 0),
  capture("midday-second", 1787162060332, 1787162259057, 1787162263000, 41, 20),
  capture("midday-open", 1787155746654, 1787162060320, 1787155749000, 62, 37),
  capture("aug18", 1787094975783, 1787100868000, 1787100868000, 1255, 1051),
  capture("nothing-aug15", 1786837208130, 1786837208130, 1786837208130, 0, 0),
  capture("aug15-second", 1786822519607, 1786822807070, 1786822807070, 38, 20),
  capture("aug15-open", 1786817670475, 1786822519593, 1786817954000, 84, 44),
  capture("aug11", 1786493659261, 1786493717000, 1786493701000, 12, 1),
];

describe("sittings, against the real record", () => {
  it("gives no row to a capture that watched an empty room", () => {
    // Events, but no work: the set was open and nothing the producer did was
    // recorded. Five of these in a real library each had a row that read like
    // an evening that went nowhere.
    const watching = capture("watched-only", 1786000000000, 1786000060000, 1786000060000, 62, 0);
    const result = sittings([...realLibrary, watching]);

    expect(result.sittings.map((sitting) => sitting.id)).not.toContain("watched-only");
    expect(result.recordedNothing).toBe(3);
  });

  it("keeps a sitting that holds a single moment", () => {
    // Small is not the same as nothing. `aug11` is one moment and stays.
    const result = sittings(realLibrary);
    const aug11 = result.sittings.find((sitting) => sitting.id === "aug11");
    expect(aug11?.work).toBe(1);
  });

  it("does not give a producer a row for a capture that recorded nothing", () => {
    // Two of the nine. They exist because Live was opened, and they printed in
    // the capture list as "< 1m · 0 moments" — a session where nothing was
    // achieved, which is not what happened. Nothing happened AT ALL.
    const result = sittings(realLibrary);

    expect(result.recordedNothing).toBe(2);
    expect(result.sittings.map((sitting) => sitting.id)).not.toContain("nothing-aug19");
    expect(result.sittings.map((sitting) => sitting.id)).not.toContain("nothing-aug15");
  });

  it("turns nine captures into the five sittings the producer actually had", () => {
    const result = sittings(realLibrary);
    expect(result.sittings).toHaveLength(5);
  });

  it("never says a producer worked for an hour that Live merely sat open", () => {
    // The row that read "1h 45m · 62 moments". Every one of those 62 events
    // landed within three seconds of the capture opening — a set-load burst —
    // and then nothing for an hour and three quarters until a rotation wrote
    // `ended_at_ms`. The sitting has to end where the work ended.
    const result = sittings(realLibrary);
    const midday = result.sittings.find((sitting) => sitting.id === "midday-open")!;

    // From 12:09:06 to its last event at 12:09:09, then resumed at 13:54.
    // The sitting spans the resumption; what it must NOT do is take its end
    // from a capture's `ended_at_ms`.
    expect(midday.endMs).toBe(1787162263000);
    expect(midday.endMs).not.toBe(1787162060320);
  });

  it("folds a capture Recall split from the one before it", () => {
    // 12ms apart, on the same set: machinery, not a producer.
    const result = sittings(realLibrary);
    const midday = result.sittings.find((sitting) => sitting.id === "midday-open")!;

    expect(midday.captureIds).toEqual(["midday-open", "midday-second"]);
    expect(midday.merged).toBe(true);
    expect(midday.events).toBe(103);
    expect(midday.work).toBe(57);
  });

  it("keeps the evening apart from the afternoon it followed", () => {
    // 13:57 to 21:57 is eight hours. Merging those would have claimed one
    // sitting ran from midday to midnight.
    const result = sittings(realLibrary);
    expect(result.sittings.map((sitting) => sitting.id)).toContain("evening");
    const evening = result.sittings.find((sitting) => sitting.id === "evening")!;
    expect(evening.captureIds).toEqual(["evening"]);
    expect(evening.merged).toBe(false);
  });

  it("reports every sitting's span from its own first event to its own last", () => {
    const result = sittings(realLibrary);
    for (const sitting of result.sittings) {
      expect(sitting.endMs).toBeGreaterThanOrEqual(sitting.startMs);
      // No sitting may claim more elapsed time than the captures it came from.
      const sources = realLibrary.filter((entry) => sitting.captureIds.includes(entry.id));
      const latestSeen = Math.max(...sources.map((entry) => entry.last_updated_at_ms));
      expect(sitting.endMs).toBe(latestSeen);
    }
  });
});

describe("sittings, the rules themselves", () => {
  const base = 1_700_000_000_000;

  it("uses the definition of a sitting the app already had", () => {
    // Not a new threshold. A third answer to "same sitting?" is the disease.
    expect(SESSION_SITTING_GAP_MS).toBe(4 * 60 * 60 * 1000);
  });

  it("does not join two sets worked seconds apart", () => {
    // Speed of hand is not evidence of one piece of work.
    const result = sittings([
      capture("a", base, base + 60_000, base + 60_000, 10, 10),
      capture("b", base + 60_100, base + 120_000, base + 120_000, 10, 10, {
        als_path: "M:\\Ableton Projects\\Other Project\\other.als",
      }),
    ]);
    expect(result.sittings).toHaveLength(2);
  });

  it("does not treat a file found on disk as a sitting somebody sat through", () => {
    const result = sittings([
      capture("scanned", base, null, base, 0, 0, { take_origin: "scanned" }),
      capture("real", base + 1000, base + 60_000, base + 60_000, 5, 5),
    ]);
    expect(result.sittings).toHaveLength(1);
    // And it is not counted among the captures that recorded nothing either —
    // it was never a capture.
    expect(result.recordedNothing).toBe(0);
  });

  it("never joins two captures that do not know which set they were in", () => {
    // The loose-takes list is full of captures with no set. Two nulls are not a
    // match — they are two absences of evidence.
    const result = sittings([
      capture("a", base, base + 1000, base + 1000, 5, 5, { als_path: null }),
      capture("b", base + 2000, base + 3000, base + 3000, 5, 5, { als_path: null }),
    ]);
    expect(result.sittings).toHaveLength(2);
  });

  it("puts captures in time order however they arrive", () => {
    const result = sittings([
      capture("late", base + 5 * SESSION_SITTING_GAP_MS, null, base + 5 * SESSION_SITTING_GAP_MS + 1000, 5, 5),
      capture("early", base, base + 1000, base + 1000, 5, 5),
    ]);
    expect(result.sittings.map((sitting) => sitting.id)).toEqual(["early", "late"]);
  });

  it("keeps a capture that is still running", () => {
    // An active capture has no `ended_at_ms` at all. Reading the end from that
    // field would have dropped the sitting the producer is sitting in.
    const result = sittings([capture("live", base, null, base + 30_000, 7, 7)]);
    expect(result.sittings).toHaveLength(1);
    expect(result.sittings[0]!.endMs).toBe(base + 30_000);
  });
});

describe("what one report has to cover", () => {
  it("reads every capture the sitting was split across, from either half", () => {
    // Opening the report from the SECOND capture of a folded sitting must give
    // the same report as opening it from the first. Otherwise which half of an
    // accident the producer happened to click changes what they are told.
    expect(sittingCaptureIds(realLibrary, "midday-open")).toEqual([
      "midday-open",
      "midday-second",
    ]);
    expect(sittingCaptureIds(realLibrary, "midday-second")).toEqual([
      "midday-open",
      "midday-second",
    ]);
  });

  it("stops at the edge of the sitting", () => {
    // The guard the old capture-scoped test was really protecting: a report
    // must never quietly widen past what was asked for.
    expect(sittingCaptureIds(realLibrary, "evening")).toEqual(["evening"]);
    expect(sittingCaptureIds(realLibrary, "aug18")).toEqual(["aug18"]);
  });

  it("still reports a capture that recorded nothing, on its own", () => {
    // It is not part of any sitting. Reporting nothing is honest; silently
    // showing a neighbouring evening instead would not be.
    expect(sittingCaptureIds(realLibrary, "nothing-aug19")).toEqual(["nothing-aug19"]);
  });

  it("has nothing to read when nothing is open", () => {
    expect(sittingCaptureIds(realLibrary, null)).toEqual([]);
  });
});

describe("a report on the whole project", () => {
  // A song that moved files: the same work, in two sets.
  const twoSets: SavedSessionMetadata[] = [
    ...realLibrary,
    capture("older-set", 1786490000000, 1786495000000, 1786495000000, 233, 200, {
      als_path: "M:\Ableton Projects\Breaking Point Project\Breaking Point.als",
      project_name: "Breaking Point",
    }),
  ];

  it("reaches every set, which no other scope does", () => {
    const ids = projectCaptureIds(twoSets);
    expect(ids).toContain("older-set");
    expect(ids).toContain("evening");
    // And the set scope does not: that is the whole point of the third scope.
    expect(sittingCaptureIds(twoSets, "evening")).not.toContain("older-set");
  });

  it("still leaves out what nobody sat through", () => {
    const ids = projectCaptureIds(twoSets);
    expect(ids).not.toContain("nothing-aug19");
    expect(ids).not.toContain("nothing-aug15");
  });

  it("folds the split captures rather than double counting them", () => {
    // Every capture appears once, and the ones Recall split are both present.
    const ids = projectCaptureIds(twoSets);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("midday-open");
    expect(ids).toContain("midday-second");
  });
});

describe("a scope has to earn its place in the list", () => {
  it("offers nothing wider when the project is one set", () => {
    // The failure mode worth naming: a third option that covers exactly what
    // the second one already covered, asking the producer to choose between
    // two identical reports.
    const oneSet = projectCaptureIds(realLibrary);
    const wholeSet = sittings(realLibrary).sittings.flatMap((sitting) => sitting.captureIds);
    expect(oneSet).toEqual(wholeSet);
  });

  it("covers strictly more once a project holds a second set", () => {
    const twoSets = [
      ...realLibrary,
      capture("older-set", 1786490000000, 1786495000000, 1786495000000, 233, 200, {
        als_path: "M:\Ableton Projects\Breaking Point Project\Breaking Point.als",
      }),
    ];
    expect(projectCaptureIds(twoSets).length).toBeGreaterThan(
      sittingCaptureIds(twoSets, "evening").length,
    );
  });
});
