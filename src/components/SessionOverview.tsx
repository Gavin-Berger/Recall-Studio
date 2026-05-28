import type {
  RecallTimelineMoment,
  SavedSessionMetadata,
  SessionStats,
  SessionViewMode,
} from "../types/recall";
import { findAbletonInstrumentReference } from "../utils/abletonInstruments";
import { RecallMark } from "./RecallMark";

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
  const focusInstrument = findAbletonInstrumentReference(String(focusDevice));

  return (
    <aside className="left-rail">
      <header className="rail-brand">
        <RecallMark />
        <div>
          <p>Recall Studio</p>
          <h1>Session Memory</h1>
        </div>
      </header>

      <section className="rail-section">
        <div className="section-kicker">Capture</div>

        <button
          type="button"
          className={`live-capture-card ${viewMode === "live" ? "is-active" : ""}`}
          onClick={onSelectLiveSession}
        >
          <span className="capture-led is-live" />
          <span>
            <strong>Live Session</strong>
            <small>Current Ableton stream</small>
          </span>
          <em>{stats.creativeEvents}</em>
        </button>
      </section>

      <section className="rail-section">
        <div className="session-history__header">
          <span>Saved Sessions</span>
          <button type="button" onClick={onStartNewSession}>
            New
          </button>
        </div>

        <details className="session-accordion" open>
          <summary>Local history</summary>

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
                    X
                  </button>
                </div>
              ))
            )}
          </div>
        </details>
      </section>

      <section className="rail-section">
        <div className="section-kicker">Focus</div>

        <div className="focus-card focus-card--track">
          <span>Selected Track</span>
          <strong>{String(focusTrack)}</strong>
        </div>

        <div className="focus-card focus-card--device">
          <span>Active Device</span>
          <strong>{String(focusDevice)}</strong>
          {focusInstrument && <small>{focusInstrument.family}</small>}
        </div>
      </section>

      <section className="rail-section rail-section--metrics">
        <RailMetric label="Moments" value={stats.creativeEvents} />
        <RailMetric label="Track" value={stats.trackEvents} />
        <RailMetric label="Device" value={stats.deviceEvents} />
        <RailMetric label="Tempo" value={stats.tempoEvents} />
      </section>

      <section className="rail-section session-memory-note">
        <span>Last Move</span>
        <p>{latestCreativeEvent?.summary ?? "Waiting for Ableton activity."}</p>
      </section>
    </aside>
  );
}

function RailMetric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rail-metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
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
