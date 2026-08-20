import { activeDurationMs, formatMoveValue } from "../../components/schema/timeline/format";
import { captureCoverage, describeCaptureCoverage } from "../../components/schema/timeline/captureCoverage";
import { producerMemoryEvents } from "../../components/schema/timeline/eventMemory";
import {
  analyzeSession,
  normalizedSessionActivities,
  passageKind,
  producerWorkKindForActivity,
  type NormalizedSessionActivity,
  type PassageControl,
  type SessionAnalysis,
  type SessionPassage,
} from "../../components/schema/timeline/sessionAnalysis";
import {
  PRODUCER_WORK_LEGEND,
  dominantProducerWork,
  emptyProducerWorkCounts,
  producerWorkDefinition,
  type ProducerWorkCounts,
  type ProducerWorkKind,
} from "../../components/schema/timeline/producerWork";
import { compareSchemas, type VersionDiff } from "./versionDiff";
import type {
  CreativeMoment,
  NoteEdit,
  ParameterChange,
  ProjectSchema,
  TimelineClipEvent,
  TrackObj,
  TrackType,
} from "../../types/schema";
import type { SavedSession } from "../../types/recall";

export type SessionReportInput = {
  session: SavedSession;
  schema: ProjectSchema | null;
  changes: ParameterChange[];
  noteEdits: NoteEdit[];
  clipEvents: TimelineClipEvent[];
  moments: CreativeMoment[];
};

export type ReportTrust = {
  level: "clear" | "partial" | "unknown";
  label: string;
  detail: string;
};

/**
 * Every headline number on the report, derived once so no two can disagree.
 *
 * The screen used to print "14 actions" beside "18 decisions" — two different
 * universes (actions excluded structure and moments, decisions included them)
 * lined up as if they were comparable. A producer reading that sees 18
 * decisions come out of 14 actions, which cannot happen. The ledger is the one
 * place these are counted, it reconciles by construction, and
 * `reportInvariants` fails loudly if it ever stops doing so.
 */
export type ReportLedger = {
  /** Every captured row. The ground truth every other count is a slice of. */
  capturedCount: number;
  /** Rows that were the producer's own hands: a control move, a MIDI edit, a clip. */
  handsOnCount: number;
  /** Rows Live reported about the set rather than a hands-on move. */
  reportedCount: number;
  /** Rows the producer explicitly saved as a moment. */
  momentCount: number;
  /** Captured rows after repeated moves on one control collapse into their net outcome. */
  decisionCount: number;
  /** How many captured rows folded into an existing decision. */
  groupedCount: number;
  /** Distinct controls the producer moved. */
  controlCount: number;
  /** Real devices touched — the mixer strip is not one of them. */
  deviceCount: number;
  /** True when track volume, pan, or a send moved. Reported separately from devices. */
  mixerTouched: boolean;
  /** Tracks with at least one captured row. */
  tracksTouched: number;
  /** Tracks in the captured set, when a snapshot exists to count them. */
  tracksInSet: number | null;
};

export type ReportEvidenceKind = "move" | "midi" | "clip" | "structure" | "moment";

export type ReportEvidence = {
  id: string;
  sourceId: string;
  kind: ReportEvidenceKind;
  atMs: number;
  track: string | null;
  subject: string;
  detail: string;
};

export type ReportDecisionKind = "control" | "midi" | "clip" | "structure" | "moment";

export type ReportDecision = {
  id: string;
  key: string;
  kind: ReportDecisionKind;
  workKind: ProducerWorkKind;
  atMs: number;
  endMs: number;
  track: string | null;
  subject: string;
  outcome: string;
  count: number;
  evidenceIds: string[];
};

export type ReportTrack = {
  id: string;
  name: string;
  number: number | null;
  type: TrackType | null;
  actionCount: number;
  sourceEventCount: number;
  moveCount: number;
  midiCount: number;
  clipCount: number;
  structureCount: number;
  momentCount: number;
  controlCount: number;
  /** Devices sitting in the chain when the set was captured. */
  chainDeviceCount: number;
  /** Devices on this track the producer actually moved something on. */
  shapedDeviceCount: number;
  /** True when this track's own volume, pan, or send moved. */
  mixerTouched: boolean;
  workLabel: string;
  workKinds: ProducerWorkKind[];
  workCounts: ProducerWorkCounts;
  lastTouchedMs: number | null;
  deviceChain: string[];
  evidenceIds: string[];
};

export type ReportSeriesBucket = {
  index: number;
  startMs: number;
  endMs: number;
  total: number;
  move: number;
  midi: number;
  clip: number;
  structure: number;
  moment: number;
  workCounts: ProducerWorkCounts;
};

export type ReportWorkSection = {
  kind: ProducerWorkKind;
  label: string;
  description: string;
  evidenceRule: string;
  decisionCount: number;
  sourceEventCount: number;
  decisionIds: string[];
  evidenceIds: string[];
};

export type ReportLesson = {
  id: "focus" | "iteration" | "carry";
  label: string;
  title: string;
  detail: string;
  evidenceIds: string[];
};

export type SessionReport = {
  session: SavedSession;
  schema: ProjectSchema | null;
  analysis: SessionAnalysis;
  trust: ReportTrust;
  handsOnMs: number;
  wallClockMs: number;
  activityStartMs: number | null;
  activityEndMs: number | null;
  /** The session's passages joined into readable chapters. See `reportChapters`. */
  chapters: SessionPassage[];
  ledger: ReportLedger;
  summaryText: string;
  tracks: ReportTrack[];
  decisions: ReportDecision[];
  workSections: ReportWorkSection[];
  lessons: ReportLesson[];
  series: ReportSeriesBucket[];
  evidence: Record<string, ReportEvidence>;
};

export type ReportComparisonMetric = {
  label: string;
  current: number;
  baseline: number;
  delta: number;
  format: "duration" | "number";
};

export type ReportComparison = {
  metrics: ReportComparisonMetric[];
  structural: VersionDiff | null;
  onlyCurrent: ReportDecision[];
  onlyBaseline: ReportDecision[];
};

function clean(value: string | null | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed && trimmed !== "0" ? trimmed : fallback;
}

// The remote script reports track volume, pan, and sends under a device called
// "Mixer" (remote-script/Recall/__init__.py). It is a channel strip, not a
// device in the chain, so counting it as one overstates "devices shaped" by one
// on every session that touched a fader.
const MIXER_PSEUDO_DEVICE = "mixer";

function isMixerDevice(deviceName: string | null | undefined): boolean {
  return deviceName?.trim().toLocaleLowerCase() === MIXER_PSEUDO_DEVICE;
}

function trackIdentity(id: string | null | undefined, name: string | null | undefined): string | null {
  const stable = id?.trim();
  if (stable) return `id:${stable}`;
  const label = name?.trim().toLocaleLowerCase();
  return label ? `name:${label}` : null;
}

function evidenceId(activity: NormalizedSessionActivity): string {
  return `${activity.kind}:${activity.id}`;
}

// The "where" of a change that did not happen on a track. This used to return
// "Arrangement" for cue points, which collided head-on with the Arrangement
// work area — the same word appeared as both the kind of work and the place it
// happened, in adjacent columns of the same row. Everything without a track
// gets one honest answer instead; the change's own wording ("Song section
// moved: Drop") already says which set-wide thing moved.
const WHOLE_SET = "Whole set";

function valueOf(change: ParameterChange, side: "before" | "after"): string {
  return side === "before"
    ? formatMoveValue(
        change.before_value,
        change.before_value_percent,
        change.unit,
        change.before_display_value,
      )
    : formatMoveValue(
        change.after_value,
        change.after_value_percent,
        change.unit,
        change.after_display_value,
      );
}

function transition(before: string, after: string): string {
  if (before === "—" && after === "—") return "Adjusted — values were not captured";
  if (after === "—") return `Started at ${before} — final value was not captured`;
  if (before === "—" || before === after) return `Set to ${after}`;
  return `${before} → ${after}`;
}

function noteOutcome(edit: NoteEdit): string {
  if (edit.summary?.trim()) return edit.summary.trim();
  const before = edit.previous_note_count;
  const after = edit.note_count;
  const count = before !== null && after !== null ? `${before} → ${after} notes` : `${after ?? "—"} notes`;
  const range =
    edit.previous_pitch_range && edit.pitch_range && edit.previous_pitch_range !== edit.pitch_range
      ? `${edit.previous_pitch_range} → ${edit.pitch_range}`
      : edit.pitch_range;
  return [count, range].filter(Boolean).join(" · ");
}

function clipOutcome(event: TimelineClipEvent): string {
  const name = clean(event.sample_name ?? event.clip_name, "Untitled clip");
  switch (event.event_type) {
    case "sample_added":
    case "audio_clip_added":
      return `Inserted ${name}`;
    case "audio_clip_recorded":
      return `Recorded audio · ${name}`;
    case "midi_clip_recorded":
      return `Recorded MIDI · ${name}`;
    default:
      return `Added ${name}`;
  }
}

/**
 * Where a captured row happened.
 *
 * A saved moment arrives from the analysis with a `trackId` but no
 * `trackName` — the analysis layer has no schema to look one up in. The report
 * does, so it resolves the name here. Without this, every moment the producer
 * pinned to a track was filed under "Project" in the Where column while the
 * same moment was correctly rolled up under its track in the track table: the
 * page contradicted itself about the same event.
 */
type TrackNameResolver = (activity: NormalizedSessionActivity) => string | null;

function trackNameResolver(schema: ProjectSchema | null): TrackNameResolver {
  const { byId } = schemaTrackLookups(schema);
  return (activity) => {
    const named = activity.trackName?.trim();
    if (named && named !== "0") return named;
    const resolved = activity.trackId ? byId.get(activity.trackId)?.name?.trim() : undefined;
    return resolved && resolved !== "0" ? resolved : null;
  };
}

/** Track-scoped rows keep their track; set-wide rows say so rather than guessing. */
function whereOf(activity: NormalizedSessionActivity, trackNameOf: TrackNameResolver): string | null {
  const track = trackNameOf(activity);
  if (track) return track;
  return activity.kind === "memory" || activity.kind === "moment" ? WHOLE_SET : null;
}

function evidenceOf(activity: NormalizedSessionActivity, trackNameOf: TrackNameResolver): ReportEvidence {
  const base = {
    id: evidenceId(activity),
    sourceId: activity.id,
    atMs: activity.atMs,
    track: whereOf(activity, trackNameOf),
  };
  if (activity.kind === "move") {
    const subject = controlLabel(activity.deviceName, activity.parameterName);
    return {
      ...base,
      kind: "move",
      subject,
      detail: transition(valueOf(activity.change, "before"), valueOf(activity.change, "after")),
    };
  }
  if (activity.kind === "midi") {
    return {
      ...base,
      kind: "midi",
      subject: activity.clipName ? `MIDI · ${activity.clipName}` : "MIDI edit",
      detail: noteOutcome(activity.edit),
    };
  }
  if (activity.kind === "clip") {
    return {
      ...base,
      kind: "clip",
      subject: activity.sampleName ?? activity.clipName ?? "Clip action",
      detail: clipOutcome(activity.event),
    };
  }
  if (activity.kind === "moment") {
    return {
      ...base,
      kind: "moment",
      subject: activity.title,
      detail: activity.note ?? `${activity.moment.confidence} moment`,
    };
  }
  return {
    ...base,
    kind: "structure",
    subject: activity.event.title,
    detail: activity.event.summary,
  };
}

function decisionsOf(
  activities: NormalizedSessionActivity[],
  trackNameOf: TrackNameResolver,
): ReportDecision[] {
  const decisions: ReportDecision[] = [];
  const controlByKey = new Map<string, ReportDecision & { firstBefore: string; lastAfter: string }>();

  for (const activity of activities) {
    const evidence = evidenceId(activity);
    const identity = trackIdentity(activity.trackId, activity.trackName) ?? "project";
    const where = whereOf(activity, trackNameOf);
    if (activity.kind === "move") {
      const subject = controlLabel(activity.deviceName, activity.parameterName);
      const key = `control:${identity}:${subject.toLocaleLowerCase()}`;
      const before = valueOf(activity.change, "before");
      const after = valueOf(activity.change, "after");
      const current = controlByKey.get(key);
      if (current) {
        current.endMs = activity.atMs;
        current.atMs = Math.min(current.atMs, activity.atMs);
        current.count += 1;
        current.lastAfter = after;
        current.outcome = transition(current.firstBefore, current.lastAfter);
        current.evidenceIds.push(evidence);
      } else {
        controlByKey.set(key, {
          id: `decision:${key}`,
          key,
          kind: "control",
          workKind: producerWorkKindForActivity(activity),
          atMs: activity.atMs,
          endMs: activity.atMs,
          track: where,
          subject,
          outcome: transition(before, after),
          count: 1,
          evidenceIds: [evidence],
          firstBefore: before,
          lastAfter: after,
        });
      }
      continue;
    }

    const decisionBase = {
      workKind: producerWorkKindForActivity(activity),
      atMs: activity.atMs,
      endMs: activity.atMs,
      track: where,
      count: 1,
      evidenceIds: [evidence],
    };
    if (activity.kind === "midi") {
      const subject = activity.clipName ? `MIDI · ${activity.clipName}` : "MIDI edit";
      decisions.push({
        ...decisionBase,
        id: `decision:midi:${activity.id}`,
        key: `midi:${identity}:${activity.clipId ?? activity.clipName ?? activity.id}`,
        kind: "midi",
        subject,
        outcome: noteOutcome(activity.edit),
      });
    } else if (activity.kind === "clip") {
      decisions.push({
        ...decisionBase,
        id: `decision:clip:${activity.id}`,
        key: `clip:${identity}:${activity.event.event_type}:${activity.clipName ?? activity.sampleName ?? activity.id}`,
        kind: "clip",
        subject: activity.sampleName ?? activity.clipName ?? "Clip action",
        outcome: clipOutcome(activity.event),
      });
    } else if (activity.kind === "moment") {
      decisions.push({
        ...decisionBase,
        id: `decision:moment:${activity.id}`,
        key: `moment:${activity.id}`,
        kind: "moment",
        subject: activity.title,
        outcome: activity.note ?? `${activity.moment.confidence} moment`,
      });
    } else {
      decisions.push({
        ...decisionBase,
        id: `decision:structure:${activity.id}`,
        key: `structure:${identity}:${activity.eventType}:${activity.event.summary.toLocaleLowerCase()}`,
        kind: "structure",
        subject: activity.event.title,
        outcome: activity.event.summary,
      });
    }
  }

  decisions.push(...controlByKey.values());
  return decisions.sort((a, b) => a.atMs - b.atMs || a.subject.localeCompare(b.subject));
}

type MutableTrack = ReportTrack & {
  controls: Set<string>;
  devices: Set<string>;
};

/** A control the producer moved, named the way they would name it out loud. */
function controlLabel(deviceName: string | null, parameterName: string | null): string {
  return [deviceName, parameterName ?? "Unlabelled control"].filter(Boolean).join(" · ");
}

function schemaTrackLookups(schema: ProjectSchema | null): {
  byId: Map<string, TrackObj>;
  byName: Map<string, TrackObj[]>;
} {
  const byId = new Map<string, TrackObj>();
  const byName = new Map<string, TrackObj[]>();
  for (const track of schema?.tracks ?? []) {
    byId.set(track.id, track);
    if (track.ableton_id) byId.set(track.ableton_id, track);
    const name = track.name?.trim().toLocaleLowerCase();
    if (name) byName.set(name, [...(byName.get(name) ?? []), track]);
  }
  return { byId, byName };
}

function workLabel(workCounts: ProducerWorkCounts): string {
  if (Object.values(workCounts).every((count) => count === 0)) return "Untouched this version";
  const dominant = dominantProducerWork(workCounts);
  if (dominant.kind !== "mixed") return producerWorkDefinition(dominant.kind).label;
  return dominant.observed
    .slice(0, 3)
    .map((kind) => producerWorkDefinition(kind).label)
    .join(" + ");
}

function tracksOf(
  schema: ProjectSchema | null,
  activities: NormalizedSessionActivity[],
  trackNameOf: TrackNameResolver,
): ReportTrack[] {
  const { byId, byName } = schemaTrackLookups(schema);
  const tracks = new Map<string, MutableTrack>();

  function ensure(activity: NormalizedSessionActivity): MutableTrack | null {
    const resolvedName = trackNameOf(activity);
    const schemaTrack =
      (activity.trackId ? byId.get(activity.trackId) : undefined) ??
      (resolvedName ? byName.get(resolvedName.toLocaleLowerCase())?.[0] : undefined);
    const key = schemaTrack
      ? `schema:${schemaTrack.id}`
      : trackIdentity(activity.trackId, resolvedName);
    if (!key) return null;
    const current = tracks.get(key);
    if (current) return current;
    const created: MutableTrack = {
      id: key,
      name: clean(schemaTrack?.name ?? resolvedName, "Untitled track"),
      number: schemaTrack?.number ?? null,
      type: schemaTrack?.type ?? null,
      actionCount: 0,
      sourceEventCount: 0,
      moveCount: 0,
      midiCount: 0,
      clipCount: 0,
      structureCount: 0,
      momentCount: 0,
      controlCount: 0,
      chainDeviceCount: schemaTrack?.devices.length ?? 0,
      shapedDeviceCount: 0,
      mixerTouched: false,
      workLabel: "Untouched this version",
      workKinds: [],
      lastTouchedMs: null,
      deviceChain: [...(schemaTrack?.devices ?? [])]
        .sort((a, b) => a.chain_index - b.chain_index)
        .map((device) => clean(device.name, "Device")),
      evidenceIds: [],
      controls: new Set<string>(),
      devices: new Set<string>(),
      workCounts: emptyProducerWorkCounts(),
    };
    tracks.set(key, created);
    return created;
  }

  for (const track of schema?.tracks ?? []) {
    const placeholder: NormalizedSessionActivity = {
      id: `schema-${track.id}`,
      kind: "memory",
      atMs: 0,
      sourceId: null,
      sourceLabel: null,
      trackId: track.id,
      trackName: track.name,
      eventType: "schema",
      event: {
        id: `schema-${track.id}`,
        eventType: "schema",
        atMs: 0,
        trackId: track.id,
        trackName: track.name,
        title: "Track present",
        summary: "Present in the captured version",
        category: "structure",
        observedArrangementPosition: null,
        observedArrangementBeats: null,
        evidence: null,
      },
    };
    ensure(placeholder);
  }

  for (const activity of activities) {
    const track = ensure(activity);
    if (!track) continue;
    track.evidenceIds.push(evidenceId(activity));
    track.sourceEventCount += 1;
    track.lastTouchedMs = Math.max(track.lastTouchedMs ?? 0, activity.atMs);
    track.workCounts[producerWorkKindForActivity(activity)] += 1;
    if (activity.kind === "move") {
      track.actionCount += 1;
      track.moveCount += 1;
      track.controls.add(`${activity.deviceName ?? ""}:${activity.parameterName ?? ""}`);
      // The mixer strip is counted as mix work, never as a device in the chain.
      if (isMixerDevice(activity.deviceName)) track.mixerTouched = true;
      else if (activity.deviceName) track.devices.add(activity.deviceName);
    } else if (activity.kind === "midi") {
      track.actionCount += 1;
      track.midiCount += 1;
    } else if (activity.kind === "clip") {
      track.actionCount += 1;
      track.clipCount += 1;
    } else if (activity.kind === "moment") {
      track.momentCount += 1;
    } else {
      track.structureCount += 1;
    }
  }

  return [...tracks.values()]
    .map(({ controls, devices, ...track }) => ({
      ...track,
      controlCount: controls.size,
      // Two different facts that used to be squashed into one number with
      // Math.max: how long the chain is, and how much of it was worked on. The
      // squashed version reported "3 devices observed" on a track where two
      // were touched, because the chain happened to hold three.
      shapedDeviceCount: devices.size,
      chainDeviceCount: Math.max(track.chainDeviceCount, devices.size),
      workLabel: workLabel(track.workCounts),
      workKinds: dominantProducerWork(track.workCounts).observed,
    }))
    .sort((a, b) => {
      if (a.number !== null && b.number !== null) return a.number - b.number;
      if (a.number !== null) return -1;
      if (b.number !== null) return 1;
      return b.actionCount - a.actionCount || a.name.localeCompare(b.name);
    });
}

function seriesOf(activities: NormalizedSessionActivity[], bucketCount = 24): ReportSeriesBucket[] {
  if (activities.length === 0) return [];
  const startMs = activities[0]?.atMs ?? 0;
  const lastMs = activities.at(-1)?.atMs ?? startMs;
  const span = Math.max(1, lastMs - startMs);
  const count = Math.max(1, Math.min(bucketCount, Math.ceil(activities.length / 2)));
  const width = span / count;
  const buckets = Array.from({ length: count }, (_, index): ReportSeriesBucket => ({
    index,
    startMs: startMs + width * index,
    endMs: index === count - 1 ? lastMs : startMs + width * (index + 1),
    total: 0,
    move: 0,
    midi: 0,
    clip: 0,
    structure: 0,
    moment: 0,
    workCounts: emptyProducerWorkCounts(),
  }));
  for (const activity of activities) {
    const index = Math.min(count - 1, Math.floor(((activity.atMs - startMs) / span) * count));
    const bucket = buckets[Math.max(0, index)];
    if (!bucket) continue;
    bucket.total += 1;
    bucket.workCounts[producerWorkKindForActivity(activity)] += 1;
    if (activity.kind === "move") bucket.move += 1;
    else if (activity.kind === "midi") bucket.midi += 1;
    else if (activity.kind === "clip") bucket.clip += 1;
    else if (activity.kind === "moment") bucket.moment += 1;
    else bucket.structure += 1;
  }
  return buckets;
}

function workSectionsOf(decisions: ReportDecision[]): ReportWorkSection[] {
  return PRODUCER_WORK_LEGEND.map((definition) => {
    const sectionDecisions = decisions.filter((decision) => decision.workKind === definition.id);
    const evidenceIds = [...new Set(sectionDecisions.flatMap((decision) => decision.evidenceIds))];
    return {
      kind: definition.id,
      label: definition.label,
      description: definition.description,
      evidenceRule: definition.evidenceRule,
      decisionCount: sectionDecisions.length,
      sourceEventCount: evidenceIds.length,
      decisionIds: sectionDecisions.map((decision) => decision.id),
      evidenceIds,
    };
  });
}

// Two passages this far apart are two separate stretches of attention no matter
// how similar the work was. Inside it, work of the same kind on the same track
// is one thing the producer was doing, not several.
const CHAPTER_GAP_MS = 10 * 60 * 1000;

// A passage this small is a blip: one fader move, one note edit. Two blips on
// the same track, minutes apart, are one stretch of attention.
const CHAPTER_BLIP_ROWS = 2;

function capturedRows(passage: SessionPassage): number {
  return Object.values(passage.workCounts).reduce((total, count) => total + count, 0);
}

function focusKey(passage: SessionPassage): string {
  return [...passage.primaryTrackNames].sort().join("|");
}

function shouldJoinChapter(previous: SessionPassage, next: SessionPassage): boolean {
  if (next.startMs - previous.endMs > CHAPTER_GAP_MS) return false;
  // Mixing is cross-track by nature. Three faders on three tracks in five
  // minutes is one act of balancing, and splitting it into three numbered steps
  // says the producer did three things.
  if (previous.kind === "mixing" && next.kind === "mixing") return true;
  const focus = focusKey(previous);
  if (focus === "" || focus !== focusKey(next)) return false;
  if (previous.kind === next.kind) return true;
  return capturedRows(previous) <= CHAPTER_BLIP_ROWS && capturedRows(next) <= CHAPTER_BLIP_ROWS;
}

function mergeCounts(a: ProducerWorkCounts, b: ProducerWorkCounts): ProducerWorkCounts {
  const merged = emptyProducerWorkCounts();
  for (const kind of Object.keys(merged) as ProducerWorkKind[]) merged[kind] = a[kind] + b[kind];
  return merged;
}

function mergeTrackCounts(
  a: SessionPassage["primaryTrackCounts"],
  b: SessionPassage["primaryTrackCounts"],
): SessionPassage["primaryTrackCounts"] {
  const totals = new Map<string, number>();
  for (const entry of [...a, ...b]) totals.set(entry.name, (totals.get(entry.name) ?? 0) + entry.count);
  return [...totals.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name));
}

function mergeControls(a: PassageControl[], b: PassageControl[]): PassageControl[] {
  const merged = new Map<string, PassageControl>();
  for (const control of [...a, ...b]) {
    const key = `${control.trackName ?? ""}${control.deviceName ?? ""}${control.parameterName}`;
    const current = merged.get(key);
    if (!current) {
      merged.set(key, { ...control });
      continue;
    }
    // Passages arrive in time order, so the earlier one holds where the control
    // started and the later one where it was left. Keeping the first `before`
    // and the last `after` is what makes the chapter report a net decision
    // rather than the last nudge inside it.
    current.count += control.count;
    current.afterDisplay = control.afterDisplay ?? current.afterDisplay;
  }
  return [...merged.values()].sort(
    (left, right) => right.count - left.count || left.parameterName.localeCompare(right.parameterName),
  );
}

function joinPassages(previous: SessionPassage, next: SessionPassage): SessionPassage {
  const workCounts = mergeCounts(previous.workCounts, next.workCounts);
  const primaryWorkCounts = mergeCounts(previous.primaryWorkCounts, next.primaryWorkCounts);
  const { kind, label } = passageKind(primaryWorkCounts, workCounts);
  const primaryTrackCounts = mergeTrackCounts(previous.primaryTrackCounts, next.primaryTrackCounts);
  return {
    ...previous,
    kind,
    label,
    workCounts,
    primaryWorkCounts,
    workKinds: dominantProducerWork(workCounts).observed,
    endMs: Math.max(previous.endMs, next.endMs),
    actionCount: previous.actionCount + next.actionCount,
    controlMoveCount: previous.controlMoveCount + next.controlMoveCount,
    midiEditCount: previous.midiEditCount + next.midiEditCount,
    clipEventCount: previous.clipEventCount + next.clipEventCount,
    structureEventCount: previous.structureEventCount + next.structureEventCount,
    markerCount: previous.markerCount + next.markerCount,
    markers: [...previous.markers, ...next.markers],
    sourceLabels: [...new Set([...previous.sourceLabels, ...next.sourceLabels])],
    trackNames: [...new Set([...previous.trackNames, ...next.trackNames])],
    primaryTrackNames: primaryTrackCounts.map((entry) => entry.name),
    primaryTrackCounts,
    primaryTrackName: primaryTrackCounts[0]?.name ?? null,
    observedArrangementPositions: [
      ...new Set([...previous.observedArrangementPositions, ...next.observedArrangementPositions]),
    ].slice(0, 4),
    lastAction: next.lastAction ?? previous.lastAction,
    controls: mergeControls(previous.controls, next.controls).slice(0, 3),
  };
}

/**
 * The session at reading altitude.
 *
 * The analysis splits on a two-minute pause, which is right for the timeline —
 * it is a magnifying glass. Read as a walkthrough it produced twelve numbered
 * steps for a seventy-eight minute session, nine of them a single captured row
 * stamped "0 sec", which tells a producer nothing they can use. Chapters join
 * adjacent passages that were plainly the same piece of work, and leave the
 * underlying passages untouched for the surfaces that want them.
 */
export function reportChapters(passages: SessionPassage[]): SessionPassage[] {
  const chapters: SessionPassage[] = [];
  for (const passage of passages) {
    const current = chapters.at(-1);
    if (current && shouldJoinChapter(current, passage)) {
      chapters[chapters.length - 1] = joinPassages(current, passage);
      continue;
    }
    chapters.push(passage);
  }
  return chapters.map((chapter, index) => ({
    ...chapter,
    order: index + 1,
    pathPosition:
      chapters.length === 1 ? "only" : index === 0 ? "start" : index === chapters.length - 1 ? "finish" : "middle",
  }));
}

function ledgerOf(
  activities: NormalizedSessionActivity[],
  decisions: ReportDecision[],
  tracks: ReportTrack[],
  schema: ProjectSchema | null,
): ReportLedger {
  const moves = activities.filter(
    (activity): activity is Extract<NormalizedSessionActivity, { kind: "move" }> => activity.kind === "move",
  );
  const handsOnCount = activities.filter(
    (activity) => activity.kind === "move" || activity.kind === "midi" || activity.kind === "clip",
  ).length;
  const momentCount = activities.filter((activity) => activity.kind === "moment").length;
  const capturedCount = activities.length;

  return {
    capturedCount,
    handsOnCount,
    // Defined as the remainder so the three slices always sum to the whole,
    // even if a new activity kind is added upstream without touching this file.
    reportedCount: capturedCount - handsOnCount - momentCount,
    momentCount,
    decisionCount: decisions.length,
    groupedCount: capturedCount - decisions.length,
    controlCount: new Set(
      moves.map((move) => `${move.trackId ?? move.trackName ?? ""}${controlLabel(move.deviceName, move.parameterName)}`),
    ).size,
    deviceCount: new Set(
      moves
        .map((move) => move.deviceName)
        .filter((name): name is string => Boolean(name) && !isMixerDevice(name)),
    ).size,
    mixerTouched: moves.some((move) => isMixerDevice(move.deviceName)),
    tracksTouched: tracks.filter((track) => track.sourceEventCount > 0).length,
    tracksInSet: schema ? tracks.length : null,
  };
}

/**
 * The report's own audit. Returns a plain-language description of every way the
 * numbers fail to reconcile, and an empty list when they all agree.
 *
 * This exists because the defects it checks for all shipped once: decisions
 * outnumbered actions, the device tally counted a channel strip, and track
 * rollups disagreed with the rows they were rolled up from. Anything the
 * producer is asked to trust has to be checkable, and a check that only lives
 * in a reviewer's head is not one.
 */
export function reportInvariants(report: SessionReport): string[] {
  const { ledger } = report;
  const problems: string[] = [];
  const evidenceCount = Object.keys(report.evidence).length;

  if (ledger.handsOnCount + ledger.reportedCount + ledger.momentCount !== ledger.capturedCount) {
    problems.push(
      `Captured rows do not add up: ${ledger.handsOnCount} hands-on + ${ledger.reportedCount} reported + ${ledger.momentCount} moments ≠ ${ledger.capturedCount} captured.`,
    );
  }
  if (evidenceCount !== ledger.capturedCount) {
    problems.push(`The ledger counts ${ledger.capturedCount} captured rows but ${evidenceCount} are addressable as evidence.`);
  }
  if (ledger.decisionCount > ledger.capturedCount) {
    problems.push(`More decisions (${ledger.decisionCount}) than captured rows (${ledger.capturedCount}); a decision can only group rows, never invent them.`);
  }
  if (ledger.tracksInSet !== null && ledger.tracksTouched > ledger.tracksInSet) {
    problems.push(`More tracks touched (${ledger.tracksTouched}) than exist in the captured set (${ledger.tracksInSet}).`);
  }

  const decisionEvidence = new Set(report.decisions.flatMap((decision) => decision.evidenceIds));
  if (decisionEvidence.size !== ledger.capturedCount) {
    problems.push(`${ledger.capturedCount - decisionEvidence.size} captured rows are not reachable from any decision.`);
  }
  const orphan = [...decisionEvidence].find((id) => !report.evidence[id]);
  if (orphan) problems.push(`A decision cites evidence "${orphan}" that the report cannot show.`);

  const sectionRows = report.workSections.reduce((total, section) => total + section.sourceEventCount, 0);
  if (sectionRows !== ledger.capturedCount) {
    problems.push(`Work areas account for ${sectionRows} captured rows out of ${ledger.capturedCount}; the percentages would not total 100%.`);
  }
  const sectionDecisions = report.workSections.reduce((total, section) => total + section.decisionCount, 0);
  if (sectionDecisions !== ledger.decisionCount) {
    problems.push(`Work areas account for ${sectionDecisions} decisions out of ${ledger.decisionCount}.`);
  }

  const trackRows = report.tracks.reduce((total, track) => total + track.sourceEventCount, 0);
  if (trackRows > ledger.capturedCount) {
    problems.push(`Track rollups claim ${trackRows} captured rows, more than the ${ledger.capturedCount} captured.`);
  }
  const overShaped = report.tracks.find((track) => track.shapedDeviceCount > track.chainDeviceCount);
  if (overShaped) {
    problems.push(`${overShaped.name} reports ${overShaped.shapedDeviceCount} devices shaped but only ${overShaped.chainDeviceCount} in its chain.`);
  }

  return problems;
}

function trustOf(input: SessionReportInput): ReportTrust {
  const coverage = captureCoverage(input.session.events);
  const coverageDetail = describeCaptureCoverage(coverage);
  if (coverage.partial && coverageDetail) {
    return { level: "partial", label: "Some controls were out of view", detail: coverageDetail };
  }
  if (
    input.session.take_origin === "scanned" ||
    input.session.events.length === 0 ||
    !input.session.events.some((event) => event.type === "focus_changed")
  ) {
    return {
      level: "unknown",
      label: "Recall was not watching",
      detail: "This version was read from the .als file after the fact, so what follows is the set as saved — not a record of the work that made it.",
    };
  }
  return {
    level: "clear",
    label: "Recall was watching throughout",
    detail: "Every control on the tracks you touched stayed in view. Nothing below was reconstructed after the fact.",
  };
}

function lessonsOf(
  tracks: ReportTrack[],
  decisions: ReportDecision[],
  sourceEventCount: number,
): ReportLesson[] {
  const lessons: ReportLesson[] = [];
  const focus = tracks
    .filter((track) => track.sourceEventCount > 0)
    .sort((a, b) => b.sourceEventCount - a.sourceEventCount || a.name.localeCompare(b.name))[0];
  if (focus) {
    const share = sourceEventCount > 0 ? Math.round((focus.sourceEventCount / sourceEventCount) * 100) : 0;
    lessons.push({
      id: "focus",
      label: "Where your attention went",
      title: focus.name,
      detail: `${share}% of everything captured this version happened here — ${focus.sourceEventCount} of ${sourceEventCount} changes. Mostly ${focus.workLabel.toLocaleLowerCase()}.`,
      evidenceIds: focus.evidenceIds,
    });
  }

  const iteration = decisions
    .filter((decision) => decision.count > 1 && decision.kind === "control")
    .sort((a, b) => b.count - a.count || b.endMs - a.endMs)[0];
  if (iteration) {
    lessons.push({
      id: "iteration",
      label: "What you kept coming back to",
      title: iteration.subject,
      detail: `You moved it ${iteration.count} times before settling on ${iteration.outcome}.`,
      evidenceIds: iteration.evidenceIds,
    });
  }

  const carry = [...decisions]
    .filter((decision) => decision.kind === "moment")
    .sort((a, b) => b.atMs - a.atMs)[0];
  const closingDecision = [...decisions]
    .filter((decision) => decision.kind !== "moment")
    .sort((a, b) => b.endMs - a.endMs)[0];
  if (carry) {
    lessons.push({
      id: "carry",
      label: "What you said to keep",
      title: carry.subject,
      detail: carry.outcome,
      evidenceIds: carry.evidenceIds,
    });
  } else if (closingDecision) {
    lessons.push({
      id: "carry",
      label: "Where you left it",
      title: closingDecision.subject,
      detail: `The last thing you changed: ${closingDecision.outcome}.`,
      evidenceIds: closingDecision.evidenceIds,
    });
  }

  return lessons;
}

export function buildSessionReport(input: SessionReportInput): SessionReport {
  const memoryEvents = producerMemoryEvents(input.session.events);
  const analysisInput = {
    changes: input.changes,
    noteEdits: input.noteEdits,
    clipEvents: input.clipEvents,
    memoryEvents,
    moments: input.moments,
    sessionStartedAtMs: input.session.started_at_ms,
  };
  const analysis = analyzeSession(analysisInput);
  const activities = normalizedSessionActivities(analysisInput);
  const trackNameOf = trackNameResolver(input.schema);
  const evidenceEntries = activities.map((activity) => evidenceOf(activity, trackNameOf));
  const evidence = Object.fromEntries(evidenceEntries.map((item) => [item.id, item]));
  const decisions = decisionsOf(activities, trackNameOf);
  const tracks = tracksOf(input.schema, activities, trackNameOf);
  const stamps = activities.map((activity) => activity.atMs);
  const activityStartMs = stamps.length > 0 ? Math.min(...stamps) : null;
  const activityEndMs = stamps.length > 0 ? Math.max(...stamps) : null;
  const handsOnMs = activeDurationMs(stamps, input.session.ended_at_ms === null ? Date.now() : null);
  const wallClockMs = Math.max(0, (input.session.ended_at_ms ?? activityEndMs ?? Date.now()) - input.session.started_at_ms);

  return {
    session: input.session,
    schema: input.schema,
    analysis,
    trust: trustOf(input),
    handsOnMs,
    wallClockMs,
    activityStartMs,
    activityEndMs,
    chapters: reportChapters(analysis.passages),
    ledger: ledgerOf(activities, decisions, tracks, input.schema),
    summaryText: analysis.pathSummary ?? "Recall has not seen enough work yet to describe this version.",
    tracks,
    decisions,
    workSections: workSectionsOf(decisions),
    lessons: lessonsOf(tracks, decisions, Object.keys(evidence).length),
    series: seriesOf(activities),
    evidence,
  };
}

export function compareSessionReports(current: SessionReport, baseline: SessionReport): ReportComparison {
  const currentKeys = new Set(current.decisions.map((decision) => decision.key));
  const baselineKeys = new Set(baseline.decisions.map((decision) => decision.key));
  const metric = (
    label: string,
    currentValue: number,
    baselineValue: number,
    format: ReportComparisonMetric["format"] = "number",
  ): ReportComparisonMetric => ({
    label,
    current: currentValue,
    baseline: baselineValue,
    delta: currentValue - baselineValue,
    format,
  });

  return {
    metrics: [
      metric("Time at the desk", current.handsOnMs, baseline.handsOnMs, "duration"),
      metric("Changes captured", current.ledger.capturedCount, baseline.ledger.capturedCount),
      metric("Decisions", current.ledger.decisionCount, baseline.ledger.decisionCount),
      metric("Tracks touched", current.ledger.tracksTouched, baseline.ledger.tracksTouched),
      metric("MIDI edits", current.analysis.midiEditCount, baseline.analysis.midiEditCount),
      metric("Moments saved", current.ledger.momentCount, baseline.ledger.momentCount),
    ],
    structural: current.schema && baseline.schema ? compareSchemas(baseline.schema, current.schema) : null,
    onlyCurrent: current.decisions.filter((decision) => !baselineKeys.has(decision.key)),
    onlyBaseline: baseline.decisions.filter((decision) => !currentKeys.has(decision.key)),
  };
}
