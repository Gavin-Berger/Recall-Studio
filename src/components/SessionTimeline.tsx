import { lazy, Suspense, useMemo, useState } from "react";
import type { RecallTimelineMoment, SessionViewMode } from "../types/recall";
import { TimelineEvent } from "./TimelineEvent";

const SessionReplay3D = lazy(() =>
  import("./SessionReplay3D").then((module) => ({
    default: module.SessionReplay3D,
  })),
);

type SessionTimelineProps = {
  events: RecallTimelineMoment[];
  viewMode: SessionViewMode;
};

const FILTERS = [
  { id: "all", label: "All" },
  { id: "track", label: "Tracks" },
  { id: "device", label: "Devices" },
  { id: "parameter", label: "Params" },
  { id: "transport", label: "Transport" },
  { id: "tempo", label: "Tempo" },
  { id: "clip", label: "Clips" },
] as const;

type TimelineFilter = (typeof FILTERS)[number]["id"];

export function SessionTimeline({ events, viewMode }: SessionTimelineProps) {
  const [activeFilter, setActiveFilter] = useState<TimelineFilter>("all");
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const timelineEvents = useMemo(
    () => events.filter((event) => event.type !== "heartbeat"),
    [events],
  );
  const visibleEvents = useMemo(() => {
    if (activeFilter === "all") {
      return timelineEvents;
    }

    return timelineEvents.filter((event) => event.type === activeFilter);
  }, [activeFilter, timelineEvents]);

  return (
    <section className="timeline-panel">
      <div className="panel-header">
        <div>
          <p className="eyebrow">
            {viewMode === "live" ? "Live Take" : "Saved Take"}
          </p>
          <h2>What Happened, When</h2>
        </div>

        <span className="event-count">{timelineEvents.length} moves</span>
      </div>

      <div className="timeline-filter-bar" aria-label="Timeline filters">
        {FILTERS.map((filter) => (
          <button
            type="button"
            key={filter.id}
            className={`timeline-filter ${
              activeFilter === filter.id ? "is-active" : ""
            }`}
            onClick={() => setActiveFilter(filter.id)}
          >
            {filter.label}
            <span>{countEventsForFilter(timelineEvents, filter.id)}</span>
          </button>
        ))}
      </div>

      <Suspense
        fallback={
          <div className="replay3d-shell replay3d-shell--loading">
            <span>Loading 3D Recall Matrix</span>
          </div>
        }
      >
        <SessionReplay3D
          events={timelineEvents}
          selectedEventId={selectedEventId}
          onSelectEvent={setSelectedEventId}
        />
      </Suspense>

      <div className="timeline-stream">
        {visibleEvents.length === 0 ? (
          <div className="empty-state">
            <p>No creative events captured yet.</p>
            <span>
              Start playback, change tempo, select a track, or open a device in
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

function countEventsForFilter(
  events: RecallTimelineMoment[],
  filter: TimelineFilter,
): number {
  if (filter === "all") {
    return events.length;
  }

  return events.filter((event) => event.type === filter).length;
}
