// From lanes and timestamps to pixels and SVG paths.
//
// Split out of the component so the drawing can be tested without rendering
// anything. A path string is either right or wrong, and asserting on it is
// cheaper and far more precise than screenshotting an SVG.

import { formatSessionDate } from "../sessionFormat";
import type { GraphEdge, GraphLayout, TimeScale } from "./versionGraphLayout";

export type GraphGeometryOptions = {
  /** Width the graph is being drawn into. It may return more; see below. */
  containerWidth: number;
  laneHeight?: number;
  padX?: number;
  padY?: number;
  /** Average room per node the graph claims before it scrolls instead. */
  minNodeGap?: number;
  /** Hard floor on the distance between two nodes on one lane. */
  minNodeSeparation?: number;
  cornerRadius?: number;
};

export type GeometryNode = {
  id: string;
  x: number;
  y: number;
  lane: number;
  depth: number;
  /** Room the name has before it would run into the next node on this lane. */
  labelMaxPx: number;
};

export type GeometryEdge = {
  fromId: string;
  toId: string;
  /** SVG path data. Orthogonal, one rounded corner, never a bezier (§11). */
  d: string;
  inferred: boolean;
};

export type GeometryLane = { index: number; depth: number; y: number; x1: number; x2: number };

/**
 * How long a node's work ran, drawn along the axis it belongs to.
 *
 * A commit has a start and an end, and drawing it as a bare point threw away
 * the most legible thing a time axis can carry: that one stretch ran seven
 * hours and the next ran thirty seconds. This is NOT §11's banned
 * scale-by-event-count — area is not standing in for importance. The bar is
 * the axis reporting elapsed time, the same fact the x position already
 * reports, extended to the other end of the work.
 */
export type GeometrySpan = {
  nodeId: string;
  x1: number;
  x2: number;
  y: number;
  depth: number;
  /** True when the real duration was too small to see and was widened. */
  clamped: boolean;
};

export type GraphGeometry = {
  width: number;
  height: number;
  nodes: GeometryNode[];
  edges: GeometryEdge[];
  lanes: GeometryLane[];
  spans: GeometrySpan[];
  sittings: { nodeId: string; x: number; y: number }[];
  /**
   * A collapsed stretch of dead air, and the words that own the spot.
   *
   * `x` is the dashed rule; `textX` is where its label starts. The label is
   * built here rather than in the component because the axis below has to know
   * how much room it takes up before deciding whether it can speak too.
   */
  breaks: { x: number; textX: number; durationMs: number; text: string }[];
  /**
   * Where each stretch of real time begins, for dating the axis.
   *
   * One tick per segment the scale kept at full width — which is exactly the
   * set of moments where the reader needs to be told the date again, because a
   * collapsed gap has just jumped them forward.
   */
  axis: { x: number; atMs: number; text: string }[];
  /** Baseline the axis labels sit on. */
  axisY: number;
};

export const LANE_HEIGHT = 56;
export const PAD_X = 32;
export const PAD_Y = 28;
export const MIN_NODE_GAP = 72;
export const CORNER_RADIUS = 6;
/** Mirrors --radius-node (DESIGN.md §11); the SVG needs it as a number too. */
export const NODE_RADIUS = 7;
/** Clear space kept between a name and the next node on the same lane. */
export const LABEL_GUTTER = 10;
/**
 * The closest two nodes on one lane may be drawn.
 *
 * Time placement alone is not enough. Two versions first captured minutes
 * apart land on the same pixel, and the later dot hides under the earlier one —
 * so a project with two versions draws one node while the header says two.
 * A graph that silently omits a version is a worse lie than one that separates
 * two coincident nodes by a few pixels, and it is the same bounded, deliberate
 * distortion §11 already sanctions for collapsed gaps: the axis bends where it
 * must so the drawing stays true to what exists. Wide enough for a dot plus its
 * selection ring plus air.
 */
export const MIN_NODE_SEPARATION = 26;
/**
 * The narrowest a duration bar may be drawn.
 *
 * A thirty-second commit on a two-week axis is a fraction of a pixel, which
 * rounds to nothing and reads as "no work here". Widening it to the node's own
 * diameter says "brief" rather than "absent" — and the span is marked
 * `clamped` so the surface never implies the bar's width is to scale.
 */
export const MIN_SPAN_PX = 14;
/** Advance width of IBM Plex Mono at --t-micro (11px). */
export const MONO_CHAR_PX = 6.6;
/**
 * The same advance, plus the widest letter-spacing the small labels carry.
 *
 * `.vg__axis` tracks 0.03em, `.vg__label` 0.04em and `.vg__break` 0.08em, so
 * text measured at the bare advance comes out about a character short of what
 * is drawn. Erring wide is the safe direction in both places it is used: it
 * drops a date that would just have cleared a gap label — the more useful of
 * the two anyway — and it trims a name one character before it would clip.
 */
export const TRACKED_CHAR_PX = MONO_CHAR_PX + 11 * 0.08;
/** Air kept between two things speaking on the axis line. */
export const AXIS_LABEL_GUTTER = 12;
/** Where a break's label sits relative to its rule. */
export const BREAK_LABEL_DX = 6;

/**
 * Lay the graph out in pixels.
 *
 * The width returned is a *minimum*, not the container's width. DESIGN.md §8
 * forbids compressing anything that encodes time, so when a project has more
 * versions than fit legibly the graph gets wider and scrolls sideways rather
 * than squeezing them together — a squeezed graph claims events were closer
 * together than they were.
 *
 * Known limit: a folder scan stamps every version it finds with almost the same
 * time, so scanned projects draw as one tight cluster. That is true — Recall
 * genuinely does not know when those files were made — and the honest fix is
 * for the scan to carry file mtimes, not for the graph to spread them out and
 * invent a history.
 */
export function graphGeometry(
  layout: GraphLayout,
  scale: TimeScale,
  options: GraphGeometryOptions,
): GraphGeometry {
  const laneHeight = options.laneHeight ?? LANE_HEIGHT;
  const padX = options.padX ?? PAD_X;
  const padY = options.padY ?? PAD_Y;
  const minNodeGap = options.minNodeGap ?? MIN_NODE_GAP;
  const radius = options.cornerRadius ?? CORNER_RADIUS;

  const laneCount = Math.max(layout.lanes.length, 1);
  /** Room under the last lane for the dated axis. */
  const axisBand = 26;
  const height = padY * 2 + (laneCount - 1) * laneHeight + axisBand;
  const axisY = height - 8;

  if (layout.placements.length === 0) {
    return {
      width: options.containerWidth,
      height,
      nodes: [],
      edges: [],
      lanes: [],
      spans: [],
      sittings: [],
      breaks: [],
      axis: [],
      axisY,
    };
  }

  // Average spacing has to stay legible, so the graph claims at least enough
  // width to give every node its own room. Past that the container decides.
  const floor = padX * 2 + Math.max(layout.placements.length - 1, 0) * minNodeGap;
  const timeWidth = Math.max(options.containerWidth, floor);
  const drawable = Math.max(timeWidth - padX * 2, 1);
  const pxPerMs = scale.spanMs > 0 ? drawable / scale.spanMs : 0;

  // Rounded at the source so a node's centre and the endpoint of the edge
  // meeting it are the same number. Sub-pixel drift between them shows up as a
  // hairline poking out from under a node.
  const xOf = (atMs: number) =>
    // A single version, or several at the same instant, has no span to scale
    // against. Centring beats pinning it to the left edge as if it were the
    // start of a history that continues off-screen.
    round(scale.spanMs > 0 ? padX + scale.project(atMs) * pxPerMs : timeWidth / 2);
  const yOf = (lane: number) => round(padY + lane * laneHeight);

  const depthOf = new Map(layout.lanes.map((lane) => [lane.index, lane.depth]));

  const placed = layout.placements.map((placement) => ({
    placement,
    x: xOf(placement.atMs),
    y: yOf(placement.lane),
  }));

  // Push apart anything that landed on top of something else. Per lane, because
  // two nodes sharing an x on DIFFERENT lanes are on different rows and do not
  // collide. Order is preserved — a node only ever moves later, never earlier,
  // so the graph cannot reverse two versions to make room.
  const separation = options.minNodeSeparation ?? MIN_NODE_SEPARATION;
  for (const lane of layout.lanes) {
    const onLane = placed
      .filter((entry) => entry.placement.lane === lane.index)
      .sort((a, b) => a.x - b.x);
    for (let index = 1; index < onLane.length; index += 1) {
      const previous = onLane[index - 1]!;
      const current = onLane[index]!;
      if (current.x - previous.x < separation) current.x = previous.x + separation;
    }
  }

  // Nudging can push the last node past the width the time span asked for.
  const rightmost = placed.reduce((max, entry) => Math.max(max, entry.x), 0);
  const width = Math.max(timeWidth, rightmost + padX);

  // A name may run until the next version on its own lane. Names on other lanes
  // are on other rows and cannot collide, and the last node on a lane has the
  // rest of the graph to itself.
  const nextOnLane = new Map<string, number>();
  for (const lane of layout.lanes) {
    const onLane = lane.nodeIds
      .map((id) => placed.find((entry) => entry.placement.nodeId === id))
      .filter((entry): entry is (typeof placed)[number] => Boolean(entry))
      .sort((a, b) => a.x - b.x);
    onLane.forEach((entry, index) => {
      const next = onLane[index + 1];
      nextOnLane.set(entry.placement.nodeId, next ? next.x - entry.x : width - entry.x);
    });
  }

  const nodes: GeometryNode[] = placed.map((entry) => ({
    id: entry.placement.nodeId,
    x: entry.x,
    y: entry.y,
    lane: entry.placement.lane,
    depth: depthOf.get(entry.placement.lane) ?? 0,
    labelMaxPx: Math.max(0, (nextOnLane.get(entry.placement.nodeId) ?? width) - LABEL_GUTTER),
  }));

  const spans: GeometrySpan[] = placed
    .filter((entry) => entry.placement.endAtMs !== undefined)
    .map((entry) => {
      const trueEnd = xOf(entry.placement.endAtMs!);
      // The node may have been nudged right to clear a neighbour; the bar
      // starts where the node is drawn, or it would detach from its own dot.
      const x1 = entry.x;
      const x2 = Math.max(trueEnd, x1);
      const clamped = x2 - x1 < MIN_SPAN_PX;
      return {
        nodeId: entry.placement.nodeId,
        x1,
        x2: clamped ? x1 + MIN_SPAN_PX : x2,
        y: entry.y,
        depth: depthOf.get(entry.placement.lane) ?? 0,
        clamped,
      };
    });

  const sittings = layout.placements.flatMap((placement) =>
    placement.sittingsMs.map((atMs) => ({
      nodeId: placement.nodeId,
      x: xOf(atMs),
      y: yOf(placement.lane),
    })),
  );

  const positionOf = new Map(nodes.map((node) => [node.id, node]));

  const lanes: GeometryLane[] = layout.lanes.map((lane) => {
    const onLane = lane.nodeIds.map((id) => positionOf.get(id)!).filter(Boolean);
    const xs = onLane.map((node) => node.x);
    return {
      index: lane.index,
      depth: lane.depth,
      y: yOf(lane.index),
      x1: xs.length > 0 ? Math.min(...xs) : padX,
      x2: xs.length > 0 ? Math.max(...xs) : padX,
    };
  });

  const edges: GeometryEdge[] = layout.edges.map((edge) => ({
    fromId: edge.fromId,
    toId: edge.toId,
    inferred: edge.inferred,
    d: edgePath(edge, positionOf, radius),
  }));

  const breaks = scale.gaps.map((gap) => {
    // The break sits at the drawn position where the dead air was removed.
    const x = xOf(gap.startMs);
    return {
      x,
      textX: x + BREAK_LABEL_DX,
      durationMs: gap.durationMs,
      text: describeBreak(gap.durationMs),
    };
  });

  // A date tick and a gap label land at almost the same x — the break sits
  // where the dead air was removed, and the next segment starts immediately
  // after it — so they overprinted each other ("Aug 11, 20264 days"). The gap
  // label owns that spot because it explains the jump; the date is dropped
  // where one is already speaking.
  //
  // Comparing the two anchors against a fixed clearance was not enough, which
  // is how that exact string survived the first fix: both labels are anchored
  // at their START and run right, so a date whose anchor is a comfortable
  // 125px from a break still prints its last four characters over it. What
  // collides is the ink, so the ink is what gets compared.
  const taken = breaks.map((brk) => extentOf(brk.textX, brk.text));
  const axis: GraphGeometry["axis"] = [];
  for (const segment of scale.segments) {
    const tick = { x: xOf(segment.startMs), atMs: segment.startMs, text: formatSessionDate(segment.startMs) };
    const extent = extentOf(tick.x, tick.text);
    // Against the breaks AND against the dates already kept: two stretches
    // either side of a short collapsed gap can date to the same day and print
    // the same date twice over itself.
    if (taken.some((other) => overlaps(extent, other))) continue;
    taken.push(extent);
    axis.push(tick);
  }

  return { width, height, nodes, edges, lanes, spans, sittings, breaks, axis, axisY };
}

/**
 * One edge: down out of the parent lane, one rounded corner, along the child's.
 *
 * Orthogonal by rule (§11). A bezier between two lanes looks like decoration
 * and stops being traceable the moment three of them cross; a right angle with
 * a single soft corner stays followable at any density.
 */
function edgePath(edge: GraphEdge, positions: Map<string, GeometryNode>, radius: number): string {
  const from = positions.get(edge.fromId);
  const to = positions.get(edge.toId);
  if (!from || !to) return "";

  if (from.y === to.y) return `M ${round(from.x)} ${round(from.y)} H ${round(to.x)}`;

  const down = to.y > from.y ? 1 : -1;
  // The corner cannot be wider than the room between the two nodes, or the
  // curve would overshoot the child and double back.
  const r = Math.max(0, Math.min(radius, Math.abs(to.x - from.x), Math.abs(to.y - from.y)));
  const turnY = to.y - r * down;
  const turnX = from.x + r;

  return [
    `M ${round(from.x)} ${round(from.y)}`,
    `V ${round(turnY)}`,
    `Q ${round(from.x)} ${round(to.y)} ${round(turnX)} ${round(to.y)}`,
    `H ${round(to.x)}`,
  ].join(" ");
}

/** Two decimals is under a tenth of a pixel and keeps paths readable in tests. */
function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Trim a set name to the room it actually has.
 *
 * Producers write long file names (`pers ep nightfall v4 mixdown.als`) and the
 * graph puts them 72px apart, so something has to give. Truncation is the
 * honest option: the full name is still on the node's tooltip and in the
 * Report, and an ellipsis says outright that there is more. Dropping the label
 * entirely, or letting names overlap, both lose the fact that a name exists.
 *
 * Below about three characters there is no legible truncation left, so nothing
 * is drawn — "…" alone tells the producer nothing they cannot see already.
 */
export function fitLabel(name: string, maxPx: number, charPx = MONO_CHAR_PX): string {
  const fits = Math.floor(maxPx / charPx);
  if (name.length <= fits) return name;
  if (fits < 4) return "";
  return `${name.slice(0, fits - 1).trimEnd()}…`;
}

/** Rounded to the unit a producer would actually say out loud. */
export function describeBreak(durationMs: number): string {
  const hours = Math.max(1, Math.round(durationMs / 3_600_000));
  if (hours < 24) return `${hours} ${hours === 1 ? "hour" : "hours"}`;
  const days = Math.round(durationMs / 86_400_000);
  if (days >= 60) {
    const months = Math.round(days / 30);
    return `${months} ${months === 1 ? "month" : "months"}`;
  }
  if (days >= 14) {
    const weeks = Math.round(days / 7);
    return `${weeks} ${weeks === 1 ? "week" : "weeks"}`;
  }
  if (days >= 7) return "1 week";
  return `${days} ${days === 1 ? "day" : "days"}`;
}

/** The horizontal ink a left-anchored mono label occupies, plus its air. */
function extentOf(x: number, text: string): { x1: number; x2: number } {
  return { x1: x, x2: x + text.length * TRACKED_CHAR_PX + AXIS_LABEL_GUTTER };
}

function overlaps(a: { x1: number; x2: number }, b: { x1: number; x2: number }): boolean {
  return a.x1 < b.x2 && b.x1 < a.x2;
}

/** `--lane-0…3`, cycling past 3 so a deep branch never runs out of steps (§11). */
export function laneColorVar(depth: number): string {
  if (depth <= 0) return "var(--lane-0)";
  return `var(--lane-${((depth - 1) % 3) + 1})`;
}
