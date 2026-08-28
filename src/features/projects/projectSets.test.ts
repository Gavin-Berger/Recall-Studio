import { describe, expect, it } from "vitest";
import type { SavedSessionMetadata } from "../../types/recall";
import { projectCommits } from "./projectCommits";
import { commitsInSet, defaultSetKey, projectSets, setKeyForCommit } from "./projectSets";

const minute = 60 * 1000;
const hour = 60 * minute;
const start = 1_720_000_000_000;
const folder = "C:\\Music\\breaking";

function work(
  id: string,
  set: string,
  atHours: number,
  over: Partial<SavedSessionMetadata> = {},
): SavedSessionMetadata {
  const startedAt = start + atHours * hour;
  return {
    id,
    name: "capture",
    project_id: "p",
    capture_name: null,
    capture_status: "ended",
    project_name: "breaking point",
    project_path: folder,
    als_path: `${folder}\\${set}.als`,
    take_origin: "recorded",
    display_name: null,
    started_at_ms: startedAt,
    ended_at_ms: startedAt + 45 * minute,
    last_updated_at_ms: startedAt + 45 * minute,
    event_count: 100,
    creative_event_count: 20,
    heartbeat_count: 0,
    ...over,
  };
}

/** Worked "breaking point", moved to the mixdown, and stayed there. */
function library() {
  return projectCommits([
    work("c1", "breaking point", 0),
    work("c2", "breaking point v2 mixdown", 3),
    work("c3", "breaking point v2 mixdown", 8),
    work("c4", "breaking point v2 mixdown", 30),
  ]).commits;
}

describe("projectSets", () => {
  it("groups the work by the set it happened in", () => {
    const sets = projectSets(library());
    expect(sets).toHaveLength(2);
    const mixdown = sets.find((set) => set.name === "breaking point v2 mixdown")!;
    expect(mixdown.sessions).toBe(3);
  });

  it("puts the set worked most recently first", () => {
    // That is the one a producer is currently in, and where the list opens.
    expect(projectSets(library())[0]!.name).toBe("breaking point v2 mixdown");
  });

  it("says which set this one came off", () => {
    // The relationship between sets is the context the list needs, and it is
    // read off the session lineage rather than recomputed from names.
    const mixdown = projectSets(library()).find(
      (set) => set.name === "breaking point v2 mixdown",
    )!;
    expect(mixdown.cameFrom).toBe("breaking point");
  });

  it("says nothing about an origin for the set the project started in", () => {
    const first = projectSets(library()).find((set) => set.name === "breaking point")!;
    expect(first.cameFrom).toBeNull();
  });

  it("does not call carrying on in the same set an origin", () => {
    // c3 and c4 continue c2 inside the same file. That is the producer keeping
    // going, not the set coming from somewhere.
    const sets = projectSets(
      projectCommits([
        work("c1", "one set", 0),
        work("c2", "one set", 4),
        work("c3", "one set", 9),
      ]).commits,
    );
    expect(sets).toHaveLength(1);
    expect(sets[0]!.cameFrom).toBeNull();
  });

  it("flags an origin that was inferred rather than watched", () => {
    const mixdown = projectSets(library()).find(
      (set) => set.name === "breaking point v2 mixdown",
    )!;
    // A new set appearing while Recall watched another is a guess, and the
    // surface has to be able to say so.
    expect(mixdown.cameFromInferred).toBe(true);
  });

  it("totals the work in each set", () => {
    const mixdown = projectSets(library()).find(
      (set) => set.name === "breaking point v2 mixdown",
    )!;
    expect(mixdown.changes).toBe(300);
  });

  it("marks a set that is still being captured", () => {
    const sets = projectSets(
      projectCommits([work("c1", "live one", 0, { ended_at_ms: null })]).commits,
    );
    expect(sets[0]!.live).toBe(true);
  });

  it("handles a project with no captured work", () => {
    expect(projectSets([])).toEqual([]);
  });
});

describe("commitsInSet", () => {
  it("keeps only the work done in one set", () => {
    const commits = library();
    const mixdownKey = projectSets(commits).find(
      (set) => set.name === "breaking point v2 mixdown",
    )!.key;
    const inSet = commitsInSet(commits, mixdownKey);
    expect(inSet.map((commit) => commit.id)).toEqual(["c2", "c3", "c4"]);
  });

  it("keeps everything when no set is focused", () => {
    const commits = library();
    expect(commitsInSet(commits, null)).toHaveLength(commits.length);
  });
});

describe("setKeyForCommit", () => {
  it("uses the same identity as the set chooser", () => {
    const commit = library()[1]!;
    const set = projectSets(library()).find((candidate) => candidate.name === commit.setName)!;
    expect(setKeyForCommit(commit)).toBe(set.key);
  });
});

describe("defaultSetKey", () => {
  it("lands on the set worked most recently", () => {
    const sets = projectSets(library());
    expect(defaultSetKey(sets)).toBe(sets[0]!.key);
  });

  it("has nothing to land on in an empty project", () => {
    expect(defaultSetKey([])).toBeNull();
  });
});
