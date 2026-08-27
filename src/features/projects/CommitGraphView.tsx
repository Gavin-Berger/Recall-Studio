import { useEffect, useMemo, useRef, useState } from "react";
import "./VersionGraphView.css";
import type { ProjectCommit } from "./projectCommits";
import type { SessionStep } from "./sessionSteps";
import { timelineNodes, withStepCount, type TimelineNode } from "./timelineNodes";
import { layoutTimeline } from "./timelineLayout";
import { collapseGaps } from "./versionGraphLayout";
import { graphGeometry, laneColorVar, NODE_RADIUS } from "./versionGraphGeometry";
import { formatSessionDate } from "../sessionFormat";

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
};

/** Room a selected commit's name needs before it must flip to the other side. */
const LABEL_ROOM = 240;

/** Rounded to the unit a producer would actually say out loud. */
function describeGap(durationMs: number): string {
  const days = Math.round(durationMs / 86_400_000);
  if (days >= 60) return `${Math.round(days / 30)} months`;
  if (days >= 14) return `${Math.round(days / 7)} weeks`;
  if (days >= 7) return "1 week";
  return `${days} days`;
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
  const changes =
    node.changes === 1 ? "1 recorded change" : `${node.changes.toLocaleString()} recorded changes`;
  const steps =
    node.kind === "session" && node.stepCount !== null && node.stepCount > 0
      ? `\n${node.stepCount} ${node.stepCount === 1 ? "step" : "steps"}`
      : "";
  return `${node.label}\n${changes} over ${describeDuration(node)}${steps}`;
}

export function CommitGraphView({
  commits,
  openSessionId,
  openSteps,
  onSelectSession,
}: CommitGraphViewProps) {
  const frameRef = useRef<HTMLDivElement | null>(null);
  const [containerWidth, setContainerWidth] = useState(900);

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
    // Ends go into the scale too. Measuring the axis on starts alone leaves a
    // long stretch of work running past the right edge of the graph it was
    // scaled against.
    const scale = collapseGaps(
      built.placements.flatMap((placement) =>
        placement.endAtMs === undefined
          ? [placement.atMs]
          : [placement.atMs, placement.endAtMs],
      ),
    );
    return { geometry: graphGeometry(built, scale, { containerWidth }), layout: built };
  }, [nodes, containerWidth]);

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

  const anyInferred = geometry.edges.some((edge) => edge.inferred);

  return (
    <div className="vg" ref={frameRef}>
      <div className="vg__scroll">
        <svg
          className="vg__canvas"
          width={geometry.width}
          height={geometry.height}
          viewBox={`0 0 ${geometry.width} ${geometry.height}`}
          role="group"
          aria-label="Project history"
        >
          {geometry.breaks.map((brk) => (
            <g key={`break-${brk.x}`} className="vg__break" aria-hidden="true">
              <line x1={brk.x} y1={0} x2={brk.x} y2={geometry.axisY - 14} />
              <text x={brk.x + 6} y={geometry.axisY}>
                {describeGap(brk.durationMs)}
              </text>
            </g>
          ))}

          {/* The axis is dated at the start of every stretch the scale kept at
              full width — which is exactly where a collapsed gap has just
              jumped the reader forward and they need telling again. */}
          {geometry.axis.map((tick) => (
            <text
              key={`axis-${tick.x}`}
              className="vg__axis"
              x={tick.x}
              y={geometry.axisY}
              aria-hidden="true"
            >
              {formatSessionDate(tick.atMs)}
            </text>
          ))}

          {geometry.lanes.map((lane) => (
            <line
              key={`lane-${lane.index}`}
              className={`vg__lane${lane.depth === 0 ? " vg__lane--trunk" : ""}`}
              x1={lane.x1}
              y1={lane.y}
              x2={lane.x2}
              y2={lane.y}
              style={{ stroke: laneColorVar(lane.depth) }}
            />
          ))}

          {/* How long each stretch of work ran. Drawn under the nodes so a dot
              is never obscured by its own bar. A duration too small to see is
              widened to the node's diameter and marked, so "brief" never reads
              as "absent" and the width never claims to be to scale. */}
          {geometry.spans.map((span) => (
            <line
              key={`span-${span.nodeId}`}
              className={`vg__span${span.clamped ? " vg__span--brief" : ""}`}
              x1={span.x1}
              y1={span.y}
              x2={span.x2}
              y2={span.y}
              style={{ stroke: laneColorVar(span.depth) }}
              aria-hidden="true"
            />
          ))}

          {geometry.edges.map((edge) => {
            const child = geometry.nodes.find((node) => node.id === edge.toId);
            return (
              <path
                key={`${edge.fromId}->${edge.toId}`}
                className={`vg__edge${edge.inferred ? " vg__edge--inferred" : ""}${
                  child?.depth === 0 ? " vg__edge--trunk" : ""
                }`}
                d={edge.d}
                fill="none"
                style={{ stroke: laneColorVar(child?.depth ?? 0) }}
              />
            );
          })}

          {geometry.nodes.map((position) => {
            const node = byId.get(position.id);
            if (!node) return null;
            const open = node.sessionId === openSessionId;
            // Only the node you are on is named. Labelling every one is
            // impossible once they cluster — the room collapses to zero and
            // most names vanish, leaving one arbitrary label that reads as if
            // that node were special. The list below names them all; the
            // graph's job is the shape and where you are in it.
            const label =
              open && node.kind === "session"
                ? `${node.label} · ${describeDuration(node)}`
                : null;

            return (
              <g
                key={node.id}
                className={`vg__node${open ? " vg__node--selected" : ""}${
                  node.live ? " vg__node--live" : ""
                }${node.kind === "step" ? " vg__node--step" : ""}`}
                role="button"
                tabIndex={0}
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
                onClick={() => onSelectSession(node.sessionId)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" && event.key !== " ") return;
                  event.preventDefault();
                  onSelectSession(node.sessionId);
                }}
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
                {label ? (
                  <text
                    className="vg__label vg__label--selected"
                    x={
                      position.x > geometry.width - LABEL_ROOM
                        ? position.x - NODE_RADIUS - 4
                        : position.x + NODE_RADIUS + 4
                    }
                    y={position.y - 14}
                    textAnchor={
                      position.x > geometry.width - LABEL_ROOM ? "end" : "start"
                    }
                  >
                    {label}
                  </text>
                ) : null}
              </g>
            );
          })}

        </svg>
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
