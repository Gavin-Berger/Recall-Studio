import type { RecallTimelineMoment } from "../types/recall";
import { findAbletonInstrumentReference } from "../utils/abletonInstruments";

type TimelineEventProps = {
  event: RecallTimelineMoment;
};

export function TimelineEvent({ event }: TimelineEventProps) {
  const label = labelForEventType(event.type);
  const instrument = findAbletonInstrumentReference(
    event.deviceName ?? String(event.metadata?.device ?? ""),
  );
  const metadataPills = buildMetadataPills(event);

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

        {instrument && (
          <div className="instrument-reference-card">
            <div>
              <span>Ableton Instrument</span>
              <strong>{instrument.name}</strong>
            </div>

            <p>{instrument.role}</p>

            <div className="instrument-reference-card__chips">
              <span>{instrument.family}</span>
              <span>{instrument.engine}</span>
              {instrument.focus.slice(0, 3).map((focus) => (
                <span key={focus}>{focus}</span>
              ))}
            </div>

            {instrument.performanceNote && (
              <small>{instrument.performanceNote}</small>
            )}
          </div>
        )}

        {metadataPills.length > 0 && (
          <div className="timeline-event__meta">
            {metadataPills.map((pill) => (
              <span key={pill.label}>
                {pill.label}: <strong>{pill.value}</strong>
              </span>
            ))}
          </div>
        )}
      </div>
    </article>
  );
}

function buildMetadataPills(event: RecallTimelineMoment): Array<{
  label: string;
  value: string;
}> {
  const metadata = event.metadata ?? {};
  const pills: Array<{ label: string; value: string }> = [];

  addPill(pills, "Track", event.trackName ?? readString(metadata.track));
  addPill(pills, "Device", event.deviceName ?? readString(metadata.device));
  addPill(pills, "Parameter", readString(metadata.parameter));
  addPill(pills, "Clip", readString(metadata.clip));
  addPill(pills, "Tempo", formatBpm(metadata.bpm));
  addPill(pills, "Position", readString(metadata.arrangementPosition));
  addPill(pills, "Value", formatPrimitive(metadata.value));

  return pills.slice(0, 4);
}

function addPill(
  pills: Array<{ label: string; value: string }>,
  label: string,
  value?: string,
) {
  if (!value || pills.some((pill) => pill.label === label && pill.value === value)) {
    return;
  }

  pills.push({ label, value });
}

function readString(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) {
    return value;
  }

  return undefined;
}

function formatBpm(value: unknown): string | undefined {
  if (typeof value !== "number") {
    return undefined;
  }

  return `${formatNumber(value)} BPM`;
}

function formatPrimitive(value: unknown): string | undefined {
  if (
    typeof value === "string" ||
    typeof value === "boolean" ||
    value === null
  ) {
    return String(value);
  }

  if (typeof value === "number") {
    return formatNumber(value);
  }

  return undefined;
}

function formatNumber(value: number): string {
  if (Number.isInteger(value)) {
    return String(value);
  }

  return value.toFixed(2).replace(/\.?0+$/, "");
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
