// The vertical Timeline's measurement layer.
//
// A version graph needs two independent coordinates: a lane says which line of
// descent a file belongs to; the vertical coordinate says when versions began.
// Keeping that second calculation out of the React surface makes it testable
// and, more importantly, prevents a tempting regression back to evenly spaced
// rows whenever a label needs more room.

import { sittings } from "./sittings";
import { normalizeAlsPath } from "./projectVersions";
import { describeBreak } from "./versionGraphGeometry";
import { collapseGaps, type GraphLayout } from "./versionGraphLayout";
import type { ObservedSave, VersionNode } from "./versionGraph";

/** Closed version record: its label plus its one-line work stretch. */
export const TIMELINE_ROW_HEIGHT = 120;
export const TIMELINE_NODE_OFFSET = 22;
export const TIMELINE_PIXELS_PER_HOUR = 16;

const HOUR_MS = 60 * 60 * 1000;
/** An overnight return is meaningful, but not useful as hundreds of blank pixels. */
export const TIMELINE_IDLE_GAP_MS = 12 * HOUR_MS;
/** Keep one compact, labelled measure of a collapsed absence on the graph. */
export const TIMELINE_BREAK_MS = 2 * HOUR_MS;

export type TimelineRow = {
  nodeId: string;
  /** The version point's centre in SVG/row pixels. */
  y: number;
  /** Space held by this record before the next version record. */
  height: number;
};

export type SittingTick = { nodeId: string; atMs: number; y: number };
export type SaveTick = { nodeId: string; atMs: number; y: number };

export type VersionTimelineLayout = {
  rows: TimelineRow[];
  sittingTicks: SittingTick[];
  saveTicks: SaveTick[];
  breaks: { y: number; durationMs: number; text: string }[];
  axis: { y: number; atMs: number }[];
  height: number;
};

function isForVersion(save: ObservedSave, node: VersionNode): boolean {
  const savePath = normalizeAlsPath(save.alsPath);
  return savePath !== null && savePath === normalizeAlsPath(node.version.alsPath);
}

/**
 * Place file records on a compact version-time scale. Long gaps between files
 * are collapsed and named. Returns and saves stay as marks inside their owning
 * record: they describe work within a version and must never stretch the graph
 * into days of empty rail.
 */
export function layoutVersionTimeline(
  nodes: VersionNode[],
  graph: GraphLayout,
  saves: ObservedSave[],
): VersionTimelineLayout {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const placements = graph.placements
    .map((placement) => ({ placement, node: byId.get(placement.nodeId) }))
    .filter((entry): entry is { placement: GraphLayout["placements"][number]; node: VersionNode } =>
      Boolean(entry.node),
    )
    .sort((left, right) =>
      left.node.version.startedAtMs - right.node.version.startedAtMs ||
      left.node.id.localeCompare(right.node.id),
    );

  // The graph's vertical scale is a VERSION scale. Returns and saves belong to
  // their version and are drawn as compact marks inside its record below. If
  // their absolute dates enter this scale, one file reopened for a week turns
  // into a week of empty rail and pushes the actual retrace below the fold.
  const scale = collapseGaps(
    placements.map(({ node }) => node.version.startedAtMs),
    { gapMs: TIMELINE_IDLE_GAP_MS, breakMs: TIMELINE_BREAK_MS },
  );

  const rawY = (atMs: number) =>
    TIMELINE_NODE_OFFSET + (scale.project(atMs) / HOUR_MS) * TIMELINE_PIXELS_PER_HOUR;

  // Labels need a physical home even when two files appeared within a minute.
  // This is a record-layout constraint, not a second time scale: after each
  // record's reserved space, every working stretch follows the same linear
  // pixels-per-hour measurement. The accumulated offset is applied to every
  // later tick, so the lane and its HTML record keep agreeing.
  const shifts: { atMs: number; before: number; after: number }[] = [];
  // Every row is the same height now that the graph carries versions only.
  const minimumHeight = () => TIMELINE_ROW_HEIGHT;
  let offset = 0;
  const rows = placements.map(({ node }) => {
    const naturalY = rawY(node.version.startedAtMs);
    const y = naturalY + offset;
    const height = minimumHeight();
    shifts.push({ atMs: node.version.startedAtMs, before: offset, after: offset + height });
    offset += height;
    return { nodeId: node.id, y, height };
  });

  const yOf = (atMs: number) => {
    let activeOffset = 0;
    for (const shift of shifts) {
      if (shift.atMs > atMs) break;
      // A sitting starting at the exact instant a file first appears belongs
      // to that point. Everything after it begins below the readable record.
      activeOffset = shift.atMs === atMs ? shift.before : shift.after;
    }
    return rawY(atMs) + activeOffset;
  };

  rows.forEach((row, index) => {
    const next = rows[index + 1];
    if (next) row.height = Math.max(row.height, next.y - row.y);
  });

  const rowById = new Map(rows.map((row) => [row.nodeId, row]));
  const sittingTicks: SittingTick[] = [];
  const saveTicks: SaveTick[] = [];

  placements.forEach(({ node }) => {
    const row = rowById.get(node.id);
    if (!row) return;
    const sittingMarks = sittings(node.version.sessions).sittings.map((sitting, index) => ({
      kind: "sitting" as const,
      atMs: sitting.startMs,
      key: index,
    }));
    const saveMarks = saves
      .filter((save) => isForVersion(save, node))
      .map((save, index) => ({ kind: "save" as const, atMs: save.savedAtMs, key: index }));
    const marks = [...sittingMarks, ...saveMarks]
      .sort((left, right) => left.atMs - right.atMs || left.kind.localeCompare(right.kind));
    const markSpan = Math.min(58, Math.max(12, row.height - 52));

    marks.forEach((mark, index) => {
      // The first mark clears the version node; the last remains in the readable
      // header portion even when an expanded work trail makes the row taller.
      const fraction = marks.length === 1 ? 0 : index / (marks.length - 1);
      const y = row.y + 12 + fraction * markSpan;
      if (mark.kind === "sitting") {
        sittingTicks.push({ nodeId: node.id, atMs: mark.atMs, y });
      } else {
        saveTicks.push({ nodeId: node.id, atMs: mark.atMs, y });
      }
    });
  });

  const graphBottom = Math.max(
    ...rows.map((row) => row.y + row.height),
    ...sittingTicks.map((tick) => tick.y + TIMELINE_NODE_OFFSET),
    ...saveTicks.map((tick) => tick.y + TIMELINE_NODE_OFFSET),
    TIMELINE_ROW_HEIGHT,
  );

  return {
    rows,
    sittingTicks,
    saveTicks,
    breaks: scale.gaps.map((gap) => ({
      // A collapsed absence belongs between its two version records. Rendering
      // it at the prior version's node puts its label in the same left gutter
      // as that version's date, so "4 days" and "Aug 11" read as one broken
      // timestamp. Reserve the centre of the fixed break below the closed row.
      y: yOf(gap.startMs) + TIMELINE_ROW_HEIGHT +
        (TIMELINE_BREAK_MS / HOUR_MS) * TIMELINE_PIXELS_PER_HOUR / 2,
      durationMs: gap.durationMs,
      text: describeBreak(gap.durationMs),
    })),
    axis: scale.segments.map((segment) => ({ y: yOf(segment.startMs), atMs: segment.startMs })),
    height: graphBottom,
  };
}
