import type { RecallTimelineMoment } from "../types/recall";

type TimelineEventProps = {
  event: RecallTimelineMoment;
};

export function TimelineEvent({ event }: TimelineEventProps) {
  const label = labelForEventType(event.type);

  return (
    <article className={`timeline-event timeline-event--${event.type}`}>
      <div className="timeline-event__timecode">{event.sessionTimecode}</div>

      <div className="timeline-event__body">
        <div className="timeline-event__header">
          <span className="timeline-event__type">{label}</span>

          {event.source && (
            <span className="timeline-event__source">{event.source}</span>
          )}
        </div>

        <h3 className="timeline-event__summary">{event.summary}</h3>

        {event.detail && (
          <p className="timeline-event__detail">{event.detail}</p>
        )}

        {event.metadata && Object.keys(event.metadata).length > 0 && (
          <div className="timeline-event__meta">
            {event.trackName && <span>Track: {event.trackName}</span>}
            {event.deviceName && <span>Device: {event.deviceName}</span>}

            {Object.entries(event.metadata).map(([key, value]) => (
              <span key={key}>
                {key}: <strong>{String(value)}</strong>
              </span>
            ))}
          </div>
        )}
      </div>
    </article>
  );
}

function labelForEventType(type: RecallTimelineMoment["type"]): string {
  switch (type) {
    case "track":
      return "TRACK MOVE";
    case "device":
      return "DEVICE";
    case "parameter":
      return "PARAMETER";
    case "transport":
      return "PLAYBACK";
    case "tempo":
      return "TEMPO";
    case "clip":
      return "CLIP";
    case "file":
      return "PROJECT";
    case "session":
      return "SET STATE";
    case "creative_moment":
      return "MOMENT";
    default:
      return type.replace("_", " ").toUpperCase();
  }
}
