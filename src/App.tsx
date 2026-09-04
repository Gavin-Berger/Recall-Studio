import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import "./App.css";

import { AppShell } from "./components/AppShell";
import type { AppSurface } from "./components/AppShell";
import { SettingsDialog } from "./components/SettingsDialog";
import type { StudioTheme } from "./components/SettingsDialog";
import { ProductionCheatSheet } from "./components/ProductionCheatSheet";
import {
  NotesScreen,
  PlannerScreen,
  ProjectBriefingScreen,
  ProjectManagerScreen,
  ProjectOrganizerScreen,
  ProjectVersionsScreen,
  SessionRecapScreen,
  StartupScreen,
  VersionTimelineScreen,
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
  requestNotificationPermission,
  sendDesktopNotification,
  storeDailyPlanReminder,
} from "./features/planner/notifications";
import { localDateKey } from "./features/planner/planner";
import { libraryPollInterval } from "./libraryPolling";
import {
  loadSaveReminderEnabled,
  saveReminder,
  storeSaveReminderEnabled,
} from "./features/projects/saveReminder";
import { getObservedSaves } from "./lib/schema/api";
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

/**
 * Is this the same connection status we already have?
 *
 * Every field, so a real change is never swallowed — the point is to skip
 * identical objects, not to stop noticing.
 */
function sameConnection(left: ConnectionStatus, right: ConnectionStatus): boolean {
  return (
    left.connected === right.connected &&
    left.last_heartbeat_ms === right.last_heartbeat_ms &&
    left.last_message === right.last_message &&
    left.bridge_version === right.bridge_version
  );
}

const POLL_INTERVAL_MS = 1000;
const BACKGROUND_POLL_INTERVAL_MS = 30_000;
/**
 * How often unsaved work is checked while a capture is live.
 *
 * Five minutes, not five seconds: the rule will not fire until twenty
 * minutes of unsaved work anyway, so a tighter loop buys nothing but a query.
 */
const SAVE_REMINDER_CHECK_MS = 5 * 60_000;
const PRODUCER_NAME_STORAGE_KEY = "recall-studio.producer-name";
const THEME_STORAGE_KEY = "recall-studio.theme";
const REPORT_PREVIEW =
  import.meta.env.DEV &&
  new URLSearchParams(window.location.search).get("reportPreview") === "1";
const TIMELINE_PREVIEW =
  import.meta.env.DEV &&
  new URLSearchParams(window.location.search).get("timelinePreview") === "1";
const PREVIEW_MODE = REPORT_PREVIEW || TIMELINE_PREVIEW;

// Local visual QA for the Timeline uses the same two version-shaped preview
// captures as the Report. It is development-only and never touches a user's
// library; the real Timeline continues to read from saved projects.
const timelinePreviewProject: SavedProject = {
  id: "preview-project",
  display_name: "Nightdrive",
  ableton_name: "Nightdrive",
  ableton_path: "C:\\Music\\Nightdrive",
  archived_at_ms: null,
  created_at_ms: reportPreviewSessions[0]?.started_at_ms ?? 0,
  updated_at_ms: reportPreviewSessions.at(-1)?.last_updated_at_ms ?? 0,
  last_updated_at_ms: reportPreviewSessions.at(-1)?.last_updated_at_ms ?? 0,
  capture_count: reportPreviewSessions.length,
  active_capture_count: 0,
  captures: reportPreviewSessions,
};

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
  const [surface, setSurface] = useState<AppSurface>(
    REPORT_PREVIEW ? "recap" : TIMELINE_PREVIEW ? "timeline" : "projects",
  );
  const [reportOpen, setReportOpen] = useState(false);
  const [connection, setConnection] = useState<ConnectionStatus>({
    connected: false,
    last_heartbeat_ms: null,
    last_message: null,
    bridge_version: null,
  });
  const [savedSessions, setSavedSessions] = useState<SavedSessionMetadata[]>(
    PREVIEW_MODE ? reportPreviewSessions : [],
  );
  const [savedProjects, setSavedProjects] = useState<SavedProject[]>(
    TIMELINE_PREVIEW ? [timelinePreviewProject] : [],
  );
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(
    PREVIEW_MODE ? REPORT_PREVIEW_SESSION_ID : null,
  );
  // Which project the versions surface is showing. The library poll keeps the
  // project object itself fresh, so new .als versions appear while you look.
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(
    TIMELINE_PREVIEW ? timelinePreviewProject.id : null,
  );
  const [libraryReady, setLibraryReady] = useState(PREVIEW_MODE);
  const [enteredStudio, setEnteredStudio] = useState(PREVIEW_MODE);
  const [producerName, setProducerName] = useState(loadProducerName);
  const [theme, setTheme] = useState<StudioTheme>(loadTheme);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [dailyPlanReminder, setDailyPlanReminder] = useState<DailyPlanReminderSettings>(loadDailyPlanReminder);
  const [inTrayBackground, setInTrayBackground] = useState(false);
  const [saveReminderEnabled, setSaveReminderEnabled] = useState(loadSaveReminderEnabled);
  // Not state: changing it must never re-render, and the rule reads it to
  // avoid repeating itself for one stretch of unsaved work.
  const lastSaveReminderMs = useRef<number | null>(null);
  const pollInterval = inTrayBackground ? BACKGROUND_POLL_INTERVAL_MS : POLL_INTERVAL_MS;
  // The library is not a live fact. It only changes when a capture writes to
  // it, so its refresh follows the capture instead of the clock — see
  // libraryPolling.ts. The 1Hz poll above stays, for connection status alone.
  const libraryInterval = libraryPollInterval({
    inTrayBackground,
    captureConnected: connection.connected,
  });

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

  // Surfaces share the window scroll position. Starting each new destination at
  // its title avoids landing halfway through a different screen after a long
  // report, planner, or reference browse.
  useEffect(() => {
    if (!enteredStudio) return;
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
  }, [enteredStudio, surface]);

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

  const handleSaveReminderChange = useCallback(async (enabled: boolean): Promise<boolean> => {
    // The OS prompt IS the opt-in. Turning it on without permission would leave
    // a switch that says "on" and does nothing.
    if (enabled && !(await requestNotificationPermission())) return false;
    setSaveReminderEnabled(enabled);
    storeSaveReminderEnabled(enabled);
    if (!enabled) lastSaveReminderMs.current = null;
    return true;
  }, []);

  // Nudge the producer when work has been going a while with nothing written.
  //
  // Rides the connection poll's cadence rather than a timer of its own: the
  // reminder is only ever relevant while a capture is live, which is exactly
  // when that poll is already running. The decision itself is in
  // saveReminder.ts, so this effect only gathers the facts.
  useEffect(() => {
    if (!saveReminderEnabled || !isTauri()) return;
    const sessionId = currentSession?.id ?? null;
    if (!sessionId || currentSession?.capture_status !== "active") return;

    let cancelled = false;

    async function check() {
      try {
        const saves = await getObservedSaves([sessionId!]);
        if (cancelled) return;
        const lastSaveMs = saves.length > 0 ? saves[saves.length - 1]!.saved_at_ms : null;

        const reminder = saveReminder({
          nowMs: Date.now(),
          lastSaveMs,
          lastActivityMs: currentSession?.last_updated_at_ms ?? null,
          captureStartedMs: currentSession?.started_at_ms ?? null,
          lastRemindedMs: lastSaveReminderMs.current,
          setName: abletonSetName(currentSession ?? null),
        });
        if (!reminder || cancelled) return;

        // Stamped BEFORE awaiting the send: a slow notification must not let a
        // second check through and fire the same reminder twice.
        lastSaveReminderMs.current = Date.now();
        await sendDesktopNotification(reminder, "the save reminder");
      } catch (error) {
        console.error("Failed to check for unsaved work:", error);
      }
    }

    void check();
    const interval = window.setInterval(() => void check(), SAVE_REMINDER_CHECK_MS);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [
    saveReminderEnabled,
    currentSession?.id,
    currentSession?.capture_status,
    currentSession?.last_updated_at_ms,
    currentSession?.started_at_ms,
    currentSession?.als_path,
  ]);


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
        // Replace the object ONLY when something in it actually changed.
        //
        // This poll runs once a second and used to hand React a brand-new
        // object every time, unchanged or not. A new object is a new state
        // value, so App re-rendered every second and took the whole tree with
        // it — including the Timeline's several hundred movement cards and
        // their piano-roll SVGs. That is a full reconciliation at 1Hz, felt as
        // a regular hitch while scrolling, and it happened with Ableton closed
        // and nothing capturing, because the poll does not care either way.
        if (mounted) setConnection((current) => (sameConnection(current, status) ? current : status));
      } catch (error) {
        console.error("Failed to get connection status:", error);
        if (mounted) {
          setConnection((current) => (current.connected ? { ...current, connected: false } : current));
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

    // Runs immediately on every interval change too, which is what makes
    // connecting Ableton feel instant: the moment `connected` flips, this
    // effect re-runs and reads the library once before the faster timer starts.
    refreshSavedSessions();
    const interval = window.setInterval(refreshSavedSessions, libraryInterval);

    return () => {
      mounted = false;
      window.clearInterval(interval);
    };
  }, [libraryInterval, reloadLibrary]);

  // "Open timeline" everywhere in the app means the project's version history.
  //
  // It used to mean the per-capture workspace — one sitting, its events on a
  // ruler. That surface is stashed (SchemaTimeline is still in the tree, routed
  // to from nowhere) because the version graph is the surface that is supposed
  // to answer "what happened", and two answers to that question is one too many.
  // The capture is still carried: the graph selects the version containing it.
  function handleOpenTimeline(sessionId?: string) {
    setSelectedSessionId(sessionId ?? effectiveSessionId);
    setSurface("timeline");
  }

  // The Timeline proper: a project's whole history as a graph.
  function handleOpenHistory(projectId: string) {
    setSelectedProjectId(projectId);
    setSurface("timeline");
  }

  // Where you click decides what the report covers. Opening from a project
  // opens the whole project; opening from a row opens that one sitting. The
  // producer never has to find a scope control to get the report they meant —
  // the control is there to move between scopes afterwards, not to reach the
  // right one in the first place.
  const [openReportScope, setOpenReportScope] = useState<"sitting" | "version" | "project">("sitting");

  function handleOpenRecap(
    sessionId?: string,
    scope: "sitting" | "version" | "project" = "sitting",
  ) {
    setSelectedSessionId(sessionId ?? effectiveSessionId);
    setOpenReportScope(scope);
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
        setSelectedProjectId(projectId);
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
      if (projectId) setSelectedProjectId(projectId);
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
      if (projectId) setSelectedProjectId(projectId);
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
          openScope={openReportScope}
          onSelectSession={handleOpenRecap}
          onOpenTimeline={handleOpenTimeline}
          onOpenProjects={() => setSurface("projects")}
        />
      }
      timeline={
        <VersionTimelineScreen
          projects={savedProjects}
          projectId={selectedProjectId ?? currentTimelineProject?.id ?? null}
          onSelectProject={handleOpenHistory}
          focusSessionId={selectedSessionId}
          onOpenReport={(sessionId) => handleOpenRecap(sessionId, "version")}
          onOpenProjects={() => setSurface("projects")}
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
      notes={<NotesScreen projects={savedProjects} onOpenTimeline={handleOpenHistory} />}
      glossary={<ProductionCheatSheet />}
    />
    <SettingsDialog
      open={settingsOpen}
      theme={theme}
      onThemeChange={setTheme}
      dailyPlanReminder={dailyPlanReminder}
      onDailyPlanReminderChange={handleDailyPlanReminderChange}
      saveReminderEnabled={saveReminderEnabled}
      onSaveReminderChange={handleSaveReminderChange}
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
