import {
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import "./SessionRecapScreen.css";
import {
  getNoteEdits,
  getParameterChanges,
  getProjectSchema,
  getTimelineClipEvents,
  listCreativeMoments,
  loadSessionEvents,
  materializeSessionSchema,
} from "../../lib/schema/api";
import { describePathCleanup, presentPassage } from "../../components/schema/timeline/passagePresenter";
import { formatClock, formatDuration } from "../../components/schema/timeline/format";
import {
  producerWorkDefinition,
  type ProducerWorkKind,
} from "../../components/schema/timeline/producerWork";
import { TRACK_TYPE_LABEL } from "../../types/schema";
import type { SavedSessionMetadata } from "../../types/recall";
import { alsSetName, formatSessionDate } from "../sessionFormat";
import {
  buildSessionReport,
  compareSessionReports,
  type ReportComparison,
  type ReportDecision,
  type ReportEvidence,
  type SessionReport,
} from "./sessionReport";
import { buildReportPreview, isReportPreviewSession } from "./sessionReportPreview";
import { ProducerWorkIcon, ReportIcon, type ReportGlyph } from "./ReportIcons";

const InteractiveReportChart = lazy(() => import("./InteractiveReportChart").then((module) => ({
  default: module.InteractiveReportChart,
})));

type SessionRecapScreenProps = {
  sessionId: string | null;
  sessions: SavedSessionMetadata[];
  onSelectSession: (sessionId: string) => void;
  onOpenTimeline: (sessionId: string) => void;
  onOpenProjects: () => void;
};

type LoadState = "idle" | "loading" | "ready" | "error";
type ReportTab = "summary" | "chapters" | "work" | "changes" | "compare";
type EvidenceRequest = { title: string; subtitle?: string; ids: string[] };

/**
 * The report as a walkthrough: five steps, each answering one question, read in
 * order.
 *
 * The previous six tabs answered overlapping questions and repeated each
 * other's panels — the full change ledger rendered in both "Session Path" and
 * "Decisions", the track ranking in both "Overview" and "Tracks", and "Graphs"
 * was a third view of data already on two other tabs. A producer had no way to
 * know which tab was the authority on anything. Every panel now appears exactly
 * once, and `question` is shown at the top of its step so the reader always
 * knows what they are looking at.
 */
const REPORT_TABS: Array<{ id: ReportTab; label: string; question: string; icon: ReportGlyph }> = [
  { id: "summary", label: "The session", question: "What happened in this version?", icon: "overview" },
  { id: "chapters", label: "How it went", question: "How did the time actually go?", icon: "path" },
  { id: "work", label: "Where it landed", question: "Which tracks and which kind of work?", icon: "tracks" },
  { id: "changes", label: "Every change", question: "What exactly changed, in order?", icon: "decisions" },
  { id: "compare", label: "Since last time", question: "What is different from the version before?", icon: "compare" },
];

async function loadReport(sessionId: string): Promise<SessionReport> {
  if (import.meta.env.DEV && isReportPreviewSession(sessionId)) {
    return buildReportPreview(sessionId);
  }

  await materializeSessionSchema(sessionId);
  const [session, schema, changes, noteEdits, clipEvents, moments] = await Promise.all([
    loadSessionEvents(sessionId),
    getProjectSchema(sessionId),
    getParameterChanges(sessionId),
    getNoteEdits(sessionId),
    getTimelineClipEvents(sessionId),
    listCreativeMoments(sessionId),
  ]);
  return buildSessionReport({ session, schema, changes, noteEdits, clipEvents, moments });
}

function sessionLabel(session: SavedSessionMetadata): string {
  return (
    alsSetName(session.als_path) ??
    session.display_name ??
    session.capture_name ??
    `${formatSessionDate(session.started_at_ms)} · ${formatClock(session.started_at_ms)}`
  );
}

function formatMetric(value: number | null | undefined): string {
  return (typeof value === "number" && Number.isFinite(value) ? value : 0).toLocaleString();
}

function countLabel(value: number | null | undefined, singular: string, plural = `${singular}s`): string {
  const safeValue = typeof value === "number" && Number.isFinite(value) ? value : 0;
  return `${safeValue.toLocaleString()} ${safeValue === 1 ? singular : plural}`;
}

function deltaLabel(value: number, duration = false): string {
  if (value === 0) return "same";
  const amount = duration ? formatDuration(Math.abs(value)) : Math.abs(value).toLocaleString();
  return `${value > 0 ? "+" : "−"}${amount}`;
}

function evidenceInRange(report: SessionReport, startMs: number, endMs: number): string[] {
  return Object.values(report.evidence)
    .filter((item) => item.atMs >= startMs - 1_000 && item.atMs <= endMs + 1_000)
    .map((item) => item.id);
}

export function SessionRecapScreen({
  sessionId,
  sessions,
  onSelectSession,
  onOpenTimeline,
  onOpenProjects,
}: SessionRecapScreenProps) {
  const [report, setReport] = useState<SessionReport | null>(null);
  const [status, setStatus] = useState<LoadState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<ReportTab>("summary");
  const [evidenceRequest, setEvidenceRequest] = useState<EvidenceRequest | null>(null);
  const [baselineId, setBaselineId] = useState<string | null>(null);
  const [baselineReport, setBaselineReport] = useState<SessionReport | null>(null);
  const [baselineStatus, setBaselineStatus] = useState<LoadState>("idle");
  const [baselineError, setBaselineError] = useState<string | null>(null);
  const loadedSessionIdRef = useRef<string | null>(null);

  const fallbackSession = sessions.find((candidate) => candidate.id === sessionId) ?? null;
  const projectSessions = useMemo(() => {
    if (!fallbackSession) return [];
    return sessions
      .filter((candidate) =>
        fallbackSession.project_id
          ? candidate.project_id === fallbackSession.project_id
          : candidate.id === fallbackSession.id,
      )
      .sort((a, b) => a.started_at_ms - b.started_at_ms);
  }, [fallbackSession, sessions]);
  const baselineCandidates = useMemo(
    () => projectSessions.filter((candidate) => candidate.id !== sessionId && candidate.creative_event_count > 0),
    [projectSessions, sessionId],
  );

  useEffect(() => {
    if (!sessionId) {
      loadedSessionIdRef.current = null;
      setReport(null);
      setStatus("idle");
      return;
    }
    let cancelled = false;
    const changingSession = loadedSessionIdRef.current !== sessionId;

    // The session list is already polled by App. Its event count gives the report
    // a cheap, precise refresh signal while Ableton is still sending work. Keep
    // the existing report mounted during refreshes so charts and hover state do
    // not flash; only a true take change gets the full loading treatment.
    if (changingSession) {
      setStatus("loading");
      setReport(null);
      setEvidenceRequest(null);
    }
    setError(null);

    const delay = changingSession ? 0 : 350;
    const timer = window.setTimeout(() => {
      void loadReport(sessionId)
        .then((nextReport) => {
          if (cancelled) return;
          loadedSessionIdRef.current = sessionId;
          setReport(nextReport);
          setStatus("ready");
        })
        .catch((loadError) => {
          if (cancelled) return;
          if (changingSession) {
            setError(String(loadError));
            setStatus("error");
          }
        });
    }, delay);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [fallbackSession?.event_count, sessionId]);

  useEffect(() => {
    if (!fallbackSession) {
      setBaselineId(null);
      return;
    }
    const before = baselineCandidates.filter((candidate) => candidate.started_at_ms < fallbackSession.started_at_ms);
    const preferred = before.at(-1) ?? baselineCandidates.at(-1) ?? null;
    setBaselineId(preferred?.id ?? null);
  }, [baselineCandidates, fallbackSession]);

  useEffect(() => {
    if (activeTab !== "compare" || !baselineId) {
      setBaselineReport(null);
      setBaselineStatus(baselineId ? "idle" : "ready");
      return;
    }
    let cancelled = false;
    setBaselineStatus("loading");
    setBaselineError(null);
    void loadReport(baselineId)
      .then((nextReport) => {
        if (cancelled) return;
        setBaselineReport(nextReport);
        setBaselineStatus("ready");
      })
      .catch((loadError) => {
        if (cancelled) return;
        setBaselineError(String(loadError));
        setBaselineStatus("error");
      });
    return () => {
      cancelled = true;
    };
  }, [activeTab, baselineId]);

  useEffect(() => {
    if (!evidenceRequest) return;
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setEvidenceRequest(null);
    }
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [evidenceRequest]);

  function changeTab(tab: ReportTab) {
    setActiveTab(tab);
    setEvidenceRequest(null);
  }

  function handleTabKey(event: ReactKeyboardEvent<HTMLButtonElement>, index: number) {
    let next = index;
    if (event.key === "ArrowRight") next = (index + 1) % REPORT_TABS.length;
    else if (event.key === "ArrowLeft") next = (index - 1 + REPORT_TABS.length) % REPORT_TABS.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = REPORT_TABS.length - 1;
    else return;
    event.preventDefault();
    const tab = REPORT_TABS[next];
    if (!tab) return;
    changeTab(tab.id);
    requestAnimationFrame(() => document.getElementById(`report-tab-${tab.id}`)?.focus());
  }

  if (!sessionId || !fallbackSession) {
    return (
      <div className="session-report session-report--empty">
        <span className="eyebrow">Session Report</span>
        <h1>Pick a version to read.</h1>
        <p>Open a project, choose one of its captured versions, and this walks you through what happened in it.</p>
        <button type="button" className="home-action home-action--primary" onClick={onOpenProjects}>
          Open Projects
        </button>
      </div>
    );
  }

  const evidenceItems = evidenceRequest && report
    ? evidenceRequest.ids
        .map((id) => report.evidence[id])
        .filter((item): item is ReportEvidence => Boolean(item))
        .sort((a, b) => a.atMs - b.atMs)
    : [];
  const comparison = report && baselineReport ? compareSessionReports(report, baselineReport) : null;
  const activeStepIndex = Math.max(0, REPORT_TABS.findIndex((tab) => tab.id === activeTab));
  const activeStep = REPORT_TABS[activeStepIndex];

  return (
    <div className="session-report">
      <header className="session-report__header">
        <div className="session-report__identity">
          <span className="eyebrow">Session Report</span>
          <h1>{fallbackSession.project_name ?? report?.schema?.name ?? fallbackSession.name}</h1>
          <div className="session-report__context">
            <span>{sessionLabel(fallbackSession)}</span>
            <i aria-hidden="true" />
            <span>{formatSessionDate(fallbackSession.started_at_ms)} · {formatClock(fallbackSession.started_at_ms)}</span>
            <i aria-hidden="true" />
            <span className={`report-status report-status--${fallbackSession.ended_at_ms === null ? "live" : "settled"}`}>
              {fallbackSession.ended_at_ms === null ? "Live · auto-updating" : "Finished"}
            </span>
          </div>
        </div>

        <div className="session-report__header-tools">
          {projectSessions.length > 1 && (
            <label className="session-report__take-picker">
              <span>Version</span>
              <select value={sessionId} onChange={(event) => onSelectSession(event.target.value)}>
                {projectSessions.map((candidate, index) => (
                  <option key={candidate.id} value={candidate.id}>
                    {String(index + 1).padStart(2, "0")} · {sessionLabel(candidate)}
                  </option>
                ))}
              </select>
            </label>
          )}
          <button type="button" className="home-action" onClick={onOpenProjects}>
            Projects
          </button>
          <button
            type="button"
            className="home-action home-action--primary session-report__timeline"
            onClick={() => onOpenTimeline(sessionId)}
          >
            <TimelineIcon />
            Open Timeline
          </button>
        </div>
      </header>

      {status === "loading" && <ReportLoading />}
      {status === "error" && (
        <section className="session-report__error" role="alert">
          <strong>Recall could not put this report together.</strong>
          <span>{error}</span>
          <button type="button" className="home-action" onClick={() => onOpenTimeline(sessionId)}>
            Open the Timeline instead
          </button>
        </section>
      )}

      {report && status === "ready" && (
        <>
          {/* How much to trust everything below, stated before any of it. */}
          <div className={`session-report__trust is-${report.trust.level}`}>
            <span className="session-report__trust-mark" aria-hidden="true"><ReportIcon name="evidence" /></span>
            <strong>{report.trust.label}</strong>
            <span>{report.trust.detail}</span>
          </div>

          <nav className="session-report__tabs" role="tablist" aria-label="Session report views">
            {REPORT_TABS.map((tab, index) => (
              <button
                key={tab.id}
                type="button"
                id={`report-tab-${tab.id}`}
                role="tab"
                aria-selected={activeTab === tab.id}
                aria-controls={`report-panel-${tab.id}`}
                tabIndex={activeTab === tab.id ? 0 : -1}
                className={activeTab === tab.id ? "is-active" : ""}
                onClick={() => changeTab(tab.id)}
                onKeyDown={(event) => handleTabKey(event, index)}
              >
                <i className="session-report__tab-step" aria-hidden="true">{index + 1}</i>
                <ReportIcon name={tab.icon} />
                <span>{tab.label}</span>
              </button>
            ))}
          </nav>

          <main
            id={`report-panel-${activeTab}`}
            className="session-report__panel"
            role="tabpanel"
            aria-labelledby={`report-tab-${activeTab}`}
          >
            {/* Whatever step the reader lands on, it opens by saying which
                question it answers. Six unlabelled panels of dense numbers was
                the thing that made this page hard to read. */}
            <p className="session-report__question">
              <b>Step {activeStepIndex + 1} of {REPORT_TABS.length}</b>
              {activeStep?.question}
            </p>
            {activeTab === "summary" && <SummaryStep report={report} onInspect={setEvidenceRequest} />}
            {activeTab === "chapters" && <ChaptersStep report={report} onInspect={setEvidenceRequest} />}
            {activeTab === "work" && <WorkStep report={report} onInspect={setEvidenceRequest} />}
            {activeTab === "changes" && <ChangesStep report={report} onInspect={setEvidenceRequest} />}
            {activeTab === "compare" && (
              <ComparisonStep
                baselineCandidates={baselineCandidates}
                baselineId={baselineId}
                baselineReport={baselineReport}
                baselineStatus={baselineStatus}
                baselineError={baselineError}
                comparison={comparison}
                onBaselineChange={setBaselineId}
                onInspect={setEvidenceRequest}
              />
            )}
          </main>
        </>
      )}

      {evidenceRequest && report && (
        <EvidenceDrawer
          request={evidenceRequest}
          items={evidenceItems}
          report={report}
          onClose={() => setEvidenceRequest(null)}
        />
      )}
    </div>
  );
}

function SummaryStep({ report, onInspect }: { report: SessionReport; onInspect: (request: EvidenceRequest) => void }) {
  return (
    <div className="report-overview">
      <SessionLedger report={report} />

      <section className="report-story">
        <div className="report-section-heading">
          <div>
            <span className="eyebrow">In one paragraph</span>
            <h2>What you did</h2>
          </div>
          <span>{formatDuration(report.wallClockMs)} from open to save</span>
        </div>
        <p>{report.summaryText}</p>
      </section>

      {report.lessons.length > 0 && (
        <section className="report-learning" aria-labelledby="report-learning-title">
          <div className="report-section-heading">
            <div>
              <span className="eyebrow">The things worth remembering</span>
              <h2 id="report-learning-title">Takeaways</h2>
            </div>
            <span>Open any card to read the changes behind it</span>
          </div>
          <div className="report-learning__grid">
            {report.lessons.map((lesson, index) => (
              <button
                key={lesson.id}
                type="button"
                className={`report-learning__card is-${lesson.id}`}
                onClick={() => onInspect({
                  title: lesson.title,
                  subtitle: lesson.label,
                  ids: lesson.evidenceIds,
                })}
              >
                <span className="report-learning__icon">
                  <ReportIcon name={lesson.id === "iteration" ? "iterate" : lesson.id === "carry" ? "carry" : "focus"} />
                  <i>{String(index + 1).padStart(2, "0")}</i>
                </span>
                <span className="report-learning__label">{lesson.label}</span>
                <strong>{lesson.title}</strong>
                <p>{lesson.detail}</p>
                <span className="report-learning__source">
                  {countLabel(lesson.evidenceIds.length, "change")}
                  <b><ReportIcon name="evidence" /> Show me</b>
                </span>
              </button>
            ))}
          </div>
        </section>
      )}

      <p className="report-next-step">
        {report.ledger.capturedCount > 0
          ? "Step 2 breaks the same session into the stretches you actually worked in."
          : "Nothing was captured for this version, so the remaining steps have nothing to show."}
      </p>
    </div>
  );
}

/**
 * The report's numbers, in one place, each labelled, and then explained.
 *
 * The strip used to print six bare figures including "Actions 14" beside
 * "Decisions 18" — numbers a producer cannot reconcile, because they were
 * counted over different things. Everything here now comes from
 * `report.ledger`, and the sentence underneath says how the figures relate, so
 * a reader is never left to work out whether two of them contradict.
 */
function SessionLedger({ report }: { report: SessionReport }) {
  const { ledger } = report;
  const tracksValue = ledger.tracksInSet !== null
    ? `${ledger.tracksTouched}/${ledger.tracksInSet}`
    : formatMetric(ledger.tracksTouched);

  return (
    <>
      <section className="report-metrics" aria-label="This version in numbers">
        <ReportMetric icon="time" value={formatDuration(report.handsOnMs)} label="Hands on the work" />
        <ReportMetric icon="actions" value={formatMetric(ledger.capturedCount)} label="Changes captured" />
        <ReportMetric icon="decisions" value={formatMetric(ledger.decisionCount)} label="Decisions" />
        <ReportMetric icon="tracks" value={tracksValue} label="Tracks touched" />
        <ReportMetric icon="device" value={formatMetric(ledger.deviceCount)} label="Devices shaped" />
        <ReportMetric icon="moment" value={formatMetric(ledger.momentCount)} label="Moments saved" accent />
      </section>
      {ledger.capturedCount > 0 && (
        <p className="report-ledger-note">
          Of the {countLabel(ledger.capturedCount, "change")} Recall captured,{" "}
          <b>{ledger.handsOnCount}</b> were your hands on a control, a clip, or MIDI notes;{" "}
          <b>{ledger.reportedCount}</b> {ledger.reportedCount === 1 ? "was" : "were"} Live reporting something about the set;{" "}
          and <b>{ledger.momentCount}</b> {ledger.momentCount === 1 ? "was a moment" : "were moments"} you saved.
          {ledger.groupedCount > 0 && (
            <> Moving one control repeatedly counts once, which is how {ledger.capturedCount} changes read as {ledger.decisionCount} decisions.</>
          )}
          {ledger.mixerTouched && <> Volume, pan, and sends count as mixing, not as a device.</>}
        </p>
      )}
    </>
  );
}

function ChaptersStep({ report, onInspect }: { report: SessionReport; onInspect: (request: EvidenceRequest) => void }) {
  const cleanup = describePathCleanup(report.analysis);
  const sittings = report.analysis.sittings.length;

  return (
    <div className="report-path">
      <section className="report-path__passages">
        <div className="report-section-heading">
          <div>
            <span className="eyebrow">Read top to bottom</span>
            <h2>{countLabel(report.chapters.length, "stretch of work", "stretches of work")}</h2>
          </div>
          <span>{sittings > 1 ? countLabel(sittings, "separate sitting") : "One sitting"}</span>
        </div>
        {report.chapters.length === 0 ? (
          <ReportEmpty
            title="No work captured yet"
            body="Stretches appear here once Recall has seen you change something in Live."
          />
        ) : (
          <ol>
            {report.chapters.map((chapter) => {
              const presented = presentPassage(chapter);
              const span = Math.max(0, chapter.endMs - chapter.startMs);
              const captured = Object.values(chapter.workCounts).reduce((total, count) => total + count, 0);
              const lead = presented.controls[0];
              return (
                <li key={chapter.id}>
                  <button
                    type="button"
                    onClick={() => onInspect({
                      title: presented.title,
                      subtitle: presented.breakdown ?? chapter.label,
                      ids: evidenceInRange(report, chapter.startMs, chapter.endMs),
                    })}
                  >
                    <span className={`report-path__number is-${chapter.workKinds[0] ?? "mixed"}`}>
                      {chapter.workKinds[0]
                        ? <ProducerWorkIcon kind={chapter.workKinds[0]} />
                        : <ReportIcon name="passages" />}
                      <i>{String(chapter.order).padStart(2, "0")}</i>
                    </span>
                    <span className="report-path__time">
                      <strong>{formatClock(chapter.startMs)}</strong>
                      {/* A stretch that lasted seconds is a point in time, not a
                          "0 sec" span. Printing zero read as a capture fault. */}
                      <small>{span >= 30_000 ? formatDuration(span) : "under a minute"}</small>
                    </span>
                    <span className="report-path__body">
                      <strong>{presented.title}</strong>
                      <small>{presented.breakdown ?? chapter.label}</small>
                      {lead && (
                        <em>
                          {lead.name}
                          {lead.trackName ? ` on ${lead.trackName}` : ""}
                          {lead.outcome ? ` · ${lead.outcome}` : ""}
                        </em>
                      )}
                    </span>
                    <span className="report-path__count">
                      {captured}<small>{captured === 1 ? "change" : "changes"}</small>
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        )}
        {cleanup.length > 0 && (
          <details className="report-cleanup">
            <summary>What Recall tidied away · {cleanup.length}</summary>
            <p>{cleanup.join(" · ")}. Nothing you did was dropped — only Live repeating itself.</p>
          </details>
        )}
      </section>

      <section className="report-card">
        <div className="report-section-heading">
          <div>
            <span className="eyebrow">The same stretches, against the clock</span>
            <h2>When the work happened</h2>
          </div>
          <span>Each point is one slice of the session</span>
        </div>
        {report.series.length === 0 ? (
          <ReportEmpty title="Nothing to plot yet" body="This appears once Recall has captured a few changes." />
        ) : (
          <>
            <Suspense fallback={<ReportLoading compact />}>
              <InteractiveReportChart key={`${report.session.id}-activity`} report={report} mode="activity" onInspect={onInspect} />
            </Suspense>
            <ReportSeriesTable report={report} />
          </>
        )}
      </section>
    </div>
  );
}

function WorkStep({ report, onInspect }: { report: SessionReport; onInspect: (request: EvidenceRequest) => void }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sort, setSort] = useState<"chain" | "activity" | "recent">("chain");
  const tracks = [...report.tracks].sort((a, b) => {
    if (sort === "activity") return b.sourceEventCount - a.sourceEventCount || a.name.localeCompare(b.name);
    if (sort === "recent") return (b.lastTouchedMs ?? 0) - (a.lastTouchedMs ?? 0) || a.name.localeCompare(b.name);
    return (a.number ?? Number.MAX_SAFE_INTEGER) - (b.number ?? Number.MAX_SAFE_INTEGER);
  });
  const activeTracks = report.tracks.filter((track) => track.sourceEventCount > 0);
  const maxTrackEvents = Math.max(1, ...activeTracks.map((track) => track.sourceEventCount));

  return (
    <div className="report-tracks">
      <WorkAreas report={report} onInspect={onInspect} />

      <div className="report-ledger__toolbar">
        <div>
          <span className="eyebrow">Track by track</span>
          <h2>Which tracks you touched</h2>
        </div>
        <label>
          <span>Order</span>
          <select value={sort} onChange={(event) => setSort(event.target.value as typeof sort)}>
            <option value="chain">Ableton track order</option>
            <option value="activity">Busiest first</option>
            <option value="recent">Most recently touched</option>
          </select>
        </label>
      </div>
      <div className="report-track-table" role="table" aria-label="Tracks in this version">
        <div className="report-track-table__head" role="row">
          <span role="columnheader">Track</span>
          <span role="columnheader">Kind of work</span>
          <span role="columnheader">Changes</span>
          <span role="columnheader">Controls moved</span>
          <span role="columnheader">Last touched</span>
        </div>
        {tracks.map((track) => {
          const selected = selectedId === track.id;
          return (
            <div key={track.id} className={`report-track-row ${selected ? "is-selected" : ""}`} role="rowgroup">
              <button
                type="button"
                className="report-track-row__summary"
                aria-expanded={selected}
                onClick={() => setSelectedId(selected ? null : track.id)}
              >
                <span className="report-track-row__name" role="cell">
                  <i>{track.number !== null ? String(track.number).padStart(2, "0") : "--"}</i>
                  <span><strong>{track.name}</strong><small>{track.type ? TRACK_TYPE_LABEL[track.type] : "Track"}</small></span>
                </span>
                <span role="cell" className="report-track-row__work">
                  <span>{track.workKinds.slice(0, 3).map((workKind) => <ProducerWorkIcon key={workKind} kind={workKind} />)}</span>
                  <small>{track.workLabel}</small>
                </span>
                <span role="cell" className="report-track-row__activity">
                  <i><b style={{ width: `${(track.sourceEventCount / maxTrackEvents) * 100}%` }} /></i>
                  <strong>{track.sourceEventCount}</strong>
                </span>
                <span role="cell" className="report-number">{track.controlCount}</span>
                <span role="cell" className="report-number">{track.lastTouchedMs ? formatClock(track.lastTouchedMs) : "Not this version"}</span>
              </button>
              {selected && (
                <div className="report-track-row__detail">
                  <div>
                    <span className="eyebrow">Chain as saved</span>
                    {track.deviceChain.length > 0 ? (
                      <div className="report-device-chain">
                        {track.deviceChain.map((device, index) => (
                          <span key={`${device}-${index}`}>{device}</span>
                        ))}
                      </div>
                    ) : (
                      <p>No devices on this track when the version was saved.</p>
                    )}
                    {track.workKinds.length > 0 && (
                      <div className="report-track-work">
                        <span className="eyebrow">Kinds of work seen here</span>
                        <div>
                          {track.workKinds.map((workKind) => (
                            <span key={workKind} className={`is-${workKind}`}>
                              <ProducerWorkIcon kind={workKind} />
                              {producerWorkDefinition(workKind).label}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                  <div className="report-track-row__facts">
                    <span><b>{track.sourceEventCount}</b> changes captured</span>
                    <span><b>{track.actionCount}</b> by your hand</span>
                    <span><b>{track.controlCount}</b> controls moved</span>
                    {/* Two separate facts, never one number: how long the chain
                        is, and how much of it you actually worked on. */}
                    <span><b>{track.shapedDeviceCount}</b> of {track.chainDeviceCount} devices shaped</span>
                    {track.mixerTouched && <span>Volume, pan, or a send moved</span>}
                  </div>
                  <button
                    type="button"
                    className="home-action"
                    disabled={track.evidenceIds.length === 0}
                    onClick={() => onInspect({
                      title: track.name,
                      subtitle: `${track.workLabel} · ${countLabel(track.sourceEventCount, "change")}`,
                      ids: track.evidenceIds,
                    })}
                  >
                    Show every change on this track
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {activeTracks.length > 0 && report.series.length > 0 && (
        <section className="report-card">
          <div className="report-section-heading">
            <div>
              <span className="eyebrow">The same tracks, side by side</span>
              <h2>How the work was spread</h2>
            </div>
          </div>
          <Suspense fallback={<ReportLoading compact />}>
            <InteractiveReportChart key={`${report.session.id}-tracks`} report={report} mode="tracks" onInspect={onInspect} />
          </Suspense>
          <details className="report-graph-data">
            <summary>Read this as a table</summary>
            <table>
              <thead><tr><th>Track</th><th>Kind of work</th><th>Changes captured</th><th>By your hand</th></tr></thead>
              <tbody>
                {activeTracks.map((track) => (
                  <tr key={track.id}><td>{track.name}</td><td>{track.workLabel}</td><td>{track.sourceEventCount}</td><td>{track.actionCount}</td></tr>
                ))}
              </tbody>
            </table>
          </details>
        </section>
      )}
    </div>
  );
}

/**
 * The kinds of work Recall can recognise, and how much of each it saw.
 *
 * Each card used to carry three unlabelled numbers — "8 decisions", "50%",
 * "10" — with nothing on screen to say what the last two counted. Both figures
 * now name their unit, and the panel states what the percentages are a share of.
 */
function WorkAreas({ report, onInspect }: {
  report: SessionReport;
  onInspect: (request: EvidenceRequest) => void;
}) {
  const captured = report.ledger.capturedCount;
  const sections = [...report.workSections].sort((a, b) => b.sourceEventCount - a.sourceEventCount);
  const seenCount = sections.filter((section) => section.sourceEventCount > 0).length;

  return (
    <section className="report-work-map" aria-labelledby="report-work-map-title">
      <div className="report-section-heading">
        <div>
          <span className="eyebrow">Most of the work first</span>
          <h2 id="report-work-map-title">Kinds of work</h2>
        </div>
        <span>{seenCount} of {sections.length} kinds seen</span>
      </div>
      <p className="report-work-map__intro">
        Every captured change lands in exactly one of these, so the percentages are shares
        of the {countLabel(captured, "change")} Recall captured. Open one to read its changes.
      </p>
      <div className="report-work-map__grid">
        {sections.map((section) => {
          const seen = section.sourceEventCount > 0;
          const share = captured > 0 ? Math.round((section.sourceEventCount / captured) * 100) : 0;
          return (
            <button
              key={section.kind}
              type="button"
              className={`report-work-card is-${section.kind} ${seen ? "is-observed" : "is-empty"}`}
              disabled={!seen}
              title={`${section.description} ${section.evidenceRule}`}
              aria-label={`${section.label}: ${seen ? `${share}% of changes captured, ${countLabel(section.sourceEventCount, "change")}, ${countLabel(section.decisionCount, "decision")}` : "not seen this version"}`}
              onClick={() => onInspect({
                title: section.label,
                subtitle: `${section.description} ${section.evidenceRule}`,
                ids: section.evidenceIds,
              })}
            >
              <span className="report-work-card__icon"><ProducerWorkIcon kind={section.kind} /></span>
              <span className="report-work-card__body">
                <strong>{section.label}</strong>
                <small>{seen ? countLabel(section.decisionCount, "decision") : "Not seen this version"}</small>
              </span>
              <span className="report-work-card__count">
                <b>{seen ? `${share}%` : "--"}</b>
                <small>{seen ? countLabel(section.sourceEventCount, "change") : "none"}</small>
              </span>
              <span className="report-work-card__meter"><i style={{ width: `${share}%` }} /></span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

function ChangesStep({ report, onInspect }: { report: SessionReport; onInspect: (request: EvidenceRequest) => void }) {
  const [kind, setKind] = useState<"all" | ProducerWorkKind>("all");
  const seenSections = report.workSections.filter((section) => section.decisionCount > 0);
  const filtered = report.decisions.filter((decision) => kind === "all" || decision.workKind === kind);
  const maxDecisions = Math.max(1, ...seenSections.map((section) => section.decisionCount));

  return (
    <div className="report-decisions">
      <section className="report-decision-summary" aria-label="Filter by kind of work">
        {seenSections.map((section) => (
          <button
            key={section.kind}
            type="button"
            className={`${kind === section.kind ? "is-active" : ""} is-${section.kind}`}
            aria-pressed={kind === section.kind}
            onClick={() => setKind(kind === section.kind ? "all" : section.kind)}
          >
            <i><ProducerWorkIcon kind={section.kind} /></i>
            <strong>{section.decisionCount}</strong>
            <span>{section.label}</span>
            <em><b style={{ width: `${(section.decisionCount / maxDecisions) * 100}%` }} /></em>
          </button>
        ))}
      </section>
      <section className="report-ledger">
        <div className="report-ledger__toolbar">
          <div>
            <span className="eyebrow">
              {kind === "all"
                ? "Everything, oldest first"
                : `Only ${producerWorkDefinition(kind).label.toLocaleLowerCase()}`}
            </span>
            <h2>{countLabel(filtered.length, "decision")}</h2>
          </div>
          {kind !== "all" && (
            <button type="button" className="report-clear" onClick={() => setKind("all")}>Show everything</button>
          )}
        </div>
        <DecisionTable decisions={filtered} onInspect={onInspect} />
      </section>
    </div>
  );
}

function ComparisonStep({
  baselineCandidates,
  baselineId,
  baselineReport,
  baselineStatus,
  baselineError,
  comparison,
  onBaselineChange,
  onInspect,
}: {
  baselineCandidates: SavedSessionMetadata[];
  baselineId: string | null;
  baselineReport: SessionReport | null;
  baselineStatus: LoadState;
  baselineError: string | null;
  comparison: ReportComparison | null;
  onBaselineChange: (id: string) => void;
  onInspect: (request: EvidenceRequest) => void;
}) {
  if (baselineCandidates.length === 0) {
    return (
      <ReportEmpty
        title="This is the only version so far"
        body="Once this project has a second captured version, this step shows what changed between them."
      />
    );
  }
  return (
    <div className="report-compare">
      <div className="report-ledger__toolbar">
        <div>
          <span className="eyebrow">This version, against an earlier one</span>
          <h2>What changed</h2>
        </div>
        <label>
          <span>Compare against</span>
          <select value={baselineId ?? ""} onChange={(event) => onBaselineChange(event.target.value)}>
            {baselineCandidates.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>{sessionLabel(candidate)}</option>
            ))}
          </select>
        </label>
      </div>
      {baselineStatus === "loading" && <ReportLoading compact />}
      {baselineStatus === "error" && (
        <p className="report-inline-error">Could not load that version to compare against: {baselineError}</p>
      )}
      {comparison && baselineReport && (
        <>
          <section className="report-compare__metrics">
            {comparison.metrics.map((metric) => (
              <article key={metric.label}>
                <header>
                  <span><ReportIcon name={comparisonMetricIcon(metric.label)} /></span>
                  <strong>{metric.label}</strong>
                  <b className={metric.delta === 0 ? "" : metric.delta > 0 ? "is-up" : "is-down"}>
                    {deltaLabel(metric.delta, metric.format === "duration")}
                  </b>
                </header>
                <div className="report-compare__values">
                  <span><small>Then</small><strong>{metric.format === "duration" ? formatDuration(metric.baseline) : metric.baseline.toLocaleString()}</strong></span>
                  <i aria-hidden="true">→</i>
                  <span><small>Now</small><strong>{metric.format === "duration" ? formatDuration(metric.current) : metric.current.toLocaleString()}</strong></span>
                </div>
                <div className="report-compare__meter" aria-hidden="true">
                  <i style={{ width: `${(metric.baseline / Math.max(1, metric.baseline, metric.current)) * 100}%` }} />
                  <b style={{ width: `${(metric.current / Math.max(1, metric.baseline, metric.current)) * 100}%` }} />
                </div>
              </article>
            ))}
          </section>

          <div className="report-compare__grid">
            <section className="report-card">
              <div className="report-section-heading">
                <div><span className="eyebrow">Only in this version</span><h2>New this time</h2></div>
                <span>{comparison.onlyCurrent.length}</span>
              </div>
              {/* Both lists render in full. They used to stop at eight with no
                  note, so a producer reading "14" counted eight rows. */}
              {comparison.onlyCurrent.length > 0
                ? <DecisionList decisions={comparison.onlyCurrent} onInspect={onInspect} compact />
                : <p className="report-quiet">Everything here also happened in the earlier version.</p>}
            </section>
            <section className="report-card">
              <div className="report-section-heading">
                <div><span className="eyebrow">Only in the earlier version</span><h2>Not repeated</h2></div>
                <span>{comparison.onlyBaseline.length}</span>
              </div>
              {comparison.onlyBaseline.length > 0 ? (
                <div className="report-compare__baseline-list">
                  {comparison.onlyBaseline.map((decision) => (
                    <div key={decision.id}><strong>{decision.subject}</strong><span>{decision.outcome}</span></div>
                  ))}
                </div>
              ) : <p className="report-quiet">You revisited everything the earlier version touched.</p>}
            </section>
          </div>

          {comparison.structural && (
            <section className="report-structural-diff">
              <div className="report-section-heading">
                <div>
                  {/* Named for its source, because it can disagree with the
                      lists above: this compares the two saved sets, while they
                      compare the work Recall watched. */}
                  <span className="eyebrow">From the two saved sets, not from the work</span>
                  <h2>What the set gained and lost</h2>
                </div>
              </div>
              <div>
                <DiffGroup label="Tracks added" items={comparison.structural.addedTracks} />
                <DiffGroup label="Tracks removed" items={comparison.structural.removedTracks} />
                <DiffGroup label="Devices added" items={comparison.structural.addedDevices.map((item) => `${item.device} · ${item.track}`)} />
                <DiffGroup label="Devices removed" items={comparison.structural.removedDevices.map((item) => `${item.device} · ${item.track}`)} />
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}

/** The activity chart's numbers, for anyone who would rather read than hover. */
function ReportSeriesTable({ report }: { report: SessionReport }) {
  const seen = report.workSections.filter((section) => section.sourceEventCount > 0);
  return (
    <details className="report-graph-data">
      <summary>Read this as a table</summary>
      <table>
        <thead>
          <tr><th>From</th><th>Changes</th>{seen.map((section) => <th key={section.kind}>{section.label}</th>)}</tr>
        </thead>
        <tbody>
          {report.series.map((bucket) => (
            <tr key={bucket.index}>
              <td>{formatClock(bucket.startMs)}</td><td>{bucket.total}</td>
              {seen.map((section) => <td key={section.kind}>{bucket.workCounts[section.kind]}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}

function ReportMetric({ icon, value, label, accent = false }: { icon: ReportGlyph; value: string; label: string; accent?: boolean }) {
  return (
    <div className={accent ? "is-moment" : ""}>
      <span className="report-metric__icon"><ReportIcon name={icon} /></span>
      <span className="report-metric__value"><strong>{value}</strong><small>{label}</small></span>
    </div>
  );
}

function DecisionList({ decisions, onInspect, compact = false }: {
  decisions: ReportDecision[];
  onInspect: (request: EvidenceRequest) => void;
  compact?: boolean;
}) {
  return (
    <div className={`report-decision-list ${compact ? "is-compact" : ""}`}>
      {decisions.map((decision) => (
        <button
          key={decision.id}
          type="button"
          onClick={() => onInspect({
            title: decision.subject,
            subtitle: [decision.track, producerWorkDefinition(decision.workKind).label].filter(Boolean).join(" · "),
            ids: decision.evidenceIds,
          })}
        >
          <span className={`report-decision-list__kind is-${decision.workKind}`} title={producerWorkDefinition(decision.workKind).label}>
            <ProducerWorkIcon kind={decision.workKind} />
          </span>
          <span className="report-decision-list__body"><strong>{decision.subject}</strong><small>{decision.track ?? "Whole set"}</small></span>
          <span className="report-decision-list__outcome">{decision.outcome}</span>
          {decision.count > 1 && <span className="report-count">{decision.count}×</span>}
        </button>
      ))}
    </div>
  );
}

function DecisionTable({ decisions, onInspect }: {
  decisions: ReportDecision[];
  onInspect: (request: EvidenceRequest) => void;
}) {
  if (decisions.length === 0) {
    return (
      <ReportEmpty
        title="Nothing of this kind was captured"
        body="Clear the filter to see everything Recall recorded for this version."
      />
    );
  }
  return (
    <div className="report-decision-table" role="table" aria-label="Every decision, oldest first">
      <div className="report-decision-table__head" role="row">
        <span role="columnheader">Time</span><span role="columnheader">What you did</span>
        <span role="columnheader">Where</span><span role="columnheader">How it ended up</span>
      </div>
      {decisions.map((decision) => (
        <button
          key={decision.id}
          type="button"
          role="row"
          onClick={() => onInspect({
            title: decision.subject,
            subtitle: [decision.track, producerWorkDefinition(decision.workKind).label].filter(Boolean).join(" · "),
            ids: decision.evidenceIds,
          })}
        >
          <time role="cell">{formatClock(decision.atMs)}</time>
          <span role="cell" className="report-decision-table__action">
            <i className={`is-${decision.workKind}`}><ProducerWorkIcon kind={decision.workKind} /></i>
            <span><strong>{decision.subject}</strong><small>{producerWorkDefinition(decision.workKind).label}</small></span>
          </span>
          {/* "Whole set" rather than a work-area name: this column answers
              where, and the work area is already the line underneath. */}
          <span role="cell">{decision.track ?? "Whole set"}</span>
          <span role="cell" className="report-decision-table__result">{decision.outcome}{decision.count > 1 && <b>{decision.count}×</b>}</span>
        </button>
      ))}
    </div>
  );
}

function DiffGroup({ label, items }: { label: string; items: string[] }) {
  return (
    <div className="report-diff-group">
      <strong>{label}</strong>
      {items.length > 0 ? <ul>{items.map((item, index) => <li key={`${item}-${index}`}>{item}</li>)}</ul> : <span>None</span>}
    </div>
  );
}

function comparisonMetricIcon(label: string): ReportGlyph {
  if (/hands-on/i.test(label)) return "time";
  if (/action/i.test(label)) return "actions";
  if (/decision/i.test(label)) return "decisions";
  if (/track/i.test(label)) return "tracks";
  return "trend";
}

function EvidenceKindIcon({ kind }: { kind: ReportEvidence["kind"] }) {
  if (kind === "midi") return <ProducerWorkIcon kind="writing" />;
  if (kind === "clip") return <ProducerWorkIcon kind="sound" />;
  if (kind === "structure") return <ProducerWorkIcon kind="arrangement" />;
  if (kind === "moment") return <ProducerWorkIcon kind="moment" />;
  return <ReportIcon name="actions" />;
}

function EvidenceDrawer({ request, items, report, onClose }: {
  request: EvidenceRequest;
  items: ReportEvidence[];
  report: SessionReport;
  onClose: () => void;
}) {
  return createPortal(
    <div className="report-evidence-backdrop" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose(); }}>
      <aside className="report-evidence" role="dialog" aria-modal="true" aria-labelledby="report-evidence-title">
        <header>
          <div><span className="eyebrow">The changes behind this</span><h2 id="report-evidence-title">{request.title}</h2>{request.subtitle && <p>{request.subtitle}</p>}</div>
          <button type="button" onClick={onClose} aria-label="Close evidence">×</button>
        </header>
        <div className="report-evidence__trust">
          <strong>{report.trust.label}</strong>
          <span>{report.trust.detail}</span>
        </div>
        {items.length > 0 ? (
          <ol>
            {items.map((item) => (
              <li key={item.id}>
                <time>{formatClock(item.atMs)}</time>
                <span className={`report-evidence__mark is-${item.kind}`} aria-hidden="true"><EvidenceKindIcon kind={item.kind} /></span>
                <div><strong>{item.subject}</strong><span>{item.detail}</span><small>{item.track ?? "Whole set"}</small></div>
              </li>
            ))}
          </ol>
        ) : <ReportEmpty title="No individual changes to show here" body="This card summarises the session rather than pointing at particular changes." />}
      </aside>
    </div>,
    document.body,
  );
}

function ReportLoading({ compact = false }: { compact?: boolean }) {
  return (
    <div className={`report-loading ${compact ? "is-compact" : ""}`} role="status">
      <span>Reading the session back</span><i /><i /><i />
    </div>
  );
}

function ReportEmpty({ title, body }: { title: string; body: string }) {
  return <div className="report-empty"><span aria-hidden="true" /><strong>{title}</strong><p>{body}</p></div>;
}

function TimelineIcon() {
  return (
    <svg viewBox="0 0 18 18" width="16" height="16" fill="none" aria-hidden="true">
      <path d="M2.5 4.5h13M2.5 9h13M2.5 13.5h13" stroke="currentColor" strokeWidth="1.25" />
      <circle cx="5" cy="4.5" r="1.5" fill="currentColor" />
      <circle cx="11" cy="9" r="1.5" fill="currentColor" />
      <circle cx="7.5" cy="13.5" r="1.5" fill="currentColor" />
    </svg>
  );
}
