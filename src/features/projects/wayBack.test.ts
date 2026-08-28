import { describe, expect, it } from "vitest";
import type { SavedSessionMetadata } from "../../types/recall";
import { projectCommits } from "./projectCommits";
import { describeWayBack, fileNameOf, wayBack } from "./wayBack";

const minute = 60 * 1000;
const hour = 60 * minute;
const start = 1_720_000_000_000;
const folder = "C:\\Music\\Breaking Point Project";

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
    event_count: 120,
    creative_event_count: 30,
    heartbeat_count: 0,
    ...over,
  };
}

/** Two sets: the mixdown was worked three times, the original once. */
function library() {
  return projectCommits([
    work("c1", "breaking point", 0),
    work("c2", "breaking point v2 mixdown", 3),
    work("c3", "breaking point v2 mixdown", 30),
    work("c4", "breaking point v2 mixdown", 60),
  ]).commits;
}

function commit(id: string) {
  return library().find((entry) => entry.id === id)!;
}

describe("wayBack", () => {
  it("names the file the work happened in", () => {
    const way = wayBack(commit("c2"), library());
    expect(way.fileName).toBe("breaking point v2 mixdown.als");
    expect(way.path).toContain(folder);
  });

  it("gives the producer's real path, not the normalised one", () => {
    // `commit.alsPath` is lowercased with its separators flipped, because it
    // exists to group sessions by set. Printing it would show a folder the
    // producer does not recognise, and the file opener may not resolve it.
    const way = wayBack(commit("c2"), library());
    expect(way.path).toBe(`${folder}\\breaking point v2 mixdown.als`);
    expect(way.path).not.toBe(commit("c2").alsPath);
    // The normalised one is lowercased with forward slashes; the real one is
    // neither.
    expect(commit("c2").alsPath).toContain("/");
    expect(way.path).not.toContain("/");
  });

  it("counts the times the set was worked after this", () => {
    // This is the fact a producer cannot know on their own, and getting it
    // wrong wastes a real trip into Ableton.
    expect(wayBack(commit("c2"), library()).workedSince).toBe(2);
    expect(wayBack(commit("c3"), library()).workedSince).toBe(1);
    expect(wayBack(commit("c4"), library()).workedSince).toBe(0);
  });

  it("counts only work in the SAME set", () => {
    // Sessions in the mixdown say nothing about whether the original moved on.
    expect(wayBack(commit("c1"), library()).workedSince).toBe(0);
  });

  it("counts later work the list is currently hiding", () => {
    // "Worked since" has to see the whole project, not the focused set, or it
    // under-reports whenever the surface is narrowed.
    const all = library();
    const focusedToOneSet = all.filter((entry) => entry.id === "c2");
    expect(wayBack(commit("c2"), all).workedSince).toBe(2);
    expect(wayBack(commit("c2"), focusedToOneSet).workedSince).toBe(0);
  });

  it("does not count a session that began at the same instant", () => {
    // Equal timestamps carry no evidence of coming later, and counting them
    // would overstate how far the file has drifted.
    const tied = projectCommits([
      work("a", "one", 0),
      work("b", "one", 0),
    ]).commits;
    expect(wayBack(tied[0]!, tied).workedSince).toBe(0);
  });

  it("reports when the set was last touched", () => {
    const way = wayBack(commit("c2"), library());
    expect(way.lastTouchedMs).toBe(start + 60 * hour + 45 * minute);
  });

  it("says nothing about a file for an unsaved set", () => {
    const unsaved = projectCommits([
      work("u", "ignored", 0, { als_path: null, display_name: null }),
    ]).commits;
    const way = wayBack(unsaved[0]!, unsaved);
    expect(way.path).toBeNull();
    expect(way.fileName).toBeNull();
  });
});

describe("describeWayBack", () => {
  it("warns that the file has moved on", () => {
    // Recall holds the record, not the audio. Implying you can return to the
    // sound would be a promise it cannot keep.
    const line = describeWayBack(wayBack(commit("c2"), library()));
    expect(line).toMatch(/2 times since/);
    expect(line).toMatch(/will not show you this/);
  });

  it("uses the singular for one later session", () => {
    expect(describeWayBack(wayBack(commit("c3"), library()))).toMatch(/once since/);
  });

  it("says the file should still be where this left it when nothing followed", () => {
    const line = describeWayBack(wayBack(commit("c4"), library()));
    expect(line).toMatch(/Nothing has been captured in this set since/);
  });

  it("says there is no file at all for an unsaved set", () => {
    const unsaved = projectCommits([
      work("u", "ignored", 0, { als_path: null, display_name: null }),
    ]).commits;
    expect(describeWayBack(wayBack(unsaved[0]!, unsaved))).toMatch(/never saved/);
  });

  it("never promises the set will look the way it did", () => {
    // §1: Recall never pretends. It can point at a file; it cannot restore a
    // moment, and must not sound like it can.
    for (const id of ["c1", "c2", "c3", "c4"]) {
      const line = describeWayBack(wayBack(commit(id), library()));
      expect(line).not.toMatch(/restore|revert|go back to this sound|as it was/i);
    }
  });
});

describe("fileNameOf", () => {
  it("reads the file off a Windows path", () => {
    expect(fileNameOf("C:\\Music\\Song\\take.als")).toBe("take.als");
  });

  it("reads the file off a POSIX path", () => {
    expect(fileNameOf("/Users/g/Music/take.als")).toBe("take.als");
  });

  it("says nothing when there is no path", () => {
    expect(fileNameOf(null)).toBeNull();
  });
});
