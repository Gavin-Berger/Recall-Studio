import { describe, expect, it } from "vitest";
import type { SavedSessionMetadata } from "../../types/recall";
import { projectVersions } from "./projectVersions";
import { landingSessionId, versionHistoryRows } from "./projectHistory";

const minute = 60 * 1000;
const day = 24 * 60 * minute;
const start = 1_720_000_000_000;
const folder = "C:\\Music\\nightfall";

function capture(over: Partial<SavedSessionMetadata> & { id: string }): SavedSessionMetadata {
  return {
    name: "capture",
    project_id: "project-1",
    capture_name: null,
    capture_status: "ended",
    project_name: "nightfall",
    project_path: folder,
    als_path: `${folder}\\nightfall.als`,
    take_origin: "recorded",
    display_name: null,
    started_at_ms: start,
    ended_at_ms: start + minute,
    last_updated_at_ms: start + minute,
    event_count: 10,
    creative_event_count: 8,
    heartbeat_count: 0,
    ...over,
  };
}

function sitting(
  id: string,
  file: string,
  days: number,
  over: Partial<SavedSessionMetadata> = {},
): SavedSessionMetadata {
  return capture({
    id,
    als_path: `${folder}\\${file}.als`,
    started_at_ms: start + days * day,
    ended_at_ms: start + days * day + 30 * minute,
    last_updated_at_ms: start + days * day + 30 * minute,
    ...over,
  });
}

/**
 * A straight run to v4, then back into v3 and onward: a real fork.
 *
 * Going back is not by itself a branch — v3 having a second sitting only means
 * it was reopened. The fork exists once something NEW comes off it while a
 * newer file already exists, which is why v5 has to be here: it is born while
 * v3 is the file most recently worked, so it descends from v3 and leaves v3
 * with two children.
 */
function forked() {
  return projectVersions([
    sitting("s1", "nightfall v1", 0),
    sitting("s2", "nightfall v2", 1),
    sitting("s3", "nightfall v3", 2),
    sitting("s4", "nightfall v4", 3),
    // Back into v3, after v4 already existed...
    sitting("s5", "nightfall v3", 4),
    // ...and onward from there. This is the second lineage.
    sitting("s6", "nightfall v5", 5),
  ]);
}

/** The same run without the fork: v3 reopened last and left as the live file. */
function returned() {
  return projectVersions([
    sitting("s1", "nightfall v1", 0),
    sitting("s2", "nightfall v2", 1),
    sitting("s3", "nightfall v3", 2),
    sitting("s4", "nightfall v4", 3),
    sitting("s5", "nightfall v3", 4),
  ]);
}

describe("versionHistoryRows", () => {
  it("lists newest first, the way a commit list puts HEAD on top", () => {
    const rows = versionHistoryRows(forked());
    expect(rows.map((row) => row.node.version.name)).toEqual([
      "nightfall v5",
      "nightfall v4",
      "nightfall v3",
      "nightfall v2",
      "nightfall v1",
    ]);
  });

  it("gives one row per file, not per sitting", () => {
    // Five captures, four files. A row is a version; the sitting count is a
    // number ON the row, never another row.
    const rows = versionHistoryRows(returned());
    expect(rows).toHaveLength(4);
    expect(rows.find((row) => row.node.version.name === "nightfall v3")!.sittings).toBe(2);
  });

  it("puts the latest ref on the version worked on most recently", () => {
    // v3 was returned to AFTER v4 was made, so v3 is where the song actually
    // is. Ranking by when a file first appeared would put the ref on v4 and
    // point the producer at something they had already moved on from.
    const rows = versionHistoryRows(returned());
    const latest = rows.filter((row) => row.latest);
    expect(latest).toHaveLength(1);
    expect(latest[0]!.node.version.name).toBe("nightfall v3");
  });

  it("marks the version the song forked at", () => {
    const rows = versionHistoryRows(forked());
    const forkedRows = rows.filter((row) => row.branchPoint);
    expect(forkedRows.map((row) => row.node.version.name)).toEqual(["nightfall v3"]);
  });

  it("keeps the trunk at depth zero and puts the branch below it", () => {
    const rows = versionHistoryRows(forked());
    const byName = new Map(rows.map((row) => [row.node.version.name, row]));
    expect(byName.get("nightfall v1")!.depth).toBe(0);
    // Exactly one lineage may claim the trunk; the other is a branch.
    const depths = rows.map((row) => row.depth);
    expect(depths.some((depth) => depth > 0)).toBe(true);
  });

  it("reports a version Recall never captured as having no moves", () => {
    const rows = versionHistoryRows(
      projectVersions([
        sitting("s1", "nightfall v1", 0),
        sitting("s2", "nightfall v2", 1, {
          take_origin: "scanned",
          event_count: 0,
          creative_event_count: 0,
        }),
      ]),
    );
    expect(rows.find((row) => row.node.version.name === "nightfall v2")!.moves).toBe(0);
  });

  it("flags a version that is still being captured", () => {
    const rows = versionHistoryRows(
      projectVersions([sitting("s1", "nightfall v1", 0, { ended_at_ms: null })]),
    );
    expect(rows[0]!.live).toBe(true);
  });

  it("carries the parentage reason onto the row", () => {
    // The row is where this sentence is actually readable — on the graph it is
    // a hover. If it stops arriving, the surface loses the only place it
    // explains itself in plain language.
    const rows = versionHistoryRows(forked());
    for (const row of rows) {
      expect(row.node.reason.length).toBeGreaterThan(0);
    }
  });

  it("handles a project with no versions", () => {
    expect(versionHistoryRows([])).toEqual([]);
  });
});

describe("landingSessionId", () => {
  it("lands on the most recent sitting of the version", () => {
    const rows = versionHistoryRows(returned());
    const v3 = rows.find((row) => row.node.version.name === "nightfall v3")!;
    // s5 is the return visit; s3 was the first pass.
    expect(landingSessionId(v3)).toBe("s5");
  });
});
