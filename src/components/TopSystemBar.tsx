import type { ConnectionStatus } from "../types/recall";

type TopSystemBarProps = {
  connection: ConnectionStatus;
  eventCount: number;
};

export function TopSystemBar({ connection, eventCount }: TopSystemBarProps) {
  return (
    <header className="top-system-bar">
      <div className="brand-lockup">
        <p className="eyebrow">Recall Studio</p>
        <h1>Creative Telemetry</h1>
      </div>

      <div className="top-system-meta">
        <span>Native Desktop</span>
        <span>Rust/Tauri</span>
        <span>Max for Live</span>
        <span>{eventCount} events</span>
        <span className={connection.connected ? "meta-live" : "meta-waiting"}>
          {connection.connected ? "Max Link Online" : "Waiting for Max"}
        </span>
      </div>
    </header>
  );
}
