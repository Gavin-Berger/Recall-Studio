// Shared session date/duration formatting for the project + recap screens, so
// the two surfaces render takes identically.

import type { SavedSessionMetadata } from "../types";

export function formatSessionDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function formatSessionDuration(session: SavedSessionMetadata): string {
  if (session.ended_at_ms === null) return "In progress";
  const ms = Math.max(0, session.ended_at_ms - session.started_at_ms);
  const totalMinutes = Math.floor(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return "< 1m";
}
