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

// Past this span, elapsed-from-session-start stops being readable: "39:24:22"
// is a number you have to decode, and nobody remembers a moment as "thirty-nine
// hours in". A take this long means the set was left open across sittings, so
// the useful question becomes "when did I do that", answered by the clock.
// Four hours: longer than any single sitting, short enough that a take spanning
// two of them switches over.
export const LONG_TAKE_MS = 4 * 60 * 60 * 1000;

export function formatClock(atMs: number): string {
  return new Date(atMs).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

// The timestamp column, in whichever clock the take's length calls for. Every
// surface takes it from here so the axis, the story rows and the blocks can
// never disagree about which clock they are on.
export function formatWhen(atMs: number, sessionStart: number, spanMs: number): string {
  return spanMs > LONG_TAKE_MS ? formatClock(atMs) : formatElapsed(atMs - sessionStart);
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

// A set left open overnight is not 39 hours of work. Wall-clock span (start → now)
// misrepresents idle takes, so the header reports *active* time instead: recorded
// activity timestamps cluster into blocks split on silences longer than the idle
// gap, and each block counts first→last plus a small pad (so one isolated move
// still registers as a minute, not zero). While recording, "now" only extends the
// current block if the producer moved something recently — an idle take stops
// accruing time the moment they stop.
export const ACTIVE_IDLE_GAP_MS = 10 * 60 * 1000;
const ACTIVE_BLOCK_PAD_MS = 60 * 1000;

export function activeDurationMs(timestamps: number[], nowMs: number | null = null): number {
  const sorted = timestamps
    .filter((stamp) => Number.isFinite(stamp) && stamp > 0)
    .sort((a, b) => a - b);
  if (
    nowMs !== null &&
    sorted.length > 0 &&
    nowMs - sorted[sorted.length - 1] > 0 &&
    nowMs - sorted[sorted.length - 1] <= ACTIVE_IDLE_GAP_MS
  ) {
    sorted.push(nowMs);
  }
  if (sorted.length === 0) return 0;

  let total = 0;
  let blockStart = sorted[0];
  let previous = sorted[0];
  for (const stamp of sorted.slice(1)) {
    if (stamp - previous > ACTIVE_IDLE_GAP_MS) {
      total += previous - blockStart + ACTIVE_BLOCK_PAD_MS;
      blockStart = stamp;
    }
    previous = stamp;
  }
  total += previous - blockStart + ACTIVE_BLOCK_PAD_MS;
  return total;
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

// One-line phrase for a MIDI note edit. The bridge's own summary wins — it was
// written with Live's note naming in hand — and this only reassembles a line
// when an older payload didn't carry one.
// Live leaves a clip unnamed as often as not, and reports that as an empty
// string (or a literal "0" — its sentinel for an absent text property). Either
// one rendered raw leaves a row labelled " · notes" with a hole where the clip
// should be.
export function clipLabel(name: string | null | undefined): string {
  const trimmed = name?.trim();
  if (!trimmed || trimmed === "0") return "Untitled clip";
  return trimmed;
}

function notesLabel(count: number): string {
  return count === 1 ? "1 note" : `${count} notes`;
}

export function describeNoteEdit(item: Activity): string {
  if (item.summary) return item.summary;
  if (item.changeKind === "cleared") {
    return `Cleared ${notesLabel(item.previousNoteCount ?? 0)}`;
  }
  const count = item.noteCount ?? 0;
  const delta =
    item.previousNoteCount !== null &&
    item.previousNoteCount !== undefined &&
    item.previousNoteCount !== count
      ? ` (${count - item.previousNoteCount > 0 ? "+" : ""}${count - item.previousNoteCount})`
      : "";
  // Show the range as a transition when it actually moved — widening a part by
  // an octave is the change, and "C1-G2" alone would hide it.
  const range =
    item.pitchRange && item.previousPitchRange && item.previousPitchRange !== item.pitchRange
      ? `${item.previousPitchRange} → ${item.pitchRange}`
      : item.pitchRange;
  return [`${notesLabel(count)}${delta}`, range].filter(Boolean).join(", ");
}

export function describeActivity(item: Activity): string {
  if (item.kind === "note") return item.title ?? "Note";
  if (item.kind === "noteEdit") {
    return `${clipLabel(item.clipName)}: ${describeNoteEdit(item)}`;
  }
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
