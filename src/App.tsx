import { useEffect, useMemo, useRef, useState } from "react";
import type { MutableRefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./App.css";

import { AppShell } from "./components/AppShell";
import { ConnectionPanel } from "./components/ConnectionPanel";
import { SessionDocument } from "./components/SessionDocument";
import { SessionOverview } from "./components/SessionOverview";
import { SessionTimeline } from "./components/SessionTimeline";
import { SignalStatusStrip } from "./components/SignalStatusStrip";
import type {
  ConnectionStatus,
  PlaybackState,
  RecallEventType,
  RecallMetadataValue,
  RecallTimelineMoment,
  SavedSession,
  SavedSessionMetadata,
  SessionStats,
  SessionViewMode,
} from "./types/recall";
import { isProducerTimelineEvent } from "./utils/producerEvents";
import { getSessionElapsedTime } from "./utils/timecode";

const BACKEND_CONNECTION_COMMAND = "get_connection_status";
const BACKEND_EVENTS_COMMAND = "get_recent_events";
const BACKEND_LIST_SESSIONS_COMMAND = "list_saved_sessions";
const BACKEND_LOAD_SESSION_COMMAND = "load_session_events";
const BACKEND_START_NEW_SESSION_COMMAND = "start_new_session";
const BACKEND_DELETE_SESSION_COMMAND = "delete_saved_session";

const POLL_INTERVAL_MS = 1000;

const EMPTY_PLAYBACK_STATE: PlaybackState = {
  playing: null,
  tempo: null,
  projectClock: null,
  arrangementPosition: null,
  rawSongTime: null,
  selectedTrack: null,
  lastUpdatedAt: null,
};

function App() {
  const [connection, setConnection] = useState<ConnectionStatus>({
    connected: false,
    last_heartbeat_ms: null,
    last_message: null,
  });

  const [liveEvents, setLiveEvents] = useState<RecallTimelineMoment[]>([]);
  const [savedEvents, setSavedEvents] = useState<RecallTimelineMoment[]>([]);
  const [savedSessions, setSavedSessions] = useState<SavedSessionMetadata[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<SessionViewMode>("live");
  const [eventCommandAvailable, setEventCommandAvailable] = useState(true);
  const liveSessionStartedAtRef = useRef<number | null>(null);

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
    let mounted = true;

    async function pollEvents() {
      if (!eventCommandAvailable) {
        return;
      }

      try {
        const rawEvents = await invoke<unknown[]>(BACKEND_EVENTS_COMMAND);

        if (!mounted || !Array.isArray(rawEvents)) {
          return;
        }

        const normalizedEvents = rawEvents
          .map((rawEvent, index) =>
            normalizeBackendEvent(rawEvent, index, liveSessionStartedAtRef),
          )
          .filter((event): event is RecallTimelineMoment => event !== null);

        setLiveEvents(normalizedEvents);
      } catch (error) {
        console.warn(
          `Backend event command "${BACKEND_EVENTS_COMMAND}" is not available yet. The connection panel will still work.`,
          error,
        );

        if (mounted) {
          setEventCommandAvailable(false);
        }
      }
    }

    pollEvents();

    const interval = window.setInterval(pollEvents, POLL_INTERVAL_MS);

    return () => {
      mounted = false;
      window.clearInterval(interval);
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
  const playbackState = useMemo(() => derivePlaybackState(rawEvents), [rawEvents]);
  const events = useMemo(() => buildCreativeTimeline(rawEvents), [rawEvents]);
  const bridgeCaptureDuration = useMemo(
    () => formatCaptureDuration(rawEvents, viewMode),
    [rawEvents, viewMode],
  );

  const latestEvent = useMemo(() => {
    return [...events].reverse().find((event) => event.type !== "heartbeat");
  }, [events]);
  const selectedEvent = useMemo(() => {
    if (!selectedEventId) {
      return latestEvent;
    }

    return events.find((event) => event.id === selectedEventId) ?? latestEvent;
  }, [events, latestEvent, selectedEventId]);

  const stats = useMemo<SessionStats>(() => {
    return {
      totalEvents: rawEvents.length,
      creativeEvents: events.length,
      transportEvents: events.filter((event) => event.type === "transport")
        .length,
      tempoEvents: events.filter((event) => event.type === "tempo").length,
      trackEvents: events.filter((event) => event.type === "track").length,
      deviceEvents: events.filter((event) => event.type === "device").length,
      parameterEvents: events.filter((event) => event.type === "parameter")
        .length,
      heartbeatEvents: rawEvents.filter((event) => event.type === "heartbeat")
        .length,
    };
  }, [events, rawEvents]);

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
      setLiveEvents([]);
      setSavedEvents([]);
      setSelectedSessionId(null);
      setSelectedEventId(null);
      setViewMode("live");

      const sessions = await invoke<SavedSessionMetadata[]>(
        BACKEND_LIST_SESSIONS_COMMAND,
      );
      setSavedSessions(sessions);
    } catch (error) {
      console.error("Failed to start a new session:", error);
    }
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
        setLiveEvents([]);
        setViewMode("live");
      }
    } catch (error) {
      console.error("Failed to delete saved session:", error);
    }
  }

  return (
    <AppShell
      rail={
        <SessionOverview
          events={events}
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
          events={events}
          playback={playbackState}
          selectedEventId={selectedEvent?.id ?? null}
          stats={stats}
          viewMode={viewMode}
          onSelectEvent={setSelectedEventId}
        />
      }
      document={
        <SessionDocument
          events={events}
          playback={playbackState}
          stats={stats}
          viewMode={viewMode}
        />
      }
      inspector={
        <ConnectionPanel
          connection={connection}
          events={events}
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

function normalizeBackendEvent(
  rawEvent: unknown,
  index: number,
  sessionStartedAtRef: MutableRefObject<number | null>,
): RecallTimelineMoment | null {
  if (!rawEvent || typeof rawEvent !== "object") {
    return null;
  }

  const event = withParsedPayload(rawEvent as Record<string, unknown>);
  const timestamp = readTimestamp(event) ?? Date.now();

  if (!sessionStartedAtRef.current) {
    sessionStartedAtRef.current = timestamp;
  }

  const type = readEventType(event);
  const rawEventType = readRawEventType(event);

  const trackName = readStringDeep(event, [
    "track",
    "track_name",
    "trackName",
    "selected_track",
    "selectedTrack",
    "selected_track_name",
    "selectedTrackName",
    "payload.track",
    "payload.track_name",
    "payload.trackName",
    "payload.selected_track",
    "payload.selectedTrack",
    "payload.selected_track_name",
    "payload.selectedTrackName",
    "data.track",
    "data.track_name",
    "data.selected_track",
    "data.selected_track_name",
  ]);

  const deviceName = readStringDeep(event, [
    "device",
    "device_name",
    "deviceName",
    "plugin",
    "plugin_name",
    "pluginName",
    "payload.device",
    "payload.device_name",
    "payload.deviceName",
    "payload.plugin",
    "payload.plugin_name",
    "payload.pluginName",
    "data.device",
    "data.device_name",
    "data.plugin",
    "data.plugin_name",
  ]);

  const groupName = readStringDeep(event, [
    "group",
    "group_name",
    "groupName",
    "track_group",
    "trackGroup",
    "parent_group",
    "parentGroup",
    "payload.group",
    "payload.group_name",
    "payload.groupName",
    "payload.track_group",
    "payload.trackGroup",
    "payload.parent_group",
    "payload.parentGroup",
    "data.group",
    "data.group_name",
    "data.groupName",
    "data.track_group",
    "data.trackGroup",
    "data.parent_group",
    "data.parentGroup",
  ]);

  const groupPath = readStringArrayDeep(event, [
    "group_path",
    "groupPath",
    "track_group_path",
    "trackGroupPath",
    "payload.group_path",
    "payload.groupPath",
    "payload.track_group_path",
    "payload.trackGroupPath",
    "data.group_path",
    "data.groupPath",
    "data.track_group_path",
    "data.trackGroupPath",
  ]);

  const parameterName = readStringDeep(event, [
    "parameter",
    "parameter_name",
    "parameterName",
    "param",
    "param_name",
    "paramName",
    "payload.parameter",
    "payload.parameter_name",
    "payload.parameterName",
    "payload.param",
    "payload.param_name",
    "payload.paramName",
    "data.parameter",
    "data.parameter_name",
    "data.param",
    "data.param_name",
  ]);

  const clipName = readStringDeep(event, [
    "clip",
    "clip_name",
    "clipName",
    "payload.clip",
    "payload.clip_name",
    "payload.clipName",
    "payload.name",
    "data.clip",
    "data.clip_name",
  ]);

  const bpm = readNumberDeep(event, [
    "bpm",
    "tempo",
    "payload.bpm",
    "payload.tempo",
    "data.bpm",
    "data.tempo",
  ]);

  const previousBpm = readNumberDeep(event, [
    "previous_bpm",
    "previousBpm",
    "previous_tempo",
    "previousTempo",
    "payload.previous_bpm",
    "payload.previousBpm",
    "payload.previous_tempo",
    "payload.previousTempo",
    "data.previous_bpm",
    "data.previous_tempo",
  ]);

  const state = readStringDeep(event, [
    "state",
    "transport_state",
    "transportState",
    "play_state",
    "playState",
    "payload.state",
    "payload.transport_state",
    "payload.transportState",
    "payload.play_state",
    "payload.playState",
    "data.state",
    "data.transport_state",
    "data.play_state",
  ]);

  const songTime = readNumberDeep(event, [
    "current_song_time",
    "currentSongTime",
    "beat_time",
    "beatTime",
    "song_time_beats",
    "songTimeBeats",
    "payload.current_song_time",
    "payload.currentSongTime",
    "payload.beat_time",
    "payload.beatTime",
    "payload.song_time_beats",
    "payload.songTimeBeats",
    "data.current_song_time",
    "data.beat_time",
    "data.song_time_beats",
    "data.songTimeBeats",
  ]);

  const explicitProjectTimeSeconds = readNumberDeep(event, [
    "song_time_seconds",
    "songTimeSeconds",
    "project_time_seconds",
    "projectTimeSeconds",
    "time_seconds",
    "timeSeconds",
    "payload.song_time_seconds",
    "payload.songTimeSeconds",
    "payload.project_time_seconds",
    "payload.projectTimeSeconds",
    "payload.time_seconds",
    "payload.timeSeconds",
    "data.song_time_seconds",
    "data.songTimeSeconds",
    "data.project_time_seconds",
    "data.projectTimeSeconds",
  ]);

  const projectTimeSeconds =
    explicitProjectTimeSeconds ??
    (typeof songTime === "number"
      ? convertAbletonBeatsToSeconds(songTime, bpm)
      : undefined);

  const playing = readBooleanDeep(event, [
    "playing",
    "is_playing",
    "payload.playing",
    "payload.is_playing",
    "data.playing",
    "data.is_playing",
  ]);

  const source =
    readStringDeep(event, ["source", "payload.source", "data.source"]) ??
    "Max_for_Live";

  const id =
    readStringDeep(event, ["id", "event_id", "eventId"]) ??
    `${type}-${timestamp}-${index}`;

  return {
    id,
    type,
    rawEventType,
    timelineRole: readTimelineRole(rawEventType, type),
    rawEvent: event,
    timestamp,
    sessionTimecode: getSessionElapsedTime(
      timestamp,
      sessionStartedAtRef.current,
    ),
    summary: buildEventSummary({
      type,
      trackName,
      groupName,
      groupPath,
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
    }),
    detail: buildEventDetail({
      type,
      trackName,
      groupName,
      groupPath,
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
    }),
    trackName,
    groupName,
    groupPath,
    deviceName,
    source,
    metadata: buildMetadata(event, {
      trackName,
      groupName,
      groupPath,
      deviceName,
      parameterName,
      clipName,
      bpm,
      previousBpm,
      state,
      playing,
      songTime,
      projectTimeSeconds,
    }),
  };
}

function buildCreativeTimeline(
  events: RecallTimelineMoment[],
): RecallTimelineMoment[] {
  const output: RecallTimelineMoment[] = [];
  let previousPlaying: boolean | null = null;
  let previousTempo: number | null = null;
  let previousTrack: string | null = null;

  for (const event of events) {
    if (event.type === "heartbeat") {
      continue;
    }

    if (event.timelineRole === "context") {
      const playing = readMetadataBoolean(event, "playing");
      const tempo = readMetadataNumber(event, "bpm");
      const track = readMetadataString(event, "track");

      const playingChanged =
        typeof playing === "boolean" &&
        previousPlaying !== null &&
        playing !== previousPlaying;
      const tempoChanged =
        typeof tempo === "number" &&
        previousTempo !== null &&
        tempo !== previousTempo;
      const trackChanged = Boolean(track && previousTrack && track !== previousTrack);

      previousPlaying = typeof playing === "boolean" ? playing : previousPlaying;
      previousTempo = typeof tempo === "number" ? tempo : previousTempo;
      previousTrack = track ?? previousTrack;

      if (!playingChanged && !tempoChanged && !trackChanged) {
        continue;
      }
    }

    if (!isProducerTimelineEvent(event)) {
      continue;
    }

    output.push(event);

    const playing = readMetadataBoolean(event, "playing");
    const tempo = readMetadataNumber(event, "bpm");
    const track = readMetadataString(event, "track");

    if (typeof playing === "boolean") previousPlaying = playing;
    if (typeof tempo === "number") previousTempo = tempo;
    if (track) previousTrack = track;
  }

  return output;
}

function derivePlaybackState(events: RecallTimelineMoment[]): PlaybackState {
  return events.reduce<PlaybackState>((state, event) => {
    const playing = readMetadataBoolean(event, "playing");
    const tempo = readMetadataNumber(event, "bpm");
    const rawSongTime = readMetadataNumber(event, "songTime");
    const projectTimeSeconds = readMetadataNumber(event, "projectTimeSeconds");
    const selectedTrack = readMetadataString(event, "track");

    return {
      playing: typeof playing === "boolean" ? playing : state.playing,
      tempo: typeof tempo === "number" ? tempo : state.tempo,
      projectClock:
        typeof projectTimeSeconds === "number"
          ? formatProjectClock(projectTimeSeconds)
          : state.projectClock,
      arrangementPosition:
        typeof rawSongTime === "number"
          ? formatArrangementPosition(rawSongTime)
          : state.arrangementPosition,
      rawSongTime:
        typeof rawSongTime === "number" ? rawSongTime : state.rawSongTime,
      selectedTrack: selectedTrack ?? state.selectedTrack,
      lastUpdatedAt:
        event.type === "transport" || event.type === "tempo" || selectedTrack
          ? event.timestamp
          : state.lastUpdatedAt,
    };
  }, EMPTY_PLAYBACK_STATE);
}

function formatCaptureDuration(
  events: RecallTimelineMoment[],
  viewMode: SessionViewMode,
): string {
  if (events.length === 0) {
    return "0:00";
  }

  const timestamps = events
    .map((event) => event.timestamp)
    .filter((timestamp) => Number.isFinite(timestamp));
  const firstTimestamp = Math.min(...timestamps);
  const lastTimestamp =
    viewMode === "live" ? Date.now() : Math.max(...timestamps);

  if (!Number.isFinite(firstTimestamp) || !Number.isFinite(lastTimestamp)) {
    return "0:00";
  }

  return formatProjectClock((lastTimestamp - firstTimestamp) / 1000);
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

function readEventType(event: Record<string, unknown>): RecallEventType {
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

  if (
    rawType.includes("transport") ||
    rawType.includes("playback") ||
    rawType.includes("playing")
  ) {
    return "transport";
  }

  if (rawType.includes("tempo") || rawType.includes("bpm")) {
    return "tempo";
  }

  if (rawType.includes("scene_launched") || rawType.includes("scene launched")) {
    return "scene";
  }

  if (rawType.includes("clip")) {
    return "clip";
  }

  if (rawType.includes("group") || rawType.includes("track bus")) {
    return "group";
  }

  if (
    rawType.includes("selected_track") ||
    rawType.includes("track_selected") ||
    rawType.includes("track selected") ||
    rawType.includes("track focus") ||
    rawType.includes("track")
  ) {
    return "track";
  }

  if (
    rawType.includes("mixer") ||
    rawType.includes("volume") ||
    rawType.includes("pan") ||
    rawType.includes("send") ||
    rawType.includes("solo") ||
    rawType.includes("mute") ||
    rawType.includes("arm")
  ) {
    return "mixer";
  }

  if (
    rawType.includes("arrangement") ||
    rawType.includes("locator") ||
    rawType.includes("marker")
  ) {
    return "arrangement";
  }

  if (
    rawType.includes("device") ||
    rawType.includes("plugin") ||
    rawType.includes("serum") ||
    rawType.includes("operator") ||
    rawType.includes("wavetable")
  ) {
    return "device";
  }

  if (
    rawType.includes("parameter") ||
    rawType.includes("param") ||
    rawType.includes("automation") ||
    rawType.includes("cutoff") ||
    rawType.includes("macro")
  ) {
    return "parameter";
  }

  if (
    rawType.includes("file") ||
    rawType.includes(".als") ||
    rawType.includes("project")
  ) {
    return "file";
  }

  if (
    rawType.includes("live set") ||
    rawType.includes("liveset") ||
    rawType.includes("set snapshot") ||
    rawType.includes("session")
  ) {
    return "session";
  }

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

function formatArrangementPosition(songTime: number): string {
  const safeSongTime = Math.max(0, songTime);
  const beatsPerBar = 4;
  const bar = Math.floor(safeSongTime / beatsPerBar) + 1;
  const beat = Math.floor(safeSongTime % beatsPerBar) + 1;
  const subBeat = safeSongTime % 1;

  if (subBeat > 0.05) {
    return `Bar ${bar} Beat ${beat}.${Math.round(subBeat * 100)}`;
  }

  return `Bar ${bar} Beat ${beat}`;
}

function convertAbletonBeatsToSeconds(
  beats: number,
  bpm?: number,
): number {
  if (typeof bpm === "number" && bpm > 0) {
    return beats / (bpm / 60);
  }

  return beats;
}

function formatProjectClock(totalSeconds: number): string {
  const safeSeconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const seconds = safeSeconds % 60;

  if (hours > 0) {
    return `${hours}:${padTime(minutes)}:${padTime(seconds)}`;
  }

  return `${minutes}:${padTime(seconds)}`;
}

function padTime(value: number): string {
  return value.toString().padStart(2, "0");
}

function readMetadataNumber(
  event: RecallTimelineMoment,
  key: string,
): number | null {
  const value = event.metadata?.[key];
  return typeof value === "number" ? value : null;
}

function readMetadataString(
  event: RecallTimelineMoment,
  key: string,
): string | null {
  const value = event.metadata?.[key];
  return typeof value === "string" && value.trim() ? value : null;
}

function readMetadataBoolean(
  event: RecallTimelineMoment,
  key: string,
): boolean | null {
  const value = event.metadata?.[key];
  return typeof value === "boolean" ? value : null;
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
