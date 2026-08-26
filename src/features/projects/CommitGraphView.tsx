import { useEffect, useMemo, useRef, useState } from "react";
import "./VersionGraphView.css";
import { layoutCommits } from "./commitLayout";
import type { ProjectCommit } from "./projectCommits";
import { collapseGaps } from "./versionGraphLayout";
import { fitLabel, graphGeometry, laneColorVar, NODE_RADIUS } from "./versionGraphGeometry";

// The overview: the project's commits drawn against real elapsed time.
//
// Built from the same `layoutCommits` the list uses, so the two surfaces cannot
// disagree about lanes, parentage or which commits fork. Pixels come from
// `graphGeometry`, unchanged — that module is about time and space, not about
// what a node means, and it was already right when the model beneath it was
// wrong.

type CommitGraphViewProps = {
  commits: ProjectCommit[];
  selectedCommitId: string | null;
  onSelectCommit: (commitId: string) => void;
};

/** Rounded to the unit a producer would actually say out loud. */
function describeGap(durationMs: number): string {
  const days = Math.round(durationMs / 86_400_000);
  if (days >= 60) return `${Math.round(days / 30)} months`;
  if (days >= 14) return `${Math.round(days / 7)} weeks`;
  if (days >= 7) return "1 week";
  return `${days} days`;
}

function commitTitle(commit: ProjectCommit): string {
  const changes =
    commit.changes === 1 ? "1 recorded change" : `${commit.changes.toLocaleString()} recorded changes`;
  const set = commit.setName ? `\n${commit.setName}` : "";
  return `${changes}${set}\n${commit.reason}`;
}

export function CommitGraphView({
  commits,
  selectedCommitId,
  onSelectCommit,
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

  const geometry = useMemo(() => {
    const layout = layoutCommits(commits);
    const scale = collapseGaps(layout.placements.map((placement) => placement.atMs));
    return graphGeometry(layout, scale, { containerWidth });
  }, [commits, containerWidth]);

  const byId = useMemo(() => new Map(commits.map((commit) => [commit.id, commit])), [commits]);

  if (commits.length === 0) {
    return (
      <div className="vg vg--empty">
        <p className="vg__empty-title">Nothing captured yet</p>
        <p className="vg__empty-body">
          Open this project in Ableton with Recall running. Every stretch of work becomes a
          point in its history.
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

          {geometry.nodes.map((position) => {
            const commit = byId.get(position.id);
            if (!commit) return null;
            const selected = commit.id === selectedCommitId;
            const label = fitLabel(commit.setName ?? "unsaved set", position.labelMaxPx);

            return (
              <g
                key={commit.id}
                className={`vg__node${selected ? " vg__node--selected" : ""}${
                  commit.live ? " vg__node--live" : ""
                }`}
                role="button"
                tabIndex={0}
                aria-label={`${commit.setName ?? "Unsaved set"}. ${commit.reason}`}
                aria-pressed={selected}
                onClick={() => onSelectCommit(commit.id)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" && event.key !== " ") return;
                  event.preventDefault();
                  onSelectCommit(commit.id);
                }}
              >
                <title>{commitTitle(commit)}</title>
                {/* A 7px dot is well under the 24px pointer target in §9, so the
                    hit area is widened without changing what is drawn. */}
                <circle className="vg__hit" cx={position.x} cy={position.y} r={14} />
                <circle
                  className="vg__dot"
                  cx={position.x}
                  cy={position.y}
                  r={NODE_RADIUS}
                  style={{
                    fill: laneColorVar(position.depth),
                    stroke: laneColorVar(position.depth),
                  }}
                />
                {label ? (
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
          Dashed links are inferred from what Recall had open, not from a save it watched.
        </p>
      ) : null}
    </div>
  );
}
