import { useEffect, useMemo, useState } from "react";
import "./ProjectHistoryScreen.css";
import type { SavedProject } from "../../types/recall";
import { formatSessionDate } from "../sessionFormat";
import { projectVersions } from "./projectVersions";
import { VersionGraphView } from "./VersionGraphView";
import { laneColorVar } from "./versionGraphGeometry";
import {
  landingSessionId,
  railShape,
  versionHistoryRows,
  type HistoryRow,
  type RailShape,
} from "./projectHistory";

// The project's history: the shape on top, the detail underneath.
//
// This surface used to be the per-capture workspace — one session, its events
// on a ruler. That is a zoom level, not a home. Opening a song and being shown
// a single sitting is like opening a repository and landing inside one commit's
// diff: it answers a question you have not asked yet.
//
// So the Timeline is now the thing a producer actually opens a project to see —
// every `.als` version, how they descend from each other, and where the song
// forked. The workspace still exists and is one click away from any row; it is
// just no longer the front door.

type ProjectHistoryScreenProps = {
  projects: SavedProject[];
  projectId: string | null;
  onSelectProject: (projectId: string) => void;
  onOpenReport: (sessionId: string) => void;
  onOpenWorkspace: (sessionId: string) => void;
  onOpenProjects: () => void;
};

/** How long ago, in the unit a producer would say out loud. */
function relativeTime(atMs: number, nowMs: number): string {
  const ms = Math.max(0, nowMs - atMs);
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  if (days < 60) return `${Math.round(days / 7)}w ago`;
  const months = Math.round(days / 30);
  if (months < 24) return `${months}mo ago`;
  return `${Math.round(days / 365)}y ago`;
}

/** Horizontal pitch between lane columns, and the row's drawn height. */
const RAIL_COL = 14;
const RAIL_ROW_H = 78;

function Rail({ row, index, shape }: { row: HistoryRow; index: number; shape: RailShape }) {
  const width = shape.columns * RAIL_COL;
  const cx = row.lane * RAIL_COL + RAIL_COL / 2;
  const cy = 22;
  const captured = row.moves > 0;

  return (
    <svg
      className="ph-rail"
      width={width}
      height={RAIL_ROW_H}
      viewBox={`0 0 ${width} ${RAIL_ROW_H}`}
      aria-hidden="true"
    >
      {row.railLanes.map((lane) => {
        const x = lane * RAIL_COL + RAIL_COL / 2;
        // The list runs newest-first, so "up" the page is later in time. A
        // lane's line starts at its own newest version and ends at its oldest;
        // in between it runs the full height, including past rows belonging to
        // other lanes, which is what keeps a branch visibly open.
        const top = shape.headRow.get(lane) === index ? cy : 0;
        const bottom = shape.tailRow.get(lane) === index ? cy : RAIL_ROW_H;
        if (top >= bottom) return null;
        return (
          <line
            key={lane}
            className="ph-rail__line"
            x1={x}
            y1={top}
            x2={x}
            y2={bottom}
            style={{ stroke: laneColorVar(shape.depthOf.get(lane) ?? 0) }}
          />
        );
      })}

      <circle
        className={`ph-rail__node${captured ? "" : " ph-rail__node--hollow"}`}
        cx={cx}
        cy={cy}
        r={4.5}
        style={{
          fill: captured ? laneColorVar(row.depth) : "var(--panel)",
          stroke: laneColorVar(row.depth),
        }}
      />
    </svg>
  );
}

function HistoryRowItem({
  row,
  selected,
  nowMs,
  index,
  shape,
  onSelect,
  onOpenReport,
  onOpenWorkspace,
}: {
  row: HistoryRow;
  selected: boolean;
  nowMs: number;
  index: number;
  shape: RailShape;
  onSelect: () => void;
  onOpenReport: () => void;
  onOpenWorkspace: () => void;
}) {
  const captured = row.moves > 0;
  const sessionId = landingSessionId(row);

  return (
    <li className={`ph-row${selected ? " is-selected" : ""}`}>
      <button
        type="button"
        className="ph-row__hit"
        onClick={onSelect}
        aria-current={selected ? "true" : undefined}
      >
        {/* The rail. Every lane alive at this row is drawn as a vertical run,
            so a branch stays visibly open beside the trunk instead of the list
            collapsing into a column of unrelated dots — this is the part that
            makes it read as a git graph. The node repeats the graph's own
            vocabulary: lane colour for position, filled for captured, dashed
            ring for a file Recall never watched (§7). */}
        <Rail row={row} index={index} shape={shape} />

        <span className="ph-row__body">
          <span className="ph-row__top">
            <span className="ph-row__name">{row.node.version.name}</span>
            {row.live && <span className="ph-ref ph-ref--live">live</span>}
            {row.latest && <span className="ph-ref ph-ref--latest">latest</span>}
            {row.branchPoint && <span className="ph-ref">forked here</span>}
            {row.depth > 0 && <span className="ph-ref ph-ref--quiet">branch</span>}
          </span>

          {/* The parentage reason is the most interesting line on the row and
              the one no other surface shows. It says in plain language why this
              version hangs where it does, and admits when it is guessing. */}
          <span className="ph-row__why">{row.node.reason}</span>

          <span className="ph-row__meta">
            <span>
              {row.sittings} {row.sittings === 1 ? "sitting" : "sittings"}
            </span>
            <span aria-hidden="true">·</span>
            <span>
              {captured
                ? `${row.moves.toLocaleString()} recorded ${row.moves === 1 ? "move" : "moves"}`
                : "nothing recorded"}
            </span>
            <span aria-hidden="true">·</span>
            <time dateTime={new Date(row.node.version.lastUpdatedAtMs).toISOString()}>
              {relativeTime(row.node.version.lastUpdatedAtMs, nowMs)}
            </time>
            <span aria-hidden="true">·</span>
            <span className="ph-row__date">
              {formatSessionDate(row.node.version.startedAtMs)}
            </span>
          </span>
        </span>
      </button>

      {sessionId && (
        <span className="ph-row__actions">
          <button type="button" className="px-btn" onClick={onOpenReport}>
            Report
          </button>
          <button type="button" className="px-btn" onClick={onOpenWorkspace}>
            Workspace
          </button>
        </span>
      )}
    </li>
  );
}

export function ProjectHistoryScreen({
  projects,
  projectId,
  onSelectProject,
  onOpenReport,
  onOpenWorkspace,
  onOpenProjects,
}: ProjectHistoryScreenProps) {
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);
  // Captured once per render pass rather than per row, so every "3d ago" on
  // screen is measured from the same instant.
  const nowMs = useMemo(() => Date.now(), [projectId, projects]);

  const project = useMemo(
    () => projects.find((candidate) => candidate.id === projectId) ?? projects[0] ?? null,
    [projects, projectId],
  );

  const versions = useMemo(() => projectVersions(project?.captures ?? []), [project]);
  const rows = useMemo(() => versionHistoryRows(versions), [versions]);
  const shape = useMemo(() => railShape(rows), [rows]);

  // Selecting the newest version on arrival, and again whenever the project
  // changes, so the surface is never showing a graph with nothing chosen.
  useEffect(() => {
    setSelectedVersionId(rows[0]?.node.id ?? null);
  }, [project?.id, rows.length]);

  const selectedRow = rows.find((row) => row.node.id === selectedVersionId) ?? rows[0] ?? null;

  if (projects.length === 0) {
    return (
      <div className="ph ph--empty">
        <strong>No projects yet.</strong>
        <p>
          Recall draws a song&rsquo;s history from the <code>.als</code> files in its folder.
          Create a project and connect its folder to see one.
        </p>
        <button type="button" className="px-btn px-btn--primary" onClick={onOpenProjects}>
          Go to Projects
        </button>
      </div>
    );
  }

  return (
    <div className="ph">
      <header className="ph__bar">
        <div className="ph__title">
          <h1>{project?.display_name ?? "History"}</h1>
          <span className="ph__subtitle">
            {rows.length} {rows.length === 1 ? "version" : "versions"}
            {rows.some((row) => row.depth > 0) && " · branched"}
          </span>
        </div>

        {projects.length > 1 && (
          <label className="ph__picker">
            <span className="ph__picker-label">Project</span>
            <select
              value={project?.id ?? ""}
              onChange={(event) => onSelectProject(event.target.value)}
            >
              {projects.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.display_name}
                </option>
              ))}
            </select>
          </label>
        )}
      </header>

      <section className="ph__graph" aria-label="Version lineage">
        <VersionGraphView
          versions={versions}
          selectedVersionId={selectedRow?.node.id ?? null}
          onSelectVersion={(versionId) => setSelectedVersionId(versionId)}
        />
      </section>

      {rows.length > 0 && (
        <section className="ph__list" aria-label="Version history">
          <ol className="ph-rows">
            {rows.map((row, index) => (
              <HistoryRowItem
                key={row.node.id}
                row={row}
                nowMs={nowMs}
                index={index}
                shape={shape}
                selected={row.node.id === selectedRow?.node.id}
                onSelect={() => setSelectedVersionId(row.node.id)}
                onOpenReport={() => {
                  const sessionId = landingSessionId(row);
                  if (sessionId) onOpenReport(sessionId);
                }}
                onOpenWorkspace={() => {
                  const sessionId = landingSessionId(row);
                  if (sessionId) onOpenWorkspace(sessionId);
                }}
              />
            ))}
          </ol>
        </section>
      )}
    </div>
  );
}
