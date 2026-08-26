import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import "./App.css";

import { AppShell } from "./components/AppShell";
import type { AppSurface } from "./components/AppShell";
import { SettingsDialog } from "./components/SettingsDialog";
import type { StudioTheme } from "./components/SettingsDialog";
import { ProductionCheatSheet } from "./components/ProductionCheatSheet";
import { SchemaTimeline } from "./components/schema/SchemaTimeline";
import {
  NotesScreen,
  PlannerScreen,
  ProjectBriefingScreen,
  ProjectManagerScreen,
  ProjectOrganizerScreen,
  ProjectVersionsScreen,
  SessionRecapScreen,
  StartupScreen,
} from "./features";
import { ReportDialog } from "./features/diagnostics/ReportDialog";
import { organizerRepository } from "./features/organizer/repository";
import { listPlannerTasks } from "./features/planner/api";
import {
  dailyPlanContent,
  delayUntilDailyPlan,
  loadDailyPlanReminder,
  requestDailyPlanPermission,
  sendDailyPlanNotification,
  storeDailyPlanReminder,
} from "./features/planner/notifications";
import { localDateKey } from "./features/planner/planner";
import { abletonSetName } from "./features/sessionFormat";
import {
  REPORT_PREVIEW_SESSION_ID,
  reportPreviewSessions,
} from "./features/projects/sessionReportPreview";
import type {
  ConnectionStatus,
  DailyPlanReminderSettings,
  SavedProject,
  SavedSessionMetadata,
  SessionStatus,
} from "./types";

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

type FolderMetadataRefresh = {
  refreshed: number;
  unavailable: number;
};

const POLL_INTERVAL_MS = 1000;
const BACKGROUND_POLL_INTERVAL_MS = 30_000;
const PRODUCER_NAME_STORAGE_KEY = "recall-studio.producer-name";
const THEME_STORAGE_KEY = "recall-studio.theme";
const REPORT_PREVIEW =
  import.meta.env.DEV &&
  new URLSearchParams(window.location.search).get("reportPreview") === "1";

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

function loadTheme(): StudioTheme {
  try {
    return window.localStorage.getItem(THEME_STORAGE_KEY) === "mono" ? "mono" : "blue";
  } catch {
    return "blue";
  }
}

function storeTheme(theme: StudioTheme) {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Local storage can be unavailable in a few embedded/browser contexts.
  }
}

function isTypingTarget(target: EventTarget | null): boolean {
  const element = target instanceof HTMLElement ? target : null;
  return Boolean(element?.closest("input, textarea, select, [contenteditable='true']"));
}

function App() {
  const [surface, setSurface] = useState<AppSurface>(REPORT_PREVIEW ? "recap" : "projects");
  const [reportOpen, setReportOpen] = useState(false);
  const [connection, setConnection] = useState<ConnectionStatus>({
    connected: false,
    last_heartbeat_ms: null,
    last_message: null,
    bridge_version: null,
  });
  const [savedSessions, setSavedSessions] = useState<SavedSessionMetadata[]>(
    REPORT_PREVIEW ? reportPreviewSessions : [],
  );
  const [savedProjects, setSavedProjects] = useState<SavedProject[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(
    REPORT_PREVIEW ? REPORT_PREVIEW_SESSION_ID : null,
  );
  // Which project the versions surface is showing. The library poll keeps the
  // project object itself fresh, so new .als versions appear while you look.
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [libraryReady, setLibraryReady] = useState(REPORT_PREVIEW);
  const [enteredStudio, setEnteredStudio] = useState(REPORT_PREVIEW);
  const [producerName, setProducerName] = useState(loadProducerName);
  const [theme, setTheme] = useState<StudioTheme>(loadTheme);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [dailyPlanReminder, setDailyPlanReminder] = useState<DailyPlanReminderSettings>(loadDailyPlanReminder);
  const [inTrayBackground, setInTrayBackground] = useState(false);
  const pollInterval = inTrayBackground ? BACKGROUND_POLL_INTERVAL_MS : POLL_INTERVAL_MS;

  useEffect(() => {
    document.documentElement.dataset.recallTheme = theme;
    storeTheme(theme);
  }, [theme]);

  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | undefined;
    void listen<boolean>("recall://window-visibility", (event) => {
      setInTrayBackground(!event.payload);
    }).then((dispose) => {
      unlisten = dispose;
    });
    return () => unlisten?.();
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | undefined;
    void listen("recall://open-planner", () => {
      setEnteredStudio(true);
      setSurface("planner");
    }).then((dispose) => {
      unlisten = dispose;
    });
    return () => unlisten?.();
  }, []);

  const sendTodayStudioPlan = useCallback(async (): Promise<boolean> => {
    try {
      const [tasks, releases] = await Promise.all([
        listPlannerTasks(),
        organizerRepository().load(),
      ]);
      return await sendDailyPlanNotification(dailyPlanContent(tasks, releases, localDateKey(new Date())));
    } catch (error) {
      console.error("Failed to send the daily studio plan:", error);
      return false;
    }
  }, []);

  const handleDailyPlanReminderChange = useCallback(async (next: DailyPlanReminderSettings): Promise<boolean> => {
    try {
      if (next.enabled && !dailyPlanReminder.enabled && !(await requestDailyPlanPermission())) {
        return false;
      }
      setDailyPlanReminder(next);
      storeDailyPlanReminder(next);
      return true;
    } catch (error) {
      console.error("Failed to update daily studio plan reminder:", error);
      return false;
    }
  }, [dailyPlanReminder.enabled]);

  // The timer is deliberately one-shot and rescheduled only after it fires.
  // It costs no recurring background work between reminders, while the tray
  // keeps the app alive after the main window has been closed.
  useEffect(() => {
    if (!dailyPlanReminder.enabled) return;
    let cancelled = false;
    let timer: number | undefined;

    const scheduleNext = () => {
      timer = window.setTimeout(async () => {
        if (cancelled) return;
        await sendTodayStudioPlan();
        if (!cancelled) scheduleNext();
      }, delayUntilDailyPlan(new Date(), dailyPlanReminder.time));
    };

    scheduleNext();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [dailyPlanReminder.enabled, dailyPlanReminder.time, sendTodayStudioPlan]);

  useEffect(() => {
    function handleKeyboardNavigation(event: KeyboardEvent) {
      if (event.key === "Escape" && settingsOpen) {
        event.preventDefault();
        setSettingsOpen(false);
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key === ",") {
        event.preventDefault();
        setSettingsOpen(true);
        return;
      }
      if (!event.altKey || event.ctrlKey || event.metaKey || isTypingTarget(event.target)) return;
      const destinations: Record<string, AppSurface> = {
        "1": "projects",
        "2": "recap",
        "3": "timeline",
        "4": "organizer",
        "5": "planner",
        "6": "notes",
        "7": "glossary",
      };
      const destination = destinations[event.key];
      if (!destination) return;
      event.preventDefault();
      setSurface(destination);
    }

    window.addEventListener("keydown", handleKeyboardNavigation);
    return () => window.removeEventListener("keydown", handleKeyboardNavigation);
  }, [settingsOpen]);

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
  const selectedProject = useMemo(
    () => savedProjects.find((project) => project.id === selectedProjectId) ?? null,
    [savedProjects, selectedProjectId],
  );
  const currentTimelineProject = useMemo(
    () =>
      currentSession?.project_id
        ? savedProjects.find((project) => project.id === currentSession.project_id) ?? null
        : null,
    [currentSession?.project_id, savedProjects],
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
    // The browser preview is useful for visual QA, but it has no Tauri bridge.
    // Do not turn that expected absence into an error every second.
    if (!isTauri()) return;
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
    const interval = window.setInterval(pollConnection, pollInterval);

    return () => {
      mounted = false;
      window.clearInterval(interval);
    };
  }, [pollInterval]);

  useEffect(() => {
    // Mark the local browser preview ready with its empty in-memory state rather
    // than continuously attempting unavailable native storage calls.
    if (!isTauri()) {
      setLibraryReady(true);
      return;
    }
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
    const interval = window.setInterval(refreshSavedSessions, pollInterval);

    return () => {
      mounted = false;
      window.clearInterval(interval);
    };
  }, [pollInterval, reloadLibrary]);

  function handleOpenTimeline(sessionId?: string) {
    setSelectedSessionId(sessionId ?? effectiveSessionId);
    setSurface("timeline");
  }

  function handleOpenRecap(sessionId?: string) {
    setSelectedSessionId(sessionId ?? effectiveSessionId);
    setSurface("recap");
  }

  // Open a project → land on its re-entry briefing (where did I leave off), the
  // hero surface for a song. The version list is one click away from there.
  function handleOpenVersions(projectId: string) {
    setSelectedProjectId(projectId);
    setSurface("briefing");
  }

  // Open a project for work: resume the take for the version open in Ableton (or
  // the most recent), then jump into its timeline. The "take me to v8" path.
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

  // End the running take and open a fresh one.
  //
  // Switching Ableton projects does NOT re-point a take: once a capture is bound
  // to a project that binding is permanent (storage.rs only attaches project_id
  // when it is still NULL). So a take started on one set keeps swallowing moves
  // made in the next one. Ending it starts a capture with no project yet, which
  // the next event from Ableton binds to the set that is actually open.
  async function handleEndTake() {
    try {
      const status = await invoke<SessionStatus>("start_new_session");
      await reloadLibrary();
      setSelectedSessionId(status.session_id);
    } catch (error) {
      console.error("Failed to end take:", error);
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

  async function handleRefreshFolderMetadata(): Promise<FolderMetadataRefresh> {
    const result = await invoke<FolderMetadataRefresh>("refresh_project_folder_metadata");
    await reloadProjects();
    return result;
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
        activeAbletonName={abletonSetName(activeSession ?? null)}
        hasActiveSession={activeSession !== null}
        onProducerNameChange={handleProducerNameChange}
        onEnter={() => setEnteredStudio(true)}
      />
    );
  }

  return (
    <>
    <AppShell
      surface={surface}
      onChangeSurface={setSurface}
      connected={connection.connected}
      onOpenStartup={() => setEnteredStudio(false)}
      onOpenReport={() => setReportOpen(true)}
      onOpenSettings={() => setSettingsOpen(true)}
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
          onRefreshFolderMetadata={handleRefreshFolderMetadata}
          onOpenVersions={handleOpenVersions}
          onStartCapture={handleStartCapture}
          onNewTake={handleNewTake}
          onEndTake={handleEndTake}
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
      briefing={
        <ProjectBriefingScreen
          project={selectedProject}
          onBack={() => setSurface("projects")}
          onOpenAllVersions={() => setSurface("versions")}
          onOpenTimeline={handleOpenTimeline}
          onOpenRecap={handleOpenRecap}
        />
      }
      versions={
        <ProjectVersionsScreen
          project={selectedProject}
          connection={connection}
          onBack={() => setSurface("briefing")}
          onOpenProject={handleOpenProject}
          onRescanFolder={handleRescanFolder}
          onConnectFolder={handleConnectFolder}
          onOpenTimeline={handleOpenTimeline}
          onOpenRecap={handleOpenRecap}
          onDeleteCapture={handleDeleteCapture}
          onListProjectAlsFiles={handleListProjectAlsFiles}
          onRelinkTake={handleRelinkTake}
        />
      }
      recap={
        <SessionRecapScreen
          sessionId={effectiveSessionId}
          sessions={savedSessions}
          onSelectSession={handleOpenRecap}
          onOpenTimeline={handleOpenTimeline}
          onOpenProjects={() => setSurface("projects")}
        />
      }
      timeline={
        <SchemaTimeline
          sessionId={effectiveSessionId}
          session={currentSession}
          project={currentTimelineProject}
          producerName={producerName}
          onOpenProjects={() => setSurface("projects")}
          onStartCapture={(projectId) => void handleOpenProject(projectId)}
          onOpenTimeline={handleOpenTimeline}
        />
      }
      organizer={
        <ProjectOrganizerScreen
          showNowPlaying={surface !== "organizer"}
          onOpenOrganizer={() => setSurface("organizer")}
        />
      }
      planner={
        <PlannerScreen
          projects={savedProjects}
          onOpenOrganizer={() => setSurface("organizer")}
          onOpenTimeline={handleOpenTimeline}
        />
      }
      notes={<NotesScreen />}
      glossary={<ProductionCheatSheet />}
    />
    <SettingsDialog
      open={settingsOpen}
      theme={theme}
      onThemeChange={setTheme}
      dailyPlanReminder={dailyPlanReminder}
      onDailyPlanReminderChange={handleDailyPlanReminderChange}
      onSendTestReminder={sendTodayStudioPlan}
      connection={connection}
      onClose={() => setSettingsOpen(false)}
    />
    <ReportDialog
      open={reportOpen}
      onClose={() => setReportOpen(false)}
      connection={connection}
    />
    </>
  );
}

export default App;
