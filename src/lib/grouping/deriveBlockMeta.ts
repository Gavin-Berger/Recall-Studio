import type { RecallTimelineMoment } from "../../types/recall";
import type { ActivityAnalytics, ActivityCategory } from "../../types/activities";

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
  const paramCount = events.filter((e) => e.type === "parameter").length;
  const clipCount = events.filter((e) => e.type === "clip").length;
  const arrangementCount = events.filter((e) => e.type === "arrangement").length;

  if (clipCount > deviceCount + paramCount) return "arrangement";
  if (arrangementCount > clipCount + deviceCount) return "arrangement";
  if (deviceCount > 0 || paramCount > 3) return "sound_design";

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

  const clipsCreated = [
    ...new Set(
      events
        .filter((e) => e.type === "clip")
        .map((e) => (e.metadata?.clip as string | undefined) ?? e.summary)
        .filter(Boolean),
    ),
  ];

  const tracksVisited = [
    ...new Set(events.filter((e) => e.trackName).map((e) => e.trackName!)),
  ];

  const playbackCount = events.filter(
    (e) => e.type === "transport" && e.metadata?.playing === true,
  ).length;

  const parameterChangeCount = events.filter((e) => e.type === "parameter").length;

  return {
    playbackCount,
    parameterChangeCount,
    devicesAdded,
    clipsCreated,
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
