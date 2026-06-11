import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { SavedSession, SavedSessionMetadata } from "../../types/recall";

type SessionRecapScreenProps = {
  sessionId: string | null;
  sessions: SavedSessionMetadata[];
  onOpenTimeline: (sessionId: string) => void;
  onOpenProjects: () => void;
};

type LoadState = "idle" | "loading" | "ready" | "error";

export function SessionRecapScreen({
  sessionId,
  sessions,
  onOpenTimeline,
  onOpenProjects,
}: SessionRecapScreenProps) {
  const [session, setSession] = useState<SavedSession | null>(null);
  const [status, setStatus] = useState<LoadState>("idle");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!sessionId) {
      setSession(null);
      setStatus("idle");
      return;
    }

    let cancelled = false;
    setStatus("loading");
    setError(null);

    invoke<SavedSession>("load_session_events", { sessionId })
      .then((loaded) => {
        if (cancelled) return;
        setSession(loaded);
        setStatus("ready");
      })
      .catch((loadError) => {
        if (cancelled) return;
        setError(String(loadError));
        setStatus("error");
      });

    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  const fallbackSession = sessions.find((candidate) => candidate.id === sessionId) ?? null;
  const displaySession = session ?? fallbackSession;
  const recap = useMemo(() => buildRecap(session), [session]);

  if (!sessionId || !displaySession) {
    return (
      <div className="session-recap session-recap--empty">
        <span className="eyebrow">Session Recap</span>
        <h1>No capture selected.</h1>
        <p>Choose a project version first, then come back here for the recap.</p>
        <button type="button" className="home-action home-action--primary" onClick={onOpenProjects}>
          Open Projects
        </button>
      </div>
    );
  }

  return (
    <div className="session-recap">
      <header className="session-recap__header">
        <div>
          <span className="eyebrow">Session Recap</span>
          <h1>{displaySession.name}</h1>
          <p>
            {formatSessionDate(displaySession.started_at_ms)} / {formatDuration(displaySession)}
          </p>
        </div>
        <div className="session-recap__actions">
          <button type="button" className="home-action" onClick={onOpenProjects}>
            Projects
          </button>
          <button type="button" className="home-action home-action--primary" onClick={() => onOpenTimeline(sessionId)}>
            Open Timeline
          </button>
        </div>
      </header>

      {status === "loading" && <p className="session-recap__status">Loading recap...</p>}
      {status === "error" && <p className="session-recap__error">{error}</p>}

      <section className="session-recap__stats" aria-label="Capture summary">
        <div>
          <strong>{displaySession.event_count}</strong>
          <span>captured events</span>
        </div>
        <div>
          <strong>{recap.trackCount}</strong>
          <span>tracks touched</span>
        </div>
        <div>
          <strong>{recap.deviceCount}</strong>
          <span>devices touched</span>
        </div>
        <div>
          <strong>{recap.moveCount}</strong>
          <span>knob moves</span>
        </div>
        <div>
          <strong>{recap.clipCount}</strong>
          <span>clips & samples</span>
        </div>
        <div>
          <strong>{displaySession.creative_event_count}</strong>
          <span>non-heartbeat</span>
        </div>
      </section>

      <div className="session-recap__grid">
        <section className="session-recap__panel">
          <span className="eyebrow">Captured Focus</span>
          <h2>What Recall saw</h2>
          <div className="recap-breakdown">
            <RecapMeter label="Track work" value={recap.trackEvents} total={recap.totalCreativeEvents} />
            <RecapMeter label="Device work" value={recap.deviceEvents} total={recap.totalCreativeEvents} />
            <RecapMeter label="Moves" value={recap.moveCount} total={recap.totalCreativeEvents} />
            <RecapMeter label="Clips / samples" value={recap.clipCount} total={recap.totalCreativeEvents} />
          </div>
        </section>

        <section className="session-recap__panel">
          <span className="eyebrow">Recent Activity</span>
          <h2>Last things captured</h2>
          {recap.recentEvents.length > 0 ? (
            <ol className="recap-event-list">
              {recap.recentEvents.map((event) => (
                <li key={event.id}>
                  <time>{formatClock(event.timestamp_ms)}</time>
                  <div>
                    <strong>{event.title}</strong>
                    <span>{event.track || event.device || event.sample_name || event.clip_name || event.description}</span>
                  </div>
                </li>
              ))}
            </ol>
          ) : (
            <p className="session-recap__empty">No captured activity yet.</p>
          )}
        </section>
      </div>
    </div>
  );
}

function RecapMeter({ label, value, total }: { label: string; value: number; total: number }) {
  const width = total > 0 ? Math.max(4, Math.round((value / total) * 100)) : 0;

  return (
    <div className="recap-meter">
      <div>
        <span>{label}</span>
        <strong>{value}</strong>
      </div>
      <i>
        <b style={{ width: `${width}%` }} />
      </i>
    </div>
  );
}

function buildRecap(session: SavedSession | null) {
  const events = session?.events.filter((event) => !event.is_heartbeat) ?? [];
  const tracks = new Set(events.map((event) => event.track).filter(Boolean));
  const devices = new Set(events.map((event) => event.device).filter(Boolean));
  const moveEvents = events.filter((event) =>
    ["parameter_changed", "automation_created", "send_changed", "volume_changed", "pan_changed"].includes(event.type),
  );
  const clipEvents = events.filter((event) =>
    event.type.includes("clip") || event.type.includes("sample"),
  );
  const trackEvents = events.filter((event) => event.type.startsWith("track_"));
  const deviceEvents = events.filter((event) => event.type.startsWith("device_"));

  return {
    totalCreativeEvents: events.length,
    trackCount: tracks.size,
    deviceCount: devices.size,
    moveCount: moveEvents.length,
    clipCount: clipEvents.length,
    trackEvents: trackEvents.length,
    deviceEvents: deviceEvents.length,
    recentEvents: events.slice(-6).reverse(),
  };
}

function formatSessionDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatClock(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatDuration(session: SavedSessionMetadata | SavedSession): string {
  if (session.ended_at_ms === null) return "In progress";
  const ms = Math.max(0, session.ended_at_ms - session.started_at_ms);
  const totalMinutes = Math.floor(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return "< 1m";
}
