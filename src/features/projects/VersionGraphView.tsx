import { useEffect, useMemo, useRef, useState } from "react";
import "./VersionGraphView.css";
import type { ProjectVersion } from "./projectVersions";
import { versionGraph, type VersionNode } from "./versionGraph";
import { collapseGaps, layoutVersionGraph } from "./versionGraphLayout";
import { fitLabel, graphGeometry, laneColorVar, NODE_RADIUS } from "./versionGraphGeometry";

// The version graph: a project's `.als` files drawn as the lineage they are,
// rather than the list they were. Structure only — which file came from which,
// when it was worked on, and where the song forked. What HAPPENED inside a
// version is the Report's job; this surface hands off to it and stays quiet.

type VersionGraphViewProps = {
  versions: ProjectVersion[];
  selectedVersionId: string | null;
  onSelectVersion: (versionId: string) => void;
};

/** Rounded to the unit a producer would actually say out loud. */
function describeGap(durationMs: number): string {
  const days = Math.round(durationMs / 86_400_000);
  if (days >= 60) return `${Math.round(days / 30)} months`;
  if (days >= 14) return `${Math.round(days / 7)} weeks`;
  if (days >= 7) return "1 week";
  return `${days} days`;
}

function nodeTitle(node: VersionNode): string {
  const sittings = node.version.sessions.length;
  const worked = sittings === 1 ? "1 sitting" : `${sittings} sittings`;
  const captured =
    node.version.eventCount > 0
      ? `${node.version.eventCount} recorded moves across ${worked}`
      : "nothing recorded — Recall was not running";
  return `${node.version.name}\n${captured}\n${node.reason}`;
}

export function VersionGraphView({
  versions,
  selectedVersionId,
  onSelectVersion,
}: VersionGraphViewProps) {
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

  const { nodes, geometry } = useMemo(() => {
    const graph = versionGraph(versions);
    const layout = layoutVersionGraph(graph);
    const scale = collapseGaps(
      layout.placements.flatMap((placement) => [placement.atMs, ...placement.sittingsMs]),
    );
    return { nodes: graph, geometry: graphGeometry(layout, scale, { containerWidth }) };
  }, [versions, containerWidth]);

  const nodeById = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);

  if (versions.length === 0) {
    return (
      <div className="vg vg--empty">
        <p className="vg__empty-title">No versions yet</p>
        <p className="vg__empty-body">
          Open a set in Live, or connect this project&rsquo;s folder to pick up the
          <code> .als </code>files already in it.
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
          aria-label="Version lineage"
        >
          {geometry.breaks.map((brk) => (
            <g key={`break-${brk.x}`} className="vg__break" aria-hidden="true">
              <line x1={brk.x} y1={0} x2={brk.x} y2={geometry.height} />
              <text x={brk.x + 6} y={geometry.height - 6}>
                {describeGap(brk.durationMs)}
              </text>
            </g>
          ))}

          {geometry.lanes.map((lane) => (
            <line
              key={`lane-${lane.index}`}
              className={`vg__lane${lane.depth === 0 ? " vg__lane--trunk" : ""}`}
              x1={lane.x1}
              y1={lane.y}
              x2={lane.x2}
              y2={lane.y}
              // A presentation attribute cannot hold a var(), so every token
              // reaches the SVG through style or a class instead.
              style={{ stroke: laneColorVar(lane.depth) }}
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

          {geometry.sittings.map((tick) => (
            <line
              key={`${tick.nodeId}-${tick.x}`}
              className="vg__sitting"
              x1={tick.x}
              y1={tick.y - 4}
              x2={tick.x}
              y2={tick.y + 4}
              aria-hidden="true"
            />
          ))}

          {geometry.nodes.map((position) => {
            const node = nodeById.get(position.id);
            if (!node) return null;
            const selected = node.id === selectedVersionId;
            // A version Recall never captured is drawn hollow: the file is real,
            // the work inside it is not something we can claim to know (§7).
            const captured = node.version.eventCount > 0;
            const label = fitLabel(node.version.name, position.labelMaxPx);

            return (
              <g
                key={node.id}
                className={`vg__node${selected ? " vg__node--selected" : ""}${
                  node.version.live ? " vg__node--live" : ""
                }`}
                role="button"
                tabIndex={0}
                aria-label={`${node.version.name}. ${node.reason}`}
                aria-pressed={selected}
                onClick={() => onSelectVersion(node.id)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" && event.key !== " ") return;
                  event.preventDefault();
                  onSelectVersion(node.id);
                }}
              >
                <title>{nodeTitle(node)}</title>
                {/* A 7px dot is well under the 24px pointer target in §9, so the
                    hit area is widened without changing what is drawn. */}
                <circle className="vg__hit" cx={position.x} cy={position.y} r={14} />
                <circle
                  className={`vg__dot${captured ? "" : " vg__dot--hollow"}`}
                  cx={position.x}
                  cy={position.y}
                  // CSS sets `r` from --radius-node where the engine supports
                  // it; this attribute is the fallback so the dot is never
                  // invisible if it does not.
                  r={NODE_RADIUS}
                  style={{
                    fill: captured ? laneColorVar(position.depth) : "none",
                    stroke: laneColorVar(position.depth),
                  }}
                />
                {label ? (
                  // Left-anchored at the dot's left edge (see the CSS note):
                  // the label runs rightwards into the gap measured by
                  // labelMaxPx, so it can never overhang the canvas.
                  <text
                    className="vg__label"
                    x={position.x - NODE_RADIUS}
                    y={position.y - 16}
                  >
                    {label}
                  </text>
                ) : null}
              </g>
            );
          })}
        </svg>
      </div>

      {anyInferred ? (
        <p className="vg__legend">
          <span className="vg__legend-swatch" aria-hidden="true" />
          Dashed links are guessed from file names. Recall did not watch these saves happen.
        </p>
      ) : null}
    </div>
  );
}
