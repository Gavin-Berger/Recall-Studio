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
        <h1>Session Recall</h1>
      </div>

      <div className="top-system-meta">
        <span>Local Memory</span>
        <span>Ableton Live</span>
        <span>Max Bridge</span>
        <span>{eventCount} moments</span>
        <span className={connection.connected ? "meta-live" : "meta-waiting"}>
          {connection.connected ? "Capture Armed" : "Waiting for Live"}
        </span>
      </div>
    </header>
  );
}
