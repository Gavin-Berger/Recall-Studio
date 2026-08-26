import {
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
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
import { formatSessionDate, preferredCaptureTitle } from "../sessionFormat";
import {
  buildVersionReport,
  compareSessionReports,
  type ReportComparison,
  type ReportDecision,
  type ReportEvidence,
  type ReportWorkSection,
  type SessionReport,
  type SessionReportInput,
} from "./sessionReport";
import {
  projectVersions,
  versionForSession,
  versionSessionsToRead,
  versionSittingCount,
  type ProjectVersion,
} from "./projectVersions";
import { buildReportPreview, isReportPreviewSession } from "./sessionReportPreview";
import { ProducerWorkIcon, ReportIcon, type ReportGlyph } from "./ReportIcons";

const InteractiveReportChart = lazy(() => import("./InteractiveReportChart").then((module) => ({
  default: module.InteractiveReportChart,
})));
const TrackConstellation = lazy(() => import("./TrackConstellation").then((module) => ({
  default: module.TrackConstellation,
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

async function loadCapture(sessionId: string): Promise<SessionReportInput> {
  await materializeSessionSchema(sessionId);
  const [session, schema, changes, noteEdits, clipEvents, moments] = await Promise.all([
    loadSessionEvents(sessionId),
    getProjectSchema(sessionId),
    getParameterChanges(sessionId),
    getNoteEdits(sessionId),
    getTimelineClipEvents(sessionId),
    listCreativeMoments(sessionId),
  ]);
  return { session, schema, changes, noteEdits, clipEvents, moments };
}

/**
 * Read one version — every sitting captured against its `.als`, as one report.
 *
 * A version usually has several captures behind it (app restarts, long breaks,
 * reopening the set), and reading only the selected one showed a fragment of
 * the version's history while the picker called it the whole thing.
 */
async function loadVersion(sessionIds: string[]): Promise<SessionReport> {
  if (import.meta.env.DEV && sessionIds.some(isReportPreviewSession)) {
    return buildReportPreview(sessionIds[0]!);
  }
  const captures = await Promise.all(sessionIds.map(loadCapture));
  return buildVersionReport(captures);
}

function sessionLabel(session: SavedSessionMetadata): string {
  return (
    preferredCaptureTitle(session) ??
    `${formatSessionDate(session.started_at_ms)} · ${formatClock(session.started_at_ms)}`
  );
}

/**
 * One line per version in the picker.
 *
 * The old line said `name · 2:01 PM · 178 recorded events` per capture, which
 * put the same `.als` on screen five times, showed a bare clock time with no
 * date (so rows days apart looked minutes apart), and offered zero-event
 * checkpoints as though they were readable versions. A version now reports its
 * own span and how many sittings went into it.
 */
function versionPickerLabel(version: ProjectVersion): string {
  const sittings = versionSittingCount(version);
  if (sittings === 0) return `${version.name} · opened, nothing captured yet`;

  const work = `${version.creativeEventCount.toLocaleString()} changes`;
  const across = sittings === 1 ? "one sitting" : `${sittings} sittings`;
  // The date is the part that was missing. Two rows an hour apart on the clock
  // can be a week apart in the project.
  const when = formatSessionDate(version.lastUpdatedAtMs);
  return `${version.name} · ${work} across ${across} · ${when}`;
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

function humanList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "captured work";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}`;
}

function scoreStoryCopy(
  report: SessionReport,
  sections: SessionReport["workSections"],
): { lead: string; detail: string | null } {
  const leading = sections.slice(0, 3);
  const tracks = report.ledger.tracksTouched;
  const areas = humanList(leading.map((section) => section.label));
  const lead = tracks > 0
    ? `You shaped ${tracks.toLocaleString()} ${tracks === 1 ? "track" : "tracks"} across ${areas}.`
    : "Recall has not seen enough work to describe this version yet.";

  const first = leading[0];
  const second = leading[1];
  const third = leading[2];
  if (!first) return { lead, detail: null };
  const detail = second && third
    ? `${first.label} carried ${countLabel(first.sourceEventCount, "captured change")}, followed by ${second.label} (${second.sourceEventCount.toLocaleString()}) and ${third.label} (${third.sourceEventCount.toLocaleString()}).`
    : second
      ? `${first.label} carried ${countLabel(first.sourceEventCount, "captured change")}, followed by ${second.label} (${second.sourceEventCount.toLocaleString()}).`
      : `${first.label} carried ${countLabel(first.sourceEventCount, "captured change")}.`;
  return { lead, detail };
}

type ScoreBar = {
  key: string;
  label: string;
  count: number;
  percent: number;
  subtitle: string;
  evidenceIds: string[];
};

/**
 * Whole percentages that add up to exactly 100.
 *
 * Rounding each share on its own lets three bars print 47/41/12 in one session
 * and 47/41/13 in the next. Largest-remainder hands the leftover points to the
 * biggest fractions, so a column a reader can add up in their head always
 * totals the whole. `counts` must be the set `total` was summed from.
 */
export function wholePercentages(counts: number[], total: number): number[] {
  if (total <= 0) return counts.map(() => 0);
  const exact = counts.map((count) => (count / total) * 100);
  const shares = exact.map((value) => Math.floor(value));
  let leftover = 100 - shares.reduce((sum, value) => sum + value, 0);
  const byFraction = exact
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index);
  for (const entry of byFraction) {
    if (leftover <= 0) break;
    shares[entry.index] += 1;
    leftover -= 1;
  }
  return shares;
}

/**
 * The work areas as ranked magnitudes, measured against the captured total.
 *
 * The panel used to draw three donuts whose arc was `count / biggest count`,
 * floored at 14%. None of that is a quantity a producer can name: the leader
 * was always a full ring, the floor made one change in forty look like a
 * seventh of the session, the ring colour came from the area's kind so the
 * smallest area could be the loudest thing on screen, and every area past third
 * place was dropped without a word. Share of the captured total is the one
 * denominator the rest of the page already agrees with, and the tail folds into
 * a single row instead of vanishing, so the bars always sum to the session.
 */
/**
 * How many areas get their own bar before the tail is folded.
 *
 * Producer work is a closed taxonomy of seven kinds, so in practice every area
 * that saw work gets named and nothing is folded. The cap is a safety valve for
 * a taxonomy that grows, not a summarising device — a folded row can easily
 * outweigh the named rows below it, which would make a ranked list read as
 * mis-sorted.
 */
const SCORE_BAR_LIMIT = 6;

export function scoreBars(sections: ReportWorkSection[]): ScoreBar[] {
  const ranked = sections
    .filter((section) => section.sourceEventCount > 0)
    .sort((a, b) => b.sourceEventCount - a.sourceEventCount || a.label.localeCompare(b.label));
  const total = ranked.reduce((sum, section) => sum + section.sourceEventCount, 0);
  if (total === 0) return [];

  const named = ranked.slice(0, SCORE_BAR_LIMIT);
  const rest = ranked.slice(SCORE_BAR_LIMIT);
  const rows = named.map((section) => ({
    key: String(section.kind),
    label: section.label,
    count: section.sourceEventCount,
    subtitle: countLabel(section.sourceEventCount, "captured change"),
    evidenceIds: section.evidenceIds,
  }));

  if (rest.length > 0) {
    const restCount = rest.reduce((sum, section) => sum + section.sourceEventCount, 0);
    rows.push({
      key: "rest",
      label: `${rest.length} more ${rest.length === 1 ? "area" : "areas"}`,
      count: restCount,
      subtitle: humanList(rest.map((section) => section.label)),
      evidenceIds: rest.flatMap((section) => section.evidenceIds),
    });
  }

  const percents = wholePercentages(rows.map((row) => row.count), total);
  return rows.map((row, index) => ({ ...row, percent: percents[index]! }));
}

function activityWindowLabel(report: SessionReport): string {
  const { activityStartMs: start, activityEndMs: end } = report;
  if (start === null || end === null || end <= start) return "One focused pass";
  const span = end - start;
  const longProjectWindow = span >= 24 * 60 * 60_000 && span > report.handsOnMs * 3;
  return longProjectWindow
    ? `Work spread across ${formatDuration(span)}`
    : `${formatDuration(span)} capture window`;
}

/**
 * How much new work has to arrive before the report rebuilds itself.
 *
 * Rebuilding is a full schema re-materialization plus a re-analysis of every
 * activity, so it cannot ride the once-a-second session poll. Twenty-five
 * changes is roughly a minute of steady knob work: often enough that the page
 * keeps up with a session, rare enough that it is not writing to disk while the
 * producer is trying to play.
 */
const REPORT_REFRESH_EVENT_STEP = 25;
const REPORT_REFRESH_DEBOUNCE_MS = 350;

/** Where a step sits in the walkthrough, for copy that points at another step. */
function nextStepNumber(id: ReportTab): number {
  return REPORT_TABS.findIndex((tab) => tab.id === id) + 1;
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
  // Bumped by the manual refresh control, so "catch me up now" always rebuilds
  // even when the event count has not crossed the next threshold.
  const [refreshNonce, setRefreshNonce] = useState(0);
  const loadedSessionIdRef = useRef<string | null>(null);
  // What the mounted report was actually built from, so the page can say how
  // many changes it has not shown you yet rather than pretending to be current.
  const renderedEventCountRef = useRef(0);
  // Which version the loaded baseline report is for, so returning to the
  // compare step does not pay for another full read of it.
  const loadedBaselineKeyRef = useRef<string | null>(null);
  // What to hand focus back to when the evidence drawer closes.
  const evidenceOpenerRef = useRef<HTMLElement | null>(null);

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
  // The picker lists versions, not captures. See projectVersions.ts for why
  // those are different things and how one .als ended up with five rows.
  const versions = useMemo(() => projectVersions(projectSessions), [projectSessions]);
  const activeVersion = useMemo(() => versionForSession(versions, sessionId), [versions, sessionId]);
  const versionSessionIds = useMemo(
    () => (activeVersion ? versionSessionsToRead(activeVersion).map((session) => session.id) : []),
    [activeVersion],
  );
  // Keyed on the ids themselves: adding a sitting to this version must reload,
  // but a re-render that produces the same set must not.
  const versionKey = versionSessionIds.join("|");
  // Coarse step rather than the raw count: the effect below re-runs when this
  // changes, so it must change 25x less often than `event_count` does.
  const refreshStep = Math.floor((activeVersion?.eventCount ?? 0) / REPORT_REFRESH_EVENT_STEP);
  const baselineCandidates = useMemo(
    () => versions.filter((version) => version.id !== activeVersion?.id && version.creativeEventCount > 0),
    [versions, activeVersion],
  );
  useEffect(() => {
    if (!sessionId || versionSessionIds.length === 0) {
      loadedSessionIdRef.current = null;
      setReport(null);
      setStatus("idle");
      return;
    }
    let cancelled = false;
    const changingSession = loadedSessionIdRef.current !== versionKey;

    // Rebuilding costs far more than the old comment here claimed.
    //
    // Each capture in the version starts with `materializeSessionSchema`, which
    // DELETEs and re-INSERTs that session's tracks, devices, parameters, and
    // parameter_changes inside a write transaction (storage.rs), then the
    // frontend re-analyses every activity from scratch. App polls the session
    // list once a second, so keying this effect on raw `event_count` meant a
    // full rebuild per second during capture, growing with session length —
    // and now that a version can span several captures, per sitting as well.
    //
    // Refreshing on a threshold keeps the report live without paying that on
    // every tick. `renderedEventCountRef` records what the mounted report was
    // actually built from, so the banner can say how far behind it is.
    if (changingSession) {
      setStatus("loading");
      setReport(null);
      setEvidenceRequest(null);
    }
    setError(null);

    const delay = changingSession ? 0 : REPORT_REFRESH_DEBOUNCE_MS;
    const timer = window.setTimeout(() => {
      void loadVersion(versionSessionIds)
        .then((nextReport) => {
          if (cancelled) return;
          loadedSessionIdRef.current = versionKey;
          renderedEventCountRef.current = activeVersion?.eventCount ?? 0;
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
    // Deliberately keyed on the coarse step, not on `event_count` itself: a
    // session streaming events must not re-trigger this on every tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, versionKey, refreshStep, refreshNonce]);

  useEffect(() => {
    if (!activeVersion) {
      setBaselineId(null);
      return;
    }
    // The previous version, by when work on it began — "since last time" means
    // the version before this one, not an arbitrary earlier capture.
    const before = baselineCandidates.filter((version) => version.startedAtMs < activeVersion.startedAtMs);
    const preferred = before.at(-1) ?? baselineCandidates.at(-1) ?? null;
    setBaselineId(preferred?.id ?? null);
  }, [baselineCandidates, activeVersion]);

  useEffect(() => {
    // Leaving the compare step used to discard the baseline, so every return
    // paid another full materialize + re-analysis. An earlier version is
    // immutable once its capture ended, so the loaded report stays valid; keep
    // it and let a baseline change be the only thing that reloads.
    if (activeTab !== "compare" || !baselineId) return;
    const baselineVersion = versions.find((version) => version.id === baselineId);
    if (!baselineVersion) return;
    if (loadedBaselineKeyRef.current === baselineId) return;
    let cancelled = false;
    loadedBaselineKeyRef.current = baselineId;
    setBaselineStatus("loading");
    setBaselineError(null);
    void loadVersion(versionSessionsToRead(baselineVersion).map((session) => session.id))
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
  }, [activeTab, baselineId, versions]);

  // Focus goes into the drawer when it opens and comes back to whatever opened
  // it when it closes. Declaring aria-modal without doing this is worse than
  // not declaring it: assistive tech announces a modal, then Tab walks straight
  // out into the page behind it.
  useEffect(() => {
    if (!evidenceRequest) return;
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setEvidenceRequest(null);
    }
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("keydown", closeOnEscape);
      // The opener is recorded at click time, not here: by the time this effect
      // runs the drawer's autoFocus has already moved activeElement onto the
      // close button, so reading it here would "restore" focus into a dialog
      // that is being unmounted. It can also be gone entirely if the drawer was
      // closed by a step change.
      const opener = evidenceOpenerRef.current;
      evidenceOpenerRef.current = null;
      if (opener?.isConnected) opener.focus();
    };
  }, [evidenceRequest]);

  /** Open the evidence drawer, remembering what to hand focus back to. */
  function openEvidence(request: EvidenceRequest) {
    evidenceOpenerRef.current = document.activeElement as HTMLElement | null;
    setEvidenceRequest(request);
  }

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
  // Was recomputed on every render — two Sets over every decision plus two
  // filters — including renders caused by opening the evidence drawer.
  const comparison = useMemo(
    () => (report && baselineReport ? compareSessionReports(report, baselineReport) : null),
    [report, baselineReport],
  );
  const activeStepIndex = Math.max(0, REPORT_TABS.findIndex((tab) => tab.id === activeTab));
  const activeStep = REPORT_TABS[activeStepIndex];
  // How far the rendered report is behind what capture has recorded. Shown
  // rather than silently absorbed, because a stale report that looks current is
  // the failure mode this refresh threshold introduces.
  const pendingChanges = report
    ? Math.max(0, (fallbackSession.event_count ?? 0) - renderedEventCountRef.current)
    : 0;
  // A session ID is storage plumbing, never a name a producer should have to read.
  // `sessionLabel` always prefers the saved .als/display name and falls back to time.
  const reportTitle = sessionLabel(fallbackSession);

  return (
    <div className="session-report">
      <header className="session-report__header">
        <div className="session-report__identity">
          <span className="eyebrow">Session Report</span>
          <h1>{reportTitle}</h1>
          <div className="session-report__context">
            <span>{formatSessionDate(fallbackSession.started_at_ms)} · {formatClock(fallbackSession.started_at_ms)}</span>
            <i aria-hidden="true" />
            <span className={`report-status report-status--${fallbackSession.ended_at_ms === null ? "live" : "settled"}`}>
              {fallbackSession.ended_at_ms === null ? "Live · auto-updating" : "Finished"}
            </span>
          </div>
        </div>

        <div className="session-report__header-tools">
          {versions.length > 1 && (
            <label className="session-report__take-picker">
              <span>Version</span>
              {/* Selecting a version selects its most recent recorded sitting,
                  because the rest of the app still addresses captures by id. */}
              <select
                value={activeVersion?.id ?? ""}
                onChange={(event) => {
                  const picked = versions.find((version) => version.id === event.target.value);
                  const target = picked ? versionSessionsToRead(picked).at(-1) : null;
                  if (target) onSelectSession(target.id);
                }}
              >
                {versions.map((version) => (
                  <option key={version.id} value={version.id}>
                    {versionPickerLabel(version)}
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
          {/* Staleness is stated, never hidden. The refresh threshold means the
              page can legitimately lag capture; a producer must be able to see
              that rather than read old numbers as current. */}
          {pendingChanges > 0 && (
            <div className="session-report__pending" role="status">
              <span>{countLabel(pendingChanges, "change")} recorded since this was built.</span>
              <button type="button" onClick={() => setRefreshNonce((nonce) => nonce + 1)}>
                Catch up
              </button>
            </div>
          )}

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
            {activeTab === "summary" && <SummaryStep report={report} onInspect={openEvidence} />}
            {activeTab === "chapters" && <ChaptersStep report={report} onInspect={openEvidence} />}
            {activeTab === "work" && <WorkStep report={report} onInspect={openEvidence} />}
            {activeTab === "changes" && <ChangesStep report={report} onInspect={openEvidence} />}
            {activeTab === "compare" && (
              <ComparisonStep
                baselineCandidates={baselineCandidates}
                baselineId={baselineId}
                baselineReport={baselineReport}
                baselineStatus={baselineStatus}
                baselineError={baselineError}
                comparison={comparison}
                onBaselineChange={setBaselineId}
                onInspect={openEvidence}
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
  const scoreSections = report.workSections
    .filter((section) => section.sourceEventCount > 0)
    .sort((a, b) => b.sourceEventCount - a.sourceEventCount || a.label.localeCompare(b.label))
    .slice(0, 3);
  const bars = scoreBars(report.workSections);
  const scoreStory = scoreStoryCopy(report, scoreSections);
  const focusTrack = report.lessons.find((lesson) => lesson.id === "focus")?.title
    ?? report.tracks
      .filter((track) => track.sourceEventCount > 0)
      .sort((a, b) => b.sourceEventCount - a.sourceEventCount || a.name.localeCompare(b.name))[0]
      ?.name;

  return (
    <div className="report-overview">
      <SessionLedger report={report} />

      <section className="report-score" aria-labelledby="report-score-title">
        <div className="report-score__head">
          <div>
            <span className="eyebrow">Session score</span>
            <h2 id="report-score-title">What you made move</h2>
          </div>
          <span className="report-score__stamp">{activityWindowLabel(report)}</span>
        </div>

        <div className="report-score__body">
          <div className="report-score__frame">
            <Suspense fallback={<div className="report-score__frame-loading">Forming track field…</div>}>
              <TrackConstellation
                tracks={report.tracks}
                onSelectTrack={(track) => onInspect({
                  title: track.name,
                  subtitle: `${track.workLabel} - ${countLabel(track.sourceEventCount, "captured change")}`,
                  ids: track.evidenceIds,
                })}
              />
            </Suspense>
          </div>

          <div className="report-score__read">
            <span className="report-score__caption">The movement, in plain language</span>
            <p className="report-score__lead">{scoreStory.lead}</p>
            {scoreStory.detail && <p className="report-score__detail">{scoreStory.detail}</p>}

            <dl className="report-score__figures">
              <div>
                <dt>Tracks touched</dt>
                {/* The one figure this view leads with. Proportional numerals:
                    tabular gives every digit the width of a zero, which reads
                    loose at display sizes. */}
                <dd className="report-score__hero">{formatMetric(report.ledger.tracksTouched)}</dd>
                {report.ledger.tracksInSet !== null && (
                  <dd className="report-score__hero-note">
                    of {formatMetric(report.ledger.tracksInSet)} in the set
                  </dd>
                )}
              </div>
              {focusTrack && (
                <div>
                  <dt>Focus landed on</dt>
                  <dd className="report-score__focus" title={focusTrack}>{focusTrack}</dd>
                </div>
              )}
            </dl>
          </div>
        </div>

        <div className="report-score__work">
          <h3 className="report-score__caption">The work that carried it</h3>
          {bars.length > 0 ? (
            <ol>
              {bars.map((bar) => (
                <li key={bar.key} style={{ "--score-share": `${bar.percent}%` } as CSSProperties}>
                  <button
                    type="button"
                    aria-label={`${bar.label}, ${bar.subtitle}, ${bar.percent}% of the work captured in this version`}
                    onClick={() => onInspect({
                      title: bar.label,
                      subtitle: bar.subtitle,
                      ids: bar.evidenceIds,
                    })}
                  >
                    <span className="report-score__work-name">{bar.label}</span>
                    <span className="report-score__work-track" aria-hidden="true"><i /></span>
                    <span className="report-score__work-value" aria-hidden="true">
                      <b>{bar.count.toLocaleString()}</b>
                      <em>{bar.percent}%</em>
                    </span>
                  </button>
                </li>
              ))}
            </ol>
          ) : (
            <p className="report-score__empty">No work has been captured for this version yet.</p>
          )}
        </div>
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

      {/* Derived, never hardcoded: reordering REPORT_TABS must not leave this
          sentence pointing at the wrong step. */}
      <p className="report-next-step">
        {report.ledger.capturedCount > 0
          ? `Step ${nextStepNumber("chapters")} breaks the same session into the stretches you actually worked in.`
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
        <section className="report-ledger-note" aria-label="Capture mix">
          <div className="report-ledger-note__heading">
            <span>Capture mix</span>
            <strong>Where the {ledger.capturedCount.toLocaleString()} changes came from</strong>
          </div>
          <div className="report-ledger-note__breakdown">
            <span className="is-hands-on">
              <b>{ledger.handsOnCount.toLocaleString()}</b>
              <small>Your hands</small>
            </span>
            <span className="is-reported">
              <b>{ledger.reportedCount.toLocaleString()}</b>
              <small>Live observed</small>
            </span>
            {ledger.momentCount > 0 && (
              <span className="is-moment">
                <b>{ledger.momentCount.toLocaleString()}</b>
                <small>Saved moments</small>
              </span>
            )}
          </div>
          <div className="report-ledger-note__rules">
            {ledger.groupedCount > 0 && (
              <span><b>{ledger.decisionCount.toLocaleString()} decisions</b> after repeat moves collapse</span>
            )}
            {ledger.mixerTouched && <span>Volume, pan, and sends read as mixing</span>}
          </div>
        </section>
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
          // rowgroup > row > cell. The cells used to sit directly inside the
          // rowgroup with no row between them, which is a malformed ARIA table —
          // a screen reader gets orphaned cells. The button carries the row role
          // so the disclosure state travels with it.
          return (
            <div key={track.id} className={`report-track-row ${selected ? "is-selected" : ""}`} role="rowgroup">
              <button
                type="button"
                role="row"
                className="report-track-row__summary"
                aria-expanded={selected}
                onClick={() => setSelectedId(selected ? null : track.id)}
              >
                <span className="report-track-row__name" role="cell">
                  <i>{track.number !== null ? String(track.number).padStart(2, "0") : "--"}</i>
                  <span>
                    <strong>{track.name}</strong>
                    {/* Says out loud that Recall could not tell which track
                        this work belongs to, rather than picking one. */}
                    <small>
                      {track.ambiguousName !== null
                        ? `${track.ambiguousName} tracks share this name — cannot tell which`
                        : track.type ? TRACK_TYPE_LABEL[track.type] : "Track"}
                    </small>
                  </span>
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
          // Never `disabled`. A kind Recall did not see still has to explain
          // what it counts — that is exactly when a producer asks. A disabled
          // button cannot be focused, so the old version made the taxonomy
          // unreachable by keyboard and invisible without a mouse hover.
          return (
            <button
              key={section.kind}
              type="button"
              className={`report-work-card is-${section.kind} ${seen ? "is-observed" : "is-empty"}`}
              aria-label={`${section.label}: ${seen ? `${share}% of changes captured, ${countLabel(section.sourceEventCount, "change")}, ${countLabel(section.decisionCount, "decision")}` : "not seen this version"}`}
              onClick={() => onInspect({
                title: section.label,
                subtitle: section.description,
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
              {/* Visible, not a tooltip. This is the page's mental model and it
                  was previously readable only by hovering. */}
              <span className="report-work-card__rule">{section.evidenceRule}</span>
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
        <DecisionTable
          decisions={filtered}
          onInspect={onInspect}
          filterLabel={kind === "all" ? null : producerWorkDefinition(kind).label}
        />
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
  baselineCandidates: ProjectVersion[];
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
              <option key={candidate.id} value={candidate.id}>{versionPickerLabel(candidate)}</option>
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
                  <span><ReportIcon name={metric.icon} /></span>
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

function DecisionTable({ decisions, onInspect, filterLabel = null }: {
  decisions: ReportDecision[];
  onInspect: (request: EvidenceRequest) => void;
  /** The active work-area filter, so the table does not claim to show everything. */
  filterLabel?: string | null;
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
    <div
      className="report-decision-table"
      role="table"
      aria-label={filterLabel
        ? `${decisions.length} ${filterLabel.toLocaleLowerCase()} decisions, oldest first`
        : "Every decision, oldest first"}
    >
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
  const panelRef = useRef<HTMLElement | null>(null);
  const [expanded, setExpanded] = useState(false);

  // Keep Tab inside the dialog. Without this the "modal" is a suggestion.
  function trapFocus(event: ReactKeyboardEvent<HTMLElement>) {
    if (event.key !== "Tab") return;
    const focusable = panelRef.current?.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    if (!focusable || focusable.length === 0) return;
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    const active = document.activeElement;
    if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return createPortal(
    <div className="report-evidence-backdrop" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose(); }}>
      <aside
        ref={panelRef}
        className={`report-evidence ${expanded ? "is-expanded" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="report-evidence-title"
        onKeyDown={trapFocus}
      >
        <header>
          <div><span className="eyebrow">The changes behind this</span><h2 id="report-evidence-title">{request.title}</h2>{request.subtitle && <p>{request.subtitle}</p>}</div>
          <div className="report-evidence__controls">
            <button
              type="button"
              onClick={() => setExpanded((current) => !current)}
              aria-label={expanded ? "Use compact evidence panel" : "Expand evidence panel"}
              title={expanded ? "Use compact panel" : "Expand panel"}
            >
              <EvidencePanelIcon expanded={expanded} />
            </button>
            {/* autoFocus lands the reader inside the dialog rather than leaving
                focus on the card behind it. */}
            <button type="button" autoFocus onClick={onClose} aria-label="Close evidence" title="Close">
              <CloseIcon />
            </button>
          </div>
        </header>
        <div className="report-evidence__trust">
          <strong>{report.trust.label}</strong>
          <span>{report.trust.detail}</span>
        </div>
        {items.length > 0 ? (
          <ol>
            {items.map((item) => <EvidenceRow key={item.id} item={item} />)}
          </ol>
        ) : <ReportEmpty title="No individual changes to show here" body="This card summarises the session rather than pointing at particular changes." />}
      </aside>
    </div>,
    document.body,
  );
}

function EvidenceRow({ item }: { item: ReportEvidence }) {
  const [open, setOpen] = useState(false);
  const detailId = `report-evidence-detail-${item.id.replace(/[^a-z0-9_-]/giu, "-")}`;

  return (
    <li className={open ? "is-expanded" : undefined}>
      <time>{formatClock(item.atMs)}</time>
      <span className={`report-evidence__mark is-${item.kind}`} aria-hidden="true"><EvidenceKindIcon kind={item.kind} /></span>
      <button
        type="button"
        className="report-evidence__toggle"
        aria-expanded={open}
        aria-controls={detailId}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="report-evidence__summary">
          <strong>{item.subject}</strong>
          <small>{item.track ?? "Whole set"}</small>
        </span>
        <EvidenceChevron open={open} />
      </button>
      {open && (
        <div id={detailId} className="report-evidence__detail">
          <span>{item.detail}</span>
        </div>
      )}
    </li>
  );
}

function EvidencePanelIcon({ expanded }: { expanded: boolean }) {
  return (
    <svg viewBox="0 0 18 18" aria-hidden="true">
      {expanded ? (
        <path d="M7 3H3v4M11 3h4v4M7 15H3v-4M11 15h4v-4M3 3l4 4M15 3l-4 4M3 15l4-4M15 15l-4-4" />
      ) : (
        <path d="M7 7H3V3m8 4h4V3M7 11H3v4m8-4h4v4M3 3l4 4m8-4-4 4M3 15l4-4m8 4-4-4" />
      )}
    </svg>
  );
}

function EvidenceChevron({ open }: { open: boolean }) {
  return (
    <svg className={`report-evidence__chevron ${open ? "is-open" : ""}`} viewBox="0 0 18 18" aria-hidden="true">
      <path d="m5 7 4 4 4-4" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 18 18" aria-hidden="true">
      <path d="m5 5 8 8M13 5l-8 8" />
    </svg>
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
