import type { RecallTimelineMoment, SessionStats } from "../types/recall";

export type SessionInsight = {
  label: string;
  value: string;
  detail: string;
};

export function buildSessionInsights(
  events: RecallTimelineMoment[],
  stats: SessionStats,
): SessionInsight[] {
  const topTrack = mostCommon(events.map((event) => event.trackName ?? readMetadata(event, "track")));
  const topGroup = mostCommon(events.map((event) => event.groupName ?? readMetadata(event, "group")));
  const topDevice = mostCommon(events.map((event) => event.deviceName ?? readMetadata(event, "device")));
  const parameterNames = events
    .filter((event) => event.type === "parameter")
    .map((event) => readMetadata(event, "parameter"))
    .filter((value): value is string => Boolean(value));
  const tempoEvents = events.filter((event) => event.type === "tempo");
  const clipEvents = events.filter((event) => event.type === "clip");
  const transportEvents = events.filter((event) => event.type === "transport");
  const insights: SessionInsight[] = [];

  insights.push({
    label: "Session shape",
    value: describeSessionShape(stats),
    detail: `${stats.creativeEvents} creative moves, ${stats.trackEvents} track moves, ${stats.deviceEvents} device moves.`,
  });

  insights.push({
    label: "Focus track",
    value: topTrack?.value ?? "Not established",
    detail: topTrack
      ? `${topTrack.count} captured moves referenced this track.`
      : "Select or edit tracks in Ableton to establish session focus.",
  });

  insights.push({
    label: "Track group",
    value: topGroup?.value ?? "No group focus",
    detail: topGroup
      ? `${topGroup.count} captured moves happened inside this group.`
      : "Group-aware events will show arrangement structure when the bridge reports group paths.",
  });

  insights.push({
    label: "Device center",
    value: topDevice?.value ?? "No device focus",
    detail: topDevice
      ? `${topDevice.count} moves involved this device.`
      : "Open or edit instruments/effects to build device memory.",
  });

  insights.push({
    label: "Automation clue",
    value: parameterNames.length > 0 ? `${parameterNames.length} edits` : "No parameter edits",
    detail:
      parameterNames.length > 0
        ? `Recent controls: ${unique(parameterNames).slice(0, 3).join(", ")}.`
        : "Parameter movement will become arrangement and sound-design clues.",
  });

  insights.push({
    label: "Arrangement energy",
    value: describeArrangementEnergy(tempoEvents.length, clipEvents.length, transportEvents.length),
    detail: `${tempoEvents.length} tempo moves, ${clipEvents.length} clip moves, ${transportEvents.length} transport moves.`,
  });

  return insights;
}

export function buildProducerSummary(
  events: RecallTimelineMoment[],
  stats: SessionStats,
): string {
  if (events.length === 0) {
    return "No creative decisions have been captured yet.";
  }

  const insights = buildSessionInsights(events, stats);
  const focus = insights.find((insight) => insight.label === "Focus track")?.value;
  const device = insights.find((insight) => insight.label === "Device center")?.value;
  const group = insights.find((insight) => insight.label === "Track group")?.value;

  return [
    `${stats.creativeEvents} creative moves captured.`,
    group && group !== "No group focus" ? `Group focus: ${group}.` : null,
    focus && focus !== "Not established" ? `Primary focus: ${focus}.` : null,
    device && device !== "No device focus" ? `Device focus: ${device}.` : null,
  ]
    .filter(Boolean)
    .join(" ");
}

function readMetadata(event: RecallTimelineMoment, key: string): string | undefined {
  const value = event.metadata?.[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function mostCommon(values: Array<string | undefined>) {
  const counts = new Map<string, number>();

  values.forEach((value) => {
    if (!value) return;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  });

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([value, count]) => ({ value, count }))[0];
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function describeSessionShape(stats: SessionStats): string {
  if (stats.creativeEvents === 0) return "Waiting";
  if (stats.parameterEvents >= stats.trackEvents + stats.deviceEvents) return "Sound design";
  if (stats.trackEvents > stats.deviceEvents && stats.trackEvents > 1) return "Track focus";
  if (stats.deviceEvents > 0) return "Device work";
  return "Capture started";
}

function describeArrangementEnergy(
  tempoCount: number,
  clipCount: number,
  transportCount: number,
): string {
  if (tempoCount + clipCount + transportCount === 0) return "Not moving yet";
  if (clipCount > tempoCount && clipCount > transportCount) return "Session View activity";
  if (tempoCount > 0) return "Tempo shaping";
  if (transportCount > 0) return "Playback pass";
  return "Light activity";
}
