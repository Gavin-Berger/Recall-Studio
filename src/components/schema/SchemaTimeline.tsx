import { Fragment, lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { listen } from "@tauri-apps/api/event";
import { save } from "@tauri-apps/plugin-dialog";
import { AnimatePresence, LazyMotion, domAnimation, useReducedMotion } from "motion/react";
import * as m from "motion/react-m";
import "./SchemaTimeline.css";
import {
  createCreativeMoment,
  deleteCreativeMoment,
  getNoteEdits,
  getParameterChanges,
  getProjectSchema,
  getTimelineClipEvents,
  listCreativeMoments,
  materializeSessionSchema,
  writeTextFile,
} from "../../lib/schema/api";
import { describeMidiChange, midiChangeSubject } from "./timeline/midiChange";
import {
  DEVICE_ROLE_LABEL,
  TRACK_TYPE_LABEL,
  type CreativeMoment,
  type NoteEdit,
  type ParameterChange,
  type ProjectSchema,
  type SavedProject,
  type SavedSessionMetadata,
  type TrackObj,
  type TimelineClipEvent,
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
  type Lookups,
  type SessionBlock,
  type ShareProjectStory,
  type ShareTimelineSource,
  type LoadStatus,
} from "./timeline";

const ArrangementCanvas = lazy(() => import("./timeline/ArrangementCanvas"));

type ProjectionSweep = {
  captureCount: number;
  timelineMoveCount: number;
  added: number;
  removed: number;
};

function changeSignature(change: ParameterChange): string {
  // Materialization may assign a different derived-row id, so compare only the
  // immutable capture facts rather than the projection's implementation detail.
  return [
    change.event_type,
    change.changed_at_ms,
    change.track_id ?? change.track_name ?? "",
    change.device_name ?? "",
    change.parameter_name ?? "",
    change.after_value ?? "",
    change.after_value_percent ?? "",
  ].join("\u001f");
}

function projectionDifference(
  before: ParameterChange[],
  after: ParameterChange[],
): Pick<ProjectionSweep, "added" | "removed"> {
  const tally = (rows: ParameterChange[]) => {
    const counts = new Map<string, number>();
    for (const row of rows) {
      const key = changeSignature(row);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  };
  const beforeCounts = tally(before);
  const afterCounts = tally(after);
  let added = 0;
  let removed = 0;
  for (const [key, count] of afterCounts) added += Math.max(0, count - (beforeCounts.get(key) ?? 0));
  for (const [key, count] of beforeCounts) removed += Math.max(0, count - (afterCounts.get(key) ?? 0));
  return { added, removed };
}

// A snapshot is a description of the set *now*. Timeline rows can outlive it:
// a track may have been renamed, deleted, or simply omitted from a later
// snapshot. Keep that work visible on a stable historic lane instead of
// throwing the row away because the current schema cannot resolve it.
function historicTrackId(trackId: string | null | undefined, trackName: string | null | undefined): string {
  const stableId = trackId?.trim();
  if (stableId) return `history:${stableId}`;
  const name = trackName?.trim();
  return name ? `history:name:${name.toLowerCase()}` : "history:unknown";
}

function resolveTimelineTrackId(
  lookups: Lookups,
  {
    parameterId,
    trackId,
    trackName,
  }: { parameterId?: string | null; trackId?: string | null; trackName?: string | null },
): string {
  return (
    (parameterId ? lookups.paramTrack.get(parameterId) : undefined) ??
    (trackId ? lookups.abletonTrack.get(trackId) : undefined) ??
    (trackName ? lookups.nameTrack.get(trackName.toLowerCase()) : undefined) ??
    historicTrackId(trackId, trackName)
  );
}

export function SchemaTimeline({
  sessionId,
  session,
  project,
  producerName,
  onOpenProjects,
  onStartCapture,
  onOpenTimeline,
}: {
  sessionId: string | null;
  session: SavedSessionMetadata | null;
  project: SavedProject | null;
  producerName: string;
  onOpenProjects: () => void;
  onStartCapture: (projectId: string) => void;
  onOpenTimeline: (sessionId: string) => void;
}) {
  const [schema, setSchema] = useState<ProjectSchema | null>(null);
  const [changes, setChanges] = useState<ParameterChange[]>([]);
  const [noteEdits, setNoteEdits] = useState<NoteEdit[]>([]);
  const [clipEvents, setClipEvents] = useState<TimelineClipEvent[]>([]);
  const [moments, setMoments] = useState<CreativeMoment[]>([]);
  const [status, setStatus] = useState<LoadStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [selectedTrackId, setSelectedTrackId] = useState<string | null>(null);
  // The overview always shows the complete chronology. The detailed map below
  // is deliberately one sitting at a time so a six-hour or overnight gap never
  // turns into a field of empty track lanes.
  const [selectedSittingId, setSelectedSittingId] = useState<string | null>(null);
  // Large Live sets routinely have dozens of quiet tracks. Start with the
  // musical story â€” the tracks that hold recorded work â€” while keeping the
  // full arrangement one click away.
  const [showQuietTracks, setShowQuietTracks] = useState(false);
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
  const [projectionSweep, setProjectionSweep] = useState<ProjectionSweep | null>(null);
  const reduceMotion = useReducedMotion();
  const activityLogEndRef = useRef<HTMLDivElement>(null);

  const load = useCallback(
    async (rematerialize: boolean, quiet = false) => {
      if (!sessionId) return;
      if (!quiet) setStatus("loading");
      setError(null);
      try {
        if (rematerialize) await materializeSessionSchema(sessionId);
        const [nextSchema, nextChanges, nextNoteEdits, nextClipEvents, nextMoments] = await Promise.all([
          getProjectSchema(sessionId),
          getParameterChanges(sessionId),
          getNoteEdits(sessionId),
          getTimelineClipEvents(sessionId),
          listCreativeMoments(sessionId),
        ]);
        setSchema(nextSchema);
        setChanges(nextChanges);
        setNoteEdits(nextNoteEdits);
        setClipEvents(nextClipEvents);
        setMoments(nextMoments);
        setStatus("ready");
      } catch (loadError) {
        setError(String(loadError));
        setStatus("error");
      }
    },
    [sessionId],
  );

  // Rebuild every captured take in the project, then compare the old and new
  // *derived* timelines. This catches a projector regression or a stale
  // materialization without pretending that a UI rebuild can discover packets
  // Ableton never delivered to Recall in the first place.
  const handleProjectRebuild = useCallback(async () => {
    if (!sessionId) return;
    setStatus("loading");
    setError(null);
    try {
      const capturesById = new Map(
        (project?.captures ?? []).map((capture) => [capture.id, capture]),
      );
      const captureIds = [...new Set([...capturesById.keys(), sessionId])];
      const before = await Promise.all(captureIds.map((id) => getParameterChanges(id)));
      await Promise.all(captureIds.map((id) => materializeSessionSchema(id)));
      const after = await Promise.all(captureIds.map((id) => getParameterChanges(id)));
      const beforeRows = before.flat();
      const afterRows = after.flat();
      const difference = projectionDifference(beforeRows, afterRows);

      const currentIndex = captureIds.indexOf(sessionId);
      const [nextSchema, nextNoteEdits, nextClipEvents, nextMoments] = await Promise.all([
        getProjectSchema(sessionId),
        getNoteEdits(sessionId),
        getTimelineClipEvents(sessionId),
        listCreativeMoments(sessionId),
      ]);
      setSchema(nextSchema);
      setChanges(after[currentIndex] ?? []);
      setNoteEdits(nextNoteEdits);
      setClipEvents(nextClipEvents);
      setMoments(nextMoments);

      if (project) {
        const historicSources = await Promise.all(
          captureIds
            .filter((id) => id !== sessionId)
            .map(async (id, index) => {
              const capture = capturesById.get(id) ?? null;
              const [captureNoteEdits, captureMoments] = await Promise.all([
                getNoteEdits(id),
                listCreativeMoments(id),
              ]);
              return {
                id,
                label: formatTakeTitle(capture, null),
                startedAtMs: capture?.started_at_ms ?? index,
                changes: after[captureIds.indexOf(id)] ?? [],
                noteEdits: captureNoteEdits,
                moments: captureMoments,
              } satisfies ShareTimelineSource;
            }),
        );
        setProjectHistorySources(historicSources);
      }

      setProjectionSweep({
        captureCount: captureIds.length,
        timelineMoveCount: afterRows.length,
        ...difference,
      });
      setStatus("ready");
    } catch (rebuildError) {
      setError(String(rebuildError));
      setStatus("error");
    }
  }, [project, sessionId]);

  useEffect(() => {
    setSchema(null);
    setChanges([]);
    setNoteEdits([]);
    setClipEvents([]);
    setMoments([]);
    setSelectedTrackId(null);
    setSelectedSittingId(null);
    setProjectionSweep(null);
    setShowQuietTracks(false);
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

  // A take remains the capture/storage unit, but the timeline is the project's
  // memory. Flatten the older captures with the open take here, rather than
  // changing how a take is created or rotated. While the older reads are in
  // flight we keep the open take visible; it expands into the full record as
  // soon as they arrive.
  const timelineChanges = useMemo(() => {
    const historicChanges = projectHistorySources?.flatMap((source) => source.changes) ?? [];
    return [...historicChanges, ...changes].sort((a, b) => a.changed_at_ms - b.changed_at_ms);
  }, [changes, projectHistorySources]);
  const projectHistoryLoading = Boolean(project && projectHistorySources === null);

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
    const sessionStart = timelineChanges[0]?.changed_at_ms ?? session?.started_at_ms ?? Date.now();

    // Fit the axis to where work actually happened. A session left recording for
    // hours otherwise crushes every move into a sliver at the far left; we drop
    // that leading/trailing dead air by bounding to the first and last activity.
    const stamps: number[] = [];
    for (const change of timelineChanges) stamps.push(change.changed_at_ms);
    for (const edit of noteEdits) stamps.push(edit.changed_at_ms);
    for (const event of clipEvents) stamps.push(event.changed_at_ms);
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
  }, [session, timelineChanges, noteEdits, clipEvents, moments]);

  const activities = useMemo<Activity[]>(() => {
    const out: Activity[] = [];
    for (const change of timelineChanges) {
      const trackId = resolveTimelineTrackId(lookups, {
        parameterId: change.parameter_id,
        trackId: change.track_id,
        trackName: change.track_name,
      });
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
        automation:
          change.event_type === "automation_created" ||
          change.event_type === "automation_edited",
        automationStartPosition: change.automation_start_position,
        automationEndPosition: change.automation_end_position,
      });
    }
    for (const edit of noteEdits) {
      // Note edits carry a track NAME only — the control surface reports the
      // clip, and clips are not in the parameter/device lookups. A clip on a
      // track the schema hasn't seen yet is dropped rather than floated on a
      // lane it doesn't belong to.
      const trackId = resolveTimelineTrackId(lookups, {
        trackId: edit.track_id,
        trackName: edit.track_name,
      });
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
    for (const event of clipEvents) {
      const trackId = resolveTimelineTrackId(lookups, {
        trackId: event.track_id,
        trackName: event.track_name,
      });
      out.push({
        id: event.id,
        kind: "clip",
        trackId,
        atMs: event.changed_at_ms,
        clipName: event.clip_name,
        assetName: event.sample_name,
        eventType: event.event_type,
      });
    }
    for (const moment of moments) {
      const directTrackId = noteTrackId(moment, lookups);
      const trackId =
        directTrackId && tracks.some((track) => track.id === directTrackId)
          ? directTrackId
          : directTrackId
            ? historicTrackId(directTrackId, null)
            : null;
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
  }, [timelineChanges, noteEdits, clipEvents, moments, lookups, tracks]);

  // Buses sink to the bottom, Main last of all — the order Ableton's own mixer
  // uses, so it reads as a fixture rather than as a track that happened to sort
  // there. Regular tracks keep their existing number order above them.
  // Activity is the durable record. Snapshot tracks are the present-day map.
  // Add lightweight historic lanes for activity that belongs to a past map so
  // fifty earlier moves never disappear just because the set later changed.
  const historicTracks = useMemo<TrackObj[]>(() => {
    const currentIds = new Set(tracks.map((track) => track.id));
    const labels = new Map<string, string>();
    const remember = (laneId: string, label: string | null | undefined) => {
      if (currentIds.has(laneId) || !laneId.startsWith("history:")) return;
      const cleanLabel = label?.trim();
      if (!labels.has(laneId) || cleanLabel) {
        labels.set(laneId, cleanLabel || "Track from an earlier snapshot");
      }
    };

    for (const change of timelineChanges) {
      remember(
        resolveTimelineTrackId(lookups, {
          parameterId: change.parameter_id,
          trackId: change.track_id,
          trackName: change.track_name,
        }),
        change.track_name,
      );
    }
    for (const edit of noteEdits) {
      remember(resolveTimelineTrackId(lookups, { trackId: edit.track_id, trackName: edit.track_name }), edit.track_name);
    }
    for (const event of clipEvents) {
      remember(resolveTimelineTrackId(lookups, { trackId: event.track_id, trackName: event.track_name }), event.track_name);
    }
    for (const moment of moments) {
      const directTrackId = noteTrackId(moment, lookups);
      if (directTrackId && !currentIds.has(directTrackId)) {
        remember(historicTrackId(directTrackId, null), null);
      }
    }

    const firstNumber = Math.max(0, ...tracks.map((track) => track.number)) + 1;
    return [...labels.entries()].map(([id, name], index) => ({
      id,
      ableton_id: null,
      name,
      number: firstNumber + index,
      type: "audio",
      color: null,
      group_id: null,
      chain_index: firstNumber + index,
      devices: [],
    }));
  }, [timelineChanges, noteEdits, clipEvents, moments, lookups, tracks]);

  const timelineTracks = useMemo(() => [...tracks, ...historicTracks], [tracks, historicTracks]);

  const lanes = useMemo(() => {
    const rank = (type: string) => (type === "master" ? 2 : type === "return" ? 1 : 0);
    return [...timelineTracks]
      .sort((a, b) => rank(a.type) - rank(b.type))
      .map((track) => ({ track, items: activities.filter((a) => a.trackId === track.id) }));
  }, [timelineTracks, activities]);

  const activeLaneCount = useMemo(
    () => lanes.filter((lane) => lane.items.length > 0).length,
    [lanes],
  );
  const visibleLanes = useMemo(
    () => (showQuietTracks || activeLaneCount === 0 ? lanes : lanes.filter((lane) => lane.items.length > 0)),
    [lanes, showQuietTracks, activeLaneCount],
  );

  // A Song Story is project-wide while this map is deliberately one take at a
  // time. When a new take contains only setup traffic (focus, transport, or a
  // snapshot), make that difference explicit and offer the most recent recorded
  // take instead of presenting a quiet map as a broken one.
  const hasCurrentTakeActivity = changes.length + noteEdits.length + clipEvents.length + moments.length > 0;
  const recordedTake = useMemo(
    () =>
      [...(project?.captures ?? [])]
        .filter(
          (capture) =>
            capture.id !== sessionId &&
            capture.take_origin !== "scanned" &&
            capture.ended_at_ms !== null &&
            capture.creative_event_count > 0,
        )
        .sort((a, b) => b.last_updated_at_ms - a.last_updated_at_ms)[0] ?? null,
    [project?.captures, sessionId],
  );

  // Kept while the legacy DOM arrangement remains mounted for a safe visual
  // transition to the canvas renderer below. The active surface is the canvas.
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

  const heatmap = useMemo(() => {
    const bucketCount = 32;
    const bucketsByTrack = new Map<string, number[]>();
    let peak = 0;
    for (const lane of lanes) {
      const buckets = Array.from({ length: bucketCount }, () => 0);
      for (const item of lane.items) {
        const relative = (item.atMs - bounds.start) / bounds.span;
        const index = Math.max(0, Math.min(bucketCount - 1, Math.floor(relative * bucketCount)));
        buckets[index] += 1;
        peak = Math.max(peak, buckets[index]);
      }
      bucketsByTrack.set(lane.track.id, buckets);
    }
    return { bucketCount, bucketsByTrack, peak };
  }, [lanes, bounds]);

  // Shared y-scale for the per-lane activity graphs: the busiest channel peaks
  // at the top, so taller curve = more changes. Sorted move timestamps per lane
  // feed a cumulative step-line that builds left→right.
  // Right edge of every lane graph: the live playhead while recording, else the
  // full width so a finished take's curve reaches the end.
  const xEnd = bounds.recording ? pct(Date.now(), bounds) : 100;

  const selectedTrack = timelineTracks.find((track) => track.id === selectedTrackId) ?? null;
  const selectedTrackIsHistoric = selectedTrack?.id.startsWith("history:") ?? false;
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
            last.lead.paramName === item.paramName &&
            last.lead.automation === item.automation
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
  const clipEventCountForTrack = trackActivity.filter((a) => a.kind === "clip").length;

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
      (change.track_id ? lookups.abletonTrack.get(change.track_id) : undefined) ??
      (change.track_name ? lookups.nameTrack.get(change.track_name.toLowerCase()) : undefined) ??
      null;

    const sorted = [...timelineChanges]
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
  }, [timelineChanges, lookups]);

  // The page structure comes from the shared Song Story engine, not capture
  // boundaries. A producer can leave the same set open long enough to rotate
  // into a new take, so the visible break belongs at the real gap in work.
  const timelineSittings = useMemo(() => {
    const typeByName = new Map(
      tracks
        .filter((track) => Boolean(track.name))
        .map((track) => [track.name!.toLowerCase(), track.type]),
    );
    return buildSittings(
      timelineChanges.map((change) => ({
        atMs: change.changed_at_ms,
        trackName: change.track_name,
        trackId: change.track_id,
        deviceName: change.device_name,
        role: null,
        trackType: change.track_name ? typeByName.get(change.track_name.toLowerCase()) ?? null : null,
        kind: "move" as const,
      })),
    );
  }, [timelineChanges, tracks]);

  // Open the densest sitting first. A producer lands on the most useful detail
  // without losing the rest of the project: every sitting remains one click
  // away in the real-time overview directly above the map.
  const defaultTimelineSitting = useMemo(
    () =>
      [...timelineSittings].sort(
        (a, b) =>
          b.moveCount + b.noteEditCount - (a.moveCount + a.noteEditCount) ||
          b.activeMs - a.activeMs ||
          b.endMs - a.endMs,
      )[0] ?? null,
    [timelineSittings],
  );
  const selectedTimelineSitting =
    timelineSittings.find((sitting) => sitting.id === selectedSittingId) ?? defaultTimelineSitting;

  useEffect(() => {
    if (selectedTimelineSitting && selectedTimelineSitting.id !== selectedSittingId) {
      setSelectedSittingId(selectedTimelineSitting.id);
    }
  }, [selectedSittingId, selectedTimelineSitting]);

  // The detail canvas only draws activity from the selected sitting. That is a
  // real time window — movement starts at its first captured action and stops
  // at its last one — not an equal-width partition of the whole project.
  const sittingActivities = useMemo(
    () =>
      selectedTimelineSitting
        ? activities.filter(
            (activity) =>
              activity.atMs >= selectedTimelineSitting.startMs &&
              activity.atMs <= selectedTimelineSitting.endMs,
          )
        : activities,
    [activities, selectedTimelineSitting],
  );
  const sittingLanes = useMemo(() => {
    const rank = (type: string) => (type === "master" ? 2 : type === "return" ? 1 : 0);
    return [...timelineTracks]
      .sort((a, b) => rank(a.type) - rank(b.type))
      .map((track) => ({ track, items: sittingActivities.filter((activity) => activity.trackId === track.id) }));
  }, [timelineTracks, sittingActivities]);
  const sittingActiveLaneCount = useMemo(
    () => sittingLanes.filter((lane) => lane.items.length > 0).length,
    [sittingLanes],
  );
  const sittingQuietLaneCount = sittingLanes.length - sittingActiveLaneCount;
  const visibleSittingLanes = useMemo(
    () =>
      showQuietTracks || sittingActiveLaneCount === 0
        ? sittingLanes
        : sittingLanes.filter((lane) => lane.items.length > 0),
    [showQuietTracks, sittingLanes, sittingActiveLaneCount],
  );
  const sittingBounds = useMemo(() => {
    if (!selectedTimelineSitting) return bounds;
    const startMs = selectedTimelineSitting.startMs;
    const endMs = selectedTimelineSitting.endMs;
    const durationMs = Math.max(0, endMs - startMs);
    // A lone captured change deserves a readable minute-wide timeline, but its
    // timestamp remains centred on the exact point where it happened.
    const padMs = durationMs === 0 ? 30_000 : Math.max(durationMs * 0.05, 1_500);
    const start = startMs - padMs;
    const end = endMs + padMs;
    return { start, end, span: end - start, recording: bounds.recording, sessionStart: startMs };
  }, [bounds, selectedTimelineSitting]);
  const selectedSittingIsLive =
    bounds.recording &&
    selectedTimelineSitting?.id === timelineSittings[timelineSittings.length - 1]?.id;

  // Keep the selected track meaningful for the sitting being inspected instead
  // of leaving the detail dock pointed at a quiet lane from another day.
  useEffect(() => {
    if (visibleSittingLanes.length === 0) {
      if (selectedTrackId !== null) setSelectedTrackId(null);
      return;
    }
    if (!selectedTrackId || !visibleSittingLanes.some((lane) => lane.track.id === selectedTrackId)) {
      setSelectedTrackId(visibleSittingLanes[0].track.id);
    }
  }, [visibleSittingLanes, selectedTrackId]);

  const activityLogSittings = useMemo(
    () =>
      timelineSittings.map((sitting) => ({
        sitting,
        blocks: sessionBlocks.filter(
          (block) => block.startMs >= sitting.startMs && block.startMs <= sitting.endMs,
        ),
      })),
    [sessionBlocks, timelineSittings],
  );


  // Session-level "pulse": headline counts + a momentum read, so the take feels
  // like an event you're in, not a table you're reading.
  const pulse = useMemo(() => {
    const moveCount = timelineChanges.length;
    const decisionCount = timelineChanges.filter((c) => c.is_quantized).length;
    const keeperCount = moments.filter(
      (m) => m.confidence === "keeper" || m.confidence === "final" || m.tags.includes("keeper"),
    ).length;
    const tracksTouched = new Set(
      timelineChanges.map((c) => c.track_name).filter((name): name is string => Boolean(name)),
    ).size;
    const times = timelineChanges.map((c) => c.changed_at_ms);

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
  }, [timelineChanges, moments, bounds.recording]);

  // Hands-on time, not wall-clock. A set left open overnight must never read as
  // "39 hr" of work — only stretches with recorded activity count.
  const activeMs = useMemo(() => {
    const stamps = [
      ...timelineChanges.map((change) => change.changed_at_ms),
      // Writing a part is hands-on time as surely as riding a knob is. Without
      // these, a session spent entirely in the piano roll would read as idle.
      ...noteEdits.map((edit) => edit.changed_at_ms),
      ...clipEvents.map((event) => event.changed_at_ms),
      ...moments.map((moment) => moment.timeline_start_ms ?? moment.created_at_ms),
    ];
    return activeDurationMs(stamps, bounds.recording ? Date.now() : null);
  }, [timelineChanges, noteEdits, clipEvents, moments, bounds.recording]);

  // An auto-written recap of the take — prose that ties the numbers together so
  // the session reads like a memory you can skim, not a table you decode.
  const sessionStory = useMemo<string[] | null>(() => {
    if (timelineChanges.length === 0) return null;
    const sentences: string[] = [];

    const trackTally = new Map<string, number>();
    const deviceTally = new Map<string, number>();
    for (const change of timelineChanges) {
      if (change.track_name) trackTally.set(change.track_name, (trackTally.get(change.track_name) ?? 0) + 1);
      if (change.device_name) deviceTally.set(change.device_name, (deviceTally.get(change.device_name) ?? 0) + 1);
    }
    const topTrack = [...trackTally.entries()].sort((a, b) => b[1] - a[1])[0];
    const topDevice = [...deviceTally.entries()].sort((a, b) => b[1] - a[1])[0];
    const trackCount = trackTally.size;

    // Boldest continuous swing, by percent-of-range.
    let biggest: { param: string; before: string; after: string; mag: number } | null = null;
    for (const change of timelineChanges) {
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

    const modes = timelineChanges.filter((c) => c.is_quantized && c.parameter_name);
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
  }, [timelineChanges, moments, session, activeMs]);

  function toggleGroup(key: string) {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const hasMap = Boolean(schema?.has_snapshot) && tracks.length > 0;
  const isProjectTimeline = Boolean(project && project.captures.length > 1);
  const takeTitle = formatTakeTitle(session, schema?.name ?? null);
  const rawTakeId = session?.name ?? session?.id ?? sessionId;
  const projectContext = session?.display_name ?? session?.project_name ?? null;
  const projectTitle =
    project?.display_name?.trim() ||
    projectContext?.trim() ||
    schema?.name?.trim() ||
    "Untitled project";
  const captureWhenLabel = session?.started_at_ms
    ? new Date(session.started_at_ms).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })
    : null;
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
      changes: timelineChanges,
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
        <section className="tl-empty-card" aria-labelledby="timeline-empty-title">
          <span className="tl-empty-card__eyebrow">Recall timeline</span>
          <h1 id="timeline-empty-title">Your session story starts with a take.</h1>
          <p>
            Choose a capture from Project Desk to see the arrangement, creative moves,
            and notes that shaped it.
          </p>
          <button type="button" className="tl-empty-card__action" onClick={onOpenProjects}>
            Open Project Desk
          </button>
        </section>
      </div>
    );
  }

  return (
    <LazyMotion features={domAnimation} strict>
    <m.div
      className="tl tl--memory"
      initial={reduceMotion ? false : { opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: reduceMotion ? 0 : 0.45 }}
    >
      <m.header
        className="tl-bar"
        initial={reduceMotion ? false : { opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: reduceMotion ? 0 : 0.35 }}
      >
        <div className="tl-bar__mark" aria-hidden="true">
          <span>R</span>
          <i className={bounds.recording ? "is-live" : ""} />
        </div>
        <div className="tl-bar__title">
          <span className={`tl-eye ${bounds.recording ? "is-rec" : ""}`}>
            {bounds.recording && <span className="tl-eye__dot" />}
            {bounds.recording ? "Recording now" : "Looking back"}
          </span>
          <strong title={rawTakeId ?? undefined}>{projectTitle}</strong>
          <span className="tl-bar__sub">
            {[
              captureWhenLabel ? `Opened ${captureWhenLabel}` : null,
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
            onClick={() => void handleProjectRebuild()}
            disabled={status === "loading"}
            title="Rebuild every captured take in this project and compare the resulting timeline rows"
          >
            <ScanIcon />
            {status === "loading" ? "Rebuilding…" : "Rebuild timeline"}
          </button>
        </div>
      </m.header>

      {error && <div className="tl-error">{error}</div>}

      {projectionSweep && (
        <div className={`tl-audit ${projectionSweep.removed > 0 ? "has-warning" : ""}`}>
          <b>Projection sweep</b>
          <span>
            {projectionSweep.captureCount} take{projectionSweep.captureCount === 1 ? "" : "s"} checked · {projectionSweep.timelineMoveCount} timeline move{projectionSweep.timelineMoveCount === 1 ? "" : "s"}
            {projectionSweep.added > 0 && ` · ${projectionSweep.added} recovered`}
            {projectionSweep.removed > 0 && ` · ${projectionSweep.removed} changed`}
            {projectionSweep.added === 0 && projectionSweep.removed === 0 && " · unchanged after rebuild"}
          </span>
          <small>Checks the database projection; it cannot prove an event that Ableton never sent.</small>
        </div>
      )}

      {!hasMap ? (
        <ScanEmptyState
          existingSet={Boolean(session?.project_path)}
          scannedTake={session?.take_origin === "scanned"}
          loading={status === "loading"}
          onScan={() => void load(true)}
          onStartCapture={project?.id ? () => onStartCapture(project.id) : undefined}
        />
      ) : (
        <>
          {!hasCurrentTakeActivity && recordedTake && (
            <section className="tl-take-redirect" aria-label="Recorded take available">
              <div>
                <span className="tl-take-redirect__eyebrow">This take is quiet</span>
                <p>
                  It has the current set map, but no musical changes yet. The project timeline below
                  includes earlier sittings; this recorded take is <b>{formatTakeTitle(recordedTake, null)}</b>.
                </p>
              </div>
              <button type="button" className="tl-btn" onClick={() => onOpenTimeline(recordedTake.id)}>
                Open recorded take
              </button>
            </section>
          )}

          <m.section
            className="tl-memory-stage"
            aria-label="Visual memory of the Ableton set"
            initial={reduceMotion ? false : { opacity: 0, scale: 0.992 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: reduceMotion ? 0 : 0.5, delay: reduceMotion ? 0 : 0.08 }}
          >
          <m.div
            className="tl-pulse"
            initial={reduceMotion ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: reduceMotion ? 0 : 0.4, delay: reduceMotion ? 0 : 0.16 }}
          >
            <div className="tl-pulse__transport" aria-hidden="true">
              <span className={bounds.recording ? "is-live" : ""} />
              <i />
              <i />
              <i />
            </div>
            <div className="tl-pulse__stats">
              {isProjectTimeline && (
                <span className="tl-stat tl-stat--scope">
                  <b>{projectHistoryLoading ? "…" : timelineSittings.length}</b>
                  <span>
                    {projectHistoryLoading
                      ? "loading earlier takes"
                      : `sitting${timelineSittings.length === 1 ? "" : "s"}`}
                  </span>
                </span>
              )}
              <span className="tl-stat">
                <b>{pulse.moveCount}</b>
                <span>gesture{pulse.moveCount === 1 ? "" : "s"}</span>
              </span>
              {pulse.decisionCount > 0 && (
                <span className="tl-stat">
                  <b>{pulse.decisionCount}</b>
                  <span>character move{pulse.decisionCount === 1 ? "" : "s"}</span>
                </span>
              )}
              <span className="tl-stat">
                <b>{activeLaneCount}</b>
                <span>active lane{activeLaneCount === 1 ? "" : "s"}</span>
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
          </m.div>

          {timelineSittings.length > 1 && (
            <m.section
              className="tl-journey"
              aria-label="Project arrangement memory"
              initial={reduceMotion ? false : { opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: reduceMotion ? 0 : 0.45, delay: reduceMotion ? 0 : 0.2 }}
            >
              <div className="tl-journey__head">
                <div>
                  <span className="tl-journey__eyebrow">Project arrangement</span>
                  <strong>One song · {timelineSittings.length} recorded work passes</strong>
                </div>
                <span className="tl-journey__clock">
                  {new Date(timelineSittings[0].startMs).toLocaleDateString(undefined, { month: "short", day: "numeric" })} {formatClock(timelineSittings[0].startMs)}
                  {" → "}
                  {new Date(timelineSittings[timelineSittings.length - 1].endMs).toLocaleDateString(undefined, { month: "short", day: "numeric" })} {formatClock(timelineSittings[timelineSittings.length - 1].endMs)}
                </span>
              </div>
              <div className="tl-journey__trace" aria-hidden="true">
                {timelineSittings.map((sitting, index) => (
                  <Fragment key={sitting.id}>
                    <span className={`tl-journey__trace-node ${sitting.id === selectedTimelineSitting?.id ? "is-selected" : ""}`} />
                    {index < timelineSittings.length - 1 && <span className="tl-journey__trace-link" />}
                  </Fragment>
                ))}
              </div>
              <div className="tl-journey__chapters">
                {timelineSittings.map((sitting, index) => {
                  const date = new Date(sitting.startMs);
                  const isSelected = sitting.id === selectedTimelineSitting?.id;
                  const isPeak = sitting.moveCount === Math.max(...timelineSittings.map((item) => item.moveCount));
                  const nextSitting = timelineSittings[index + 1];
                  const breakMs = nextSitting ? Math.max(0, nextSitting.startMs - sitting.endMs) : 0;
                  return (
                    <Fragment key={sitting.id}>
                      <m.button
                        type="button"
                        className={`tl-journey__chapter is-${sitting.kind} ${isSelected ? "is-selected" : ""}`}
                        style={{ ["--chapter-weight" as string]: Math.max(1, Math.min(1.65, Math.log2(sitting.moveCount + 1) / 3)) }}
                        animate={{ opacity: isSelected ? 1 : 0.82, scale: isSelected ? 1 : 0.992 }}
                        whileHover={reduceMotion ? undefined : { y: -3, opacity: 1, scale: 1 }}
                        whileTap={reduceMotion ? undefined : { scale: 0.992 }}
                        transition={{ duration: reduceMotion ? 0 : 0.24 }}
                        onClick={() => setSelectedSittingId(sitting.id)}
                        aria-pressed={isSelected}
                        title={`Show Sitting ${sitting.index + 1} in detail`}
                      >
                        <span className="tl-journey__chapter-top">
                          <span className="tl-journey__ordinal">{String(sitting.index + 1).padStart(2, "0")}</span>
                          <span>{date.toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span>
                          {isPeak && <span className="tl-journey__peak">most active</span>}
                        </span>
                        <span className="tl-journey__title">{index === 0 ? "Pass 01 · first movement" : `Pass ${String(index + 1).padStart(2, "0")}`}</span>
                        <span className="tl-journey__read">{sitting.label}</span>
                        <span className="tl-journey__focus">{sittingWork(sitting)}</span>
                        <span className="tl-journey__time">{formatClock(sitting.startMs)} – {formatClock(sitting.endMs)}</span>
                        <span className="tl-journey__facts">
                          {sitting.moveCount} move{sitting.moveCount === 1 ? "" : "s"} <i /> {formatDuration(sitting.activeMs)} active
                        </span>
                      </m.button>
                      {nextSitting && (
                        <m.div
                          className="tl-journey__break"
                          aria-label={`No recorded work for ${formatDuration(breakMs)}`}
                          initial={reduceMotion ? false : { opacity: 0 }}
                          animate={{ opacity: 1 }}
                          transition={{ duration: reduceMotion ? 0 : 0.4, delay: reduceMotion ? 0 : 0.28 + index * 0.06 }}
                        >
                          <span className="tl-journey__break-line" aria-hidden="true" />
                          <span className="tl-journey__break-copy">
                            <b>{formatDuration(breakMs)} paused</b>
                            <small>no recorded work</small>
                          </span>
                        </m.div>
                      )}
                    </Fragment>
                  );
                })}
              </div>
              <div className="tl-sittings__legacy" aria-hidden="true">
              <div className="tl-sittings__head">
                <span>Whole project timeline</span>
                <span>{timelineSittings.length} work sittings · actual clock time</span>
              </div>
              <div className="tl-sittings__rail" aria-hidden="true">
                {timelineSittings.map((sitting) => {
                  const left = pct(sitting.startMs, bounds);
                  const right = pct(sitting.endMs, bounds);
                  const width = Math.min(100 - left, Math.max(0.9, right - left));
                  return (
                    <span
                      key={sitting.id}
                      className={`tl-sittings__window ${sitting.id === selectedTimelineSitting?.id ? "is-selected" : ""}`}
                      style={{ left: `${left}%`, width: `${width}%` }}
                    />
                  );
                })}
              </div>
              <div className="tl-sittings__list">
                {timelineSittings.map((sitting) => {
                  const date = new Date(sitting.startMs);
                  const isSelected = sitting.id === selectedTimelineSitting?.id;
                  return (
                    <button
                      key={sitting.id}
                      type="button"
                      className={`tl-sittings__item ${isSelected ? "is-selected" : ""}`}
                      onClick={() => setSelectedSittingId(sitting.id)}
                      aria-pressed={isSelected}
                      title={`Show Sitting ${sitting.index + 1} in detail`}
                    >
                      <span className="tl-sittings__number">Sitting {sitting.index + 1}</span>
                      <span className="tl-sittings__when">
                        {date.toLocaleDateString(undefined, { month: "short", day: "numeric" })} · {formatClock(sitting.startMs)}–{formatClock(sitting.endMs)}
                      </span>
                      <span className="tl-sittings__facts">
                        {sitting.moveCount} move{sitting.moveCount === 1 ? "" : "s"} · {formatDuration(sitting.activeMs)} active
                      </span>
                    </button>
                  );
                })}
              </div>
              </div>
            </m.section>
          )}

          <m.div
            className="tl-arrange-toolbar"
            initial={reduceMotion ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: reduceMotion ? 0 : 0.35, delay: reduceMotion ? 0 : 0.26 }}
          >
          {sittingLanes.length > 0 && (
            <div className="tl-capture-scope">
              <span className="tl-capture-scope__label">
                <span className="tl-capture-scope__dot" aria-hidden="true" />
                {selectedTimelineSitting
                  ? `Sitting ${selectedTimelineSitting.index + 1} detail`
                  : isProjectTimeline
                    ? "Project timeline"
                    : "This take"}
                : showing {visibleSittingLanes.length} track{visibleSittingLanes.length === 1 ? "" : "s"} with recorded work
                {sittingQuietLaneCount > 0 && ` · ${sittingQuietLaneCount} quiet`}
              </span>
              {sittingQuietLaneCount > 0 && (
                <button
                  type="button"
                  className="tl-capture-scope__toggle"
                  onClick={() => setShowQuietTracks((current) => !current)}
                  aria-pressed={showQuietTracks}
                >
                  {showQuietTracks ? "Focus on activity" : `Show all ${sittingLanes.length} tracks`}
                </button>
              )}
            </div>
          )}

          <div className="tl-legend">
            <span className="tl-legend__hint">hover a gesture · click to pin</span>
            <span><span className="tl-key tl-key--heat" /> activity density</span>
            <span><span className="tl-key tl-key--move" /> running total</span>
            <span><span className="tl-key tl-key--note" /> note</span>
            {selectedSittingIsLive && <span><span className="tl-key tl-key--now" /> now</span>}
          </div>
          </m.div>

          <m.div
            className="tl-arrange"
            initial={reduceMotion ? false : { opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: reduceMotion ? 0 : 0.45, delay: reduceMotion ? 0 : 0.3 }}
          >
            <div className="tl-headers">
              <div className="tl-rspacer" />
              {visibleSittingLanes.map((lane) => {
                const color = trackColor(lane.track);
                return (
                  <button
                    key={lane.track.id}
                    type="button"
                    className={`tl-hdr ${lane.track.id === selectedTrackId ? "is-sel" : ""} ${
                      lane.track.type === "master" ? "is-main" : lane.track.type === "return" ? "is-bus" : ""
                    }`}
                    style={{ ["--lane-color" as string]: color }}
                    onClick={() => setSelectedTrackId(lane.track.id)}
                    title={`${lane.track.name ?? "Untitled track"} — recorded activity`}
                  >
                    <span className="tl-hdr__index">
                      {lane.track.type === "master" ? "M" : String(lane.track.number).padStart(2, "0")}
                    </span>
                    <span className="tl-hdr__sw" style={{ background: color }} />
                    <span className="tl-hdr__name">
                      {lane.track.type === "master" ? "Main" : lane.track.name ?? "Untitled track"}
                    </span>
                    {lane.track.id.startsWith("history:") && <span className="tl-hdr__past">past</span>}
                    <span className="tl-hdr__activity" aria-label={`${lane.items.length} recorded events`}>
                      <i /><i /><i />
                      <b>{lane.items.length}</b>
                    </span>
                  </button>
                );
              })}
            </div>

            <div className="tl-tracks">
              <Suspense fallback={<div className="tl-arrangement-canvas tl-arrangement-canvas--loading" />}>
                <ArrangementCanvas
                  lanes={visibleSittingLanes}
                  bounds={sittingBounds}
                  selectedTrackId={selectedTrackId}
                  onSelectTrack={setSelectedTrackId}
                  recording={selectedSittingIsLive}
                />
              </Suspense>
              <div className="tl-legacy-arrangement" aria-hidden="true">
              <div className="tl-ruler">
                {buildTicks(bounds).map((tick) => (
                  <span key={tick.label + tick.pct} className="tl-tick" style={{ left: `${tick.pct}%` }}>
                    {tick.label}
                  </span>
                ))}
              </div>
              {visibleLanes.map((lane) => {
                const moveTimes = laneGraphs.moveTimesByLane.get(lane.track.id) ?? [];
                const graph = cumulativeMovePaths(moveTimes, bounds, laneGraphs.maxMoves, xEnd);
                const moveCount = moveTimes.length;
                const heatBuckets = heatmap.bucketsByTrack.get(lane.track.id) ?? [];
                const heatColor = trackColor(lane.track);
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
                    <span
                      className="tl-heat"
                      aria-hidden="true"
                      style={{ gridTemplateColumns: `repeat(${heatmap.bucketCount}, minmax(0, 1fr))` }}
                    >
                      {heatBuckets.map((count, index) => {
                        const intensity = heatmap.peak > 0 ? count / heatmap.peak : 0;
                        return (
                          <span
                            key={index}
                            className={`tl-heat__cell ${count > 0 ? "is-active" : ""}`}
                            style={
                              count > 0
                                ? {
                                    backgroundColor: heatColor,
                                    opacity: 0.14 + Math.sqrt(intensity) * 0.7,
                                  }
                                : undefined
                            }
                          />
                        );
                      })}
                    </span>
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
          </m.div>

          <AnimatePresence mode="wait" initial={false}>
          {selectedTrack && (
            <m.div
              key={selectedTrack.id}
              className="tl-dock"
              initial={reduceMotion ? false : { opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={reduceMotion ? undefined : { opacity: 0, y: -6 }}
              transition={{ duration: reduceMotion ? 0 : 0.25 }}
            >
              <div className="tl-dock__head">
                <span className="tl-dock__kick">Track memory</span>
                <span className="tl-dock__name">
                  <span className="tl-dock__sw" style={{ background: trackColor(selectedTrack) }} />
                  {selectedTrack.name ?? "Untitled track"}
                </span>
                <span className="tl-dock__meta">
                  {selectedTrackIsHistoric ? (
                    <>Captured in an earlier snapshot Â· {moveCountForTrack} move{moveCountForTrack === 1 ? "" : "s"}</>
                  ) : (
                    <>
                  {TRACK_TYPE_LABEL[selectedTrack.type]} · {selectedTrack.devices.length} device
                  {selectedTrack.devices.length === 1 ? "" : "s"} · {moveCountForTrack} move
                  {moveCountForTrack === 1 ? "" : "s"}
                  {noteEditCountForTrack > 0 && (
                    <> · {noteEditCountForTrack} note edit{noteEditCountForTrack === 1 ? "" : "s"}</>
                  )}
                  {clipEventCountForTrack > 0 && (
                    <> · {clipEventCountForTrack} clip added</>
                  )}
                    </>
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
                <p className="tl-chain__empty">
                  {selectedTrackIsHistoric
                    ? "This lane preserves recorded work from an earlier set snapshot."
                    : "No devices captured on this track."}
                </p>
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

                    if (lead.kind === "clip") {
                      return (
                        <li key={group.key} className="tl-ci">
                          <span className="tl-ci__ic tl-ci__ic--note" aria-hidden="true">+</span>
                          <span className="tl-ci__body">
                            <span className="tl-ci__what"><b>{
                              lead.eventType === "sample_added"
                                ? "Sample added"
                                : lead.eventType === "audio_clip_recorded"
                                  ? "Recorded audio"
                                  : lead.eventType === "midi_clip_recorded"
                                    ? "Recorded MIDI"
                                    : "Clip added"
                            }</b></span>
                            <span className="tl-ci__val">{lead.assetName ?? lead.clipName ?? "Untitled clip"}</span>
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
                          <span className={`tl-ci__ic ${lead.automation ? "tl-ci__ic--automation" : "tl-ci__ic--move"}`}>
                            {lead.automation ? "⌁" : null}
                          </span>
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
                  disabled={selectedTrackIsHistoric}
                  onClick={() => setNoteStar((value) => !value)}
                >
                  ★
                </button>
                <input
                  value={noteDraft}
                  disabled={selectedTrackIsHistoric}
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
                  disabled={selectedTrackIsHistoric || !noteDraft.trim()}
                  onClick={() => void handleAddNote()}
                >
                  Add note
                </button>
              </div>
            </m.div>
          )}
          </AnimatePresence>
          </m.section>

          <details className="tl-memory-tape">
            <summary>
              <span className="tl-memory-tape__reel" aria-hidden="true"><i /><i /></span>
              <span className="tl-memory-tape__title">
                <b>Session tape</b>
                <small>The event-by-event record behind the visual memory</small>
              </span>
              <span className="tl-memory-tape__count">
                {sessionBlocks.length} passage{sessionBlocks.length === 1 ? "" : "s"}
                {noteEdits.length > 0 && ` · ${noteEdits.length} MIDI edit${noteEdits.length === 1 ? "" : "s"}`}
              </span>
              <span className="tl-memory-tape__chevron" aria-hidden="true">⌄</span>
            </summary>
            <div className="tl-memory-tape__content">
          {sessionBlocks.length > 0 && (
            <section className="tl-activity-log" aria-label="Activity log">
              <div className="tl-activity-log__head">
                <div>
                  <span className="tl-activity-log__kick">
                    Event tape
                  </span>
                  <span className="tl-activity-log__sub">
                    {projectHistoryLoading
                      ? "reading earlier takes"
                      : timelineSittings.length > 1
                        ? `${timelineSittings.length} sittings, newest first`
                        : "clock time, newest first"}
                  </span>
                </div>
                <button
                  type="button"
                  className="tl-activity-log__jump-bottom"
                  onClick={() =>
                    activityLogEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" })
                  }
                >
                  Oldest event
                </button>
              </div>
              <ol className="tl-activity-log__list">
                {[...activityLogSittings].reverse().map(({ sitting, blocks }, index, newestFirst) => {
                  const newerSitting = newestFirst[index - 1]?.sitting;
                  const gapMs = newerSitting ? Math.max(0, newerSitting.startMs - sitting.endMs) : 0;
                  const date = new Date(sitting.startMs);
                  return (
                    <Fragment key={sitting.id}>
                      {newerSitting && (
                        <li className="tl-activity-log__break">
                          <span className="tl-activity-log__break-rule" aria-hidden="true" />
                          <span>Break between sittings · {formatDuration(gapMs)} elapsed</span>
                          <span className="tl-activity-log__break-rule" aria-hidden="true" />
                        </li>
                      )}
                      {timelineSittings.length > 1 && (
                        <li className="tl-activity-log__sitting">
                          <time dateTime={date.toISOString()} title={date.toLocaleString()}>
                            Sitting {sitting.index + 1} · {date.toLocaleDateString(undefined, { month: "short", day: "numeric" })} · {formatClock(sitting.startMs)}
                          </time>
                          <span>
                            {sitting.moveCount} move{sitting.moveCount === 1 ? "" : "s"} · {formatDuration(sitting.activeMs)} active · {sitting.label}
                          </span>
                        </li>
                      )}
                      {[...blocks].reverse().map((block) => {
                  const track =
                    (block.trackId ? tracks.find((candidate) => candidate.id === block.trackId) : null) ??
                    (block.trackName
                      ? tracks.find(
                          (candidate) => candidate.name?.toLowerCase() === block.trackName?.toLowerCase(),
                        )
                      : null);
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
                        onClick={() => track && setSelectedTrackId(track.id)}
                        title={track ? `Focus ${block.trackName ?? "track"}` : undefined}
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
                    </Fragment>
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
              <span className="tl-blocks__kick">MIDI changes</span>
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
                  const summary = describeMidiChange(edit);
                  return (
                    <div
                      key={edit.id}
                      className="tl-note-row"
                      style={{ ["--lane-color" as string]: track ? trackColor(track) : "var(--paper)" }}
                    >
                      <span className="tl-block__rail" aria-hidden="true" />
                      <span className="tl-block__main">
                        {/* The musical act first, the numbers under it. A
                            producer recognises "moved up an octave"; they do not
                            recognise "distinct_pitches 1 → 4". */}
                        <span className="tl-block__top">
                          <span className="tl-block__track">{summary.headline}</span>
                          <span className="tl-note-row__track">{midiChangeSubject(edit)}</span>
                        </span>
                        <span className="tl-notes-val">
                          <PitchBar
                            min={edit.pitch_min}
                            max={edit.pitch_max}
                            previousMin={edit.previous_pitch_min}
                            previousMax={edit.previous_pitch_max}
                            label={edit.pitch_range}
                          />
                          {summary.detail && (
                            <span className="tl-block__params">{summary.detail}</span>
                          )}
                        </span>
                        {/* Raw fields, kept so the capture can still be checked
                            against Live rather than trusting the phrase above —
                            but demoted, because they are evidence, not the story. */}
                        <span className="tl-note-row__raw">
                          {edit.previous_note_count ?? "—"} → {edit.note_count ?? "—"} notes
                          {edit.distinct_pitches !== null && ` · ${edit.distinct_pitches} pitches`}
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
            </div>
          </details>

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
    </m.div>
    </LazyMotion>
  );
}
