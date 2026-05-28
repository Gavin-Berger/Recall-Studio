import type {
  RecallTimelineMoment,
  SavedSessionMetadata,
  SessionStats,
  SessionViewMode,
} from "../types/recall";
import { TelemetryStat } from "./TelemetryStat";

type SessionOverviewProps = {
  events: RecallTimelineMoment[];
  stats: SessionStats;
  sessions: SavedSessionMetadata[];
  selectedSessionId: string | null;
  viewMode: SessionViewMode;
  onSelectLiveSession: () => void;
  onSelectSavedSession: (sessionId: string) => void;
  onStartNewSession: () => void;
  onDeleteSavedSession: (sessionId: string) => void;
};

export function SessionOverview({
  events,
  stats,
  sessions,
  selectedSessionId,
  viewMode,
  onSelectLiveSession,
  onSelectSavedSession,
  onStartNewSession,
  onDeleteSavedSession,
}: SessionOverviewProps) {
  const latestTrack = [...events]
    .reverse()
    .find((event) => event.trackName || event.metadata?.track);

  const latestDevice = [...events]
    .reverse()
    .find((event) => event.deviceName || event.metadata?.device);

  const latestCreativeEvent = [...events]
    .reverse()
    .find((event) => event.type !== "heartbeat");

  const focusTrack =
    latestTrack?.trackName ?? latestTrack?.metadata?.track ?? "No track selected";
  const focusDevice =
    latestDevice?.deviceName ?? latestDevice?.metadata?.device ?? "No device activity";

  return (
    <aside className="session-overview">
      <div className="panel-header">
        <div>
          <p className="eyebrow">{viewMode === "live" ? "Now Recording" : "Saved Take"}</p>
          <h2>Session Focus</h2>
        </div>
      </div>

      <div className="session-title-block">
        <p className="session-label">
          {viewMode === "live" ? "Current Take" : "Recall Take"}
        </p>
        <h1>{viewMode === "live" ? "Live Capture" : "Saved Session"}</h1>
        <span>
          {viewMode === "live"
            ? "Writing Ableton moves to local memory"
            : "Reviewing a recorded production pass"}
        </span>
      </div>

      <div className="focus-stack">
        <div className="focus-card focus-card--track">
          <span>Focus Track</span>
          <strong>{String(focusTrack)}</strong>
        </div>

        <div className="focus-card focus-card--device">
          <span>Active Device</span>
          <strong>{String(focusDevice)}</strong>
        </div>
      </div>

      <div className="session-history">
        <div className="session-history__header">
          <span>Local Takes</span>
          <button type="button" onClick={onStartNewSession}>
            New
          </button>
        </div>

        <button
          type="button"
          className={`session-row ${viewMode === "live" ? "is-active" : ""}`}
          onClick={onSelectLiveSession}
        >
          <span>
            <strong>Live Capture</strong>
            <small>Current Ableton stream</small>
          </span>
          <em>{stats.creativeEvents}</em>
        </button>

        <div className="session-history__list">
          {sessions.length === 0 ? (
            <p className="session-history__empty">No saved sessions yet.</p>
          ) : (
            sessions.map((session) => (
              <div
                key={session.id}
                className={`session-row ${
                  viewMode === "saved" && selectedSessionId === session.id
                    ? "is-active"
                    : ""
                }`}
              >
                <button
                  type="button"
                  className="session-row__main"
                  onClick={() => onSelectSavedSession(session.id)}
                >
                  <span>
                    <strong>{session.name}</strong>
                    <small>{formatSessionDate(session.started_at_ms)}</small>
                  </span>
                  <em>{session.creative_event_count}</em>
                </button>

                <button
                  type="button"
                  className="session-row__delete"
                  title="Delete local session history"
                  aria-label={`Delete ${session.name}`}
                  onClick={() => onDeleteSavedSession(session.id)}
                >
                  Delete
                </button>
              </div>
            ))
          )}
        </div>
      </div>

      <div className="stat-grid">
        <TelemetryStat label="Moments" value={stats.creativeEvents} />
        <TelemetryStat label="Transport" value={stats.transportEvents} />
        <TelemetryStat label="Tempo" value={stats.tempoEvents} />
        <TelemetryStat label="Track Moves" value={stats.trackEvents} />
      </div>

      <div className="session-memory-note">
        <span>Last Move</span>
        <p>{latestCreativeEvent?.summary ?? "Waiting for Ableton activity."}</p>
      </div>
    </aside>
  );
}

function formatSessionDate(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(timestamp));
}
