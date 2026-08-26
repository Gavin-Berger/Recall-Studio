// What this capture could and could not see.
//
// Recall's path is only trustworthy if its silences are honest. Two very
// different facts render identically today: "you did nothing on that control"
// and "that control was outside what the bridge was watching". The second is a
// property of the capture, and the producer can only account for it if we say
// it out loud.
//
// The bridge reports its own coverage on every `focus_changed`: how many
// parameters it attached listeners to, how many the track actually publishes,
// and which devices exceeded the per-device listener cap. This module folds
// those reports into one statement per capture.

import type { SavedSessionEvent } from "../../../types/recall";

export type TruncatedDevice = {
  deviceName: string;
  watched: number;
  available: number;
};

export type CaptureCoverage = {
  /** Devices that published more controls than the bridge could watch. */
  truncatedDevices: TruncatedDevice[];
  /** Controls published by those devices that no listener was attached to. */
  unwatchedParameterCount: number;
  /** True when at least one device was only partially watched. */
  partial: boolean;
  /**
   * Lower-cased names of every track the bridge ever attached device listeners
   * to, in the order it first saw them.
   *
   * This is the second kind of blind spot, and until now the report had no
   * word for it. `_attach_to_focused_device` binds parameter listeners to
   * `song.view.selected_track` only — mixer controls are the documented
   * exception — so a track the producer never selected in Live publishes
   * nothing, reports no truncation, and is indistinguishable from a track they
   * simply did not work on. Every `focus_changed` names the track it attached
   * to, including the no-devices path, so the set costs nothing to collect.
   */
  watchedTrackNames: string[];
  /** True when at least one `focus_changed` was recorded at all. */
  observed: boolean;
};

function payloadOf(event: SavedSessionEvent): Record<string, unknown> {
  if (!event.payload) return {};
  try {
    const parsed = JSON.parse(event.payload) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function positiveInt(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
}

function cleanName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  // Live reports an absent text property as a literal "0"; rendering that as a
  // device name would put a bare zero in the coverage line.
  return trimmed && trimmed !== "0" ? trimmed : null;
}

export function captureCoverage(events: SavedSessionEvent[]): CaptureCoverage {
  // Keep the widest reading per device rather than the latest. A device is
  // re-reported every time the producer selects its track, and the honest
  // statement about the whole capture is the largest gap that ever existed.
  const worstByDevice = new Map<string, TruncatedDevice>();
  const watchedTracks = new Set<string>();
  let observed = false;

  for (const event of events) {
    if (event.type !== "focus_changed") continue;
    observed = true;
    const payload = payloadOf(event);
    // Read the track before the truncation guard below. A focus_changed with no
    // devices still proves the bridge was watching that track, and it is the
    // path that reports an empty `truncated_devices` — skipping it here would
    // mean an empty track never counted as watched.
    const watched = cleanName(payload.track_name) ?? cleanName(event.track);
    if (watched) watchedTracks.add(watched.toLocaleLowerCase());
    const devices = payload.truncated_devices;
    if (!Array.isArray(devices)) continue;
    for (const entry of devices) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const record = entry as Record<string, unknown>;
      const deviceName = cleanName(record.device_name) ?? "Unnamed device";
      const watched = positiveInt(record.watched);
      const available = positiveInt(record.available);
      if (watched === null || available === null || available <= watched) continue;
      const current = worstByDevice.get(deviceName);
      if (!current || available - watched > current.available - current.watched) {
        worstByDevice.set(deviceName, { deviceName, watched, available });
      }
    }
  }

  const truncatedDevices = [...worstByDevice.values()].sort(
    (a, b) => b.available - b.watched - (a.available - a.watched) || a.deviceName.localeCompare(b.deviceName),
  );
  const unwatchedParameterCount = truncatedDevices.reduce(
    (total, device) => total + (device.available - device.watched),
    0,
  );

  return {
    truncatedDevices,
    unwatchedParameterCount,
    partial: truncatedDevices.length > 0,
    watchedTrackNames: [...watchedTracks],
    observed,
  };
}

/**
 * Was this track ever in view?
 *
 * Answers with `null` rather than `false` when the capture recorded no
 * `focus_changed` at all — a scanned take knows nothing about what was
 * watched, and saying "not watched" there would be as much of an invention as
 * saying "untouched".
 */
export function trackWasWatched(coverage: CaptureCoverage, trackName: string | null): boolean | null {
  if (!coverage.observed) return null;
  const name = trackName?.trim().toLocaleLowerCase();
  if (!name) return null;
  return coverage.watchedTrackNames.includes(name);
}

/** One plain sentence for the coverage footer, or null when coverage was full. */
export function describeCaptureCoverage(coverage: CaptureCoverage): string | null {
  if (!coverage.partial) return null;
  const names = coverage.truncatedDevices.slice(0, 2).map((device) => device.deviceName);
  const remaining = coverage.truncatedDevices.length - names.length;
  const where = remaining > 0 ? `${names.join(", ")} and ${remaining} more` : names.join(" and ");
  const controls =
    coverage.unwatchedParameterCount === 1 ? "1 control" : `${coverage.unwatchedParameterCount} controls`;
  return `${controls} on ${where} were outside capture range — moves there were not recorded.`;
}
