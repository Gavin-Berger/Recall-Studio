import { useMemo, useState } from "react";
import type {
  PlaybackState,
  RecallTimelineMoment,
  SessionStats,
  SessionViewMode,
} from "../types/recall";
import { buildProducerSummary, buildSessionInsights } from "../utils/sessionInsights";
import { formatProducerMoment, isProducerTimelineEvent } from "../utils/producerEvents";
import { RecallMark } from "./RecallMark";

type SessionDocumentProps = {
  events: RecallTimelineMoment[];
  playback: PlaybackState;
  stats: SessionStats;
  viewMode: SessionViewMode;
};

export function SessionDocument({
  events,
  playback,
  stats,
  viewMode,
}: SessionDocumentProps) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const documentEvents = useMemo(
    () => events.filter(isProducerTimelineEvent),
    [events],
  );
  const groupedEvents = groupEventsByType(documentEvents);
  const producerSummary = buildProducerSummary(documentEvents, stats);
  const insights = buildSessionInsights(documentEvents, stats);
  const importantEvents = documentEvents.filter((event) =>
    ["track", "group", "device", "parameter", "clip", "tempo", "transport"].includes(event.type),
  );
  const plainTextDocument = useMemo(
    () => buildPlainTextDocument(documentEvents, playback, stats, viewMode),
    [documentEvents, playback, stats, viewMode],
  );

  async function handleCopyDocument() {
    try {
      await navigator.clipboard.writeText(plainTextDocument);
      setCopyState("copied");
      window.setTimeout(() => setCopyState("idle"), 1600);
    } catch (error) {
      console.error("Failed to copy session document:", error);
      setCopyState("failed");
      window.setTimeout(() => setCopyState("idle"), 1800);
    }
  }

  return (
    <section className="session-document">
      <header className="document-hero">
        <RecallMark />
        <div>
          <p className="eyebrow">Session Document</p>
          <h1>{viewMode === "live" ? "Live Capture Notes" : "Saved Session Notes"}</h1>
          <span>
            A producer-readable timeline you can use to brief collaborators on
            what changed in the Ableton session.
          </span>
        </div>

        <button type="button" onClick={handleCopyDocument}>
          {copyState === "copied"
            ? "Copied"
            : copyState === "failed"
              ? "Copy failed"
              : "Copy draft"}
        </button>
      </header>

      <div className="document-grid">
        <section className="document-page">
          <div className="document-page__header">
            <span>Recall Studio</span>
            <strong>Timecoded Production Notes</strong>
          </div>

          <div className="document-summary">
            <DocumentMetric label="Creative moves" value={stats.creativeEvents} />
            <DocumentMetric label="Track focus" value={stats.trackEvents} />
            <DocumentMetric label="Device work" value={stats.deviceEvents} />
            <DocumentMetric label="Parameter edits" value={stats.parameterEvents} />
          </div>

          <section className="document-section">
            <h2>Session Snapshot</h2>
            <p>{buildSnapshotSentence(playback, stats)}</p>
            <p>{producerSummary}</p>
          </section>

          <section className="document-section">
            <h2>Timeline</h2>

            {documentEvents.length === 0 ? (
              <p className="document-empty">
                No creative decisions have been captured yet. Start playback,
                select tracks, edit devices, or launch clips in Ableton to build
                this document.
              </p>
            ) : (
              <ol className="document-timeline">
                {documentEvents.map((event) => {
                  const moment = formatProducerMoment(event);

                  return (
                    <li key={event.id}>
                      <time>{event.sessionTimecode}</time>
                      <div>
                        <strong>{moment.title}</strong>
                        {moment.detail && <p>{moment.detail}</p>}
                      </div>
                    </li>
                  );
                })}
              </ol>
            )}
          </section>
        </section>

        <aside className="document-sidebar">
          <section>
            <h2>Producer Focus</h2>
            <DocumentList
              empty="No major creative moves yet."
              items={importantEvents.slice(-6).reverse().map((event) => ({
                label: event.sessionTimecode,
                value: formatProducerMoment(event).title,
              }))}
            />
          </section>

          <section>
            <h2>Session Intelligence</h2>
            <div className="document-insights">
              {insights.slice(0, 4).map((insight) => (
                <article key={insight.label}>
                  <span>{insight.label}</span>
                  <strong>{insight.value}</strong>
                  <p>{insight.detail}</p>
                </article>
              ))}
            </div>
          </section>

          <section>
            <h2>Activity Breakdown</h2>
            <div className="document-breakdown">
              {groupedEvents.map((group) => (
                <div key={group.type}>
                  <span>{labelForType(group.type)}</span>
                  <strong>{group.count}</strong>
                </div>
              ))}
            </div>
          </section>

          <section>
            <h2>Share Format</h2>
            <pre>{plainTextDocument}</pre>
          </section>
        </aside>
      </div>
    </section>
  );
}

function DocumentMetric({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function DocumentList({
  items,
  empty,
}: {
  items: Array<{ label: string; value: string }>;
  empty: string;
}) {
  if (items.length === 0) {
    return <p className="document-empty">{empty}</p>;
  }

  return (
    <ul className="document-list">
      {items.map((item) => (
        <li key={`${item.label}-${item.value}`}>
          <span>{item.label}</span>
          <strong>{item.value}</strong>
        </li>
      ))}
    </ul>
  );
}

function buildSnapshotSentence(
  playback: PlaybackState,
  stats: SessionStats,
): string {
  const parts = [
    `${stats.creativeEvents} creative moves captured`,
    playback.projectClock ? `project time ${playback.projectClock}` : null,
    playback.selectedTrack ? `${playback.selectedTrack} selected` : null,
    typeof playback.tempo === "number" ? `${formatNumber(playback.tempo)} BPM` : null,
    playback.arrangementPosition ? playback.arrangementPosition : null,
  ].filter(Boolean);

  return parts.length > 0
    ? `${parts.join(". ")}.`
    : "Recall Studio is waiting for Ableton telemetry to build a session record.";
}

function buildPlainTextDocument(
  events: RecallTimelineMoment[],
  playback: PlaybackState,
  stats: SessionStats,
  viewMode: SessionViewMode,
): string {
  const lines = [
    `Recall Studio - ${viewMode === "live" ? "Live Capture" : "Saved Session"} Notes`,
    "",
    buildSnapshotSentence(playback, stats),
    "",
    "Timeline:",
    ...(events.length > 0
      ? events.map((event) => {
          const moment = formatProducerMoment(event);
          return `${event.sessionTimecode}  ${moment.title}${
            moment.detail ? ` - ${moment.detail}` : ""
          }`;
        })
      : ["No creative events captured yet."]),
  ];

  return lines.join("\n");
}

function groupEventsByType(events: RecallTimelineMoment[]) {
  const order: RecallTimelineMoment["type"][] = [
    "track",
    "group",
    "device",
    "parameter",
    "clip",
    "tempo",
    "transport",
    "session",
    "file",
  ];

  return order.map((type) => ({
    type,
    count: events.filter((event) => event.type === type).length,
  }));
}

function labelForType(type: RecallTimelineMoment["type"]): string {
  switch (type) {
    case "track":
      return "Track focus";
    case "group":
      return "Track groups";
    case "device":
      return "Device work";
    case "parameter":
      return "Parameter edits";
    case "clip":
      return "Clip moves";
    case "tempo":
      return "Tempo";
    case "transport":
      return "Transport";
    case "session":
      return "Live Set";
    case "file":
      return "Project file";
    default:
      return "Other";
  }
}

function formatNumber(value: number): string {
  if (Number.isInteger(value)) {
    return String(value);
  }

  return value.toFixed(2).replace(/\.?0+$/, "");
}
