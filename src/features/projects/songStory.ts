// The Song Story engine — reconstruct a project's life as a sequence of
// "sittings" from its move history, and give each a soft, inferred sense of what
// kind of work it was. Pure: no React, no I/O. The screen feeds it a flat,
// cross-take activity stream and renders the Sitting[] it returns.
//
// A sitting is a stretch of work bounded by a long enough silence. This is the
// unit the arc is built from — reliable, because it comes straight from the
// timestamps, and independent of whether the producer saves new .als versions.

import type { DeviceRole, ParameterChange, TrackType } from "../../types/schema";

// The identity a track is grouped by: its stable id when known, else its bare
// name. Two different Ableton tracks can share a name — Ableton auto-names a
// track after the first device dropped on it, so it's easy to end up with two
// tracks both called "Serum 2" — but never a track_id. Preferring the id is
// what keeps them from being folded into one entry everywhere this engine
// groups by track. Activity with neither is grouped under "" (all such moves
// share one bucket, same as the old name-only behavior for untracked moves).
function trackKey(trackId: string | null, trackName: string | null): string {
  return trackId || trackName || "";
}

// One recorded act, flattened across every take of the project. `role` and
// `trackType` are resolved by the caller from the latest schema so the classifier
// can tell a synth tweak from an EQ move without re-deriving lookups here.
export type StoryActivity = {
  atMs: number;
  trackName: string | null;
  trackId: string | null;
  deviceName: string | null;
  role: DeviceRole | null;
  trackType: TrackType | null;
  // A clip/sample insertion is a concrete production move. It participates in
  // sitting boundaries and move totals, but not device-role classification.
  kind: "move" | "noteEdit" | "clip" | "memory";
};

// What a sitting looked like, in producer terms rather than "kind" flags.
export type SittingKind = "foundation" | "sound_design" | "arrangement" | "mix" | "session";

export type Sitting = {
  id: string;
  index: number;
  startMs: number;
  endMs: number;
  activeMs: number;
  moveCount: number;
  noteEditCount: number;
  // Tracks worked this sitting, most-active first.
  tracksTouched: string[];
  // Tracks that appear for the FIRST time in the whole project history here.
  newTracks: string[];
  // Tracks worked this sitting that already existed (touched, not introduced),
  // most-active first.
  reworkedTracks: string[];
  kind: SittingKind;
  // Soft, hedged phrase for the UI — never stated as fact (DESIGN.md "never
  // pretend"). Always begins "looks like…" except the neutral fallback.
  label: string;
};

// A gap longer than this ends a sitting. Three hours: long enough that a dinner
// break mid-session doesn't split one sitting in two, short enough that picking
// the project back up the next day reads as a new one. Tunable.
export const SITTING_GAP_MS = 3 * 60 * 60 * 1000;

// Idle gap that stops hands-on time from accruing *within* a sitting, so a
// sitting left open while the producer listens doesn't inflate its minutes.
const ACTIVE_IDLE_GAP_MS = 10 * 60 * 1000;
const ACTIVE_BLOCK_PAD_MS = 60 * 1000;

// Hands-on minutes inside one sitting: activity clusters split on short idles,
// each padded so a lone move still counts as a minute. (A local copy of the
// timeline's active-time logic, kept here so the engine stays dependency-free.)
function activeMs(timestamps: number[]): number {
  const sorted = timestamps.filter((t) => Number.isFinite(t)).sort((a, b) => a - b);
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

function rankByCount(counts: Map<string, number>): string[] {
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([name]) => name);
}

// Infer the character of a sitting from what dominated it. Deliberately modest:
// when nothing clearly leads, it says so ("a work session") rather than guessing.
// Every non-neutral label is hedged in the UI copy as "looks like…".
function classify(input: {
  index: number;
  moveCount: number;
  noteEditCount: number;
  newTrackCount: number;
  tracksTouchedCount: number;
  instrumentMoves: number;
  audioFxMoves: number;
  mixerMoves: number;
  touchedBus: boolean;
}): { kind: SittingKind; label: string } {
  const { moveCount, noteEditCount, newTrackCount } = input;
  const totalMoves = Math.max(1, moveCount);

  // Opening a project on empty tracks reads as laying the foundation.
  if (input.index === 0 && newTrackCount >= 2 && input.mixerMoves === 0) {
    return { kind: "foundation", label: "looks like laying foundations" };
  }
  // Bringing in new parts / writing MIDI is arrangement work.
  if (
    (newTrackCount >= 2 && input.mixerMoves === 0) ||
    noteEditCount >= Math.max(3, moveCount * 0.5)
  ) {
    return { kind: "arrangement", label: "looks like arrangement" };
  }
  // Mix work: deliberate mixer moves across channels, effect moves spread
  // across channels, or the Main/returns getting touched with effects.
  if (
    (input.mixerMoves / totalMoves >= 0.4 && input.tracksTouchedCount >= 2) ||
    (input.audioFxMoves / totalMoves >= 0.5 && input.tracksTouchedCount >= 3) ||
    (input.touchedBus && input.audioFxMoves >= 3)
  ) {
    return { kind: "mix", label: "looks like a mix pass" };
  }
  // Concentrated instrument tweaking is sound design.
  if (input.instrumentMoves / totalMoves >= 0.4) {
    return { kind: "sound_design", label: "looks like sound design" };
  }
  return { kind: "session", label: "a work session" };
}

function summarize(
  items: StoryActivity[],
  index: number,
  seenTracks: Set<string>,
): Sitting {
  const timestamps = items.map((item) => item.atMs);
  const startMs = Math.min(...timestamps);
  const endMs = Math.max(...timestamps);

  // Keyed by track identity (id-preferred), not the display name — see
  // `trackKey`. `keyToName` recovers the display name for the output arrays,
  // which stay name lists since that's what the UI renders.
  const trackMoves = new Map<string, number>();
  const keyToName = new Map<string, string>();
  let moveCount = 0;
  let noteEditCount = 0;
  let instrumentMoves = 0;
  let audioFxMoves = 0;
  let mixerMoves = 0;
  let touchedBus = false;

  for (const item of items) {
    if (item.kind === "noteEdit") noteEditCount += 1;
    else moveCount += 1;

    if (item.trackName) {
      const key = trackKey(item.trackId, item.trackName);
      trackMoves.set(key, (trackMoves.get(key) ?? 0) + 1);
      if (!keyToName.has(key)) keyToName.set(key, item.trackName);
    }
    if (item.kind === "move") {
      if (item.role === "instrument") instrumentMoves += 1;
      if (item.role === "audio_effect") audioFxMoves += 1;
      if (item.deviceName === "Mixer") mixerMoves += 1;
    }
    if (item.trackType === "master" || item.trackType === "return") touchedBus = true;
  }

  const touchedKeys = rankByCount(trackMoves);
  const tracksTouched = touchedKeys.map((key) => keyToName.get(key) ?? key);
  const newTracks: string[] = [];
  const reworkedTracks: string[] = [];
  for (const key of touchedKeys) {
    const name = keyToName.get(key) ?? key;
    if (seenTracks.has(key)) {
      reworkedTracks.push(name);
    } else {
      newTracks.push(name);
      seenTracks.add(key);
    }
  }

  const { kind, label } = classify({
    index,
    moveCount,
    noteEditCount,
    newTrackCount: newTracks.length,
    tracksTouchedCount: tracksTouched.length,
    instrumentMoves,
    audioFxMoves,
    mixerMoves,
    touchedBus,
  });

  return {
    id: `sit-${index}-${startMs}`,
    index,
    startMs,
    endMs,
    activeMs: activeMs(timestamps),
    moveCount,
    noteEditCount,
    tracksTouched,
    newTracks,
    reworkedTracks,
    kind,
    label,
  };
}

// Cluster a project's whole activity stream into sittings, oldest first. A
// "new track" is flagged the first sitting it ever appears in, so the arc shows
// where each part entered the song.
export function buildSittings(
  activities: StoryActivity[],
  gapMs: number = SITTING_GAP_MS,
): Sitting[] {
  const sorted = activities
    .filter((activity) => Number.isFinite(activity.atMs))
    .sort((a, b) => a.atMs - b.atMs);
  if (sorted.length === 0) return [];

  const clusters: StoryActivity[][] = [];
  let current: StoryActivity[] = [];
  let previous: number | null = null;
  for (const activity of sorted) {
    if (previous !== null && activity.atMs - previous > gapMs) {
      clusters.push(current);
      current = [];
    }
    current.push(activity);
    previous = activity.atMs;
  }
  if (current.length > 0) clusters.push(current);

  const seenTracks = new Set<string>();
  return clusters.map((items, index) => summarize(items, index, seenTracks));
}

// The single biggest sitting by move count — the "breakthrough" candidate. Null
// when there's nothing decisive (no sittings, or a lone one).
export function breakthroughIndex(sittings: Sitting[]): number | null {
  if (sittings.length < 2) return null;
  let best = 0;
  for (let i = 1; i < sittings.length; i += 1) {
    if (sittings[i].moveCount > sittings[best].moveCount) best = i;
  }
  return sittings[best].moveCount > 0 ? best : null;
}

// ── Contribution record: net changes, narrative, and the labour ledger ───────
//
// The recap half of the "did this work, here's how" record. Everything above is
// the *when* (sittings); this is the *what* — the concrete before→after state of
// each parameter that actually moved, and the plain-language work summary.

// One parameter's net change across the whole history: where it started, where
// it ended, and how many hands-on moves it took to get there.
export type NetChange = {
  trackName: string;
  trackId: string | null;
  deviceName: string | null;
  paramName: string | null;
  beforeDisplay: string;
  afterDisplay: string;
  count: number;
  firstMs: number;
  lastMs: number;
};

// Prefer the bridge's live-formatted string ("440 Hz", "Sinefold"); fall back to
// the raw value + unit, then the percent, then an em dash. Never invent a value.
function fmtValue(
  display: string | null,
  value: number | null,
  percent: number | null,
  unit: string | null,
): string {
  if (display && display.trim()) return display.trim();
  if (value !== null && Number.isFinite(value)) {
    const rounded = Math.abs(value) >= 100 ? Math.round(value) : Math.round(value * 100) / 100;
    return unit ? `${rounded} ${unit}` : String(rounded);
  }
  if (percent !== null && Number.isFinite(percent)) return `${Math.round(percent)}%`;
  return "—";
}

// Collapse a change stream to the net move per (track · device · parameter):
// earliest "before", latest "after", and the move count. Params whose start and
// end read the same are dropped — a knob wiggled back to where it began is
// labour, not a result, and this is the results half. Ranked by activity.
export function netChanges(changes: ParameterChange[]): NetChange[] {
  const byKey = new Map<string, NetChange>();
  for (const change of changes) {
    if (!change.track_name) continue;
    const key = `${trackKey(change.track_id, change.track_name)} ${change.device_name ?? ""} ${change.parameter_name ?? ""}`;
    const before = fmtValue(
      change.before_display_value,
      change.before_value,
      change.before_value_percent,
      change.unit,
    );
    const after = fmtValue(
      change.after_display_value,
      change.after_value,
      change.after_value_percent,
      change.unit,
    );
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, {
        trackName: change.track_name,
        trackId: change.track_id,
        deviceName: change.device_name,
        paramName: change.parameter_name,
        beforeDisplay: before,
        afterDisplay: after,
        count: 1,
        firstMs: change.changed_at_ms,
        lastMs: change.changed_at_ms,
      });
      continue;
    }
    existing.count += 1;
    if (change.changed_at_ms < existing.firstMs) {
      existing.firstMs = change.changed_at_ms;
      existing.beforeDisplay = before;
    }
    if (change.changed_at_ms >= existing.lastMs) {
      existing.lastMs = change.changed_at_ms;
      existing.afterDisplay = after;
    }
  }
  return [...byKey.values()]
    .filter((change) => change.beforeDisplay !== change.afterDisplay)
    .sort((a, b) => b.count - a.count || a.firstMs - b.firstMs);
}

// "A", "A and B", "A, B and 3 more" — a readable track list capped at `max`.
export function humanTracks(names: string[], max = 2): string {
  if (names.length === 0) return "";
  if (names.length === 1) return names[0];
  if (names.length <= max) {
    return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  }
  return `${names.slice(0, max).join(", ")} and ${names.length - max} more`;
}

// The one-line "what happened" for a sitting, in producer terms: which parts came
// in and which got reworked. Pairs with the sitting's hedged `label` in the UI.
export function sittingWork(sitting: Sitting): string {
  const parts: string[] = [];
  if (sitting.newTracks.length > 0) {
    parts.push(`brought in ${humanTracks(sitting.newTracks)}`);
  }
  if (sitting.reworkedTracks.length > 0) {
    parts.push(`${sitting.newTracks.length ? "reworked" : "shaped"} ${humanTracks(sitting.reworkedTracks)}`);
  }
  if (parts.length === 0 && sitting.tracksTouched.length > 0) {
    parts.push(`worked ${humanTracks(sitting.tracksTouched)}`);
  }
  return parts.join(", ") || "kept moving";
}

// The labour claim: totals across every sitting. Separate from credit (what
// survived) — this is effort, and it counts abandoned work too.
export type StoryLedger = {
  sittings: number;
  moves: number;
  noteEdits: number;
  activeMs: number;
  firstMs: number | null;
  lastMs: number | null;
  tracksShaped: number;
};

export function storyLedger(sittings: Sitting[]): StoryLedger {
  const tracks = new Set<string>();
  for (const sitting of sittings) {
    for (const name of sitting.tracksTouched) tracks.add(name);
  }
  return {
    sittings: sittings.length,
    moves: sittings.reduce((total, sitting) => total + sitting.moveCount, 0),
    noteEdits: sittings.reduce((total, sitting) => total + sitting.noteEditCount, 0),
    activeMs: sittings.reduce((total, sitting) => total + sitting.activeMs, 0),
    firstMs: sittings.length ? Math.min(...sittings.map((sitting) => sitting.startMs)) : null,
    lastMs: sittings.length ? Math.max(...sittings.map((sitting) => sitting.endMs)) : null,
    tracksShaped: tracks.size,
  };
}

// ── Take diff: what survived vs. what was cut ────────────────────────────────
//
// The credit/labour split from the record conversation, made real. `current` is
// the set of track names (lowercased) present in the latest take's schema — the
// delivered shape. Work on a track that is no longer there is real labour but
// earns no credit on the final project; it's kept, not deleted, just filed apart.

export type NetSplit = { survived: NetChange[]; cut: NetChange[] };

// With no current-shape known (single take, or schema still loading), everything
// counts as survived — never fabricate a "cut" from missing information.
export function splitBySurvival(recap: NetChange[], current: Set<string>): NetSplit {
  if (current.size === 0) return { survived: recap, cut: [] };
  const survived: NetChange[] = [];
  const cut: NetChange[] = [];
  for (const change of recap) {
    if (current.has(change.trackName.toLowerCase())) survived.push(change);
    else cut.push(change);
  }
  return { survived, cut };
}

// Roll a cut change list up to one entry per track, most-worked first — the
// labour line reads by track ("Pizz Strings — 31 moves, later cut"), not by knob.
export function cutTracks(cut: NetChange[]): { name: string; moves: number }[] {
  const byTrack = new Map<string, number>();
  for (const change of cut) {
    byTrack.set(change.trackName, (byTrack.get(change.trackName) ?? 0) + change.count);
  }
  return [...byTrack.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, moves]) => ({ name, moves }));
}

// ── Contribution, grouped by track ───────────────────────────────────────────
//
// A flat list of single parameter moves reads like "the last knob I touched".
// The work actually happened *per track*: a track collected many changes across
// several devices. This groups it that way — the headline is the volume (N
// changes across M devices), and the settled before→after values sit underneath.

export type TrackContribution = {
  // Stable identity for this entry — track_id when known, else the name. Use
  // this (not trackName) as a React key or a dedupe key: two different tracks
  // can share a display name.
  trackKey: string;
  trackName: string;
  trackId: string | null;
  changeCount: number; // every recorded move on the track, wiggles included
  deviceCount: number; // distinct devices (plugins) touched
  params: NetChange[]; // the parameters that netted a change, most-worked first
};

// Group a change stream by track: raw move count and distinct device count for
// the headline, plus the net-changed parameters for the drill-down. Ranked by
// how much work each track took. Grouped by track identity (id-preferred, see
// `trackKey`), not the raw name — two tracks sharing a name (Ableton auto-names
// a track after its first device, e.g. two separate "Serum 2" tracks) are kept
// as separate entries rather than merged into one.
export function groupByTrack(changes: ParameterChange[]): TrackContribution[] {
  const raw = new Map<
    string,
    { name: string; id: string | null; count: number; devices: Set<string> }
  >();
  for (const change of changes) {
    if (!change.track_name) continue;
    const key = trackKey(change.track_id, change.track_name);
    const entry = raw.get(key) ?? {
      name: change.track_name,
      id: change.track_id,
      count: 0,
      devices: new Set<string>(),
    };
    entry.count += 1;
    if (change.device_name) entry.devices.add(change.device_name);
    raw.set(key, entry);
  }

  const paramsByTrack = new Map<string, NetChange[]>();
  for (const net of netChanges(changes)) {
    const key = trackKey(net.trackId, net.trackName);
    const list = paramsByTrack.get(key) ?? [];
    list.push(net);
    paramsByTrack.set(key, list);
  }

  return [...raw.entries()]
    .map(([key, entry]) => ({
      trackKey: key,
      trackName: entry.name,
      trackId: entry.id,
      changeCount: entry.count,
      deviceCount: entry.devices.size,
      params: paramsByTrack.get(key) ?? [],
    }))
    .sort((a, b) => b.changeCount - a.changeCount);
}

export type TrackSplit = { survived: TrackContribution[]; cut: TrackContribution[] };

// The credit/labour split, at the track level: tracks present in the delivered
// take earn credit; tracks worked but no longer there are labour.
export function splitTracksBySurvival(
  groups: TrackContribution[],
  current: Set<string>,
): TrackSplit {
  if (current.size === 0) return { survived: groups, cut: [] };
  const survived: TrackContribution[] = [];
  const cut: TrackContribution[] = [];
  for (const group of groups) {
    if (current.has(group.trackName.toLowerCase())) survived.push(group);
    else cut.push(group);
  }
  return { survived, cut };
}
