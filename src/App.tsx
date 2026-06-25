import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import "./App.css";

import { AppShell } from "./components/AppShell";
import type { AppSurface } from "./components/AppShell";
import { ProductionCheatSheet } from "./components/ProductionCheatSheet";
import { SchemaTimeline } from "./components/schema/SchemaTimeline";
import { ProjectManagerScreen, SessionRecapScreen, StartupScreen } from "./features";
import type { ConnectionStatus, SavedProject, SavedSessionMetadata, SessionStatus } from "./types";

const BACKEND_CONNECTION_COMMAND = "get_connection_status";
const BACKEND_LIST_SESSIONS_COMMAND = "list_saved_sessions";
const BACKEND_LIST_PROJECTS_COMMAND = "list_projects";
const BACKEND_CREATE_PROJECT_COMMAND = "create_project";
const BACKEND_RENAME_PROJECT_COMMAND = "rename_project";
const BACKEND_ARCHIVE_PROJECT_COMMAND = "archive_project";
const BACKEND_ASSIGN_SESSION_TO_PROJECT_COMMAND = "assign_session_to_project";
const BACKEND_RENAME_CAPTURE_COMMAND = "rename_capture";
const BACKEND_DELETE_CAPTURE_COMMAND = "delete_saved_session";
const BACKEND_START_CAPTURE_FOR_PROJECT_COMMAND = "start_capture_for_project";
const BACKEND_NEW_TAKE_FOR_PROJECT_COMMAND = "new_take_for_project";

const POLL_INTERVAL_MS = 1000;
const PRODUCER_NAME_STORAGE_KEY = "recall-studio.producer-name";

function loadProducerName(): string {
  try {
    return window.localStorage.getItem(PRODUCER_NAME_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

function storeProducerName(name: string) {
  try {
    window.localStorage.setItem(PRODUCER_NAME_STORAGE_KEY, name);
  } catch {
    // Local storage can be unavailable in a few embedded/browser contexts.
  }
}

function App() {
  const [surface, setSurface] = useState<AppSurface>("projects");
  const [connection, setConnection] = useState<ConnectionStatus>({
    connected: false,
    last_heartbeat_ms: null,
    last_message: null,
    bridge_version: null,
  });
  const [savedSessions, setSavedSessions] = useState<SavedSessionMetadata[]>([]);
  const [savedProjects, setSavedProjects] = useState<SavedProject[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [libraryReady, setLibraryReady] = useState(false);
  const [enteredStudio, setEnteredStudio] = useState(false);
  const [producerName, setProducerName] = useState(loadProducerName);

  const activeSession = useMemo(
    () => savedSessions.find((session) => session.ended_at_ms === null) ?? null,
    [savedSessions],
  );

  const effectiveSessionId = selectedSessionId ?? activeSession?.id ?? savedSessions[0]?.id ?? null;
  const currentSession = useMemo(
    () => savedSessions.find((session) => session.id === effectiveSessionId) ?? null,
    [effectiveSessionId, savedSessions],
  );
  const unassignedSessions = useMemo(
    () => savedSessions.filter((session) => !session.project_id),
    [savedSessions],
  );
  const totalMoments = useMemo(
    () => savedSessions.reduce((total, session) => total + session.creative_event_count, 0),
    [savedSessions],
  );

  const reloadProjects = useCallback(async () => {
    const projects = await invoke<SavedProject[]>(BACKEND_LIST_PROJECTS_COMMAND, {
      includeArchived: false,
    });
    setSavedProjects(projects);
    return projects;
  }, []);

  const reloadLibrary = useCallback(async () => {
    const [sessions, projects] = await Promise.all([
      invoke<SavedSessionMetadata[]>(BACKEND_LIST_SESSIONS_COMMAND),
      invoke<SavedProject[]>(BACKEND_LIST_PROJECTS_COMMAND, {
        includeArchived: false,
      }),
    ]);

    setSavedSessions(sessions);
    setSavedProjects(projects);
    setLibraryReady(true);

    return { sessions, projects };
  }, []);

  useEffect(() => {
    let mounted = true;

    async function pollConnection() {
      try {
        const status = await invoke<ConnectionStatus>(BACKEND_CONNECTION_COMMAND);
        if (mounted) setConnection(status);
      } catch (error) {
        console.error("Failed to get connection status:", error);
        if (mounted) {
          setConnection((current) => ({ ...current, connected: false }));
        }
      }
    }

    pollConnection();
    const interval = window.setInterval(pollConnection, POLL_INTERVAL_MS);

    return () => {
      mounted = false;
      window.clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    let mounted = true;

    async function refreshSavedSessions() {
      try {
        const { sessions, projects } = await reloadLibrary();
        if (mounted) {
          setSavedSessions(sessions);
          setSavedProjects(projects);
        }
      } catch (error) {
        console.error("Failed to refresh projects and captures:", error);
        if (mounted) setLibraryReady(true);
      }
    }

    refreshSavedSessions();
    const interval = window.setInterval(refreshSavedSessions, POLL_INTERVAL_MS);

    return () => {
      mounted = false;
      window.clearInterval(interval);
    };
  }, [reloadLibrary]);

  function handleOpenTimeline(sessionId?: string) {
    setSelectedSessionId(sessionId ?? effectiveSessionId);
    setSurface("timeline");
  }

  function handleOpenRecap(sessionId?: string) {
    setSelectedSessionId(sessionId ?? effectiveSessionId);
    setSurface("recap");
  }

  // Open a project: resume the take for the version open in Ableton (or the most
  // recent), then jump into its timeline. The "double-click takes me to v8" path.
  async function handleOpenProject(projectId: string) {
    try {
      const status = await invoke<SessionStatus>("open_take_for_open_file", {
        projectId,
      });
      await reloadLibrary();
      if (status.session_id) {
        setSelectedSessionId(status.session_id);
        setSurface("timeline");
      }
    } catch (error) {
      console.error("Failed to open project take:", error);
      throw error;
    }
  }

  async function handleStartCapture(projectId?: string | null) {
    try {
      const status = await invoke<SessionStatus>(BACKEND_START_CAPTURE_FOR_PROJECT_COMMAND, {
        projectId: projectId ?? null,
      });
      await reloadLibrary();
      setSelectedSessionId(status.session_id);
      setSurface("timeline");
    } catch (error) {
      console.error("Failed to start capture:", error);
      throw error;
    }
  }

  // Intentionally start a fresh take, even when the project already has one going.
  async function handleNewTake(projectId?: string | null) {
    try {
      const status = await invoke<SessionStatus>(BACKEND_NEW_TAKE_FOR_PROJECT_COMMAND, {
        projectId: projectId ?? null,
      });
      await reloadLibrary();
      setSelectedSessionId(status.session_id);
      setSurface("timeline");
    } catch (error) {
      console.error("Failed to start a new take:", error);
      throw error;
    }
  }

  async function handleCreateProject(displayName: string) {
    await invoke(BACKEND_CREATE_PROJECT_COMMAND, { displayName });
    await reloadProjects();
  }

  async function handleConnectFolder(projectId?: string | null): Promise<number> {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "Choose an Ableton project folder — or the folder that holds all of them",
    });
    if (typeof selected !== "string") return 0;
    const count = await invoke<number>("connect_project_folder", {
      path: selected,
      projectId: projectId ?? null,
    });
    await reloadProjects();
    return count;
  }

  // Re-scan a project's connected folder for new `.als` versions, surfacing each as
  // a take. Returns how many were added so the UI can report it.
  async function handleRescanFolder(projectId: string): Promise<number> {
    const added = await invoke<number>("rescan_project_folder", { projectId });
    await reloadProjects();
    return added;
  }

  async function handleRenameProject(projectId: string, displayName: string) {
    await invoke(BACKEND_RENAME_PROJECT_COMMAND, { projectId, displayName });
    await reloadProjects();
  }

  async function handleArchiveProject(projectId: string) {
    await invoke(BACKEND_ARCHIVE_PROJECT_COMMAND, { projectId });
    const { sessions, projects } = await reloadLibrary();
    setSavedSessions(sessions);
    setSavedProjects(projects);
  }

  async function handleRenameCapture(sessionId: string, captureName: string) {
    await invoke(BACKEND_RENAME_CAPTURE_COMMAND, { sessionId, captureName });
    await reloadLibrary();
  }

  // List the `.als` versions in a project's folder, for the relink picker.
  function handleListProjectAlsFiles(projectId: string) {
    return invoke<{ name: string; path: string }[]>("list_project_als_files", {
      projectId,
    });
  }

  // Move a take's history onto a different `.als` version (after a rename).
  async function handleRelinkTake(sessionId: string, alsPath: string) {
    await invoke("relink_take", { sessionId, alsPath });
    await reloadLibrary();
  }

  async function handleMoveCapture(sessionId: string, projectId: string | null) {
    await invoke(BACKEND_ASSIGN_SESSION_TO_PROJECT_COMMAND, {
      sessionId,
      projectId,
    });
    await reloadLibrary();
  }

  async function handleDeleteCapture(sessionId: string) {
    await invoke(BACKEND_DELETE_CAPTURE_COMMAND, { sessionId });
    const { sessions } = await reloadLibrary();
    const stillSelected = sessions.some((session) => session.id === selectedSessionId);
    if (!stillSelected) {
      setSelectedSessionId(sessions.find((session) => session.ended_at_ms === null)?.id ?? sessions[0]?.id ?? null);
    }
  }

  function handleProducerNameChange(name: string) {
    setProducerName(name);
    storeProducerName(name);
  }

  if (!enteredStudio) {
    return (
      <StartupScreen
        producerName={producerName}
        connected={connection.connected}
        loading={!libraryReady}
        projectCount={savedProjects.length}
        takeCount={savedSessions.length}
        momentCount={totalMoments}
        recordingCount={activeSession ? 1 : 0}
        activeAbletonName={activeSession?.project_name ?? null}
        onProducerNameChange={handleProducerNameChange}
        onEnter={() => setEnteredStudio(true)}
      />
    );
  }

  return (
    <AppShell
      surface={surface}
      onChangeSurface={setSurface}
      connected={connection.connected}
      projects={
        <ProjectManagerScreen
          connection={connection}
          projects={savedProjects}
          unassignedSessions={unassignedSessions}
          activeSession={activeSession}
          selectedSessionId={effectiveSessionId}
          loading={!libraryReady}
          onCreateProject={handleCreateProject}
          onConnectFolder={handleConnectFolder}
          onRescanFolder={handleRescanFolder}
          onOpenProject={handleOpenProject}
          onStartCapture={handleStartCapture}
          onNewTake={handleNewTake}
          onOpenTimeline={handleOpenTimeline}
          onOpenRecap={handleOpenRecap}
          onRenameProject={handleRenameProject}
          onArchiveProject={handleArchiveProject}
          onRenameCapture={handleRenameCapture}
          onMoveCapture={handleMoveCapture}
          onDeleteCapture={handleDeleteCapture}
          onListProjectAlsFiles={handleListProjectAlsFiles}
          onRelinkTake={handleRelinkTake}
        />
      }
      recap={
        <SessionRecapScreen
          sessionId={effectiveSessionId}
          sessions={savedSessions}
          onOpenTimeline={handleOpenTimeline}
          onOpenProjects={() => setSurface("projects")}
        />
      }
      timeline={<SchemaTimeline sessionId={effectiveSessionId} session={currentSession} />}
      glossary={<ProductionCheatSheet />}
    />
  );
}

export default App;
