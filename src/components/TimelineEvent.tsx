import type { RecallTimelineMoment } from "../types/recall";
import { findAbletonInstrumentReference } from "../utils/abletonInstruments";
import { formatProducerMoment, producerEventIcon } from "../utils/producerEvents";

type TimelineEventProps = {
  event: RecallTimelineMoment;
  isSelected: boolean;
  onSelect: (eventId: string) => void;
};

export function TimelineEvent({ event, isSelected, onSelect }: TimelineEventProps) {
  const presentation = formatProducerMoment(event);
  const instrument = findAbletonInstrumentReference(
    event.deviceName ?? String(event.metadata?.device ?? ""),
  );
  const metadataPills = presentation.metadataPills;

  return (
    <article
      className={`timeline-event timeline-event--${event.type} ${
        isSelected ? "is-selected" : ""
      }`}
    >
      <button
        type="button"
        className="timeline-event__row"
        onClick={() => onSelect(event.id)}
      >
        <span className="timeline-event__timecode">{event.sessionTimecode}</span>

        <span className={`event-glyph event-glyph--${event.type}`} aria-hidden="true">
          {producerEventIcon(event.type)}
        </span>

        <span className="timeline-event__main">
          <span className="timeline-event__label">{presentation.categoryLabel}</span>
          <strong>{presentation.title}</strong>
          {presentation.detail && <small>{presentation.detail}</small>}
        </span>

        <span className="timeline-event__context">{presentation.contextLabel}</span>
      </button>

      <details className="timeline-event__details">
        <summary>Details</summary>

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
      </details>
    </article>
  );
}
