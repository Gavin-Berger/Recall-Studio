import { describe, expect, it } from "vitest";
import type { SavedSessionMetadata } from "../../types/recall";
import { projectVersions } from "./projectVersions";
import { versionGraph, type ObservedSave } from "./versionGraph";
import { layoutVersionGraph } from "./versionGraphLayout";
import {
  layoutVersionTimeline,
  TIMELINE_BREAK_MS,
  TIMELINE_PIXELS_PER_HOUR,
  TIMELINE_ROW_HEIGHT,
} from "./versionTimelineLayout";

const hour = 60 * 60 * 1000;
const minute = 60 * 1000;
const day = 24 * hour;
const start = 1_720_000_000_000;

function capture(
  id: string,
  file: string,
  atMs: number,
  overrides: Partial<SavedSessionMetadata> = {},
): SavedSessionMetadata {
  return {
    id,
    name: "capture",
    project_id: "timeline-layout",
    capture_name: null,
    capture_status: "ended",
    project_name: "Timeline layout",
    project_path: "C:\\Music\\Timeline layout",
    als_path: `C:\\Music\\Timeline layout\\${file}.als`,
    take_origin: "recorded",
    display_name: null,
    started_at_ms: atMs,
    ended_at_ms: atMs + minute,
    last_updated_at_ms: atMs + minute,
    event_count: 10,
    creative_event_count: 8,
    heartbeat_count: 0,
    ...overrides,
  };
}

function build(captures: SavedSessionMetadata[], saves: ObservedSave[] = []) {
  const nodes = versionGraph(projectVersions(captures), saves);
  return layoutVersionTimeline(nodes, layoutVersionGraph(nodes), saves);
}

describe("layoutVersionTimeline", () => {
  it("keeps working time linear and names a long absence instead of making every row even", () => {
    const timeline = build([
      capture("v1", "Nightfall", start),
      capture("v2", "Nightfall v2", start + 5 * minute),
      capture("v3", "Nightfall v3", start + 5 * 30 * day),
    ]);

    const [first, second, third] = timeline.rows;
    expect(second!.y - first!.y).toBeCloseTo(
      TIMELINE_ROW_HEIGHT + (5 * minute / hour) * TIMELINE_PIXELS_PER_HOUR,
    );
    expect(third!.y - second!.y).toBeGreaterThan(TIMELINE_ROW_HEIGHT);
    expect(timeline.breaks).toEqual([
      expect.objectContaining({ text: "5 months" }),
    ]);
  });

  it("collapses an overnight absence to a compact labelled gap", () => {
    const timeline = build([
      capture("v1", "Nightfall", start),
      capture("v2", "Nightfall v2", start + 18 * hour),
    ]);

    expect(timeline.breaks).toHaveLength(1);
    expect(timeline.breaks[0]).toEqual(expect.objectContaining({ text: "18 hours" }));
    expect(timeline.rows[1]!.y - timeline.rows[0]!.y).toBeCloseTo(
      TIMELINE_ROW_HEIGHT + (TIMELINE_BREAK_MS / hour) * TIMELINE_PIXELS_PER_HOUR,
    );
    // The label occupies the collapsed gap itself, never the left date gutter
    // of the version above it.
    expect(timeline.breaks[0]!.y).toBeGreaterThan(timeline.rows[0]!.y + TIMELINE_ROW_HEIGHT);
    expect(timeline.breaks[0]!.y).toBeLessThan(timeline.rows[1]!.y);
  });

  it("draws one 3px sitting tick for a Recall-split return, never one tick per capture", () => {
    const timeline = build([
      capture("first-half", "Nightfall", start),
      capture("second-half", "Nightfall", start + 8 * minute),
    ]);

    expect(timeline.rows).toHaveLength(1);
    expect(timeline.sittingTicks).toHaveLength(1);
  });

  it("keeps returns to one version inside its row instead of drawing days of empty rail", () => {
    const timeline = build([
      capture("return-1", "Nightfall", start),
      capture("return-2", "Nightfall", start + 4 * day),
      capture("return-3", "Nightfall", start + 7 * day),
    ]);

    expect(timeline.rows).toHaveLength(1);
    expect(timeline.sittingTicks).toHaveLength(3);
    expect(timeline.height).toBeLessThanOrEqual(TIMELINE_ROW_HEIGHT + 24);
    expect(timeline.breaks).toHaveLength(0);
    expect(Math.max(...timeline.sittingTicks.map((tick) => tick.y))).toBeLessThan(TIMELINE_ROW_HEIGHT);
  });

  it("puts an observed save on the matching version lane despite Windows path spelling", () => {
    const saves: ObservedSave[] = [{
      alsPath: "c:/music/timeline layout/NIGHTFALL.als",
      savedAtMs: start + 2 * minute,
    }];
    const timeline = build([capture("v1", "Nightfall", start)], saves);

    expect(timeline.saveTicks).toEqual([
      expect.objectContaining({ atMs: start + 2 * minute }),
    ]);
  });
});
