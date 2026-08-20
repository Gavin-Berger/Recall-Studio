// Shared types and constants for the schema timeline surface. Kept apart from the
// component so the data helpers, share/export, and presentational parts can all
// agree on one shape without importing the big component file.

import type { NoteChangeKind } from "../../../types/schema";
import type { ProducerMemoryCategory } from "./eventMemory";
import type { CapturedEvidence } from "./captureEvidence";

export type LoadStatus = "idle" | "loading" | "ready" | "error";
export type ExportFormat = "md" | "txt" | "json" | "pdf";

// A contiguous stretch of work on one track — the unit the timeline summarizes
// activity in, replacing the per-move "Worth Keeping" rail. Producers work in
// sections ("I was on the lead for a while"), not isolated knob tweaks.
export type SessionBlock = {
  id: string;
  trackId: string | null;
  trackName: string | null;
  startMs: number;
  endMs: number;
  moveCount: number;
  // Devices touched in the block, most-active first.
  devices: string[];
  // The parameters ridden most in the block, capped for display.
  topParams: { name: string; count: number }[];
};

// A pause longer than this ends the current block and starts a new one, even on
// the same track. Two minutes: long enough that stepping away and coming back
// reads as a new stretch of work, short enough not to merge unrelated sessions
// on one track into a single block.
export const BLOCK_GAP_MS = 120_000;

export const LIVE_REFRESH_DEBOUNCE_MS = 700;
// Backstop for a live session when event pushes go missing (a suspended webview
// drops them silently). Deliberately slow: pushes drive normal updates, and this
// only bounds how long a miss can persist. Every tick rematerializes the schema,
// so tightening it puts real work on the backend for no gain.
export const LIVE_SAFETY_POLL_MS = 15_000;
export const LIVE_REFRESH_EVENT_TYPES = new Set([
  "parameter_changed",
  "clip_notes_changed",
  "sample_added",
  "audio_clip_added",
  "midi_clip_created",
  "audio_clip_recorded",
  "midi_clip_recorded",
  "volume_changed",
  "pan_changed",
  "send_changed",
  "clip_deleted",
  "device_parameter_changed",
  "automation_created",
  "automation_edited",
  "selected_track_focus_snapshot",
  "live_set_snapshot",
  "device_added",
  "device_removed",
  "device_chain_changed",
  "device_toggled",
  "device_preset_changed",
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
  "track_deleted",
  "track_name_changed",
  "tracks_grouped",
  "track_ungrouped",
  "return_track_added",
  "track_frozen",
  "track_flattened",
  "track_routing_changed",
  "automation_deleted",
  "scene_launched",
  "clip_launched",
  "clip_renamed",
  "clip_moved",
  "clip_duplicated",
  "clip_consolidated",
  "clip_quantized",
  "notes_quantized",
  "quantize_applied",
  "capture_midi",
  "midi_captured",
  "warp_mode_changed",
  "project_saved",
]);

export type LiveRecallEvent = {
  session_id?: string | null;
  event_type?: string | null;
  // Which capture tier sent it: "max_for_live" or "control_surface". Shown in the
  // bridge log so the two can be told apart while both exist.
  source?: string | null;
  timestamp_ms?: number | null;
};

// How many recent events the bridge log keeps. Small on purpose: it answers
// "is anything arriving, and from where", not "what happened this session" —
// the timeline itself is the record.
export const BRIDGE_LOG_LIMIT = 20;

// One thing that happened on a track this take — a knob move, a note the
// producer wrote, or an edit to the MIDI in a clip.
//
// "note" and "noteEdit" are different things and the names are load-bearing:
// a `note` is an annotation the producer typed, a `noteEdit` is MIDI notes
// changing inside a clip.
export type Activity = {
  id: string;
  kind: "move" | "note" | "noteEdit" | "clip" | "memory";
  trackId: string;
  atMs: number;
  // move
  deviceName?: string | null;
  paramName?: string | null;
  before?: number | null;
  after?: number | null;
  beforePercent?: number | null;
  afterPercent?: number | null;
  unit?: string | null;
  // Live-formatted display: mode name for quantized params ("Sinefold"), or the
  // unit-bearing value for continuous ones ("440 Hz"). Preferred over the raw
  // number/percent when present.
  beforeDisplay?: string | null;
  afterDisplay?: string | null;
  // Deliberate automation-lane changes get their own timeline treatment.
  automation?: boolean;
  // Transport positions observed during a live automation write. They locate
  // the producer's action; they are not Arrangement-envelope breakpoints or a
  // claim that the lane spans the interval.
  automationStartPosition?: string | null;
  automationEndPosition?: string | null;
  // Where Live's playhead was when the event arrived. Universal context from
  // bridge v0.6.0; distinct from the object's own Arrangement range below.
  observedArrangementPosition?: string | null;
  observedArrangementBeats?: number | null;
  arrangementStartBeats?: number | null;
  arrangementEndBeats?: number | null;
  // Whether this parameter is categorical (a mode selector) rather than a
  // continuous value — drives pill-vs-number rendering and suppresses the
  // up/down direction caret (a mode flip has no direction).
  quantized?: boolean | null;
  // note
  title?: string;
  starred?: boolean;
  // noteEdit — the part that changed, and how
  clipName?: string | null;
  clipId?: string | null;
  changeKind?: NoteChangeKind | null;
  noteCount?: number | null;
  previousNoteCount?: number | null;
  pitchRange?: string | null;
  pitchMin?: number | null;
  pitchMax?: number | null;
  previousPitchMin?: number | null;
  previousPitchMax?: number | null;
  previousPitchRange?: string | null;
  // Bridge-rendered phrase ("16 notes (+4), C1-G1 -> C1-G2"), preferred over
  // anything reassembled here — it was written where Live's own note naming was
  // in hand.
  summary?: string | null;
  // clip/sample addition
  assetName?: string | null;
  eventType?:
    | "sample_added"
    | "audio_clip_added"
    | "midi_clip_created"
    | "audio_clip_recorded"
    | "midi_clip_recorded"
    | "clip_created";
  // Selected immutable events that explain how the set evolved without being
  // raw telemetry: tempo, structure, recording, launches, saves, and similar.
  memoryCategory?: ProducerMemoryCategory;
  memoryTitle?: string;
  memorySummary?: string;
  evidence?: CapturedEvidence | null;
};

// A run of consecutive same-parameter moves collapsed into one story row.
// `lead` is the newest move (its after-value is the net result); `items` holds
// every move in the run, newest-first, for the expanded view.
export type ActivityGroup = {
  key: string;
  lead: Activity;
  items: Activity[];
};

// A session-wide "worth keeping" candidate — a starred note, a deliberate mode
// flip, or a large net parameter move — surfaced so the producer can flag what
// mattered without scrolling the full log.
export type Highlight = {
  id: string;
  kind: "note" | "mode" | "move";
  momentId?: string;
  trackId: string | null;
  trackName: string | null;
  deviceName: string | null;
  paramName: string | null;
  before: number | null;
  beforePercent: number | null;
  beforeDisplay: string | null;
  after: number | null;
  afterPercent: number | null;
  afterDisplay: string | null;
  unit: string | null;
  title: string | null;
  starred: boolean;
  atMs: number;
  score: number;
  // Why this surfaced — shown on the card so the curation isn't a black box.
  reason: string;
  // Relative rank strength 0–1, for the per-card strength meter.
  strength: number;
};

export type Lookups = {
  paramTrack: Map<string, string>;
  deviceTrack: Map<string, string>;
  nameTrack: Map<string, string>;
  abletonTrack: Map<string, string>;
};
