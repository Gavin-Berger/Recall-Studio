import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./App.css";

type ConnectionStatus = {
  connected: boolean;
  last_heartbeat_ms: number | null;
  last_message: string | null;
};

type RecallEvent = {
  protocol: string;
  source: string;
  event_type: string;
  timestamp_ms: number;
  title: string;
  description: string;
  payload: string | null;
  session_id: string | null;
};

type SessionStatus = {
  active: boolean;
  session_id: string | null;
  started_at_ms: number | null;
  ended_at_ms: number | null;
};

type StorageStatus = {
  initialized: boolean;
  db_path: string | null;
};

function App() {
  const [connection, setConnection] = useState<ConnectionStatus>({
    connected: false,
    last_heartbeat_ms: null,
    last_message: null,
  });

  const [events, setEvents] = useState<RecallEvent[]>([]);

  const [session, setSession] = useState<SessionStatus>({
    active: false,
    session_id: null,
    started_at_ms: null,
    ended_at_ms: null,
  });

  const [storage, setStorage] = useState<StorageStatus>({
    initialized: false,
    db_path: null,
  });

  useEffect(() => {
    const pollBackend = async () => {
      try {
        const status = await invoke<ConnectionStatus>("get_connection_status");
        setConnection(status);
      } catch (error) {
        console.error("Failed to get connection status:", error);
      }

      try {
        const recentEvents = await invoke<RecallEvent[]>("get_recent_events");
        setEvents([...recentEvents].reverse());
      } catch (error) {
        console.error("Failed to get recent events:", error);
      }

      try {
        const sessionStatus = await invoke<SessionStatus>("get_session_status");
        setSession(sessionStatus);
      } catch (error) {
        console.error("Failed to get session status:", error);
      }

      try {
        const storageStatus = await invoke<StorageStatus>("get_storage_status");
        setStorage(storageStatus);
      } catch (error) {
        console.error("Failed to get storage status:", error);
      }
    };

    pollBackend();

    const interval = setInterval(pollBackend, 1000);

    return () => clearInterval(interval);
  }, []);

  const handleStartSession = async () => {
    try {
      const sessionStatus = await invoke<SessionStatus>("start_session");
      setSession(sessionStatus);
    } catch (error) {
      console.error("Failed to start session:", error);
    }
  };

  const handleStopSession = async () => {
    try {
      const sessionStatus = await invoke<SessionStatus>("stop_session");
      setSession(sessionStatus);
    } catch (error) {
      console.error("Failed to stop session:", error);
    }
  };

  const formatTime = (timestamp: number) => {
    const date = new Date(Number(timestamp));

    if (Number.isNaN(date.getTime())) {
      return "--:--:--";
    }

    return date.toLocaleTimeString();
  };

  const formatSessionStart = () => {
    if (!session.started_at_ms) {
      return "No session is currently being tracked.";
    }

    return `Started at ${formatTime(session.started_at_ms)}.`;
  };

  const trackedEventCount = events.filter(
    (event) => event.event_type !== "heartbeat",
  ).length;

  return (
    <main className="app-shell">
      <section className="hero">
        <p className="eyebrow">Recall Studio</p>
        <h1>Creative session memory for Ableton producers.</h1>
        <p className="subtitle">
          Track Ableton activity, review session history, and turn production
          work into clean session logs.
        </p>
      </section>

      <section className="status-grid">
        <div className="card">
          <span className="label">Max for Live</span>
          <strong className={connection.connected ? "online" : "offline"}>
            {connection.connected ? "Connected" : "Disconnected"}
          </strong>
          <p>
            {connection.connected
              ? "Receiving structured Recall Protocol events."
              : "Waiting for heartbeat from the Ableton device."}
          </p>
        </div>

        <div className="card">
          <span className="label">Active Session</span>
          <strong className={session.active ? "online" : "offline"}>
            {session.active ? "Tracking" : "Not Started"}
          </strong>
          <p>
            {session.active && session.session_id
              ? `Capturing activity for ${session.session_id}. ${formatSessionStart()}`
              : "No session is currently being tracked."}
          </p>
        </div>

        <div className="card">
          <span className="label">Storage</span>
          <strong className={storage.initialized ? "online" : "offline"}>
            {storage.initialized ? "Ready" : "Not Ready"}
          </strong>
          <p>
            {storage.initialized
              ? "Local session database initialized."
              : "Waiting for local storage setup."}
          </p>
        </div>
      </section>

      <section className="timeline-card">
        <div className="timeline-header">
          <h2>Live Session Activity</h2>
          <span>{trackedEventCount} Tracked Events</span>
        </div>

        <div className="timeline-events">
          {events.length === 0 ? (
            <p className="empty-state">No events received yet.</p>
          ) : (
            events.map((event, index) => (
              <div
                className="timeline-event"
                key={`${event.timestamp_ms}-${index}`}
              >
                <div className="timeline-time">
                  {formatTime(event.timestamp_ms)}
                </div>

                <div className="timeline-content">
                  <strong>{event.title}</strong>
                  <p>{event.description}</p>

                  {event.session_id && (
                    <small>Attached to {event.session_id}</small>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      </section>

      <section className="actions">
        <button onClick={handleStartSession} disabled={session.active}>
          Start Session
        </button>

        <button
          className="secondary"
          onClick={handleStopSession}
          disabled={!session.active}
        >
          Stop Session
        </button>

        <button className="secondary">Import Recording</button>
        <button className="secondary">Settings</button>
      </section>
    </main>
  );
}

export default App;
