import { type FormEvent, useEffect, useMemo, useState } from "react";
import { RecallMark } from "../../components/RecallMark";
import { BridgeSetup } from "../home/BridgeSetup";
import type { ConnectionStatus, SavedProject, SavedSessionMetadata } from "../../types/recall";

type ProjectManagerScreenProps = {
  connection: ConnectionStatus;
  projects: SavedProject[];
  unassignedSessions: SavedSessionMetadata[];
  activeSession: SavedSessionMetadata | null;
  selectedSessionId: string | null;
  loading?: boolean;
  onCreateProject: (displayName: string) => Promise<void>;
  onStartCapture: (projectId?: string | null) => Promise<void>;
  onNewTake: (projectId?: string | null) => Promise<void>;
  onOpenTimeline: (sessionId: string) => void;
  onOpenRecap: (sessionId: string) => void;
  onRenameProject: (projectId: string, displayName: string) => Promise<void>;
  onArchiveProject: (projectId: string) => Promise<void>;
  onRenameCapture: (sessionId: string, captureName: string) => Promise<void>;
  onMoveCapture: (sessionId: string, projectId: string | null) => Promise<void>;
  onDeleteCapture: (sessionId: string) => Promise<void>;
};

export function ProjectManagerScreen({
  connection,
  projects,
  unassignedSessions,
  activeSession,
  selectedSessionId,
  loading = false,
  onCreateProject,
  onStartCapture,
  onNewTake,
  onOpenTimeline,
  onOpenRecap,
  onRenameProject,
  onArchiveProject,
  onRenameCapture,
  onMoveCapture,
  onDeleteCapture,
}: ProjectManagerScreenProps) {
  const [newProjectName, setNewProjectName] = useState("");
  const [busyLabel, setBusyLabel] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const isBusy = busyLabel !== null || loading;

  const allCaptures = useMemo(
    () => projects.flatMap((project) => project.captures).concat(unassignedSessions),
    [projects, unassignedSessions],
  );
  const totalMoments = allCaptures.reduce((total, session) => total + session.creative_event_count, 0);
  // The Ableton set currently open (from the active take's detected set name).
  const activeAbletonName = activeSession?.project_name ?? null;

  async function runAction(label: string, action: () => Promise<void>) {
    setBusyLabel(label);
    setError(null);
    try {
      await action();
    } catch (actionError) {
      setError(String(actionError));
    } finally {
      setBusyLabel(null);
    }
  }

  function handleCreateProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = newProjectName.trim();
    if (!name) {
      setError("Give this project a name first.");
      return;
    }

    void runAction("Adding project...", async () => {
      await onCreateProject(name);
      setNewProjectName("");
    });
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
              : "Awaiting bridge"}
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

      <section className="project-manager__quickstart" aria-label="Create or start">
        <form className="project-create" onSubmit={handleCreateProject}>
          <label>
            <span>Song or version name</span>
            <input
              value={newProjectName}
              onChange={(event) => setNewProjectName(event.target.value)}
              placeholder="Song, remix, experiment, or version"
            />
          </label>
          <button type="submit" className="home-action home-action--primary" disabled={isBusy}>
            Add Project
          </button>
        </form>

        <button
          type="button"
          className="home-action"
          disabled={isBusy}
          onClick={() => void runAction("Starting quick take...", () => onStartCapture(null))}
        >
          Quick Take
        </button>
      </section>

      {(loading || busyLabel || error) && (
        <div className={`project-manager__notice ${error ? "project-manager__notice--error" : ""}`}>
          {error ?? busyLabel ?? "Opening your project desk..."}
        </div>
      )}

      <div className="project-manager__layout">
        <section className="project-manager__projects" aria-label="Projects">
          <div className="project-manager__section-head">
            <div>
              <span className="eyebrow">Project Library</span>
              <h2>Choose a song or version.</h2>
            </div>
          </div>

          {loading ? (
            <ProjectLoadingRows />
          ) : projects.length > 0 ? (
            <div className="project-list">
              {projects.map((project) => (
                <ProjectCard
                  key={project.id}
                  project={project}
                  projects={projects}
                  activeSessionId={activeSession?.id ?? null}
                  selectedSessionId={selectedSessionId}
                  busy={isBusy}
                  onStartCapture={onStartCapture}
                  onNewTake={onNewTake}
                  onOpenTimeline={onOpenTimeline}
                  onOpenRecap={onOpenRecap}
                  onRenameProject={onRenameProject}
                  onArchiveProject={onArchiveProject}
                  onRenameCapture={onRenameCapture}
                  onMoveCapture={onMoveCapture}
                  onDeleteCapture={onDeleteCapture}
                  runAction={runAction}
                />
              ))}
            </div>
          ) : (
            <div className="project-manager__empty">
              <strong>No projects yet.</strong>
              <p>Add a project name, or start a quick take while you explore.</p>
            </div>
          )}

          {!loading && unassignedSessions.length > 0 && (
            <section className="project-manager__unassigned" aria-label="Unassigned takes">
              <div className="project-manager__section-head">
                <div>
                  <span className="eyebrow">Loose Takes</span>
                  <h2>Takes waiting for a project.</h2>
                </div>
              </div>
              <div className="project-card__sessions">
                {unassignedSessions.map((session) => (
                  <CaptureRow
                    key={session.id}
                    session={session}
                    projects={projects}
                    activeSessionId={activeSession?.id ?? null}
                    selectedSessionId={selectedSessionId}
                    busy={isBusy}
                    onOpenTimeline={onOpenTimeline}
                    onOpenRecap={onOpenRecap}
                    onRenameCapture={onRenameCapture}
                    onMoveCapture={onMoveCapture}
                    onDeleteCapture={onDeleteCapture}
                    runAction={runAction}
                  />
                ))}
              </div>
            </section>
          )}
        </section>

        <aside className="project-manager__bridge">
          <BridgeSetup connection={connection} />
        </aside>
      </div>
    </div>
  );
}

function ProjectLoadingRows() {
  return (
    <div className="project-list project-list--loading" aria-label="Loading projects">
      {[0, 1, 2].map((item) => (
        <div key={item} className="project-card project-card--loading">
          <span />
          <span />
          <span />
        </div>
      ))}
    </div>
  );
}

function ProjectCard({
  project,
  projects,
  activeSessionId,
  selectedSessionId,
  busy,
  onStartCapture,
  onNewTake,
  onOpenTimeline,
  onOpenRecap,
  onRenameProject,
  onArchiveProject,
  onRenameCapture,
  onMoveCapture,
  onDeleteCapture,
  runAction,
}: {
  project: SavedProject;
  projects: SavedProject[];
  activeSessionId: string | null;
  selectedSessionId: string | null;
  busy: boolean;
  onStartCapture: (projectId?: string | null) => Promise<void>;
  onNewTake: (projectId?: string | null) => Promise<void>;
  onOpenTimeline: (sessionId: string) => void;
  onOpenRecap: (sessionId: string) => void;
  onRenameProject: (projectId: string, displayName: string) => Promise<void>;
  onArchiveProject: (projectId: string) => Promise<void>;
  onRenameCapture: (sessionId: string, captureName: string) => Promise<void>;
  onMoveCapture: (sessionId: string, projectId: string | null) => Promise<void>;
  onDeleteCapture: (sessionId: string) => Promise<void>;
  runAction: (label: string, action: () => Promise<void>) => Promise<void>;
}) {
  const [draftName, setDraftName] = useState(project.display_name);
  const activeCapture =
    project.captures.find((session) => session.id === activeSessionId) ??
    project.captures.find((session) => session.ended_at_ms === null) ??
    null;
  const hasActiveCapture = activeCapture !== null;

  useEffect(() => {
    setDraftName(project.display_name);
  }, [project.display_name]);

  async function saveProjectName() {
    const nextName = draftName.trim();
    if (!nextName) {
      setDraftName(project.display_name);
      return;
    }

    if (nextName === project.display_name) return;

    await runAction("Renaming project...", () => onRenameProject(project.id, nextName));
  }

  function handleArchive() {
    const confirmed = window.confirm(`Archive "${project.display_name}"? Takes stay saved, but the project leaves this desk.`);
    if (!confirmed) return;
    void runAction("Archiving project...", () => onArchiveProject(project.id));
  }

  return (
    <article className={`project-card ${hasActiveCapture ? "project-card--active" : ""}`}>
      <div className="project-card__top">
        <label className="project-card__name">
          <span>Project name</span>
          <input
            value={draftName}
            onChange={(event) => setDraftName(event.target.value)}
            onBlur={() => void saveProjectName()}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
              if (event.key === "Escape") {
                setDraftName(project.display_name);
                event.currentTarget.blur();
              }
            }}
          />
        </label>
        <div className="project-card__actions">
          {hasActiveCapture ? (
            <>
              <button
                type="button"
                className="home-action home-action--primary"
                disabled={busy}
                onClick={() => onOpenTimeline(activeCapture!.id)}
              >
                Open Live Take
              </button>
              <button
                type="button"
                className="home-action"
                disabled={busy}
                onClick={() => void runAction("Starting new take...", () => onNewTake(project.id))}
              >
                Start Another Take
              </button>
            </>
          ) : (
            <button
              type="button"
              className="home-action home-action--primary"
              disabled={busy}
              onClick={() => void runAction("Starting capture...", () => onStartCapture(project.id))}
            >
              Start Capture
            </button>
          )}
          <button type="button" className="home-action" disabled={busy} onClick={handleArchive}>
            Archive
          </button>
        </div>
      </div>

      <div className="project-card__facts">
        <span>{project.capture_count} take{project.capture_count === 1 ? "" : "s"}</span>
        {project.active_capture_count > 0 && (
          <span className="project-card__recording">Recording now</span>
        )}
        <span>Updated {formatSessionDate(project.last_updated_at_ms)}</span>
      </div>

      <div className="project-card__source" title={project.ableton_path ?? undefined}>
        <span className="project-card__source-label">Ableton set</span>
        {project.ableton_name || project.ableton_path ? (
          <span className="project-card__source-name">
            {project.ableton_name ?? project.ableton_path}
          </span>
        ) : (
          <span className="project-card__source-empty">
            Open this song in Ableton and Recall will connect it
          </span>
        )}
      </div>

      <div className="project-card__sessions">
        {project.captures.length > 0 ? (
          project.captures.map((session) => (
            <CaptureRow
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
              runAction={runAction}
            />
          ))
        ) : (
          <p className="project-card__empty">No takes recorded yet.</p>
        )}
      </div>
    </article>
  );
}

function CaptureRow({
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
  runAction: (label: string, action: () => Promise<void>) => Promise<void>;
}) {
  const [draftName, setDraftName] = useState(session.capture_name ?? session.name);
  const isSelected = session.id === selectedSessionId;
  const isActive = session.id === activeSessionId || session.ended_at_ms === null;

  useEffect(() => {
    setDraftName(session.capture_name ?? session.name);
  }, [session.capture_name, session.name]);

  async function saveCaptureName() {
    const nextName = draftName.trim();
    if (!nextName) {
      setDraftName(session.capture_name ?? session.name);
      return;
    }

    if (nextName === (session.capture_name ?? session.name)) return;

    await runAction("Renaming take...", () => onRenameCapture(session.id, nextName));
  }

  function handleDelete() {
    const confirmed = window.confirm(`Delete this take ("${session.name}")? This removes its saved timeline and cannot be undone.`);
    if (!confirmed) return;
    void runAction("Deleting take...", () => onDeleteCapture(session.id));
  }

  return (
    <div className={`project-version ${isSelected ? "is-selected" : ""} ${isActive ? "is-active" : ""}`}>
      <label className="project-version__name">
        <input
          value={draftName}
          onChange={(event) => setDraftName(event.target.value)}
          onBlur={() => void saveCaptureName()}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
            if (event.key === "Escape") {
              setDraftName(session.capture_name ?? session.name);
              event.currentTarget.blur();
            }
          }}
          aria-label="Take name"
        />
        <span>
          {formatSessionDate(session.started_at_ms)} / {formatDuration(session)} / {session.event_count} moves
        </span>
      </label>

      <div className="project-version__badges">
        {isActive && <span>Recording</span>}
        <span>{session.creative_event_count} moments</span>
      </div>

      <select
        className="project-version__move"
        value={session.project_id ?? ""}
        disabled={busy}
        aria-label="Move take"
        onChange={(event) =>
          void runAction("Moving take...", () => onMoveCapture(session.id, event.target.value || null))
        }
      >
        <option value="">Unassigned</option>
        {projects.map((project) => (
          <option key={project.id} value={project.id}>
            {project.display_name}
          </option>
        ))}
      </select>

      <div className="project-version__actions">
        <button type="button" disabled={busy} onClick={() => onOpenRecap(session.id)}>
          Recap
        </button>
        <button type="button" disabled={busy} onClick={() => onOpenTimeline(session.id)}>
          Timeline
        </button>
        <button type="button" className="project-version__delete" disabled={busy} onClick={handleDelete}>
          Delete
        </button>
      </div>
    </div>
  );
}

function countLabel(count: number, noun: string): string {
  return `${noun}${count === 1 ? "" : "s"}`;
}

function formatSessionDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatDuration(session: SavedSessionMetadata): string {
  if (session.ended_at_ms === null) return "In progress";
  const ms = Math.max(0, session.ended_at_ms - session.started_at_ms);
  const totalMinutes = Math.floor(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return "< 1m";
}
