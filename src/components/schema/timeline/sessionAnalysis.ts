// Deterministic session analysis for Recall's producer-facing surfaces.
//
// Capture is intentionally exhaustive: a single action in Live can result in a
// note report, a clip report, and a structural report from different observers.
// That is valuable evidence, but it is not a useful primary interface. This
// module turns that evidence into a small number of factual work passages. It
// never guesses musical intent from a plugin name or writes a creative summary.

import type { CreativeMoment, NoteEdit, ParameterChange, TimelineClipEvent } from "../../../types/schema";
import type { ProducerMemoryEvent } from "./eventMemory";
import { formatMoveValue } from "./format";
import {
  classifyProducerWork,
  dominantProducerWork,
  emptyProducerWorkCounts,
  producerWorkDefinition,
  type ProducerWorkCounts,
  type ProducerWorkKind,
} from "./producerWork";

// A pause of two minutes is enough to separate an active creative stretch from
// the next one while allowing a producer to move between related tracks without
// fragmenting a passage into a row per control or track.
export const ANALYSIS_PASSAGE_GAP_MS = 2 * 60 * 1000;

// A capture can stay active for a long time while its work changes naturally.
// We only subdivide one of those very long stretches when Live actually
// recorded a meaningful pause inside it. This keeps the path legible without
// inventing stages from individual parameter moves.
export const MAX_PATH_PASSAGE_MS = 8 * 60 * 1000;
export const PATH_SPLIT_MIN_GAP_MS = 45 * 1000;
const MIN_ACTIONS_ON_EACH_SIDE_OF_SPLIT = 3;

// A project path can span months. Eleven numbered steps running from an evening
// straight into a step three days later reads as one continuous stretch of work,
// which is a lie about how the record was made. Four hours is longer than any
// single sitting and short enough that two sittings in one day still separate;
// splitting on elapsed gap rather than the calendar keeps a session that runs
// past midnight in one piece.
export const SESSION_SITTING_GAP_MS = 4 * 60 * 60 * 1000;

type ActivityKind = "move" | "midi" | "clip" | "memory" | "moment";
export type PassageKind = ProducerWorkKind | "mixed";
export type SessionPathPosition = "only" | "start" | "middle" | "finish";

type ActivityBase = {
  id: string;
  kind: ActivityKind;
  atMs: number;
  sourceId: string | null;
  sourceLabel: string | null;
  trackId: string | null;
  trackName: string | null;
};

export type NormalizedSessionActivity =
  | (ActivityBase & {
      kind: "move";
      change: ParameterChange;
      deviceName: string | null;
      parameterName: string | null;
    })
  | (ActivityBase & {
      kind: "midi";
      edit: NoteEdit;
      clipId: string | null;
      clipName: string | null;
    })
  | (ActivityBase & {
      kind: "clip";
      event: TimelineClipEvent;
      clipName: string | null;
      sampleName: string | null;
    })
  | (ActivityBase & {
      kind: "memory";
      event: ProducerMemoryEvent;
      eventType: string;
    })
  | (ActivityBase & {
      kind: "moment";
      moment: CreativeMoment;
      title: string;
      note: string | null;
    });

type PrimarySessionActivity = Extract<NormalizedSessionActivity, { kind: "move" | "midi" | "clip" }>;

function isPrimaryAction(activity: NormalizedSessionActivity): activity is PrimarySessionActivity {
  return activity.kind === "move" || activity.kind === "midi" || activity.kind === "clip";
}

export function producerWorkKindForActivity(activity: NormalizedSessionActivity): ProducerWorkKind {
  if (activity.kind === "move") {
    return classifyProducerWork({
      kind: "move",
      deviceName: activity.deviceName,
      parameterName: activity.parameterName,
    });
  }
  if (activity.kind === "midi") return classifyProducerWork({ kind: "midi" });
  if (activity.kind === "clip") {
    return classifyProducerWork({ kind: "clip", eventType: activity.event.event_type });
  }
  if (activity.kind === "moment") return classifyProducerWork({ kind: "moment" });
  return classifyProducerWork({
    kind: "memory",
    eventType: activity.eventType,
    memoryCategory: activity.event.category,
  });
}

export type SessionAnalysisInput = {
  changes: ParameterChange[];
  noteEdits: NoteEdit[];
  clipEvents: TimelineClipEvent[];
  memoryEvents: ProducerMemoryEvent[];
  moments?: CreativeMoment[];
  sessionStartedAtMs?: number | null;
};

// Inputs are kept source-aware at the boundary because every take starts with
// its own Live snapshot. A project path can then span multiple takes without
// treating an old take's routing/tempo snapshot as a new creative action.
export type SessionAnalysisSourceInput = SessionAnalysisInput & {
  sourceId?: string | null;
  sourceLabel?: string | null;
};

// One control the producer worked during a passage. `count` is how much labour
// went into it; `beforeDisplay`/`afterDisplay` are where it started and ended,
// which is the decision. A count alone cannot tell "nudged" from "searched the
// whole range and committed", and the decision is the part worth reading back.
export type PassageControl = {
  deviceName: string | null;
  parameterName: string;
  // The track this control lives on. A passage can span tracks while its
  // headline names only the busiest one, so a control listed underneath has to
  // say where it is or the reader attributes it to the headline's track. That
  // is how "Shaped sound on Bass Main · Glue Compressor · Threshold" reached
  // the screen while the Glue Compressor sat on Drum Group.
  trackName: string | null;
  count: number;
  beforeDisplay: string | null;
  afterDisplay: string | null;
};

export type SessionPassage = {
  id: string;
  order: number;
  pathPosition: SessionPathPosition;
  kind: PassageKind;
  label: string;
  workKinds: ProducerWorkKind[];
  workCounts: ProducerWorkCounts;
  // Work counted from hands-on actions only. `kind` is decided from these when
  // there are any, so a burst of structural reports cannot retitle a passage
  // the producer spent writing MIDI. Exposed so passages can be merged into
  // larger chapters without the merge having to re-derive the same judgement.
  primaryWorkCounts: ProducerWorkCounts;
  startMs: number;
  endMs: number;
  gapBeforeMs: number | null;
  actionCount: number;
  controlMoveCount: number;
  midiEditCount: number;
  clipEventCount: number;
  structureEventCount: number;
  markerCount: number;
  markers: { id: string; title: string; note: string | null; atMs: number }[];
  sourceLabels: string[];
  // Every track named by any evidence in the passage, including structural
  // reports and saved notes. Use this for context, never for a headline count.
  trackNames: string[];
  // Only tracks the producer actually acted on. A headline like "Balanced N
  // tracks" must come from here: a routing report or a note attached to a track
  // is not the producer touching its fader.
  primaryTrackNames: string[];
  // The same tracks with how much hands-on work landed on each, busiest first.
  // A headline that names one track needs to know whether that track actually
  // carried the step or merely won a two-to-one split.
  primaryTrackCounts: { name: string; count: number }[];
  observedArrangementPositions: string[];
  primaryTrackName: string | null;
  firstAction: string | null;
  lastAction: string | null;
  controls: PassageControl[];
};

// A continuous stretch of work with no long absence inside it. Passages are the
// steps; a sitting is the day/evening those steps belong to.
export type SessionSitting = {
  id: string;
  order: number;
  startMs: number;
  endMs: number;
  passages: SessionPassage[];
};

export type SessionAnalysis = {
  passages: SessionPassage[];
  sittings: SessionSitting[];
  pathSummary: string | null;
  actionCount: number;
  controlMoveCount: number;
  midiEditCount: number;
  clipEventCount: number;
  structureEventCount: number;
  markerCount: number;
  trackCount: number;
  workCounts: ProducerWorkCounts;
  duplicateReportCount: number;
  openingStateEventCount: number;
};

// Live emits these facts while a capture observer is establishing its initial
// picture of a set. They describe what was already there, not an action the
// producer took during the new capture. We only hide them in the short opening
// window; the same event later in a take remains evidence.
const OPENING_STATE_EVENT_TYPES = new Set([
  "track_routing_changed",
  "tempo_changed",
  "signature_changed",
  "time_signature_changed",
  "scale_changed",
  "key_changed",
  "groove_changed",
  "swing_changed",
]);
const OPENING_STATE_WINDOW_MS = 5_000;

function cleanName(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed !== "0" ? trimmed : null;
}

function stringValue(value: string | number | null | undefined): string {
  return value === null || value === undefined ? "" : String(value);
}

// The value as the producer saw it in Live, or null when the capture carried no
// readable value at all. `formatMoveValue` renders that case as an em dash for
// the detail tape; a passage summary would rather say nothing than say "—".
function displayValue(
  value: number | null | undefined,
  percent: number | null | undefined,
  unit: string | null | undefined,
  display: string | null | undefined,
): string | null {
  const text = formatMoveValue(value, percent, unit, display);
  return text === "—" ? null : text;
}

type TrackIdentity = (activity: NormalizedSessionActivity) => string | null;

// One identity per real track, across rows that describe it differently.
//
// Live's track pointer is authoritative, but not every row carries one: an older
// payload, or a track Live would not give us a pointer for, arrives name-only.
// Keying on `trackId ?? trackName` counts such a track twice — once as a pointer
// and once as a name — which is how "Balanced 31 tracks" can outrun the number
// of tracks in the set. Resolving names back to a pointer we have seen elsewhere
// keeps one track counted once.
function trackIdentity(activities: NormalizedSessionActivity[]): TrackIdentity {
  const idByName = new Map<string, string>();
  for (const activity of activities) {
    const id = activity.trackId?.trim();
    const name = cleanName(activity.trackName)?.toLowerCase();
    if (id && name && !idByName.has(name)) idByName.set(name, id);
  }
  return (activity) => {
    const id = activity.trackId?.trim();
    if (id) return `id:${id}`;
    const name = cleanName(activity.trackName)?.toLowerCase();
    if (!name) return null;
    const resolved = idByName.get(name);
    return resolved ? `id:${resolved}` : `name:${name}`;
  };
}

function compareActivities(a: NormalizedSessionActivity, b: NormalizedSessionActivity): number {
  return (
    a.atMs - b.atMs ||
    (a.sourceId ?? "").localeCompare(b.sourceId ?? "") ||
    a.id.localeCompare(b.id) ||
    a.kind.localeCompare(b.kind)
  );
}

function activityFingerprint(activity: NormalizedSessionActivity): string {
  const base = [
    activity.kind,
    activity.atMs,
    activity.trackId ?? cleanName(activity.trackName)?.toLowerCase() ?? "",
  ];
  if (activity.kind === "move") {
    return [
      ...base,
      activity.change.parameter_id ?? "",
      activity.deviceName ?? "",
      activity.parameterName ?? "",
      stringValue(activity.change.before_value),
      stringValue(activity.change.after_value),
      stringValue(activity.change.before_display_value),
      stringValue(activity.change.after_display_value),
    ].join("\u001f");
  }
  if (activity.kind === "midi") {
    return [
      ...base,
      activity.clipId ?? cleanName(activity.clipName)?.toLowerCase() ?? "",
      activity.edit.change_kind ?? "",
      stringValue(activity.edit.previous_note_count),
      stringValue(activity.edit.note_count),
      activity.edit.previous_pitch_range ?? "",
      activity.edit.pitch_range ?? "",
      activity.edit.summary ?? "",
    ].join("\u001f");
  }
  if (activity.kind === "clip") {
    return [
      ...base,
      activity.event.event_type,
      cleanName(activity.clipName)?.toLowerCase() ?? "",
      cleanName(activity.sampleName)?.toLowerCase() ?? "",
      stringValue(activity.event.arrangement_start_beats),
      stringValue(activity.event.arrangement_end_beats),
    ].join("\u001f");
  }
  if (activity.kind === "moment") {
    return [
      ...base,
      activity.title,
      activity.note ?? "",
      activity.moment.type,
    ].join("\u001f");
  }
  return [
    ...base,
    activity.eventType,
    activity.event.title,
    activity.event.summary,
  ].join("\u001f");
}

function asActivities(input: SessionAnalysisSourceInput): NormalizedSessionActivity[] {
  const activities: NormalizedSessionActivity[] = [];
  for (const change of input.changes) {
    if (!Number.isFinite(change.changed_at_ms)) continue;
    activities.push({
      id: change.id,
      kind: "move",
      atMs: change.changed_at_ms,
      sourceId: input.sourceId ?? null,
      sourceLabel: cleanName(input.sourceLabel),
      trackId: change.track_id,
      trackName: cleanName(change.track_name),
      deviceName: cleanName(change.device_name),
      parameterName: cleanName(change.parameter_name),
      change,
    });
  }
  for (const edit of input.noteEdits) {
    if (!Number.isFinite(edit.changed_at_ms)) continue;
    activities.push({
      id: edit.id,
      kind: "midi",
      atMs: edit.changed_at_ms,
      sourceId: input.sourceId ?? null,
      sourceLabel: cleanName(input.sourceLabel),
      trackId: edit.track_id,
      trackName: cleanName(edit.track_name),
      clipId: edit.clip_id,
      clipName: cleanName(edit.clip_name),
      edit,
    });
  }
  for (const event of input.clipEvents) {
    if (!Number.isFinite(event.changed_at_ms)) continue;
    activities.push({
      id: event.id,
      kind: "clip",
      atMs: event.changed_at_ms,
      sourceId: input.sourceId ?? null,
      sourceLabel: cleanName(input.sourceLabel),
      trackId: event.track_id,
      trackName: cleanName(event.track_name),
      clipName: cleanName(event.clip_name),
      sampleName: cleanName(event.sample_name),
      event,
    });
  }
  for (const event of input.memoryEvents) {
    if (!Number.isFinite(event.atMs)) continue;
    activities.push({
      id: event.id,
      kind: "memory",
      atMs: event.atMs,
      sourceId: input.sourceId ?? null,
      sourceLabel: cleanName(input.sourceLabel),
      trackId: event.trackId,
      trackName: cleanName(event.trackName),
      eventType: event.eventType,
      event,
    });
  }
  for (const moment of input.moments ?? []) {
    const atMs = moment.timeline_start_ms ?? moment.created_at_ms;
    if (!Number.isFinite(atMs)) continue;
    const targetTrackId = moment.targets.find((target) => target.target_type === "track")?.target_id ?? null;
    activities.push({
      id: moment.id,
      kind: "moment",
      atMs,
      sourceId: input.sourceId ?? null,
      sourceLabel: cleanName(input.sourceLabel),
      trackId: targetTrackId,
      trackName: null,
      title: cleanName(moment.title) ?? "Saved note",
      note: cleanName(moment.note),
      moment,
    });
  }
  return activities.sort(compareActivities);
}

function isOpeningState(activity: NormalizedSessionActivity, sessionStartedAtMs: number): boolean {
  return (
    activity.kind === "memory" &&
    OPENING_STATE_EVENT_TYPES.has(activity.eventType) &&
    activity.atMs >= sessionStartedAtMs - 1_000 &&
    activity.atMs <= sessionStartedAtMs + OPENING_STATE_WINDOW_MS
  );
}

function canonicalActivities(input: SessionAnalysisSourceInput): {
  activities: NormalizedSessionActivity[];
  duplicateReportCount: number;
  openingStateEventCount: number;
} {
  const reports = asActivities(input);
  const unique = new Map<string, NormalizedSessionActivity>();
  for (const report of reports) {
    const key = activityFingerprint(report);
    if (!unique.has(key)) unique.set(key, report);
  }
  const deduplicated = [...unique.values()].sort(compareActivities);
  const inferredStart = deduplicated[0]?.atMs ?? 0;
  const sessionStartedAtMs = input.sessionStartedAtMs ?? inferredStart;
  const openingState = deduplicated.filter((activity) => isOpeningState(activity, sessionStartedAtMs));
  return {
    activities: deduplicated.filter((activity) => !isOpeningState(activity, sessionStartedAtMs)),
    duplicateReportCount: reports.length - deduplicated.length,
    openingStateEventCount: openingState.length,
  };
}

// Used by the export layer as well as the on-screen analysis. An exported
// project record must not resurrect duplicate reports or opening snapshots the
// producer never acted on.
export function normalizedSessionActivities(input: SessionAnalysisInput): NormalizedSessionActivity[] {
  return canonicalActivities(input).activities;
}

/**
 * The same normalization across several takes, ordered as one stream.
 *
 * Sources stay separate through `canonicalActivities` so each take's opening
 * snapshot is judged against its own start — folding them into one input first
 * would let take two's routing snapshot read as new work in take one. The
 * companion to `analyzeSessionSources`, for callers that need the rows rather
 * than the analysis.
 */
export function normalizedActivitiesAcrossSources(
  inputs: SessionAnalysisSourceInput[],
): NormalizedSessionActivity[] {
  return inputs
    .flatMap((input) => canonicalActivities(input).activities)
    .sort(compareActivities);
}

function clusterActivities(activities: NormalizedSessionActivity[]): NormalizedSessionActivity[][] {
  if (activities.length === 0) return [];
  const clusters: NormalizedSessionActivity[][] = [];
  let current: NormalizedSessionActivity[] = [];
  let previous: number | null = null;
  for (const activity of activities) {
    if (previous !== null && activity.atMs - previous > ANALYSIS_PASSAGE_GAP_MS) {
      clusters.push(current);
      current = [];
    }
    current.push(activity);
    previous = activity.atMs;
  }
  if (current.length > 0) clusters.push(current);
  return clusters;
}

function splitLongCluster(cluster: NormalizedSessionActivity[]): NormalizedSessionActivity[][] {
  const passages = [cluster];

  // Work from left to right and always choose the largest recorded pause in an
  // oversized stretch. With the same input this produces the same chapters;
  // no track order, device name, or event arrival order can influence it.
  for (let index = 0; index < passages.length; index += 1) {
    const candidate = passages[index];
    if (!candidate || candidate.length < MIN_ACTIONS_ON_EACH_SIDE_OF_SPLIT * 2) continue;
    const firstAtMs = candidate[0]?.atMs ?? 0;
    const lastAtMs = candidate.at(-1)?.atMs ?? firstAtMs;
    if (lastAtMs - firstAtMs <= MAX_PATH_PASSAGE_MS) continue;

    let splitAfterIndex = -1;
    let largestGap = PATH_SPLIT_MIN_GAP_MS;
    for (
      let itemIndex = MIN_ACTIONS_ON_EACH_SIDE_OF_SPLIT - 1;
      itemIndex < candidate.length - MIN_ACTIONS_ON_EACH_SIDE_OF_SPLIT;
      itemIndex += 1
    ) {
      const before = candidate[itemIndex];
      const after = candidate[itemIndex + 1];
      if (!before || !after) continue;
      const gap = after.atMs - before.atMs;
      // The first largest gap wins ties, so equally valid pauses still lead to
      // a stable path rather than a random-looking split.
      if (gap > largestGap) {
        largestGap = gap;
        splitAfterIndex = itemIndex;
      }
    }
    if (splitAfterIndex === -1) continue;

    passages.splice(
      index,
      1,
      candidate.slice(0, splitAfterIndex + 1),
      candidate.slice(splitAfterIndex + 1),
    );
    // Re-check the left side before moving on: a very long take can contain
    // more than one observed pause worth using as a boundary.
    index -= 1;
  }

  return passages;
}

function closestPassageIndex(
  activity: NormalizedSessionActivity,
  passages: NormalizedSessionActivity[][],
): number | null {
  let best: { index: number; distance: number } | null = null;
  for (const [index, passage] of passages.entries()) {
    const start = passage[0]?.atMs;
    const end = passage.at(-1)?.atMs;
    if (start === undefined || end === undefined) continue;
    const distance = activity.atMs < start ? start - activity.atMs : activity.atMs > end ? activity.atMs - end : 0;
    if (distance > ANALYSIS_PASSAGE_GAP_MS) continue;
    if (!best || distance < best.distance) best = { index, distance };
  }
  return best?.index ?? null;
}

export function passageKind(
  primaryWorkCounts: ProducerWorkCounts,
  allWorkCounts: ProducerWorkCounts,
): { kind: PassageKind; label: string } {
  const primaryCount = Object.values(primaryWorkCounts).reduce((total, count) => total + count, 0);
  const dominant = dominantProducerWork(primaryCount > 0 ? primaryWorkCounts : allWorkCounts);
  if (dominant.kind === "mixed") {
    const labels = dominant.observed.slice(0, 3).map((kind) => producerWorkDefinition(kind).label);
    return { kind: "mixed", label: labels.length > 0 ? labels.join(" + ") : "Mixed work" };
  }
  return { kind: dominant.kind, label: producerWorkDefinition(dominant.kind).label };
}

function actionCue(activity: NormalizedSessionActivity | undefined): string | null {
  if (!activity || activity.kind === "memory" || activity.kind === "moment") return null;
  if (activity.kind === "move") {
    return [activity.deviceName, activity.parameterName ?? "Unlabelled control"].filter(Boolean).join(" · ");
  }
  if (activity.kind === "midi") {
    return activity.clipName ? `MIDI edit · ${activity.clipName}` : "MIDI edit";
  }
  const clipName = activity.sampleName ?? activity.clipName;
  const action = (() => {
    switch (activity.event.event_type) {
      case "sample_added": return "Sample added";
      case "audio_clip_added": return "Audio clip added";
      case "audio_clip_recorded": return "Audio recorded";
      case "midi_clip_recorded": return "MIDI recorded";
      case "midi_clip_created": return "MIDI clip created";
      default: return "Clip created";
    }
  })();
  return clipName ? `${action} · ${clipName}` : action;
}

export function observedArrangementPosition(activity: NormalizedSessionActivity): string | null {
  if (activity.kind === "move") {
    return cleanName(activity.change.observed_arrangement_position ?? activity.change.automation_start_position);
  }
  if (activity.kind === "midi") return cleanName(activity.edit.observed_arrangement_position);
  if (activity.kind === "clip") return cleanName(activity.event.observed_arrangement_position);
  return activity.kind === "memory" ? cleanName(activity.event.observedArrangementPosition) : null;
}

function summarizePassage(
  items: NormalizedSessionActivity[],
  index: number,
  identityOf: TrackIdentity,
): SessionPassage {
  const controls = new Map<string, PassageControl>();
  const trackCounts = new Map<string, { name: string; count: number }>();
  const primaryTrackCounts = new Map<string, { name: string; count: number }>();
  const sourceLabels = new Set<string>();
  const arrangementPositions = new Set<string>();
  let controlMoveCount = 0;
  let midiEditCount = 0;
  let clipEventCount = 0;
  let structureEventCount = 0;
  let markerCount = 0;
  const workCounts = emptyProducerWorkCounts();
  const primaryWorkCounts = emptyProducerWorkCounts();
  const markers: SessionPassage["markers"] = [];

  for (const item of items) {
    const workKind = producerWorkKindForActivity(item);
    workCounts[workKind] += 1;
    if (isPrimaryAction(item)) primaryWorkCounts[workKind] += 1;
    if (item.sourceLabel) sourceLabels.add(item.sourceLabel);
    if (isPrimaryAction(item)) {
      const position = observedArrangementPosition(item);
      if (position) arrangementPositions.add(position);
    }
    const identity = identityOf(item);
    if (identity && item.trackName) {
      const current = trackCounts.get(identity) ?? { name: item.trackName, count: 0 };
      current.count += 1;
      trackCounts.set(identity, current);
      if (isPrimaryAction(item)) {
        const primaryCurrent = primaryTrackCounts.get(identity) ?? { name: item.trackName, count: 0 };
        primaryCurrent.count += 1;
        primaryTrackCounts.set(identity, primaryCurrent);
      }
    }
    if (item.kind === "move") {
      controlMoveCount += 1;
      const parameterName = item.parameterName ?? "Unlabelled control";
      // Keyed by track as well as by control: two tracks can carry the same
      // device with the same parameter, and folding them together reports one
      // fader's journey as if it were the other's.
      const key = [item.trackId ?? item.trackName ?? "", item.deviceName ?? "", parameterName].join("");
      // Items arrive in time order, so the first sighting of a control fixes
      // where the passage found it and each later one advances where it left it.
      // That gives the net decision across the passage rather than the last
      // individual nudge inside it.
      const current = controls.get(key) ?? {
        deviceName: item.deviceName,
        parameterName,
        trackName: item.trackName,
        count: 0,
        beforeDisplay: displayValue(
          item.change.before_value,
          item.change.before_value_percent,
          item.change.unit,
          item.change.before_display_value,
        ),
        afterDisplay: null,
      };
      current.count += 1;
      current.afterDisplay =
        displayValue(
          item.change.after_value,
          item.change.after_value_percent,
          item.change.unit,
          item.change.after_display_value,
        ) ?? current.afterDisplay;
      controls.set(key, current);
    } else if (item.kind === "midi") {
      midiEditCount += 1;
    } else if (item.kind === "clip") {
      clipEventCount += 1;
    } else if (item.kind === "moment") {
      markerCount += 1;
      markers.push({ id: item.id, title: item.title, note: item.note, atMs: item.atMs });
    } else {
      structureEventCount += 1;
    }
  }

  const { kind, label } = passageKind(primaryWorkCounts, workCounts);
  const first = items[0];
  const last = items.at(-1);
  const primaryItems = items.filter(isPrimaryAction);
  const firstPrimary = primaryItems[0];
  const lastPrimary = primaryItems.at(-1);
  const rankedPrimaryTracks = [...primaryTrackCounts.values()]
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  const primaryTrackName = rankedPrimaryTracks[0]?.name ?? null;
  return {
    id: `passage-${index}-${first?.atMs ?? 0}`,
    order: index + 1,
    pathPosition: "only",
    kind,
    label,
    workKinds: dominantProducerWork(workCounts).observed,
    workCounts,
    primaryWorkCounts,
    // Structural memory stays attached as supporting evidence, but a producer
    // path begins and ends with actions they actually made whenever those are
    // available. That keeps a late routing report from rewriting the chapter.
    startMs: firstPrimary?.atMs ?? first?.atMs ?? 0,
    endMs: lastPrimary?.atMs ?? last?.atMs ?? first?.atMs ?? 0,
    gapBeforeMs: null,
    actionCount: controlMoveCount + midiEditCount + clipEventCount,
    controlMoveCount,
    midiEditCount,
    clipEventCount,
    structureEventCount,
    markerCount,
    markers,
    sourceLabels: [...sourceLabels],
    trackNames: [...trackCounts.values()]
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
      .map((entry) => entry.name),
    primaryTrackNames: rankedPrimaryTracks.map((entry) => entry.name),
    primaryTrackCounts: rankedPrimaryTracks,
    // The Timeline owns the complete producer-facing record. Presentation may
    // summarize a long run, but the analysis layer must never discard observed
    // positions before a surface has the chance to show them.
    observedArrangementPositions: [...arrangementPositions],
    primaryTrackName,
    firstAction: actionCue(primaryItems[0]),
    lastAction: actionCue(primaryItems.at(-1)),
    // Ranking is useful for a summary, but truncating here made the fourth
    // control disappear from every downstream surface—including Timeline.
    controls: [...controls.values()]
      .sort((a, b) => b.count - a.count || a.parameterName.localeCompare(b.parameterName)),
  };
}

// Break the ordered path wherever the producer was away long enough that the
// next step is a fresh sitting rather than a continuation. Passages are already
// ordered and carry the measured gap, so this reads that gap rather than
// re-deriving one.
export function groupPassagesIntoSittings(passages: SessionPassage[]): SessionSitting[] {
  const sittings: SessionSitting[] = [];
  for (const passage of passages) {
    const current = sittings.at(-1);
    const startsNewSitting =
      !current || (passage.gapBeforeMs !== null && passage.gapBeforeMs >= SESSION_SITTING_GAP_MS);
    if (startsNewSitting) {
      sittings.push({
        id: `sitting-${sittings.length}-${passage.startMs}`,
        order: sittings.length + 1,
        startMs: passage.startMs,
        endMs: passage.endMs,
        passages: [passage],
      });
      continue;
    }
    current.passages.push(passage);
    current.endMs = Math.max(current.endMs, passage.endMs);
  }
  return sittings;
}

function pathPosition(index: number, total: number): SessionPathPosition {
  if (total <= 1) return "only";
  if (index === 0) return "start";
  if (index === total - 1) return "finish";
  return "middle";
}

function pathPhrase(passage: SessionPassage): string {
  switch (passage.kind) {
    case "writing":
      return "writing";
    case "recording":
      return "recording and performance";
    case "sound":
      return "sound and sample work";
    case "arrangement":
      return "arrangement";
    case "mixing":
      return "mixing";
    case "project":
      return "project changes";
    case "moment":
      return "a marked moment";
    default: {
      const labels = passage.workKinds.slice(0, 3).map((kind) => producerWorkDefinition(kind).phrase);
      if (labels.length === 0) return "mixed work";
      if (labels.length === 1) return labels[0] ?? "mixed work";
      return `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}`;
    }
  }
}

function passageScope(passage: SessionPassage): string {
  if (passage.kind !== "mixing" && passage.primaryTrackName) return ` on ${passage.primaryTrackName}`;
  // Scope describes what the producer worked on, so it counts only tracks they
  // acted on — a track named by a routing report was not part of the pass.
  const touched = passage.primaryTrackNames;
  const tracks = touched.slice(0, 2);
  if (tracks.length === 0) return "";
  if (tracks.length === 1) return ` on ${tracks[0]}`;
  const remaining = touched.length - tracks.length;
  const suffix = remaining > 0 ? ` and ${remaining} more track${remaining === 1 ? "" : "s"}` : "";
  return ` across ${tracks.join(" and ")}${suffix}`;
}

function summarizePath(passages: SessionPassage[]): string | null {
  if (passages.length === 0) return null;
  const totals = emptyProducerWorkCounts();
  for (const passage of passages) {
    for (const kind of Object.keys(totals) as ProducerWorkKind[]) {
      totals[kind] += passage.workCounts[kind];
    }
  }
  const ranked = (Object.keys(totals) as ProducerWorkKind[])
    .filter((kind) => totals[kind] > 0)
    .sort((a, b) => totals[b] - totals[a]);
  const focus = ranked.slice(0, 3).map((kind) => producerWorkDefinition(kind).label);
  const focusText = focus.length <= 1
    ? focus[0] ?? "captured work"
    : `${focus.slice(0, -1).join(", ")} and ${focus.at(-1)}`;
  const tracks = new Set(passages.flatMap((passage) => passage.primaryTrackNames));
  const broadScope = tracks.size > 0 ? ` across ${tracks.size} track${tracks.size === 1 ? "" : "s"}` : "";
  const first = passages[0];
  const last = passages.at(-1);
  if (!first || !last || passages.length === 1) {
    return `This session focused on ${focusText}${first ? passageScope(first) : broadScope}.`;
  }
  return `This session focused on ${focusText}${broadScope}. It opened with ${pathPhrase(first)}${passageScope(first)} and closed with ${pathPhrase(last)}${passageScope(last)}.`;
}

export function analyzeSessionSources(inputs: SessionAnalysisSourceInput[]): SessionAnalysis {
  const canonicalSources = inputs.map((input) => canonicalActivities(input));
  const activities = canonicalSources
    .flatMap((source) => source.activities)
    .sort(compareActivities);
  const primary = activities.filter(isPrimaryAction);
  const initialClusters = clusterActivities(primary.length > 0 ? primary : activities);
  const clusters = initialClusters.flatMap(splitLongCluster);

  // Structural events provide useful supporting evidence, but never keep an
  // otherwise separate writing/shaping passage artificially connected.
  if (primary.length > 0) {
    for (const supportingActivity of activities.filter((activity) => activity.kind === "memory" || activity.kind === "moment")) {
      const index = closestPassageIndex(supportingActivity, clusters);
      if (index !== null) clusters[index]?.push(supportingActivity);
    }
    for (const cluster of clusters) cluster.sort(compareActivities);
  }

  // Built once over every activity so a track described by pointer in one take
  // and by name in another resolves to a single identity everywhere below.
  const identityOf = trackIdentity(activities);
  const passages = clusters.map((cluster, index) => summarizePassage(cluster, index, identityOf));
  const orderedPassages = passages.map((passage, index) => ({
    ...passage,
    order: index + 1,
    pathPosition: pathPosition(index, passages.length),
    gapBeforeMs: index > 0
      ? Math.max(0, passage.startMs - (passages[index - 1]?.endMs ?? passage.startMs))
      : null,
  }));
  const trackNames = new Set(
    activities
      .filter(isPrimaryAction)
      .map((activity) => identityOf(activity))
      .filter((identity): identity is string => identity !== null),
  );
  const controlMoveCount = activities.filter((activity) => activity.kind === "move").length;
  const midiEditCount = activities.filter((activity) => activity.kind === "midi").length;
  const clipEventCount = activities.filter((activity) => activity.kind === "clip").length;
  const structureEventCount = activities.filter((activity) => activity.kind === "memory").length;
  const markerCount = activities.filter((activity) => activity.kind === "moment").length;
  const workCounts = emptyProducerWorkCounts();
  for (const activity of activities) workCounts[producerWorkKindForActivity(activity)] += 1;

  return {
    passages: orderedPassages,
    sittings: groupPassagesIntoSittings(orderedPassages),
    pathSummary: summarizePath(orderedPassages),
    actionCount: controlMoveCount + midiEditCount + clipEventCount,
    controlMoveCount,
    midiEditCount,
    clipEventCount,
    structureEventCount,
    markerCount,
    trackCount: trackNames.size,
    workCounts,
    duplicateReportCount: canonicalSources.reduce((count, source) => count + source.duplicateReportCount, 0),
    openingStateEventCount: canonicalSources.reduce((count, source) => count + source.openingStateEventCount, 0),
  };
}

export function analyzeSession(input: SessionAnalysisInput): SessionAnalysis {
  return analyzeSessionSources([input]);
}
