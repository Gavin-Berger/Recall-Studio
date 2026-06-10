import type { RecallEventType } from "../../types/recall";

// Canonical lookup map: exact bridge/Rust `event_type` strings → frontend
// RecallEventType category. This is the frontend half of the event vocabulary
// contract; the backend half is `src-tauri/src/event_catalog.rs`. Keep the two in
// step — every creative event the catalog can emit should map to a real category
// here, never fall through to "unknown".
//
// No string inference: if an event_type isn't listed, canonicalEventType returns
// "unknown" and the caller falls back to legacy heuristics. The whole point of
// this table is that the mapping is explicit and unit-testable (see
// eventTypeMap.test.ts), so the vocabulary can't silently drift again.
export const EVENT_TYPE_MAP: Record<string, RecallEventType> = {
  // ── Transport (hidden from the curated timeline; analytics only) ──────────
  transport_play: "transport",
  transport_stop: "transport",
  transport_changed: "transport",
  transport_snapshot: "transport",
  playback_state_changed: "transport",
  beat_time_changed: "transport",
  recording_state_changed: "transport",
  metronome_toggled: "transport",
  loop_toggled: "transport",

  // ── Tempo ─────────────────────────────────────────────────────────────────
  tempo_changed: "tempo",

  // ── Tracks ──────────────────────────────────────────────────────────────
  track_selected: "track",
  track_created: "track",
  track_deleted: "track",
  track_name_changed: "track",
  track_duplicated: "track",
  track_muted: "track",
  track_unmuted: "track",
  track_soloed: "track",
  track_unsoloed: "track",
  track_armed: "track",
  track_unarmed: "track",
  track_frozen: "track",
  track_flattened: "track",
  return_track_added: "track",
  track_event: "track",

  // ── Groups & routing ──────────────────────────────────────────────────────
  group_focused: "group",
  tracks_grouped: "group",
  track_ungrouped: "group",
  track_routing_changed: "mixer",

  // ── Devices: instruments & effects ──────────────────────────────────────
  device_added: "device",
  device_removed: "device",
  device_chain_changed: "device",
  device_toggled: "device",
  device_preset_changed: "device",
  macro_mapped: "device",
  device_event: "device",
  device_selected: "device",

  // ── Parameters & automation ─────────────────────────────────────────────
  device_parameter_changed: "parameter",
  parameter_changed: "parameter",
  automation_created: "parameter",
  automation_edited: "parameter",
  automation_deleted: "parameter",

  // ── Clips & samples ─────────────────────────────────────────────────────
  clip_created: "clip",
  clip_launched: "clip",
  clip_stopped: "clip",
  clip_deleted: "clip",
  clip_renamed: "clip",
  clip_moved: "clip",
  clip_duplicated: "clip",
  clip_event: "clip",
  clip_recording_started: "clip",
  clip_recording_stopped: "clip",
  warp_mode_changed: "clip",
  clip_consolidated: "clip",
  sample_added: "clip",
  audio_clip_added: "clip",
  midi_clip_created: "clip",

  // ── Scenes ────────────────────────────────────────────────────────────────
  scene_launched: "scene",
  scene_changed: "scene",
  scene_created: "scene",
  scene_renamed: "scene",
  follow_action_fired: "scene",

  // ── Mixing (context — folded into analytics, not individual moments) ───────
  volume_changed: "mixer",
  pan_changed: "mixer",
  send_changed: "mixer",
  crossfader_changed: "mixer",

  // ── Arrangement ─────────────────────────────────────────────────────────
  locator_added: "arrangement",
  arrangement_section_changed: "arrangement",

  // ── Session / project ─────────────────────────────────────────────────────
  live_set_snapshot: "session",
  session_snapshot: "session",
  session_snapshot_started: "session",
  session_snapshot_completed: "session",
  project_file_changed: "file",
  project_saved: "file",
  creative_decision: "creative_moment",

  // ── System / lifecycle (hidden — connection health, not creative) ─────────
  heartbeat: "heartbeat",
  device_loaded: "heartbeat",
  bridge_started: "heartbeat",
  bridge_stopped: "heartbeat",
};

// Resolve a raw event_type string to its frontend category. Tries the exact
// string first, then a lowercased form, then "unknown".
export function canonicalEventType(
  rawEventType: string | undefined,
): RecallEventType {
  if (!rawEventType) return "unknown";
  return (
    EVENT_TYPE_MAP[rawEventType] ??
    EVENT_TYPE_MAP[rawEventType.toLowerCase()] ??
    "unknown"
  );
}
