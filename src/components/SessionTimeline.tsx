import { useMemo, useState } from "react";
import type {
  ConnectionStatus,
  PlaybackState,
  RecallTimelineMoment,
  SessionStats,
  SessionViewMode,
} from "../types/recall";
import { isProducerTimelineEvent } from "../utils/producerEvents";
import { CaptureReadinessPanel } from "./CaptureReadinessPanel";
import { MemoryChamber } from "./MemoryChamber";
import { TimelineEvent } from "./TimelineEvent";

type SessionTimelineProps = {
  connection: ConnectionStatus;
  events: RecallTimelineMoment[];
  playback: PlaybackState;
  selectedEventId: string | null;
  stats: SessionStats;
  viewMode: SessionViewMode;
  onSelectEvent: (eventId: string) => void;
};

const FILTERS = [
  { id: "all", label: "All" },
  { id: "track", label: "Tracks" },
  { id: "group", label: "Groups" },
  { id: "device", label: "Devices" },
  { id: "parameter", label: "Params" },
  { id: "transport", label: "Transport" },
  { id: "tempo", label: "Tempo" },
  { id: "clip", label: "Clips" },
] as const;

type TimelineFilter = (typeof FILTERS)[number]["id"];

export function SessionTimeline({
  connection,
  events,
  playback,
  selectedEventId,
  stats,
  viewMode,
  onSelectEvent,
}: SessionTimelineProps) {
  const [activeFilter, setActiveFilter] = useState<TimelineFilter>("all");
  const timelineEvents = useMemo(
    () => events.filter(isProducerTimelineEvent),
    [events],
  );
  const visibleEvents = useMemo(() => {
    if (activeFilter === "all") {
      return timelineEvents;
    }

    return timelineEvents.filter((event) => event.type === activeFilter);
  }, [activeFilter, timelineEvents]);
  const activityLanes = useMemo(() => buildActivityLanes(timelineEvents), [timelineEvents]);

  return (
    <section className="timeline-stage">
      <header className="timeline-stage__header">
        <div>
          <p className="eyebrow">
            {viewMode === "live" ? "Live Session" : "Saved Session"}
          </p>
          <h1>What Happened, When</h1>
          <span>
            A timecoded memory of producer decisions captured from Ableton Live.
          </span>
        </div>

        <div className="timeline-stage__counter">
          <strong>{timelineEvents.length}</strong>
          <span>moments</span>
        </div>
      </header>

      <div className="signal-field" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>

      <MemoryChamber events={timelineEvents} />

      <div className="session-map" aria-label="Session activity map">
        {activityLanes.map((lane) => (
          <div className={`session-map__lane session-map__lane--${lane.id}`} key={lane.id}>
            <span>{lane.label}</span>
            <div>
              {lane.cells.map((isActive, index) => (
                <i className={isActive ? "is-active" : ""} key={index} />
              ))}
            </div>
            <strong>{lane.count}</strong>
          </div>
        ))}
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

      <div className="timeline-editor">
        <div className="timeline-ruler" aria-hidden="true">
          <span>00:00</span>
          <span>Session Memory</span>
          <span>Live Edge</span>
        </div>

        <div className="timeline-stream">
          {visibleEvents.length === 0 ? (
            <CaptureReadinessPanel
              connection={connection}
              playback={playback}
              stats={stats}
              viewMode={viewMode}
            />
          ) : (
            visibleEvents.map((event) => (
              <TimelineEvent
                key={event.id}
                event={event}
                isSelected={selectedEventId === event.id}
                onSelect={onSelectEvent}
              />
            ))
          )}
        </div>
      </div>
    </section>
  );
}

function buildActivityLanes(events: RecallTimelineMoment[]) {
  const laneDefinitions = [
    { id: "track", label: "Track" },
    { id: "group", label: "Group" },
    { id: "device", label: "Device" },
    { id: "parameter", label: "Param" },
    { id: "clip", label: "Clip" },
    { id: "transport", label: "Play" },
  ] as const;

  return laneDefinitions.map((lane) => {
    const laneEvents = events.filter((event) => event.type === lane.id);
    const density = Math.min(16, Math.max(0, laneEvents.length));

    return {
      ...lane,
      count: laneEvents.length,
      cells: Array.from({ length: 16 }, (_, index) => index < density),
    };
  });
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
