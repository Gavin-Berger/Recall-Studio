import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LoadingSpinner } from "../../components/LoadingSpinner";
import "./ProjectHistoryScreen.css";
import type { SavedProject } from "../../types/recall";
import { formatSessionDate, formatSessionDuration } from "../sessionFormat";
import { formatClock } from "../../components/schema/timeline/format";
import { CommitGraphView } from "./CommitGraphView";
import { laneColorVar } from "./versionGraphGeometry";
import {
  elbowPath,
  groupByDay,
  historyRows,
  landingSessionId,
  laneX,
  RAIL_COL,
  RAIL_NODE_Y,
  RAIL_ROW_H,
  railShape,
  type HistoryRow,
  type RailShape,
} from "./projectHistory";
import { projectCommits, type ProjectArtifact } from "./projectCommits";
import {
  commitsInSet,
  defaultSetKey,
  projectSets,
  setKeyForCommit,
  type ProjectSet,
} from "./projectSets";
import { historyKeyAction } from "./historyKeys";
import {
  getNoteEdits,
  getParameterChanges,
  getProjectSchema,
  getTimelineClipEvents,
  materializeSessionSchema,
} from "../../lib/schema/api";
import { commitRacks, RACK_CONTENTS_LIMIT, type CommitRack } from "./commitRacks";
import { wayBack, type WayBack } from "./wayBack";
import { WayBackPanel } from "./WayBackPanel";
import {
  describeGap as describeStepGap,
  sessionSteps,
  type SessionStep,
} from "./sessionSteps";
import {
  commitDiff,
  diffHeadline,
  diffLines,
  DIFF_LIMIT,
  type CommitDiff,
} from "./commitDiff";
import { commitHeadline, summarizeCommit, type CommitContents } from "./commitContents";

// The Timeline: one project's history, as commits.
//
// The project is the repository. A captured stretch of work is a commit. The
// `.als` a commit was made against is a label on it, not the identity of the
// graph — see projectCommits.ts for why that inversion mattered.
//
// Two views of one model: the overview draws continuation and branches, the
// list draws the working detail, and both come from the same project history so
// they cannot disagree.

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
  | {
      status: "ready";
      contents: CommitContents;
      racks: CommitRack[];
      diff: CommitDiff;
      steps: SessionStep[];
      /** Where this work lives, and whether the file has moved on since. */
      way: WayBack;
    }
  | { status: "error" };

/**
 * The session's work, in the order it happened.
 *
 * This is the part that used to mean leaving for another screen. A history is
 * only useful if the detail of any step opens where you are standing, so the
 * session opens in place: the summary above says what the work touched, this
 * says what happened.
 */
function Steps({ steps }: { steps: SessionStep[] }) {
  if (steps.length === 0) return null;
  return (
    <section className="ph-steps" aria-label="What happened, in order">
      <h3 className="ph-contents__head">
        Step by step
        <span className="ph-contents__count">{steps.length}</span>
      </h3>
      <ol className="ph-steps__list">
        {steps.map((step) => (
          <li key={step.id} className="ph-step">
            <span className="ph-step__when">
              {formatClock(step.startMs)}
              {step.gapBeforeMs !== null && step.gapBeforeMs > 0 && (
                <span className="ph-step__gap">{describeStepGap(step.gapBeforeMs)}</span>
              )}
            </span>
            <span className="ph-step__body">
              <span className="ph-step__title">
                {step.title}
                {step.kind && <span className="ph-ref ph-ref--quiet">{step.kind}</span>}
              </span>
              {step.tracks.length > 0 && (
                <span className="ph-step__tracks">{step.tracks.join(" · ")}</span>
              )}
              {step.controls.length > 0 && (
                <ul className="ph-step__controls">
                  {step.controls.map((control) => (
                    <li key={control.key}>
                      <span className="ph-contents__label">{control.label}</span>
                      {/* Where it started and where it was left. The landing
                          point is the decision; the count alone cannot tell a
                          nudge from searching the range and committing. */}
                      {control.from && control.to && (
                        <span className="ph-step__move">
                          {control.from} <span aria-hidden="true">&rarr;</span> {control.to}
                        </span>
                      )}
                      {control.track && (
                        <span className="ph-contents__ctx">{control.track}</span>
                      )}
                    </li>
                  ))}
                  {step.moreControls > 0 && (
                    <li className="ph-contents__more">+{step.moreControls} more</li>
                  )}
                </ul>
              )}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

/**
 * What changed in the set since the parent commit.
 *
 * Leads the panel because it is the structural answer — "this is where the
 * second Serum arrived" — and everything below it is the work done inside that
 * structure. Silent for a root, and explicit rather than reassuring when there
 * is no snapshot to compare: "cannot say" and "nothing changed" are different
 * facts and must not look alike.
 */
function Diff({ state }: { state: CommitDiff }) {
  if (state.status === "root") return null;
  if (state.status === "unknown") {
    return (
      <p className="ph-diff__quiet">
        Recall didn&rsquo;t get a look at the set on both sides of this, so it can&rsquo;t
        say what changed.
      </p>
    );
  }
  if (state.status === "unchanged") {
    return <p className="ph-diff__quiet">Same tracks and devices as before.</p>;
  }

  const { lines, total } = diffLines(state.diff);
  return (
    <section className="ph-diff" aria-label="What changed in the set">
      <h3 className="ph-contents__head">
        What changed in the set
        <span className="ph-contents__count">{diffHeadline(state.diff)}</span>
      </h3>
      <ul className="ph-diff__list">
        {lines.map((line) => (
          <li key={line.key} className={line.sign === "+" ? "is-added" : "is-removed"}>
            <span className="ph-diff__sign" aria-hidden="true">
              {line.sign}
            </span>
            <span className="ph-contents__label">{line.label}</span>
            {line.context && <span className="ph-contents__ctx">{line.context}</span>}
          </li>
        ))}
      </ul>
      {total > DIFF_LIMIT && (
        <p className="ph-contents__more">+{total - DIFF_LIMIT} more</p>
      )}
    </section>
  );
}

/**
 * Racks the commit touched, and what is inside them.
 *
 * Set apart from the other groups and labelled, because it is a different KIND
 * of fact. Everything above it is work Recall watched happen; this is
 * structure Recall read from a snapshot. The note says so rather than letting
 * the two read as one list.
 */
function Racks({ racks }: { racks: CommitRack[] }) {
  return (
    <section className="ph-racks" aria-label="Racks on the tracks you worked">
      <h3 className="ph-contents__head">
        Inside the racks
        <span className="ph-contents__count">{racks.length}</span>
      </h3>
      <p className="ph-racks__note">
        Recall reads what a rack contains, but it does not watch the controls
        inside one — moves on these are not captured.
      </p>
      <ul className="ph-racks__list">
        {racks.map((rack) => (
          <li key={rack.key}>
            <span className="ph-racks__name">
              {rack.name}
              {rack.track && <span className="ph-contents__ctx">{rack.track}</span>}
            </span>
            <ul className="ph-racks__inner">
              {rack.contents.map((entry) => (
                <li key={entry.key}>
                  <span className="ph-contents__label">{entry.label}</span>
                  {entry.detail && <span className="ph-contents__ctx">{entry.detail}</span>}
                </li>
              ))}
            </ul>
            {rack.total > RACK_CONTENTS_LIMIT && (
              <p className="ph-contents__more">+{rack.total - RACK_CONTENTS_LIMIT} more</p>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * What a commit contains, shown for the one that is selected.
 *
 * Loaded lazily and only for the selection: a project with sixty commits would
 * otherwise fire sixty round trips to render a list nobody has read yet.
 */
function Contents({ state }: { state: ContentsState }) {
  // Each contents panel owns its expanded tails. This hook stays before the
  // loading/error returns so React sees the same hook order while data lands.
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => new Set());
  if (state.status === "loading") {
    return <p className="ph-contents__quiet px-loading-inline" role="status"><LoadingSpinner />Reading what changed…</p>;
  }
  if (state.status === "error") {
    return <p className="ph-contents__quiet">Couldn&rsquo;t read what changed in this one.</p>;
  }
  const { contents } = state;
  if (contents.empty) {
    return (
      <p className="ph-contents__quiet">
        Recall counted the work here but kept no detail about it, so there is nothing to
        break down.
      </p>
    );
  }

  type GroupRow = { key: string; label: string; context: string | null; changes?: number };
  type Group = {
    id: string;
    title: string;
    total: number;
    rows: GroupRow[];
    allRows: GroupRow[];
    /** Everything was touched once, so there is nothing worth naming. */
    spread: boolean;
  };

  const groups: Group[] = [
    { id: "tracks", title: "Tracks", total: contents.totals.tracks, rows: contents.tracks, allRows: contents.all.tracks, spread: contents.evenlySpread.tracks },
    { id: "devices", title: "Devices", total: contents.totals.devices, rows: contents.devices, allRows: contents.all.devices, spread: contents.evenlySpread.devices },
    { id: "parameters", title: "Parameters", total: contents.totals.parameters, rows: contents.parameters, allRows: contents.all.parameters, spread: contents.evenlySpread.parameters },
    { id: "notes", title: "Notes", total: contents.totals.notes, rows: contents.notes, allRows: contents.all.notes, spread: false },
    { id: "added", title: "Added", total: contents.totals.added, rows: contents.added, allRows: contents.all.added, spread: false },
  ].filter((group) => group.rows.length > 0 || group.total > 0);

  return (
    <>
    <Diff state={state.diff} />
    <div className="ph-contents">
      {groups.map((group) => (
        <section key={group.id} className="ph-contents__group">
          <h3 className="ph-contents__head">
            {group.title}
            <span className="ph-contents__count">{group.total}</span>
          </h3>
          {(() => {
            const expanded = expandedGroups.has(group.id);
            const shownRows = expanded ? group.allRows : group.rows;
            const hidden = Math.max(0, group.allRows.length - group.rows.length);
            return <>
          {shownRows.length > 0 ? (
            <ul className="ph-contents__list">
              {shownRows.map((row) => (
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
          {hidden > 0 && (
            <button
              type="button"
              className="ph-contents__more"
              aria-expanded={expanded}
              onClick={() => {
                setExpandedGroups((current) => {
                  const next = new Set(current);
                  if (next.has(group.id)) next.delete(group.id);
                  else next.add(group.id);
                  return next;
                });
              }}
            >
              {expanded ? "Show fewer" : `+${hidden} more`}
            </button>
          )}
            </>;
          })()}
        </section>
      ))}
      </div>
      {state.racks.length > 0 && <Racks racks={state.racks} />}
    <Steps steps={state.steps} />
    {/* Last, because it is the way OUT. Everything above says what happened;
        this says where it lives and whether going there will show you it. */}
    <WayBackPanel way={state.way} />
    </>
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

/**
 * Which set the list is about.
 *
 * Every set in the project, most recently worked first, so the one a producer
 * is currently in is where this opens. Shown as a row of choices rather than a
 * dropdown because the count beside each name is itself the useful fact —
 * where the work in this project actually went.
 */
function SetPicker({
  sets,
  focused,
  onFocus,
}: {
  sets: ProjectSet[];
  focused: ProjectSet | null;
  onFocus: (key: string) => void;
}) {
  if (sets.length < 2) return null;
  return (
    <nav className="ph-sets" aria-label="Sets in this project">
      {sets.map((set) => {
        const selected = set.key === focused?.key;
        return (
          <button
            key={set.key}
            type="button"
            className={`ph-set${selected ? " is-selected" : ""}`}
            aria-current={selected ? "true" : undefined}
            onClick={() => onFocus(set.key)}
          >
            <span className="ph-set__name">{set.name}</span>
            <span className="ph-set__count">
              {set.sessions} {set.sessions === 1 ? "session" : "sessions"}
            </span>
            {set.live && <span className="ph-ref ph-ref--live">capturing</span>}
          </button>
        );
      })}
    </nav>
  );
}

function CommitRow({
  row,
  index,
  shape,
  selected,
  nowMs,
  contents,
  detailsOpen,
  headline: loadedHeadline,
  showSet,
  onSelect,
  onToggleDetails,
  onOpenReport,
  onOpenWorkspace,
}: {
  row: HistoryRow;
  index: number;
  shape: RailShape;
  selected: boolean;
  nowMs: number;
  contents: ContentsState | null;
  detailsOpen: boolean;
  headline: string | null;
  /** True when this row's set differs from the one the list is about. */
  showSet: boolean;
  onSelect: () => void;
  onToggleDetails: () => void;
  onOpenReport: () => void;
  onOpenWorkspace: () => void;
}) {
  const { commit } = row;
  const headline =
    contents?.status === "ready" ? commitHeadline(contents.contents) : loadedHeadline;

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
          <span className="ph-row__lead">
          <span className="ph-row__top">
            {/* The commit "message": derived from what the work actually
                concentrated on, never invented. The breakdown only loads for
                the selected row, so everything else shows its size instead —
                which is why the count lives here and not in the meta line
                below, where it would render twice on the selected row. */}
            <span className="ph-row__name">
              {headline ?? commit.setName ?? "Unsaved set"}
            </span>
            {/* Only when it differs from the set the list is about.
                The list is narrowed to one set and sits under a heading that
                already names it, so this printed the same chip on every row —
                the same noise the repeated parentage line was, in a different
                shape. Kept as a condition rather than deleted: it earns its
                place again the moment a row can come from somewhere else. */}
            {commit.setName && headline && showSet && (
              <span className="ph-ref ph-ref--set">{commit.setName}</span>
            )}
            {row.live && <span className="ph-ref ph-ref--live">capturing</span>}
            {row.latest && !row.live && <span className="ph-ref ph-ref--latest">latest</span>}
            {row.branchPoint && <span className="ph-ref">went two ways</span>}
            {row.depth > 0 && <span className="ph-ref ph-ref--quiet">other line</span>}
          </span>

          {/* Only when it says something.
              "Picked up X where the earlier session left it" is the DEFAULT —
              it was printed on every row and read as nine identical lines of
              noise burying the rows where the lineage is actually uncertain. A
              guess and a root are worth a sentence; carrying on in the file you
              were already in is not. */}
          {(commit.inferred || commit.parentId === null) && (
            <span className="ph-row__why">{commit.reason}</span>
          )}
          </span>

          <span className="ph-row__meta">
            {/* The date lives on the day heading above; repeating it on every
                row under it is noise. */}
            {/* Each separator belongs to the value BEFORE it, not between the
                two as its own item. A standalone dot is a flex item like any
                other and wraps like one, so a narrow row broke the line after
                it and every second line opened with an orphaned "· 1w ago". */}
            {[
              formatClock(commit.atMs),
              formatSessionDuration(commit.session),
              `${commit.changes.toLocaleString()} ${
                commit.changes === 1 ? "captured event" : "captured events"
              }`,
              ...(commit.creativeChanges > 0
                ? [`${commit.creativeChanges.toLocaleString()} creative events`]
                : []),
            ].map((text, index) => (
              <span key={index}>
                {text}
                <span aria-hidden="true"> ·</span>
              </span>
            ))}
            <time dateTime={new Date(commit.endedAtMs).toISOString()}>
              {relativeTime(commit.endedAtMs, nowMs)}
            </time>
          </span>
        </span>

        {/* Outside the two-column body: the panel is full width, and leaving it
            inside would make it a third column beside the metadata. */}
        {selected && detailsOpen && contents && <Contents state={contents} />}
      </button>

      <span className="ph-row__actions">
        {selected && (
          <button
            type="button"
            className={`px-btn${detailsOpen ? " px-btn--active" : ""}`}
            aria-expanded={detailsOpen}
            onClick={onToggleDetails}
          >
            {detailsOpen ? "Hide details" : "Details"}
          </button>
        )}
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
  const [detailsCommitId, setDetailsCommitId] = useState<string | null>(null);
  // Set only by a keyboard move, so arriving on the surface or clicking a row
  // never yanks focus somewhere the user did not ask for.
  const [moveFocus, setMoveFocus] = useState(false);
  // Cached by session id so re-selecting a commit does not refetch. The ref
  // guards against duplicate fetches when an effect re-runs before state lands.
  const [contents, setContents] = useState<Record<string, ContentsState>>({});
  // Headlines for EVERY row, not just the selected one. A list of "1,014
  // recorded changes / 41 recorded changes / 62 recorded changes" says nothing
  // about the work — the count is the one fact a commit has that is not worth
  // reading. One `getParameterChanges` per row is enough for the headline
  // (tracks and devices come from it); notes, clips, structure and the diff
  // stay lazy because only the open row shows them.
  const [headlines, setHeadlines] = useState<Record<string, string>>({});
  const requested = useRef(new Set<string>());
  const headlined = useRef(new Set<string>());

  const project = useMemo(
    () => projects.find((candidate) => candidate.id === projectId) ?? projects[0] ?? null,
    [projects, projectId],
  );

  // Built once for the whole project. The graph draws all of it — that IS the
  // relationship between the sets — while the list below narrows to one.
  const model = useMemo(() => projectCommits(project?.captures ?? []), [project]);
  const { artifacts, emptyCheckpoints } = model;
  const sets = useMemo(() => projectSets(model.commits), [model]);

  const [focusedSetKey, setFocusedSetKey] = useState<string | null>(null);
  const focusedSet =
    sets.find((candidate) => candidate.key === focusedSetKey) ?? sets[0] ?? null;

  // A producer sits down inside ONE set and makes decisions there. Pouring
  // every set's work into one stream read as one long undifferentiated day.
  const rows = useMemo(
    () => historyRows(commitsInSet(model.commits, focusedSet?.key ?? null)),
    [model, focusedSet],
  );
  const shape = useMemo(() => railShape(rows), [rows]);
  const days = useMemo(() => groupByDay(rows), [rows]);
  const commits = model.commits;

  // Captured once per project rather than per row, so every "3d ago" on screen
  // is measured from the same instant.
  const nowMs = useMemo(() => Date.now(), [project?.id, rows.length]);

  useEffect(() => {
    setFocusedSetKey(defaultSetKey(sets));
  }, [project?.id, sets.length]);

  useEffect(() => {
    // Switching from the set chooser lands on that set's newest work. A point
    // chosen in the project graph, though, must stay the exact point chosen —
    // it is already in the newly focused set.
    setSelectedCommitId((current) =>
      current && rows.some((row) => row.commit.id === current)
        ? current
        : rows[0]?.commit.id ?? null,
    );
  }, [focusedSet?.key, rows]);

  /**
   * The set's structure for one session.
   *
   * Materialized first: the schema is a projection rebuilt from the stored
   * snapshot events, and a session that has never been materialized reports
   * `has_snapshot: false` — which would read as "no structure" when the truth
   * is "not built yet". Failure degrades to null so a missing snapshot costs
   * the rack list and the diff, never the whole panel.
   */
  const structureOf = useCallback(async (sessionId: string) => {
    try {
      await materializeSessionSchema(sessionId);
      return await getProjectSchema(sessionId);
    } catch {
      return null;
    }
  }, []);

  const loadContents = useCallback(
    (sessionId: string, parentSessionId: string | null, startedAtMs: number) => {
    if (requested.current.has(sessionId)) return;
    const selectedCommit = commits.find((commit) => commit.id === sessionId);
    // A row can disappear while its details are loading (for example after a
    // project refresh). Do not attach a file-return promise to unrelated work.
    if (!selectedCommit) return;
    requested.current.add(sessionId);
    setContents((current) => ({ ...current, [sessionId]: { status: "loading" } }));
    void (async () => {
      try {
        const [changes, notes, clips, schema, parentSchema] = await Promise.all([
          getParameterChanges(sessionId),
          getNoteEdits(sessionId),
          getTimelineClipEvents(sessionId),
          structureOf(sessionId),
          // The PARENT's structure, not the row printed underneath: on a fork
          // those differ, and the parent is what actually preceded this state.
          parentSessionId ? structureOf(parentSessionId) : Promise.resolve(null),
        ]);
        const summary = summarizeCommit(changes, notes, clips);
        // Only racks on tracks this commit actually touched. A set can hold
        // dozens; a commit that never went near them should not list them.
        const touched = new Set(
          [
            ...changes.map((change) => change.track_name),
            ...notes.map((note) => note.track_name),
            ...clips.map((clip) => clip.track_name),
          ]
            .map((name) => name?.trim())
            .filter((name): name is string => Boolean(name)),
        );
        setContents((current) => ({
          ...current,
          [sessionId]: {
            status: "ready",
            contents: summary,
            racks: commitRacks(schema?.has_snapshot ? schema : null, touched),
            diff: commitDiff(parentSchema, schema, parentSessionId !== null),
            steps: sessionSteps(changes, notes, clips, startedAtMs),
            // The WHOLE project, not the focused set: "worked since" has to
            // count later sessions the list is currently hiding, or it
            // under-reports how far the file has drifted.
            way: wayBack(selectedCommit, commits),
          },
        }));
      } catch {
        setContents((current) => ({ ...current, [sessionId]: { status: "error" } }));
      }
    })();
    },
    [commits, structureOf],
  );

  /**
   * How many rows get a headline without being opened.
   *
   * Local SQLite, so a call is cheap, but a two-year project can hold hundreds
   * of commits and firing hundreds of queries to fill a list nobody has
   * scrolled to is still wrong. The rows past this keep their change count,
   * which is honest and costs nothing.
   */
  const HEADLINE_BUDGET = 40;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      for (const row of rows.slice(0, HEADLINE_BUDGET)) {
        if (cancelled) return;
        const id = row.commit.id;
        if (headlined.current.has(id)) continue;
        try {
          const changes = await getParameterChanges(id);
          // Marked done only once there is an answer. Marking it before the
          // await left the row that happened to be in flight when this effect
          // was torn down — switching set, a capture landing — permanently
          // blacklisted: the walk restarted, skipped it as already handled, and
          // it kept its set name as a title forever while the rows either side
          // of it described themselves. Three of the eight rows in one library
          // read that way, which looked like three sessions that did nothing.
          if (cancelled) return;
          headlined.current.add(id);
          const line = commitHeadline(summarizeCommit(changes, [], []));
          setHeadlines((current) => ({ ...current, [id]: line }));
        } catch {
          // A failure IS an answer: the row keeps its change count, and asking
          // again on every re-render would spin.
          headlined.current.add(id);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [rows]);

  const selectedRow = rows.find((row) => row.commit.id === selectedCommitId) ?? rows[0] ?? null;
  // The open session's detail, which the graph needs so it can draw that
  // session as its steps instead of one node.
  const selectedContents = selectedRow ? contents[selectedRow.commit.id] ?? null : null;

  // The right column is an information pane, not a second empty index. Open
  // the newest selected session on arrival so its facts earn the desktop
  // space. The producer can still close it with "Hide details"; this runs
  // again only when they choose a different session.
  useEffect(() => {
    setDetailsCommitId(selectedRow?.commit.id ?? null);
  }, [selectedRow?.commit.id]);

  useEffect(() => {
    if (!selectedRow) return;
    loadContents(selectedRow.commit.id, selectedRow.commit.parentId, selectedRow.commit.atMs);
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
  const selectListSession = useCallback((sessionId: string) => {
    setSelectedCommitId(sessionId);
    setDetailsCommitId(sessionId);
  }, []);
  const selectGraphSession = useCallback(
    (sessionId: string) => {
      const commit = commits.find((candidate) => candidate.id === sessionId);
      if (!commit) return;
      const nextSetKey = setKeyForCommit(commit);
      if (nextSetKey !== focusedSet?.key) setFocusedSetKey(nextSetKey);
      selectListSession(sessionId);
      // The map is the left-side navigator. A point should therefore put the
      // corresponding work straight into the reading pane on its right.
      setMoveFocus(true);
    },
    [commits, focusedSet?.key, selectListSession],
  );

  if (projects.length === 0) {
    return (
      <div className="ph ph--empty">
        <strong>No projects yet.</strong>
        <p>
          Recall keeps everything you do in a project — every stretch of work, in the
          order it happened. Create one and open it in Ableton with Recall running.
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
          <p className="ph__eyebrow">Project history</p>
          <h1>{project?.display_name ?? "History"}</h1>
          <span className="ph__subtitle">
            {commits.length} captured {commits.length === 1 ? "session" : "sessions"}
            {sets.length > 1 && ` · ${sets.length} sets`}
            {/* "2 empty" said nothing. These are sittings Recall opened and
                watched without seeing any work — real, worth counting so the
                numbers add up, and meaningless unless the line says what they
                were. */}
            {emptyCheckpoints > 0 &&
              ` · ${emptyCheckpoints} more recorded nothing`}
          </span>
          {/* Where this set came from. The relationship between sets is
              context for the decisions below, not another entry in the list —
              and it says outright when it was inferred rather than watched. */}
          {focusedSet?.cameFrom && (
            <p className="ph__origin">
              {/* Names its own subject. The title above is the PROJECT and the
                  chips that say which set is focused sit below, so a bare
                  "Came off X" reached the reader before the thing it was
                  about. */}
              <span className="ph__origin-subject">{focusedSet.name}</span>{" "}
              {focusedSet.cameFromInferred ? "most likely came off" : "came off"}{" "}
              <button
                type="button"
                className="ph__origin-link"
                onClick={() => {
                  const origin = sets.find((set) => set.name === focusedSet.cameFrom);
                  if (origin) setFocusedSetKey(origin.key);
                }}
              >
                {focusedSet.cameFrom}
              </button>
            </p>
          )}
          {/* A shortcut nobody knows about is not a feature. Stated once, in
              the quietest type on the surface, next to what it acts on. */}
          {rows.length > 1 && (
            <p className="ph__keys">
              <kbd>↑</kbd>
              <kbd>↓</kbd> move · <kbd>p</kbd> came from · <kbd>↵</kbd> report ·{" "}
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

      <div className="ph__workspace">
        <aside className="ph__sidebar">
          <section className="ph__graph" aria-labelledby="project-map-heading">
            <header className="ph__surface-head ph__map-head">
              <div>
                <p className="ph__eyebrow">Project map</p>
                <h2 id="project-map-heading">Work paths</h2>
              </div>
              <p className="ph__surface-note">
                Recent work is at the top. Pick a path to read its work.
              </p>
            </header>
            <div className="ph__graph-body">
              <CommitGraphView
                commits={commits}
                openSessionId={selectedRow?.commit.id ?? null}
                openSteps={
                  detailsCommitId === selectedRow?.commit.id && selectedContents?.status === "ready"
                    ? selectedContents.steps
                    : []
                }
                onSelectSession={selectGraphSession}
                variant="sidebar"
              />
            </div>
          </section>
        </aside>

        <div className="ph__details">
        {rows.length > 0 && (
          <section className="ph__record" aria-labelledby="work-record-heading">
          <header className="ph__surface-head ph__record-head">
            <div>
              <p className="ph__eyebrow">Work record</p>
              <h2 id="work-record-heading">
                {focusedSet ? `Capture record for ${focusedSet.name}` : "Capture record"}
              </h2>
            </div>
            <p className="ph__surface-note">
              {rows.length} {rows.length === 1 ? "session" : "sessions"} in view
            </p>
          </header>

          <SetPicker
            sets={sets}
            focused={focusedSet}
            onFocus={(key) => {
              setFocusedSetKey(key);
              setDetailsCommitId(null);
            }}
          />

          <section
            className="ph__list"
            aria-label="Sessions"
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
                selectListSession(target.commit.id);
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
                        detailsOpen={row.commit.id === detailsCommitId}
                        headline={headlines[row.commit.id] ?? null}
                showSet={setKeyForCommit(row.commit) !== (focusedSet?.key ?? null)}
                        selected={row.commit.id === selectedRow?.commit.id}
                        onSelect={() => selectListSession(row.commit.id)}
                        onToggleDetails={() =>
                          setDetailsCommitId((current) =>
                            current === row.commit.id ? null : row.commit.id,
                          )
                        }
                        onOpenReport={() => onOpenReport(landingSessionId(row))}
                        onOpenWorkspace={() => onOpenWorkspace(landingSessionId(row))}
                      />
                    ))}
                  </ol>
                </li>
              ))}
            </ol>
          </section>
          </section>
        )}

        {artifacts.length > 0 && <Artifacts artifacts={artifacts} />}
        </div>
      </div>
    </div>
  );
}
