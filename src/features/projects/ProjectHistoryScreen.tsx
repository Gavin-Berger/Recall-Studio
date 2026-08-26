import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./ProjectHistoryScreen.css";
import type { SavedProject } from "../../types/recall";
import { formatSessionDate, formatSessionDuration } from "../sessionFormat";
import { formatClock } from "../../components/schema/timeline/format";
import { CommitGraphView } from "./CommitGraphView";
import { laneColorVar } from "./versionGraphGeometry";
import {
  elbowPath,
  groupByDay,
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
import { historyKeyAction } from "./historyKeys";
import {
  getNoteEdits,
  getParameterChanges,
  getTimelineClipEvents,
} from "../../lib/schema/api";
import { commitHeadline, summarizeCommit, type CommitContents } from "./commitContents";

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

type ContentsState =
  | { status: "loading" }
  | { status: "ready"; contents: CommitContents }
  | { status: "error" };

/**
 * What a commit contains, shown for the one that is selected.
 *
 * Loaded lazily and only for the selection: a project with sixty commits would
 * otherwise fire sixty round trips to render a list nobody has read yet.
 */
function Contents({ state }: { state: ContentsState }) {
  if (state.status === "loading") {
    return <p className="ph-contents__quiet">Reading what changed…</p>;
  }
  if (state.status === "error") {
    return <p className="ph-contents__quiet">Couldn&rsquo;t read what changed in this one.</p>;
  }
  const { contents } = state;
  if (contents.empty) {
    return (
      <p className="ph-contents__quiet">
        Recall recorded work here but has no breakdown for it — the detail predates the
        projection, or the capture only saw counts.
      </p>
    );
  }

  type Group = {
    title: string;
    total: number;
    rows: { key: string; label: string; context: string | null; changes?: number }[];
    /** Everything was touched once, so there is nothing worth naming. */
    spread: boolean;
  };

  const groups: Group[] = [
    { title: "Tracks", total: contents.totals.tracks, rows: contents.tracks, spread: contents.evenlySpread.tracks },
    { title: "Devices", total: contents.totals.devices, rows: contents.devices, spread: contents.evenlySpread.devices },
    { title: "Parameters", total: contents.totals.parameters, rows: contents.parameters, spread: contents.evenlySpread.parameters },
    { title: "Notes", total: contents.totals.notes, rows: contents.notes, spread: false },
    { title: "Added", total: contents.totals.added, rows: contents.added, spread: false },
  ].filter((group) => group.rows.length > 0 || group.total > 0);

  return (
    <div className="ph-contents">
      {groups.map((group) => (
        <section key={group.title} className="ph-contents__group">
          <h3 className="ph-contents__head">
            {group.title}
            <span className="ph-contents__count">{group.total}</span>
          </h3>
          {group.rows.length > 0 ? (
            <ul className="ph-contents__list">
              {group.rows.map((row) => (
                <li key={row.key}>
                  <span className="ph-contents__label">{row.label}</span>
                  {row.context && <span className="ph-contents__ctx">{row.context}</span>}
                  {typeof row.changes === "number" && (
                    <span className="ph-contents__n">{row.changes.toLocaleString()}</span>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            // Nothing stood out. Naming five at random would read as a finding
            // when it is really the shape of a plugin's parameter list.
            <p className="ph-contents__even">
              {group.spread ? "each touched once" : "nothing recorded"}
            </p>
          )}
          {group.rows.length > 0 && group.total > group.rows.length && (
            <p className="ph-contents__more">
              +{group.total - group.rows.length} more
            </p>
          )}
        </section>
      ))}
    </div>
  );
}

/**
 * A day heading that the rail runs straight through.
 *
 * GitHub groups commits by day and can get away with a plain heading because it
 * draws no graph beside them. Here a heading with no rail would cut every lane
 * in half at each date, so the divider draws the pass-through lines of the row
 * BELOW it — the lanes alive at that point — with no node of its own.
 */
function DayDivider({
  label,
  lanes,
  shape,
}: {
  label: string;
  lanes: number[];
  shape: RailShape;
}) {
  return (
    <li className="ph-day">
      <svg
        className="ph-rail ph-rail--pass"
        width={shape.columns * RAIL_COL}
        height={28}
        viewBox={`0 0 ${shape.columns * RAIL_COL} 28`}
        aria-hidden="true"
      >
        {lanes.map((lane) => (
          <line
            key={lane}
            className="ph-rail__line"
            x1={laneX(lane)}
            y1={0}
            x2={laneX(lane)}
            y2={28}
            style={{ stroke: laneColorVar(shape.depthOf.get(lane) ?? 0) }}
          />
        ))}
      </svg>
      <h2 className="ph-day__label">{label}</h2>
    </li>
  );
}

function CommitRow({
  row,
  index,
  shape,
  selected,
  nowMs,
  contents,
  onSelect,
  onOpenReport,
  onOpenWorkspace,
}: {
  row: HistoryRow;
  index: number;
  shape: RailShape;
  selected: boolean;
  nowMs: number;
  contents: ContentsState | null;
  onSelect: () => void;
  onOpenReport: () => void;
  onOpenWorkspace: () => void;
}) {
  const { commit } = row;
  const headline =
    contents?.status === "ready" ? commitHeadline(contents.contents) : null;

  return (
    <li className={`ph-row${selected ? " is-selected" : ""}`}>
      <button
        type="button"
        className="ph-row__hit"
        onClick={onSelect}
        aria-current={selected ? "true" : undefined}
        // Roving tabindex: the list is one stop on the tab order, not one per
        // commit. A month of work would otherwise cost sixty tab presses to
        // step over.
        tabIndex={selected ? 0 : -1}
        data-commit-row={selected ? "selected" : undefined}
      >
        <Rail row={row} index={index} shape={shape} />

        <span className="ph-row__body">
          <span className="ph-row__top">
            {/* The commit "message": derived from what the work actually
                concentrated on, never invented. The breakdown only loads for
                the selected row, so everything else shows its size instead —
                which is why the count lives here and not in the meta line
                below, where it would render twice on the selected row. */}
            <span className="ph-row__name">
              {headline ??
                `${commit.changes.toLocaleString()} recorded ${
                  commit.changes === 1 ? "change" : "changes"
                }`}
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
            {/* The date lives on the day heading above; repeating it on every
                row under it is noise. */}
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

          {selected && contents && <Contents state={contents} />}
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
  // Set only by a keyboard move, so arriving on the surface or clicking a row
  // never yanks focus somewhere the user did not ask for.
  const [moveFocus, setMoveFocus] = useState(false);
  // Cached by session id so re-selecting a commit does not refetch. The ref
  // guards against duplicate fetches when an effect re-runs before state lands.
  const [contents, setContents] = useState<Record<string, ContentsState>>({});
  const requested = useRef(new Set<string>());

  const project = useMemo(
    () => projects.find((candidate) => candidate.id === projectId) ?? projects[0] ?? null,
    [projects, projectId],
  );

  const history = useMemo(() => projectHistory(project?.captures ?? []), [project]);
  const { rows, artifacts, emptyCheckpoints } = history;
  const shape = useMemo(() => railShape(rows), [rows]);
  const days = useMemo(() => groupByDay(rows), [rows]);
  const commits = useMemo(() => rows.map((row) => row.commit), [rows]);

  // Captured once per project rather than per row, so every "3d ago" on screen
  // is measured from the same instant.
  const nowMs = useMemo(() => Date.now(), [project?.id, rows.length]);

  useEffect(() => {
    setSelectedCommitId(rows[0]?.commit.id ?? null);
  }, [project?.id, rows.length]);

  const loadContents = useCallback((sessionId: string) => {
    if (requested.current.has(sessionId)) return;
    requested.current.add(sessionId);
    setContents((current) => ({ ...current, [sessionId]: { status: "loading" } }));
    void (async () => {
      try {
        const [changes, notes, clips] = await Promise.all([
          getParameterChanges(sessionId),
          getNoteEdits(sessionId),
          getTimelineClipEvents(sessionId),
        ]);
        setContents((current) => ({
          ...current,
          [sessionId]: { status: "ready", contents: summarizeCommit(changes, notes, clips) },
        }));
      } catch {
        setContents((current) => ({ ...current, [sessionId]: { status: "error" } }));
      }
    })();
  }, []);

  const selectedRow = rows.find((row) => row.commit.id === selectedCommitId) ?? rows[0] ?? null;

  useEffect(() => {
    if (selectedRow) loadContents(selectedRow.commit.id);
  }, [selectedRow, loadContents]);

  useEffect(() => {
    if (!moveFocus) return;
    setMoveFocus(false);
    const target = document.querySelector<HTMLElement>('[data-commit-row="selected"]');
    target?.focus();
    // `block: "nearest"` keeps a step from scrolling the whole page when the
    // next row is already on screen. Guarded because jsdom has no
    // scrollIntoView and older webviews may not either — focus is the part
    // that matters, scrolling is the courtesy.
    if (typeof target?.scrollIntoView === "function") {
      target.scrollIntoView({ block: "nearest" });
    }
  }, [moveFocus, selectedCommitId]);
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
          {/* A shortcut nobody knows about is not a feature. Stated once, in
              the quietest type on the surface, next to what it acts on. */}
          {rows.length > 1 && (
            <p className="ph__keys">
              <kbd>↑</kbd>
              <kbd>↓</kbd> move · <kbd>p</kbd> parent · <kbd>↵</kbd> report ·{" "}
              <kbd>⇧↵</kbd> workspace
            </p>
          )}
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
        <section
          className="ph__list"
          aria-label="Commits"
          onKeyDown={(event) => {
            const index = rows.findIndex((row) => row.commit.id === selectedRow?.commit.id);
            const action = historyKeyAction(event, {
              index,
              count: rows.length,
              parentRows: rows.map((row) => row.parentRow),
            });
            if (action.kind === "none") return;
            event.preventDefault();
            const target = rows[action.index];
            if (!target) return;
            if (action.kind === "select") {
              setSelectedCommitId(target.commit.id);
              // Follow the selection with focus, or the next key would be
              // resolved against a row the user can no longer see.
              setMoveFocus(true);
            } else if (action.kind === "openReport") {
              onOpenReport(landingSessionId(target));
            } else {
              onOpenWorkspace(landingSessionId(target));
            }
          }}
        >
          <ol className="ph-rows">
            {days.map((day) => (
              <li key={day.key} className="ph-day-group">
                <ol className="ph-rows">
                  <DayDivider
                    label={formatSessionDate(day.atMs)}
                    // The lanes alive at the first row under this heading are
                    // the ones that must keep running through it.
                    lanes={day.entries[0]?.row.railLanes ?? []}
                    shape={shape}
                  />
                  {day.entries.map(({ row, index }) => (
                    <CommitRow
                      key={row.commit.id}
                      row={row}
                      index={index}
                      shape={shape}
                      nowMs={nowMs}
                      contents={contents[row.commit.id] ?? null}
                      selected={row.commit.id === selectedRow?.commit.id}
                      onSelect={() => setSelectedCommitId(row.commit.id)}
                      onOpenReport={() => onOpenReport(landingSessionId(row))}
                      onOpenWorkspace={() => onOpenWorkspace(landingSessionId(row))}
                    />
                  ))}
                </ol>
              </li>
            ))}
          </ol>
        </section>
      )}

      {artifacts.length > 0 && <Artifacts artifacts={artifacts} />}
    </div>
  );
}
