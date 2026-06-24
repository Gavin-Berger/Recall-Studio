import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { listen } from "@tauri-apps/api/event";
import { save } from "@tauri-apps/plugin-dialog";
import "./SchemaTimeline.css";
import {
  createCreativeMoment,
  deleteCreativeMoment,
  getParameterChanges,
  getProjectSchema,
  listCreativeMoments,
  materializeSessionSchema,
  writeTextFile,
} from "../../lib/schema/api";
import {
  DEVICE_ROLE_LABEL,
  TRACK_TYPE_LABEL,
  type CreativeMoment,
  type DeviceObj,
  type ParameterChange,
  type ParameterObj,
  type ProjectSchema,
  type TrackObj,
} from "../../types/schema";
import type { SavedSessionMetadata } from "../../types/recall";

type LoadStatus = "idle" | "loading" | "ready" | "error";
type ExportFormat = "md" | "txt" | "json" | "pdf";

const LIVE_REFRESH_DEBOUNCE_MS = 700;
const LIVE_REFRESH_EVENT_TYPES = new Set([
  "parameter_changed",
  "device_parameter_changed",
  "automation_created",
  "selected_track_focus_snapshot",
  "live_set_snapshot",
  "device_added",
  "device_removed",
  "device_chain_changed",
]);

type LiveRecallEvent = {
  session_id?: string | null;
  event_type?: string | null;
};

// One thing that happened on a track this take — a knob move or a note.
type Activity = {
  id: string;
  kind: "move" | "note";
  trackId: string;
  atMs: number;
  // move
  deviceName?: string | null;
  paramName?: string | null;
  before?: number | null;
  after?: number | null;
  beforePercent?: number | null;
  afterPercent?: number | null;
  unit?: string | null;
  // Live-formatted display: mode name for quantized params ("Sinefold"), or the
  // unit-bearing value for continuous ones ("440 Hz"). Preferred over the raw
  // number/percent when present.
  beforeDisplay?: string | null;
  afterDisplay?: string | null;
  // Whether this parameter is categorical (a mode selector) rather than a
  // continuous value — drives pill-vs-number rendering and suppresses the
  // up/down direction caret (a mode flip has no direction).
  quantized?: boolean | null;
  // note
  title?: string;
  starred?: boolean;
};

// A run of consecutive same-parameter moves collapsed into one story row.
// `lead` is the newest move (its after-value is the net result); `items` holds
// every move in the run, newest-first, for the expanded view.
type ActivityGroup = {
  key: string;
  lead: Activity;
  items: Activity[];
};

// A session-wide "worth keeping" candidate — a starred note, a deliberate mode
// flip, or a large net parameter move — surfaced so the producer can flag what
// mattered without scrolling the full log.
type Highlight = {
  id: string;
  kind: "note" | "mode" | "move";
  momentId?: string;
  trackId: string | null;
  trackName: string | null;
  deviceName: string | null;
  paramName: string | null;
  before: number | null;
  beforePercent: number | null;
  beforeDisplay: string | null;
  after: number | null;
  afterPercent: number | null;
  afterDisplay: string | null;
  unit: string | null;
  title: string | null;
  starred: boolean;
  atMs: number;
  score: number;
  // Why this surfaced — shown on the card so the curation isn't a black box.
  reason: string;
  // Relative rank strength 0–1, for the per-card strength meter.
  strength: number;
};

export function SchemaTimeline({
  sessionId,
  session,
}: {
  sessionId: string | null;
  session: SavedSessionMetadata | null;
}) {
  const [schema, setSchema] = useState<ProjectSchema | null>(null);
  const [changes, setChanges] = useState<ParameterChange[]>([]);
  const [moments, setMoments] = useState<CreativeMoment[]>([]);
  const [status, setStatus] = useState<LoadStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [selectedTrackId, setSelectedTrackId] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState("");
  const [noteStar, setNoteStar] = useState(false);
  // Group ids the user expanded to see each move inside a collapsed run.
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  // Highlight ids the user has kept/flagged this session, for instant card feedback.
  const [keptHighlights, setKeptHighlights] = useState<Map<string, "keeper" | "working">>(new Map());
  // Keyboard-driven curation: which highlight card is focused in the rail.
  const [focusedCard, setFocusedCard] = useState(-1);
  const railRef = useRef<HTMLDivElement>(null);
  // Transient "Copied!" feedback for the share button.
  const [copied, setCopied] = useState(false);
  // Selected export format for copy/save.
  const [exportFormat, setExportFormat] = useState<ExportFormat>("md");

  const load = useCallback(
    async (rematerialize: boolean, quiet = false) => {
      if (!sessionId) return;
      if (!quiet) setStatus("loading");
      setError(null);
      try {
        if (rematerialize) await materializeSessionSchema(sessionId);
        const [nextSchema, nextChanges, nextMoments] = await Promise.all([
          getProjectSchema(sessionId),
          getParameterChanges(sessionId),
          listCreativeMoments(sessionId),
        ]);
        setSchema(nextSchema);
        setChanges(nextChanges);
        setMoments(nextMoments);
        setStatus("ready");
      } catch (loadError) {
        setError(String(loadError));
        setStatus("error");
      }
    },
    [sessionId],
  );

  useEffect(() => {
    setSchema(null);
    setChanges([]);
    setMoments([]);
    setSelectedTrackId(null);
    void load(true);
  }, [sessionId, load]);

  useEffect(() => {
    if (!sessionId || session?.ended_at_ms !== null) return;

    let disposed = false;
    let unlisten: (() => void) | null = null;
    let refreshTimer: number | null = null;

    const scheduleRefresh = () => {
      if (refreshTimer !== null) window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => {
        refreshTimer = null;
        void load(true, true);
      }, LIVE_REFRESH_DEBOUNCE_MS);
    };

    void listen<LiveRecallEvent>("recall-event", (event) => {
      const incoming = event.payload;
      if (incoming.session_id !== sessionId) return;
      const eventType = incoming.event_type ?? "";
      if (!LIVE_REFRESH_EVENT_TYPES.has(eventType)) return;
      scheduleRefresh();
    }).then((cleanup) => {
      if (disposed) {
        cleanup();
      } else {
        unlisten = cleanup;
      }
    });

    return () => {
      disposed = true;
      if (refreshTimer !== null) window.clearTimeout(refreshTimer);
      if (unlisten) unlisten();
    };
  }, [sessionId, session?.ended_at_ms, load]);

  const refreshMoments = useCallback(async () => {
    if (!sessionId) return;
    setMoments(await listCreativeMoments(sessionId));
  }, [sessionId]);

  // Lookups: which track owns a given parameter / device, so a change or a note
  // can be placed on the right lane.
  const lookups = useMemo(() => buildLookups(schema), [schema]);

  const tracks = useMemo(
    () => (schema ? [...schema.tracks].sort((a, b) => a.number - b.number) : []),
    [schema],
  );

  const bounds = useMemo(() => {
    const recording = session?.ended_at_ms === null;
    const sessionStart = session?.started_at_ms ?? (changes[0]?.changed_at_ms ?? Date.now());

    // Fit the axis to where work actually happened. A session left recording for
    // hours otherwise crushes every move into a sliver at the far left; we drop
    // that leading/trailing dead air by bounding to the first and last activity.
    const stamps: number[] = [];
    for (const change of changes) stamps.push(change.changed_at_ms);
    for (const moment of moments) stamps.push(moment.timeline_start_ms ?? moment.created_at_ms);

    let start: number;
    let end: number;
    if (stamps.length > 0) {
      start = Math.min(...stamps);
      end = Math.max(...stamps);
    } else {
      start = sessionStart;
      end = session?.ended_at_ms ?? Date.now();
    }

    // Breathing room so the first/last events aren't glued to the edges.
    const pad = Math.max((end - start) * 0.04, 1500);
    start -= pad;
    end += pad;
    if (end - start < 60_000) end = start + 60_000;

    return { start, end, span: end - start, recording, sessionStart };
  }, [session, changes, moments]);

  const activities = useMemo<Activity[]>(() => {
    const out: Activity[] = [];
    for (const change of changes) {
      const trackId =
        (change.parameter_id ? lookups.paramTrack.get(change.parameter_id) : undefined) ??
        (change.track_name ? lookups.nameTrack.get(change.track_name.toLowerCase()) : undefined);
      if (!trackId) continue;
      out.push({
        id: change.id,
        kind: "move",
        trackId,
        atMs: change.changed_at_ms,
        deviceName: change.device_name,
        paramName: change.parameter_name,
        before: change.before_value,
        after: change.after_value,
        beforePercent: change.before_value_percent,
        afterPercent: change.after_value_percent,
        unit: change.unit,
        beforeDisplay: change.before_display_value,
        afterDisplay: change.after_display_value,
        quantized: change.is_quantized,
      });
    }
    for (const moment of moments) {
      const trackId = noteTrackId(moment, lookups);
      if (!trackId) continue;
      out.push({
        id: moment.id,
        kind: "note",
        trackId,
        atMs: moment.timeline_start_ms ?? moment.created_at_ms,
        title: moment.title,
        starred: moment.confidence === "keeper" || moment.confidence === "final" || moment.tags.includes("keeper"),
      });
    }
    return out;
  }, [changes, moments, lookups]);

  const lanes = useMemo(
    () => tracks.map((track) => ({ track, items: activities.filter((a) => a.trackId === track.id) })),
    [tracks, activities],
  );

  // Shared y-scale for the per-lane activity graphs: the busiest channel peaks
  // at the top, so taller curve = more changes. Sorted move timestamps per lane
  // feed a cumulative step-line that builds left→right.
  const laneGraphs = useMemo(() => {
    const moveTimesByLane = new Map<string, number[]>();
    let maxMoves = 0;
    for (const lane of lanes) {
      const times = lane.items
        .filter((item) => item.kind === "move")
        .map((item) => item.atMs)
        .sort((a, b) => a - b);
      moveTimesByLane.set(lane.track.id, times);
      maxMoves = Math.max(maxMoves, times.length);
    }
    return { moveTimesByLane, maxMoves };
  }, [lanes]);

  // Right edge of every lane graph: the live playhead while recording, else the
  // full width so a finished take's curve reaches the end.
  const xEnd = bounds.recording ? pct(Date.now(), bounds) : 100;

  // Default the dock to the first track once a scan lands.
  useEffect(() => {
    if (tracks.length === 0) {
      if (selectedTrackId !== null) setSelectedTrackId(null);
      return;
    }
    if (!selectedTrackId || !tracks.some((track) => track.id === selectedTrackId)) {
      setSelectedTrackId(tracks[0].id);
    }
  }, [tracks, selectedTrackId]);

  const selectedTrack = tracks.find((track) => track.id === selectedTrackId) ?? null;
  const trackActivity = useMemo(
    () => activities.filter((a) => a.trackId === selectedTrackId).sort((a, b) => b.atMs - a.atMs),
    [activities, selectedTrackId],
  );
  const changedDeviceNames = useMemo(
    () => new Set(trackActivity.filter((a) => a.kind === "move" && a.deviceName).map((a) => a.deviceName as string)),
    [trackActivity],
  );

  // Collapse consecutive moves of the same device+parameter into one run so a
  // knob twiddled five times reads as a single decision (net before → after,
  // with a count), not five near-identical rows. Notes and switches between
  // params break a run. trackActivity is newest-first, so each group's lead is
  // its latest move and the net "before" comes from its oldest.
  const groupedActivity = useMemo<ActivityGroup[]>(() => {
    const out: ActivityGroup[] = [];
    for (const item of trackActivity) {
      const last = out[out.length - 1];
      const mergeable =
        item.kind === "move" &&
        last !== undefined &&
        last.lead.kind === "move" &&
        last.lead.deviceName === item.deviceName &&
        last.lead.paramName === item.paramName;
      if (mergeable) {
        last.items.push(item);
      } else {
        out.push({ key: item.id, lead: item, items: [item] });
      }
    }
    return out;
  }, [trackActivity]);

  // Headline for the dock: which device on this track you touched the most.
  const mostTouched = useMemo(() => {
    const tally = new Map<string, number>();
    for (const item of trackActivity) {
      if (item.kind !== "move" || !item.deviceName) continue;
      tally.set(item.deviceName, (tally.get(item.deviceName) ?? 0) + 1);
    }
    let best: { name: string; count: number } | null = null;
    for (const [name, count] of tally) {
      if (!best || count > best.count) best = { name, count };
    }
    return best;
  }, [trackActivity]);

  const moveCountForTrack = trackActivity.filter((a) => a.kind === "move").length;

  // Session-wide "worth keeping" candidates. Notes are intentional, so they rank
  // first; then deliberate mode flips; then the biggest net parameter swings.
  // Parameter changes are collapsed to one net move per device+param so the same
  // knob doesn't flood the rail.
  const highlights = useMemo<Highlight[]>(() => {
    const resolveTrackId = (change: ParameterChange): string | null =>
      (change.parameter_id ? lookups.paramTrack.get(change.parameter_id) : undefined) ??
      (change.track_name ? lookups.nameTrack.get(change.track_name.toLowerCase()) : undefined) ??
      null;

    const out: Highlight[] = [];

    for (const moment of moments) {
      const trackId = noteTrackId(moment, lookups);
      const starred =
        moment.confidence === "keeper" ||
        moment.confidence === "final" ||
        moment.tags.includes("keeper");
      out.push({
        id: `note-${moment.id}`,
        kind: "note",
        momentId: moment.id,
        trackId,
        trackName: trackId ? tracks.find((t) => t.id === trackId)?.name ?? null : null,
        deviceName: null,
        paramName: null,
        before: null,
        beforePercent: null,
        beforeDisplay: null,
        after: null,
        afterPercent: null,
        afterDisplay: null,
        unit: null,
        title: moment.title,
        starred,
        atMs: moment.timeline_start_ms ?? moment.created_at_ms,
        score: 10_000,
        reason: starred ? "★ Kept" : "★ Flagged",
        strength: 1,
      });
    }

    // Net change per device+param, walked in time order; count = how many times
    // you touched it (a strong "I cared" signal on its own).
    const sorted = [...changes].sort((a, b) => a.changed_at_ms - b.changed_at_ms);
    const byKey = new Map<string, { first: ParameterChange; last: ParameterChange; count: number }>();
    for (const change of sorted) {
      if (!change.parameter_name) continue;
      const key = `${change.track_name ?? ""}|${change.device_name ?? ""}|${change.parameter_name}`;
      const existing = byKey.get(key);
      if (existing) {
        existing.last = change;
        existing.count += 1;
      } else {
        byKey.set(key, { first: change, last: change, count: 1 });
      }
    }

    // Time range for recency weighting — recent moves get a gentle boost so the
    // rail feels live during a session, not frozen on early baseline tweaks.
    const firstMs = sorted.length > 0 ? sorted[0].changed_at_ms : 0;
    const lastMs = sorted.length > 0 ? sorted[sorted.length - 1].changed_at_ms : 1;
    const timeSpan = Math.max(lastMs - firstMs, 1);

    const moveHighlights: Highlight[] = [];
    for (const { first, last, count } of byKey.values()) {
      const magnitude =
        last.after_value_percent !== null &&
        last.after_value_percent !== undefined &&
        first.before_value_percent !== null &&
        first.before_value_percent !== undefined
          ? Math.abs(last.after_value_percent - first.before_value_percent)
          : last.is_quantized
            ? 60
            : 30;

      // Signals of "worth keeping", each its own contribution to the score:
      //  • iteration — you kept coming back to it (deliberate craft)
      //  • character — a mode/type flip changes the sound's identity
      //  • magnitude — a big swing is a decisive move
      //  • recency — gentle boost for later moves
      const iterationScore = count > 1 ? (count - 1) * 30 : 0;
      const characterScore = last.is_quantized ? 70 : 0;
      const magnitudeScore = magnitude;
      const recencyScore = ((last.changed_at_ms - firstMs) / timeSpan) * 35;
      const score = iterationScore + characterScore + magnitudeScore + recencyScore;

      // The reason shown is the strongest signal, with sensible thresholds so a
      // tiny one-off move doesn't claim "Big swing".
      let reason = "Move";
      if (count >= 3) reason = `Came back ${count}×`;
      else if (last.is_quantized) reason = "Character move";
      else if (magnitude >= 50) reason = "Big swing";
      else if (count === 2) reason = "Revisited";

      moveHighlights.push({
        id: `pc-${last.id}`,
        kind: last.is_quantized ? "mode" : "move",
        trackId: resolveTrackId(last),
        trackName: last.track_name,
        deviceName: last.device_name,
        paramName: last.parameter_name,
        before: first.before_value,
        beforePercent: first.before_value_percent,
        beforeDisplay: first.before_display_value,
        after: last.after_value,
        afterPercent: last.after_value_percent,
        afterDisplay: last.after_display_value,
        unit: last.unit,
        title: null,
        starred: false,
        atMs: last.changed_at_ms,
        score,
        reason,
        strength: 0,
      });
    }

    // Strength meter is relative to the strongest move this session.
    const maxMoveScore = Math.max(1, ...moveHighlights.map((h) => h.score));
    for (const h of moveHighlights) h.strength = Math.min(1, h.score / maxMoveScore);

    moveHighlights.sort((a, b) => b.score - a.score || b.atMs - a.atMs);

    // Diversity cap: at most 2 cards per device so one busy plugin can't fill the
    // rail — a spread of decisions across the track is more useful to recall. Fill
    // any remaining slots with the next-best regardless of device.
    const LIMIT = 8;
    const perDevice = new Map<string, number>();
    const picked: Highlight[] = [];
    const overflow: Highlight[] = [];
    for (const h of moveHighlights) {
      const dev = h.deviceName ?? "—";
      const used = perDevice.get(dev) ?? 0;
      if (used < 2) {
        perDevice.set(dev, used + 1);
        picked.push(h);
      } else {
        overflow.push(h);
      }
    }
    const moves = [...picked, ...overflow].slice(0, LIMIT);

    // Notes (intentional keeps) always lead, then the diversity-capped moves.
    return [...out, ...moves].slice(0, LIMIT + out.length);
  }, [changes, moments, lookups, tracks]);

  async function keepHighlight(highlight: Highlight, confidence: "keeper" | "working") {
    if (!sessionId || !highlight.trackId) return;
    const label =
      highlight.kind === "note"
        ? highlight.title ?? "Moment"
        : [highlight.deviceName, highlight.paramName].filter(Boolean).join(" · ") || "Move";
    try {
      await createCreativeMoment({
        id: crypto.randomUUID(),
        sessionId,
        title: label,
        momentType: highlight.kind === "mode" ? "sound_design" : "automation",
        note: label,
        tags: confidence === "keeper" ? ["keeper"] : [],
        confidence,
        timelineStartMs: highlight.atMs ?? null,
        targets: [{ target_type: "track", target_id: highlight.trackId }],
      });
      setKeptHighlights((prev) => new Map(prev).set(highlight.id, confidence));
      await refreshMoments();
    } catch (keepError) {
      setError(String(keepError));
    }
  }

  // Keyboard curation: ← → move the focused card, K keeps it, R flags it to revisit.
  function handleRailKey(event: KeyboardEvent<HTMLDivElement>) {
    if (highlights.length === 0) return;
    if (event.key === "ArrowRight") {
      event.preventDefault();
      setFocusedCard((i) => Math.min(highlights.length - 1, i < 0 ? 0 : i + 1));
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      setFocusedCard((i) => Math.max(0, i < 0 ? 0 : i - 1));
    } else if (event.key === "k" || event.key === "K" || event.key === "r" || event.key === "R") {
      const card = highlights[focusedCard];
      if (card && card.kind !== "note" && !keptHighlights.has(card.id)) {
        event.preventDefault();
        void keepHighlight(card, event.key === "k" || event.key === "K" ? "keeper" : "working");
      }
    }
  }

  // Keep the focused curation card in view as arrow keys move across the rail.
  useEffect(() => {
    if (focusedCard < 0 || !railRef.current) return;
    const el = railRef.current.querySelector<HTMLElement>(`[data-card-index="${focusedCard}"]`);
    el?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [focusedCard]);

  // Session-level "pulse": headline counts + a momentum read, so the take feels
  // like an event you're in, not a table you're reading.
  const pulse = useMemo(() => {
    const moveCount = changes.length;
    const decisionCount = changes.filter((c) => c.is_quantized).length;
    const keeperCount = moments.filter(
      (m) => m.confidence === "keeper" || m.confidence === "final" || m.tags.includes("keeper"),
    ).length;
    const tracksTouched = new Set(
      changes.map((c) => c.track_name).filter((name): name is string => Boolean(name)),
    ).size;
    const times = changes.map((c) => c.changed_at_ms).sort((a, b) => a - b);

    // Momentum from recent cadence (moves in the last two minutes).
    const now = Date.now();
    const recent = times.filter((t) => now - t < 120_000).length;
    let momentum: { label: string; tone: "hot" | "warm" | "calm" };
    if (!bounds.recording) {
      momentum = { label: "Take complete", tone: "calm" };
    } else if (recent >= 6) {
      momentum = { label: "In the zone", tone: "hot" };
    } else if (recent >= 1) {
      momentum = { label: "On a roll", tone: "warm" };
    } else {
      momentum = { label: "Listening…", tone: "calm" };
    }

    return { moveCount, decisionCount, keeperCount, tracksTouched, times, momentum };
  }, [changes, moments, bounds.recording]);

  // An auto-written recap of the take — prose that ties the numbers together so
  // the session reads like a memory you can skim, not a table you decode.
  const sessionStory = useMemo<string[] | null>(() => {
    if (changes.length === 0) return null;
    const sentences: string[] = [];

    const trackTally = new Map<string, number>();
    const deviceTally = new Map<string, number>();
    for (const change of changes) {
      if (change.track_name) trackTally.set(change.track_name, (trackTally.get(change.track_name) ?? 0) + 1);
      if (change.device_name) deviceTally.set(change.device_name, (deviceTally.get(change.device_name) ?? 0) + 1);
    }
    const topTrack = [...trackTally.entries()].sort((a, b) => b[1] - a[1])[0];
    const topDevice = [...deviceTally.entries()].sort((a, b) => b[1] - a[1])[0];
    const trackCount = trackTally.size;

    // Boldest continuous swing, by percent-of-range.
    let biggest: { param: string; before: string; after: string; mag: number } | null = null;
    for (const change of changes) {
      if (!change.parameter_name || change.is_quantized) continue;
      if (change.after_value_percent === null || change.before_value_percent === null) continue;
      const mag = Math.abs(change.after_value_percent - change.before_value_percent);
      if (!biggest || mag > biggest.mag) {
        biggest = {
          param: change.parameter_name,
          before: change.before_display_value ?? formatPercent(change.before_value_percent),
          after: change.after_display_value ?? formatPercent(change.after_value_percent),
          mag,
        };
      }
    }

    const modes = changes.filter((c) => c.is_quantized && c.parameter_name);
    const keepers = moments.filter(
      (m) => m.confidence === "keeper" || m.confidence === "final" || m.tags.includes("keeper"),
    ).length;

    const durationMs = session?.started_at_ms
      ? (session.ended_at_ms ?? Date.now()) - session.started_at_ms
      : null;
    const project = session?.display_name ?? session?.project_name ?? null;

    sentences.push(
      `${durationMs ? formatDuration(durationMs) : "A take"}${project ? ` on ${project}` : ""}.`,
    );
    if (topTrack) {
      sentences.push(
        trackCount === 1
          ? `Nearly all of it on ${topTrack[0]} — ${topTrack[1]} move${topTrack[1] === 1 ? "" : "s"}.`
          : `Across ${trackCount} tracks, mostly ${topTrack[0]} (${topTrack[1]} moves).`,
      );
    }
    if (topDevice && topDevice[1] >= 2) {
      sentences.push(`The ${topDevice[0]} got the most hands-on attention.`);
    }
    if (biggest) {
      sentences.push(`Boldest move: ${biggest.param}, ${biggest.before} → ${biggest.after}.`);
    }
    if (modes.length > 0) {
      const last = modes[modes.length - 1];
      sentences.push(
        `You reshaped its character — ${last.parameter_name} to ${last.after_display_value ?? "a new mode"}.`,
      );
    }
    if (keepers > 0) {
      sentences.push(`${keepers} keeper${keepers === 1 ? "" : "s"} flagged.`);
    }

    return sentences;
  }, [changes, moments, session]);

  function toggleGroup(key: string) {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const hasMap = Boolean(schema?.has_snapshot) && tracks.length > 0;
  const takeTitle = formatTakeTitle(session, schema?.name ?? null);
  const rawTakeId = session?.name ?? session?.id ?? sessionId;
  const projectContext = session?.display_name ?? session?.project_name ?? null;
  // Human duration for the header: start → end (or "now" while recording).
  const durationLabel = session?.started_at_ms
    ? formatDuration(
        (session.ended_at_ms ?? Date.now()) - session.started_at_ms,
      )
    : null;

  async function handleAddNote() {
    if (!sessionId || !selectedTrack) return;
    const text = noteDraft.trim();
    if (!text) return;
    try {
      await createCreativeMoment({
        id: crypto.randomUUID(),
        sessionId,
        title: text,
        momentType: "idea_to_revisit",
        note: text,
        tags: noteStar ? ["keeper"] : [],
        confidence: noteStar ? "keeper" : "working",
        timelineStartMs: bounds.recording ? Date.now() : null,
        targets: [{ target_type: "track", target_id: selectedTrack.id }],
      });
      setNoteDraft("");
      setNoteStar(false);
      await refreshMoments();
    } catch (noteError) {
      setError(String(noteError));
    }
  }

  async function handleDeleteNote(id: string) {
    try {
      await deleteCreativeMoment(id);
      await refreshMoments();
    } catch (deleteError) {
      setError(String(deleteError));
    }
  }

  // One structured snapshot of the take, shared by every export format so JSON,
  // Markdown, and plain text never drift apart. Strings are the producer-facing
  // display values; raw numeric fields are kept alongside for machine consumers.
  function buildShareData() {
    const valueOf = (
      value: number | null,
      percent: number | null,
      unit: string | null,
      display: string | null,
    ) => formatMoveValue(value, percent, unit, display);

    const byTrack = new Map<string, ParameterChange[]>();
    for (const change of [...changes].sort((a, b) => a.changed_at_ms - b.changed_at_ms)) {
      const key = change.track_name ?? "Unknown track";
      const arr = byTrack.get(key);
      if (arr) arr.push(change);
      else byTrack.set(key, [change]);
    }

    return {
      title: takeTitle,
      project: projectContext,
      duration: durationLabel,
      recordedAtMs: session?.started_at_ms ?? null,
      exportedAtMs: Date.now(),
      stats: {
        moves: pulse.moveCount,
        characterMoves: pulse.decisionCount,
        tracksTouched: pulse.tracksTouched,
        keepers: pulse.keeperCount,
      },
      story: sessionStory ? sessionStory.join(" ") : null,
      worthKeeping: highlights
        .filter((h) => h.kind !== "note")
        .map((h) => ({
          parameter: h.paramName,
          track: h.trackName,
          device: h.deviceName,
          before: valueOf(h.before, h.beforePercent, h.unit, h.beforeDisplay),
          after: valueOf(h.after, h.afterPercent, h.unit, h.afterDisplay),
          reason: h.reason,
          isMode: h.kind === "mode",
          atMs: h.atMs,
          elapsedMs: h.atMs - bounds.sessionStart,
        })),
      tracks: [...byTrack.entries()].map(([name, list]) => ({
        name,
        moves: list.length,
        changes: list.map((c) => ({
          device: c.device_name,
          parameter: c.parameter_name,
          before: valueOf(c.before_value, c.before_value_percent, c.unit, c.before_display_value),
          after: valueOf(c.after_value, c.after_value_percent, c.unit, c.after_display_value),
          beforeValue: c.before_value,
          afterValue: c.after_value,
          unit: c.unit,
          isQuantized: c.is_quantized ?? false,
          atMs: c.changed_at_ms,
          elapsedMs: c.changed_at_ms - bounds.sessionStart,
        })),
      })),
    };
  }

  type ShareData = ReturnType<typeof buildShareData>;

  function renderMarkdown(d: ShareData): string {
    const lines: string[] = [];
    lines.push(`# ${d.title}${d.project ? ` — ${d.project}` : ""}`);
    const meta = [
      d.duration,
      `${d.stats.moves} move${d.stats.moves === 1 ? "" : "s"}`,
      d.stats.tracksTouched > 0
        ? `${d.stats.tracksTouched} track${d.stats.tracksTouched === 1 ? "" : "s"} touched`
        : null,
      d.stats.keepers > 0 ? `${d.stats.keepers} keeper${d.stats.keepers === 1 ? "" : "s"}` : null,
    ]
      .filter(Boolean)
      .join(" · ");
    if (meta) lines.push(`_${meta}_`);
    lines.push("");
    if (d.story) lines.push("## The story so far", "", d.story, "");
    if (d.worthKeeping.length > 0) {
      lines.push("## Worth keeping", "");
      for (const h of d.worthKeeping) {
        const where = [h.track, h.device].filter(Boolean).join(" · ");
        const value = h.before !== "—" ? `${h.before} → ${h.after}` : h.after;
        lines.push(`- **${h.parameter ?? "Move"}** (${where}) — ${value} · ${h.reason}`);
      }
      lines.push("");
    }
    if (d.tracks.length > 0) {
      lines.push("## What you changed", "");
      for (const track of d.tracks) {
        lines.push(`### ${track.name}`);
        for (const c of track.changes) {
          const where = [c.device, c.parameter].filter(Boolean).join(" · ");
          const value = c.before !== "—" ? `${c.before} → ${c.after}` : c.after;
          lines.push(`- ${where}: ${value} _(${formatElapsed(c.elapsedMs)})_`);
        }
        lines.push("");
      }
    }
    lines.push("---", "_Exported from Recall Studio_");
    return lines.join("\n");
  }

  function renderText(d: ShareData): string {
    const lines: string[] = [];
    lines.push(`${d.title}${d.project ? ` — ${d.project}` : ""}`);
    const meta = [d.duration, `${d.stats.moves} moves`].filter(Boolean).join(" · ");
    if (meta) lines.push(meta);
    lines.push("");
    if (d.story) lines.push("THE STORY SO FAR", d.story, "");
    if (d.worthKeeping.length > 0) {
      lines.push("WORTH KEEPING");
      for (const h of d.worthKeeping) {
        const where = [h.track, h.device].filter(Boolean).join(" · ");
        const value = h.before !== "—" ? `${h.before} -> ${h.after}` : h.after;
        lines.push(`  - ${h.parameter ?? "Move"} (${where}): ${value} [${h.reason}]`);
      }
      lines.push("");
    }
    if (d.tracks.length > 0) {
      lines.push("WHAT YOU CHANGED");
      for (const track of d.tracks) {
        lines.push(`  ${track.name}`);
        for (const c of track.changes) {
          const where = [c.device, c.parameter].filter(Boolean).join(" · ");
          const value = c.before !== "—" ? `${c.before} -> ${c.after}` : c.after;
          lines.push(`    - ${where}: ${value} (${formatElapsed(c.elapsedMs)})`);
        }
      }
      lines.push("");
    }
    lines.push("Exported from Recall Studio");
    return lines.join("\n");
  }

  function buildShareDocument(format: Exclude<ExportFormat, "pdf">): string {
    const data = buildShareData();
    if (format === "json") return JSON.stringify(data, null, 2);
    if (format === "txt") return renderText(data);
    return renderMarkdown(data);
  }

  // A print-ready HTML document for the PDF path. Rendering through the webview's
  // print dialog ("Save as PDF") gives a properly typeset page instead of a
  // text-dumped PDF, with no extra dependency.
  function renderHtml(d: ShareData): string {
    const esc = (value: string | null | undefined) =>
      (value ?? "").replace(/[&<>]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;"));
    const meta = [
      d.duration,
      `${d.stats.moves} move${d.stats.moves === 1 ? "" : "s"}`,
      d.stats.tracksTouched > 0 ? `${d.stats.tracksTouched} tracks touched` : null,
      d.stats.keepers > 0 ? `${d.stats.keepers} keepers` : null,
    ]
      .filter(Boolean)
      .join(" · ");

    const keep = d.worthKeeping
      .map((h) => {
        const where = [h.track, h.device].filter(Boolean).map(esc).join(" · ");
        const value = h.before !== "—" ? `${esc(h.before)} → ${esc(h.after)}` : esc(h.after);
        return `<li><b>${esc(h.parameter ?? "Move")}</b> <span class="where">(${where})</span> — <span class="val">${value}</span> <span class="reason">· ${esc(h.reason)}</span></li>`;
      })
      .join("");

    const tracks = d.tracks
      .map((track) => {
        const rows = track.changes
          .map((c) => {
            const where = [c.device, c.parameter].filter(Boolean).map(esc).join(" · ");
            const value = c.before !== "—" ? `${esc(c.before)} → ${esc(c.after)}` : esc(c.after);
            return `<li>${where}: <span class="val">${value}</span> <span class="when">(${formatElapsed(c.elapsedMs)})</span></li>`;
          })
          .join("");
        return `<h3>${esc(track.name)}</h3><ul>${rows}</ul>`;
      })
      .join("");

    return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(d.title)}</title>
<style>
  @page { margin: 0.9in; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, "Segoe UI", Roboto, sans-serif; color: #1b1b1f; line-height: 1.5; margin: 0; }
  h1 { font-size: 22px; margin: 0 0 2px; }
  .meta { color: #6a6a72; font-size: 12px; margin-bottom: 20px; }
  h2 { font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; color: #6366f1; border-bottom: 1px solid #e3e3ea; padding-bottom: 5px; margin: 26px 0 8px; }
  h3 { font-size: 13px; margin: 14px 0 3px; color: #2b2b33; }
  .story { font-size: 14px; max-width: 70ch; }
  ul { margin: 4px 0; padding-left: 18px; }
  li { font-size: 12.5px; margin: 3px 0; }
  .val { font-family: ui-monospace, "SFMono-Regular", Menlo, monospace; }
  .where, .reason, .when { color: #8a8a93; }
  .foot { margin-top: 30px; color: #b0b0b8; font-size: 11px; }
</style></head><body>
  <h1>${esc(d.title)}${d.project ? ` — ${esc(d.project)}` : ""}</h1>
  <div class="meta">${esc(meta)}</div>
  ${d.story ? `<h2>The story so far</h2><p class="story">${esc(d.story)}</p>` : ""}
  ${keep ? `<h2>Worth keeping</h2><ul>${keep}</ul>` : ""}
  ${tracks ? `<h2>What you changed</h2>${tracks}` : ""}
  <div class="foot">Exported from Recall Studio</div>
</body></html>`;
  }

  function exportPdf() {
    const html = renderHtml(buildShareData());
    const frame = document.createElement("iframe");
    frame.setAttribute("aria-hidden", "true");
    frame.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;";
    document.body.appendChild(frame);
    const doc = frame.contentWindow?.document;
    if (!doc) {
      document.body.removeChild(frame);
      return;
    }
    doc.open();
    doc.write(html);
    doc.close();
    // Let the iframe lay out before invoking the print/save-as-PDF dialog.
    window.setTimeout(() => {
      frame.contentWindow?.focus();
      frame.contentWindow?.print();
      window.setTimeout(() => document.body.removeChild(frame), 1500);
    }, 250);
  }

  async function handleCopyShare() {
    if (exportFormat === "pdf") return;
    try {
      await navigator.clipboard.writeText(buildShareDocument(exportFormat));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch (copyError) {
      setError(String(copyError));
    }
  }

  async function handleExportShare() {
    if (exportFormat === "pdf") {
      exportPdf();
      return;
    }
    try {
      const ext = exportFormat;
      const filterName = ext === "md" ? "Markdown" : ext === "txt" ? "Text" : "JSON";
      const fileName = `${takeTitle.replace(/[^\w.-]+/g, "-")}-recall.${ext}`;
      const path = await save({
        defaultPath: fileName,
        filters: [{ name: filterName, extensions: [ext] }],
      });
      if (!path) return;
      await writeTextFile(path, buildShareDocument(ext));
    } catch (exportError) {
      setError(String(exportError));
    }
  }

  if (!sessionId) {
    return (
      <div className="tl-empty-screen">
        <p>Open a take to relive what you did — and keep what worked.</p>
      </div>
    );
  }

  return (
    <div className="tl">
      <header className="tl-bar">
        <div className="tl-bar__title">
          <span className={`tl-eye ${bounds.recording ? "is-rec" : ""}`}>
            {bounds.recording && <span className="tl-eye__dot" />}
            {bounds.recording ? "Recording now" : "Looking back"}
          </span>
          <strong title={rawTakeId ?? undefined}>{takeTitle}</strong>
          <span className="tl-bar__sub">
            {[
              projectContext,
              durationLabel,
              "tracks down · time across",
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </div>
        <div className="tl-bar__actions">
          {hasMap && (
            <>
              <div className="tl-fmt" role="group" aria-label="Export format">
                {(["md", "txt", "json", "pdf"] as ExportFormat[]).map((fmt) => (
                  <button
                    key={fmt}
                    type="button"
                    className={`tl-fmt__opt ${exportFormat === fmt ? "is-on" : ""}`}
                    onClick={() => setExportFormat(fmt)}
                    aria-pressed={exportFormat === fmt}
                    title={`Export as ${
                      fmt === "md"
                        ? "Markdown"
                        : fmt === "txt"
                          ? "plain text"
                          : fmt === "json"
                            ? "JSON"
                            : "PDF"
                    }`}
                  >
                    {fmt.toUpperCase()}
                  </button>
                ))}
              </div>
              <button
                type="button"
                className="tl-btn"
                onClick={() => void handleCopyShare()}
                disabled={exportFormat === "pdf"}
                title={
                  exportFormat === "pdf"
                    ? "PDF can't be copied — use Save"
                    : `Copy this take as ${exportFormat.toUpperCase()} to the clipboard`
                }
              >
                <CopyIcon />
                {copied ? "Copied!" : "Copy"}
              </button>
              <button
                type="button"
                className="tl-btn"
                onClick={() => void handleExportShare()}
                title={exportFormat === "pdf" ? "Open the print dialog to save as PDF" : `Save this take as a .${exportFormat} file`}
              >
                <ExportIcon />
                {exportFormat === "pdf" ? "Save PDF" : "Export"}
              </button>
            </>
          )}
          <button
            type="button"
            className="tl-btn tl-btn--primary"
            onClick={() => void load(true)}
            disabled={status === "loading"}
            title="Re-read the current Live set's tracks and devices to refresh this map"
          >
            <ScanIcon />
            {status === "loading" ? "Scanning…" : "Rescan set"}
          </button>
        </div>
      </header>

      {error && <div className="tl-error">{error}</div>}

      {!hasMap ? (
        <ScanEmptyState
          existingSet={Boolean(session?.project_path)}
          loading={status === "loading"}
          onScan={() => void load(true)}
        />
      ) : (
        <>
          <div className="tl-pulse">
            <div className="tl-pulse__stats">
              <span className="tl-stat">
                <b>{pulse.moveCount}</b>
                <span>move{pulse.moveCount === 1 ? "" : "s"}</span>
              </span>
              {pulse.decisionCount > 0 && (
                <span className="tl-stat">
                  <b>{pulse.decisionCount}</b>
                  <span>character move{pulse.decisionCount === 1 ? "" : "s"}</span>
                </span>
              )}
              <span className="tl-stat">
                <b>{pulse.tracksTouched}</b>
                <span>track{pulse.tracksTouched === 1 ? "" : "s"} touched</span>
              </span>
              {pulse.keeperCount > 0 && (
                <span className="tl-stat tl-stat--keep">
                  <b>{pulse.keeperCount}</b>
                  <span>keeper{pulse.keeperCount === 1 ? "" : "s"}</span>
                </span>
              )}
            </div>
            {(() => {
              const spark = cumulativeMovePaths(
                pulse.times,
                bounds,
                Math.max(pulse.times.length, 1),
                xEnd,
              );
              return spark ? (
                <ActivitySpark
                  paths={spark}
                  color="#aab4ff"
                  gradientId="spark-pulse"
                  className="tl-pulse__spark"
                />
              ) : null;
            })()}
            <span className={`tl-pulse__state is-${pulse.momentum.tone}`}>
              <span className="tl-pulse__pip" />
              {pulse.momentum.label}
            </span>
          </div>

          <div className="tl-legend">
            <span><span className="tl-key tl-key--move" /> activity (taller = more changes)</span>
            <span><span className="tl-key tl-key--note" /> note</span>
            {bounds.recording && <span><span className="tl-key tl-key--now" /> now</span>}
          </div>

          <div className="tl-arrange">
            <div className="tl-headers">
              <div className="tl-rspacer" />
              {lanes.map((lane) => {
                const color = trackColor(lane.track);
                const moveCount = (laneGraphs.moveTimesByLane.get(lane.track.id) ?? []).length;
                return (
                  <button
                    key={lane.track.id}
                    type="button"
                    className={`tl-hdr ${lane.track.id === selectedTrackId ? "is-sel" : ""}`}
                    style={{ ["--lane-color" as string]: color }}
                    onClick={() => setSelectedTrackId(lane.track.id)}
                    title={`${lane.track.name ?? "Untitled track"} — ${moveCount} move${moveCount === 1 ? "" : "s"}`}
                  >
                    <span className="tl-hdr__sw" style={{ background: color }} />
                    <span className="tl-hdr__name">{lane.track.name ?? "Untitled track"}</span>
                    {moveCount > 0 && <span className="tl-hdr__count">{moveCount}</span>}
                  </button>
                );
              })}
            </div>

            <div className="tl-tracks">
              <div className="tl-ruler">
                {buildTicks(bounds).map((tick) => (
                  <span key={tick.label + tick.pct} className="tl-tick" style={{ left: `${tick.pct}%` }}>
                    {tick.label}
                  </span>
                ))}
              </div>
              {lanes.map((lane) => {
                const moveTimes = laneGraphs.moveTimesByLane.get(lane.track.id) ?? [];
                const graph = cumulativeMovePaths(moveTimes, bounds, laneGraphs.maxMoves, xEnd);
                const moveCount = moveTimes.length;
                return (
                  <button
                    key={lane.track.id}
                    type="button"
                    className={`tl-lane ${lane.track.id === selectedTrackId ? "is-sel" : ""}`}
                    onClick={() => setSelectedTrackId(lane.track.id)}
                    aria-label={`${lane.track.name ?? "Untitled track"} — ${moveCount} moves`}
                  >
                    {graph && (
                      <ActivitySpark
                        paths={graph}
                        color={trackColor(lane.track)}
                        gradientId={`spark-${lane.track.id}`}
                      />
                    )}
                    {lane.items
                      .filter((item) => item.kind === "note")
                      .map((item) => (
                        <span
                          key={item.id}
                          className="tl-mk tl-mk--note"
                          style={{ left: `${pct(item.atMs, bounds)}%` }}
                          title={describeActivity(item)}
                        >
                          ★
                        </span>
                      ))}
                  </button>
                );
              })}
              {bounds.recording && <span className="tl-playhead" style={{ left: `${pct(Date.now(), bounds)}%` }} />}
            </div>
          </div>

          {selectedTrack && (
            <div className="tl-dock">
              <div className="tl-dock__head">
                <span className="tl-dock__kick">Track memory</span>
                <span className="tl-dock__name">
                  <span className="tl-dock__sw" style={{ background: trackColor(selectedTrack) }} />
                  {selectedTrack.name ?? "Untitled track"}
                </span>
                <span className="tl-dock__meta">
                  {TRACK_TYPE_LABEL[selectedTrack.type]} · {selectedTrack.devices.length} device
                  {selectedTrack.devices.length === 1 ? "" : "s"} · {moveCountForTrack} move
                  {moveCountForTrack === 1 ? "" : "s"}
                </span>
                {mostTouched && mostTouched.count > 1 && (
                  <span className="tl-dock__top">
                    Most-touched: <b>{mostTouched.name}</b> · {mostTouched.count}
                  </span>
                )}
              </div>

              {selectedTrack.devices.length > 0 ? (
                <div className="tl-chain">
                  {selectedTrack.devices.map((device, index) => (
                    <span key={device.id} className="tl-chain__seg">
                      {index > 0 && <span className="tl-chain__arrow">→</span>}
                      <span className={`tl-pill ${device.enabled ? "" : "is-off"}`}>
                        <span className="tl-pill__rl" style={{ background: deviceColor(device) }} />
                        {device.name ?? DEVICE_ROLE_LABEL[device.role]}
                        {device.name && changedDeviceNames.has(device.name) && <span className="tl-pill__chg" />}
                      </span>
                    </span>
                  ))}
                </div>
              ) : (
                <p className="tl-chain__empty">No devices captured on this track.</p>
              )}

              <div className="tl-story-head">What you did to {selectedTrack.name ?? "this track"}</div>
              {groupedActivity.length > 0 ? (
                <ul className="tl-story">
                  {groupedActivity.map((group) => {
                    const lead = group.lead;
                    const count = group.items.length;
                    const oldest = group.items[count - 1];
                    const when = formatElapsed(lead.atMs - bounds.sessionStart);
                    const expanded = expandedGroups.has(group.key);

                    if (lead.kind === "note") {
                      return (
                        <li key={group.key} className="tl-ci">
                          <span className="tl-ci__ic tl-ci__ic--note">★</span>
                          <span className="tl-ci__body">
                            <span className="tl-ci__what"><b>Note</b></span>
                            <span className="tl-ci__val">{lead.title ?? ""}</span>
                          </span>
                          <span className="tl-ci__when">{when}</span>
                          <button
                            type="button"
                            className="tl-ci__del"
                            aria-label="Delete note"
                            onClick={() => void handleDeleteNote(lead.id)}
                          >
                            ×
                          </button>
                        </li>
                      );
                    }

                    return (
                      <li key={group.key} className="tl-ci-wrap">
                        <div
                          className={`tl-ci ${count > 1 ? "tl-ci--group" : ""} ${expanded ? "is-open" : ""}`}
                          {...(count > 1
                            ? {
                                role: "button",
                                tabIndex: 0,
                                onClick: () => toggleGroup(group.key),
                                onKeyDown: (event: KeyboardEvent) => {
                                  if (event.key === "Enter" || event.key === " ") {
                                    event.preventDefault();
                                    toggleGroup(group.key);
                                  }
                                },
                              }
                            : {})}
                        >
                          <span className="tl-ci__ic tl-ci__ic--move" />
                          <span className="tl-ci__body">
                            {moveWhatNode(lead)}
                            {moveValueNode(oldest, lead, count)}
                          </span>
                          <span className="tl-ci__when">{when}</span>
                          {count > 1 && (
                            <span className={`tl-ci__chev ${expanded ? "is-open" : ""}`} aria-hidden="true">
                              ⌄
                            </span>
                          )}
                        </div>
                        {expanded && count > 1 && (
                          <ul className="tl-substory">
                            {group.items.map((item) => (
                              <li key={item.id} className="tl-ci tl-ci--sub">
                                <span className="tl-ci__ic" />
                                <span className="tl-ci__body">
                                  {moveValueNode(item, item, 1)}
                                </span>
                                <span className="tl-ci__when">
                                  {formatElapsed(item.atMs - bounds.sessionStart)}
                                </span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="tl-story__empty">Nothing logged on this track yet — moves show up here as you tweak it.</p>
              )}

              <div className="tl-addnote">
                <button
                  type="button"
                  className={`tl-addnote__star ${noteStar ? "is-on" : ""}`}
                  aria-label="Flag as keeper"
                  aria-pressed={noteStar}
                  onClick={() => setNoteStar((value) => !value)}
                >
                  ★
                </button>
                <input
                  value={noteDraft}
                  onChange={(event) => setNoteDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void handleAddNote();
                  }}
                  placeholder={`Add a note to ${selectedTrack.name ?? "this track"}…`}
                  aria-label="Add a note"
                />
                <button
                  type="button"
                  className="tl-btn tl-btn--primary tl-addnote__save"
                  disabled={!noteDraft.trim()}
                  onClick={() => void handleAddNote()}
                >
                  Add note
                </button>
              </div>
            </div>
          )}

          {highlights.length > 0 && (
            <div className="tl-keep">
              <div className="tl-keep__head">
                <span className="tl-keep__kick">Worth keeping</span>
                <span className="tl-keep__sub">ranked by what you worked · keep or revisit</span>
                <span className="tl-keep__keys" aria-hidden="true">
                  <kbd>←</kbd><kbd>→</kbd> move · <kbd>K</kbd> keep · <kbd>R</kbd> revisit
                </span>
              </div>
              <div
                className="tl-keep__rail"
                ref={railRef}
                tabIndex={0}
                role="listbox"
                aria-label="Worth keeping"
                onKeyDown={handleRailKey}
                onFocus={() => setFocusedCard((i) => (i < 0 ? 0 : i))}
              >
                {highlights.map((highlight, cardIndex) => {
                  const track = highlight.trackId
                    ? tracks.find((t) => t.id === highlight.trackId)
                    : null;
                  const color = track ? trackColor(track) : "#6382ff";
                  const isNote = highlight.kind === "note";
                  const hasBefore =
                    (highlight.beforeDisplay !== null && highlight.beforeDisplay !== "") ||
                    highlight.before !== null ||
                    highlight.beforePercent !== null;
                  const after = formatMoveValue(
                    highlight.after,
                    highlight.afterPercent,
                    highlight.unit,
                    highlight.afterDisplay,
                  );
                  const isMode = highlight.kind === "mode";
                  const beforeRef = highlight.beforePercent ?? highlight.before;
                  const afterRef = highlight.afterPercent ?? highlight.after;
                  const direction =
                    !isMode && beforeRef !== null && afterRef !== null
                      ? afterRef > beforeRef
                        ? "up"
                        : afterRef < beforeRef
                          ? "down"
                          : null
                      : null;
                  const barPct =
                    !isMode && highlight.afterPercent !== null
                      ? Math.max(0, Math.min(100, highlight.afterPercent))
                      : null;
                  const strengthPips = isNote ? 0 : Math.max(1, Math.round(highlight.strength * 3));
                  return (
                    <div
                      key={highlight.id}
                      data-card-index={cardIndex}
                      className={`tl-card ${isNote ? "tl-card--note" : ""} ${
                        focusedCard === cardIndex ? "is-focused" : ""
                      }`}
                      style={{ ["--lane-color" as string]: color }}
                      onClick={() => setFocusedCard(cardIndex)}
                    >
                      <div className="tl-card__top">
                        <span className="tl-card__badge">{highlight.reason}</span>
                        {strengthPips > 0 && (
                          <span
                            className="tl-card__meter"
                            aria-label={`strength ${strengthPips} of 3`}
                            title={`Rank strength ${strengthPips}/3`}
                          >
                            {[0, 1, 2].map((i) => (
                              <span
                                key={i}
                                className={`tl-card__pip ${i < strengthPips ? "is-on" : ""}`}
                              />
                            ))}
                          </span>
                        )}
                        <span className="tl-card__when">
                          {formatElapsed(highlight.atMs - bounds.sessionStart)}
                        </span>
                      </div>
                      <div className="tl-card__where">
                        {[highlight.trackName, highlight.deviceName].filter(Boolean).join(" · ")}
                      </div>
                      <div className="tl-card__body">
                        {isNote ? (
                          <span className="tl-card__note">{highlight.title}</span>
                        ) : (
                          <>
                            <span className="tl-card__param">{highlight.paramName}</span>
                            <span className={`tl-ba tl-card__val ${isMode ? "is-mode" : ""}`}>
                              {hasBefore && (
                                <>
                                  <span className="tl-ba__o">
                                    {formatMoveValue(
                                      highlight.before,
                                      highlight.beforePercent,
                                      highlight.unit,
                                      highlight.beforeDisplay,
                                    )}
                                  </span>
                                  <span className="tl-ba__arr">→</span>
                                </>
                              )}
                              <span className="tl-ba__n">{after}</span>
                              {direction && (
                                <span className={`tl-ba__dir is-${direction}`} aria-hidden="true">
                                  {direction === "up" ? "▲" : "▼"}
                                </span>
                              )}
                            </span>
                            {barPct !== null && (
                              <span className="tl-card__bar" aria-hidden="true">
                                <span className="tl-card__bar-fill" style={{ width: `${barPct}%` }} />
                              </span>
                            )}
                          </>
                        )}
                      </div>
                      {isNote ? (
                        highlight.starred && <div className="tl-card__kept">★ Kept</div>
                      ) : keptHighlights.has(highlight.id) ? (
                        <div className="tl-card__kept">
                          {keptHighlights.get(highlight.id) === "keeper" ? "★ Kept" : "↩ Saved to revisit"}
                        </div>
                      ) : (
                        <div className="tl-card__actions">
                          <button
                            type="button"
                            className="tl-card__act tl-card__act--keep"
                            onClick={() => void keepHighlight(highlight, "keeper")}
                          >
                            ★ Keep
                          </button>
                          <button
                            type="button"
                            className="tl-card__act"
                            onClick={() => void keepHighlight(highlight, "working")}
                          >
                            ↩ Revisit
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {sessionStory && (
            <div className="tl-recap">
              <div className="tl-recap__kick">The story so far</div>
              <p className="tl-recap__text">{sessionStory.join(" ")}</p>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function ScanEmptyState({
  existingSet,
  loading,
  onScan,
}: {
  existingSet: boolean;
  loading: boolean;
  onScan: () => void;
}) {
  return (
    <div className="tl-scan">
      <div className="tl-scan__ic">
        <ScanIcon />
      </div>
      <h3>{existingSet ? "Catching up on this set" : "Waiting for your first move"}</h3>
      <p>
        {existingSet
          ? "This set was built before Recall was watching, so it's baselining every track and device already in it. Give it a few seconds on a big set, then refresh."
          : "Make a move in Ableton — your first tweak lays out the tracks and starts the map."}
      </p>
      <button type="button" className="tl-btn tl-btn--primary" onClick={onScan} disabled={loading}>
        <ScanIcon />
        {loading ? "Scanning…" : existingSet ? "Refresh map" : "Refresh"}
      </button>
      <div className="tl-scan__ghost">
        <span />
        <span />
        <span />
        <span />
      </div>
    </div>
  );
}

// ── data helpers ──────────────────────────────────────────────────────────────

type Lookups = {
  paramTrack: Map<string, string>;
  deviceTrack: Map<string, string>;
  nameTrack: Map<string, string>;
};

function buildLookups(schema: ProjectSchema | null): Lookups {
  const paramTrack = new Map<string, string>();
  const deviceTrack = new Map<string, string>();
  const nameTrack = new Map<string, string>();
  if (!schema) return { paramTrack, deviceTrack, nameTrack };

  const walkParams = (params: ParameterObj[], trackId: string) => {
    for (const param of params) {
      paramTrack.set(param.id, trackId);
      if (param.children.length > 0) walkParams(param.children, trackId);
    }
  };

  for (const track of schema.tracks) {
    if (track.name) nameTrack.set(track.name.toLowerCase(), track.id);
    for (const device of track.devices) {
      deviceTrack.set(device.id, track.id);
      walkParams(device.parameters, track.id);
    }
  }
  return { paramTrack, deviceTrack, nameTrack };
}

function noteTrackId(moment: CreativeMoment, lookups: Lookups): string | null {
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

function pct(atMs: number, bounds: { start: number; span: number }): number {
  if (bounds.span <= 0) return 50;
  const value = ((atMs - bounds.start) / bounds.span) * 100;
  return Math.min(100, Math.max(0, value));
}

// Build a cumulative step-line (and matching filled area) for one lane's moves,
// in a 0–100 × 0–100 viewBox drawn with preserveAspectRatio="none". The curve
// stays flat then steps up at each move, so its rising height tells the story of
// how much a channel was touched. `globalMax` is shared across lanes so the
// busiest channel peaks at the top. Returns null when there's nothing to draw.
function cumulativeMovePaths(
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

// Renders a cumulative activity curve as a glowing, gradient-filled spark that
// draws itself in on mount. Shared by the track lanes and the session pulse so
// the timeline reads like a living waveform rather than a chart. The vertical
// gradient (currentColor → transparent) is defined per instance so each lane can
// carry its own track color.
function ActivitySpark({
  paths,
  color,
  gradientId,
  className = "tl-graph",
}: {
  paths: { line: string; area: string };
  color: string;
  gradientId: string;
  className?: string;
}) {
  return (
    <svg
      className={className}
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      style={{ color }}
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="currentColor" stopOpacity="0.34" />
          <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path className="tl-graph__area" d={paths.area} style={{ fill: `url(#${gradientId})` }} />
      <path
        className="tl-graph__line"
        d={paths.line}
        pathLength={1}
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

function buildTicks(bounds: {
  start: number;
  span: number;
  sessionStart: number;
}): Array<{ pct: number; label: string }> {
  const steps = 4;
  const out: Array<{ pct: number; label: string }> = [];
  for (let i = 0; i <= steps; i += 1) {
    // Label each tick by how far into the session it sits, so the axis and the
    // change-list timestamps share one clock (elapsed from session start).
    const atMs = bounds.start + (bounds.span * i) / steps;
    out.push({ pct: (i / steps) * 100, label: formatElapsed(atMs - bounds.sessionStart) });
  }
  return out;
}

function formatElapsed(ms: number): string {
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
function formatTakeTitle(
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
function formatDuration(ms: number): string {
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

function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? `${rounded}%` : `${rounded.toFixed(1)}%`;
}

function formatMoveValue(
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

function describeActivity(item: Activity): string {
  if (item.kind === "note") return item.title ?? "Note";
  const where = [item.deviceName, item.paramName].filter(Boolean).join(" · ");
  return `${where}: ${formatMoveValue(item.before, item.beforePercent, item.unit, item.beforeDisplay)} → ${formatMoveValue(
    item.after,
    item.afterPercent,
    item.unit,
    item.afterDisplay,
  )}`;
}

// Left column of a move row: "Device · Parameter", so the eye can lock onto
// what was touched separately from the value.
function moveWhatNode(item: Activity) {
  return (
    <span className="tl-ci__what">
      <b>{item.deviceName ?? "Device"}</b>
      <span className="tl-ci__det"> · {item.paramName ?? "parameter"}</span>
    </span>
  );
}

// Up/down direction of a continuous move, by percent-of-range when known, else
// raw value. Mode (quantized) changes have no direction. Used to tint a caret so
// a knob raised reads warm and one lowered reads cool — sound, not spreadsheet.
function moveDirection(beforeItem: Activity, afterItem: Activity): "up" | "down" | null {
  if (afterItem.quantized) return null;
  const before = beforeItem.beforePercent ?? beforeItem.before;
  const after = afterItem.afterPercent ?? afterItem.after;
  if (before === null || before === undefined || after === null || after === undefined) {
    return null;
  }
  if (after > before) return "up";
  if (after < before) return "down";
  return null;
}

// Right column of a move row: the value as "before → after" (or just "after"
// when no pre-value is known). Continuous values get a direction caret; mode
// (quantized) values render as a categorical pill so they read distinct from a
// number. An optional "N×" badge marks a collapsed run.
function moveValueNode(beforeItem: Activity, afterItem: Activity, count: number) {
  const quantized = afterItem.quantized === true;
  const after = formatMoveValue(
    afterItem.after,
    afterItem.afterPercent,
    afterItem.unit,
    afterItem.afterDisplay,
  );
  const hasBefore =
    (beforeItem.beforeDisplay !== null &&
      beforeItem.beforeDisplay !== undefined &&
      beforeItem.beforeDisplay !== "") ||
    (beforeItem.before !== null && beforeItem.before !== undefined) ||
    (beforeItem.beforePercent !== null && beforeItem.beforePercent !== undefined);
  const direction = moveDirection(beforeItem, afterItem);
  return (
    <span className={`tl-ci__val tl-ba ${quantized ? "is-mode" : ""}`}>
      {hasBefore && (
        <>
          <span className="tl-ba__o">
            {formatMoveValue(
              beforeItem.before,
              beforeItem.beforePercent,
              beforeItem.unit,
              beforeItem.beforeDisplay,
            )}
          </span>
          <span className="tl-ba__arr">→</span>
        </>
      )}
      <span className="tl-ba__n">{after}</span>
      {direction && (
        <span className={`tl-ba__dir is-${direction}`} aria-hidden="true">
          {direction === "up" ? "▲" : "▼"}
        </span>
      )}
      {count > 1 && <span className="tl-ba__count">{count}×</span>}
    </span>
  );
}

const TRACK_FALLBACK: Record<TrackObj["type"], string> = {
  midi: "#6382ff",
  audio: "#aaccf0",
  return: "#f0cfa0",
  group: "#9c88ff",
  master: "#9aa3c4",
};

function trackColor(track: TrackObj): string {
  if (track.color && /^#[0-9a-fA-F]{6}$/.test(track.color)) return track.color;
  return TRACK_FALLBACK[track.type];
}

function deviceColor(device: DeviceObj): string {
  if (device.role === "instrument") return "#9c88ff";
  if (device.role === "midi_effect") return "#6382ff";
  return "#5ab4a0";
}

function ScanIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <circle cx="8" cy="8" r="2" fill="currentColor" />
      <path
        d="M8 2.2a5.8 5.8 0 0 1 5.8 5.8M8 13.8A5.8 5.8 0 0 1 2.2 8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
      <path d="M10.5 5.5V4a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5" strokeLinecap="round" />
    </svg>
  );
}

function ExportIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
      <path d="M8 10V2.5M8 2.5 5.5 5M8 2.5 10.5 5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M3 9.5v3A1.5 1.5 0 0 0 4.5 14h7a1.5 1.5 0 0 0 1.5-1.5v-3" strokeLinecap="round" />
    </svg>
  );
}
