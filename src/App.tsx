import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./App.css";

import { AppShell } from "./components/AppShell";
import type { AppSurface } from "./components/AppShell";
import { ProductionCheatSheet } from "./components/ProductionCheatSheet";
import { SchemaTimeline } from "./components/schema/SchemaTimeline";
import { HomeScreen } from "./features/home/HomeScreen";
import type { ConnectionStatus, SavedSessionMetadata } from "./types/recall";

const BACKEND_CONNECTION_COMMAND = "get_connection_status";
const BACKEND_LIST_SESSIONS_COMMAND = "list_saved_sessions";
const BACKEND_START_NEW_SESSION_COMMAND = "start_new_session";

const POLL_INTERVAL_MS = 1000;

// The milestone app is intentionally lean: a landing page, the schema-driven
// timeline (which fetches its own normalized data per session), and the glossary.
// The raw live-event stream and its derived/curated views were retired in favour
// of the persisted schema projection the timeline renders.
function App() {
  const [surface, setSurface] = useState<AppSurface>("home");
  const [connection, setConnection] = useState<ConnectionStatus>({
    connected: false,
    last_heartbeat_ms: null,
    last_message: null,
    bridge_version: null,
  });
  const [savedSessions, setSavedSessions] = useState<SavedSessionMetadata[]>([]);
  // The session the timeline is viewing. Null falls back to the active session.
  const [timelineSessionId, setTimelineSessionId] = useState<string | null>(null);

  const activeSession = useMemo(
    () => savedSessions.find((session) => session.ended_at_ms === null) ?? null,
    [savedSessions],
  );

  const effectiveSessionId = timelineSessionId ?? activeSession?.id ?? null;

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
        const sessions = await invoke<SavedSessionMetadata[]>(
          BACKEND_LIST_SESSIONS_COMMAND,
        );
        if (mounted) setSavedSessions(sessions);
      } catch (error) {
        console.error("Failed to list saved sessions:", error);
      }
    }

    refreshSavedSessions();
    const interval = window.setInterval(refreshSavedSessions, POLL_INTERVAL_MS);

    return () => {
      mounted = false;
      window.clearInterval(interval);
    };
  }, []);

  function handleOpenSession(sessionId: string) {
    setTimelineSessionId(sessionId);
    setSurface("timeline");
  }

  function handleOpenTimeline() {
    setTimelineSessionId(activeSession?.id ?? null);
    setSurface("timeline");
  }

  async function handleStartNewSession() {
    try {
      await invoke(BACKEND_START_NEW_SESSION_COMMAND);
      const sessions = await invoke<SavedSessionMetadata[]>(
        BACKEND_LIST_SESSIONS_COMMAND,
      );
      setSavedSessions(sessions);
      const nextActive =
        sessions.find((session) => session.ended_at_ms === null) ?? null;
      setTimelineSessionId(nextActive?.id ?? null);
      setSurface("timeline");
    } catch (error) {
      console.error("Failed to start a new session:", error);
    }
  }

  return (
    <AppShell
      surface={surface}
      onChangeSurface={setSurface}
      connected={connection.connected}
      home={
        <HomeScreen
          connection={connection}
          sessions={savedSessions}
          activeSession={activeSession}
          onStartNewSession={handleStartNewSession}
          onOpenTimeline={handleOpenTimeline}
          onOpenSession={handleOpenSession}
        />
      }
      timeline={<SchemaTimeline sessionId={effectiveSessionId} />}
      glossary={<ProductionCheatSheet />}
    />
  );
}

export default App;
