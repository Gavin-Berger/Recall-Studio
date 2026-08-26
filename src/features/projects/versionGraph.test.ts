import { describe, expect, it } from "vitest";
import type { SavedSessionMetadata } from "../../types/recall";
import { projectVersions, type ProjectVersion } from "./projectVersions";
import { childrenByParent, parseVersionName, versionGraph } from "./versionGraph";

const day = 24 * 60 * 60 * 1000;
const start = 1_720_000_000_000;

function capture(over: Partial<SavedSessionMetadata> = {}): SavedSessionMetadata {
  return {
    id: "session-1",
    name: "capture",
    project_id: "project-1",
    capture_name: null,
    capture_status: "ended",
    project_name: "pers ep nightfall",
    project_path: "C:\\Music\\nightfall",
    als_path: "C:\\Music\\nightfall\\pers ep nightfall.als",
    take_origin: "recorded",
    display_name: null,
    started_at_ms: start,
    ended_at_ms: start + 60_000,
    last_updated_at_ms: start + 60_000,
    event_count: 10,
    creative_event_count: 8,
    heartbeat_count: 0,
    ...over,
  };
}

/** One capture per named `.als`, each a day after the last, in the order given. */
function versionsFromNames(names: string[], gapMs = day): ProjectVersion[] {
  return projectVersions(
    names.map((name, index) =>
      capture({
        id: `s${index}`,
        als_path: `C:\\Music\\nightfall\\${name}.als`,
        started_at_ms: start + index * gapMs,
        last_updated_at_ms: start + index * gapMs + 60_000,
      }),
    ),
  );
}


/**
 * Versions with explicit sittings: `[name, ...dayOffsets]`.
 *
 * One sitting per version cannot express the case overlap detection exists for
 * — going back to an older file after a newer one appeared — because the
 * "going back" IS a second sitting.
 */
function versionsFromSittings(specs: [string, ...number[]][]): ProjectVersion[] {
  const captures: SavedSessionMetadata[] = [];
  specs.forEach(([name, ...days], versionIndex) => {
    days.forEach((offset, sittingIndex) => {
      captures.push(
        capture({
          id: `s${versionIndex}-${sittingIndex}`,
          als_path: `C:\\Music\\nightfall\\${name}.als`,
          started_at_ms: start + offset * day,
          last_updated_at_ms: start + offset * day + 60_000,
        }),
      );
    });
  });
  return projectVersions(captures);
}

function parentNames(nodes: ReturnType<typeof versionGraph>): Record<string, string | null> {
  const nameOf = new Map(nodes.map((node) => [node.id, node.version.name]));
  return Object.fromEntries(
    nodes.map((node) => [
      node.version.name,
      node.parentId === null ? null : (nameOf.get(node.parentId) ?? "?"),
    ]),
  );
}

describe("parseVersionName", () => {
  it("reads a trailing version number off the stem", () => {
    expect(parseVersionName("pers ep nightfall v4")).toEqual({
      stem: "pers ep nightfall",
      ordinal: 4,
    });
  });

  it("treats the same song written three ways as one stem", () => {
    // These land in a project folder together all the time: one saved by hand,
    // one by a template, one after a rename. They are the same lineage.
    expect(parseVersionName("nightfall_v2").stem).toBe("nightfall");
    expect(parseVersionName("Nightfall-V2").stem).toBe("nightfall");
    expect(parseVersionName("nightfall 2").stem).toBe("nightfall");
    expect(parseVersionName("nightfall_v2").ordinal).toBe(2);
    expect(parseVersionName("nightfall 2").ordinal).toBe(2);
  });

  it("does not invent a number for an unnumbered name", () => {
    expect(parseVersionName("nightfall")).toEqual({ stem: "nightfall", ordinal: null });
  });

  it("reads a version number from the middle of a name", () => {
    // Straight from the real library: two projects, same song, and the version
    // token sits before a trailing word. An end-anchored rule reads both as
    // unnumbered and loses the most obvious lineage there is.
    expect(parseVersionName("Breaking Point v3 mixdown")).toEqual({
      stem: "breaking point mixdown",
      ordinal: 3,
    });
    expect(parseVersionName("Breaking Point v2 mixdown").stem).toBe("breaking point mixdown");
  });

  it("keeps a named branch on its own stem", () => {
    // "v3 alt" is version three OF THE ALT LINE, not of the song. Different
    // stem from plain "nightfall", so the alt still gets its own lane — and
    // "nightfall v4 alt" now joins it instead of standing alone.
    expect(parseVersionName("nightfall v3 alt")).toEqual({
      stem: "nightfall alt",
      ordinal: 3,
    });
    expect(parseVersionName("nightfall v4 alt").stem).toBe("nightfall alt");
    expect(parseVersionName("nightfall v3 alt").stem).not.toBe(
      parseVersionName("nightfall v3").stem,
    );
  });

  it("prefers an explicit v-token over a trailing digit", () => {
    // "serum 2" is a device, "v2" is a version. When both shapes are present
    // the explicit one is the version.
    expect(parseVersionName("drums v2 serum 3")).toEqual({
      stem: "drums serum 3",
      ordinal: 2,
    });
  });

  it("keeps a bare number as its own stem rather than inventing an empty song", () => {
    expect(parseVersionName("v4")).toEqual({ stem: "v4", ordinal: null });
    expect(parseVersionName("2")).toEqual({ stem: "2", ordinal: null });
  });

  it("ignores the extension and surrounding whitespace", () => {
    expect(parseVersionName("  Nightfall V4.als  ")).toEqual({
      stem: "nightfall",
      ordinal: 4,
    });
  });
});

describe("versionGraph", () => {
  it("makes the oldest version the root and justifies it", () => {
    const nodes = versionGraph(versionsFromNames(["nightfall", "nightfall v2"]));
    expect(nodes[0]!.parentId).toBeNull();
    expect(nodes[0]!.basis).toBeNull();
    expect(nodes[0]!.inferred).toBe(false);
    expect(nodes[0]!.reason).toBe("The first version Recall knows about.");
  });

  it("follows the numbers when the names carry them", () => {
    const nodes = versionGraph(
      versionsFromNames(["nightfall", "nightfall v2", "nightfall v3", "nightfall v4"]),
    );
    expect(parentNames(nodes)).toEqual({
      nightfall: null,
      "nightfall v2": "nightfall",
      "nightfall v3": "nightfall v2",
      "nightfall v4": "nightfall v3",
    });
    expect(nodes.slice(1).every((node) => node.basis === "filename")).toBe(true);
  });

  it("skips a missing number rather than breaking the chain", () => {
    // v3 was never captured — deleted, or worked on before Recall existed.
    // v4 still descends from v2; a root would claim the song restarted.
    const nodes = versionGraph(versionsFromNames(["nightfall", "nightfall v2", "nightfall v4"]));
    expect(parentNames(nodes)["nightfall v4"]).toBe("nightfall v2");
  });

  it("does not follow numbers across different songs", () => {
    // Two songs in one project folder. `daybreak v2` must not descend from
    // `nightfall v1` just because the numbers happen to line up.
    const nodes = versionGraph(versionsFromNames(["nightfall v1", "daybreak v2"]));
    expect(parentNames(nodes)["daybreak v2"]).toBe("nightfall v1");
    expect(nodes[1]!.basis).toBe("activity");
  });

  it("falls back to what you had open when the name says nothing, and admits it", () => {
    const nodes = versionGraph(versionsFromNames(["nightfall", "nightfall final"]));
    expect(parentNames(nodes)["nightfall final"]).toBe("nightfall");
    expect(nodes[1]!.basis).toBe("activity");
    expect(nodes[1]!.reason).toContain("not observed");
  });

  it("falls back to the clock only after a cold return, and calls it a guess", () => {
    // Three weeks away. What you had open last month says nothing about what
    // you branched from today, so the activity link has no claim.
    const nodes = versionGraph(versionsFromSittings([
      ["nightfall", 0],
      ["nightfall final", 21],
    ]));
    expect(nodes[1]!.basis).toBe("chronological");
    expect(nodes[1]!.reason).toContain("guess");
  });

  it("marks every inferred edge as inferred so it renders dashed", () => {
    // DESIGN.md §11: a guess must never be drawn the way a fact is drawn.
    const nodes = versionGraph(
      versionsFromNames(["nightfall", "nightfall v2", "nightfall alt"]),
    );
    expect(nodes.slice(1).every((node) => node.inferred)).toBe(true);
  });

  it("names both versions in the reason so the hover explains itself", () => {
    const nodes = versionGraph(versionsFromNames(["nightfall v1", "nightfall v2"]));
    expect(nodes[1]!.reason).toContain("nightfall v2");
    expect(nodes[1]!.reason).toContain("nightfall v1");
  });

  it("forks when two versions share a parent", () => {
    // The shape this whole feature exists to show. v3 is worked on day 0, an
    // alt is branched off it on day 1, then v3 is picked up AGAIN on day 3 and
    // v4 comes off it on day 4 — so v3 has two children and the song forks.
    const nodes = versionGraph(
      versionsFromSittings([
        ["pers ep nightfall v3", 0, 3],
        ["pers ep nightfall v3 alt", 1],
        ["pers ep nightfall v4", 4],
      ]),
    );
    const parents = parentNames(nodes);
    expect(parents["pers ep nightfall v3 alt"]).toBe("pers ep nightfall v3");
    expect(parents["pers ep nightfall v4"]).toBe("pers ep nightfall v3");

    const children = childrenByParent(nodes);
    const v3 = nodes.find((node) => node.version.name === "pers ep nightfall v3")!;
    expect(children.get(v3.id)?.map((node) => node.version.name)).toEqual([
      "pers ep nightfall v3 alt",
      "pers ep nightfall v4",
    ]);
  });

  it("forks with no version numbers at all", () => {
    // The case that matters for real projects: names carry nothing, so every
    // link is activity-based. The fork still appears, because it comes from
    // going BACK to the first file on day 3 before branching again on day 4.
    const nodes = versionGraph(
      versionsFromSittings([
        ["new 90 bpm drums", 0, 3],
        ["new 90 bpm drums take", 1],
        ["new 90 bpm drums final", 4],
      ]),
    );
    const parents = parentNames(nodes);
    expect(parents["new 90 bpm drums take"]).toBe("new 90 bpm drums");
    expect(parents["new 90 bpm drums final"]).toBe("new 90 bpm drums");
    expect(nodes.slice(1).every((node) => node.basis === "activity")).toBe(true);
  });

  it("prefers the file you had open over the numbering when they disagree", () => {
    // v5 appears while you are back in v3. The name says it follows v4; the
    // sittings say it came off v3. Behaviour wins — a numbering scheme is a
    // convention, having v3 open is evidence, and deferring to the name here
    // would erase the fork.
    const nodes = versionGraph(
      versionsFromSittings([
        ["nightfall v3", 0, 4],
        ["nightfall v4", 1],
        ["nightfall v5", 5],
      ]),
    );
    expect(parentNames(nodes)["nightfall v5"]).toBe("nightfall v3");
    expect(nodes[2]!.basis).toBe("activity");
  });

  it("keeps the name when the name and the open file agree", () => {
    // The ordinary linear case: the newest file IS the one you were in, so the
    // producer's own numbering is the better thing to show.
    const nodes = versionGraph(
      versionsFromSittings([
        ["nightfall v3", 0],
        ["nightfall v4", 1],
      ]),
    );
    expect(nodes[1]!.basis).toBe("filename");
  });

  it("breaks a duplicate number toward the version worked on most recently", () => {
    // Two files both called v3 — someone saved it twice into different folders.
    // v4 descends from the one that was actually in front of the producer.
    //
    // Two things have to be true for this test to be about the tie-break at
    // all, and both are easy to get wrong.
    //
    // 1. The two folders must disagree about which kind of recency you mean.
    //    `a` was opened FIRST but worked LAST; `b` was opened second and
    //    dropped. Ranking by first sitting picks `b`, ranking by last sitting
    //    picks `a`. A fixture giving each version ONE sitting collapses the
    //    two readings and proves nothing.
    //
    // 2. Both v3s must be COLD — more than ACTIVE_WINDOW_MS before v4. The
    //    activity rule outranks the name and would otherwise reach `a` on its
    //    own, so the assertion would hold no matter what this tie-break did.
    //    Cold is the only window where the filename tie-break decides, which
    //    is exactly why it needs its own test.
    const versions = projectVersions([
      capture({ id: "a1", als_path: "C:\\a\\nightfall v3.als", started_at_ms: start }),
      capture({ id: "b1", als_path: "C:\\b\\nightfall v3.als", started_at_ms: start + 5 * day }),
      // Back into `a`, after `b` had already been made.
      capture({
        id: "a2",
        als_path: "C:\\a\\nightfall v3.als",
        started_at_ms: start + 10 * day,
        last_updated_at_ms: start + 10 * day + 60_000,
      }),
      capture({ id: "c", als_path: "C:\\a\\nightfall v4.als", started_at_ms: start + 20 * day }),
    ]);
    const nodes = versionGraph(versions);
    const v4 = nodes.find((node) => node.version.id.includes("v4"))!;
    expect(v4.parentId).toBe("c:/a/nightfall v3.als");
    // Proves the name decided it. If this reads "activity" the fixture went
    // warm again and the test has stopped covering the tie-break.
    expect(v4.basis).toBe("filename");
  });

  it("does not read a scanned file's timestamp as time the producer spent", () => {
    // A connected folder writes one row per `.als` with the file's modified
    // time and no events (storage.rs::add_scanned_takes). Recall was not
    // running, so nothing here may claim to know what was open: the honest
    // fallback is the clock, labelled as the guess it is.
    const scanned = (file: string, offsetDays: number) =>
      capture({
        id: `scan-${file}`,
        als_path: `C:\\Music\\nightfall\\${file}.als`,
        take_origin: "scanned",
        capture_status: "scanned",
        started_at_ms: start + offsetDays * day,
        ended_at_ms: start + offsetDays * day,
        last_updated_at_ms: start + offsetDays * day,
        event_count: 0,
        creative_event_count: 0,
      });

    // Unnumbered names, so filename lineage cannot rescue this either.
    const nodes = versionGraph(
      projectVersions([scanned("new 90 bpm drums", 0), scanned("drum bounce final", 1)]),
    );

    expect(nodes[1]!.basis).toBe("chronological");
    expect(nodes[1]!.reason).not.toMatch(/You were working in/);
  });

  it("still reads lineage from the names of scanned files", () => {
    // Withdrawing the behavioural claim must not cost the naming claim: the
    // names are real evidence even when Recall watched nothing.
    const scanned = (file: string, offsetDays: number) =>
      capture({
        id: `scan-${file}`,
        als_path: `C:\\Music\\nightfall\\${file}.als`,
        take_origin: "scanned",
        capture_status: "scanned",
        started_at_ms: start + offsetDays * day,
        ended_at_ms: start + offsetDays * day,
        last_updated_at_ms: start + offsetDays * day,
        event_count: 0,
        creative_event_count: 0,
      });

    const nodes = versionGraph(
      projectVersions([scanned("nightfall v2", 0), scanned("nightfall v3", 1)]),
    );

    expect(nodes[1]!.basis).toBe("filename");
  });

  it("gives an unanchored capture a parent instead of stranding it", () => {
    // An unsaved set has no file to key on. It still happened, and it still
    // happened after something, so the clock carries it.
    const versions = projectVersions([
      capture({ id: "saved", als_path: "C:\\a\\nightfall.als", started_at_ms: start }),
      capture({ id: "unsaved", als_path: null, started_at_ms: start + day }),
    ]);
    const nodes = versionGraph(versions);
    const unsaved = nodes.find((node) => node.id === "session:unsaved")!;
    expect(unsaved.parentId).toBe("c:/a/nightfall.als");
    expect(unsaved.basis).toBe("activity");
  });

  it("returns one node per version and no cycles", () => {
    const versions = versionsFromNames([
      "nightfall",
      "nightfall v2",
      "nightfall v3",
      "nightfall v3 alt",
      "nightfall v4",
    ]);
    const nodes = versionGraph(versions);
    expect(nodes).toHaveLength(versions.length);

    // Every parent is older than its child, so following parents terminates.
    const byId = new Map(nodes.map((node) => [node.id, node]));
    for (const node of nodes) {
      if (!node.parentId) continue;
      expect(byId.get(node.parentId)!.version.startedAtMs).toBeLessThan(node.version.startedAtMs);
    }
  });

  it("handles an empty project", () => {
    expect(versionGraph([])).toEqual([]);
  });

  it("handles a single version", () => {
    const nodes = versionGraph(versionsFromNames(["nightfall"]));
    expect(nodes).toHaveLength(1);
    expect(nodes[0]!.parentId).toBeNull();
  });
});
