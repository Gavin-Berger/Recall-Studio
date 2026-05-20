import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./App.css";

type ConnectionStatus = {
  connected: boolean;
  last_heartbeat_ms: number | null;
  last_message: string | null;
};

function App() {
  const [connection, setConnection] = useState<ConnectionStatus>({
    connected: false,
    last_heartbeat_ms: null,
    last_message: null,
  });

  useEffect(() => {
    const interval = setInterval(async () => {
      try {
        const status = await invoke<ConnectionStatus>("get_connection_status");
        setConnection(status);
      } catch (error) {
        console.error("Failed to get connection status:", error);
      }
    }, 1000);

    return () => clearInterval(interval);
  }, []);

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

      <section className="actions">
        <button>Start Session</button>
        <button className="secondary">Import Recording</button>
        <button className="secondary">Settings</button>
      </section>
    </main>
  );
}

export default App;
