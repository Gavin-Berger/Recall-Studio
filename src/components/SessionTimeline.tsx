import type { RecallTimelineMoment, SessionViewMode } from "../types/recall";
import { TimelineEvent } from "./TimelineEvent";

type SessionTimelineProps = {
  events: RecallTimelineMoment[];
  viewMode: SessionViewMode;
};

export function SessionTimeline({ events, viewMode }: SessionTimelineProps) {
  const visibleEvents = events.filter((event) => event.type !== "heartbeat");

  return (
    <section className="timeline-panel">
      <div className="panel-header">
        <div>
          <p className="eyebrow">
            {viewMode === "live" ? "Live Session Memory" : "Saved Session Memory"}
          </p>
          <h2>Timecoded Creative Timeline</h2>
        </div>

        <span className="event-count">{visibleEvents.length} moments</span>
      </div>

      <div className="timeline-stream">
        {visibleEvents.length === 0 ? (
          <div className="empty-state">
            <p>No creative events captured yet.</p>
            <span>
              Start playback, change tempo, select a track, or move around in
              Ableton.
            </span>
          </div>
        ) : (
          visibleEvents.map((event) => (
            <TimelineEvent key={event.id} event={event} />
          ))
        )}
      </div>
    </section>
  );
}
