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

  it("keeps a named branch as its own stem", () => {
    // "v3 alt" is not the third version of anything — the producer branched and
    // named the branch. A separate stem is what puts it on its own lane.
    expect(parseVersionName("nightfall v3 alt")).toEqual({
      stem: "nightfall v3 alt",
      ordinal: null,
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
    expect(nodes[1]!.basis).toBe("chronological");
  });

  it("falls back to the clock when there is nothing in the name, and says so", () => {
    const nodes = versionGraph(versionsFromNames(["nightfall", "nightfall final"]));
    expect(parentNames(nodes)["nightfall final"]).toBe("nightfall");
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
    // The shape this whole feature exists to show: a trunk to v3, a named
    // branch off it, and the trunk carrying on to v4.
    const nodes = versionGraph(
      versionsFromNames([
        "pers ep nightfall",
        "pers ep nightfall v2",
        "pers ep nightfall v3",
        "pers ep nightfall v3 alt",
        "pers ep nightfall v4",
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

  it("breaks a duplicate number toward the version worked on most recently", () => {
    // Two files both called v3 — someone saved it twice into different folders.
    // v4 descends from the one that was actually in front of the producer.
    const versions = projectVersions([
      capture({ id: "a", als_path: "C:\\a\\nightfall v3.als", started_at_ms: start }),
      capture({ id: "b", als_path: "C:\\b\\nightfall v3.als", started_at_ms: start + day }),
      capture({ id: "c", als_path: "C:\\a\\nightfall v4.als", started_at_ms: start + 2 * day }),
    ]);
    const nodes = versionGraph(versions);
    const v4 = nodes.find((node) => node.version.id.includes("v4"))!;
    expect(v4.parentId).toBe("c:/b/nightfall v3.als");
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
    expect(unsaved.basis).toBe("chronological");
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
