export type ConnectionStatus = {
  connected: boolean;
  last_heartbeat_ms: number | null;
  last_message: string | null;
};

export type RecallEventType =
  | "heartbeat"
  | "transport"
  | "tempo"
  | "track"
  | "group"
  | "device"
  | "parameter"
  | "clip"
  | "scene"
  | "mixer"
  | "arrangement"
  | "session"
  | "file"
  | "creative_moment"
  | "unknown";

export type RecallMetadataValue =
  | string
  | number
  | boolean
  | null
  | string[];

export type RecallTimelineMoment = {
  id: string;
  type: RecallEventType;
  rawEventType?: string;
  timelineRole?: "creative" | "transport" | "context" | "debug";
  rawEvent?: unknown;
  timestamp: number;
  sessionTimecode: string;
  summary: string;
  detail?: string;
  trackName?: string;
  groupName?: string;
  groupPath?: string[];
  deviceName?: string;
  source?: string;
  metadata?: Record<string, RecallMetadataValue>;
};

export type PlaybackState = {
  playing: boolean | null;
  tempo: number | null;
  projectClock: string | null;
  arrangementPosition: string | null;
  rawSongTime: number | null;
  selectedTrack: string | null;
  lastUpdatedAt: number | null;
};

export type SavedSessionMetadata = {
  id: string;
  name: string;
  started_at_ms: number;
  ended_at_ms: number | null;
  last_updated_at_ms: number;
  event_count: number;
  creative_event_count: number;
  heartbeat_count: number;
};

export type SavedSessionEvent = {
  id: string;
  type: string;
  timestamp_ms: number;
  summary: string | null;
  title: string;
  description: string;
  source: string;
  payload: string | null;
  session_id: string | null;
  track: string | null;
  device: string | null;
  parameter: string | null;
  is_heartbeat: boolean;
};

export type SavedSession = SavedSessionMetadata & {
  events: SavedSessionEvent[];
};

export type SessionViewMode = "live" | "saved";

export type SessionStats = {
  totalEvents: number;
  creativeEvents: number;
  transportEvents: number;
  tempoEvents: number;
  trackEvents: number;
  deviceEvents: number;
  parameterEvents: number;
  heartbeatEvents: number;
};
