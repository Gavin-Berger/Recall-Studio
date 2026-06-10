import type { RecallTimelineMoment } from "./recall";

// How a raw event participates in the activity system.
export type EventClass =
  | "visible"    // shows in timeline as a key action inside an activity block
  | "context"    // provides grouping context (track focus, parameter changes) but not shown
  | "analytics"  // counted in analytics (playbacks, tempo changes) but not shown
  | "system";    // ignored entirely (heartbeats, connection noise)

export type ActivityCategory =
  | "sound_design"   // device chain work, parameter tweaking
  | "arrangement"    // clip creation, scene work, structural changes
  | "mixing"         // master/bus/mixer-focused work
  | "tracking"       // recording-related events
  | "general";       // catch-all

export type ActivityAnalytics = {
  playbackCount: number;
  parameterChangeCount: number;
  devicesAdded: string[];
  // Samples dropped in (by file/sample name) — kept distinct from clipsCreated so
  // a Splice drag-in reads as "Dropped in X", not a generic created clip.
  samplesAdded: string[];
  clipsCreated: string[];
  // Parameters a producer wrote automation on (e.g. "Filter Cutoff") — distinct
  // from the raw parameterChangeCount, since writing automation is a creative act.
  automationTargets: string[];
  tracksVisited: string[];
};

export type ActivityBlock = {
  id: string;
  startTime: number;        // ms epoch
  endTime: number;
  startTimecode: string;    // session-relative (e.g. "00:04:12")
  endTimecode: string;
  durationMs: number;
  primaryTrack: string | null;
  category: ActivityCategory;
  title: string;
  summary: string;
  keyActions: string[];
  visibleEvents: RecallTimelineMoment[];
  contextEvents: RecallTimelineMoment[];
  analytics: ActivityAnalytics;
};
