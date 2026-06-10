import type { RecallTimelineMoment } from "../../types/recall";
import type { ActivityAnalytics, ActivityCategory } from "../../types/activities";
import {
  SAMPLE_EVENT_TYPES,
  AUTOMATION_EVENT_TYPES,
} from "../../utils/producerEvents";

// Small helpers so analytics agree with the producer-facing category split:
// a sample drag-in is a sample (not a clip), and automation is automation (not a
// raw parameter tweak). Both read off the canonical raw-type sets.
function isSampleEvent(event: RecallTimelineMoment): boolean {
  const raw = event.rawEventType?.toLowerCase();
  return !!raw && SAMPLE_EVENT_TYPES.has(raw);
}

function isAutomationEvent(event: RecallTimelineMoment): boolean {
  const raw = event.rawEventType?.toLowerCase();
  return !!raw && AUTOMATION_EVENT_TYPES.has(raw);
}

// Recording a take is its own mode of working ("tracking"), distinct from
// building clips. Covers both the clip-slot recording events the bridge emits
// today and the arrangement-level recording events reserved in the catalog.
const RECORDING_EVENT_TYPES = new Set([
  "clip_recording_started",
  "clip_recording_stopped",
  "recording_started",
  "recording_stopped",
]);

function isRecordingEvent(event: RecallTimelineMoment): boolean {
  const raw = event.rawEventType?.toLowerCase();
  return !!raw && RECORDING_EVENT_TYPES.has(raw);
}

function readMeta(event: RecallTimelineMoment, key: string): string | undefined {
  const value = event.metadata?.[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

// ── Primary track ────────────────────────────────────────────────────────────

export function derivePrimaryTrack(events: RecallTimelineMoment[]): string | null {
  const counts = new Map<string, number>();
  for (const event of events) {
    const track = event.trackName ?? (event.metadata?.track as string | undefined);
    if (track) {
      counts.set(track, (counts.get(track) ?? 0) + 1);
    }
  }
  if (counts.size === 0) return null;
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

// ── Category ─────────────────────────────────────────────────────────────────

export function deriveCategory(
  events: RecallTimelineMoment[],
  primaryTrack: string | null,
): ActivityCategory {
  const trackLower = primaryTrack?.toLowerCase() ?? "";

  if (
    trackLower.includes("master") ||
    trackLower.includes("mix") ||
    trackLower.includes("bus") ||
    trackLower.includes("sum")
  ) {
    return "mixing";
  }

  const deviceCount = events.filter((e) => e.type === "device").length;
  const sampleCount = events.filter(isSampleEvent).length;
  const automationCount = events.filter(isAutomationEvent).length;
  // Raw parameter tweaks, excluding automation writes (their own creative act).
  const paramCount = events.filter(
    (e) => e.type === "parameter" && !isAutomationEvent(e),
  ).length;
  // Real clips only — exclude samples (sound selection) and recordings (tracking),
  // which are counted as their own signals below.
  const realClipCount = events.filter(
    (e) => e.type === "clip" && !isSampleEvent(e) && !isRecordingEvent(e),
  ).length;
  const sceneCount = events.filter((e) => e.type === "scene").length;
  const arrangementCount = events.filter((e) => e.type === "arrangement").length;
  const recordingSignal = events.filter(isRecordingEvent).length;

  // Sound-shaping: loading devices, choosing samples, writing automation, and
  // heavy parameter tweaking are all "designing the sound".
  const soundDesignSignal =
    deviceCount + sampleCount + automationCount + (paramCount > 3 ? 1 : 0);
  // Structure: building MIDI/audio clips, scenes, and arrangement edits.
  const arrangementSignal = realClipCount + sceneCount + arrangementCount;

  // Recording a take is a distinct mode — when it's the dominant activity in the
  // block, the producer was tracking, not designing or arranging.
  if (
    recordingSignal > 0 &&
    recordingSignal >= soundDesignSignal &&
    recordingSignal >= arrangementSignal
  ) {
    return "tracking";
  }
  if (arrangementSignal > soundDesignSignal && arrangementSignal > 0) {
    return "arrangement";
  }
  if (soundDesignSignal > 0) return "sound_design";

  return "general";
}

// ── Analytics ────────────────────────────────────────────────────────────────

export function buildAnalytics(events: RecallTimelineMoment[]): ActivityAnalytics {
  const devicesAdded = [
    ...new Set(
      events
        .filter((e) => e.type === "device" && e.deviceName)
        .map((e) => e.deviceName!),
    ),
  ];

  // Samples dropped in — by their file/sample name (falling back to clip name).
  const samplesAdded = [
    ...new Set(
      events
        .filter(isSampleEvent)
        .map((e) => readMeta(e, "sample") ?? readMeta(e, "clip"))
        .filter((name): name is string => Boolean(name)),
    ),
  ];

  // Real clips only — samples are tracked separately above, so exclude them here
  // to avoid double-counting a Splice drag-in as both a sample and a clip.
  const clipsCreated = [
    ...new Set(
      events
        .filter((e) => e.type === "clip" && !isSampleEvent(e))
        .map((e) => (e.metadata?.clip as string | undefined) ?? e.summary)
        .filter(Boolean),
    ),
  ];

  // Parameters automation was written on (e.g. "Filter Cutoff").
  const automationTargets = [
    ...new Set(
      events
        .filter(isAutomationEvent)
        .map((e) => readMeta(e, "parameter"))
        .filter((name): name is string => Boolean(name)),
    ),
  ];

  const tracksVisited = [
    ...new Set(events.filter((e) => e.trackName).map((e) => e.trackName!)),
  ];

  const playbackCount = events.filter(
    (e) => e.type === "transport" && e.metadata?.playing === true,
  ).length;

  // Raw parameter tweaks, excluding automation writes (those are creative acts
  // surfaced separately as automationTargets).
  const parameterChangeCount = events.filter(
    (e) => e.type === "parameter" && !isAutomationEvent(e),
  ).length;

  return {
    playbackCount,
    parameterChangeCount,
    devicesAdded,
    samplesAdded,
    clipsCreated,
    automationTargets,
    tracksVisited,
  };
}

// ── Title ────────────────────────────────────────────────────────────────────

export function deriveTitle(
  category: ActivityCategory,
  primaryTrack: string | null,
): string {
  if (primaryTrack) {
    switch (category) {
      case "sound_design":
        return `Worked on ${primaryTrack}`;
      case "arrangement":
        return `Arranged ${primaryTrack}`;
      case "mixing":
        return `Mixed ${primaryTrack}`;
      case "tracking":
        return `Recorded ${primaryTrack}`;
      default:
        return `Worked on ${primaryTrack}`;
    }
  }

  switch (category) {
    case "sound_design":
      return "Sound design";
    case "arrangement":
      return "Arrangement work";
    case "mixing":
      return "Mix session";
    case "tracking":
      return "Recording session";
    default:
      return "Session activity";
  }
}

// ── Key actions ──────────────────────────────────────────────────────────────

export function deriveKeyActions(
  visibleEvents: RecallTimelineMoment[],
  analytics: ActivityAnalytics,
): string[] {
  const actions: string[] = [];

  for (const device of analytics.devicesAdded.slice(0, 3)) {
    actions.push(`Added ${device}`);
  }

  for (const sample of analytics.samplesAdded.slice(0, 2)) {
    actions.push(`Dropped in ${sample}`);
  }

  for (const target of analytics.automationTargets.slice(0, 2)) {
    actions.push(`Automated ${target}`);
  }

  for (const clip of analytics.clipsCreated.slice(0, 2)) {
    actions.push(`Created ${clip}`);
  }

  if (analytics.parameterChangeCount > 0) {
    actions.push(
      `Adjusted ${analytics.parameterChangeCount} parameter${analytics.parameterChangeCount === 1 ? "" : "s"}`,
    );
  }

  if (analytics.playbackCount > 1) {
    actions.push(`Replayed section ${analytics.playbackCount} times`);
  } else if (analytics.playbackCount === 1) {
    actions.push("Replayed section once");
  }

  // Fall back to event summaries if no structured actions were found.
  if (actions.length === 0) {
    for (const event of visibleEvents.slice(0, 4)) {
      if (event.summary) {
        actions.push(event.summary);
      }
    }
  }

  return actions;
}

// ── Summary text ─────────────────────────────────────────────────────────────

export function buildSummary(
  durationMs: number,
  primaryTrack: string | null,
  analytics: ActivityAnalytics,
): string {
  const parts: string[] = [];
  const dur = formatDurationText(durationMs);

  if (primaryTrack && durationMs >= 60_000) {
    parts.push(`Spent ${dur} working on ${primaryTrack}.`);
  } else if (durationMs >= 60_000) {
    parts.push(`${dur} of activity.`);
  }

  if (analytics.devicesAdded.length > 0) {
    const listed = analytics.devicesAdded.slice(0, 3).join(", ");
    const overflow =
      analytics.devicesAdded.length > 3
        ? ` and ${analytics.devicesAdded.length - 3} more`
        : "";
    parts.push(`Added ${listed}${overflow}.`);
  }

  if (analytics.samplesAdded.length === 1) {
    parts.push(`Dropped in ${analytics.samplesAdded[0]}.`);
  } else if (analytics.samplesAdded.length > 1) {
    parts.push(`Dropped in ${analytics.samplesAdded.length} samples.`);
  }

  if (analytics.automationTargets.length === 1) {
    parts.push(`Automated ${analytics.automationTargets[0]}.`);
  } else if (analytics.automationTargets.length > 1) {
    parts.push(`Automated ${analytics.automationTargets.length} parameters.`);
  }

  if (analytics.clipsCreated.length === 1) {
    parts.push(`Created ${analytics.clipsCreated[0]}.`);
  } else if (analytics.clipsCreated.length > 1) {
    parts.push(`Created ${analytics.clipsCreated.length} clips.`);
  }

  if (analytics.parameterChangeCount > 5) {
    parts.push(`Made ${analytics.parameterChangeCount} parameter adjustments.`);
  }

  if (analytics.playbackCount > 1) {
    parts.push(`Replayed the section ${analytics.playbackCount} times.`);
  } else if (analytics.playbackCount === 1) {
    parts.push("Replayed the section once.");
  }

  if (analytics.tracksVisited.length > 1) {
    parts.push(`Moved across ${analytics.tracksVisited.length} tracks.`);
  }

  return parts.length > 0 ? parts.join(" ") : "Creative session activity.";
}

function formatDurationText(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "less than a minute";
  if (minutes === 1) return "1 minute";
  return `${minutes} minutes`;
}
