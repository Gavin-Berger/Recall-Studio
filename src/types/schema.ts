// Normalized Recall Studio schema — the frontend mirror of the Rust structs in
// `src-tauri/src/schema_projection.rs`. Field names are snake_case to match the
// serde JSON that the Tauri commands return verbatim (no camel conversion happens
// on return values, only on command arguments).
//
// This is the schema-driven model the timeline renders: Project → Track → Device →
// Parameter, plus the user-authored creative-memory layer (CreativeMoment,
// ParameterChange). No plugin names are baked in anywhere — devices are
// differentiated only by `role`.

export type TrackType = "midi" | "audio" | "return" | "group" | "master";

export type DeviceRole = "instrument" | "midi_effect" | "audio_effect";

export type ReturnPurpose =
  | "reverb"
  | "delay"
  | "parallel"
  | "distortion"
  | "utility"
  | "custom";

export type MomentType =
  | "sound_design"
  | "arrangement"
  | "mix_move"
  | "automation"
  | "routing"
  | "happy_accident"
  | "idea_to_revisit";

export type Confidence = "rough" | "working" | "keeper" | "final";

export type ParameterObj = {
  id: string;
  device_id: string;
  parent_parameter_id: string | null;
  name: string | null;
  value: number | null;
  unit: string | null;
  min: number | null;
  max: number | null;
  normalized_value: number | null;
  children: ParameterObj[];
};

export type DeviceObj = {
  id: string;
  track_id: string;
  ableton_id: string | null;
  name: string | null;
  role: DeviceRole;
  chain_index: number;
  enabled: boolean;
  parameters: ParameterObj[];
};

export type TrackObj = {
  id: string;
  ableton_id: string | null;
  name: string | null;
  number: number;
  type: TrackType;
  color: string | null;
  group_id: string | null;
  chain_index: number;
  devices: DeviceObj[];
};

export type ProjectSchema = {
  session_id: string;
  name: string;
  has_snapshot: boolean;
  tracks: TrackObj[];
};

export type ParameterChange = {
  id: string;
  parameter_id: string | null;
  track_name: string | null;
  device_name: string | null;
  parameter_name: string | null;
  before_value: number | null;
  after_value: number | null;
  before_value_percent: number | null;
  after_value_percent: number | null;
  unit: string | null;
  // Live-formatted display: mode name for quantized params ("Sinefold"), or the
  // unit-bearing value for continuous ones ("440 Hz"). is_quantized distinguishes
  // a categorical mode from a numeric value so they can render differently.
  before_display_value: string | null;
  after_display_value: string | null;
  is_quantized: boolean | null;
  reason: string | null;
  changed_at_ms: number;
};

export type CreativeMomentTarget = {
  target_type: "track" | "device" | "parameter" | "parameter_change" | "clip";
  target_id: string;
};

export type CreativeMoment = {
  id: string;
  session_id: string;
  title: string;
  type: MomentType;
  timeline_start_ms: number | null;
  timeline_end_ms: number | null;
  note: string | null;
  tags: string[];
  confidence: Confidence;
  created_at_ms: number;
  updated_at_ms: number;
  targets: CreativeMomentTarget[];
};

// ── Display helpers (labels for the producer-facing UI) ───────────────────────

export const TRACK_TYPE_LABEL: Record<TrackType, string> = {
  midi: "MIDI",
  audio: "Audio",
  return: "Return",
  group: "Group",
  master: "Main",
};

export const DEVICE_ROLE_LABEL: Record<DeviceRole, string> = {
  instrument: "Instrument",
  midi_effect: "MIDI FX",
  audio_effect: "Audio FX",
};

export const MOMENT_TYPE_LABEL: Record<MomentType, string> = {
  sound_design: "Sound design",
  arrangement: "Arrangement",
  mix_move: "Mix move",
  automation: "Automation",
  routing: "Routing",
  happy_accident: "Happy accident",
  idea_to_revisit: "Idea to revisit",
};

// Order matters: rough → working → keeper → final is the producer's confidence ramp.
export const CONFIDENCE_ORDER: Confidence[] = [
  "rough",
  "working",
  "keeper",
  "final",
];

export const CONFIDENCE_LABEL: Record<Confidence, string> = {
  rough: "Rough",
  working: "Working",
  keeper: "Keeper",
  final: "Final",
};
