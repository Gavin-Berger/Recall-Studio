import { useState } from "react";
import type { ActivityBlock } from "../types/activities";
import { producerEventIcon } from "../utils/producerEvents";

const CATEGORY_LABELS: Record<ActivityBlock["category"], string> = {
  sound_design: "Sound Design",
  arrangement: "Arrangement",
  mixing: "Mixing",
  tracking: "Tracking",
  general: "Session",
};

type ActivityBlockProps = {
  block: ActivityBlock;
  index: number;
};

export function ActivityBlockCard({ block, index }: ActivityBlockProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  const durationLabel = formatDuration(block.durationMs);
  const hasRawDetail =
    block.visibleEvents.length > 0 || block.contextEvents.length > 0;
  const contextCount =
    block.contextEvents.length + block.analytics.parameterChangeCount;

  return (
    <article className={`activity-block activity-block--${block.category}`}>
      {/* ── Header ─────────────────────────────────────────────── */}
      <header className="activity-block__header">
        <div className="activity-block__time">
          <time>{block.startTimecode}</time>
          {block.endTimecode !== block.startTimecode && (
            <>
              <span>–</span>
              <time>{block.endTimecode}</time>
            </>
          )}
        </div>

        <div className="activity-block__badges">
          {durationLabel && (
            <span className="activity-badge activity-badge--duration">
              {durationLabel}
            </span>
          )}
          <span className={`activity-badge activity-badge--category activity-badge--${block.category}`}>
            {CATEGORY_LABELS[block.category]}
          </span>
        </div>

        <span className="activity-block__index">#{index + 1}</span>
      </header>

      {/* ── Title + track ─────────────────────────────────────── */}
      <div className="activity-block__title-row">
        <h3>{block.title}</h3>
        {block.primaryTrack && (
          <span className="activity-block__track">{block.primaryTrack}</span>
        )}
      </div>

      {/* ── Summary ───────────────────────────────────────────── */}
      <p className="activity-block__summary">{block.summary}</p>

      {/* ── Key actions ───────────────────────────────────────── */}
      {block.keyActions.length > 0 && (
        <ul className="activity-block__actions">
          {block.keyActions.map((action, i) => (
            <li key={i}>{action}</li>
          ))}
        </ul>
      )}

      {/* ── Footer: analytics + expand ────────────────────────── */}
      <footer className="activity-block__footer">
        <div className="activity-block__analytics">
          {block.analytics.playbackCount > 0 && (
            <span>
              <strong>{block.analytics.playbackCount}</strong> playback{block.analytics.playbackCount === 1 ? "" : "s"}
            </span>
          )}
          {block.analytics.parameterChangeCount > 0 && (
            <span>
              <strong>{block.analytics.parameterChangeCount}</strong> param change{block.analytics.parameterChangeCount === 1 ? "" : "s"}
            </span>
          )}
          {block.analytics.devicesAdded.length > 0 && (
            <span>
              <strong>{block.analytics.devicesAdded.length}</strong> device{block.analytics.devicesAdded.length === 1 ? "" : "s"}
            </span>
          )}
          {contextCount > 0 && (
            <span className="activity-block__analytics--dim">
              {contextCount} context event{contextCount === 1 ? "" : "s"}
            </span>
          )}
        </div>

        {hasRawDetail && (
          <button
            type="button"
            className="activity-block__expand-btn"
            onClick={() => setIsExpanded((v) => !v)}
            aria-expanded={isExpanded}
          >
            {isExpanded ? "Hide events" : "View events"}
            <span className="activity-block__expand-chevron">
              {isExpanded ? "▾" : "▸"}
            </span>
          </button>
        )}
      </footer>

      {/* ── Expanded raw events ────────────────────────────────── */}
      {isExpanded && (
        <div className="activity-block__events">
          {block.visibleEvents.length > 0 && (
            <>
              <p className="activity-block__events-label">Key moments</p>
              <ol className="activity-block__event-list">
                {block.visibleEvents.map((event) => (
                  <li key={event.id} className="activity-block__event-row">
                    <time>{event.sessionTimecode}</time>
                    <span
                      className={`event-glyph event-glyph--${event.type} event-glyph--sm`}
                      aria-hidden="true"
                    >
                      {producerEventIcon(event.type)}
                    </span>
                    <span>{event.summary}</span>
                  </li>
                ))}
              </ol>
            </>
          )}

          {contextCount > 0 && (
            <p className="activity-block__events-label activity-block__events-label--dim">
              + {contextCount} context event{contextCount === 1 ? "" : "s"} hidden
            </p>
          )}
        </div>
      )}
    </article>
  );
}

function formatDuration(ms: number): string | null {
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 10) return null;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  if (seconds === 0) return `${minutes}m`;
  return `${minutes}m ${seconds}s`;
}
