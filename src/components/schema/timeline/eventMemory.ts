import type { SavedSessionEvent } from "../../../types/recall";
import { alsSetName } from "../../../features/sessionFormat";
import { captureEvidence, type CapturedEvidence } from "./captureEvidence";

export type ProducerMemoryCategory =
  | "song"
  | "recording"
  | "structure"
  | "sound"
  | "automation"
  | "mix"
  | "performance"
  | "project";

export type ProducerMemoryEvent = {
  id: string;
  eventType: string;
  atMs: number;
  trackId: string | null;
  trackName: string | null;
  title: string;
  summary: string;
  category: ProducerMemoryCategory;
  observedArrangementPosition: string | null;
  observedArrangementBeats: number | null;
  evidence: CapturedEvidence | null;
};

type Payload = Record<string, unknown>;
const ROOT_NOTES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

export const PRODUCER_MEMORY_EVENT_TYPES = new Set([
  "tempo_changed",
  "signature_changed",
  "time_signature_changed",
  "scale_changed",
  "key_changed",
  "recording_started",
  "recording_stopped",
  "clip_recording_started",
  "clip_recording_stopped",
  "track_created",
  "track_duplicated",
  "return_track_added",
  "track_deleted",
  "track_name_changed",
  "tracks_grouped",
  "track_ungrouped",
  "track_frozen",
  "track_flattened",
  "track_routing_changed",
  "device_added",
  "device_removed",
  "device_chain_changed",
  "device_toggled",
  "device_preset_changed",
  "macro_mapped",
  "macro_unmapped",
  "rack_variation_stored",
  "rack_variation_recalled",
  "rack_variation_deleted",
  "chain_added",
  "chain_removed",
  "chain_renamed",
  "drum_pad_renamed",
  "automation_deleted",
  "automation_envelope_changed",
  "automation_envelope_cleared",
  "scene_launched",
  "scene_created",
  "scene_renamed",
  "scene_deleted",
  "clip_launched",
  "clip_deleted",
  "clip_renamed",
  "clip_moved",
  "clip_duplicated",
  "clip_consolidated",
  "clip_cropped",
  "clip_loop_duplicated",
  "clip_gain_changed",
  "clip_pitch_changed",
  "clip_loop_changed",
  "clip_markers_changed",
  "warp_mode_changed",
  "warp_markers_changed",
  "audio_clip_changed",
  "clip_quantized",
  "notes_quantized",
  "quantize_applied",
  "capture_midi",
  "midi_captured",
  "take_comped",
  "groove_changed",
  "swing_changed",
  "crossfade_assignment_changed",
  "mix_energy_summary",
  "cue_point_added",
  "cue_point_renamed",
  "cue_point_moved",
  "cue_point_deleted",
  "project_saved",
]);

// These already have richer projections elsewhere. Rendering the raw row as
// well would turn one producer action into two timeline memories.
const PROJECTED_EVENT_TYPES = new Set([
  "parameter_changed",
  "device_parameter_changed",
  "automation_created",
  "automation_edited",
  "volume_changed",
  "pan_changed",
  "send_changed",
  "clip_notes_changed",
  "sample_added",
  "audio_clip_added",
  "midi_clip_created",
  "audio_clip_recorded",
  "midi_clip_recorded",
  "clip_created",
]);

// Useful for capture health or aggregate analysis, but not authorship. These
// must never become cards just because they happen frequently.
const TELEMETRY_EVENT_TYPES = new Set([
  "heartbeat",
  "bridge_started",
  "bridge_stopped",
  "transport_play",
  "transport_stop",
  "transport_snapshot",
  "transport_changed",
  "playback_state_changed",
  "beat_time_changed",
  "metronome_toggled",
  "track_selected",
  "selected_track_focus_snapshot",
  "focus_changed",
  "device_selected",
  "scene_changed",
  "track_list_changed",
  "live_set_snapshot",
  "session_snapshot",
  "set_snapshot",
  "track_muted",
  "track_unmuted",
  "track_soloed",
  "track_unsoloed",
  "track_armed",
  "track_unarmed",
]);

function payloadOf(event: SavedSessionEvent): Payload {
  if (!event.payload) return {};
  try {
    const parsed = JSON.parse(event.payload) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Payload : {};
  } catch {
    return {};
  }
}

function text(payload: Payload, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string" && value.trim() && value.trim() !== "0") return value.trim();
  }
  return null;
}

function number(payload: Payload, ...keys: string[]): number | null {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
}

function bool(payload: Payload, ...keys: string[]): boolean | null {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "boolean") return value;
    if (value === 0 || value === 1) return Boolean(value);
  }
  return null;
}

function array(payload: Payload, ...keys: string[]): unknown[] {
  for (const key of keys) {
    const value = payload[key];
    if (Array.isArray(value)) return value;
  }
  return [];
}

function cleanName(value: string | null | undefined, fallback: string): string {
  const clean = value?.trim();
  return clean && clean !== "0" ? clean : fallback;
}

function isAutomaticTrackNumberAdjustment(previous: string, current: string): boolean {
  const numberedName = /^\s*(\d+)([\s._-]+)(.+?)\s*$/u;
  const before = numberedName.exec(previous);
  const after = numberedName.exec(current);
  if (!before || !after) return false;

  return before[1] !== after[1]
    && before[2] === after[2]
    && before[3].trim().toLocaleLowerCase() === after[3].trim().toLocaleLowerCase();
}

function bpm(value: number | null): string | null {
  if (value === null) return null;
  return `${Number.isInteger(value) ? value : value.toFixed(1)} BPM`;
}

function beatPosition(value: number | null): string | null {
  if (value === null) return null;
  const display = Number.isInteger(value)
    ? String(value)
    : value.toFixed(2).replace(/0+$/u, "").replace(/\.$/u, "");
  return `beat ${display}`;
}

function transition(before: string | null, after: string | null): string {
  if (before && after && before !== after) return `${before} → ${after}`;
  return after ? `Set to ${after}` : before ?? "Changed";
}

function routeLabel(value: string | null): string | null {
  if (!value) return null;
  // Live routing channels can stringify to a transient Python object address.
  // That is observer bookkeeping, never a route a producer can verify.
  if (/^<[^>]+\sobject\sat\s0x[\da-f]+>$/iu.test(value)) return null;
  return value;
}

function routingPath(payload: Payload, direction: "input" | "output", previous = false): string | null {
  const prefix = previous ? "previous_" : "";
  return routeLabel(text(
    payload,
    `${prefix}${direction}_routing_channel`,
    `${prefix}${direction}_routing_type`,
    `${prefix}${direction}_routing`,
  ));
}

function routingChange(payload: Payload):
  | { direction: "input" | "output"; before: string; after: string }
  | null {
  for (const direction of ["output", "input"] as const) {
    const before = routingPath(payload, direction, true);
    const after = routingPath(payload, direction);
    if (before && after && before !== after) return { direction, before, after };
  }
  return null;
}

function memory(
  event: SavedSessionEvent,
  payload: Payload,
  category: ProducerMemoryCategory,
  title: string,
  summary: string,
): ProducerMemoryEvent {
  return {
    id: `event-memory-${event.id}`,
    eventType: event.type,
    atMs: event.timestamp_ms,
    trackId: text(payload, "track_id"),
    trackName: event.track ?? text(payload, "track_name"),
    title,
    summary,
    category,
    observedArrangementPosition: text(payload, "observed_arrangement_position", "arrangement_position", "cue_position"),
    observedArrangementBeats: number(payload, "observed_arrangement_beats", "arrangement_beats"),
    evidence: captureEvidence(event),
  };
}

/**
 * Turn one durable Live event into a producer-facing memory, or hide it.
 *
 * This is intentionally an allow-list. New telemetry stays invisible until we
 * can state what a producer learns from it. Forward-looking rows are included
 * for event names already catalogued by Recall so capture can grow without the
 * timeline falling back to raw engineering labels.
 */
export function producerMemoryEvent(event: SavedSessionEvent): ProducerMemoryEvent | null {
  if (event.is_heartbeat || PROJECTED_EVENT_TYPES.has(event.type) || TELEMETRY_EVENT_TYPES.has(event.type)) {
    return null;
  }

  const payload = payloadOf(event);
  const track = cleanName(event.track ?? text(payload, "track_name"), "Untitled track");
  const device = cleanName(event.device ?? text(payload, "device_name"), "Device");
  const clip = cleanName(event.clip_name ?? text(payload, "clip_name"), "Clip");

  switch (event.type) {
    case "tempo_changed": {
      const after = bpm(event.bpm ?? number(payload, "bpm", "tempo"));
      const before = bpm(number(payload, "previous_bpm", "previous_tempo"));
      return memory(event, payload, "song", "Tempo changed", transition(before, after));
    }
    case "signature_changed":
    case "time_signature_changed": {
      const numerator = number(payload, "signature_numerator", "numerator");
      const denominator = number(payload, "signature_denominator", "denominator");
      const signature = numerator && denominator ? `${numerator}/${denominator}` : null;
      return memory(event, payload, "song", "Time signature changed", signature ? `Set to ${signature}` : "Meter changed");
    }
    case "scale_changed":
    case "key_changed": {
      const rootNumber = number(payload, "root_note");
      const root = text(payload, "root_note_name") ?? (rootNumber === null ? null : ROOT_NOTES[((rootNumber % 12) + 12) % 12]);
      const scale = text(payload, "scale_name");
      return memory(event, payload, "song", "Key and scale changed", [root, scale].filter(Boolean).join(" ") || "Song scale changed");
    }
    case "recording_started":
    case "clip_recording_started":
      return memory(event, payload, "recording", "Recording started", event.track ? `Recording on ${track}` : "A recording pass began");
    case "recording_stopped":
    case "clip_recording_stopped":
      return memory(event, payload, "recording", "Recording stopped", event.track ? `Finished recording on ${track}` : "The recording pass ended");
    case "track_created":
      return memory(event, payload, "structure", "Track added", `Added ${track}`);
    case "track_duplicated":
      return memory(event, payload, "structure", "Track duplicated", `Duplicated ${track}`);
    case "return_track_added":
      return memory(event, payload, "structure", "Return added", `Added return ${track}`);
    case "track_deleted":
      return memory(event, payload, "structure", "Track removed", `Removed ${track}`);
    case "track_name_changed": {
      const previous = cleanName(text(payload, "previous_track_name"), "Untitled track");
      // Live rewrites numeric prefixes when a channel moves (10-Serum 2 becomes
      // 11-Serum 2). The current snapshot already updates the lane label; the
      // rewrite is bookkeeping, not a producer decision. This display guard
      // also cleans up captures recorded before the script-side filter existed.
      if (isAutomaticTrackNumberAdjustment(previous, track)) return null;
      return memory(event, payload, "structure", "Track renamed", `${previous} → ${track}`);
    }
    case "tracks_grouped": {
      const group = cleanName(text(payload, "group_track_name"), "a group");
      return memory(event, payload, "structure", "Track grouped", `Moved ${track} into ${group}`);
    }
    case "track_ungrouped":
      return memory(event, payload, "structure", "Track ungrouped", `Removed ${track} from its group`);
    case "track_frozen":
      return memory(event, payload, "structure", "Track frozen", `Froze ${track}`);
    case "track_flattened":
      return memory(event, payload, "structure", "Track flattened", `Committed ${track} to audio`);
    case "track_routing_changed": {
      const change = routingChange(payload);
      // A routing listener has no useful meaning unless it captured both ends
      // of the path. This hides delayed Live refresh snapshots already stored
      // in historical sessions instead of presenting them as user actions.
      if (!change) return null;
      if (change.direction === "input") {
        return memory(event, payload, "structure", "Input source updated", `${track} now listens to ${change.after} instead of ${change.before}`);
      }
      const action = change.after.toLocaleLowerCase() === "no output"
        ? "now has no output"
        : `now feeds ${change.after}`;
      return memory(event, payload, "structure", "Signal path updated", `${track} ${action} instead of ${change.before}`);
    }
    case "device_added":
      return memory(event, payload, "sound", "Device added", `Added ${device} to ${track}`);
    case "device_removed":
      return memory(event, payload, "sound", "Device removed", `Removed ${device} from ${track}`);
    case "device_chain_changed":
      return memory(event, payload, "sound", "Signal chain changed", `Changed the device chain on ${track}`);
    case "device_toggled": {
      const active = bool(payload, "is_active", "enabled");
      return memory(event, payload, "sound", active === false ? "Device bypassed" : "Device enabled", `${device} on ${track}`);
    }
    case "device_preset_changed": {
      const preset = cleanName(text(payload, "preset_name"), "a new preset");
      return memory(event, payload, "sound", "Preset changed", `${device}: ${preset}`);
    }
    case "macro_mapped": {
      const macro = cleanName(text(payload, "macro_name", "parameter_name"), "Macro");
      const target = cleanName(text(payload, "mapped_parameter_name", "target_name"), "a parameter");
      return memory(event, payload, "sound", "Macro mapped", `${macro} → ${target}`);
    }
    case "macro_unmapped":
      return memory(event, payload, "sound", "Macro unmapped", `Changed macro control on ${device}`);
    case "rack_variation_stored": {
      const count = number(payload, "variation_count");
      const variation = cleanName(text(payload, "variation_name"), count === null ? "Rack variation" : `Variation ${count}`);
      return memory(event, payload, "sound", "Rack variation stored", `${device}: ${variation}`);
    }
    case "rack_variation_recalled": {
      const index = number(payload, "selected_variation_index");
      const variation = cleanName(text(payload, "variation_name"), index === null ? "Rack variation" : `Variation ${index + 1}`);
      return memory(event, payload, "sound", "Rack variation recalled", `${device}: ${variation}`);
    }
    case "rack_variation_deleted":
      return memory(event, payload, "sound", "Rack variation removed", device);
    case "chain_added":
      return memory(event, payload, "sound", "Rack chain added", `${cleanName(text(payload, "chain_name"), "Chain")} on ${track}`);
    case "chain_removed":
      return memory(event, payload, "sound", "Rack chain removed", `${cleanName(text(payload, "chain_name"), "Chain")} on ${track}`);
    case "chain_renamed":
      return memory(event, payload, "sound", "Rack chain renamed", `${cleanName(text(payload, "previous_chain_name"), "Chain")} → ${cleanName(text(payload, "chain_name"), "Chain")}`);
    case "drum_pad_renamed":
      return memory(event, payload, "sound", "Drum pad named", cleanName(text(payload, "drum_pad_name", "pad_name"), "Drum pad"));
    case "automation_deleted":
    case "automation_envelope_cleared":
      return memory(event, payload, "automation", "Automation removed", `${device} · ${cleanName(event.parameter, "parameter")}`);
    case "automation_envelope_changed": {
      const points = array(payload, "automation_points", "envelope_points", "points").length;
      return memory(event, payload, "automation", "Automation shaped", points > 0 ? `${device} · ${cleanName(event.parameter, "parameter")} · ${points} points` : `${device} · ${cleanName(event.parameter, "parameter")}`);
    }
    case "scene_launched": {
      const sceneIndex = number(payload, "scene_index");
      const scene = cleanName(text(payload, "scene_name"), sceneIndex === null ? "Scene" : `Scene ${sceneIndex + 1}`);
      return memory(event, payload, "performance", "Scene launched", `Played ${scene}`);
    }
    case "scene_created": {
      const scene = cleanName(text(payload, "scene_name"), "Scene");
      return memory(event, payload, "structure", "Scene added", `Added ${scene}`);
    }
    case "scene_renamed":
      return memory(event, payload, "structure", "Scene renamed", `${cleanName(text(payload, "previous_scene_name"), "Scene")} → ${cleanName(text(payload, "scene_name"), "Scene")}`);
    case "scene_deleted":
      return memory(event, payload, "structure", "Scene removed", cleanName(text(payload, "scene_name", "name"), "Scene"));
    case "clip_launched":
      return memory(event, payload, "performance", "Clip launched", `Played ${clip} on ${track}`);
    case "clip_deleted":
      return memory(event, payload, "structure", "Clip removed", `Removed ${clip} from ${track}`);
    case "clip_renamed": {
      const previous = cleanName(text(payload, "previous_clip_name"), "Untitled clip");
      return memory(event, payload, "structure", "Clip renamed", `${previous} → ${clip}`);
    }
    case "clip_moved":
      return memory(event, payload, "structure", "Clip moved", `${clip} on ${track}`);
    case "clip_duplicated":
      return memory(event, payload, "structure", "Clip duplicated", `${clip} on ${track}`);
    case "clip_consolidated":
      return memory(event, payload, "structure", "Clips consolidated", `Committed a new clip on ${track}`);
    case "clip_cropped":
      return memory(event, payload, "structure", "Clip cropped", `${clip} on ${track}`);
    case "clip_loop_duplicated":
      return memory(event, payload, "structure", "Loop duplicated", `${clip} on ${track}`);
    case "clip_gain_changed": {
      const before = number(payload, "previous_gain");
      const after = number(payload, "gain");
      const beforeDisplay = text(payload, "previous_gain_display_string") ?? (before === null ? null : String(before));
      const afterDisplay = text(payload, "gain_display_string") ?? (after === null ? null : String(after));
      return memory(event, payload, "sound", "Clip gain changed", `${clip}: ${transition(beforeDisplay, afterDisplay)}`);
    }
    case "clip_pitch_changed": {
      const coarse = number(payload, "pitch_coarse");
      const fine = number(payload, "pitch_fine");
      const pitch = [coarse === null ? null : `${coarse} st`, fine === null ? null : `${fine} ct`].filter(Boolean).join(" · ");
      return memory(event, payload, "sound", "Clip pitch changed", `${clip}: ${pitch || "Pitch adjusted"}`);
    }
    case "clip_loop_changed":
      return memory(event, payload, "structure", "Clip loop changed", `${clip} on ${track}`);
    case "clip_markers_changed":
      return memory(event, payload, "structure", "Clip boundaries changed", `${clip} on ${track}`);
    case "warp_mode_changed": {
      const mode = cleanName(text(payload, "warp_mode_name", "warp_mode"), "a new warp mode");
      return memory(event, payload, "sound", "Warp mode changed", `${clip}: ${mode}`);
    }
    case "warp_markers_changed": {
      const markers = Array.isArray(payload.warp_markers) ? payload.warp_markers.length : null;
      return memory(event, payload, "sound", "Timing warped", markers === null ? clip : `${clip}: ${markers} warp markers`);
    }
    case "audio_clip_changed":
      return memory(event, payload, "sound", "Audio clip shaped", `${clip} on ${track}`);
    case "clip_quantized":
    case "notes_quantized":
    case "quantize_applied":
      return memory(event, payload, "structure", "Part quantized", `${clip} on ${track}`);
    case "capture_midi":
    case "midi_captured":
      return memory(event, payload, "performance", "Played MIDI captured", `${clip} on ${track}`);
    case "take_comped":
      return memory(event, payload, "recording", "Take comped", `Built a comp on ${track}`);
    case "groove_changed": {
      const groove = cleanName(text(payload, "groove_name", "name"), "Groove");
      const amount = number(payload, "groove_amount");
      return memory(event, payload, "song", "Groove changed", amount === null ? groove : `Amount set to ${amount}`);
    }
    case "swing_changed": {
      const amount = number(payload, "swing_amount");
      return memory(event, payload, "song", "Swing changed", amount === null ? "Song swing adjusted" : `Set to ${amount}`);
    }
    case "crossfade_assignment_changed": {
      const assignment = number(payload, "crossfade_assign");
      const label = assignment === 0 ? "A" : assignment === 1 ? "None" : assignment === 2 ? "B" : "Assignment changed";
      return memory(event, payload, "mix", "Crossfade assignment changed", `${track}: ${label}`);
    }
    case "mix_energy_summary": {
      const peak = number(payload, "peak_db");
      const average = number(payload, "average_db", "mean_db");
      const result = [average === null ? null : `${average} dB average`, peak === null ? null : `${peak} dB peak`].filter(Boolean).join(" · ");
      return memory(event, payload, "mix", "Mix energy", result || `Energy captured on ${track}`);
    }
    case "cue_point_added": {
      const cue = cleanName(text(payload, "cue_name", "name"), "Locator");
      const position = beatPosition(number(payload, "cue_time"));
      return memory(
        event,
        payload,
        "structure",
        `Song section added: ${cue}`,
        position ? `Marked at ${position}` : "Added to the arrangement",
      );
    }
    case "cue_point_renamed":
      return memory(event, payload, "structure", "Song section renamed", `${cleanName(text(payload, "previous_cue_name"), "Unnamed section")} → ${cleanName(text(payload, "cue_name", "name"), "Unnamed section")}`);
    case "cue_point_moved": {
      const cue = cleanName(text(payload, "cue_name", "name"), "Unnamed section");
      const before = beatPosition(number(payload, "previous_cue_time"));
      const after = beatPosition(number(payload, "cue_time"));
      return memory(
        event,
        payload,
        "structure",
        `Song section moved: ${cue}`,
        before || after ? transition(before, after) : "Position changed in the arrangement",
      );
    }
    case "cue_point_deleted": {
      const cue = cleanName(text(payload, "cue_name", "name"), "Unnamed section");
      const position = beatPosition(number(payload, "cue_time"));
      return memory(
        event,
        payload,
        "structure",
        `Song section removed: ${cue}`,
        position ? `Removed from ${position}` : "Removed from the arrangement",
      );
    }
    case "project_saved": {
      // The saved filename is the whole point of a save: it names the version
      // the producer can go back to. Falling straight through to "Live Set"
      // when the payload only carried a path made the row say nothing.
      const name = cleanName(
        text(payload, "set_name", "project_name") ?? alsSetName(text(payload, "file_path", "path")),
        "Live Set",
      );
      return memory(event, payload, "project", "Version saved", name);
    }
    default:
      return null;
  }
}

export function producerMemoryEvents(events: SavedSessionEvent[]): ProducerMemoryEvent[] {
  return events
    .map(producerMemoryEvent)
    .filter((event): event is ProducerMemoryEvent => event !== null)
    .sort((a, b) => a.atMs - b.atMs);
}
