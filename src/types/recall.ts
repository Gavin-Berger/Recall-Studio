export type ConnectionStatus = {
  connected: boolean;
  last_heartbeat_ms: number | null;
  last_message: string | null;
  bridge_version: string | null;
};

export type SessionStatus = {
  active: boolean;
  session_id: string | null;
  started_at_ms: number | null;
  ended_at_ms: number | null;
};

export type SavedSessionMetadata = {
  id: string;
  name: string;
  project_id: string | null;
  capture_name: string | null;
  capture_status: string;
  project_name: string | null;
  project_path: string | null;
  // The `.als` version this take is anchored to, and how it originated:
  // "recorded" (captured live) or "scanned" (a version found on disk, no moves yet).
  als_path: string | null;
  take_origin: string;
  display_name: string | null;
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
  track_type: string | null;
  device_id?: string | null;
  device: string | null;
  device_chain: string | null;
  parameter: string | null;
  parameter_value: number | null;
  previous_parameter_value: number | null;
  parameter_value_percent: number | null;
  previous_parameter_value_percent: number | null;
  // Live-formatted display: mode name for quantized params ("Sinefold"), or the
  // unit-bearing value for continuous ones ("440 Hz"). parameter_is_quantized
  // distinguishes the two so categorical modes and numeric values render differently.
  parameter_display_value: string | null;
  previous_parameter_display_value: string | null;
  parameter_is_quantized: boolean | null;
  clip_name: string | null;
  sample_name: string | null;
  file_path: string | null;
  bpm: number | null;
  playing: boolean | null;
  is_heartbeat: boolean;
};

export type SavedSession = SavedSessionMetadata & {
  events: SavedSessionEvent[];
};

export type SavedProject = {
  id: string;
  display_name: string;
  ableton_name: string | null;
  ableton_path: string | null;
  archived_at_ms: number | null;
  created_at_ms: number;
  updated_at_ms: number;
  last_updated_at_ms: number;
  capture_count: number;
  active_capture_count: number;
  captures: SavedSessionMetadata[];
  folder_metadata?: ProjectFolderMetadata | null;
};

export type ProjectFolderMetadata = {
  created_at_ms: number | null;
  modified_at_ms: number | null;
  latest_file_modified_at_ms: number | null;
  file_count: number;
  total_size_bytes: number;
  als_file_count: number;
  audio_file_count: number;
  scanned_at_ms: number;
};

