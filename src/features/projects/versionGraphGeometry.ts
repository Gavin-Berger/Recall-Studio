// From lanes and timestamps to pixels and SVG paths.
//
// Split out of the component so the drawing can be tested without rendering
// anything. A path string is either right or wrong, and asserting on it is
// cheaper and far more precise than screenshotting an SVG.

import type { GraphEdge, GraphLayout, TimeScale } from "./versionGraphLayout";

export type GraphGeometryOptions = {
  /** Width the graph is being drawn into. It may return more; see below. */
  containerWidth: number;
  laneHeight?: number;
  padX?: number;
  padY?: number;
  /** Closest two nodes may sit before the graph widens and scrolls instead. */
  minNodeGap?: number;
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

export type GraphGeometry = {
  width: number;
  height: number;
  nodes: GeometryNode[];
  edges: GeometryEdge[];
  lanes: GeometryLane[];
  sittings: { nodeId: string; x: number; y: number }[];
  breaks: { x: number; durationMs: number }[];
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
/** Advance width of IBM Plex Mono at --t-micro (11px). */
export const MONO_CHAR_PX = 6.6;

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
  const height = padY * 2 + (laneCount - 1) * laneHeight;

  if (layout.placements.length === 0) {
    return { width: options.containerWidth, height, nodes: [], edges: [], lanes: [], sittings: [], breaks: [] };
  }

  // Average spacing has to stay legible, so the graph claims at least enough
  // width to give every node its own room. Past that the container decides.
  const floor = padX * 2 + Math.max(layout.placements.length - 1, 0) * minNodeGap;
  const width = Math.max(options.containerWidth, floor);
  const drawable = Math.max(width - padX * 2, 1);
  const pxPerMs = scale.spanMs > 0 ? drawable / scale.spanMs : 0;

  // Rounded at the source so a node's centre and the endpoint of the edge
  // meeting it are the same number. Sub-pixel drift between them shows up as a
  // hairline poking out from under a node.
  const xOf = (atMs: number) =>
    // A single version, or several at the same instant, has no span to scale
    // against. Centring beats pinning it to the left edge as if it were the
    // start of a history that continues off-screen.
    round(scale.spanMs > 0 ? padX + scale.project(atMs) * pxPerMs : width / 2);
  const yOf = (lane: number) => round(padY + lane * laneHeight);

  const depthOf = new Map(layout.lanes.map((lane) => [lane.index, lane.depth]));

  const placed = layout.placements.map((placement) => ({
    placement,
    x: xOf(placement.atMs),
    y: yOf(placement.lane),
  }));

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

  const breaks = scale.gaps.map((gap) => ({
    // The break sits at the drawn position where the dead air was removed.
    x: xOf(gap.startMs),
    durationMs: gap.durationMs,
  }));

  return { width, height, nodes, edges, lanes, sittings, breaks };
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

/** `--lane-0…3`, cycling past 3 so a deep branch never runs out of steps (§11). */
export function laneColorVar(depth: number): string {
  if (depth <= 0) return "var(--lane-0)";
  return `var(--lane-${((depth - 1) % 3) + 1})`;
}
