import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { listen } from "@tauri-apps/api/event";
import { save } from "@tauri-apps/plugin-dialog";
import "./SchemaTimeline.css";
import {
  createCreativeMoment,
  deleteCreativeMoment,
  getNoteEdits,
  getParameterChanges,
  getProjectSchema,
  listCreativeMoments,
  materializeSessionSchema,
  writeTextFile,
} from "../../lib/schema/api";
import {
  DEVICE_ROLE_LABEL,
  NOTE_KIND_LABEL,
  TRACK_TYPE_LABEL,
  type CreativeMoment,
  type NoteEdit,
  type ParameterChange,
  type ProjectSchema,
  type SavedProject,
  type SavedSessionMetadata,
} from "../../types";
import { abletonSetName, alsSetName } from "../../features/sessionFormat";
import { buildSittings, sittingWork, storyLedger } from "../../features/projects/songStory";
import {
  activeDurationMs,
  ActivitySpark,
  buildLookups,
  buildShareData,
  buildShareDocument,
  buildTicks,
  clipLabel,
  CopyIcon,
  cumulativeMovePaths,
  deviceColor,
  describeActivity,
  describeNoteEdit,
  ExportIcon,
  exportPdf,
  formatClock,
  formatDuration,
  formatWhen,
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
  NotesIcon,
  PitchBar,
  pct,
  ScanEmptyState,
  ScanIcon,
  trackColor,
  type Activity,
  type ActivityGroup,
  type ExportFormat,
  type LiveRecallEvent,
  type SessionBlock,
  type ShareProjectStory,
  type ShareTimelineSource,
  type LoadStatus,
} from "./timeline";

export function SchemaTimeline({
  sessionId,
  session,
  project,
  producerName,
}: {
  sessionId: string | null;
  session: SavedSessionMetadata | null;
  project: SavedProject | null;
  producerName: string;
}) {
  const [schema, setSchema] = useState<ProjectSchema | null>(null);
  const [changes, setChanges] = useState<ParameterChange[]>([]);
  const [noteEdits, setNoteEdits] = useState<NoteEdit[]>([]);
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
  // Older takes are fetched only to make an export a project record, not a
  // single-take dump. The current take keeps using the live state below so its
  // last moves appear immediately while recording.
  const [projectHistorySources, setProjectHistorySources] = useState<ShareTimelineSource[] | null>(null);
  const activityLogEndRef = useRef<HTMLDivElement>(null);

  const load = useCallback(
    async (rematerialize: boolean, quiet = false) => {
      if (!sessionId) return;
      if (!quiet) setStatus("loading");
      setError(null);
      try {
        if (rematerialize) await materializeSessionSchema(sessionId);
        const [nextSchema, nextChanges, nextNoteEdits, nextMoments] = await Promise.all([
          getProjectSchema(sessionId),
          getParameterChanges(sessionId),
          getNoteEdits(sessionId),
          listCreativeMoments(sessionId),
        ]);
        setSchema(nextSchema);
        setChanges(nextChanges);
        setNoteEdits(nextNoteEdits);
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
    setNoteEdits([]);
    setMoments([]);
    setSelectedTrackId(null);
    void load(true);
  }, [sessionId, load]);

  const projectCaptureKey = useMemo(
    () => (project?.captures ?? []).map((capture) => capture.id).sort().join("|"),
    [project?.captures],
  );

  useEffect(() => {
    if (!project) {
      setProjectHistorySources(null);
      return;
    }

    const historicCaptures = project.captures.filter((capture) => capture.id !== sessionId);
    if (historicCaptures.length === 0) {
      setProjectHistorySources([]);
      return;
    }

    let cancelled = false;
    setProjectHistorySources(null);
    void Promise.all(
      historicCaptures.map(async (capture) => {
        await materializeSessionSchema(capture.id);
        const [captureChanges, captureNoteEdits, captureMoments] = await Promise.all([
          getParameterChanges(capture.id),
          getNoteEdits(capture.id),
          listCreativeMoments(capture.id),
        ]);
        return {
          id: capture.id,
          label: formatTakeTitle(capture, null),
          startedAtMs: capture.started_at_ms,
          changes: captureChanges,
          noteEdits: captureNoteEdits,
          moments: captureMoments,
        } satisfies ShareTimelineSource;
      }),
    )
      .then((sources) => {
        if (!cancelled) setProjectHistorySources(sources);
      })
      .catch(() => {
        // A project record is still useful for the open take if an old capture
        // cannot be re-read. Don't turn a background export enhancement into a
        // timeline error state.
        if (!cancelled) setProjectHistorySources([]);
      });

    return () => {
      cancelled = true;
    };
  }, [project?.id, projectCaptureKey, sessionId]);

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
    for (const edit of noteEdits) stamps.push(edit.changed_at_ms);
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
  }, [session, changes, noteEdits, moments]);

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
    for (const edit of noteEdits) {
      // Note edits carry a track NAME only — the control surface reports the
      // clip, and clips are not in the parameter/device lookups. A clip on a
      // track the schema hasn't seen yet is dropped rather than floated on a
      // lane it doesn't belong to.
      const trackId = edit.track_name
        ? lookups.nameTrack.get(edit.track_name.toLowerCase())
        : undefined;
      if (!trackId) continue;
      out.push({
        id: edit.id,
        kind: "noteEdit",
        trackId,
        atMs: edit.changed_at_ms,
        clipName: edit.clip_name,
        clipId: edit.clip_id,
        changeKind: edit.change_kind,
        noteCount: edit.note_count,
        previousNoteCount: edit.previous_note_count,
        pitchRange: edit.pitch_range,
        pitchMin: edit.pitch_min,
        pitchMax: edit.pitch_max,
        previousPitchMin: edit.previous_pitch_min,
        previousPitchMax: edit.previous_pitch_max,
        previousPitchRange: edit.previous_pitch_range,
        summary: edit.summary,
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
  }, [changes, noteEdits, moments, lookups]);

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
        last !== undefined &&
        (item.kind === "move"
          ? last.lead.kind === "move" &&
            last.lead.deviceName === item.deviceName &&
            last.lead.paramName === item.paramName
          : // Consecutive edits to the SAME clip are one stretch of writing.
            // Each settled edit is already coalesced at the bridge, but a
            // producer building a part still produces a run of them, and eight
            // rows for one part is the same noise the move grouping exists to
            // prevent.
            item.kind === "noteEdit" &&
            last.lead.kind === "noteEdit" &&
            // Identity, not name: unnamed clips all share a blank name, and
            // merging on that collapses edits from different parts into one run.
            (item.clipId ?? item.id) === (last.lead.clipId ?? last.lead.id));
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
  const noteEditCountForTrack = trackActivity.filter((a) => a.kind === "noteEdit").length;

  // Session-wide "worth keeping" candidates. Notes are intentional, so they rank
  // first; then deliberate mode flips; then the biggest net parameter swings.
  // Parameter changes are collapsed to one net move per device+param so the same
  // knob doesn't flood the rail.
  // Activity-log entries are contiguous stretches of work on one track. Grouping
  // prevents a knob ride from flooding the log while retaining the timestamped
  // record of which part of the session happened when.
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
      // Writing a part is hands-on time as surely as riding a knob is. Without
      // these, a session spent entirely in the piano roll would read as idle.
      ...noteEdits.map((edit) => edit.changed_at_ms),
      ...moments.map((moment) => moment.timeline_start_ms ?? moment.created_at_ms),
    ];
    return activeDurationMs(stamps, bounds.recording ? Date.now() : null);
  }, [changes, noteEdits, moments, bounds.recording]);

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

  const timelineSources = useMemo<ShareTimelineSource[]>(() => {
    const currentSource: ShareTimelineSource = {
      id: sessionId ?? "current-take",
      label: takeTitle,
      startedAtMs: session?.started_at_ms ?? null,
      changes,
      noteEdits,
      moments,
    };
    // Until historic takes finish loading, export the current take honestly
    // rather than holding the button hostage. Once loaded, the selected take
    // is appended as the live source and the story covers the whole project.
    return project ? [...(projectHistorySources ?? []), currentSource] : [currentSource];
  }, [changes, moments, noteEdits, project, projectHistorySources, session?.started_at_ms, sessionId, takeTitle]);

  const exportedProjectStory = useMemo<ShareProjectStory | null>(() => {
    const activities = timelineSources.flatMap((source) => [
      ...source.changes.map((change) => ({
        atMs: change.changed_at_ms,
        trackName: change.track_name,
        trackId: change.track_id,
        deviceName: change.device_name,
        role: null,
        trackType: null,
        kind: "move" as const,
      })),
      ...(source.noteEdits ?? []).map((edit) => ({
        atMs: edit.changed_at_ms,
        trackName: edit.track_name,
        trackId: null,
        deviceName: null,
        role: null,
        trackType: null,
        kind: "noteEdit" as const,
      })),
    ]);
    const sittings = buildSittings(activities);
    if (sittings.length === 0) return null;
    const ledger = storyLedger(sittings);
    const pieces = [
      `${ledger.sittings} work session${ledger.sittings === 1 ? "" : "s"}`,
      `${ledger.moves} recorded move${ledger.moves === 1 ? "" : "s"}`,
      ledger.noteEdits > 0 ? `${ledger.noteEdits} MIDI edit${ledger.noteEdits === 1 ? "" : "s"}` : null,
      ledger.tracksShaped > 0 ? `${ledger.tracksShaped} track${ledger.tracksShaped === 1 ? "" : "s"} shaped` : null,
      ledger.activeMs > 0 ? `${formatDuration(ledger.activeMs)} active` : null,
    ].filter((piece): piece is string => Boolean(piece));
    return {
      summary: pieces.join(" · "),
      chapters: sittings.map((sitting) => ({
        startMs: sitting.startMs,
        endMs: sitting.endMs,
        label: sitting.label,
        work: sittingWork(sitting),
        moves: sitting.moveCount,
        noteEdits: sitting.noteEditCount,
        activeMs: sitting.activeMs,
      })),
    };
  }, [timelineSources]);

  const exportedProjectRecord = useMemo(() => {
    const captureTimes = (project?.captures ?? []).map((capture) => capture.started_at_ms);
    const firstCapturedAtMs = captureTimes.length
      ? Math.min(...captureTimes)
      : session?.started_at_ms ?? null;
    const lastCapturedAtMs = captureTimes.length
      ? Math.max(...(project?.captures ?? []).map((capture) => capture.last_updated_at_ms))
      : session?.last_updated_at_ms ?? null;
    const setName = project?.ableton_name?.trim();
    return {
      name: project?.display_name ?? projectContext,
      setName:
        setName && setName !== "0"
          ? setName
          : alsSetName(session?.als_path) ?? abletonSetName(session),
      producerName: producerName.trim() || null,
      captureCount: project?.captures.length ?? 1,
      firstCapturedAtMs,
      lastCapturedAtMs,
    };
  }, [producerName, project, projectContext, session]);

  const preparingProjectRecord = Boolean(
    project && projectHistorySources === null && project.captures.some((capture) => capture.id !== sessionId),
  );

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
      timelineSources,
      projectRecord: exportedProjectRecord,
      projectStory: exportedProjectStory,
    });
  }

  async function handleCopyShare() {
    if (exportFormat === "pdf" || preparingProjectRecord) return;
    try {
      await navigator.clipboard.writeText(buildShareDocument(currentShareData(), exportFormat));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch (copyError) {
      setError(String(copyError));
    }
  }

  async function handleExportShare() {
    if (preparingProjectRecord) return;
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
                disabled={exportFormat === "pdf" || preparingProjectRecord}
                title={
                  preparingProjectRecord
                    ? "Preparing the full project record from earlier takes"
                    : exportFormat === "pdf"
                      ? "PDF can't be copied — use Save"
                      : `Copy this project record as ${exportFormat.toUpperCase()} to the clipboard`
                }
              >
                <CopyIcon />
                {preparingProjectRecord ? "Preparing…" : copied ? "Copied!" : "Copy"}
              </button>
              <button
                type="button"
                className="tl-btn"
                onClick={() => void handleExportShare()}
                disabled={preparingProjectRecord}
                title={
                  preparingProjectRecord
                    ? "Preparing the full project record from earlier takes"
                    : exportFormat === "pdf"
                      ? "Open the print dialog to save this project record as PDF"
                      : `Save this project record as a .${exportFormat} file`
                }
              >
                <ExportIcon />
                {preparingProjectRecord ? "Preparing…" : exportFormat === "pdf" ? "Save PDF" : "Export"}
              </button>
            </>
          )}
          <button
            type="button"
            className="tl-btn tl-btn--primary"
            onClick={() => void load(true)}
            disabled={status === "loading"}
            title="Rebuild this map from the moves already captured in the database"
          >
            <ScanIcon />
            {status === "loading" ? "Rebuilding…" : "Rebuild timeline"}
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
                  color="var(--signal-soft)"
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
                    {/* Note edits sit UNDER the note stars so an annotation is
                        never hidden behind a tick, and read as a small mark on
                        the lane rather than a second star competing with it. */}
                    {lane.items
                      .filter((item) => item.kind === "noteEdit")
                      .map((item) => (
                        <span
                          key={item.id}
                          className="tl-mk tl-mk--midi"
                          style={{ left: `${pct(item.atMs, bounds)}%` }}
                          title={describeActivity(item)}
                        />
                      ))}
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
                  {noteEditCountForTrack > 0 && (
                    <> · {noteEditCountForTrack} note edit{noteEditCountForTrack === 1 ? "" : "s"}</>
                  )}
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
                    const when = formatWhen(lead.atMs, bounds.sessionStart, bounds.span);
                    const expanded = expandedGroups.has(group.key);

                    if (lead.kind === "noteEdit") {
                      // Net result of the run: the newest edit's landing state,
                      // measured from the oldest edit's starting count — the
                      // same before→after logic the move rows use.
                      // The bridge's own summary is dropped for a run: it
                      // describes only the newest edit, so reusing it would
                      // report "+1" for a stretch that added twelve notes.
                      const net = {
                        ...lead,
                        previousNoteCount: oldest.previousNoteCount,
                        previousPitchRange: oldest.previousPitchRange,
                        summary: count > 1 ? null : lead.summary,
                      };
                      return (
                        <li key={group.key} className="tl-ci tl-ci--notes">
                          <span className="tl-ci__ic tl-ci__ic--notes" aria-hidden="true">
                            <NotesIcon />
                          </span>
                          <span className="tl-ci__body">
                            <span className="tl-ci__what">
                              <b>{clipLabel(lead.clipName)}</b>
                              <span className="tl-ci__det"> · notes</span>
                            </span>
                            <span className="tl-ci__val tl-notes-val">
                              {/* Drawn before it is spelled: where the part sits
                                  on the keyboard, and the ghost of where it sat
                                  before, so a transposition reads as movement. */}
                              <PitchBar
                                min={net.pitchMin}
                                max={net.pitchMax}
                                previousMin={oldest.previousPitchMin}
                                previousMax={oldest.previousPitchMax}
                                label={net.pitchRange}
                              />
                              <span className="tl-notes-val__text">{describeNoteEdit(net)}</span>
                              {count > 1 && <span className="tl-ba__count">{count}×</span>}
                            </span>
                          </span>
                          <span className="tl-ci__when">{when}</span>
                        </li>
                      );
                    }

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
                                  {formatWhen(item.atMs, bounds.sessionStart, bounds.span)}
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
            <section className="tl-activity-log" aria-label="Activity log">
              <div className="tl-activity-log__head">
                <div>
                  <span className="tl-activity-log__kick">Activity log</span>
                  <span className="tl-activity-log__sub">clock time, newest first</span>
                </div>
                <button
                  type="button"
                  className="tl-activity-log__jump-bottom"
                  onClick={() =>
                    activityLogEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" })
                  }
                >
                  Jump to bottom
                </button>
              </div>
              <ol className="tl-activity-log__list">
                {[...sessionBlocks].reverse().map((block) => {
                  const track = block.trackId
                    ? tracks.find((t) => t.id === block.trackId)
                    : null;
                  const color = track ? trackColor(track) : "var(--signal)";
                  const detail = [
                    block.moveCount === 1 ? "1 move" : `${block.moveCount} moves`,
                    block.devices[0],
                    ...block.topParams.map((param) => param.name),
                  ]
                    .filter(Boolean)
                    .join(" · ");
                  return (
                    <li key={block.id}>
                      <button
                        type="button"
                        className="tl-activity-log__row"
                        style={{ ["--lane-color" as string]: color }}
                        onClick={() => block.trackId && setSelectedTrackId(block.trackId)}
                        title={
                          block.trackId
                            ? `Focus ${block.trackName ?? "track"}`
                            : undefined
                        }
                      >
                        <time
                          className="tl-activity-log__time"
                          dateTime={new Date(block.startMs).toISOString()}
                          title={new Date(block.startMs).toLocaleString()}
                        >
                          {formatClock(block.startMs)}
                        </time>
                        <span className="tl-activity-log__marker" aria-hidden="true" />
                        <span className="tl-activity-log__body">
                          <span className="tl-activity-log__track">
                            {block.trackName ?? "Untitled track"}
                          </span>
                          <span className="tl-activity-log__detail">{detail}</span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ol>
              <div ref={activityLogEndRef} className="tl-activity-log__end" aria-hidden="true" />
            </section>
          )}

          {/* MIDI notes — its own section rather than only per-track rows.
              Session-wide and newest-first, so what the capture layer claims can
              be read against what actually happened in Live. Rendered even when
              empty: "nothing arrived" is the reading that matters most while
              note capture is young, and a section that vanishes when there is
              no data cannot say it. */}
          <div className="tl-notes">
            <div className="tl-blocks__head">
              <span className="tl-blocks__kick">MIDI notes</span>
              <span className="tl-blocks__sub">
                {noteEdits.length > 0
                  ? `${noteEdits.length} edit${noteEdits.length === 1 ? "" : "s"}, newest first`
                  : "edits to clip contents land here"}
              </span>
            </div>
            {noteEdits.length > 0 ? (
              <div className="tl-blocks__list">
                {[...noteEdits].reverse().map((edit) => {
                  const track = edit.track_name
                    ? tracks.find(
                        (t) => t.name?.toLowerCase() === edit.track_name?.toLowerCase(),
                      )
                    : null;
                  return (
                    <div
                      key={edit.id}
                      className="tl-note-row"
                      style={{ ["--lane-color" as string]: track ? trackColor(track) : "var(--paper)" }}
                    >
                      <span className="tl-block__rail" aria-hidden="true" />
                      <span className="tl-block__main">
                        <span className="tl-block__top">
                          <span className="tl-block__track">{clipLabel(edit.clip_name)}</span>
                          <span className="tl-note-row__track">
                            {edit.track_name ?? "unknown track"}
                          </span>
                          {edit.change_kind && (
                            <span className={`tl-note-kind is-${edit.change_kind}`}>
                              {NOTE_KIND_LABEL[edit.change_kind] ?? edit.change_kind}
                            </span>
                          )}
                        </span>
                        <span className="tl-notes-val">
                          <PitchBar
                            min={edit.pitch_min}
                            max={edit.pitch_max}
                            previousMin={edit.previous_pitch_min}
                            previousMax={edit.previous_pitch_max}
                            label={edit.pitch_range}
                          />
                          <span className="tl-block__params">{edit.summary ?? "—"}</span>
                        </span>
                        {/* Raw fields, for checking the capture against Live
                            rather than trusting the rendered phrase. */}
                        <span className="tl-note-row__raw">
                          {edit.previous_note_count ?? "—"} → {edit.note_count ?? "—"} notes
                          {edit.distinct_pitches !== null && ` · ${edit.distinct_pitches} pitches`}
                          {edit.pitch_range && ` · ${edit.pitch_range}`}
                          {edit.velocity_mean !== null && ` · vel ${edit.velocity_mean}`}
                          {edit.length_beats !== null && ` · ${edit.length_beats} beats`}
                        </span>
                      </span>
                      <span className="tl-block__time">
                        <span className="tl-block__when">
                          {formatWhen(edit.changed_at_ms, bounds.sessionStart, bounds.span)}
                        </span>
                      </span>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="tl-story__empty">
                No note edits captured yet. Open a MIDI clip in Ableton, change some
                notes, then pause — an edit is reported once the clip sits still.
              </p>
            )}
          </div>

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
