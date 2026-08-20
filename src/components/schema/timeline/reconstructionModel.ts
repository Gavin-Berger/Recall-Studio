import type { TrackObj } from "../../../types/schema";
import { describeActivity, formatClock, formatMoveValue } from "./format";
import type { Activity } from "./types";

export type MusicalPosition = {
  bar: number;
  beat: number | null;
  label: string;
};

export type ReconstructionEvent = {
  id: string;
  activity: Activity;
  track: TrackObj | null;
  trackName: string;
  position: MusicalPosition | null;
  endPosition: MusicalPosition | null;
  category: "part" | "automation" | "sound" | "mix" | "note" | "song" | "recording" | "structure" | "performance" | "project";
  title: string;
  summary: string;
};

export type BuildStep = {
  id: string;
  startMs: number;
  endMs: number;
  trackId: string;
  trackName: string;
  events: ReconstructionEvent[];
  title: string;
  summary: string;
};

export type Recipe = {
  id: string;
  what: string;
  track: string;
  where: string;
  when: string;
  change: string;
  context: string[];
  evidence: string;
  missing: string[];
};

const BUILD_STEP_GAP_MS = 90_000;

export function parseMusicalPosition(value: string | null | undefined): MusicalPosition | null {
  if (!value) return null;
  const barMatch = value.match(/\bBar\s+(\d+)/i);
  if (!barMatch) return null;
  const beatMatch = value.match(/\bBeat\s+(\d+)/i);
  const bar = Number(barMatch[1]);
  const beat = beatMatch ? Number(beatMatch[1]) : null;
  if (!Number.isFinite(bar) || bar < 1) return null;
  return { bar, beat: beat && Number.isFinite(beat) ? beat : null, label: value };
}

function eventCategory(activity: Activity): ReconstructionEvent["category"] {
  if (activity.kind === "memory") return activity.memoryCategory ?? "structure";
  if (activity.kind === "clip" || activity.kind === "noteEdit") return "part";
  if (activity.kind === "note") return "note";
  if (activity.automation) return "automation";
  if (activity.deviceName === "Mixer") return "mix";
  return "sound";
}

function eventTitle(activity: Activity): string {
  if (activity.kind === "memory") return activity.memoryTitle ?? "Song change";
  if (activity.kind === "clip") {
    const name = activity.assetName ?? activity.clipName ?? "clip";
    if (activity.eventType === "audio_clip_recorded") return `Recorded ${name}`;
    if (activity.eventType === "midi_clip_recorded") return `Recorded MIDI: ${name}`;
    return `Added ${name}`;
  }
  if (activity.kind === "noteEdit") return `${activity.clipName || "MIDI clip"} · notes ${activity.changeKind ?? "edited"}`;
  if (activity.kind === "note") return activity.title || "Producer note";
  return [activity.deviceName ?? "Device", activity.paramName ?? "parameter"].join(" · ");
}

export function buildReconstructionEvents(activities: Activity[], tracks: TrackObj[]): ReconstructionEvent[] {
  const tracksById = new Map(tracks.map((track) => [track.id, track]));
  return [...activities]
    .sort((a, b) => a.atMs - b.atMs)
    .map((activity) => {
      const track = tracksById.get(activity.trackId) ?? null;
      return {
        id: activity.id,
        activity,
        track,
        trackName: track?.name?.trim() || (track?.type === "master" ? "Main" : "Track"),
        position: parseMusicalPosition(
          activity.automationStartPosition ?? activity.observedArrangementPosition,
        ),
        endPosition: parseMusicalPosition(activity.automationEndPosition),
        category: eventCategory(activity),
        title: eventTitle(activity),
        summary: describeActivity(activity),
      };
    });
}

export function buildBuildSteps(events: ReconstructionEvent[]): BuildStep[] {
  const steps: BuildStep[] = [];
  for (const event of events) {
    const previous = steps[steps.length - 1];
    const joinsPrevious = previous &&
      previous.trackId === event.activity.trackId &&
      event.activity.atMs - previous.endMs <= BUILD_STEP_GAP_MS;
    if (!joinsPrevious) {
      steps.push({
        id: `step-${event.id}`,
        startMs: event.activity.atMs,
        endMs: event.activity.atMs,
        trackId: event.activity.trackId,
        trackName: event.trackName,
        events: [event],
        title: event.title,
        summary: event.summary,
      });
      continue;
    }
    previous.endMs = event.activity.atMs;
    previous.events.push(event);
    const categories = new Set(previous.events.map((item) => item.category));
    previous.title = previous.events.length === 1
      ? event.title
      : `${previous.trackName} · ${previous.events.length} captured decisions`;
    previous.summary = [...categories].map((category) => category === "part" ? "parts" : category).join(" · ");
  }
  return steps;
}

function recipeChange(activity: Activity): string {
  if (activity.kind === "memory") return activity.memorySummary ?? activity.memoryTitle ?? "Changed";
  if (activity.kind !== "move") return describeActivity(activity);
  const before = formatMoveValue(activity.before, activity.beforePercent, activity.unit, activity.beforeDisplay);
  const after = formatMoveValue(activity.after, activity.afterPercent, activity.unit, activity.afterDisplay);
  const hasBefore = activity.before !== null && activity.before !== undefined || Boolean(activity.beforeDisplay);
  return hasBefore ? `${before} → ${after}` : `Set to ${after}`;
}

export function buildRecipe(event: ReconstructionEvent): Recipe {
  const { activity, track } = event;
  const devices = activity.kind === "memory" ? [] : track?.devices
    .slice()
    .sort((a, b) => a.chain_index - b.chain_index)
    .map((device) => device.name || device.class_name || "Device") ?? [];
  const hasObjectRange = activity.arrangementStartBeats !== null &&
    activity.arrangementStartBeats !== undefined;
  const objectRange = hasObjectRange
    ? activity.arrangementEndBeats !== null &&
        activity.arrangementEndBeats !== undefined &&
        activity.arrangementEndBeats !== activity.arrangementStartBeats
      ? `Arrangement beats ${activity.arrangementStartBeats}–${activity.arrangementEndBeats}`
      : `Arrangement beat ${activity.arrangementStartBeats}`
    : null;
  const observedLocation = event.position
    ? event.endPosition && event.endPosition.label !== event.position.label
      ? `${event.position.label} → ${event.endPosition.label}`
      : `${event.position.label}${activity.automation ? "" : " · playhead observed"}`
    : null;
  const location = objectRange ?? observedLocation ?? "Arrangement position was not captured";
  const missing: string[] = [];
  if (!objectRange && !event.position) missing.push("No arrangement or playhead location for this event");
  const hasSource = activity.evidence?.facts.some((fact) => fact.label === "Source") ?? false;
  if (activity.kind === "clip" && !activity.assetName && !hasSource) missing.push("No recoverable sample reference");
  if (activity.kind === "noteEdit" && !activity.evidence?.midiNotes.length) {
    missing.push("Note onsets were summarized, not stored individually");
  }
  if (activity.automation && !activity.evidence?.automationPoints.length) {
    missing.push("The automation envelope points were not stored");
  }
  if (activity.kind === "move" && !track) missing.push("Track snapshot unavailable for chain context");

  return {
    id: event.id,
    what: event.title,
    track: event.trackName,
    where: location,
    when: formatClock(activity.atMs),
    change: recipeChange(activity),
    context: devices.length ? [`Device chain: ${devices.join(" → ")}`] : [],
    evidence: hasObjectRange
      ? `Live reported the object’s exact Arrangement beat range${observedLocation ? `; ${observedLocation}` : ""}.`
      : activity.automation
      ? "Observed while Live reported an automation write. The bar positions locate the producer’s action, not the full envelope."
      : event.position
        ? "Captured directly from Ableton with the playhead position observed when Recall recorded this move."
        : "Captured directly from the Ableton event stream.",
    missing,
  };
}
