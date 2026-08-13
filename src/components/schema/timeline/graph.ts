// Data shaping for the schema timeline's geometry: track/parameter lookups, the
// time→x projection, the cumulative activity spark paths, and the axis ticks.
// Pure — no React, no I/O.

import type {
  CreativeMoment,
  ParameterObj,
  ProjectSchema,
} from "../../../types/schema";
import type { Lookups } from "./types";
import { formatWhen } from "./format";

export type TimelineBounds = {
  start: number;
  span: number;
  sessionStart?: number;
};

export function buildLookups(schema: ProjectSchema | null): Lookups {
  const paramTrack = new Map<string, string>();
  const deviceTrack = new Map<string, string>();
  const nameTrack = new Map<string, string>();
  const abletonTrack = new Map<string, string>();
  if (!schema) return { paramTrack, deviceTrack, nameTrack, abletonTrack };

  const walkParams = (params: ParameterObj[], trackId: string) => {
    for (const param of params) {
      paramTrack.set(param.id, trackId);
      if (param.children.length > 0) walkParams(param.children, trackId);
    }
  };

  for (const track of schema.tracks) {
    if (track.name) nameTrack.set(track.name.toLowerCase(), track.id);
    if (track.ableton_id) abletonTrack.set(track.ableton_id, track.id);
    for (const device of track.devices) {
      deviceTrack.set(device.id, track.id);
      walkParams(device.parameters, track.id);
    }
  }
  return { paramTrack, deviceTrack, nameTrack, abletonTrack };
}

export function noteTrackId(moment: CreativeMoment, lookups: Lookups): string | null {
  for (const target of moment.targets) {
    if (target.target_type === "track") return target.target_id;
    if (target.target_type === "device") {
      const trackId = lookups.deviceTrack.get(target.target_id);
      if (trackId) return trackId;
    }
    if (target.target_type === "parameter" || target.target_type === "parameter_change") {
      const trackId = lookups.paramTrack.get(target.target_id);
      if (trackId) return trackId;
    }
  }
  return null;
}

export function pct(atMs: number, bounds: TimelineBounds): number {
  if (bounds.span <= 0) return 50;
  const value = ((atMs - bounds.start) / bounds.span) * 100;
  return Math.min(100, Math.max(0, value));
}

// Build a cumulative step-line (and matching filled area) for one lane's moves,
// in a 0–100 × 0–100 viewBox drawn with preserveAspectRatio="none". The curve
// stays flat then steps up at each move, so its rising height tells the story of
// how much a channel was touched. `globalMax` is shared across lanes so the
// busiest channel peaks at the top. Returns null when there's nothing to draw.
export function cumulativeMovePaths(
  moveTimes: number[],
  bounds: { start: number; span: number },
  globalMax: number,
  xEnd: number,
): { line: string; area: string } | null {
  if (moveTimes.length === 0 || globalMax <= 0) return null;

  const TOP_PAD = 8; // leaves headroom so the tallest curve isn't clipped
  const f = (n: number) => n.toFixed(2);
  const y = (count: number) => 100 - (count / globalMax) * (100 - TOP_PAD);

  let line = `M 0 ${f(y(0))}`;
  moveTimes.forEach((atMs, index) => {
    const x = pct(atMs, bounds);
    // Hold the previous level to this move's x, then step up by one.
    line += ` L ${f(x)} ${f(y(index))} L ${f(x)} ${f(y(index + 1))}`;
  });
  // Carry the final level out to the right edge.
  line += ` L ${f(xEnd)} ${f(y(moveTimes.length))}`;

  const area = `${line} L ${f(xEnd)} 100 Z`;
  return { line, area };
}

export function buildTicks(bounds: TimelineBounds): Array<{ pct: number; label: string }> {
  const steps = 4;
  const out: Array<{ pct: number; label: string }> = [];
  for (let i = 0; i <= steps; i += 1) {
    // Label each tick by how far into the session it sits, so the axis and the
    // change-list timestamps share one clock (elapsed from session start).
    const atMs = bounds.start + (bounds.span * i) / steps;
    out.push({
      pct: (i / steps) * 100,
      label: formatWhen(atMs, bounds.sessionStart ?? bounds.start, bounds.span),
    });
  }
  return out;
}
