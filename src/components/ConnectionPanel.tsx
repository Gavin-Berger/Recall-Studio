import type { ConnectionStatus, RecallTimelineMoment } from "../types/recall";

type ConnectionPanelProps = {
  connection: ConnectionStatus;
  latestEvent?: RecallTimelineMoment;
  heartbeatCount: number;
};

export function ConnectionPanel({
  connection,
  latestEvent,
  heartbeatCount,
}: ConnectionPanelProps) {
  const statusLabel = connection.connected ? "ONLINE" : "WAITING";
  const statusClass = connection.connected ? "is-online" : "is-waiting";

  return (
    <aside className="connection-panel">
      <div className="panel-header">
        <div>
          <p className="eyebrow">Signal</p>
          <h2>Max Link</h2>
        </div>

        <span className={`status-pill ${statusClass}`}>{statusLabel}</span>
      </div>

      <div className="signal-core">
        <div className={`signal-orb ${statusClass}`} />

        <div>
          <p className="signal-title">
            {connection.connected
              ? "Receiving Ableton telemetry"
              : "Listening for Max for Live"}
          </p>

          <p className="signal-subtitle">UDP localhost · port 9000</p>
        </div>
      </div>

      <div className="telemetry-list">
        <div>
          <span>Last heartbeat</span>
          <strong>{formatHeartbeatAge(connection.last_heartbeat_ms)}</strong>
        </div>

        <div>
          <span>Heartbeat events</span>
          <strong>{heartbeatCount}</strong>
        </div>

        <div>
          <span>Last message</span>
          <strong>{connection.last_message ?? "None"}</strong>
        </div>

        <div>
          <span>Latest moment</span>
          <strong>{latestEvent?.type ?? "None"}</strong>
        </div>

        <div>
          <span>Protocol</span>
          <strong>Recall v1</strong>
        </div>
      </div>
    </aside>
  );
}

function formatHeartbeatAge(value: number | null): string {
  if (value === null) {
    return "No heartbeat";
  }

  if (value > 1_000_000_000_000) {
    const age = Date.now() - value;

    if (age < 0) {
      return "just now";
    }

    if (age < 1000) {
      return `${age}ms ago`;
    }

    return `${Math.floor(age / 1000)}s ago`;
  }

  if (value < 1000) {
    return `${value}ms ago`;
  }

  return `${Math.floor(value / 1000)}s ago`;
}
