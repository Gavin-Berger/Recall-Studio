import { useEffect, useMemo, useState } from "react";
import "./ProjectHistoryScreen.css";
import type { SavedProject } from "../../types/recall";
import { formatSessionDate, formatSessionDuration } from "../sessionFormat";
import { formatClock } from "../../components/schema/timeline/format";
import { CommitGraphView } from "./CommitGraphView";
import { laneColorVar } from "./versionGraphGeometry";
import {
  elbowPath,
  landingSessionId,
  laneX,
  projectHistory,
  RAIL_COL,
  RAIL_NODE_Y,
  RAIL_ROW_H,
  railShape,
  type HistoryRow,
  type RailShape,
} from "./projectHistory";
import type { ProjectArtifact } from "./projectCommits";

// The Timeline: one project's history, as commits.
//
// The project is the repository. A captured stretch of work is a commit. The
// `.als` a commit was made against is a label on it, not the identity of the
// graph — see projectCommits.ts for why that inversion mattered.
//
// Two views of one model: the overview draws time, the list draws structure and
// detail, and both come from `projectHistory` so they cannot disagree.

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

/**
 * The rail for one row: the lanes running past it, the elbow to its parent, and
 * its own node.
 *
 * The elbow is what makes this read as git rather than as a list with a stripe
 * down the side. Without it two lanes simply start existing beside each other
 * and nothing on screen says the branch came from anywhere.
 */
function Rail({ row, index, shape }: { row: HistoryRow; index: number; shape: RailShape }) {
  const width = shape.columns * RAIL_COL;
  const elbow = elbowPath(row);

  return (
    <svg
      className="ph-rail"
      width={width}
      height={RAIL_ROW_H}
      viewBox={`0 0 ${width} ${RAIL_ROW_H}`}
      aria-hidden="true"
    >
      {row.railLanes.map((lane) => {
        const x = laneX(lane);
        // Newest-first, so "up" the page is later in time. A lane's line starts
        // at its own newest commit and ends at its oldest; in between it runs
        // the full row height, including past rows on other lanes.
        const top = shape.headRow.get(lane) === index ? RAIL_NODE_Y : 0;
        const bottom = shape.tailRow.get(lane) === index ? RAIL_NODE_Y : RAIL_ROW_H;
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

      {elbow && (
        <path
          className={`ph-rail__elbow${row.commit.inferred ? " ph-rail__elbow--inferred" : ""}`}
          d={elbow}
          fill="none"
          style={{ stroke: laneColorVar(row.depth) }}
        />
      )}

      <circle
        className={`ph-rail__node${row.live ? " ph-rail__node--live" : ""}`}
        cx={laneX(row.lane)}
        cy={RAIL_NODE_Y}
        r={5}
        style={{ fill: laneColorVar(row.depth), stroke: laneColorVar(row.depth) }}
      />
    </svg>
  );
}

function CommitRow({
  row,
  index,
  shape,
  selected,
  nowMs,
  onSelect,
  onOpenReport,
  onOpenWorkspace,
}: {
  row: HistoryRow;
  index: number;
  shape: RailShape;
  selected: boolean;
  nowMs: number;
  onSelect: () => void;
  onOpenReport: () => void;
  onOpenWorkspace: () => void;
}) {
  const { commit } = row;

  return (
    <li className={`ph-row${selected ? " is-selected" : ""}`}>
      <button
        type="button"
        className="ph-row__hit"
        onClick={onSelect}
        aria-current={selected ? "true" : undefined}
      >
        <Rail row={row} index={index} shape={shape} />

        <span className="ph-row__body">
          <span className="ph-row__top">
            <span className="ph-row__name">
              {commit.changes.toLocaleString()} recorded{" "}
              {commit.changes === 1 ? "change" : "changes"}
            </span>
            {commit.setName && <span className="ph-ref ph-ref--set">{commit.setName}</span>}
            {row.live && <span className="ph-ref ph-ref--live">capturing</span>}
            {row.latest && !row.live && <span className="ph-ref ph-ref--latest">latest</span>}
            {row.branchPoint && <span className="ph-ref">branched here</span>}
            {row.depth > 0 && <span className="ph-ref ph-ref--quiet">branch</span>}
          </span>

          {/* Why this commit hangs where it does, in the producer's language,
              naming the evidence actually used and admitting when it guessed. */}
          <span className="ph-row__why">{commit.reason}</span>

          <span className="ph-row__meta">
            <span>{formatSessionDate(commit.atMs)}</span>
            <span aria-hidden="true">·</span>
            <span>{formatClock(commit.atMs)}</span>
            <span aria-hidden="true">·</span>
            <span>{formatSessionDuration(commit.session)}</span>
            {commit.creativeChanges > 0 && (
              <>
                <span aria-hidden="true">·</span>
                <span>{commit.creativeChanges.toLocaleString()} creative</span>
              </>
            )}
            <span aria-hidden="true">·</span>
            <time dateTime={new Date(commit.endedAtMs).toISOString()}>
              {relativeTime(commit.endedAtMs, nowMs)}
            </time>
          </span>
        </span>
      </button>

      <span className="ph-row__actions">
        <button type="button" className="px-btn" onClick={onOpenReport}>
          Report
        </button>
        <button type="button" className="px-btn" onClick={onOpenWorkspace}>
          Workspace
        </button>
      </span>
    </li>
  );
}

/** Sets found on disk that Recall never watched. Shown, and shown as unlinked. */
function Artifacts({ artifacts }: { artifacts: ProjectArtifact[] }) {
  return (
    <section className="ph__artifacts" aria-label="Files found on disk">
      <h2 className="ph__artifacts-head">
        {artifacts.length} {artifacts.length === 1 ? "file" : "files"} found on disk
      </h2>
      <p className="ph__artifacts-note">
        Recall was not running when these were made, so it has nothing to say about where
        they came from or what changed in them. They are not part of the history above.
      </p>
      <ul className="ph__artifact-list">
        {artifacts.map((artifact) => (
          <li key={artifact.id}>
            <span className="ph__artifact-name">{artifact.setName ?? "Untitled set"}</span>
            <span className="ph__artifact-meta">
              last modified {formatSessionDate(artifact.atMs)}
            </span>
          </li>
        ))}
      </ul>
    </section>
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
  const [selectedCommitId, setSelectedCommitId] = useState<string | null>(null);

  const project = useMemo(
    () => projects.find((candidate) => candidate.id === projectId) ?? projects[0] ?? null,
    [projects, projectId],
  );

  const history = useMemo(() => projectHistory(project?.captures ?? []), [project]);
  const { rows, artifacts, emptyCheckpoints } = history;
  const shape = useMemo(() => railShape(rows), [rows]);
  const commits = useMemo(() => rows.map((row) => row.commit), [rows]);

  // Captured once per project rather than per row, so every "3d ago" on screen
  // is measured from the same instant.
  const nowMs = useMemo(() => Date.now(), [project?.id, rows.length]);

  useEffect(() => {
    setSelectedCommitId(rows[0]?.commit.id ?? null);
  }, [project?.id, rows.length]);

  const selectedRow = rows.find((row) => row.commit.id === selectedCommitId) ?? rows[0] ?? null;
  const branches = new Set(rows.filter((row) => row.depth > 0).map((row) => row.lane)).size;

  if (projects.length === 0) {
    return (
      <div className="ph ph--empty">
        <strong>No projects yet.</strong>
        <p>
          A project is the repository and every stretch of captured work is a point in its
          history. Create one and open it in Ableton with Recall running.
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
            {rows.length} {rows.length === 1 ? "commit" : "commits"}
            {branches > 0 && ` · ${branches} ${branches === 1 ? "branch" : "branches"}`}
            {emptyCheckpoints > 0 && ` · ${emptyCheckpoints} empty`}
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

      <section className="ph__graph" aria-label="Project history">
        <CommitGraphView
          commits={commits}
          selectedCommitId={selectedRow?.commit.id ?? null}
          onSelectCommit={(commitId) => setSelectedCommitId(commitId)}
        />
      </section>

      {rows.length > 0 && (
        <section className="ph__list" aria-label="Commits">
          <ol className="ph-rows">
            {rows.map((row, index) => (
              <CommitRow
                key={row.commit.id}
                row={row}
                index={index}
                shape={shape}
                nowMs={nowMs}
                selected={row.commit.id === selectedRow?.commit.id}
                onSelect={() => setSelectedCommitId(row.commit.id)}
                onOpenReport={() => onOpenReport(landingSessionId(row))}
                onOpenWorkspace={() => onOpenWorkspace(landingSessionId(row))}
              />
            ))}
          </ol>
        </section>
      )}

      {artifacts.length > 0 && <Artifacts artifacts={artifacts} />}
    </div>
  );
}
