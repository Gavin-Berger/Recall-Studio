// Shared types and constants for the schema timeline surface. Kept apart from the
// component so the data helpers, share/export, and presentational parts can all
// agree on one shape without importing the big component file.

export type LoadStatus = "idle" | "loading" | "ready" | "error";
export type ExportFormat = "md" | "txt" | "json" | "pdf";

export const LIVE_REFRESH_DEBOUNCE_MS = 700;
// Backstop for a live session when event pushes go missing (a suspended webview
// drops them silently). Deliberately slow: pushes drive normal updates, and this
// only bounds how long a miss can persist. Every tick rematerializes the schema,
// so tightening it puts real work on the backend for no gain.
export const LIVE_SAFETY_POLL_MS = 15_000;
export const LIVE_REFRESH_EVENT_TYPES = new Set([
  "parameter_changed",
  "device_parameter_changed",
  "automation_created",
  "selected_track_focus_snapshot",
  "live_set_snapshot",
  "device_added",
  "device_removed",
  "device_chain_changed",
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

// One thing that happened on a track this take — a knob move or a note.
export type Activity = {
  id: string;
  kind: "move" | "note";
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
  // Whether this parameter is categorical (a mode selector) rather than a
  // continuous value — drives pill-vs-number rendering and suppresses the
  // up/down direction caret (a mode flip has no direction).
  quantized?: boolean | null;
  // note
  title?: string;
  starred?: boolean;
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
};
