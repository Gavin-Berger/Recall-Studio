import { useEffect, useMemo, useRef, useState } from "react";
import type { MutableRefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./App.css";

import { AppShell } from "./components/AppShell";
import { ConnectionPanel } from "./components/ConnectionPanel";
import { SessionOverview } from "./components/SessionOverview";
import { SessionTimeline } from "./components/SessionTimeline";
import { TopSystemBar } from "./components/TopSystemBar";
import type {
  ConnectionStatus,
  RecallEventType,
  RecallTimelineMoment,
  SavedSession,
  SavedSessionMetadata,
  SessionStats,
  SessionViewMode,
} from "./types/recall";
import { getSessionElapsedTime } from "./utils/timecode";

const BACKEND_CONNECTION_COMMAND = "get_connection_status";
const BACKEND_EVENTS_COMMAND = "get_recent_events";
const BACKEND_LIST_SESSIONS_COMMAND = "list_saved_sessions";
const BACKEND_LOAD_SESSION_COMMAND = "load_session_events";
const BACKEND_START_NEW_SESSION_COMMAND = "start_new_session";

const POLL_INTERVAL_MS = 1000;

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

  const events = viewMode === "live" ? liveEvents : savedEvents;

  const latestEvent = useMemo(() => {
    return [...events].reverse().find((event) => event.type !== "heartbeat");
  }, [events]);

  const stats = useMemo<SessionStats>(() => {
    return {
      totalEvents: events.length,
      creativeEvents: events.filter((event) => event.type !== "heartbeat")
        .length,
      transportEvents: events.filter((event) => event.type === "transport")
        .length,
      tempoEvents: events.filter((event) => event.type === "tempo").length,
      trackEvents: events.filter((event) => event.type === "track").length,
      deviceEvents: events.filter((event) => event.type === "device").length,
      parameterEvents: events.filter((event) => event.type === "parameter")
        .length,
      heartbeatEvents: events.filter((event) => event.type === "heartbeat")
        .length,
    };
  }, [events]);

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
      setViewMode("saved");
    } catch (error) {
      console.error("Failed to load saved session:", error);
    }
  }

  function handleSelectLiveSession() {
    setViewMode("live");
    setSelectedSessionId(null);
  }

  async function handleStartNewSession() {
    try {
      await invoke(BACKEND_START_NEW_SESSION_COMMAND);
      liveSessionStartedAtRef.current = null;
      setLiveEvents([]);
      setSavedEvents([]);
      setSelectedSessionId(null);
      setViewMode("live");

      const sessions = await invoke<SavedSessionMetadata[]>(
        BACKEND_LIST_SESSIONS_COMMAND,
      );
      setSavedSessions(sessions);
    } catch (error) {
      console.error("Failed to start a new session:", error);
    }
  }

  return (
    <AppShell
      topBar={
        <TopSystemBar
          connection={connection}
          eventCount={stats.creativeEvents}
        />
      }
      overview={
        <SessionOverview
          events={events}
          stats={stats}
          sessions={savedSessions}
          selectedSessionId={selectedSessionId}
          viewMode={viewMode}
          onSelectLiveSession={handleSelectLiveSession}
          onSelectSavedSession={handleSelectSavedSession}
          onStartNewSession={handleStartNewSession}
        />
      }
      timeline={<SessionTimeline events={events} viewMode={viewMode} />}
      connection={
        <ConnectionPanel
          connection={connection}
          latestEvent={latestEvent}
          heartbeatCount={stats.heartbeatEvents}
        />
      }
      footer={
        <footer className="session-summary-strip">
          <div>
            <p className="eyebrow">Next Memory Layer</p>
            <strong>AI-assisted session summary</strong>
          </div>

          <span>
            Recall Studio is building a timecoded history of the session from
            real Ableton telemetry. Once event capture is stable, this area can
            summarize creative decisions, track focus, tempo movement, device
            changes, and session structure.
          </span>
        </footer>
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

  const bpm = readNumberDeep(event, [
    "bpm",
    "tempo",
    "payload.bpm",
    "payload.tempo",
    "data.bpm",
    "data.tempo",
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

  const source =
    readStringDeep(event, ["source", "payload.source", "data.source"]) ??
    "Max_for_Live";

  const id =
    readStringDeep(event, ["id", "event_id", "eventId"]) ??
    `${type}-${timestamp}-${index}`;

  return {
    id,
    type,
    timestamp,
    sessionTimecode: getSessionElapsedTime(
      timestamp,
      sessionStartedAtRef.current,
    ),
    summary: buildEventSummary({
      type,
      trackName,
      deviceName,
      parameterName,
      bpm,
      state,
      event,
    }),
    detail: buildEventDetail({
      type,
      trackName,
      deviceName,
      parameterName,
      bpm,
      state,
    }),
    trackName,
    deviceName,
    source,
    metadata: buildMetadata(event, {
      trackName,
      deviceName,
      parameterName,
      bpm,
      state,
    }),
  };
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
    rawType.includes("cutoff") ||
    rawType.includes("macro")
  ) {
    return "parameter";
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
  deviceName?: string;
  parameterName?: string;
  bpm?: number;
  state?: string;
  event: Record<string, unknown>;
}): string {
  const { type, trackName, deviceName, parameterName, bpm, state, event } =
    input;

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

  const normalizedTitle = rawTitle.toLowerCase();

  if (normalizedTitle.includes("selected track focus snapshot")) {
    if (trackName) {
      return `${trackName} track was selected.`;
    }

    return "Selected track focus was captured.";
  }

  if (normalizedTitle.includes("track selected")) {
    if (trackName) {
      return `${trackName} track was selected.`;
    }

    return "Track selection changed.";
  }

  if (normalizedTitle.includes("tempo changed")) {
    if (typeof bpm === "number") {
      return `Tempo changed to ${bpm} BPM.`;
    }

    return "Tempo changed.";
  }

  if (normalizedTitle.includes("transport snapshot")) {
    if (state) {
      return `Transport snapshot captured while playback was ${state}.`;
    }

    return "Transport state snapshot captured.";
  }

  if (normalizedTitle.includes("live set snapshot")) {
    return "Live set structure snapshot captured.";
  }

  switch (type) {
    case "heartbeat":
      return "Heartbeat received from Max for Live.";

    case "transport":
      if (state) {
        return `Transport changed to ${state}.`;
      }

      return "Transport state changed.";

    case "tempo":
      if (typeof bpm === "number") {
        return `Tempo changed to ${bpm} BPM.`;
      }

      return "Tempo changed.";

    case "track":
      if (trackName) {
        return `${trackName} track was selected.`;
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
      if (deviceName && trackName && parameterName) {
        return `${parameterName} was edited on ${deviceName} in ${trackName}.`;
      }

      if (deviceName && trackName) {
        return `${deviceName} was edited on ${trackName}.`;
      }

      if (parameterName) {
        return `${parameterName} was edited.`;
      }

      return "Parameter movement was captured.";

    case "session":
      return "Session structure snapshot captured.";

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
  deviceName?: string;
  parameterName?: string;
  bpm?: number;
  state?: string;
}): string | undefined {
  const { type, trackName, deviceName, parameterName, bpm, state } = input;

  if (type === "track" && trackName) {
    return "Producer focus changed inside Ableton.";
  }

  if (type === "device" && deviceName && trackName) {
    return `${deviceName} activity was captured on ${trackName}.`;
  }

  if (type === "device" && deviceName) {
    return "Device-level session activity was captured from Ableton.";
  }

  if (type === "parameter" && parameterName) {
    return "A device or track control was adjusted during the session.";
  }

  if (type === "tempo" && typeof bpm === "number") {
    return "Tempo movement was captured as part of the session timeline.";
  }

  if (type === "transport" && state) {
    return "Playback state changed inside Ableton.";
  }

  if (type === "session") {
    return "Recall Studio captured the current Live Set structure.";
  }

  return undefined;
}

function buildMetadata(
  event: Record<string, unknown>,
  known: {
    trackName?: string;
    deviceName?: string;
    parameterName?: string;
    bpm?: number;
    state?: string;
  },
): Record<string, string | number | boolean | null> {
  const metadata: Record<string, string | number | boolean | null> = {};

  if (known.state) metadata.state = known.state;
  if (typeof known.bpm === "number") metadata.bpm = known.bpm;
  if (known.trackName) metadata.track = known.trackName;
  if (known.deviceName) metadata.device = known.deviceName;
  if (known.parameterName) metadata.parameter = known.parameterName;

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
