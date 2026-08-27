import { describe, expect, it } from "vitest";
import type { SavedSessionMetadata } from "../../types/recall";
import { projectCommits, type ProjectCommit } from "./projectCommits";
import type { SessionStep } from "./sessionSteps";
import { timelineNodes, withStepCount } from "./timelineNodes";

const minute = 60 * 1000;
const hour = 60 * minute;
const start = 1_720_000_000_000;

function work(id: string, set: string, atHours: number): SavedSessionMetadata {
  const startedAt = start + atHours * hour;
  return {
    id,
    name: "capture",
    project_id: "p",
    capture_name: null,
    capture_status: "ended",
    project_name: "nightfall",
    project_path: "C:\\Music\\nightfall",
    als_path: `C:\\Music\\nightfall\\${set}.als`,
    take_origin: "recorded",
    display_name: null,
    started_at_ms: startedAt,
    ended_at_ms: startedAt + 45 * minute,
    last_updated_at_ms: startedAt + 45 * minute,
    event_count: 100,
    creative_event_count: 20,
    heartbeat_count: 0,
  };
}

function step(id: string, atMinutes: number): SessionStep {
  return {
    id,
    title: `Step ${id}`,
    kind: "Sound",
    startMs: start + atMinutes * minute,
    endMs: start + (atMinutes + 5) * minute,
    gapBeforeMs: null,
    tracks: ["Drums"],
    controls: [],
    moreControls: 0,
    moves: 4,
    noteEdits: 1,
    clipEvents: 0,
  };
}

function commitsOf(captures: SavedSessionMetadata[]): ProjectCommit[] {
  return projectCommits(captures).commits;
}

const threeSessions = commitsOf([
  work("s1", "nightfall", 0),
  work("s2", "nightfall", 5),
  work("s3", "nightfall", 30),
]);

describe("timelineNodes · collapsed", () => {
  it("draws one node per session when nothing is open", () => {
    const nodes = timelineNodes(threeSessions, null, []);
    expect(nodes).toHaveLength(3);
    expect(nodes.every((node) => node.kind === "session")).toBe(true);
  });

  it("chains the sessions in the order they happened", () => {
    const nodes = timelineNodes(threeSessions, null, []);
    expect(nodes[0]!.parentId).toBeNull();
    expect(nodes[1]!.parentId).toBe("s1");
    expect(nodes[2]!.parentId).toBe("s2");
  });

  it("carries a session's own uncertainty onto its node", () => {
    // A new set appearing while Recall watched another is a guess.
    const commits = commitsOf([work("s1", "nightfall", 0), work("s2", "nightfall v2", 3)]);
    const nodes = timelineNodes(commits, null, []);
    expect(nodes[1]!.inferred).toBe(true);
  });
});

describe("timelineNodes · opened", () => {
  const steps = [step("a", 0), step("b", 10), step("c", 20)];

  it("replaces the open session with its steps", () => {
    const nodes = timelineNodes(threeSessions, "s2", steps);
    expect(nodes.filter((node) => node.kind === "step")).toHaveLength(3);
    expect(nodes.find((node) => node.id === "s2")).toBeUndefined();
  });

  it("leaves the other sessions collapsed", () => {
    const nodes = timelineNodes(threeSessions, "s2", steps);
    const sessions = nodes.filter((node) => node.kind === "session");
    expect(sessions.map((node) => node.id)).toEqual(["s1", "s3"]);
  });

  it("keeps the chain unbroken across the opened session", () => {
    // Expanding must never cut the line. The first step takes the node before
    // it, and the session after takes the LAST step.
    const nodes = timelineNodes(threeSessions, "s2", steps);
    const byId = new Map(nodes.map((node) => [node.id, node]));
    expect(byId.get("a")!.parentId).toBe("s1");
    expect(byId.get("b")!.parentId).toBe("a");
    expect(byId.get("c")!.parentId).toBe("b");
    expect(byId.get("s3")!.parentId).toBe("c");
  });

  it("marks only the first step as uncertain when the session was a guess", () => {
    // The steps after it follow each other inside one sitting, which Recall
    // watched happen. Only the link crossing from another session is inferred.
    const commits = commitsOf([work("s1", "nightfall", 0), work("s2", "nightfall v2", 3)]);
    const nodes = timelineNodes(commits, "s2", steps);
    const stepNodes = nodes.filter((node) => node.kind === "step");
    expect(stepNodes[0]!.inferred).toBe(true);
    expect(stepNodes.slice(1).every((node) => node.inferred === false)).toBe(true);
  });

  it("collapses the session while its steps are still being read", () => {
    // An empty step list means "not read yet", not "no work". The graph must
    // not flicker between two shapes on the way.
    const nodes = timelineNodes(threeSessions, "s2", []);
    expect(nodes).toHaveLength(3);
    expect(nodes.every((node) => node.kind === "session")).toBe(true);
  });

  it("keeps every step pointing at the session it belongs to", () => {
    const nodes = timelineNodes(threeSessions, "s2", steps);
    for (const node of nodes.filter((entry) => entry.kind === "step")) {
      expect(node.sessionId).toBe("s2");
    }
  });

  it("marks only the final step live while capture is running", () => {
    const running = commitsOf([
      { ...work("s1", "nightfall", 0), ended_at_ms: null },
    ]);
    const nodes = timelineNodes(running, "s1", steps);
    const stepNodes = nodes.filter((node) => node.kind === "step");
    expect(stepNodes[stepNodes.length - 1]!.live).toBe(true);
    expect(stepNodes.slice(0, -1).every((node) => node.live === false)).toBe(true);
  });
});

describe("withStepCount", () => {
  it("tells a collapsed session how many steps it holds", () => {
    const nodes = withStepCount(timelineNodes(threeSessions, null, []), "s2", 7);
    expect(nodes.find((node) => node.id === "s2")!.stepCount).toBe(7);
    expect(nodes.find((node) => node.id === "s1")!.stepCount).toBeNull();
  });
});
