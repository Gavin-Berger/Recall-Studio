// Display formatting for the schema timeline: values, durations, the take title,
// and per-track/device colors. Pure — no React, no I/O.

import type { DeviceObj, SavedSessionMetadata, TrackObj } from "../../../types";
import type { Activity } from "./types";

export function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  // Promote to h:mm:ss past an hour so a long session's axis can't be mistaken
  // for minutes:seconds.
  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
  }
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

// Human, scannable take title. Auto-generated names (the raw "Session <epoch>"
// the backend assigns) are replaced with the session's date + start time so the
// header reads like a memory, not a database row.
export function formatTakeTitle(
  session: SavedSessionMetadata | null,
  schemaName: string | null,
): string {
  const raw = session?.name?.trim();
  const isAutoName = !raw || /^session[-\s]?\d+$/i.test(raw);
  if (raw && !isAutoName) return raw;
  if (session?.started_at_ms) {
    const date = new Date(session.started_at_ms);
    const day = date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    const time = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    return `${day} · ${time}`;
  }
  return schemaName ?? "Take";
}

// Compact human duration for the header ("26 min", "1 hr 12 min", "48 sec").
export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds} sec`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes} min`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes > 0 ? `${hours} hr ${minutes} min` : `${hours} hr`;
}

function formatNum(value: number): string {
  return Number.isInteger(value) ? String(value) : (Math.round(value * 100) / 100).toString();
}

function formatValue(value: number | null | undefined, unit: string | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return unit ? `${formatNum(value)} ${unit}` : formatNum(value);
}

export function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? `${rounded}%` : `${rounded.toFixed(1)}%`;
}

export function formatMoveValue(
  value: number | null | undefined,
  percent: number | null | undefined,
  unit: string | null | undefined,
  display?: string | null,
): string {
  // The Live-formatted string ("440 Hz", "Sinefold", "1") is the truest
  // representation of what the producer saw, so it wins when present.
  if (display !== null && display !== undefined && display !== "") {
    return display;
  }
  return percent !== null && percent !== undefined
    ? formatPercent(percent)
    : formatValue(value, unit);
}

export function describeActivity(item: Activity): string {
  if (item.kind === "note") return item.title ?? "Note";
  const where = [item.deviceName, item.paramName].filter(Boolean).join(" · ");
  return `${where}: ${formatMoveValue(item.before, item.beforePercent, item.unit, item.beforeDisplay)} → ${formatMoveValue(
    item.after,
    item.afterPercent,
    item.unit,
    item.afterDisplay,
  )}`;
}

const TRACK_FALLBACK: Record<TrackObj["type"], string> = {
  midi: "#6382ff",
  audio: "#aaccf0",
  return: "#f0cfa0",
  group: "#9c88ff",
  master: "#9aa3c4",
};

export function trackColor(track: TrackObj): string {
  if (track.color && /^#[0-9a-fA-F]{6}$/.test(track.color)) return track.color;
  return TRACK_FALLBACK[track.type];
}

export function deviceColor(device: DeviceObj): string {
  if (device.role === "instrument") return "#9c88ff";
  if (device.role === "midi_effect") return "#6382ff";
  return "#5ab4a0";
}
