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
};

function App() {
  const [connection, setConnection] = useState<ConnectionStatus>({
    connected: false,
    last_heartbeat_ms: null,
    last_message: null,
  });

  const [events, setEvents] = useState<RecallEvent[]>([]);

  useEffect(() => {
    const interval = setInterval(async () => {
      try {
        const status = await invoke<ConnectionStatus>("get_connection_status");
        const recentEvents = await invoke<RecallEvent[]>("get_recent_events");

        setConnection(status);
        setEvents([...recentEvents].reverse());
      } catch (error) {
        console.error("Frontend polling failed:", error);
      }
    }, 1000);

    return () => clearInterval(interval);
  }, []);

  const formatTime = (timestamp: number) => {
    return new Date(timestamp).toLocaleTimeString();
  };

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
              ? "Receiving heartbeat from the Max for Live device."
              : "Waiting for heartbeat from the Ableton device."}
          </p>
        </div>

        <div className="card">
          <span className="label">Active Session</span>
          <strong>Not Started</strong>
          <p>No session is currently being tracked.</p>
        </div>

        <div className="card">
          <span className="label">Storage</span>
          <strong>Local First</strong>
          <p>All session data will be stored on this machine.</p>
        </div>
      </section>

      <section className="timeline-card">
        <div className="timeline-header">
          <h2>Live Session Activity</h2>
          <span>{events.length} Events</span>
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
                </div>
              </div>
            ))
          )}
        </div>
      </section>

      <section className="actions">
        <button>Start Session</button>
        <button className="secondary">Import Recording</button>
        <button className="secondary">Settings</button>
      </section>
    </main>
  );
}

export default App;
