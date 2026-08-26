import { describe, expect, it } from "vitest";
import type { SavedSessionMetadata } from "../../types/recall";
import { CONTINUATION_WINDOW_MS, projectCommits } from "./projectCommits";

const minute = 60 * 1000;
const hour = 60 * minute;
const start = 1_720_000_000_000;
const folder = "C:\\Music\\nightfall";

/**
 * A captured stretch of work: one session, against one set, that recorded
 * something. `atHours` is when it began, `lengthMin` how long it ran.
 */
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
    project_id: "project-1",
    capture_name: null,
    capture_status: "ended",
    project_name: "nightfall",
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

/** A set found on disk, never captured. */
function onDisk(id: string, set: string, atHours: number): SavedSessionMetadata {
  const at = start + atHours * hour;
  return work(id, set, atHours, {
    take_origin: "scanned",
    capture_status: "scanned",
    ended_at_ms: at,
    last_updated_at_ms: at,
    event_count: 0,
    creative_event_count: 0,
  });
}

/** A session Recall opened but which recorded nothing. */
function emptyCheckpoint(id: string, set: string, atHours: number): SavedSessionMetadata {
  return work(id, set, atHours, { event_count: 0, creative_event_count: 0 });
}

function parents(captures: SavedSessionMetadata[]): Record<string, string | null> {
  return Object.fromEntries(
    projectCommits(captures).commits.map((commit) => [commit.id, commit.parentId]),
  );
}

describe("projectCommits · what counts as a commit", () => {
  it("makes one commit per captured stretch of work, not one per file", () => {
    // Three sessions against the SAME set is three commits. The old model
    // collapsed these into a single file node with tick marks, which is exactly
    // the intermediate history that was invisible.
    const model = projectCommits([
      work("c1", "nightfall", 0),
      work("c2", "nightfall", 5),
      work("c3", "nightfall", 30),
    ]);
    expect(model.commits.map((commit) => commit.id)).toEqual(["c1", "c2", "c3"]);
  });

  it("does not make a commit out of a session that recorded nothing", () => {
    // Recall opened a take, watched, and saw no work. There is nothing to put
    // in the history, and a node would claim otherwise.
    const model = projectCommits([
      work("c1", "nightfall", 0),
      emptyCheckpoint("empty", "nightfall", 2),
      work("c2", "nightfall", 5),
    ]);
    expect(model.commits.map((commit) => commit.id)).toEqual(["c1", "c2"]);
    expect(model.emptyCheckpoints).toBe(1);
  });

  it("keeps the set as metadata on the commit, not as its identity", () => {
    const [commit] = projectCommits([work("c1", "nightfall v2", 0)]).commits;
    expect(commit!.id).toBe("c1");
    expect(commit!.setName).toBe("nightfall v2");
    expect(commit!.alsPath).toContain("nightfall v2.als");
  });

  it("carries the recorded-change counts as the commit's contents", () => {
    const [commit] = projectCommits([
      work("c1", "nightfall", 0, { event_count: 481, creative_event_count: 57 }),
    ]).commits;
    expect(commit!.changes).toBe(481);
    expect(commit!.creativeChanges).toBe(57);
  });

  it("marks a commit whose capture is still running", () => {
    const [commit] = projectCommits([
      work("c1", "nightfall", 0, { ended_at_ms: null }),
    ]).commits;
    expect(commit!.live).toBe(true);
  });
});

describe("projectCommits · linear evolution", () => {
  it("chains work on the same set, and calls it observed", () => {
    const model = projectCommits([
      work("c1", "nightfall", 0),
      work("c2", "nightfall", 5),
      work("c3", "nightfall", 30),
    ]);
    expect(parents([work("c1", "nightfall", 0), work("c2", "nightfall", 5), work("c3", "nightfall", 30)])).toEqual({
      c1: null,
      c2: "c1",
      c3: "c2",
    });
    // Continuing the same set is watched, not guessed: it draws solid.
    expect(model.commits.slice(1).every((commit) => commit.basis === "continued")).toBe(true);
    expect(model.commits.slice(1).every((commit) => commit.inferred === false)).toBe(true);
  });

  it("continues the same set across any gap at all", () => {
    // Reopening a file after six months is still literally continuing that
    // state. The gap says nothing about whether it happened.
    const model = projectCommits([
      work("c1", "nightfall", 0),
      work("c2", "nightfall", 24 * 200),
    ]);
    expect(model.commits[1]!.parentId).toBe("c1");
    expect(model.commits[1]!.basis).toBe("continued");
  });

  it("hangs a new set off the one Recall had open, and admits it inferred that", () => {
    const model = projectCommits([work("c1", "nightfall", 0), work("c2", "nightfall v2", 3)]);
    expect(model.commits[1]!.parentId).toBe("c1");
    expect(model.commits[1]!.basis).toBe("branched");
    expect(model.commits[1]!.inferred).toBe(true);
  });
});

describe("projectCommits · returning to an older state", () => {
  // The case the whole rewrite exists for. Work `nightfall`, save `nightfall
  // v2` and work it, then go BACK to `nightfall` and keep pushing it.
  const returned = [
    work("c1", "nightfall", 0),
    work("c2", "nightfall v2", 3),
    work("c3", "nightfall v2", 8),
    work("c4", "nightfall", 12),
  ];

  it("takes the older state as the parent, not whatever happened last", () => {
    // c4 continues c1, because c1 is the state it reopened. Bare chronology
    // would hand it c3, which is a different lineage entirely.
    expect(parents(returned).c4).toBe("c1");
  });

  it("forks: the reopened commit now has two children", () => {
    const model = projectCommits(returned);
    const childrenOfC1 = model.commits.filter((commit) => commit.parentId === "c1");
    expect(childrenOfC1.map((commit) => commit.id).sort()).toEqual(["c2", "c4"]);
  });

  it("shows every intermediate stretch of work, not one node per file", () => {
    // Four commits across two sets. The old model drew two nodes.
    expect(projectCommits(returned).commits).toHaveLength(4);
  });

  it("needs no version numbers in the names at all", () => {
    const unnamed = [
      work("c1", "new 90 bpm drums", 0),
      work("c2", "drum bounce", 3),
      work("c3", "new 90 bpm drums", 8),
    ];
    expect(parents(unnamed).c3).toBe("c1");
    expect(projectCommits(unnamed).commits[2]!.basis).toBe("continued");
  });
});

describe("projectCommits · refusing to invent history", () => {
  it("leaves a scanned file out of the history entirely", () => {
    const model = projectCommits([
      work("c1", "nightfall", 0),
      onDisk("scan", "nightfall v9", 3),
    ]);
    expect(model.commits.map((commit) => commit.id)).toEqual(["c1"]);
    expect(model.artifacts.map((artifact) => artifact.id)).toEqual(["scan"]);
  });

  it("never links a scanned file to anything", () => {
    // Artifacts have no parentId to set. Their timestamp is a file mtime, not
    // evidence of work, so nothing may descend from them either.
    const model = projectCommits([
      onDisk("a", "one", 0),
      onDisk("b", "two", 3),
      work("c1", "three", 6),
    ]);
    expect(model.artifacts).toHaveLength(2);
    expect(model.commits).toHaveLength(1);
    expect(model.commits[0]!.parentId).toBeNull();
  });

  it("gives a project of nothing but scanned files no history at all", () => {
    const model = projectCommits([onDisk("a", "one", 0), onDisk("b", "two", 3)]);
    expect(model.commits).toEqual([]);
    expect(model.artifacts).toHaveLength(2);
  });

  it("does not invent parentage between commits that began at the same instant", () => {
    // Equal timestamps carry no evidence about which continued which. Picking
    // one would be arbitrary, so both stand as roots.
    const model = projectCommits([
      work("a", "one", 0),
      work("b", "two", 0),
    ]);
    expect(model.commits.every((commit) => commit.parentId === null)).toBe(true);
  });

  it("still continues the same set when two OTHER commits tie", () => {
    // A tie must not disable the observed rule, only the inferred one.
    const model = projectCommits([
      work("a", "one", 0),
      work("b", "two", 0),
      work("c", "one", 5),
    ]);
    expect(model.commits.find((commit) => commit.id === "c")!.parentId).toBe("a");
  });

  it("starts a new root rather than guessing across a long silence", () => {
    const gapHours = CONTINUATION_WINDOW_MS / hour + 24;
    const model = projectCommits([work("c1", "nightfall", 0), work("c2", "daybreak", gapHours)]);
    expect(model.commits[1]!.parentId).toBeNull();
    expect(model.commits[1]!.basis).toBeNull();
  });

  it("allows several roots when Recall genuinely has no evidence", () => {
    const gapHours = CONTINUATION_WINDOW_MS / hour + 24;
    const model = projectCommits([
      work("c1", "one", 0),
      work("c2", "two", gapHours),
      work("c3", "three", gapHours * 2),
    ]);
    expect(model.commits.filter((commit) => commit.parentId === null)).toHaveLength(3);
  });
});

describe("projectCommits · uncertainty language", () => {
  it("never claims a filename was the evidence", () => {
    // The old model read version numbers out of names. Nothing here does, so
    // nothing here may say it did.
    const model = projectCommits([
      work("c1", "nightfall", 0),
      work("c2", "nightfall v2", 3),
      work("c3", "nightfall", 8),
    ]);
    for (const commit of model.commits) {
      expect(commit.reason).not.toMatch(/file ?name|numbering|read from the names/i);
    }
  });

  it("says a continued commit was watched, without hedging", () => {
    const model = projectCommits([work("c1", "nightfall", 0), work("c2", "nightfall", 5)]);
    expect(model.commits[1]!.inferred).toBe(false);
    expect(model.commits[1]!.reason).not.toMatch(/likely|guess|probably|not observed/i);
  });

  it("says an inferred commit is a guess, and what the guess was from", () => {
    const model = projectCommits([work("c1", "nightfall", 0), work("c2", "nightfall v2", 3)]);
    const reason = model.commits[1]!.reason;
    expect(model.commits[1]!.inferred).toBe(true);
    expect(reason).toMatch(/not observed/i);
    // It must name the set it inferred FROM, or the claim is unauditable.
    expect(reason).toContain("nightfall");
  });

  it("says plainly when it has nothing to go on", () => {
    const gapHours = CONTINUATION_WINDOW_MS / hour + 24;
    const model = projectCommits([work("c1", "one", 0), work("c2", "two", gapHours)]);
    expect(model.commits[1]!.reason).toMatch(/no evidence/i);
  });

  it("does not describe an unsaved set as if it had a name", () => {
    const model = projectCommits([
      work("c1", "nightfall", 0),
      work("c2", "ignored", 3, { als_path: null, display_name: null }),
    ]);
    expect(model.commits[1]!.setName).toBeNull();
    expect(model.commits[1]!.reason).toContain("an unsaved set");
  });
});
