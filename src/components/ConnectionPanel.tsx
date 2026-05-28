import type {
  ConnectionStatus,
  PlaybackState,
  RecallTimelineMoment,
} from "../types/recall";

type ConnectionPanelProps = {
  connection: ConnectionStatus;
  latestEvent?: RecallTimelineMoment;
  heartbeatCount: number;
  playback: PlaybackState;
};

export function ConnectionPanel({
  connection,
  latestEvent,
  heartbeatCount,
  playback,
}: ConnectionPanelProps) {
  const statusLabel = connection.connected ? "ONLINE" : "WAITING";
  const statusClass = connection.connected ? "is-online" : "is-waiting";

  return (
    <aside className="connection-panel">
      <div className="panel-header">
        <div>
          <p className="eyebrow">Signal</p>
          <h2>Live Bridge</h2>
        </div>

        <span className={`status-pill ${statusClass}`}>{statusLabel}</span>
      </div>

      <div className="signal-core">
        <div className={`signal-orb ${statusClass}`} />

        <div>
          <p className="signal-title">
            {connection.connected
              ? "Capture stream locked"
              : "Waiting for Ableton bridge"}
          </p>

          <p className="signal-subtitle">UDP localhost - port 9000</p>
        </div>
      </div>

      <div className="telemetry-list">
        <div>
          <span>Transport</span>
          <strong>{formatPlaybackStatus(playback.playing)}</strong>
        </div>

        <div>
          <span>Tempo</span>
          <strong>
            {typeof playback.tempo === "number"
              ? `${formatNumber(playback.tempo)} BPM`
              : "Unknown"}
          </strong>
        </div>

        <div>
          <span>Arrangement Position</span>
          <strong>{playback.arrangementPosition ?? "Not reported"}</strong>
        </div>

        <div>
          <span>Selected Track</span>
          <strong>{playback.selectedTrack ?? "None"}</strong>
        </div>

        <div>
          <span>Last heartbeat</span>
          <strong>{formatHeartbeatAge(connection.last_heartbeat_ms)}</strong>
        </div>

        <div>
          <span>Bridge pulses</span>
          <strong>{heartbeatCount}</strong>
        </div>

        <div>
          <span>Last bridge signal</span>
          <strong>{connection.last_message ?? "None"}</strong>
        </div>

        <div>
          <span>Latest move</span>
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

function formatPlaybackStatus(playing: boolean | null): string {
  if (playing === null) {
    return "Unknown";
  }

  return playing ? "Playing" : "Stopped";
}

function formatNumber(value: number): string {
  if (Number.isInteger(value)) {
    return String(value);
  }

  return value.toFixed(2).replace(/\.?0+$/, "");
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
