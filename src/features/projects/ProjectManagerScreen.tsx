import {
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { RecallMark } from "../../components/RecallMark";
import { BridgeSetup } from "../home/BridgeSetup";
import { formatSessionDate, formatSessionDuration } from "../sessionFormat";
import { RelinkDialog, type AlsFileChoice } from "./RelinkDialog";
import type { ConnectionStatus, SavedProject, SavedSessionMetadata } from "../../types/recall";

type ProjectManagerScreenProps = {
  connection: ConnectionStatus;
  projects: SavedProject[];
  unassignedSessions: SavedSessionMetadata[];
  activeSession: SavedSessionMetadata | null;
  selectedSessionId: string | null;
  loading?: boolean;
  onCreateProject: (displayName: string) => Promise<void>;
  onConnectFolder: (projectId?: string | null) => Promise<number>;
  onRescanFolder: (projectId: string) => Promise<number>;
  onOpenVersions: (projectId: string) => void;
  onStartCapture: (projectId?: string | null) => Promise<void>;
  onNewTake: (projectId?: string | null) => Promise<void>;
  onOpenTimeline: (sessionId: string) => void;
  onOpenRecap: (sessionId: string) => void;
  onRenameProject: (projectId: string, displayName: string) => Promise<void>;
  onArchiveProject: (projectId: string) => Promise<void>;
  onRenameCapture: (sessionId: string, captureName: string) => Promise<void>;
  onMoveCapture: (sessionId: string, projectId: string | null) => Promise<void>;
  onDeleteCapture: (sessionId: string) => Promise<void>;
  onListProjectAlsFiles: (projectId: string) => Promise<AlsFileChoice[]>;
  onRelinkTake: (sessionId: string, alsPath: string) => Promise<void>;
};

type SortKey = "name" | "takes" | "updated";
type SortDir = "asc" | "desc";

const DEFAULT_DIR: Record<SortKey, SortDir> = {
  name: "asc",
  takes: "desc",
  updated: "desc",
};

export function ProjectManagerScreen({
  connection,
  projects,
  unassignedSessions,
  activeSession,
  selectedSessionId,
  loading = false,
  onCreateProject,
  onConnectFolder,
  onRescanFolder,
  onOpenVersions,
  onStartCapture,
  onNewTake,
  onOpenTimeline,
  onOpenRecap,
  onRenameProject,
  onArchiveProject,
  onRenameCapture,
  onMoveCapture,
  onDeleteCapture,
  onListProjectAlsFiles,
  onRelinkTake,
}: ProjectManagerScreenProps) {
  const [busyLabel, setBusyLabel] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("updated");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [creating, setCreating] = useState(false);
  const [bridgeOpen, setBridgeOpen] = useState(!connection.connected);

  const isBusy = busyLabel !== null || loading;
  const activeSessionId = activeSession?.id ?? null;
  const activeAbletonName = activeSession?.project_name ?? null;

  const allCaptures = useMemo(
    () => projects.flatMap((project) => project.captures).concat(unassignedSessions),
    [projects, unassignedSessions],
  );
  const totalMoments = allCaptures.reduce((total, session) => total + session.creative_event_count, 0);

  const trimmedQuery = query.trim().toLowerCase();

  const visibleProjects = useMemo(() => {
    const filtered = trimmedQuery
      ? projects.filter((project) => projectMatches(project, trimmedQuery))
      : projects;
    return [...filtered].sort((a, b) => compareProjects(a, b, sortKey, sortDir));
  }, [projects, trimmedQuery, sortKey, sortDir]);

  const visibleUnassigned = useMemo(() => {
    const list = trimmedQuery
      ? unassignedSessions.filter((session) => captureName(session).toLowerCase().includes(trimmedQuery))
      : unassignedSessions;
    return [...list].sort((a, b) => b.started_at_ms - a.started_at_ms);
  }, [unassignedSessions, trimmedQuery]);

  // While filtering, reveal every match by treating filtered projects as expanded.
  const isExpanded = (projectId: string) => Boolean(trimmedQuery) || expanded.has(projectId);

  async function runAction(label: string, action: () => Promise<void>) {
    setBusyLabel(label);
    setError(null);
    setFlash(null);
    try {
      await action();
    } catch (actionError) {
      setError(String(actionError));
    } finally {
      setBusyLabel(null);
    }
  }

  function toggleExpand(projectId: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
  }

  function toggleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir((dir) => (dir === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir(DEFAULT_DIR[key]);
    }
  }

  async function handleCreateDraft(name: string) {
    await runAction("Adding project...", () => onCreateProject(name));
    setCreating(false);
  }

  return (
    <div className="project-manager">
      <header className="project-manager__header">
        <div className="project-manager__brand">
          <RecallMark />
          <div>
            <span className="eyebrow">Project Desk</span>
            <h1>Recall Studio</h1>
            <p>Pick a song, open a take, and keep the moves you want to remember.</p>
          </div>
        </div>

        <div className={`home-connection ${connection.connected ? "home-connection--live" : "home-connection--off"}`}>
          <span className="home-connection__dot" />
          <span>
            {connection.connected
              ? activeAbletonName
                ? `Ableton: ${activeAbletonName}`
                : "Ableton connected"
              : "Listening for Ableton…"}
          </span>
        </div>
      </header>

      <section className="project-manager__summary" aria-label="Project desk summary">
        <div>
          <strong>{projects.length}</strong>
          <span>{countLabel(projects.length, "project")}</span>
        </div>
        <div>
          <strong>{allCaptures.length}</strong>
          <span>{countLabel(allCaptures.length, "take")}</span>
        </div>
        <div>
          <strong>{totalMoments}</strong>
          <span>{countLabel(totalMoments, "moment")}</span>
        </div>
        <div>
          <strong>{activeSession ? "1" : "0"}</strong>
          <span>{countLabel(activeSession ? 1 : 0, "recording")}</span>
        </div>
      </section>

      <BridgeStrip connection={connection} open={bridgeOpen} onToggle={() => setBridgeOpen((open) => !open)} />

      {(loading || busyLabel || error || flash) && (
        <div className={`project-manager__notice ${error ? "project-manager__notice--error" : ""}`}>
          {error ?? busyLabel ?? flash ?? "Opening your project desk..."}
        </div>
      )}

      <section className="project-explorer" aria-label="Project library">
        <div className="project-explorer__bar">
          <div className="project-explorer__crumb">
            <FolderIcon />
            <div>
              <span className="eyebrow">Project Library</span>
              <span className="project-explorer__count">
                {projects.length} {countLabel(projects.length, "project")}
                {" · "}
                {allCaptures.length} {countLabel(allCaptures.length, "take")}
                {activeSession ? " · 1 recording" : ""}
              </span>
            </div>
          </div>

          <div className="project-explorer__tools">
            <label className="project-explorer__search">
              <SearchIcon />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Filter projects"
                aria-label="Filter projects"
              />
              {query && (
                <button
                  type="button"
                  className="project-explorer__search-clear"
                  aria-label="Clear filter"
                  onClick={() => setQuery("")}
                >
                  <CloseIcon />
                </button>
              )}
            </label>

            <button
              type="button"
              className="home-action"
              disabled={isBusy}
              onClick={async () => {
                setBusyLabel("Importing projects...");
                setError(null);
                setFlash(null);
                try {
                  const added = await onConnectFolder(null);
                  setFlash(
                    added > 0
                      ? `Imported ${added} ${added === 1 ? "project" : "projects"} from that folder.`
                      : "No new projects — those folders are already in your library.",
                  );
                } catch (importError) {
                  setError(String(importError));
                } finally {
                  setBusyLabel(null);
                }
              }}
            >
              <FolderIcon />
              Connect Folder
            </button>
            <button
              type="button"
              className="home-action"
              disabled={isBusy}
              onClick={() => void runAction("Starting quick take...", () => onStartCapture(null))}
            >
              Quick Take
            </button>
            <button
              type="button"
              className="home-action home-action--primary"
              disabled={isBusy || creating}
              onClick={() => setCreating(true)}
            >
              <PlusIcon />
              New Project
            </button>
          </div>
        </div>

        <div className="project-explorer__head" role="row">
          <span className="px-cell px-cell--chev" />
          <SortHeader label="Name" sortKey="name" activeKey={sortKey} dir={sortDir} onSort={toggleSort} />
          <SortHeader label="Takes" sortKey="takes" activeKey={sortKey} dir={sortDir} onSort={toggleSort} align="end" />
          <SortHeader label="Updated" sortKey="updated" activeKey={sortKey} dir={sortDir} onSort={toggleSort} />
          <span className="px-cell px-set px-head__static">Ableton</span>
          <span className="px-cell px-actions" />
        </div>

        {loading ? (
          <ProjectLoadingRows />
        ) : (
          <div className="project-explorer__rows">
            {creating && (
              <DraftRow busy={isBusy} onCommit={handleCreateDraft} onCancel={() => setCreating(false)} />
            )}

            {visibleProjects.map((project) => (
              <ProjectRow
                key={project.id}
                project={project}
                projects={projects}
                activeSessionId={activeSessionId}
                selectedSessionId={selectedSessionId}
                busy={isBusy}
                expanded={isExpanded(project.id)}
                onToggle={() => toggleExpand(project.id)}
                onConnectFolder={onConnectFolder}
                onRescanFolder={onRescanFolder}
                onOpenVersions={onOpenVersions}
                onNewTake={onNewTake}
                onOpenTimeline={onOpenTimeline}
                onOpenRecap={onOpenRecap}
                onRenameProject={onRenameProject}
                onArchiveProject={onArchiveProject}
                onRenameCapture={onRenameCapture}
                onMoveCapture={onMoveCapture}
                onDeleteCapture={onDeleteCapture}
                onListProjectAlsFiles={onListProjectAlsFiles}
                onRelinkTake={onRelinkTake}
                runAction={runAction}
              />
            ))}

            {!creating && visibleProjects.length === 0 && (
              <div className="project-explorer__empty">
                {projects.length === 0 ? (
                  <>
                    <strong>No projects yet.</strong>
                    <p>Hit New Project to name your first song, or Quick Take to start recording right away.</p>
                  </>
                ) : (
                  <>
                    <strong>Nothing matches "{query.trim()}".</strong>
                    <p>Try a different name, or clear the filter.</p>
                  </>
                )}
              </div>
            )}
          </div>
        )}

        {!loading && visibleUnassigned.length > 0 && (
          <div className="project-explorer__loose">
            <div className="project-explorer__loose-head">
              <span className="eyebrow">Loose Takes</span>
              <span className="project-explorer__count">{countLabel(visibleUnassigned.length, "take")} waiting for a project</span>
            </div>
            <div className="project-explorer__rows">
              {visibleUnassigned.map((session) => (
                <TakeRow
                  key={session.id}
                  session={session}
                  projects={projects}
                  activeSessionId={activeSessionId}
                  selectedSessionId={selectedSessionId}
                  busy={isBusy}
                  onOpenTimeline={onOpenTimeline}
                  onOpenRecap={onOpenRecap}
                  onRenameCapture={onRenameCapture}
                  onMoveCapture={onMoveCapture}
                  onDeleteCapture={onDeleteCapture}
                  onListProjectAlsFiles={onListProjectAlsFiles}
                  onRelinkTake={onRelinkTake}
                  runAction={runAction}
                />
              ))}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

function BridgeStrip({
  connection,
  open,
  onToggle,
}: {
  connection: ConnectionStatus;
  open: boolean;
  onToggle: () => void;
}) {
  const live = connection.connected;
  return (
    <section className={`bridge-strip ${live ? "bridge-strip--live" : "bridge-strip--off"} ${open ? "is-open" : ""}`}>
      <button type="button" className="bridge-strip__bar" onClick={onToggle} aria-expanded={open}>
        <span className="bridge-strip__status">
          <span className="bridge-strip__dot" />
          <span className="bridge-strip__label">
            {live
              ? connection.bridge_version
                ? `Ableton bridge connected · v${connection.bridge_version}`
                : "Ableton bridge connected"
              : "Ableton bridge not connected"}
          </span>
        </span>
        <span className="bridge-strip__hint">
          {live ? "Setup" : "Connect Ableton"}
          <Chevron open={open} />
        </span>
      </button>
      {open && (
        <div className="bridge-strip__body">
          <BridgeSetup connection={connection} />
        </div>
      )}
    </section>
  );
}

function SortHeader({
  label,
  sortKey,
  activeKey,
  dir,
  onSort,
  align = "start",
}: {
  label: string;
  sortKey: SortKey;
  activeKey: SortKey;
  dir: SortDir;
  onSort: (key: SortKey) => void;
  align?: "start" | "end";
}) {
  const active = sortKey === activeKey;
  const cellClass = sortKey === "takes" ? "px-num" : sortKey === "updated" ? "px-when" : "px-name";
  return (
    <button
      type="button"
      className={`px-cell ${cellClass} px-sort ${active ? "is-active" : ""} ${align === "end" ? "px-sort--end" : ""}`}
      onClick={() => onSort(sortKey)}
      aria-label={`Sort by ${label}`}
    >
      {label}
      <span className="px-sort__dir">{active ? (dir === "asc" ? "↑" : "↓") : ""}</span>
    </button>
  );
}

function ProjectLoadingRows() {
  return (
    <div className="project-explorer__rows project-explorer__rows--loading" aria-label="Loading projects">
      {[0, 1, 2, 3].map((item) => (
        <div key={item} className="px-row px-row--loading">
          <span className="px-skeleton px-skeleton--name" />
          <span className="px-skeleton px-skeleton--num" />
          <span className="px-skeleton px-skeleton--when" />
        </div>
      ))}
    </div>
  );
}

function ProjectRow({
  project,
  projects,
  activeSessionId,
  selectedSessionId,
  busy,
  expanded,
  onToggle,
  onConnectFolder,
  onRescanFolder,
  onOpenVersions,
  onNewTake,
  onOpenTimeline,
  onOpenRecap,
  onRenameProject,
  onArchiveProject,
  onRenameCapture,
  onMoveCapture,
  onDeleteCapture,
  onListProjectAlsFiles,
  onRelinkTake,
  runAction,
}: {
  project: SavedProject;
  projects: SavedProject[];
  activeSessionId: string | null;
  selectedSessionId: string | null;
  busy: boolean;
  expanded: boolean;
  onToggle: () => void;
  onConnectFolder: (projectId?: string | null) => Promise<number>;
  onRescanFolder: (projectId: string) => Promise<number>;
  onOpenVersions: (projectId: string) => void;
  onNewTake: (projectId?: string | null) => Promise<void>;
  onOpenTimeline: (sessionId: string) => void;
  onOpenRecap: (sessionId: string) => void;
  onRenameProject: (projectId: string, displayName: string) => Promise<void>;
  onArchiveProject: (projectId: string) => Promise<void>;
  onRenameCapture: (sessionId: string, captureName: string) => Promise<void>;
  onMoveCapture: (sessionId: string, projectId: string | null) => Promise<void>;
  onDeleteCapture: (sessionId: string) => Promise<void>;
  onListProjectAlsFiles: (projectId: string) => Promise<AlsFileChoice[]>;
  onRelinkTake: (sessionId: string, alsPath: string) => Promise<void>;
  runAction: (label: string, action: () => Promise<void>) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const hasTakes = project.captures.length > 0;
  const recording = project.active_capture_count > 0;

  const takes = useMemo(
    () => [...project.captures].sort((a, b) => b.started_at_ms - a.started_at_ms),
    [project.captures],
  );

  function handleArchive() {
    const confirmed = window.confirm(
      `Archive "${project.display_name}"? Takes stay saved, but the project leaves this desk.`,
    );
    if (!confirmed) return;
    void runAction("Archiving project...", () => onArchiveProject(project.id));
  }

  // Clicking a project leads to its versions view — the version rail is the hero
  // surface. Quick inline peeking at takes stays on the chevron / Space key.
  function handleRowClick(event: React.MouseEvent) {
    if ((event.target as HTMLElement).closest("button, input, .row-menu")) return;
    onOpenVersions(project.id);
  }

  function handleRowKey(event: React.KeyboardEvent) {
    if ((event.target as HTMLElement).closest("button, input, .row-menu")) return;
    if (event.key === "Enter") {
      event.preventDefault();
      onOpenVersions(project.id);
    } else if (event.key === " " && hasTakes) {
      event.preventDefault();
      onToggle();
    }
  }

  return (
    <div className={`px-group ${recording ? "is-recording" : ""}`}>
      <div
        className={`px-row px-row--project ${expanded ? "is-open" : ""} is-clickable`}
        role="button"
        tabIndex={0}
        aria-expanded={hasTakes ? expanded : undefined}
        onClick={handleRowClick}
        onKeyDown={handleRowKey}
      >
        <span className="px-cell px-cell--chev">
          {hasTakes && (
            <button
              type="button"
              className="px-chev-btn"
              aria-label={expanded ? "Collapse takes" : "Expand takes"}
              onClick={(event) => {
                event.stopPropagation();
                onToggle();
              }}
            >
              <Chevron open={expanded} />
            </button>
          )}
        </span>

        <span className="px-cell px-name">
          <FolderIcon open={expanded && hasTakes} />
          {editing ? (
            <EditableName
              value={project.display_name}
              busy={busy}
              ariaLabel="Project name"
              onCommit={(next) => runAction("Renaming project...", () => onRenameProject(project.id, next))}
              onClose={() => setEditing(false)}
            />
          ) : (
            <span
              className="px-name__text"
              title={project.display_name}
              onDoubleClick={() => setEditing(true)}
            >
              {project.display_name}
            </span>
          )}
        </span>

        <span className={`px-cell px-num ${hasTakes ? "" : "is-zero"}`}>{project.capture_count}</span>

        <span className="px-cell px-when">{formatSessionDate(project.last_updated_at_ms)}</span>

        <span className="px-cell px-set">
          {recording ? (
            <span className="px-chip px-chip--rec">
              <span className="px-dot" />
              Recording
            </span>
          ) : project.ableton_name || project.ableton_path ? (
            <span className="px-tag" title={project.ableton_path ?? project.ableton_name ?? undefined}>
              Ableton set
            </span>
          ) : (
            <span className="px-dash">—</span>
          )}
        </span>

        <span className="px-cell px-actions">
          <button
            type="button"
            className="px-btn px-btn--primary"
            disabled={busy}
            onClick={() => onOpenVersions(project.id)}
            title="See this song's versions and what changed"
          >
            {recording ? "Open" : (
              <>
                <PlayIcon />
                Open
              </>
            )}
          </button>
          <RowMenu ariaLabel="Project actions" disabled={busy}>
            {(close) => (
              <>
                <button
                  type="button"
                  className="row-menu__item"
                  onClick={() => {
                    setEditing(true);
                    close();
                  }}
                >
                  Rename
                </button>
                <button
                  type="button"
                  className="row-menu__item"
                  onClick={() => {
                    void runAction("Connecting folder...", () => onConnectFolder(project.id).then(() => undefined));
                    close();
                  }}
                >
                  {project.ableton_name || project.ableton_path ? "Replace Ableton folder…" : "Connect Ableton folder…"}
                </button>
                {project.ableton_path && (
                  <button
                    type="button"
                    className="row-menu__item"
                    onClick={() => {
                      void runAction("Rescanning folder...", () => onRescanFolder(project.id).then(() => undefined));
                      close();
                    }}
                  >
                    Rescan folder for new versions
                  </button>
                )}
                {recording && (
                  <button
                    type="button"
                    className="row-menu__item"
                    onClick={() => {
                      void runAction("Starting new take...", () => onNewTake(project.id));
                      close();
                    }}
                  >
                    Start another take
                  </button>
                )}
                <div className="row-menu__sep" />
                <button
                  type="button"
                  className="row-menu__item row-menu__item--danger"
                  onClick={() => {
                    handleArchive();
                    close();
                  }}
                >
                  Archive project
                </button>
              </>
            )}
          </RowMenu>
        </span>
      </div>

      {expanded && (
        <div className="px-takes">
          {hasTakes ? (
            takes.map((session) => (
              <TakeRow
                key={session.id}
                session={session}
                projects={projects}
                activeSessionId={activeSessionId}
                selectedSessionId={selectedSessionId}
                busy={busy}
                onOpenTimeline={onOpenTimeline}
                onOpenRecap={onOpenRecap}
                onRenameCapture={onRenameCapture}
                onMoveCapture={onMoveCapture}
                onDeleteCapture={onDeleteCapture}
                onListProjectAlsFiles={onListProjectAlsFiles}
                onRelinkTake={onRelinkTake}
                runAction={runAction}
              />
            ))
          ) : (
            <p className="px-takes__empty">No takes recorded yet.</p>
          )}
        </div>
      )}
    </div>
  );
}

function TakeRow({
  session,
  projects,
  activeSessionId,
  selectedSessionId,
  busy,
  onOpenTimeline,
  onOpenRecap,
  onRenameCapture,
  onMoveCapture,
  onDeleteCapture,
  onListProjectAlsFiles,
  onRelinkTake,
  runAction,
}: {
  session: SavedSessionMetadata;
  projects: SavedProject[];
  activeSessionId: string | null;
  selectedSessionId: string | null;
  busy: boolean;
  onOpenTimeline: (sessionId: string) => void;
  onOpenRecap: (sessionId: string) => void;
  onRenameCapture: (sessionId: string, captureName: string) => Promise<void>;
  onMoveCapture: (sessionId: string, projectId: string | null) => Promise<void>;
  onDeleteCapture: (sessionId: string) => Promise<void>;
  onListProjectAlsFiles: (projectId: string) => Promise<AlsFileChoice[]>;
  onRelinkTake: (sessionId: string, alsPath: string) => Promise<void>;
  runAction: (label: string, action: () => Promise<void>) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [relinkOpen, setRelinkOpen] = useState(false);
  const isSelected = session.id === selectedSessionId;
  // A scanned take is a version found on disk with no recorded moves yet — it must
  // not read as a live recording even though it shares the take row.
  const isScanned = session.take_origin === "scanned";
  const isActive = !isScanned && (session.id === activeSessionId || session.ended_at_ms === null);
  const name = captureName(session);

  function handleDelete() {
    const confirmed = window.confirm(
      `Delete this take ("${name}")? This removes its saved timeline and cannot be undone.`,
    );
    if (!confirmed) return;
    void runAction("Deleting take...", () => onDeleteCapture(session.id));
  }

  return (
    <div className={`px-take ${isSelected ? "is-selected" : ""} ${isActive ? "is-active" : ""}`}>
      <span className="px-take__rail" />
      <span className="px-take__main">
        {editing ? (
          <EditableName
            value={name}
            busy={busy}
            ariaLabel="Take name"
            onCommit={(next) => runAction("Renaming take...", () => onRenameCapture(session.id, next))}
            onClose={() => setEditing(false)}
          />
        ) : (
          <span className="px-take__name" title={name} onDoubleClick={() => setEditing(true)}>
            {name}
            {isScanned && <span className="px-take__found">Found</span>}
          </span>
        )}
        {isScanned ? (
          <span className="px-take__meta">
            {formatSessionDate(session.started_at_ms)}
            {" · "}
            version on disk · not recorded yet
          </span>
        ) : (
          <span className="px-take__meta">
            {formatSessionDate(session.started_at_ms)}
            {" · "}
            {formatSessionDuration(session)}
            {" · "}
            {session.creative_event_count} {countLabel(session.creative_event_count, "moment")}
            {isActive ? " · live" : ""}
          </span>
        )}
      </span>

      <span className="px-take__actions">
        <button type="button" className="px-btn" disabled={busy} onClick={() => onOpenRecap(session.id)}>
          Recap
        </button>
        <button type="button" className="px-btn" disabled={busy} onClick={() => onOpenTimeline(session.id)}>
          Timeline
        </button>
        <RowMenu ariaLabel="Take actions" disabled={busy}>
          {(close) => (
            <>
              <button
                type="button"
                className="row-menu__item"
                onClick={() => {
                  setEditing(true);
                  close();
                }}
              >
                Rename
              </button>
              {session.project_id && (
                <button
                  type="button"
                  className="row-menu__item"
                  onClick={() => {
                    setRelinkOpen(true);
                    close();
                  }}
                >
                  Relink to file…
                </button>
              )}
              <div className="row-menu__sep" />
              <div className="row-menu__label">Move to</div>
              <button
                type="button"
                className="row-menu__item"
                disabled={session.project_id === null}
                onClick={() => {
                  void runAction("Moving take...", () => onMoveCapture(session.id, null));
                  close();
                }}
              >
                Loose takes
              </button>
              {projects.map((project) => (
                <button
                  key={project.id}
                  type="button"
                  className="row-menu__item"
                  disabled={session.project_id === project.id}
                  onClick={() => {
                    void runAction("Moving take...", () => onMoveCapture(session.id, project.id));
                    close();
                  }}
                >
                  {project.display_name}
                </button>
              ))}
              <div className="row-menu__sep" />
              <button
                type="button"
                className="row-menu__item row-menu__item--danger"
                onClick={() => {
                  handleDelete();
                  close();
                }}
              >
                Delete take
              </button>
            </>
          )}
        </RowMenu>
      </span>

      {relinkOpen && session.project_id && (
        <RelinkDialog
          projectId={session.project_id}
          currentAlsPath={session.als_path}
          busy={busy}
          onList={onListProjectAlsFiles}
          onChoose={(alsPath) =>
            runAction("Relinking take...", () => onRelinkTake(session.id, alsPath))
          }
          onClose={() => setRelinkOpen(false)}
        />
      )}
    </div>
  );
}

function DraftRow({
  busy,
  onCommit,
  onCancel,
}: {
  busy: boolean;
  onCommit: (name: string) => Promise<void> | void;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const done = useRef(false);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  function commit() {
    if (done.current) return;
    const trimmed = name.trim();
    if (!trimmed) {
      onCancel();
      return;
    }
    done.current = true;
    void onCommit(trimmed);
  }

  return (
    <div className="px-row px-row--draft">
      <span className="px-cell px-cell--chev" />
      <span className="px-cell px-name">
        <FolderIcon />
        <input
          ref={inputRef}
          className="px-name__input"
          value={name}
          placeholder="New project name"
          disabled={busy}
          onChange={(event) => setName(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") commit();
            if (event.key === "Escape") {
              done.current = true;
              onCancel();
            }
          }}
          aria-label="New project name"
        />
      </span>
      <span className="px-cell px-num is-zero">0</span>
      <span className="px-cell px-when">now</span>
      <span className="px-cell px-set">
        <span className="px-dash">—</span>
      </span>
      <span className="px-cell px-actions" />
    </div>
  );
}

function EditableName({
  value,
  busy,
  ariaLabel,
  onCommit,
  onClose,
}: {
  value: string;
  busy: boolean;
  ariaLabel: string;
  onCommit: (next: string) => Promise<void>;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);
  const done = useRef(false);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  function commit() {
    if (done.current) return;
    done.current = true;
    const next = draft.trim();
    if (next && next !== value) {
      void onCommit(next);
    }
    onClose();
  }

  return (
    <input
      ref={inputRef}
      className="px-name__input"
      value={draft}
      disabled={busy}
      onChange={(event) => setDraft(event.target.value)}
      onClick={(event) => event.stopPropagation()}
      onBlur={commit}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Enter") commit();
        if (event.key === "Escape") {
          done.current = true;
          onClose();
        }
      }}
      aria-label={ariaLabel}
    />
  );
}

function RowMenu({
  ariaLabel,
  disabled = false,
  children,
}: {
  ariaLabel: string;
  disabled?: boolean;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointer(event: MouseEvent) {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className={`row-menu ${open ? "is-open" : ""}`} ref={ref}>
      <button
        type="button"
        className="row-menu__trigger"
        aria-label={ariaLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
      >
        <DotsIcon />
      </button>
      {open && (
        <div className="row-menu__pop" role="menu">
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

function projectMatches(project: SavedProject, query: string): boolean {
  if (project.display_name.toLowerCase().includes(query)) return true;
  if (project.ableton_name?.toLowerCase().includes(query)) return true;
  return project.captures.some((session) => captureName(session).toLowerCase().includes(query));
}

function compareProjects(a: SavedProject, b: SavedProject, key: SortKey, dir: SortDir): number {
  let result = 0;
  if (key === "name") {
    result = a.display_name.localeCompare(b.display_name, undefined, { sensitivity: "base", numeric: true });
  } else if (key === "takes") {
    result = a.capture_count - b.capture_count;
  } else {
    result = a.last_updated_at_ms - b.last_updated_at_ms;
  }
  if (result === 0) result = a.last_updated_at_ms - b.last_updated_at_ms;
  return dir === "asc" ? result : -result;
}

function captureName(session: SavedSessionMetadata): string {
  return session.capture_name ?? session.name;
}

function countLabel(count: number, noun: string): string {
  return `${noun}${count === 1 ? "" : "s"}`;
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg className={`px-chevron ${open ? "is-open" : ""}`} viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
      <path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function FolderIcon({ open = false }: { open?: boolean }) {
  return (
    <svg className={`px-folder ${open ? "is-open" : ""}`} viewBox="0 0 18 18" width="16" height="16" aria-hidden="true">
      <path
        d="M2 4.6c0-.6.5-1.1 1.1-1.1h3.3c.4 0 .7.2.9.5l.7 1h6c.6 0 1.1.5 1.1 1.1V13c0 .6-.5 1.1-1.1 1.1H3.1C2.5 14.1 2 13.6 2 13V4.6z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <circle cx="7" cy="7" r="4.2" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M10.2 10.2L14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
      <path d="M8 3v10M3 8h10" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}

function PlayIcon() {
  return (
    <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
      <path d="M5 3.5l7 4.5-7 4.5z" fill="currentColor" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
      <path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function DotsIcon() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
      <circle cx="3.2" cy="8" r="1.3" fill="currentColor" />
      <circle cx="8" cy="8" r="1.3" fill="currentColor" />
      <circle cx="12.8" cy="8" r="1.3" fill="currentColor" />
    </svg>
  );
}
