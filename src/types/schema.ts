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
  display_value: string | null;
  initial_value: number | null;
  initial_display_value: string | null;
  default_value: number | null;
  unit: string | null;
  min: number | null;
  max: number | null;
  normalized_value: number | null;
  is_quantized: boolean | null;
  value_items: string[];
  automation_state: number | null;
  state: number | null;
  is_enabled: boolean | null;
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
  initial_enabled: boolean;
  host_parameter_count: number;
  class_name: string | null;
  preset_name: string | null;
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
  // The capture intent that created this row. Automation gets a distinct
  // timeline treatment instead of reading as an ordinary knob move.
  event_type: string;
  parameter_id: string | null;
  track_name: string | null;
  // Live's stable per-track pointer. Two changes can share track_name (Ableton
  // auto-names a track after its first device, e.g. two separate "Serum 2"
  // tracks) but never this — prefer it for grouping/identity. Null for changes
  // captured before the bridge sent it.
  track_id: string | null;
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
  // Present only for a live automation write captured against Live's musical
  // ruler. These are transport observations during the producer's action, not
  // Arrangement-envelope breakpoints or an inferred constant/ramp span.
  automation_start_ms: number | null;
  automation_start_position: string | null;
  automation_end_position: string | null;
  observed_arrangement_position?: string | null;
  observed_arrangement_beats?: number | null;
  changed_at_ms: number;
};

// A settled edit to the notes in a MIDI clip. Read straight from the event log
// rather than a projection table — the bridge coalesces note edits before
// sending, so one event already means one edit.
export type NoteChangeKind =
  | "notes_added"
  | "notes_removed"
  | "notes_edited"
  | "cleared"
  | "edited";

// Producer-facing wording for each kind of note change. "Rewritten" rather than
// "edited" for a same-count change: the count held but the part did not, which
// is what transposing or re-timing a phrase looks like from here.
export const NOTE_KIND_LABEL: Record<NoteChangeKind, string> = {
  notes_added: "added",
  notes_removed: "removed",
  notes_edited: "rewritten",
  cleared: "cleared",
  edited: "edited",
};

export type NoteEdit = {
  id: string;
  track_name: string | null;
  track_id: string | null;
  clip_name: string | null;
  // Live's clip pointer — the only reliable way to tell two clips apart, since
  // clip names are often blank.
  clip_id: string | null;
  change_kind: NoteChangeKind | null;
  note_count: number | null;
  previous_note_count: number | null;
  distinct_pitches: number | null;
  // Raw MIDI numbers, for drawing the pitch bar. pitch_range is the label.
  pitch_min: number | null;
  pitch_max: number | null;
  previous_pitch_min: number | null;
  previous_pitch_max: number | null;
  // Pitch range in Live's naming ("C1-G2"), pre-rendered by the bridge.
  pitch_range: string | null;
  previous_pitch_range: string | null;
  velocity_mean: number | null;
  length_beats: number | null;
  summary: string | null;
  observed_arrangement_position?: string | null;
  observed_arrangement_beats?: number | null;
  arrangement_start_beats?: number | null;
  arrangement_end_beats?: number | null;
  changed_at_ms: number;
};

export type TimelineClipEvent = {
  id: string;
  event_type:
    | "sample_added"
    | "audio_clip_added"
    | "midi_clip_created"
    | "audio_clip_recorded"
    | "midi_clip_recorded"
    | "clip_created";
  track_name: string | null;
  track_id: string | null;
  clip_name: string | null;
  sample_name: string | null;
  observed_arrangement_position?: string | null;
  observed_arrangement_beats?: number | null;
  arrangement_start_beats?: number | null;
  arrangement_end_beats?: number | null;
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

