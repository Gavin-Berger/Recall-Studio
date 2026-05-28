import type {
  ConnectionStatus,
  PlaybackState,
  RecallTimelineMoment,
  SessionStats,
} from "../types/recall";

type SignalStatusStripProps = {
  connection: ConnectionStatus;
  playback: PlaybackState;
  stats: SessionStats;
  latestEvent?: RecallTimelineMoment;
  bridgeCaptureDuration: string;
};

export function SignalStatusStrip({
  connection,
  playback,
  stats,
  latestEvent,
  bridgeCaptureDuration,
}: SignalStatusStripProps) {
  return (
    <footer className="signal-status-strip">
      <div className="status-strip__brand">
        <span className={connection.connected ? "capture-led is-live" : "capture-led"} />
        <div>
          <strong>Recall Studio</strong>
          <span>Signal Memory Console</span>
        </div>
      </div>

      <StatusCell
        label="Max Link"
        value={connection.connected ? "Locked" : "Waiting"}
        tone={connection.connected ? "live" : "meter"}
      />
      <StatusCell label="Heartbeat" value={formatHeartbeatAge(connection.last_heartbeat_ms)} />
      <StatusCell label="Capture Time" value={bridgeCaptureDuration} />
      <StatusCell
        label="Transport"
        value={playback.playing === null ? "Unknown" : playback.playing ? "Playing" : "Stopped"}
      />
      <StatusCell
        label="Tempo"
        value={typeof playback.tempo === "number" ? `${formatNumber(playback.tempo)} BPM` : "Unknown"}
      />
      <StatusCell
        label="Project Time"
        value={playback.projectClock ?? "Not reported"}
      />
      <StatusCell
        label="Bar"
        value={playback.arrangementPosition ?? "Not reported"}
      />
      <StatusCell
        label="Track"
        value={playback.selectedTrack ?? "No track selected"}
        wide
      />
      <StatusCell label="Captured" value={`${stats.creativeEvents} moves`} />
      <StatusCell label="Latest" value={latestEvent?.type ?? "None"} />
    </footer>
  );
}

function StatusCell({
  label,
  value,
  tone,
  wide = false,
}: {
  label: string;
  value: string;
  tone?: "live" | "meter";
  wide?: boolean;
}) {
  return (
    <div className={`status-cell ${wide ? "status-cell--wide" : ""} ${tone ? `is-${tone}` : ""}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function formatNumber(value: number): string {
  if (Number.isInteger(value)) {
    return String(value);
  }

  return value.toFixed(2).replace(/\.?0+$/, "");
}

function formatHeartbeatAge(value: number | null): string {
  if (value === null) {
    return "No pulse";
  }

  if (value > 1_000_000_000_000) {
    const age = Date.now() - value;

    if (age < 0) {
      return "Now";
    }

    if (age < 1000) {
      return `${age}ms`;
    }

    return `${Math.floor(age / 1000)}s`;
  }

  if (value < 1000) {
    return `${value}ms`;
  }

  return `${Math.floor(value / 1000)}s`;
}
