import { useCallback, useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { listen } from "@tauri-apps/api/event";
import { save } from "@tauri-apps/plugin-dialog";
import "./SchemaTimeline.css";
import {
  createCreativeMoment,
  deleteCreativeMoment,
  getParameterChanges,
  getProjectSchema,
  listCreativeMoments,
  materializeSessionSchema,
  writeTextFile,
} from "../../lib/schema/api";
import {
  DEVICE_ROLE_LABEL,
  TRACK_TYPE_LABEL,
  type CreativeMoment,
  type ParameterChange,
  type ProjectSchema,
  type SavedSessionMetadata,
} from "../../types";
import {
  activeDurationMs,
  ActivitySpark,
  buildLookups,
  buildShareData,
  buildShareDocument,
  buildTicks,
  CopyIcon,
  cumulativeMovePaths,
  deviceColor,
  describeActivity,
  ExportIcon,
  exportPdf,
  formatDuration,
  formatElapsed,
  formatPercent,
  formatTakeTitle,
  BLOCK_GAP_MS,
  BRIDGE_LOG_LIMIT,
  LIVE_REFRESH_DEBOUNCE_MS,
  LIVE_SAFETY_POLL_MS,
  LIVE_REFRESH_EVENT_TYPES,
  moveValueNode,
  moveWhatNode,
  noteTrackId,
  pct,
  ScanEmptyState,
  ScanIcon,
  trackColor,
  type Activity,
  type ActivityGroup,
  type ExportFormat,
  type LiveRecallEvent,
  type SessionBlock,
  type LoadStatus,
} from "./timeline";

export function SchemaTimeline({
  sessionId,
  session,
}: {
  sessionId: string | null;
  session: SavedSessionMetadata | null;
}) {
  const [schema, setSchema] = useState<ProjectSchema | null>(null);
  const [changes, setChanges] = useState<ParameterChange[]>([]);
  const [moments, setMoments] = useState<CreativeMoment[]>([]);
  const [status, setStatus] = useState<LoadStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [selectedTrackId, setSelectedTrackId] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState("");
  const [noteStar, setNoteStar] = useState(false);
  // Rolling tail of raw events, newest first — a "is capture actually arriving,
  // and from which tier" readout while the M4L bridge and the Python control
  // surface both exist.
  const [bridgeLog, setBridgeLog] = useState<LiveRecallEvent[]>([]);
  const [bridgeLogOpen, setBridgeLogOpen] = useState(false);
  // Group ids the user expanded to see each move inside a collapsed run.
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  // Transient "Copied!" feedback for the share button.
  const [copied, setCopied] = useState(false);
  // Selected export format for copy/save.
  const [exportFormat, setExportFormat] = useState<ExportFormat>("md");

  const load = useCallback(
    async (rematerialize: boolean, quiet = false) => {
      if (!sessionId) return;
      if (!quiet) setStatus("loading");
      setError(null);
      try {
        if (rematerialize) await materializeSessionSchema(sessionId);
        const [nextSchema, nextChanges, nextMoments] = await Promise.all([
          getProjectSchema(sessionId),
          getParameterChanges(sessionId),
          listCreativeMoments(sessionId),
        ]);
        setSchema(nextSchema);
        setChanges(nextChanges);
        setMoments(nextMoments);
        setStatus("ready");
      } catch (loadError) {
        setError(String(loadError));
        setStatus("error");
      }
    },
    [sessionId],
  );

  useEffect(() => {
    setSchema(null);
    setChanges([]);
    setMoments([]);
    setSelectedTrackId(null);
    void load(true);
  }, [sessionId, load]);

  useEffect(() => {
    if (!sessionId || session?.ended_at_ms !== null) return;

    let disposed = false;
    let unlisten: (() => void) | null = null;
    let refreshTimer: number | null = null;

    const scheduleRefresh = () => {
      if (refreshTimer !== null) window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => {
        refreshTimer = null;
        void load(true, true);
      }, LIVE_REFRESH_DEBOUNCE_MS);
    };

    // The backend emits one array per persisted batch rather than one message per
    // event: a burst used to mean thousands of individual IPC crossings into the
    // webview. This handler only decides whether to refresh, so a batch is
    // strictly cheaper — one crossing, one debounce, same outcome.
    void listen<LiveRecallEvent[]>("recall-events", (event) => {
      const incoming = event.payload;

      // Log EVERY event, not just refresh-triggering ones. The log's job is to
      // show that traffic is arriving at all — filtering it to the types that
      // happen to redraw the timeline would hide exactly the case you open it
      // for (something is being sent, but nothing appears).
      setBridgeLog((current) => [...incoming].reverse().concat(current).slice(0, BRIDGE_LOG_LIMIT));

      const relevant = incoming.some(
        (item) =>
          item.session_id === sessionId &&
          LIVE_REFRESH_EVENT_TYPES.has(item.event_type ?? ""),
      );
      if (!relevant) return;
      scheduleRefresh();
    }).then((cleanup) => {
      if (disposed) {
        cleanup();
      } else {
        unlisten = cleanup;
      }
    });

    // SAFETY NET: refresh on a slow interval regardless of pushes.
    //
    // The listener above is the fast path, but it is push-only, and a push that
    // never arrives leaves the timeline frozen FOREVER while events keep
    // persisting to disk. That is what happens when the OS suspends the webview
    // — alt-tab into a fullscreen game for a while and come back to a timeline
    // that stopped at the moment you left, even though capture never stopped.
    //
    // The interval is slow (LIVE_SAFETY_POLL_MS) because it exists to bound how
    // long a miss can last, not to drive normal updates. Pushes still do that.
    const safetyPoll = window.setInterval(() => {
      void load(true, true);
    }, LIVE_SAFETY_POLL_MS);

    // Refresh the moment the window comes back. Suspension is exactly when
    // pushes get dropped, and regaining focus is the strongest available signal
    // that we were gone — it makes recovery feel instant rather than making the
    // producer wait out the poll interval.
    const onWake = () => {
      if (document.visibilityState === "visible") void load(true, true);
    };
    window.addEventListener("focus", onWake);
    document.addEventListener("visibilitychange", onWake);

    return () => {
      disposed = true;
      if (refreshTimer !== null) window.clearTimeout(refreshTimer);
      if (unlisten) unlisten();
      window.clearInterval(safetyPoll);
      window.removeEventListener("focus", onWake);
      document.removeEventListener("visibilitychange", onWake);
    };
  }, [sessionId, session?.ended_at_ms, load]);

  const refreshMoments = useCallback(async () => {
    if (!sessionId) return;
    setMoments(await listCreativeMoments(sessionId));
  }, [sessionId]);

  // Lookups: which track owns a given parameter / device, so a change or a note
  // can be placed on the right lane.
  const lookups = useMemo(() => buildLookups(schema), [schema]);

  const tracks = useMemo(
    () => (schema ? [...schema.tracks].sort((a, b) => a.number - b.number) : []),
    [schema],
  );

  const bounds = useMemo(() => {
    const recording = session?.ended_at_ms === null;
    const sessionStart = session?.started_at_ms ?? (changes[0]?.changed_at_ms ?? Date.now());

    // Fit the axis to where work actually happened. A session left recording for
    // hours otherwise crushes every move into a sliver at the far left; we drop
    // that leading/trailing dead air by bounding to the first and last activity.
    const stamps: number[] = [];
    for (const change of changes) stamps.push(change.changed_at_ms);
    for (const moment of moments) stamps.push(moment.timeline_start_ms ?? moment.created_at_ms);

    let start: number;
    let end: number;
    if (stamps.length > 0) {
      start = Math.min(...stamps);
      end = Math.max(...stamps);
    } else {
      start = sessionStart;
      end = session?.ended_at_ms ?? Date.now();
    }

    // Breathing room so the first/last events aren't glued to the edges.
    const pad = Math.max((end - start) * 0.04, 1500);
    start -= pad;
    end += pad;
    if (end - start < 60_000) end = start + 60_000;

    return { start, end, span: end - start, recording, sessionStart };
  }, [session, changes, moments]);

  const activities = useMemo<Activity[]>(() => {
    const out: Activity[] = [];
    for (const change of changes) {
      const trackId =
        (change.parameter_id ? lookups.paramTrack.get(change.parameter_id) : undefined) ??
        (change.track_name ? lookups.nameTrack.get(change.track_name.toLowerCase()) : undefined);
      if (!trackId) continue;
      out.push({
        id: change.id,
        kind: "move",
        trackId,
        atMs: change.changed_at_ms,
        deviceName: change.device_name,
        paramName: change.parameter_name,
        before: change.before_value,
        after: change.after_value,
        beforePercent: change.before_value_percent,
        afterPercent: change.after_value_percent,
        unit: change.unit,
        beforeDisplay: change.before_display_value,
        afterDisplay: change.after_display_value,
        quantized: change.is_quantized,
      });
    }
    for (const moment of moments) {
      const trackId = noteTrackId(moment, lookups);
      if (!trackId) continue;
      out.push({
        id: moment.id,
        kind: "note",
        trackId,
        atMs: moment.timeline_start_ms ?? moment.created_at_ms,
        title: moment.title,
        starred: moment.confidence === "keeper" || moment.confidence === "final" || moment.tags.includes("keeper"),
      });
    }
    return out;
  }, [changes, moments, lookups]);

  // Buses sink to the bottom, Main last of all — the order Ableton's own mixer
  // uses, so it reads as a fixture rather than as a track that happened to sort
  // there. Regular tracks keep their existing number order above them.
  const lanes = useMemo(() => {
    const rank = (type: string) => (type === "master" ? 2 : type === "return" ? 1 : 0);
    return [...tracks]
      .sort((a, b) => rank(a.type) - rank(b.type))
      .map((track) => ({ track, items: activities.filter((a) => a.trackId === track.id) }));
  }, [tracks, activities]);

  // Shared y-scale for the per-lane activity graphs: the busiest channel peaks
  // at the top, so taller curve = more changes. Sorted move timestamps per lane
  // feed a cumulative step-line that builds left→right.
  const laneGraphs = useMemo(() => {
    const moveTimesByLane = new Map<string, number[]>();
    let maxMoves = 0;
    for (const lane of lanes) {
      const times = lane.items
        .filter((item) => item.kind === "move")
        .map((item) => item.atMs)
        .sort((a, b) => a - b);
      moveTimesByLane.set(lane.track.id, times);
      maxMoves = Math.max(maxMoves, times.length);
    }
    return { moveTimesByLane, maxMoves };
  }, [lanes]);

  // Right edge of every lane graph: the live playhead while recording, else the
  // full width so a finished take's curve reaches the end.
  const xEnd = bounds.recording ? pct(Date.now(), bounds) : 100;

  // Default the dock to the first track once a scan lands.
  useEffect(() => {
    if (tracks.length === 0) {
      if (selectedTrackId !== null) setSelectedTrackId(null);
      return;
    }
    if (!selectedTrackId || !tracks.some((track) => track.id === selectedTrackId)) {
      setSelectedTrackId(tracks[0].id);
    }
  }, [tracks, selectedTrackId]);

  const selectedTrack = tracks.find((track) => track.id === selectedTrackId) ?? null;
  const trackActivity = useMemo(
    () => activities.filter((a) => a.trackId === selectedTrackId).sort((a, b) => b.atMs - a.atMs),
    [activities, selectedTrackId],
  );
  const changedDeviceNames = useMemo(
    () => new Set(trackActivity.filter((a) => a.kind === "move" && a.deviceName).map((a) => a.deviceName as string)),
    [trackActivity],
  );

  // Collapse consecutive moves of the same device+parameter into one run so a
  // knob twiddled five times reads as a single decision (net before → after,
  // with a count), not five near-identical rows. Notes and switches between
  // params break a run. trackActivity is newest-first, so each group's lead is
  // its latest move and the net "before" comes from its oldest.
  const groupedActivity = useMemo<ActivityGroup[]>(() => {
    const out: ActivityGroup[] = [];
    for (const item of trackActivity) {
      const last = out[out.length - 1];
      const mergeable =
        item.kind === "move" &&
        last !== undefined &&
        last.lead.kind === "move" &&
        last.lead.deviceName === item.deviceName &&
        last.lead.paramName === item.paramName;
      if (mergeable) {
        last.items.push(item);
      } else {
        out.push({ key: item.id, lead: item, items: [item] });
      }
    }
    return out;
  }, [trackActivity]);

  // Headline for the dock: which device on this track you touched the most.
  const mostTouched = useMemo(() => {
    const tally = new Map<string, number>();
    for (const item of trackActivity) {
      if (item.kind !== "move" || !item.deviceName) continue;
      tally.set(item.deviceName, (tally.get(item.deviceName) ?? 0) + 1);
    }
    let best: { name: string; count: number } | null = null;
    for (const [name, count] of tally) {
      if (!best || count > best.count) best = { name, count };
    }
    return best;
  }, [trackActivity]);

  const moveCountForTrack = trackActivity.filter((a) => a.kind === "move").length;

  // Session-wide "worth keeping" candidates. Notes are intentional, so they rank
  // first; then deliberate mode flips; then the biggest net parameter swings.
  // Parameter changes are collapsed to one net move per device+param so the same
  // knob doesn't flood the rail.
  // Activity blocks: contiguous stretches of work on one track, the unit the
  // timeline now summarizes in. This replaced the per-move "Worth Keeping" rail,
  // which scored individual knob tweaks and asked you to curate them — the wrong
  // altitude. Producers remember sections of work ("I was on the lead"), not
  // isolated moves, so we segment the move stream into those sections instead.
  const sessionBlocks = useMemo<SessionBlock[]>(() => {
    const resolveTrackId = (change: ParameterChange): string | null =>
      (change.parameter_id ? lookups.paramTrack.get(change.parameter_id) : undefined) ??
      (change.track_name ? lookups.nameTrack.get(change.track_name.toLowerCase()) : undefined) ??
      null;

    const sorted = [...changes]
      .filter((change) => change.parameter_name)
      .sort((a, b) => a.changed_at_ms - b.changed_at_ms);

    type Acc = {
      trackId: string | null;
      trackName: string | null;
      key: string;
      startMs: number;
      endMs: number;
      moveCount: number;
      deviceCounts: Map<string, number>;
      paramCounts: Map<string, number>;
    };

    const blocks: Acc[] = [];
    let current: Acc | null = null;

    for (const change of sorted) {
      const key = change.track_name?.toLowerCase() ?? "—";
      const gap = current ? change.changed_at_ms - current.endMs : 0;

      // Break the block on a track change or a long enough pause.
      if (!current || key !== current.key || gap > BLOCK_GAP_MS) {
        current = {
          trackId: resolveTrackId(change),
          trackName: change.track_name,
          key,
          startMs: change.changed_at_ms,
          endMs: change.changed_at_ms,
          moveCount: 0,
          deviceCounts: new Map(),
          paramCounts: new Map(),
        };
        blocks.push(current);
      }

      current.endMs = change.changed_at_ms;
      current.moveCount += 1;
      if (change.device_name) {
        current.deviceCounts.set(
          change.device_name,
          (current.deviceCounts.get(change.device_name) ?? 0) + 1,
        );
      }
      if (change.parameter_name) {
        current.paramCounts.set(
          change.parameter_name,
          (current.paramCounts.get(change.parameter_name) ?? 0) + 1,
        );
      }
    }

    const rankNames = (counts: Map<string, number>) =>
      [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([name, count]) => ({ name, count }));

    return blocks.map((block, index) => ({
      id: `blk-${index}-${block.startMs}`,
      trackId: block.trackId,
      trackName: block.trackName,
      startMs: block.startMs,
      endMs: block.endMs,
      moveCount: block.moveCount,
      devices: rankNames(block.deviceCounts).map((entry) => entry.name),
      topParams: rankNames(block.paramCounts).slice(0, 3),
    }));
  }, [changes, lookups]);


  // Session-level "pulse": headline counts + a momentum read, so the take feels
  // like an event you're in, not a table you're reading.
  const pulse = useMemo(() => {
    const moveCount = changes.length;
    const decisionCount = changes.filter((c) => c.is_quantized).length;
    const keeperCount = moments.filter(
      (m) => m.confidence === "keeper" || m.confidence === "final" || m.tags.includes("keeper"),
    ).length;
    const tracksTouched = new Set(
      changes.map((c) => c.track_name).filter((name): name is string => Boolean(name)),
    ).size;
    const times = changes.map((c) => c.changed_at_ms).sort((a, b) => a - b);

    // Momentum from recent cadence (moves in the last two minutes).
    const now = Date.now();
    const recent = times.filter((t) => now - t < 120_000).length;
    let momentum: { label: string; tone: "hot" | "warm" | "calm" };
    if (!bounds.recording) {
      momentum = { label: "Take complete", tone: "calm" };
    } else if (recent >= 6) {
      momentum = { label: "In the zone", tone: "hot" };
    } else if (recent >= 1) {
      momentum = { label: "On a roll", tone: "warm" };
    } else {
      momentum = { label: "Listening…", tone: "calm" };
    }

    return { moveCount, decisionCount, keeperCount, tracksTouched, times, momentum };
  }, [changes, moments, bounds.recording]);

  // Hands-on time, not wall-clock. A set left open overnight must never read as
  // "39 hr" of work — only stretches with recorded activity count.
  const activeMs = useMemo(() => {
    const stamps = [
      ...changes.map((change) => change.changed_at_ms),
      ...moments.map((moment) => moment.timeline_start_ms ?? moment.created_at_ms),
    ];
    return activeDurationMs(stamps, bounds.recording ? Date.now() : null);
  }, [changes, moments, bounds.recording]);

  // An auto-written recap of the take — prose that ties the numbers together so
  // the session reads like a memory you can skim, not a table you decode.
  const sessionStory = useMemo<string[] | null>(() => {
    if (changes.length === 0) return null;
    const sentences: string[] = [];

    const trackTally = new Map<string, number>();
    const deviceTally = new Map<string, number>();
    for (const change of changes) {
      if (change.track_name) trackTally.set(change.track_name, (trackTally.get(change.track_name) ?? 0) + 1);
      if (change.device_name) deviceTally.set(change.device_name, (deviceTally.get(change.device_name) ?? 0) + 1);
    }
    const topTrack = [...trackTally.entries()].sort((a, b) => b[1] - a[1])[0];
    const topDevice = [...deviceTally.entries()].sort((a, b) => b[1] - a[1])[0];
    const trackCount = trackTally.size;

    // Boldest continuous swing, by percent-of-range.
    let biggest: { param: string; before: string; after: string; mag: number } | null = null;
    for (const change of changes) {
      if (!change.parameter_name || change.is_quantized) continue;
      if (change.after_value_percent === null || change.before_value_percent === null) continue;
      const mag = Math.abs(change.after_value_percent - change.before_value_percent);
      if (!biggest || mag > biggest.mag) {
        biggest = {
          param: change.parameter_name,
          before: change.before_display_value ?? formatPercent(change.before_value_percent),
          after: change.after_display_value ?? formatPercent(change.after_value_percent),
          mag,
        };
      }
    }

    const modes = changes.filter((c) => c.is_quantized && c.parameter_name);
    const keepers = moments.filter(
      (m) => m.confidence === "keeper" || m.confidence === "final" || m.tags.includes("keeper"),
    ).length;

    const project = session?.display_name ?? session?.project_name ?? null;

    sentences.push(
      `${activeMs > 0 ? `${formatDuration(activeMs)} of hands-on work` : "A take"}${project ? ` on ${project}` : ""}.`,
    );
    if (topTrack) {
      sentences.push(
        trackCount === 1
          ? `Nearly all of it on ${topTrack[0]} — ${topTrack[1]} move${topTrack[1] === 1 ? "" : "s"}.`
          : `Across ${trackCount} tracks, mostly ${topTrack[0]} (${topTrack[1]} moves).`,
      );
    }
    if (topDevice && topDevice[1] >= 2) {
      sentences.push(`The ${topDevice[0]} got the most hands-on attention.`);
    }
    if (biggest) {
      sentences.push(`Boldest move: ${biggest.param}, ${biggest.before} → ${biggest.after}.`);
    }
    if (modes.length > 0) {
      const last = modes[modes.length - 1];
      sentences.push(
        `You reshaped its character — ${last.parameter_name} to ${last.after_display_value ?? "a new mode"}.`,
      );
    }
    if (keepers > 0) {
      sentences.push(`${keepers} keeper${keepers === 1 ? "" : "s"} flagged.`);
    }

    return sentences;
  }, [changes, moments, session, activeMs]);

  function toggleGroup(key: string) {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const hasMap = Boolean(schema?.has_snapshot) && tracks.length > 0;
  const takeTitle = formatTakeTitle(session, schema?.name ?? null);
  const rawTakeId = session?.name ?? session?.id ?? sessionId;
  const projectContext = session?.display_name ?? session?.project_name ?? null;
  // Header duration: hands-on time only. No recorded moves yet → no number at
  // all, rather than a wall-clock timer that keeps climbing while the set idles.
  const durationLabel = activeMs > 0 ? `${formatDuration(activeMs)} active` : null;

  async function handleAddNote() {
    if (!sessionId || !selectedTrack) return;
    const text = noteDraft.trim();
    if (!text) return;
    try {
      await createCreativeMoment({
        id: crypto.randomUUID(),
        sessionId,
        title: text,
        momentType: "idea_to_revisit",
        note: text,
        tags: noteStar ? ["keeper"] : [],
        confidence: noteStar ? "keeper" : "working",
        timelineStartMs: bounds.recording ? Date.now() : null,
        targets: [{ target_type: "track", target_id: selectedTrack.id }],
      });
      setNoteDraft("");
      setNoteStar(false);
      await refreshMoments();
    } catch (noteError) {
      setError(String(noteError));
    }
  }

  async function handleDeleteNote(id: string) {
    try {
      await deleteCreativeMoment(id);
      await refreshMoments();
    } catch (deleteError) {
      setError(String(deleteError));
    }
  }

  // Assemble the structured snapshot every export format shares, from the
  // current derived state. The rendering itself lives in timeline-share.
  function currentShareData() {
    return buildShareData({
      title: takeTitle,
      project: projectContext,
      duration: durationLabel,
      recordedAtMs: session?.started_at_ms ?? null,
      changes,
      stats: {
        moves: pulse.moveCount,
        characterMoves: pulse.decisionCount,
        tracksTouched: pulse.tracksTouched,
        keepers: pulse.keeperCount,
      },
      story: sessionStory,
      blocks: sessionBlocks,
      sessionStart: bounds.sessionStart,
    });
  }

  async function handleCopyShare() {
    if (exportFormat === "pdf") return;
    try {
      await navigator.clipboard.writeText(buildShareDocument(currentShareData(), exportFormat));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch (copyError) {
      setError(String(copyError));
    }
  }

  async function handleExportShare() {
    if (exportFormat === "pdf") {
      exportPdf(currentShareData());
      return;
    }
    try {
      const ext = exportFormat;
      const filterName = ext === "md" ? "Markdown" : ext === "txt" ? "Text" : "JSON";
      const fileName = `${takeTitle.replace(/[^\w.-]+/g, "-")}-recall.${ext}`;
      const path = await save({
        defaultPath: fileName,
        filters: [{ name: filterName, extensions: [ext] }],
      });
      if (!path) return;
      await writeTextFile(path, buildShareDocument(currentShareData(), ext));
    } catch (exportError) {
      setError(String(exportError));
    }
  }

  if (!sessionId) {
    return (
      <div className="tl-empty-screen">
        <p>Open a take to relive what you did — and keep what worked.</p>
      </div>
    );
  }

  return (
    <div className="tl">
      <header className="tl-bar">
        <div className="tl-bar__title">
          <span className={`tl-eye ${bounds.recording ? "is-rec" : ""}`}>
            {bounds.recording && <span className="tl-eye__dot" />}
            {bounds.recording ? "Recording now" : "Looking back"}
          </span>
          <strong title={rawTakeId ?? undefined}>{takeTitle}</strong>
          <span className="tl-bar__sub">
            {[
              projectContext,
              session?.started_at_ms
                ? new Date(session.started_at_ms).toLocaleDateString(undefined, {
                    month: "short",
                    day: "numeric",
                    year: "numeric",
                  })
                : null,
              durationLabel,
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </div>
        <div className="tl-bar__actions">
          {hasMap && (
            <>
              <div className="tl-fmt" role="group" aria-label="Export format">
                {(["md", "txt", "json", "pdf"] as ExportFormat[]).map((fmt) => (
                  <button
                    key={fmt}
                    type="button"
                    className={`tl-fmt__opt ${exportFormat === fmt ? "is-on" : ""}`}
                    onClick={() => setExportFormat(fmt)}
                    aria-pressed={exportFormat === fmt}
                    title={`Export as ${
                      fmt === "md"
                        ? "Markdown"
                        : fmt === "txt"
                          ? "plain text"
                          : fmt === "json"
                            ? "JSON"
                            : "PDF"
                    }`}
                  >
                    {fmt.toUpperCase()}
                  </button>
                ))}
              </div>
              <button
                type="button"
                className="tl-btn"
                onClick={() => void handleCopyShare()}
                disabled={exportFormat === "pdf"}
                title={
                  exportFormat === "pdf"
                    ? "PDF can't be copied — use Save"
                    : `Copy this take as ${exportFormat.toUpperCase()} to the clipboard`
                }
              >
                <CopyIcon />
                {copied ? "Copied!" : "Copy"}
              </button>
              <button
                type="button"
                className="tl-btn"
                onClick={() => void handleExportShare()}
                title={exportFormat === "pdf" ? "Open the print dialog to save as PDF" : `Save this take as a .${exportFormat} file`}
              >
                <ExportIcon />
                {exportFormat === "pdf" ? "Save PDF" : "Export"}
              </button>
            </>
          )}
          <button
            type="button"
            className="tl-btn tl-btn--primary"
            onClick={() => void load(true)}
            disabled={status === "loading"}
            title="Re-read the current Live set's tracks and devices to refresh this map"
          >
            <ScanIcon />
            {status === "loading" ? "Scanning…" : "Rescan set"}
          </button>
        </div>
      </header>

      {error && <div className="tl-error">{error}</div>}

      {!hasMap ? (
        <ScanEmptyState
          existingSet={Boolean(session?.project_path)}
          loading={status === "loading"}
          onScan={() => void load(true)}
        />
      ) : (
        <>
          <div className="tl-pulse">
            <div className="tl-pulse__stats">
              <span className="tl-stat">
                <b>{pulse.moveCount}</b>
                <span>move{pulse.moveCount === 1 ? "" : "s"}</span>
              </span>
              {pulse.decisionCount > 0 && (
                <span className="tl-stat">
                  <b>{pulse.decisionCount}</b>
                  <span>character move{pulse.decisionCount === 1 ? "" : "s"}</span>
                </span>
              )}
              <span className="tl-stat">
                <b>{pulse.tracksTouched}</b>
                <span>track{pulse.tracksTouched === 1 ? "" : "s"} touched</span>
              </span>
              {pulse.keeperCount > 0 && (
                <span className="tl-stat tl-stat--keep">
                  <b>{pulse.keeperCount}</b>
                  <span>keeper{pulse.keeperCount === 1 ? "" : "s"}</span>
                </span>
              )}
            </div>
            {(() => {
              const spark = cumulativeMovePaths(
                pulse.times,
                bounds,
                Math.max(pulse.times.length, 1),
                xEnd,
              );
              return spark ? (
                <ActivitySpark
                  paths={spark}
                  color="#aab4ff"
                  gradientId="spark-pulse"
                  className="tl-pulse__spark"
                />
              ) : null;
            })()}
            <span className={`tl-pulse__state is-${pulse.momentum.tone}`}>
              <span className="tl-pulse__pip" />
              {pulse.momentum.label}
            </span>
          </div>

          <div className="tl-legend">
            <span><span className="tl-key tl-key--move" /> activity (taller = more changes)</span>
            <span><span className="tl-key tl-key--note" /> note</span>
            {bounds.recording && <span><span className="tl-key tl-key--now" /> now</span>}
          </div>

          <div className="tl-arrange">
            <div className="tl-headers">
              <div className="tl-rspacer" />
              {lanes.map((lane) => {
                const color = trackColor(lane.track);
                const moveCount = (laneGraphs.moveTimesByLane.get(lane.track.id) ?? []).length;
                return (
                  <button
                    key={lane.track.id}
                    type="button"
                    className={`tl-hdr ${lane.track.id === selectedTrackId ? "is-sel" : ""} ${
                      lane.track.type === "master" ? "is-main" : lane.track.type === "return" ? "is-bus" : ""
                    }`}
                    style={{ ["--lane-color" as string]: color }}
                    onClick={() => setSelectedTrackId(lane.track.id)}
                    title={`${lane.track.name ?? "Untitled track"} — ${moveCount} move${moveCount === 1 ? "" : "s"}`}
                  >
                    <span className="tl-hdr__sw" style={{ background: color }} />
                    <span className="tl-hdr__name">
                      {lane.track.type === "master" ? "Main" : lane.track.name ?? "Untitled track"}
                    </span>
                    {moveCount > 0 && <span className="tl-hdr__count">{moveCount}</span>}
                  </button>
                );
              })}
            </div>

            <div className="tl-tracks">
              <div className="tl-ruler">
                {buildTicks(bounds).map((tick) => (
                  <span key={tick.label + tick.pct} className="tl-tick" style={{ left: `${tick.pct}%` }}>
                    {tick.label}
                  </span>
                ))}
              </div>
              {lanes.map((lane) => {
                const moveTimes = laneGraphs.moveTimesByLane.get(lane.track.id) ?? [];
                const graph = cumulativeMovePaths(moveTimes, bounds, laneGraphs.maxMoves, xEnd);
                const moveCount = moveTimes.length;
                return (
                  <button
                    key={lane.track.id}
                    type="button"
                    className={`tl-lane ${lane.track.id === selectedTrackId ? "is-sel" : ""} ${
                      lane.track.type === "master" ? "is-main" : lane.track.type === "return" ? "is-bus" : ""
                    }`}
                    onClick={() => setSelectedTrackId(lane.track.id)}
                    aria-label={`${lane.track.name ?? "Untitled track"} — ${moveCount} moves`}
                  >
                    {graph && (
                      <ActivitySpark
                        paths={graph}
                        color={trackColor(lane.track)}
                        gradientId={`spark-${lane.track.id}`}
                      />
                    )}
                    {lane.items
                      .filter((item) => item.kind === "note")
                      .map((item) => (
                        <span
                          key={item.id}
                          className="tl-mk tl-mk--note"
                          style={{ left: `${pct(item.atMs, bounds)}%` }}
                          title={describeActivity(item)}
                        >
                          ★
                        </span>
                      ))}
                  </button>
                );
              })}
              {bounds.recording && <span className="tl-playhead" style={{ left: `${pct(Date.now(), bounds)}%` }} />}
            </div>
          </div>

          {selectedTrack && (
            <div className="tl-dock">
              <div className="tl-dock__head">
                <span className="tl-dock__kick">Track memory</span>
                <span className="tl-dock__name">
                  <span className="tl-dock__sw" style={{ background: trackColor(selectedTrack) }} />
                  {selectedTrack.name ?? "Untitled track"}
                </span>
                <span className="tl-dock__meta">
                  {TRACK_TYPE_LABEL[selectedTrack.type]} · {selectedTrack.devices.length} device
                  {selectedTrack.devices.length === 1 ? "" : "s"} · {moveCountForTrack} move
                  {moveCountForTrack === 1 ? "" : "s"}
                </span>
                {mostTouched && mostTouched.count > 1 && (
                  <span className="tl-dock__top">
                    Most-touched: <b>{mostTouched.name}</b> · {mostTouched.count}
                  </span>
                )}
              </div>

              {selectedTrack.devices.length > 0 ? (
                <div className="tl-chain">
                  {selectedTrack.devices.map((device, index) => (
                    <span key={device.id} className="tl-chain__seg">
                      {index > 0 && <span className="tl-chain__arrow">→</span>}
                      <span className={`tl-pill ${device.enabled ? "" : "is-off"}`}>
                        <span className="tl-pill__rl" style={{ background: deviceColor(device) }} />
                        {device.name ?? DEVICE_ROLE_LABEL[device.role]}
                        {device.name && changedDeviceNames.has(device.name) && <span className="tl-pill__chg" />}
                      </span>
                    </span>
                  ))}
                </div>
              ) : (
                <p className="tl-chain__empty">No devices captured on this track.</p>
              )}

              <div className="tl-story-head">What you did to {selectedTrack.name ?? "this track"}</div>
              {groupedActivity.length > 0 ? (
                <ul className="tl-story">
                  {groupedActivity.map((group) => {
                    const lead = group.lead;
                    const count = group.items.length;
                    const oldest = group.items[count - 1];
                    const when = formatElapsed(lead.atMs - bounds.sessionStart);
                    const expanded = expandedGroups.has(group.key);

                    if (lead.kind === "note") {
                      return (
                        <li key={group.key} className="tl-ci">
                          <span className="tl-ci__ic tl-ci__ic--note">★</span>
                          <span className="tl-ci__body">
                            <span className="tl-ci__what"><b>Note</b></span>
                            <span className="tl-ci__val">{lead.title ?? ""}</span>
                          </span>
                          <span className="tl-ci__when">{when}</span>
                          <button
                            type="button"
                            className="tl-ci__del"
                            aria-label="Delete note"
                            onClick={() => void handleDeleteNote(lead.id)}
                          >
                            ×
                          </button>
                        </li>
                      );
                    }

                    return (
                      <li key={group.key} className="tl-ci-wrap">
                        <div
                          className={`tl-ci ${count > 1 ? "tl-ci--group" : ""} ${expanded ? "is-open" : ""}`}
                          {...(count > 1
                            ? {
                                role: "button",
                                tabIndex: 0,
                                onClick: () => toggleGroup(group.key),
                                onKeyDown: (event: KeyboardEvent) => {
                                  if (event.key === "Enter" || event.key === " ") {
                                    event.preventDefault();
                                    toggleGroup(group.key);
                                  }
                                },
                              }
                            : {})}
                        >
                          <span className="tl-ci__ic tl-ci__ic--move" />
                          <span className="tl-ci__body">
                            {moveWhatNode(lead)}
                            {moveValueNode(oldest, lead, count)}
                          </span>
                          <span className="tl-ci__when">{when}</span>
                          {count > 1 && (
                            <span className={`tl-ci__chev ${expanded ? "is-open" : ""}`} aria-hidden="true">
                              ⌄
                            </span>
                          )}
                        </div>
                        {expanded && count > 1 && (
                          <ul className="tl-substory">
                            {group.items.map((item) => (
                              <li key={item.id} className="tl-ci tl-ci--sub">
                                <span className="tl-ci__ic" />
                                <span className="tl-ci__body">
                                  {moveValueNode(item, item, 1)}
                                </span>
                                <span className="tl-ci__when">
                                  {formatElapsed(item.atMs - bounds.sessionStart)}
                                </span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="tl-story__empty">Nothing logged on this track yet — moves show up here as you tweak it.</p>
              )}

              <div className="tl-addnote">
                <button
                  type="button"
                  className={`tl-addnote__star ${noteStar ? "is-on" : ""}`}
                  aria-label="Flag as keeper"
                  aria-pressed={noteStar}
                  onClick={() => setNoteStar((value) => !value)}
                >
                  ★
                </button>
                <input
                  value={noteDraft}
                  onChange={(event) => setNoteDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void handleAddNote();
                  }}
                  placeholder={`Add a note to ${selectedTrack.name ?? "this track"}…`}
                  aria-label="Add a note"
                />
                <button
                  type="button"
                  className="tl-btn tl-btn--primary tl-addnote__save"
                  disabled={!noteDraft.trim()}
                  onClick={() => void handleAddNote()}
                >
                  Add note
                </button>
              </div>
            </div>
          )}

          {sessionBlocks.length > 0 && (
            <div className="tl-blocks">
              <div className="tl-blocks__head">
                <span className="tl-blocks__kick">What you worked on</span>
                <span className="tl-blocks__sub">stretches of activity, newest first</span>
              </div>
              <div className="tl-blocks__list">
                {[...sessionBlocks].reverse().map((block) => {
                  const track = block.trackId
                    ? tracks.find((t) => t.id === block.trackId)
                    : null;
                  const color = track ? trackColor(track) : "#6382ff";
                  const durationMs = Math.max(0, block.endMs - block.startMs);
                  const params =
                    block.topParams.length > 0
                      ? block.topParams.map((p) => p.name).join(" · ")
                      : "adjustments";
                  return (
                    <button
                      type="button"
                      key={block.id}
                      className="tl-block"
                      style={{ ["--lane-color" as string]: color }}
                      onClick={() => block.trackId && setSelectedTrackId(block.trackId)}
                      title={
                        block.trackId
                          ? `Focus ${block.trackName ?? "track"}`
                          : undefined
                      }
                    >
                      <span className="tl-block__rail" aria-hidden="true" />
                      <span className="tl-block__main">
                        <span className="tl-block__top">
                          <span className="tl-block__track">
                            {block.trackName ?? "Untitled track"}
                          </span>
                          <span className="tl-block__count">
                            {block.moveCount} move{block.moveCount === 1 ? "" : "s"}
                          </span>
                        </span>
                        <span className="tl-block__params">
                          {params}
                          {block.devices.length > 0 && (
                            <span className="tl-block__dev"> · {block.devices[0]}</span>
                          )}
                        </span>
                      </span>
                      <span className="tl-block__time">
                        <span className="tl-block__when">
                          {formatElapsed(block.startMs - bounds.sessionStart)}
                        </span>
                        {durationMs >= 1000 && (
                          <span className="tl-block__dur">
                            {durationMs >= 60_000
                              ? `${Math.round(durationMs / 60_000)}m`
                              : `${Math.round(durationMs / 1000)}s`}
                          </span>
                        )}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {sessionStory && (
            <div className="tl-recap">
              <div className="tl-recap__kick">The story so far</div>
              <p className="tl-recap__text">{sessionStory.join(" ")}</p>
            </div>
          )}

        </>
      )}

      {/* Outside the hasMap branch on purpose: the log is most useful when the
          timeline is EMPTY and you need to know whether anything is arriving at
          all. Hiding it behind a populated map hides it exactly when it matters. */}
      <div className="tl-blog">
        <button
          type="button"
          className="tl-blog__toggle"
          onClick={() => setBridgeLogOpen((open) => !open)}
          aria-expanded={bridgeLogOpen}
        >
          Bridge log {bridgeLog.length > 0 && `(${bridgeLog.length})`}
        </button>

        {bridgeLogOpen && (
          <div className="tl-blog__list">
            {bridgeLog.length === 0 ? (
              <div className="tl-blog__empty">
                Nothing received yet. Events appear here as Ableton sends them.
              </div>
            ) : (
              bridgeLog.map((entry, index) => (
                <div className="tl-blog__row" key={`${entry.timestamp_ms ?? 0}-${index}`}>
                  <span className="tl-blog__time">
                    {entry.timestamp_ms
                      ? new Date(entry.timestamp_ms).toLocaleTimeString()
                      : "—"}
                  </span>
                  <span
                    className={`tl-blog__src ${
                      entry.source === "control_surface" ? "is-py" : ""
                    }`}
                  >
                    {entry.source === "control_surface" ? "PY" : "M4L"}
                  </span>
                  <span className="tl-blog__type">{entry.event_type ?? "unknown"}</span>
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}
