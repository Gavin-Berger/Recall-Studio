import type {
  ConnectionStatus,
  PlaybackState,
  RecallTimelineMoment,
  SessionStats,
} from "../types/recall";
import { formatProducerMoment, producerEventIcon } from "../utils/producerEvents";
import { ProducerInsights } from "./ProducerInsights";

type ConnectionPanelProps = {
  connection: ConnectionStatus;
  events: RecallTimelineMoment[];
  latestEvent?: RecallTimelineMoment;
  selectedEvent?: RecallTimelineMoment;
  heartbeatCount: number;
  playback: PlaybackState;
  stats: SessionStats;
  bridgeCaptureDuration: string;
};

export function ConnectionPanel({
  connection,
  events,
  latestEvent,
  selectedEvent,
  heartbeatCount,
  playback,
  stats,
  bridgeCaptureDuration,
}: ConnectionPanelProps) {
  const statusClass = connection.connected ? "is-online" : "is-waiting";
  const selectedMoment = selectedEvent
    ? formatProducerMoment(selectedEvent)
    : null;

  return (
    <aside className="event-inspector">
      <section className="inspector-section inspector-section--primary">
        <div className="section-kicker">Inspector</div>

        {selectedEvent && selectedMoment ? (
          <div className="selected-moment">
            <div className="selected-moment__header">
              <span className={`event-glyph event-glyph--${selectedEvent.type}`}>
                {producerEventIcon(selectedEvent.type)}
              </span>
              <div>
                <p>{selectedEvent.sessionTimecode}</p>
                <h2>{selectedMoment.title}</h2>
              </div>
            </div>

            {selectedMoment.detail && (
              <p className="selected-moment__detail">{selectedMoment.detail}</p>
            )}

            <div className="inspector-grid">
              <InspectorValue label="Type" value={selectedMoment.categoryLabel} />
              <InspectorValue label="Source" value={selectedEvent.source ?? "Max for Live"} />
              <InspectorValue label="Group" value={readMetadata(selectedEvent, "group")} />
              <InspectorValue label="Track" value={selectedEvent.trackName ?? readMetadata(selectedEvent, "track")} />
              <InspectorValue label="Device" value={selectedEvent.deviceName ?? readMetadata(selectedEvent, "device")} />
              <InspectorValue label="Project Time" value={readMetadata(selectedEvent, "projectClock")} />
              <InspectorValue label="Position" value={readMetadata(selectedEvent, "arrangementPosition")} />
              <InspectorValue label="Tempo" value={formatBpm(selectedEvent.metadata?.bpm)} />
            </div>

            <details className="raw-payload-accordion">
              <summary>Protocol details</summary>
              <pre>{formatRawPayload(selectedEvent)}</pre>
            </details>
          </div>
        ) : (
          <div className="inspector-empty">
            <h2>No moment selected</h2>
            <p>Select a timecoded move to inspect its Ableton context.</p>
          </div>
        )}
      </section>

      <ProducerInsights events={events} stats={stats} />

      <section className="inspector-section">
        <div className="section-kicker">Bridge Health</div>

        <div className="signal-core">
          <div className={`signal-orb ${statusClass}`} />

          <div>
            <p className="signal-title">
              {connection.connected ? "Capture stream locked" : "Waiting for Ableton bridge"}
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
            <span>Project Time</span>
            <strong>{playback.projectClock ?? "Not reported"}</strong>
          </div>

          <div>
            <span>Arrangement</span>
            <strong>{playback.arrangementPosition ?? "No bar/beat"}</strong>
          </div>

          <div>
            <span>Selected Track</span>
            <strong>{playback.selectedTrack ?? "None"}</strong>
          </div>

          <div>
            <span>Heartbeat</span>
            <strong>{formatHeartbeatAge(connection.last_heartbeat_ms)}</strong>
          </div>

          <div>
            <span>Bridge Version</span>
            <strong>
              {connection.bridge_version
                ? `v${connection.bridge_version}`
                : connection.connected
                  ? "Reporting…"
                  : "Not connected"}
            </strong>
          </div>

          <div>
            <span>Capture Time</span>
            <strong>{bridgeCaptureDuration}</strong>
          </div>

          <div>
            <span>Bridge Pulses</span>
            <strong>{heartbeatCount}</strong>
          </div>

          <div>
            <span>Latest Move</span>
            <strong>{latestEvent ? formatProducerMoment(latestEvent).categoryLabel : "None"}</strong>
          </div>
        </div>
      </section>
    </aside>
  );
}

function InspectorValue({
  label,
  value,
}: {
  label: string;
  value?: string;
}) {
  return (
    <div>
      <span>{label}</span>
      <strong>{value ?? "None"}</strong>
    </div>
  );
}

function readMetadata(event: RecallTimelineMoment, key: string): string | undefined {
  const value = event.metadata?.[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function formatBpm(value: unknown): string | undefined {
  return typeof value === "number" ? `${formatNumber(value)} BPM` : undefined;
}

function formatRawPayload(event: RecallTimelineMoment): string {
  return JSON.stringify(
    {
      id: event.id,
      type: event.type,
      rawEventType: event.rawEventType,
      timelineRole: event.timelineRole,
      timestamp: event.timestamp,
      metadata: event.metadata,
      rawEvent: event.rawEvent,
    },
    null,
    2,
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
