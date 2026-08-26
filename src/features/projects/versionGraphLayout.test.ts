import { describe, expect, it } from "vitest";
import type { SavedSessionMetadata } from "../../types/recall";
import { projectVersions } from "./projectVersions";
import { versionGraph, type VersionNode } from "./versionGraph";
import {
  collapseGaps,
  DEFAULT_BREAK_MS,
  DEFAULT_GAP_MS,
  layoutVersionGraph,
} from "./versionGraphLayout";

const minute = 60 * 1000;
const hour = 60 * minute;
const day = 24 * hour;
const start = 1_720_000_000_000;

function capture(over: Partial<SavedSessionMetadata> = {}): SavedSessionMetadata {
  return {
    id: "session-1",
    name: "capture",
    project_id: "project-1",
    capture_name: null,
    capture_status: "ended",
    project_name: "nightfall",
    project_path: "C:\\Music\\nightfall",
    als_path: "C:\\Music\\nightfall\\nightfall.als",
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

function graphFromNames(names: string[], gapMs = day): VersionNode[] {
  return versionGraph(
    projectVersions(
      names.map((name, index) =>
        capture({
          id: `s${index}`,
          als_path: `C:\\Music\\nightfall\\${name}.als`,
          started_at_ms: start + index * gapMs,
          last_updated_at_ms: start + index * gapMs + minute,
        }),
      ),
    ),
  );
}

function laneNames(nodes: VersionNode[]): string[][] {
  const nameOf = new Map(nodes.map((node) => [node.id, node.version.name]));
  return layoutVersionGraph(nodes).lanes.map((lane) =>
    lane.nodeIds.map((id) => nameOf.get(id) ?? "?"),
  );
}

describe("layoutVersionGraph", () => {
  it("puts the song on the trunk and the experiment on the branch", () => {
    // The case that decides the whole lane rule: the alt is OLDER than v4, so
    // "eldest child keeps the trunk" would put the abandoned experiment on the
    // mainline and push the song onto a branch.
    const nodes = graphFromNames([
      "nightfall v2",
      "nightfall v3",
      "nightfall v3 alt",
      "nightfall v4",
    ]);
    expect(laneNames(nodes)).toEqual([
      ["nightfall v2", "nightfall v3", "nightfall v4"],
      ["nightfall v3 alt"],
    ]);
  });

  it("keeps a straight history on one lane", () => {
    // The rule that makes this a graph and not a ladder: a chain of single
    // children is ONE line with four nodes, the way a run of commits is.
    const nodes = graphFromNames(["nightfall", "nightfall v2", "nightfall v3", "nightfall v4"]);
    const layout = layoutVersionGraph(nodes);
    expect(layout.lanes).toHaveLength(1);
    expect(layout.lanes[0]!.depth).toBe(0);
    expect(layout.lanes[0]!.nodeIds).toHaveLength(4);
    expect(layout.placements.every((placement) => placement.lane === 0)).toBe(true);
  });

  it("opens a lane only on a second child", () => {
    const nodes = graphFromNames([
      "nightfall",
      "nightfall v2",
      "nightfall v3",
      "nightfall v3 alt",
      "nightfall v4",
    ]);
    expect(laneNames(nodes)).toEqual([
      ["nightfall", "nightfall v2", "nightfall v3", "nightfall v4"],
      ["nightfall v3 alt"],
    ]);
  });

  it("keeps a renamed continuation on its branch instead of forking again", () => {
    // `alt` forks off the trunk, then `alt take` continues it. One fork, two
    // lanes — a lineage that keeps going is still one line, whatever it is called.
    const nodes = graphFromNames([
      "nightfall",
      "nightfall v2",
      "nightfall alt",
      "nightfall alt take",
      "nightfall v3",
    ]);
    expect(laneNames(nodes)).toEqual([
      ["nightfall", "nightfall v2", "nightfall v3"],
      ["nightfall alt", "nightfall alt take"],
    ]);
  });

  it("puts a branch off a branch one level dimmer again", () => {
    // `alt` forks off the trunk; `alt bounce` and `alt v2` both come off `alt`,
    // so the named one carries that branch and the other forks a third time.
    // Depth drives --lane-0..3; it is distance from the trunk, never importance.
    const nodes = graphFromNames([
      "nightfall",
      "nightfall v2",
      "nightfall alt",
      "nightfall alt bounce",
      "nightfall alt v2",
      "nightfall v3",
    ]);
    const layout = layoutVersionGraph(nodes);
    expect(layout.lanes.map((lane) => lane.depth)).toEqual([0, 1, 2]);
    expect(laneNames(nodes)[2]).toEqual(["nightfall alt bounce"]);
  });

  it("carries every sitting onto the lane as a tick", () => {
    const versions = projectVersions([
      capture({ id: "a", started_at_ms: start }),
      capture({ id: "b", started_at_ms: start + 2 * hour }),
      capture({ id: "c", started_at_ms: start + 5 * hour }),
    ]);
    const layout = layoutVersionGraph(versionGraph(versions));
    expect(layout.placements).toHaveLength(1);
    expect(layout.placements[0]!.sittingsMs).toEqual([start, start + 2 * hour, start + 5 * hour]);
  });

  it("places each node at the real time its version began", () => {
    const nodes = graphFromNames(["nightfall", "nightfall v2"]);
    const layout = layoutVersionGraph(nodes);
    expect(layout.placements.map((placement) => placement.atMs)).toEqual([start, start + day]);
  });

  it("draws one edge per parent link, carrying the lanes it spans", () => {
    const nodes = graphFromNames([
      "nightfall",
      "nightfall v2",
      "nightfall alt",
      "nightfall v3",
    ]);
    const layout = layoutVersionGraph(nodes);
    expect(layout.edges).toHaveLength(3);
    const fork = layout.edges.find((edge) => edge.fromLane !== edge.toLane)!;
    expect(fork.fromLane).toBe(0);
    expect(fork.toLane).toBe(1);
  });

  it("marks inferred edges so they render dashed", () => {
    const nodes = graphFromNames(["nightfall", "nightfall v2"]);
    expect(layoutVersionGraph(nodes).edges.every((edge) => edge.inferred)).toBe(true);
  });

  it("gives a lone version one lane and no edges", () => {
    const layout = layoutVersionGraph(graphFromNames(["nightfall"]));
    expect(layout.lanes).toHaveLength(1);
    expect(layout.edges).toEqual([]);
  });

  it("handles an empty project", () => {
    expect(layoutVersionGraph([])).toEqual({ lanes: [], placements: [], edges: [] });
  });

  it("places every node exactly once", () => {
    const nodes = graphFromNames([
      "nightfall",
      "nightfall v2",
      "nightfall v2 alt",
      "nightfall v3",
      "nightfall b",
    ]);
    const layout = layoutVersionGraph(nodes);
    expect(layout.placements).toHaveLength(nodes.length);
    const placed = layout.lanes.flatMap((lane) => lane.nodeIds);
    expect(new Set(placed).size).toBe(nodes.length);
  });
});

describe("collapseGaps", () => {
  it("draws a working stretch at real scale", () => {
    const scale = collapseGaps([start, start + hour, start + 3 * hour]);
    expect(scale.gaps).toHaveLength(0);
    expect(scale.spanMs).toBe(3 * hour);
    expect(scale.project(start + hour)).toBe(hour);
  });

  it("squeezes dead air down to a fixed break", () => {
    // Three weeks away from the song. Drawn to scale it is a screen of nothing.
    const away = 21 * day;
    const scale = collapseGaps([start, start + hour, start + away, start + away + hour]);
    expect(scale.gaps).toHaveLength(1);
    expect(scale.spanMs).toBe(hour + DEFAULT_BREAK_MS + hour);
  });

  it("reports what each break removed so the label can name it", () => {
    // DESIGN.md §11: a break that names what it removed is honest; silently
    // rescaling the axis is not.
    const away = 21 * day;
    const scale = collapseGaps([start, start + away]);
    expect(scale.gaps[0]!.durationMs).toBe(away);
  });

  it("keeps order across a break", () => {
    const away = 30 * day;
    const scale = collapseGaps([start, start + hour, start + away, start + away + hour]);
    const drawn = [start, start + hour, start + away, start + away + hour].map(scale.project);
    expect(drawn).toEqual([...drawn].sort((a, b) => a - b));
  });

  it("does not collapse a gap at the threshold, only past it", () => {
    expect(collapseGaps([start, start + DEFAULT_GAP_MS]).gaps).toHaveLength(0);
    expect(collapseGaps([start, start + DEFAULT_GAP_MS + 1]).gaps).toHaveLength(1);
  });

  it("honours a custom threshold", () => {
    const scale = collapseGaps([start, start + 2 * hour], { gapMs: hour, breakMs: minute });
    expect(scale.gaps).toHaveLength(1);
    expect(scale.spanMs).toBe(minute);
  });

  it("clamps a time inside a gap to the segment it precedes", () => {
    const away = 30 * day;
    const scale = collapseGaps([start, start + away]);
    const insideTheGap = start + 10 * day;
    expect(scale.project(insideTheGap)).toBe(scale.project(start + away));
  });

  it("survives duplicate and unsorted input", () => {
    const scale = collapseGaps([start + hour, start, start + hour]);
    expect(scale.spanMs).toBe(hour);
    expect(scale.project(start)).toBe(0);
  });

  it("handles no times at all", () => {
    const scale = collapseGaps([]);
    expect(scale.spanMs).toBe(0);
    expect(scale.project(start)).toBe(0);
  });
});
