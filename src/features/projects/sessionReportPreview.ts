import type {
  CreativeMoment,
  DeviceObj,
  NoteEdit,
  ParameterChange,
  ProjectSchema,
  TimelineClipEvent,
  TrackObj,
} from "../../types/schema";
import type { SavedSession, SavedSessionEvent, SavedSessionMetadata } from "../../types/recall";
import { buildSessionReport, type SessionReport, type SessionReportInput } from "./sessionReport";

export const REPORT_PREVIEW_SESSION_ID = "report-preview-current";
const BASELINE_PREVIEW_SESSION_ID = "report-preview-baseline";
const previewStart = new Date(2026, 7, 18, 21, 42).getTime();

function rawEvent(overrides: Partial<SavedSessionEvent> = {}): SavedSessionEvent {
  return {
    id: "preview-event",
    type: "focus_changed",
    timestamp_ms: previewStart,
    summary: null,
    title: "Focus changed",
    description: "Capture scope established",
    source: "control_surface",
    payload: JSON.stringify({ truncated_devices: [] }),
    session_id: REPORT_PREVIEW_SESSION_ID,
    track: null,
    track_type: null,
    device: null,
    device_chain: null,
    parameter: null,
    parameter_value: null,
    previous_parameter_value: null,
    parameter_value_percent: null,
    previous_parameter_value_percent: null,
    parameter_display_value: null,
    previous_parameter_display_value: null,
    parameter_is_quantized: null,
    clip_name: null,
    sample_name: null,
    file_path: null,
    bpm: null,
    playing: null,
    is_heartbeat: false,
    ...overrides,
  };
}

function device(id: string, trackId: string, name: string, chainIndex: number): DeviceObj {
  return {
    id,
    track_id: trackId,
    ableton_id: id,
    name,
    role: chainIndex === 0 ? "instrument" : "audio_effect",
    chain_index: chainIndex,
    enabled: true,
    initial_enabled: true,
    host_parameter_count: 16,
    class_name: name,
    preset_name: null,
    parameters: [],
  };
}

function track(id: string, number: number, name: string, type: TrackObj["type"], devices: string[]): TrackObj {
  return {
    id,
    ableton_id: id,
    name,
    number,
    type,
    color: null,
    group_id: null,
    chain_index: number - 1,
    devices: devices.map((name, index) => device(`${id}-device-${index}`, id, name, index)),
  };
}

function change(
  id: string,
  minute: number,
  trackId: string,
  trackName: string,
  deviceName: string,
  parameterName: string,
  beforeDisplay: string,
  afterDisplay: string,
): ParameterChange {
  return {
    id,
    event_type: parameterName === "Volume" ? "volume_changed" : "parameter_changed",
    parameter_id: `${trackId}:${deviceName}:${parameterName}`,
    track_name: trackName,
    track_id: trackId,
    device_name: deviceName,
    parameter_name: parameterName,
    before_value: null,
    after_value: null,
    before_value_percent: null,
    after_value_percent: null,
    unit: null,
    before_display_value: beforeDisplay,
    after_display_value: afterDisplay,
    is_quantized: false,
    reason: null,
    automation_start_ms: null,
    automation_start_position: null,
    automation_end_position: null,
    observed_arrangement_position: minute < 40 ? "Bar 17 · Beat 1" : "Bar 49 · Beat 1",
    changed_at_ms: previewStart + minute * 60_000,
  };
}

function note(id: string, minute: number, trackId: string, trackName: string, clipName: string, before: number, after: number): NoteEdit {
  return {
    id,
    track_name: trackName,
    track_id: trackId,
    clip_name: clipName,
    clip_id: `${trackId}:${clipName}`,
    change_kind: after > before ? "notes_added" : "notes_edited",
    note_count: after,
    previous_note_count: before,
    distinct_pitches: 7,
    pitch_min: 36,
    pitch_max: 55,
    previous_pitch_min: 36,
    previous_pitch_max: 48,
    pitch_range: "C1-G2",
    previous_pitch_range: "C1-C2",
    velocity_mean: 94,
    length_beats: 8,
    summary: `${after} notes (${after - before > 0 ? "+" : ""}${after - before}) · C1-G2`,
    observed_arrangement_position: "Bar 17 · Beat 1",
    changed_at_ms: previewStart + minute * 60_000,
  };
}

function clip(id: string, minute: number, trackId: string, trackName: string, name: string): TimelineClipEvent {
  return {
    id,
    event_type: "sample_added",
    track_name: trackName,
    track_id: trackId,
    clip_name: name,
    sample_name: name,
    observed_arrangement_position: "Bar 1 · Beat 1",
    changed_at_ms: previewStart + minute * 60_000,
  };
}

function moment(id: string, minute: number, title: string, noteText: string, trackId: string): CreativeMoment {
  return {
    id,
    session_id: REPORT_PREVIEW_SESSION_ID,
    title,
    type: "sound_design",
    timeline_start_ms: previewStart + minute * 60_000,
    timeline_end_ms: null,
    note: noteText,
    tags: ["preview"],
    confidence: "keeper",
    created_at_ms: previewStart + minute * 60_000,
    updated_at_ms: previewStart + minute * 60_000,
    targets: [{ target_type: "track", target_id: trackId }],
  };
}

const currentTracks = [
  track("drums", 1, "Drum Group", "group", ["Drum Rack", "Glue Compressor"]),
  track("bass", 2, "Bass Main", "midi", ["Serum", "Saturator", "EQ Eight"]),
  track("lead", 3, "Lead", "midi", ["Wavetable", "Echo"]),
  track("texture", 4, "Texture", "audio", ["Auto Filter", "Hybrid Reverb"]),
  track("master", 5, "Main", "master", ["Utility", "Limiter"]),
];

function schema(sessionId: string, tracks: TrackObj[]): ProjectSchema {
  return { session_id: sessionId, name: "Nightdrive", has_snapshot: true, tracks };
}

const currentChanges = [
  change("move-01", 4, "drums", "Drum Group", "Glue Compressor", "Threshold", "−8.2 dB", "−11.4 dB"),
  change("move-02", 7, "drums", "Drum Group", "Glue Compressor", "Threshold", "−11.4 dB", "−13.7 dB"),
  change("move-03", 11, "bass", "Bass Main", "Serum", "Cutoff", "18%", "31%"),
  change("move-04", 14, "bass", "Bass Main", "Serum", "Cutoff", "31%", "42%"),
  change("move-05", 21, "bass", "Bass Main", "Saturator", "Drive", "4.0 dB", "7.8 dB"),
  change("move-06", 36, "lead", "Lead", "Echo", "Dry/Wet", "0%", "17%"),
  change("move-07", 54, "texture", "Texture", "Auto Filter", "Frequency", "780 Hz", "2.1 kHz"),
  change("move-08", 61, "drums", "Drum Group", "Mixer", "Volume", "−2.1 dB", "−4.8 dB"),
  change("move-09", 64, "bass", "Bass Main", "Mixer", "Volume", "−5.0 dB", "−3.6 dB"),
  change("move-10", 68, "lead", "Lead", "Mixer", "Volume", "−7.3 dB", "−6.1 dB"),
];

const currentEvents = [
  rawEvent({ id: "focus", track: "Bass Main" }),
  rawEvent({ id: "track-added", type: "track_created", timestamp_ms: previewStart + 48 * 60_000, track: "Texture", title: "Track added", description: "Texture", payload: JSON.stringify({ track_id: "texture", track_name: "Texture" }) }),
  rawEvent({ id: "device-added", type: "device_added", timestamp_ms: previewStart + 20 * 60_000, track: "Bass Main", device: "Saturator", title: "Device added", description: "Saturator", payload: JSON.stringify({ track_id: "bass", device_name: "Saturator" }) }),
  rawEvent({ id: "section-moved", type: "cue_point_moved", timestamp_ms: previewStart + 42 * 60_000, title: "Song section moved", description: "Drop", payload: JSON.stringify({ cue_name: "Drop", previous_cue_time: 128, cue_time: 192 }) }),
  rawEvent({ id: "project-saved", type: "project_saved", timestamp_ms: previewStart + 72 * 60_000, title: "Project saved", description: "Nightdrive_v08.als", payload: JSON.stringify({ file_path: "C:\\Music\\Nightdrive\\Nightdrive_v08.als" }) }),
];

function savedSession(
  id: string,
  displayName: string,
  startedAt: number,
  events: SavedSessionEvent[],
  creativeCount: number,
): SavedSession {
  return {
    id,
    name: displayName,
    project_id: "preview-project",
    capture_name: null,
    capture_status: "ended",
    project_name: "Nightdrive",
    project_path: "C:\\Music\\Nightdrive",
    als_path: `C:\\Music\\Nightdrive\\${displayName}.als`,
    take_origin: "recorded",
    display_name: displayName,
    started_at_ms: startedAt,
    ended_at_ms: startedAt + 78 * 60_000,
    last_updated_at_ms: startedAt + 78 * 60_000,
    event_count: events.length + creativeCount,
    creative_event_count: creativeCount,
    heartbeat_count: 0,
    events,
  };
}

const currentInput: SessionReportInput = {
  session: savedSession(REPORT_PREVIEW_SESSION_ID, "Nightdrive_v08", previewStart, currentEvents, 19),
  schema: schema(REPORT_PREVIEW_SESSION_ID, currentTracks),
  changes: currentChanges,
  noteEdits: [
    note("midi-1", 8, "bass", "Bass Main", "Bass Hook", 8, 14),
    note("midi-2", 33, "lead", "Lead", "Lead Verse", 12, 18),
  ],
  clipEvents: [
    clip("clip-1", 2, "drums", "Drum Group", "kick_07.wav"),
    clip("clip-2", 49, "texture", "Texture", "warehouse_air.wav"),
  ],
  moments: [
    moment("moment-1", 17, "Keep the bass tone", "The low mids are right here.", "bass"),
    moment("moment-2", 58, "Texture belongs in the drop", "Keep it quiet until bar 49.", "texture"),
  ],
};

const baselineStart = previewStart - 24 * 60 * 60_000;
const baselineEvents = [rawEvent({ id: "baseline-focus", session_id: BASELINE_PREVIEW_SESSION_ID, timestamp_ms: baselineStart })];
const baselineInput: SessionReportInput = {
  session: savedSession(BASELINE_PREVIEW_SESSION_ID, "Nightdrive_v07", baselineStart, baselineEvents, 8),
  schema: schema(BASELINE_PREVIEW_SESSION_ID, currentTracks.filter((item) => item.id !== "texture")),
  changes: [
    { ...change("baseline-1", 7, "drums", "Drum Group", "Glue Compressor", "Threshold", "−8.2 dB", "−10.1 dB"), changed_at_ms: baselineStart + 7 * 60_000 },
    { ...change("baseline-2", 19, "bass", "Bass Main", "Serum", "Cutoff", "18%", "27%"), changed_at_ms: baselineStart + 19 * 60_000 },
    { ...change("baseline-3", 42, "lead", "Lead", "Echo", "Dry/Wet", "0%", "9%"), changed_at_ms: baselineStart + 42 * 60_000 },
  ],
  noteEdits: [{ ...note("baseline-midi", 13, "bass", "Bass Main", "Bass Hook", 4, 8), changed_at_ms: baselineStart + 13 * 60_000 }],
  clipEvents: [],
  moments: [],
};

export const reportPreviewSessions: SavedSessionMetadata[] = [
  baselineInput.session,
  currentInput.session,
];

export function isReportPreviewSession(sessionId: string): boolean {
  return sessionId === REPORT_PREVIEW_SESSION_ID || sessionId === BASELINE_PREVIEW_SESSION_ID;
}

export function buildReportPreview(sessionId: string): SessionReport {
  return buildSessionReport(sessionId === BASELINE_PREVIEW_SESSION_ID ? baselineInput : currentInput);
}
