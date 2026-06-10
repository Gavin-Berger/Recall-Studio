import { RecallMark } from "../../components/RecallMark";
import { BridgeSetup } from "./BridgeSetup";
import type { ConnectionStatus, SavedSessionMetadata } from "../../types/recall";

type HomeScreenProps = {
  connection: ConnectionStatus;
  sessions: SavedSessionMetadata[];
  activeSession: SavedSessionMetadata | null;
  onStartNewSession: () => void;
  onOpenTimeline: () => void;
  onOpenSession: (sessionId: string) => void;
};

export function HomeScreen({
  connection,
  sessions,
  activeSession,
  onStartNewSession,
  onOpenTimeline,
  onOpenSession,
}: HomeScreenProps) {
  const recentSessions = sessions.slice(0, 7);

  return (
    <div className="home-screen">
      <header className="home-screen__header">
        <div className="home-screen__brand">
          <RecallMark />
          <div>
            <h1>Recall Studio</h1>
            <p>Session memory for Ableton Live</p>
          </div>
        </div>

        <div
          className={`home-connection ${
            connection.connected ? "home-connection--live" : "home-connection--off"
          }`}
        >
          <span className="home-connection__dot" />
          <span>
            {connection.connected ? "Ableton connected" : "Ableton not connected"}
          </span>
        </div>
      </header>

      <div className="home-screen__body">
        <BridgeSetup connection={connection} />

        {activeSession && (
          <section className="home-active-session">
            <div className="home-active-session__info">
              <span className="home-active-session__badge">Active</span>
              <strong>{activeSession.name}</strong>
              <span>{formatSessionDate(activeSession.started_at_ms)}</span>
              <span>{activeSession.creative_event_count} moments captured</span>
            </div>
            <button
              type="button"
              className="home-action home-action--primary"
              onClick={onOpenTimeline}
            >
              Open Timeline
            </button>
          </section>
        )}

        {recentSessions.length > 0 ? (
          <section className="home-sessions">
            <h2 className="home-sessions__label">
              {activeSession ? "Previous Sessions" : "Recent Sessions"}
            </h2>
            <div className="home-session-list">
              {recentSessions
                .filter((s) => s.id !== activeSession?.id)
                .map((session) => (
                  <button
                    key={session.id}
                    type="button"
                    className="home-session-row"
                    onClick={() => onOpenSession(session.id)}
                  >
                    <strong className="home-session-row__name">{session.name}</strong>
                    <span className="home-session-row__date">
                      {formatSessionDate(session.started_at_ms)}
                    </span>
                    <span className="home-session-row__duration">
                      {session.ended_at_ms !== null
                        ? formatDuration(session.ended_at_ms - session.started_at_ms)
                        : "In progress"}
                    </span>
                    <span className="home-session-row__count">
                      {session.creative_event_count} moments
                    </span>
                  </button>
                ))}
            </div>
          </section>
        ) : (
          !activeSession && (
            <div className="home-screen__empty">
              <p>No sessions captured yet.</p>
              <p>Connect Ableton Live and start a capture to begin.</p>
            </div>
          )
        )}
      </div>

      <footer className="home-screen__actions">
        {!activeSession && (
          <button
            type="button"
            className="home-action home-action--primary"
            onClick={onStartNewSession}
          >
            Start New Capture
          </button>
        )}
        <button
          type="button"
          className="home-action"
          onClick={onOpenTimeline}
        >
          Open Timeline
        </button>
      </footer>
    </div>
  );
}

function formatSessionDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }

  if (minutes > 0) {
    return `${minutes}m`;
  }

  return "< 1m";
}
