import { useCallback, useEffect, useMemo, useState } from "react";
import "./SchemaTimeline.css";
import {
  createCreativeMoment,
  deleteCreativeMoment,
  getParameterChanges,
  getProjectSchema,
  listCreativeMoments,
  materializeSessionSchema,
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
  unit?: string | null;
  // note
  title?: string;
  starred?: boolean;
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

  const load = useCallback(
    async (rematerialize: boolean) => {
      if (!sessionId) return;
      setStatus("loading");
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
    const start = session?.started_at_ms ?? (changes[0]?.changed_at_ms ?? Date.now());
    const recording = session?.ended_at_ms === null;
    let end = session?.ended_at_ms ?? Date.now();
    for (const change of changes) end = Math.max(end, change.changed_at_ms);
    if (end <= start) end = start + 60_000;
    return { start, end, span: end - start, recording };
  }, [session, changes]);

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
        unit: change.unit,
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

  const hasMap = Boolean(schema?.has_snapshot) && tracks.length > 0;
  const takeTitle = session?.name ?? schema?.name ?? "Take";
  const projectContext = session?.display_name ?? session?.project_name ?? null;

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

  if (!sessionId) {
    return (
      <div className="tl-empty-screen">
        <p>Open a take from your project library to see what changed and keep what worked.</p>
      </div>
    );
  }

  return (
    <div className="tl">
      <header className="tl-bar">
        <div className="tl-bar__title">
          <span className={`tl-eye ${bounds.recording ? "is-rec" : ""}`}>
            {bounds.recording && <span className="tl-eye__dot" />}
            {bounds.recording ? "Recording now" : "Viewing take"}
          </span>
          <strong>{takeTitle}</strong>
          <span className="tl-bar__sub">
            {projectContext ? `${projectContext} · ` : ""}
            read down = your tracks · across = what you did
          </span>
        </div>
        <div className="tl-bar__actions">
          <button
            type="button"
            className="tl-btn tl-btn--primary"
            onClick={() => void load(true)}
            disabled={status === "loading"}
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
          <div className="tl-legend">
            <span><span className="tl-key tl-key--move" /> knob move</span>
            <span><span className="tl-key tl-key--note" /> note</span>
            {bounds.recording && <span><span className="tl-key tl-key--now" /> now</span>}
          </div>

          <div className="tl-arrange">
            <div className="tl-tracks">
              <div className="tl-ruler">
                {buildTicks(bounds.span).map((tick) => (
                  <span key={tick.label + tick.pct} className="tl-tick" style={{ left: `${tick.pct}%` }}>
                    {tick.label}
                  </span>
                ))}
              </div>
              {lanes.map((lane) => (
                <button
                  key={lane.track.id}
                  type="button"
                  className={`tl-lane ${lane.track.id === selectedTrackId ? "is-sel" : ""}`}
                  onClick={() => setSelectedTrackId(lane.track.id)}
                  aria-label={`${lane.track.name ?? "Untitled track"} — ${lane.items.length} moves`}
                >
                  {lane.items.map((item) => (
                    <span
                      key={item.id}
                      className={`tl-mk tl-mk--${item.kind}`}
                      style={{ left: `${pct(item.atMs, bounds)}%` }}
                      title={describeActivity(item)}
                    >
                      {item.kind === "note" ? "★" : ""}
                    </span>
                  ))}
                </button>
              ))}
              {bounds.recording && <span className="tl-playhead" style={{ left: `${pct(Date.now(), bounds)}%` }} />}
            </div>

            <div className="tl-headers">
              <div className="tl-rspacer" />
              {lanes.map((lane) => {
                const color = trackColor(lane.track);
                return (
                  <button
                    key={lane.track.id}
                    type="button"
                    className={`tl-hdr ${lane.track.id === selectedTrackId ? "is-sel" : ""}`}
                    style={{ background: color, color: readableText(color) }}
                    onClick={() => setSelectedTrackId(lane.track.id)}
                  >
                    <span className="tl-hdr__name">{lane.track.name ?? "Untitled track"}</span>
                  </button>
                );
              })}
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
                  {selectedTrack.devices.length === 1 ? "" : "s"} · {trackActivity.filter((a) => a.kind === "move").length} moves
                </span>
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
              {trackActivity.length > 0 ? (
                <ul className="tl-story">
                  {trackActivity.map((item) => (
                    <li key={item.id} className="tl-ci">
                      <span className={`tl-ci__ic tl-ci__ic--${item.kind}`}>{item.kind === "note" ? "★" : ""}</span>
                      <span className="tl-ci__body">{renderActivityBody(item)}</span>
                      <span className="tl-ci__when">{formatElapsed(item.atMs - bounds.start)}</span>
                      {item.kind === "note" && (
                        <button
                          type="button"
                          className="tl-ci__del"
                          aria-label="Delete note"
                          onClick={() => void handleDeleteNote(item.id)}
                        >
                          ×
                        </button>
                      )}
                    </li>
                  ))}
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
      <h3>{existingSet ? "Capturing what's already in this set" : "This take isn't mapped yet"}</h3>
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

function buildTicks(spanMs: number): Array<{ pct: number; label: string }> {
  const steps = 4;
  const out: Array<{ pct: number; label: string }> = [];
  for (let i = 0; i <= steps; i += 1) {
    out.push({ pct: (i / steps) * 100, label: formatElapsed((spanMs * i) / steps) });
  }
  return out;
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function formatNum(value: number): string {
  return Number.isInteger(value) ? String(value) : (Math.round(value * 100) / 100).toString();
}

function formatValue(value: number | null | undefined, unit: string | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return unit ? `${formatNum(value)} ${unit}` : formatNum(value);
}

function describeActivity(item: Activity): string {
  if (item.kind === "note") return item.title ?? "Note";
  const where = [item.deviceName, item.paramName].filter(Boolean).join(" · ");
  return `${where}: ${formatValue(item.before, item.unit)} → ${formatValue(item.after, item.unit)}`;
}

function renderActivityBody(item: Activity) {
  if (item.kind === "note") {
    return (
      <>
        <b>Note</b>
        <span className="tl-ci__det"> — {item.title}</span>
      </>
    );
  }
  return (
    <>
      <b>{item.deviceName ?? "Device"}</b>
      <span className="tl-ci__det"> — {item.paramName ?? "parameter"} </span>
      {item.before === null || item.before === undefined ? (
        <span className="tl-ba">
          set to <span className="tl-ba__n">{formatValue(item.after, item.unit)}</span>
        </span>
      ) : (
        <span className="tl-ba">
          <span className="tl-ba__o">{formatValue(item.before, item.unit)}</span> →{" "}
          <span className="tl-ba__n">{formatValue(item.after, item.unit)}</span>
        </span>
      )}
    </>
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

function readableText(hex: string): string {
  const match = /^#([0-9a-fA-F]{6})$/.exec(hex);
  if (!match) return "#f4f6ff";
  const int = parseInt(match[1], 16);
  const r = (int >> 16) & 255;
  const g = (int >> 8) & 255;
  const b = int & 255;
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.62 ? "#0d0f18" : "#f4f6ff";
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
