import { useEffect, useMemo, useRef, useState } from "react";
import "./VersionGraphView.css";
import type { ProjectCommit } from "./projectCommits";
import type { SessionStep } from "./sessionSteps";
import { timelineNodes, withStepCount, type TimelineNode } from "./timelineNodes";
import { layoutTimeline } from "./timelineLayout";
import { mapKeyAction } from "./mapKeys";
import { laneColorVar, NODE_RADIUS } from "./versionGraphGeometry";

// The overview: the project's commits drawn against real elapsed time.
//
// Built from the same `layoutCommits` the list uses, so the two surfaces cannot
// disagree about lanes, parentage or which commits fork. Pixels come from
// `graphGeometry`, unchanged — that module is about time and space, not about
// what a node means, and it was already right when the model beneath it was
// wrong.

type CommitGraphViewProps = {
  commits: ProjectCommit[];
  /** The session whose steps are drawn; every other session stays one node. */
  openSessionId: string | null;
  /** That session's steps, empty while they are still being read. */
  openSteps: SessionStep[];
  onSelectSession: (sessionId: string) => void;
  /** A narrow map beside the selected work, rather than a full-width overview. */
  variant?: "full" | "sidebar";
};

type GraphSizing = {
  minWidth: number;
  maxWidth: number;
  labelGutter: number;
  labelRun: number;
};

type PanState = {
  pointerId: number;
  startX: number;
  startY: number;
  startScrollLeft: number;
  startScrollTop: number;
};

type VerticalNode = {
  id: string;
  x: number;
  y: number;
  depth: number;
  labelX: number;
};

type VerticalGraph = {
  width: number;
  height: number;
  nodes: VerticalNode[];
  edges: { fromId: string; toId: string; d: string; inferred: boolean; depth: number }[];
};

const GRAPH_TOP = 28;
const GRAPH_BOTTOM = 34;
const GRAPH_LEFT = 36;
const LANE_GAP = 30;
// Leave the graph a clearly separate side rail. The records start far enough
// away that the eye reads line first, then information — instead of a small
// icon glued to the first word of each row.
const FULL_GRAPH: GraphSizing = {
  minWidth: 760,
  maxWidth: 1_120,
  labelGutter: 116,
  labelRun: 700,
};

const SIDEBAR_GRAPH: GraphSizing = {
  minWidth: 320,
  maxWidth: 520,
  labelGutter: 42,
  labelRun: 280,
};

/**
 * A git-style history is read down the page: the latest work stays at the top,
 * branches keep their own vertical rail, and a merge is a single deliberate
 * elbow. Time is stated in the accompanying row rather than suggested by the
 * distance between points, so a week away never looks like a quiet afternoon.
 */
function verticalGraph(
  layout: ReturnType<typeof layoutTimeline>,
  nodes: TimelineNode[],
  containerWidth: number,
  zoom: number,
  sizing: GraphSizing,
): VerticalGraph {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const drawnLanes = [...layout.lanes].sort((a, b) => a.index - b.index);
  const depthOf = new Map(drawnLanes.map((lane) => [lane.index, lane.depth]));
  // Folded lanes retain their original ids. Remap the lanes that remain so an
  // older hidden branch cannot leave a phantom empty column in the tree.
  const columnOf = new Map(drawnLanes.map((lane, index) => [lane.index, index]));
  // A row has room for a named stretch plus its supporting facts. It never
  // collapses into a field of dots merely because the producer zooms out.
  const rowHeight = Math.max(64, Math.round(72 * zoom));
  const visible = layout.placements
    .map((placement) => ({ placement, node: byId.get(placement.nodeId) }))
    .filter((entry): entry is { placement: (typeof layout.placements)[number]; node: TimelineNode } => Boolean(entry.node))
    .sort((a, b) => b.node.atMs - a.node.atMs || b.node.endMs - a.node.endMs || a.node.id.localeCompare(b.node.id));
  const laneCount = Math.max(drawnLanes.length, 1);
  const labelX = GRAPH_LEFT + (laneCount - 1) * LANE_GAP + sizing.labelGutter;
  const boundedWidth = Math.min(sizing.maxWidth, containerWidth);
  const width = Math.max(boundedWidth, labelX + sizing.labelRun);
  const positions = new Map<string, VerticalNode>();

  visible.forEach(({ placement }, index) => {
    positions.set(placement.nodeId, {
      id: placement.nodeId,
      x: GRAPH_LEFT + (columnOf.get(placement.lane) ?? 0) * LANE_GAP,
      y: GRAPH_TOP + index * rowHeight,
      depth: depthOf.get(placement.lane) ?? 0,
      labelX,
    });
  });

  const positioned = visible
    .map(({ placement }) => positions.get(placement.nodeId))
    .filter((position): position is VerticalNode => Boolean(position));
  const height = Math.max(132, GRAPH_TOP + Math.max(0, positioned.length - 1) * rowHeight + GRAPH_BOTTOM);

  const edges = layout.edges.flatMap((edge) => {
    const parent = positions.get(edge.fromId);
    const child = positions.get(edge.toId);
    if (!parent || !child) return [];
    const d = parent.x === child.x
      ? `M ${child.x} ${child.y} V ${parent.y}`
      : `M ${child.x} ${child.y} H ${parent.x} V ${parent.y}`;
    return [{
      fromId: edge.fromId,
      toId: edge.toId,
      d,
      inferred: edge.inferred,
      depth: child.depth,
    }];
  });

  return { width, height, nodes: positioned, edges };
}

/** How long the work ran, in the unit a producer would say. */
function describeDuration(node: { atMs: number; endMs: number }): string {
  const ms = Math.max(0, node.endMs - node.atMs);
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

/**
 * The hover readout for one node.
 *
 * A collapsed session says how many steps are inside it, which is the fact that
 * tells you whether opening it is worth doing. A step says what it was.
 */
function nodeTitle(node: TimelineNode): string {
  // This is the unfiltered event-log count. Calling it a "change" made the
  // map contradict the report, which deliberately curates that log into a
  // smaller set of meaningful work changes.
  const events =
    node.changes === 1 ? "1 captured event" : `${node.changes.toLocaleString()} captured events`;
  const steps =
    node.kind === "session" && node.stepCount !== null && node.stepCount > 0
      ? `\n${node.stepCount} ${node.stepCount === 1 ? "step" : "steps"}`
      : "";
  return `${node.label}\n${events} over ${describeDuration(node)}${steps}`;
}

export function CommitGraphView({
  commits,
  openSessionId,
  openSteps,
  onSelectSession,
  variant = "full",
}: CommitGraphViewProps) {
  const frameRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const panRef = useRef<PanState | null>(null);
  const [containerWidth, setContainerWidth] = useState(900);
  const [zoom, setZoom] = useState(1);
  const [isPanning, setIsPanning] = useState(false);
  // The one point the map's single tab stop lands on. Every point being its own
  // stop made crossing a map of thirty steps thirty presses (§9).
  const [focusedNodeId, setFocusedNodeId] = useState<string | null>(null);

  useEffect(() => {
    const frame = frameRef.current;
    // jsdom and older webviews have no ResizeObserver. The graph still draws at
    // the fallback width; it just will not re-fit on resize.
    if (!frame || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      const width = entry?.contentRect.width ?? 0;
      if (width > 0) setContainerWidth(width);
    });
    observer.observe(frame);
    return () => observer.disconnect();
  }, []);

  const nodes = useMemo(() => {
    const built = timelineNodes(commits, openSessionId, openSteps);
    return openSessionId && openSteps.length > 0
      ? built
      : withStepCount(built, openSessionId ?? "", openSteps.length);
  }, [commits, openSessionId, openSteps]);

  const { geometry, layout } = useMemo(() => {
    const built = layoutTimeline(nodes);
    const sizing = variant === "sidebar" ? SIDEBAR_GRAPH : FULL_GRAPH;
    return {
      geometry: verticalGraph(built, nodes, Math.max(sizing.minWidth, containerWidth), zoom, sizing),
      layout: built,
    };
  }, [nodes, containerWidth, zoom, variant]);

  const byId = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  if (commits.length === 0) {
    return (
      <div className="vg vg--empty">
        <p className="vg__empty-title">Nothing captured yet</p>
        <p className="vg__empty-body">
          Open this project in Ableton with Recall running. Every stretch of work you do
          lands here, in the order it happened.
        </p>
      </div>
    );
  }

  // Latest work is at the top, so keyboard travel matches the visual order:
  // right/down move back through history; left/up move toward the present.
  const inViewOrder = [...geometry.nodes].sort((a, b) => a.y - b.y);
  const focusedIndex = inViewOrder.findIndex((node) => node.id === focusedNodeId);

  const anyInferred = geometry.edges.some((edge) => edge.inferred);
  const zoomPercent = Math.round(zoom * 100);

  function updateZoom(next: number) {
    setZoom(Math.min(2, Math.max(0.6, Math.round(next * 10) / 10)));
  }

  function resetView() {
    setZoom(1);
    requestAnimationFrame(() => {
      if (!scrollRef.current) return;
      scrollRef.current.scrollLeft = 0;
      scrollRef.current.scrollTop = 0;
    });
  }

  function startPan(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    const target = event.target as Element;
    // A point is an action, not a drag handle. Starting on the drawing around
    // it is how the whole map moves without ever stealing a point click.
    if (target.closest(".vg__node, .vg__record")) return;
    const viewport = scrollRef.current;
    if (!viewport) return;
    panRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startScrollLeft: viewport.scrollLeft,
      startScrollTop: viewport.scrollTop,
    };
    viewport.setPointerCapture?.(event.pointerId);
    setIsPanning(true);
  }

  function movePan(event: React.PointerEvent<HTMLDivElement>) {
    const pan = panRef.current;
    const viewport = scrollRef.current;
    if (!pan || !viewport || pan.pointerId !== event.pointerId) return;
    viewport.scrollLeft = pan.startScrollLeft + pan.startX - event.clientX;
    viewport.scrollTop = pan.startScrollTop + pan.startY - event.clientY;
  }

  function endPan(event: React.PointerEvent<HTMLDivElement>) {
    const pan = panRef.current;
    if (!pan || pan.pointerId !== event.pointerId) return;
    scrollRef.current?.releasePointerCapture?.(event.pointerId);
    panRef.current = null;
    setIsPanning(false);
  }

  return (
    <div className={`vg vg--history-tree vg--history-tree--${variant}`} ref={frameRef}>
      <div className="vg__controls" role="group" aria-label="Map controls">
        <span className="vg__controls-label">Scale</span>
        <button
          type="button"
          className="vg__control"
          aria-label="Zoom out"
          onClick={() => updateZoom(zoom - 0.1)}
          disabled={zoom <= 0.6}
        >
          <span aria-hidden="true">−</span>
        </button>
        <input
          className="vg__zoom"
          type="range"
          min="0.6"
          max="2"
          step="0.1"
          value={zoom}
          aria-label="Timeline scale"
          aria-valuetext={`${zoomPercent}%`}
          onChange={(event) => updateZoom(Number(event.target.value))}
        />
        <output className="vg__zoom-value" aria-live="polite">
          {zoomPercent}%
        </output>
        <button
          type="button"
          className="vg__control"
          aria-label="Zoom in"
          onClick={() => updateZoom(zoom + 0.1)}
          disabled={zoom >= 2}
        >
          <span aria-hidden="true">+</span>
        </button>
        <button type="button" className="vg__control vg__control--fit" onClick={resetView}>
          Fit
        </button>
      </div>

      <div
        ref={scrollRef}
        className={`vg__scroll${isPanning ? " is-panning" : ""}`}
        onPointerDown={startPan}
        onPointerMove={movePan}
        onPointerUp={endPan}
        onPointerCancel={endPan}
        onWheel={(event) => {
          // This is a map rather than page content: the wheel changes the
          // reading scale directly. Panning remains click-drag so a producer
          // can inspect a dense branch without losing their place.
          event.preventDefault();
          updateZoom(zoom + (event.deltaY < 0 ? 0.1 : -0.1));
        }}
        tabIndex={0}
        onKeyDown={(event) => {
          const action = mapKeyAction(event, {
            index: focusedIndex,
            count: inViewOrder.length,
          });
          if (action.kind === "none") return;
          event.preventDefault();
          if (action.kind === "zoomIn") return updateZoom(zoom + 0.1);
          if (action.kind === "zoomOut") return updateZoom(zoom - 0.1);
          if (action.kind === "fit") return resetView();

          const target = inViewOrder[action.index];
          if (!target) return;
          if (action.kind === "open") {
            const node = byId.get(target.id);
            if (node) onSelectSession(node.sessionId);
            return;
          }
          setFocusedNodeId(target.id);
          // Bring the selected stretch into view. Guarded because jsdom has no
          // scrollIntoView and older webviews may not either — moving focus is
          // the part that matters.
          const drawn = scrollRef.current?.querySelector<HTMLElement>(
            `[data-map-node="${target.id}"]`,
          );
          if (drawn && typeof drawn.scrollIntoView === "function") {
            drawn.scrollIntoView({ block: "nearest", inline: "nearest" });
          }
        }}
        aria-label="Project map. Arrow keys move between stretches of work; up and left move toward recent work, while down and right move back through history. Enter opens one; plus and minus change the scale; and 0 fits it. Drag empty space to pan; scroll to zoom."
      >
        <div className="vg__stage">
          <svg
            className="vg__canvas"
            width={geometry.width}
            height={geometry.height}
            viewBox={`0 0 ${geometry.width} ${geometry.height}`}
            role="group"
            aria-label="Project history"
          >
          {geometry.edges.map((edge) => {
            return (
              <path
                key={`${edge.fromId}->${edge.toId}`}
                className={`vg__edge${edge.inferred ? " vg__edge--inferred" : ""}${edge.depth === 0 ? " vg__edge--trunk" : ""}`}
                d={edge.d}
                fill="none"
                style={{ stroke: laneColorVar(edge.depth) }}
              />
            );
          })}

          {geometry.nodes.map((position) => {
            const node = byId.get(position.id);
            if (!node) return null;
            const open = node.sessionId === openSessionId;

            return (
              <g
                key={node.id}
                className={`vg__node${open ? " vg__node--selected" : ""}${
                  node.live ? " vg__node--live" : ""
                }${node.kind === "step" ? " vg__node--step" : ""}${
                  node.id === focusedNodeId ? " vg__node--focused" : ""
                }`}
                aria-hidden="true"
                onClick={() => onSelectSession(node.sessionId)}
              >
                <title>{nodeTitle(node)}</title>
                {/* A 7px dot is well under the 24px pointer target in §9, so the
                    hit area is widened without changing what is drawn. */}
                <circle className="vg__hit" cx={position.x} cy={position.y} r={14} />
                <circle
                  className="vg__dot"
                  cx={position.x}
                  cy={position.y}
                  // A step inside an open session draws smaller than the
                  // sessions around it: they are different KINDS of thing, and
                  // the same size would say they were peers.
                  r={node.kind === "step" ? NODE_RADIUS - 2 : NODE_RADIUS}
                  style={{
                    fill: laneColorVar(position.depth),
                    stroke: laneColorVar(position.depth),
                  }}
                />
              </g>
            );
          })}

          </svg>
          <div className="vg__records" aria-label="Stretches of work">
            {geometry.nodes.map((position) => {
              const node = byId.get(position.id);
              if (!node) return null;
              const open = node.sessionId === openSessionId;
              const events = node.changes === 1
                ? "1 captured event"
                : `${node.changes.toLocaleString()} captured events`;

              return (
                <button
                  key={node.id}
                  type="button"
                  className={`vg__record${open ? " is-selected" : ""}${
                    node.live ? " is-live" : ""
                  }${node.kind === "step" ? " is-step" : ""}${
                    node.id === focusedNodeId ? " is-focused" : ""
                  }`}
                  data-map-node={node.id}
                  // The map is one tab stop. These real HTML buttons make the
                  // information column usable by assistive tech without
                  // adding a stop for every stretch as you tab through it.
                  tabIndex={-1}
                  aria-label={
                    node.kind === "step"
                      ? `${node.label}, part of the session you have open`
                      : `${node.label}. ${
                          node.stepCount === null
                            ? "A stretch of work"
                            : `${node.stepCount} steps`
                        }`
                  }
                  aria-pressed={open}
                  style={{ top: `${position.y}px`, left: `${position.labelX}px` }}
                  onClick={() => onSelectSession(node.sessionId)}
                  onKeyDown={(event) => event.stopPropagation()}
                >
                  <strong className="vg__record-title" title={node.label}>
                    {node.label || "Unsaved set"}
                  </strong>
                  <span className="vg__record-meta">
                    <span>{describeDuration(node)}</span>
                    <span aria-hidden="true">·</span>
                    <span>{events}</span>
                    {node.kind === "session" && node.stepCount !== null && node.stepCount > 0 && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span>{node.stepCount} {node.stepCount === 1 ? "step" : "steps"}</span>
                      </>
                    )}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {layout.foldedLanes.length > 0 && (
        <p className="vg__legend">
          <span className="vg__legend-swatch vg__legend-swatch--folded" aria-hidden="true" />
          {layout.foldedNodeIds.length}{" "}
          {layout.foldedNodeIds.length === 1 ? "stretch" : "stretches"} of older work on{" "}
          {layout.foldedLanes.length}{" "}
          {layout.foldedLanes.length === 1 ? "line" : "lines"} you have left behind are not
          drawn. Six lines is as many as this stays readable at.
        </p>
      )}

      {anyInferred ? (
        <p className="vg__legend">
          <span className="vg__legend-swatch" aria-hidden="true" />
          Dashed links are inferred from what Recall had open, not from a save it watched.
        </p>
      ) : null}
    </div>
  );
}
