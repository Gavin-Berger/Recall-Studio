import { useEffect, useMemo, useRef, useState } from "react";
import type { MutableRefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "./App.css";

import { AppShell } from "./components/AppShell";
import type { AppSurface } from "./components/AppShell";
import { ConnectionPanel } from "./components/ConnectionPanel";
import { ProducerInsights } from "./components/ProducerInsights";
import { SessionDocument } from "./components/SessionDocument";
import { SessionOverview } from "./components/SessionOverview";
import { SessionTimeline } from "./components/SessionTimeline";
import { SignalStatusStrip } from "./components/SignalStatusStrip";
import { HomeScreen } from "./features/home/HomeScreen";
import type {
  ConnectionStatus,
  RecallEventType,
  RecallMetadataValue,
  RecallTimelineMoment,
  SavedSession,
  SavedSessionMetadata,
  SessionStats,
  SessionViewMode,
} from "./types/recall";
import { buildCreativeTimeline } from "./lib/timeline/creativeTimeline";
import {
  deriveTransportFromEvents,
  deriveCaptureDuration,
  formatProjectClock,
  formatArrangementPosition,
  convertAbletonBeatsToSeconds,
} from "./lib/transport/transportState";
import { useTimelineCuration } from "./hooks/useTimelineCuration";
import { useActivityBlocks } from "./hooks/useActivityBlocks";
import { getSessionElapsedTime } from "./utils/timecode";

const BACKEND_CONNECTION_COMMAND = "get_connection_status";
const BACKEND_EVENTS_COMMAND = "get_recent_events";
const BACKEND_LIST_SESSIONS_COMMAND = "list_saved_sessions";
const BACKEND_LOAD_SESSION_COMMAND = "load_session_events";
const BACKEND_START_NEW_SESSION_COMMAND = "start_new_session";
const BACKEND_DELETE_SESSION_COMMAND = "delete_saved_session";

const POLL_INTERVAL_MS = 1000;
// How often buffered live events are flushed into React state. Low enough to
// feel real-time, high enough to collapse bursts into a single re-render.
const LIVE_FLUSH_INTERVAL_MS = 150;

function App() {
  const [surface, setSurface] = useState<AppSurface>("home");
  const [connection, setConnection] = useState<ConnectionStatus>({
    connected: false,
    last_heartbeat_ms: null,
    last_message: null,
    bridge_version: null,
  });

  const [liveEvents, setLiveEvents] = useState<RecallTimelineMoment[]>([]);
  const [savedEvents, setSavedEvents] = useState<RecallTimelineMoment[]>([]);
  const [savedSessions, setSavedSessions] = useState<SavedSessionMetadata[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<SessionViewMode>("live");
  const [eventCommandAvailable, setEventCommandAvailable] = useState(true);
  const liveSessionStartedAtRef = useRef<number | null>(null);
  // Live ingestion is batched: UDP events can arrive faster than React can
  // re-render, and every render rebuilds the whole creative timeline + stats.
  // We dedup with an O(1) id set and buffer arrivals, then flush in batches on
  // an interval so render cost is bounded by flush rate, not event rate.
  const seenLiveIdsRef = useRef<Set<string>>(new Set());
  const pendingLiveEventsRef = useRef<RecallTimelineMoment[]>([]);

  function resetLiveEventTracking() {
    seenLiveIdsRef.current = new Set();
    pendingLiveEventsRef.current = [];
  }

  const activeSession = useMemo(
    () => savedSessions.find((s) => s.ended_at_ms === null) ?? null,
    [savedSessions],
  );

  useEffect(() => {
    let mounted = true;

    async function pollConnection() {
      try {
        const status = await invoke<ConnectionStatus>(
          BACKEND_CONNECTION_COMMAND,
        );

        if (mounted) {
          setConnection(status);
        }
      } catch (error) {
        console.error("Failed to get connection status:", error);

        if (mounted) {
          setConnection((current) => ({
            ...current,
            connected: false,
          }));
        }
      }
    }

    pollConnection();

    const interval = window.setInterval(pollConnection, POLL_INTERVAL_MS);

    return () => {
      mounted = false;
      window.clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    if (!eventCommandAvailable) return;

    let unlisten: (() => void) | undefined;

    async function setup() {
      // Seed with all events already in the backend's in-memory buffer.
      // This covers the full live session since the buffer is no longer capped.
      try {
        const rawEvents = await invoke<unknown[]>(BACKEND_EVENTS_COMMAND);
        if (Array.isArray(rawEvents)) {
          const normalized = rawEvents
            .map((rawEvent, index) =>
              normalizeBackendEvent(rawEvent, index, liveSessionStartedAtRef),
            )
            .filter((e): e is RecallTimelineMoment => e !== null);
          // Seed the dedup set so streamed events that overlap the buffer are
          // ignored without an O(n) scan.
          seenLiveIdsRef.current = new Set(normalized.map((e) => e.id));
          pendingLiveEventsRef.current = [];
          setLiveEvents(normalized);
        }
      } catch (error) {
        console.warn(
          `Backend event command "${BACKEND_EVENTS_COMMAND}" is not available.`,
          error,
        );
        setEventCommandAvailable(false);
        return;
      }

      // Subscribe to real-time push events from the Rust UDP listener.
      // New events are appended; duplicates are ignored by ID check.
      unlisten = await listen<unknown>("recall-event", (tauriEvent) => {
        const normalized = normalizeBackendEvent(
          tauriEvent.payload,
          0,
          liveSessionStartedAtRef,
        );
        if (!normalized) return;
        // O(1) dedup; buffer for the next flush instead of setting state now.
        if (seenLiveIdsRef.current.has(normalized.id)) return;
        seenLiveIdsRef.current.add(normalized.id);
        pendingLiveEventsRef.current.push(normalized);
      });
    }

    setup();

    // Drain buffered events into state in batches, collapsing event bursts into
    // a single re-render so the per-event cost stays bounded under heavy load.
    const flushInterval = window.setInterval(() => {
      if (pendingLiveEventsRef.current.length === 0) return;
      const batch = pendingLiveEventsRef.current;
      pendingLiveEventsRef.current = [];
      setLiveEvents((prev) => prev.concat(batch));
    }, LIVE_FLUSH_INTERVAL_MS);

    return () => {
      unlisten?.();
      window.clearInterval(flushInterval);
    };
  }, [eventCommandAvailable]);

  useEffect(() => {
    let mounted = true;

    async function refreshSavedSessions() {
      try {
        const sessions = await invoke<SavedSessionMetadata[]>(
          BACKEND_LIST_SESSIONS_COMMAND,
        );

        if (mounted) {
          setSavedSessions(sessions);
        }
      } catch (error) {
        console.error("Failed to list saved sessions:", error);
      }
    }

    refreshSavedSessions();

    const interval = window.setInterval(refreshSavedSessions, POLL_INTERVAL_MS);

    return () => {
      mounted = false;
      window.clearInterval(interval);
    };
  }, []);

  const rawEvents = viewMode === "live" ? liveEvents : savedEvents;
  const playbackState = useMemo(() => deriveTransportFromEvents(rawEvents), [rawEvents]);
  const creativeEvents = useMemo(() => buildCreativeTimeline(rawEvents), [rawEvents]);
  const bridgeCaptureDuration = useMemo(
    () => deriveCaptureDuration(rawEvents, viewMode),
    [rawEvents, viewMode],
  );

  // Curation is persisted per session. Saved sessions have stable event IDs;
  // for live capture we key on the active session so notes survive a reload.
  const curationSessionId =
    viewMode === "saved" ? selectedSessionId : (activeSession?.id ?? null);

  const {
    allItems,
    visibleItems,
    freeNotes,
    actions: curationActions,
  } = useTimelineCuration(creativeEvents, curationSessionId);

  const activityBlocks = useActivityBlocks(creativeEvents);

  // selectedItem is driven by click selection; falls back to the latest visible item.
  const latestItem = visibleItems[visibleItems.length - 1] ?? null;
  const selectedItem = useMemo(() => {
    if (!selectedEventId) return latestItem;
    return visibleItems.find((item) => item.id === selectedEventId) ?? latestItem;
  }, [visibleItems, latestItem, selectedEventId]);

  // Raw event equivalents for components that haven't adopted TimelineItem yet.
  const latestEvent = latestItem?.raw ?? null;
  const selectedEvent = selectedItem?.raw ?? null;

  const stats = useMemo<SessionStats>(() => {
    return {
      totalEvents: rawEvents.length,
      creativeEvents: creativeEvents.length,
      transportEvents: creativeEvents.filter((e) => e.type === "transport").length,
      tempoEvents: creativeEvents.filter((e) => e.type === "tempo").length,
      trackEvents: creativeEvents.filter((e) => e.type === "track").length,
      deviceEvents: creativeEvents.filter((e) => e.type === "device").length,
      parameterEvents: creativeEvents.filter((e) => e.type === "parameter").length,
      heartbeatEvents: rawEvents.filter((e) => e.type === "heartbeat").length,
    };
  }, [creativeEvents, rawEvents]);

  async function handleSelectSavedSession(sessionId: string) {
    try {
      const session = await invoke<SavedSession>(BACKEND_LOAD_SESSION_COMMAND, {
        sessionId,
      });
      const savedStartedAtRef: MutableRefObject<number | null> = {
        current: session.started_at_ms,
      };
      const normalizedEvents = session.events
        .map((event, index) =>
          normalizeBackendEvent(event, index, savedStartedAtRef),
        )
        .filter((event): event is RecallTimelineMoment => event !== null);

      setSavedEvents(normalizedEvents);
      setSelectedSessionId(sessionId);
      setSelectedEventId(null);
      setViewMode("saved");
      setSurface("timeline");
    } catch (error) {
      console.error("Failed to load saved session:", error);
    }
  }

  function handleSelectLiveSession() {
    setViewMode("live");
    setSelectedSessionId(null);
    setSelectedEventId(null);
  }

  async function handleStartNewSession() {
    try {
      await invoke(BACKEND_START_NEW_SESSION_COMMAND);
      liveSessionStartedAtRef.current = null;
      resetLiveEventTracking();
      setLiveEvents([]);
      setSavedEvents([]);
      setSelectedSessionId(null);
      setSelectedEventId(null);
      setViewMode("live");
      setSurface("capture");

      const sessions = await invoke<SavedSessionMetadata[]>(
        BACKEND_LIST_SESSIONS_COMMAND,
      );
      setSavedSessions(sessions);
    } catch (error) {
      console.error("Failed to start a new session:", error);
    }
  }

  function handleGoToCapture() {
    setSurface("capture");
  }

  async function handleDeleteSavedSession(sessionId: string) {
    const session = savedSessions.find((savedSession) => savedSession.id === sessionId);
    const confirmed = window.confirm(
      `Delete ${session?.name ?? "this session"} from local Recall Studio history? This cannot be undone.`,
    );

    if (!confirmed) {
      return;
    }

    try {
      await invoke(BACKEND_DELETE_SESSION_COMMAND, { sessionId });

      if (selectedSessionId === sessionId) {
        setSavedEvents([]);
        setSelectedSessionId(null);
        setSelectedEventId(null);
        setViewMode("live");
      }

      const sessions = await invoke<SavedSessionMetadata[]>(
        BACKEND_LIST_SESSIONS_COMMAND,
      );

      setSavedSessions(sessions);

      if (session?.ended_at_ms === null) {
        liveSessionStartedAtRef.current = null;
        resetLiveEventTracking();
        setLiveEvents([]);
        setViewMode("live");
      }
    } catch (error) {
      console.error("Failed to delete saved session:", error);
    }
  }

  return (
    <AppShell
      surface={surface}
      onChangeSurface={setSurface}
      connected={connection.connected}
      home={
        <HomeScreen
          connection={connection}
          sessions={savedSessions}
          activeSession={activeSession}
          onStartNewSession={handleStartNewSession}
          onGoToCapture={handleGoToCapture}
          onOpenSession={handleSelectSavedSession}
        />
      }
      rail={
        <SessionOverview
          events={creativeEvents}
          stats={stats}
          sessions={savedSessions}
          selectedSessionId={selectedSessionId}
          viewMode={viewMode}
          onSelectLiveSession={handleSelectLiveSession}
          onSelectSavedSession={handleSelectSavedSession}
          onStartNewSession={handleStartNewSession}
          onDeleteSavedSession={handleDeleteSavedSession}
        />
      }
      timeline={
        <SessionTimeline
          connection={connection}
          items={visibleItems}
          allItems={allItems}
          rawEvents={creativeEvents}
          activityBlocks={activityBlocks}
          playback={playbackState}
          selectedEventId={selectedItem?.id ?? null}
          stats={stats}
          viewMode={viewMode}
          onSelectEvent={setSelectedEventId}
          onHideItem={curationActions.hideItem}
          onRestoreItem={curationActions.restoreItem}
          onEditItem={curationActions.editItem}
          onAddNote={curationActions.addNote}
        />
      }
      document={
        <SessionDocument
          visibleItems={visibleItems}
          freeNotes={freeNotes}
          playback={playbackState}
          stats={stats}
          viewMode={viewMode}
          curationEnabled={curationSessionId !== null}
          onEditItem={curationActions.editItem}
          onHideItem={curationActions.hideItem}
          onAddNote={curationActions.addNote}
          onDeleteNote={curationActions.deleteNote}
        />
      }
      analytics={<ProducerInsights events={creativeEvents} stats={stats} />}
      inspector={
        <ConnectionPanel
          connection={connection}
          events={creativeEvents}
          latestEvent={latestEvent}
          selectedEvent={selectedEvent}
          heartbeatCount={stats.heartbeatEvents}
          playback={playbackState}
          stats={stats}
          bridgeCaptureDuration={bridgeCaptureDuration}
        />
      }
      statusStrip={
        <SignalStatusStrip
          connection={connection}
          playback={playbackState}
          stats={stats}
          latestEvent={latestEvent}
          bridgeCaptureDuration={bridgeCaptureDuration}
        />
      }
    />
  );
}

// Shape of the RecallEvent struct as serialized by Rust.
// Fields extracted by the Rust normalizer are top-level — no payload digging needed.
type BackendEvent = {
  event_type?: string;
  timestamp_ms?: number;
  source?: string;
  // Structured fields extracted by Rust from the payload at ingestion.
  track_name?: string | null;
  device_name?: string | null;
  parameter_name?: string | null;
  parameter_value?: number | null;
  clip_name?: string | null;
  device_chain?: string | null;
  bpm?: number | null;
  playing?: boolean | null;
  // Retain raw payload and legacy fields for backwards compatibility
  // with v1 events loaded from the database.
  [key: string]: unknown;
};

// Canonical lookup map: exact Rust event_type strings → frontend RecallEventType.
// No string inference — if the event_type isn't in this map, it stays "unknown".
const EVENT_TYPE_MAP: Record<string, RecallEventType> = {
  // Transport
  transport_play: "transport",
  transport_stop: "transport",
  transport_changed: "transport",
  playback_state_changed: "transport",
  beat_time_changed: "transport",
  recording_state_changed: "transport",
  // Tempo
  tempo_changed: "tempo",
  // Track
  track_selected: "track",
  track_created: "track",
  track_deleted: "track",
  track_name_changed: "track",
  track_event: "track",
  // Device
  device_added: "device",
  device_removed: "device",
  device_chain_changed: "device",
  device_event: "device",
  device_selected: "device",
  // Parameter
  device_parameter_changed: "parameter",
  parameter_changed: "parameter",
  // Clip
  clip_created: "clip",
  clip_launched: "clip",
  clip_stopped: "clip",
  clip_deleted: "clip",
  clip_event: "clip",
  clip_recording_started: "clip",
  clip_recording_stopped: "clip",
  // Scene
  scene_launched: "scene",
  scene_changed: "scene",
  // Group
  group_focused: "group",
  // Session / arrangement
  live_set_snapshot: "session",
  session_snapshot: "session",
  creative_decision: "creative_moment",
  // File
  project_file_changed: "file",
  // System
  heartbeat: "heartbeat",
  bridge_started: "heartbeat",
  bridge_stopped: "heartbeat",
};

function canonicalEventType(rawEventType: string | undefined): RecallEventType {
  if (!rawEventType) return "unknown";
  return EVENT_TYPE_MAP[rawEventType] ?? EVENT_TYPE_MAP[rawEventType.toLowerCase()] ?? "unknown";
}

function normalizeBackendEvent(
  rawEvent: unknown,
  index: number,
  sessionStartedAtRef: MutableRefObject<number | null>,
): RecallTimelineMoment | null {
  if (!rawEvent || typeof rawEvent !== "object") {
    return null;
  }

  // The Rust backend sends RecallEvent with structured top-level fields.
  // For v1 events loaded from the database, payload may still need parsing
  // to recover legacy fields — keep withParsedPayload for compatibility.
  const raw = rawEvent as BackendEvent;
  const event = withParsedPayload(raw as Record<string, unknown>);

  // Timestamps: use the ms field from Rust directly. Fall back to legacy paths
  // only for old v1 database events that may not include timestamp_ms.
  const timestamp =
    typeof raw.timestamp_ms === "number"
      ? raw.timestamp_ms
      : (readTimestamp(event) ?? Date.now());

  if (!sessionStartedAtRef.current) {
    sessionStartedAtRef.current = timestamp;
  }

  // Type: canonical lookup first. Fall back to string inference only for
  // old v1 events that predate the structured event_type vocabulary.
  const rawEventType = typeof raw.event_type === "string" ? raw.event_type : readRawEventType(event);
  const type = canonicalEventType(rawEventType) !== "unknown"
    ? canonicalEventType(rawEventType)
    : readEventTypeLegacy(event);

  // ── Structured fields ───────────────────────────────────────────────────
  // v2 events: read directly from top-level Rust struct fields.
  // v1 events: fall back to deep path search (old behaviour).
  const trackName =
    typeof raw.track_name === "string"
      ? raw.track_name
      : readStringDeep(event, ["track", "track_name", "selected_track", "payload.track_name", "payload.track", "data.track_name"]);

  const deviceName =
    typeof raw.device_name === "string"
      ? raw.device_name
      : readStringDeep(event, ["device", "device_name", "plugin", "plugin_name", "payload.device_name", "payload.device"]);

  const parameterName =
    typeof raw.parameter_name === "string"
      ? raw.parameter_name
      : readStringDeep(event, ["parameter", "parameter_name", "param", "param_name", "payload.parameter_name", "payload.parameter"]);

  const clipName =
    typeof raw.clip_name === "string"
      ? raw.clip_name
      : readStringDeep(event, ["clip", "clip_name", "payload.clip_name", "payload.clip"]);

  // Top-level for live events; payload fallback for saved sessions (no column).
  const deviceChain =
    typeof raw.device_chain === "string"
      ? raw.device_chain
      : readStringDeep(event, ["device_chain", "payload.device_chain", "chain", "payload.chain"]);

  const bpm =
    typeof raw.bpm === "number"
      ? raw.bpm
      : readNumberDeep(event, ["bpm", "tempo", "payload.bpm", "payload.tempo"]);

  const playing =
    typeof raw.playing === "boolean"
      ? raw.playing
      : readBooleanDeep(event, ["playing", "is_playing", "payload.playing"]);

  // Fields not yet promoted to top-level struct (v1 compat only).
  const groupName = readStringDeep(event, [
    "group", "group_name", "track_group",
    "payload.group", "payload.group_name",
  ]);
  const groupPath = readStringArrayDeep(event, [
    "group_path", "groupPath", "payload.group_path",
  ]);
  const previousBpm = readNumberDeep(event, [
    "previous_bpm", "previousBpm", "payload.previous_bpm",
  ]);
  const state = readStringDeep(event, [
    "state", "transport_state", "play_state",
    "payload.state", "payload.transport_state",
  ]);
  const songTime = readNumberDeep(event, [
    "current_song_time", "beat_time", "song_time_beats",
    "payload.current_song_time", "payload.beat_time",
  ]);
  const explicitProjectTimeSeconds = readNumberDeep(event, [
    "song_time_seconds", "project_time_seconds",
    "payload.song_time_seconds", "payload.project_time_seconds",
  ]);
  const projectTimeSeconds =
    explicitProjectTimeSeconds ??
    (typeof songTime === "number" ? convertAbletonBeatsToSeconds(songTime, bpm) : undefined);

  const source =
    (typeof raw.source === "string" ? raw.source : null) ??
    readStringDeep(event, ["source", "payload.source"]) ??
    "Max_for_Live";

  // Prefer the backend-assigned SQLite rowid so a live event keeps the same
  // identity once the session is saved and reloaded (stable curation keys).
  // Live events carry a numeric `id`; saved events carry it as a string.
  const id =
    (typeof raw.id === "number" ? String(raw.id) : undefined) ??
    readStringDeep(event, ["id", "event_id", "eventId"]) ??
    `${rawEventType ?? type}-${timestamp}-${index}`;

  return {
    id,
    type,
    rawEventType,
    timelineRole: readTimelineRole(rawEventType, type),
    rawEvent: event,
    timestamp,
    sessionTimecode: getSessionElapsedTime(timestamp, sessionStartedAtRef.current),
    summary: buildEventSummary({
      type, trackName, groupName, groupPath, deviceName,
      parameterName, clipName, bpm, previousBpm, state,
      playing, songTime, projectTimeSeconds, event,
    }),
    detail: buildEventDetail({
      type, trackName, groupName, groupPath, deviceName,
      parameterName, clipName, bpm, previousBpm, state,
      playing, songTime, projectTimeSeconds, event,
    }),
    trackName,
    groupName,
    groupPath,
    deviceName,
    deviceChain,
    source,
    metadata: buildMetadata(event, {
      trackName, groupName, groupPath, deviceName, deviceChain,
      parameterName, clipName, bpm, previousBpm, state,
      playing, songTime, projectTimeSeconds,
    }),
  };
}


function readTimelineRole(
  rawEventType: string | undefined,
  type: RecallEventType,
): RecallTimelineMoment["timelineRole"] {
  if (type === "heartbeat") return "debug";
  if (rawEventType === "transport_snapshot") return "context";
  if (type === "transport" || type === "tempo") return "transport";
  return "creative";
}

function withParsedPayload(
  event: Record<string, unknown>,
): Record<string, unknown> {
  const payload = event.payload;

  if (typeof payload !== "string") {
    return event;
  }

  try {
    return {
      ...event,
      payload: JSON.parse(payload),
    };
  } catch {
    return event;
  }
}

// Legacy type inference — only used for v1 events loaded from the database
// that predate the structured event_type vocabulary. New events use canonicalEventType().
function readEventTypeLegacy(event: Record<string, unknown>): RecallEventType {
  const rawType = String(
    event.type ??
      event.event_type ??
      event.eventType ??
      event.kind ??
      event.name ??
      event.label ??
      event.title ??
      event.message ??
      "unknown",
  ).toLowerCase();

  if (rawType.includes("heart")) return "heartbeat";
  if (rawType.includes("transport") || rawType.includes("playback")) return "transport";
  if (rawType.includes("tempo") || rawType.includes("bpm")) return "tempo";
  if (rawType.includes("scene_launched") || rawType.includes("scene launched")) return "scene";
  if (rawType.includes("clip")) return "clip";
  if (rawType.includes("group") || rawType.includes("track bus")) return "group";
  if (rawType.includes("selected_track") || rawType.includes("track_selected") || rawType.includes("track")) return "track";
  if (rawType.includes("mixer") || rawType.includes("volume") || rawType.includes("pan")) return "mixer";
  if (rawType.includes("arrangement") || rawType.includes("locator")) return "arrangement";
  if (rawType.includes("device") || rawType.includes("plugin")) return "device";
  if (rawType.includes("parameter") || rawType.includes("param") || rawType.includes("automation")) return "parameter";
  if (rawType.includes("file") || rawType.includes(".als") || rawType.includes("project")) return "file";
  if (rawType.includes("live set") || rawType.includes("session")) return "session";
  if (rawType.includes("moment")) return "creative_moment";
  return "unknown";
}

function readTimestamp(event: Record<string, unknown>): number | null {
  const value =
    readDeepValue(event, "timestamp") ??
    readDeepValue(event, "timestamp_ms") ??
    readDeepValue(event, "timestampMs") ??
    readDeepValue(event, "time") ??
    readDeepValue(event, "created_at") ??
    readDeepValue(event, "createdAt") ??
    readDeepValue(event, "payload.timestamp") ??
    readDeepValue(event, "payload.timestamp_ms") ??
    readDeepValue(event, "data.timestamp") ??
    readDeepValue(event, "data.timestamp_ms");

  if (typeof value === "number") {
    if (value < 10_000_000_000) {
      return value * 1000;
    }

    return value;
  }

  if (typeof value === "string") {
    const parsedDate = Date.parse(value);

    if (!Number.isNaN(parsedDate)) {
      return parsedDate;
    }

    const parsedNumber = Number(value);

    if (Number.isFinite(parsedNumber)) {
      return parsedNumber < 10_000_000_000 ? parsedNumber * 1000 : parsedNumber;
    }
  }

  return null;
}

function buildEventSummary(input: {
  type: RecallEventType;
  trackName?: string;
  groupName?: string;
  groupPath?: string[];
  deviceName?: string;
  parameterName?: string;
  clipName?: string;
  bpm?: number;
  previousBpm?: number;
  state?: string;
  playing?: boolean;
  songTime?: number;
  projectTimeSeconds?: number;
  event: Record<string, unknown>;
}): string {
  const {
    type,
    trackName,
    deviceName,
    parameterName,
    clipName,
    bpm,
    previousBpm,
    state,
    playing,
    event,
  } = input;

  const directSummary = readStringDeep(event, [
    "summary",
    "creative_summary",
    "creativeSummary",
    "human_summary",
    "humanSummary",
    "payload.summary",
    "data.summary",
  ]);

  if (directSummary) {
    return directSummary;
  }

  const rawTitle =
    readStringDeep(event, [
      "title",
      "name",
      "label",
      "event_name",
      "eventName",
      "message",
      "payload.title",
      "payload.name",
      "payload.message",
      "data.title",
      "data.name",
      "data.message",
    ]) ?? "";

  const rawEventType = readStringDeep(event, ["type", "event_type", "eventType"]);
  const normalizedTitle = rawTitle.toLowerCase();
  const normalizedEventType = (rawEventType ?? "").toLowerCase();

  if (normalizedEventType === "transport_play") {
    return "Playback started";
  }

  if (normalizedEventType === "transport_stop") {
    return "Playback stopped";
  }

  if (normalizedEventType === "transport_snapshot") {
    return "Transport updated";
  }

  if (normalizedEventType === "tempo_changed") {
    if (typeof bpm === "number" && typeof previousBpm === "number") {
      return `Tempo changed from ${formatNumber(previousBpm)} to ${formatNumber(bpm)} BPM.`;
    }

    if (typeof bpm === "number") {
      return `Tempo changed to ${formatNumber(bpm)} BPM.`;
    }
  }

  if (normalizedEventType === "selected_track_focus_snapshot") {
    return buildTrackFocusSummary(event, trackName);
  }

  if (normalizedEventType === "live_set_snapshot") {
    return buildLiveSetSummary(event, trackName, bpm, playing);
  }

  if (normalizedTitle.includes("selected track focus snapshot")) {
    return buildTrackFocusSummary(event, trackName);
  }

  if (normalizedTitle.includes("track selected")) {
    if (trackName) {
      return `${trackName} track was selected.`;
    }

    return "Track selection changed.";
  }

  if (normalizedTitle.includes("tempo changed")) {
    if (typeof bpm === "number" && typeof previousBpm === "number") {
      return `Tempo changed from ${formatNumber(previousBpm)} to ${formatNumber(bpm)} BPM.`;
    }

    if (typeof bpm === "number") {
      return `Tempo changed to ${formatNumber(bpm)} BPM.`;
    }

    return "Tempo changed.";
  }

  if (normalizedTitle.includes("transport snapshot")) {
    return "Transport updated";
  }

  if (normalizedTitle.includes("live set snapshot")) {
    return buildLiveSetSummary(event, trackName, bpm, playing);
  }

  switch (type) {
    case "heartbeat":
      return "Heartbeat received from Max for Live.";

    case "transport":
      if (typeof playing === "boolean") {
        return playing ? "Playback started" : "Playback stopped";
      }

      if (state) {
        return `Transport changed to ${state}.`;
      }

      return "Transport state changed.";

    case "tempo":
      if (typeof bpm === "number" && typeof previousBpm === "number") {
        return `Tempo changed from ${formatNumber(previousBpm)} to ${formatNumber(bpm)} BPM.`;
      }

      if (typeof bpm === "number") {
        return `Tempo changed to ${formatNumber(bpm)} BPM.`;
      }

      return "Tempo changed.";

    case "track":
      if (trackName) {
        return "Track selected";
      }

      return "Track focus changed.";

    case "device":
      if (trackName && deviceName) {
        return `${deviceName} was placed on ${trackName}.`;
      }

      if (deviceName) {
        return `${deviceName} device activity was captured.`;
      }

      return "Device activity was captured.";

    case "parameter":
      return buildParameterSummary({
        trackName,
        deviceName,
        parameterName,
        event,
      });

    case "clip":
      if (clipName && trackName) {
        return `${clipName} was launched on ${trackName}.`;
      }

      if (clipName) {
        return `${clipName} was launched.`;
      }

      if (trackName) {
        return `A clip was launched on ${trackName}.`;
      }

      return "A clip was launched.";

    case "session":
      return buildLiveSetSummary(event, trackName, bpm, playing);

    case "file":
      return buildFileSummary(event);

    case "creative_moment":
      return "Creative session moment captured.";

    default:
      if (rawTitle) {
        return rawTitle;
      }

      return "Ableton telemetry event captured.";
  }
}

function buildEventDetail(input: {
  type: RecallEventType;
  trackName?: string;
  groupName?: string;
  groupPath?: string[];
  deviceName?: string;
  parameterName?: string;
  clipName?: string;
  bpm?: number;
  previousBpm?: number;
  state?: string;
  playing?: boolean;
  songTime?: number;
  projectTimeSeconds?: number;
  event: Record<string, unknown>;
}): string | undefined {
  const {
    type,
    trackName,
    deviceName,
    parameterName,
    clipName,
    bpm,
    previousBpm,
    state,
    playing,
    songTime,
    projectTimeSeconds,
    event,
  } = input;

  if (type === "track" && trackName) {
    return `Selected "${trackName}".`;
  }

  if (type === "device" && deviceName && trackName) {
    return `${deviceName} activity was captured on ${trackName}.`;
  }

  if (type === "device" && deviceName) {
    return "Device-level session activity was captured from Ableton.";
  }

  if (type === "parameter" && parameterName) {
    return buildParameterDetail({
      trackName,
      deviceName,
      parameterName,
      event,
    });
  }

  if (type === "tempo" && typeof bpm === "number" && typeof previousBpm === "number") {
    return `${formatSignedNumber(bpm - previousBpm)} BPM change.`;
  }

  if (type === "tempo" && typeof bpm === "number") {
    return "Project tempo value from Ableton Live.";
  }

  if (type === "transport" && typeof playing === "boolean") {
    return `Arrangement playback ${playing ? "started" : "stopped"}${formatAtProjectTime(projectTimeSeconds)}${formatAtArrangementPosition(songTime)}.`;
  }

  if (type === "transport" && state) {
    return `Transport state: ${state}.`;
  }

  if (type === "session") {
    return buildLiveSetDetail(event);
  }

  if (type === "clip" && clipName) {
    return trackName ? `Clip launch on ${trackName}.` : "Clip launch event from Ableton.";
  }

  return undefined;
}

function buildMetadata(
  event: Record<string, unknown>,
  known: {
    trackName?: string;
    groupName?: string;
    groupPath?: string[];
    deviceName?: string;
    deviceChain?: string;
    parameterName?: string;
    clipName?: string;
    bpm?: number;
    previousBpm?: number;
    state?: string;
    playing?: boolean;
    songTime?: number;
    projectTimeSeconds?: number;
  },
): Record<string, RecallMetadataValue> {
  const metadata: Record<string, RecallMetadataValue> = {};

  if (known.state) metadata.state = known.state;
  if (typeof known.bpm === "number") metadata.bpm = known.bpm;
  if (known.trackName) metadata.track = known.trackName;
  if (known.groupName) metadata.group = known.groupName;
  if (known.groupPath?.length) metadata.groupPath = known.groupPath;
  if (known.deviceName) metadata.device = known.deviceName;
  if (known.deviceChain) metadata.deviceChain = known.deviceChain;
  if (known.parameterName) metadata.parameter = known.parameterName;
  if (known.clipName) metadata.clip = known.clipName;
  if (typeof known.previousBpm === "number") metadata.previousBpm = known.previousBpm;
  if (typeof known.playing === "boolean") metadata.playing = known.playing;
  if (typeof known.songTime === "number") {
    metadata.arrangementPosition = formatArrangementPosition(known.songTime);
    metadata.songTime = known.songTime;
  }
  if (typeof known.projectTimeSeconds === "number") {
    metadata.projectClock = formatProjectClock(known.projectTimeSeconds);
    metadata.projectTimeSeconds = known.projectTimeSeconds;
  }

  const position = readStringDeep(event, [
    "position",
    "beat_position",
    "beatPosition",
    "song_position",
    "songPosition",
    "payload.position",
    "payload.beat_position",
    "payload.song_position",
    "data.position",
    "data.beat_position",
    "data.song_position",
  ]);

  const trackIndex = readNumberDeep(event, [
    "track_index",
    "trackIndex",
    "index",
    "payload.track_index",
    "payload.trackIndex",
    "payload.index",
    "data.track_index",
    "data.index",
  ]);

  const value =
    readDeepValue(event, "value") ?? readDeepValue(event, "payload.value");

  if (position) metadata.position = position;
  if (typeof trackIndex === "number") metadata.trackIndex = trackIndex;

  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null
  ) {
    metadata.value = value;
  }

  return metadata;
}

function readRawEventType(event: Record<string, unknown>): string | undefined {
  return readStringDeep(event, ["type", "event_type", "eventType"])?.toLowerCase();
}

function buildTrackFocusSummary(
  event: Record<string, unknown>,
  trackName?: string,
): string {
  const name =
    trackName ??
    readStringDeep(event, ["name", "payload.name", "data.name"]) ??
    "Selected track";
  const deviceCount = readNumberDeep(event, [
    "device_count",
    "payload.device_count",
    "data.device_count",
  ]);
  const clipCount = readArrayLength(event, ["clips", "payload.clips", "data.clips"]);
  const armed = readBooleanDeep(event, ["arm", "payload.arm", "data.arm"]);
  const muted = readBooleanDeep(event, ["muted", "payload.muted", "data.muted"]);
  const solo = readBooleanDeep(event, ["solo", "payload.solo", "data.solo"]);
  const details: string[] = [];

  if (typeof deviceCount === "number") {
    details.push(`${deviceCount} device${deviceCount === 1 ? "" : "s"}`);
  }

  if (typeof clipCount === "number") {
    details.push(`${clipCount} clip${clipCount === 1 ? "" : "s"}`);
  }

  if (armed) details.push("armed");
  if (muted) details.push("muted");
  if (solo) details.push("soloed");

  return details.length > 0
    ? `${name} track was selected (${details.join(", ")}).`
    : `${name} track was selected.`;
}

function buildLiveSetSummary(
  event: Record<string, unknown>,
  trackName?: string,
  bpm?: number,
  playing?: boolean,
): string {
  const trackCount = readNumberDeep(event, [
    "track_count",
    "payload.track_count",
    "data.track_count",
    "counts.tracks",
    "payload.counts.tracks",
  ]);
  const sceneCount = readNumberDeep(event, [
    "scene_count",
    "payload.scene_count",
    "data.scene_count",
    "counts.scenes",
    "payload.counts.scenes",
  ]);
  const parts: string[] = [];

  if (typeof trackCount === "number") {
    parts.push(`${trackCount} track${trackCount === 1 ? "" : "s"}`);
  }

  if (typeof sceneCount === "number") {
    parts.push(`${sceneCount} scene${sceneCount === 1 ? "" : "s"}`);
  }

  if (typeof bpm === "number") {
    parts.push(`${formatNumber(bpm)} BPM`);
  }

  if (typeof playing === "boolean") {
    parts.push(playing ? "playing" : "stopped");
  }

  if (trackName) {
    parts.push(`${trackName} selected`);
  }

  return parts.length > 0
    ? `Live Set state: ${parts.join(", ")}.`
    : "Live Set state changed.";
}

function buildLiveSetDetail(event: Record<string, unknown>): string | undefined {
  const tracks = readObjectArray(event, ["tracks", "payload.tracks", "data.tracks"])
    .map((track) => readStringDeep(track, ["name"]))
    .filter((name): name is string => Boolean(name))
    .slice(0, 5);

  if (tracks.length > 0) {
    return `Tracks visible in this snapshot: ${tracks.join(", ")}.`;
  }

  return undefined;
}

function buildParameterSummary(input: {
  trackName?: string;
  deviceName?: string;
  parameterName?: string;
  event: Record<string, unknown>;
}): string {
  const { trackName, deviceName, parameterName, event } = input;
  const value = readPrimitive(event, ["value", "payload.value", "data.value"]);
  const valueText = value === undefined ? "" : ` to ${formatPrimitive(value)}`;

  if (deviceName && trackName && parameterName) {
    return `${parameterName} on ${deviceName} in ${trackName} was changed${valueText}.`;
  }

  if (deviceName && parameterName) {
    return `${parameterName} on ${deviceName} was changed${valueText}.`;
  }

  if (parameterName) {
    return `${parameterName} was changed${valueText}.`;
  }

  if (deviceName && trackName) {
    return `${deviceName} was edited on ${trackName}.`;
  }

  return "A parameter was changed.";
}

function buildParameterDetail(input: {
  trackName?: string;
  deviceName?: string;
  parameterName?: string;
  event: Record<string, unknown>;
}): string | undefined {
  const { event } = input;
  const minValue = readPrimitive(event, ["min_value", "min", "payload.min_value", "payload.min"]);
  const maxValue = readPrimitive(event, ["max_value", "max", "payload.max_value", "payload.max"]);

  if (minValue !== undefined && maxValue !== undefined) {
    return `Range touched: ${formatPrimitive(minValue)} to ${formatPrimitive(maxValue)}.`;
  }

  return "Device or mixer control value changed in Ableton.";
}

function buildFileSummary(event: Record<string, unknown>): string {
  const fileName = readStringDeep(event, ["file_name", "fileName", "payload.file_name"]);
  const changeType = readStringDeep(event, ["change_type", "changeType", "payload.change_type"]);

  if (fileName && changeType) {
    return `${fileName} was ${changeType}.`;
  }

  if (fileName) {
    return `${fileName} changed.`;
  }

  return "Ableton project file changed.";
}

function formatAtArrangementPosition(songTime?: number): string {
  if (typeof songTime !== "number") {
    return "";
  }

  return ` (${formatArrangementPosition(songTime)})`;
}

function formatAtProjectTime(projectTimeSeconds?: number): string {
  if (typeof projectTimeSeconds !== "number") {
    return "";
  }

  return ` at ${formatProjectClock(projectTimeSeconds)}`;
}

function formatNumber(value: number): string {
  if (Number.isInteger(value)) {
    return String(value);
  }

  return value.toFixed(2).replace(/\.?0+$/, "");
}

function formatSignedNumber(value: number): string {
  const formatted = formatNumber(value);
  return value > 0 ? `+${formatted}` : formatted;
}

function formatPrimitive(value: string | number | boolean | null): string {
  if (typeof value === "number") {
    return formatNumber(value);
  }

  return String(value);
}

function readPrimitive(
  event: Record<string, unknown>,
  keys: string[],
): string | number | boolean | null | undefined {
  for (const key of keys) {
    const value = readDeepValue(event, key);

    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean" ||
      value === null
    ) {
      return value;
    }
  }

  return undefined;
}

function readObjectArray(
  event: Record<string, unknown>,
  keys: string[],
): Record<string, unknown>[] {
  for (const key of keys) {
    const value = readDeepValue(event, key);

    if (Array.isArray(value)) {
      return value.filter(
        (item): item is Record<string, unknown> =>
          Boolean(item) && typeof item === "object",
      );
    }
  }

  return [];
}

function readArrayLength(
  event: Record<string, unknown>,
  keys: string[],
): number | undefined {
  for (const key of keys) {
    const value = readDeepValue(event, key);

    if (Array.isArray(value)) {
      return value.length;
    }
  }

  return undefined;
}

function readStringDeep(
  event: Record<string, unknown>,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    const value = readDeepValue(event, key);

    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }

    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }

  return undefined;
}

function readStringArrayDeep(
  event: Record<string, unknown>,
  keys: string[],
): string[] | undefined {
  for (const key of keys) {
    const value = readDeepValue(event, key);

    if (Array.isArray(value)) {
      const strings = value.filter(
        (item): item is string =>
          typeof item === "string" && item.trim().length > 0,
      );

      if (strings.length > 0) {
        return strings;
      }
    }

    if (typeof value === "string" && value.trim().length > 0) {
      return value
        .split("/")
        .map((part) => part.trim())
        .filter(Boolean);
    }
  }

  return undefined;
}

function readNumberDeep(
  event: Record<string, unknown>,
  keys: string[],
): number | undefined {
  for (const key of keys) {
    const value = readDeepValue(event, key);

    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }

    if (typeof value === "string") {
      const parsed = Number(value);

      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }

  return undefined;
}

function readBooleanDeep(
  event: Record<string, unknown>,
  keys: string[],
): boolean | undefined {
  for (const key of keys) {
    const value = readDeepValue(event, key);

    if (typeof value === "boolean") {
      return value;
    }

    if (typeof value === "number") {
      return value === 1;
    }

    if (typeof value === "string") {
      if (value === "1" || value.toLowerCase() === "true") {
        return true;
      }

      if (value === "0" || value.toLowerCase() === "false") {
        return false;
      }
    }
  }

  return undefined;
}

function readDeepValue(event: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = event;

  for (const part of parts) {
    if (!current || typeof current !== "object") {
      return undefined;
    }

    current = (current as Record<string, unknown>)[part];
  }

  return current;
}

export default App;
