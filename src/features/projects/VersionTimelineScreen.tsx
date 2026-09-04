import {
  memo,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useState,
  type CSSProperties,
} from "react";
import { isTauri } from "@tauri-apps/api/core";
import type { SavedProject, SavedSessionMetadata } from "../../types/recall";
import { NOTE_KIND_LABEL, type MidiClipNote, type NoteEdit } from "../../types/schema";
import { formatSessionDate } from "../sessionFormat";
import { formatClock, formatDuration } from "../../components/schema/timeline/format";
import {
  describeMidiChange,
  namedMidiClip,
} from "../../components/schema/timeline/midiChange";
import { producerWorkDefinition } from "../../components/schema/timeline/producerWork";
import {
  normalizeAlsPath,
  projectVersions,
  type AlsFileAges,
  type ProjectVersion,
} from "./projectVersions";
import { layoutVersionGraph } from "./versionGraphLayout";
import { versionGraph, type ObservedSave, type VersionNode } from "./versionGraph";
import { sittings as groupSittings } from "./sittings";
import {
  layoutVersionTimeline,
  TIMELINE_ROW_HEIGHT,
  type VersionTimelineLayout,
} from "./versionTimelineLayout";
import { movementShape, type MovementShape } from "./movementShape";
import {
  barBeatLabel,
  barCountLabel,
  type SongPositionSource,
} from "./songPosition";
import { gapLabel, sittingByTrack, sittingTrail } from "./sittingTrail";
import type { SittingDepth, VersionDepth } from "./versionDepth";
import {
  getAlsFileTimes,
  getAlsPresets,
  getObservedSaves,
  type StoredTrackPreset,
} from "../../lib/schema/api";
import { ReportLoading } from "./ReportLoading";
import { loadVersionDepth } from "./versionReportLoader";
import type { ReportDecision, ReportEvidence } from "./sessionReport";
import {
  compareSavedPresets,
  type ComparedSavedPreset,
} from "./savedPresetState";
import "./VersionTimelineScreen.css";

type VersionTimelineScreenProps = {
  projects: SavedProject[];
  projectId: string | null;
  focusSessionId?: string | null;
  onSelectProject: (projectId: string) => void;
  onOpenReport: (sessionId: string, scope: "version") => void;
  onOpenProjects: () => void;
};

type SelectedVersionParent = {
  name: string;
  sessionId: string | null;
  alsPath: string | null;
};

/** Must match `.vt-graph__rows > li` in the stylesheet. */
const ROW_HEIGHT = TIMELINE_ROW_HEIGHT;

function versionLabel(version: ProjectVersion): string {
  return version.alsPath ? `${version.name}.als` : version.name;
}

function latestVersion(versions: ProjectVersion[]): ProjectVersion | null {
  return versions.reduce<ProjectVersion | null>(
    (latest, version) =>
      latest === null || version.lastUpdatedAtMs > latest.lastUpdatedAtMs ? version : latest,
    null,
  );
}

function latestSitting(version: ProjectVersion): string | null {
  const lastWorked = groupSittings(version.sessions).sittings.at(-1);
  return lastWorked?.captureIds.at(-1) ?? version.sessions.at(-1)?.id ?? null;
}

/** The exact stored path, not ProjectVersion.alsPath, which is normalized for identity. */
function versionSourcePath(version: ProjectVersion): string | null {
  for (const session of [...version.sessions].reverse()) {
    const path = session.als_path?.trim();
    if (path && path !== "0") return path;
  }
  return null;
}

/** The graph owns calendar time on its axis. Its rows only state the return
    count; repeating a date range beneath the file name makes a producer parse
    the same time fact twice. */
function versionWorkLine(version: ProjectVersion): string {
  const worked = groupSittings(version.sessions).sittings;
  if (worked.length === 0) return "Recall captured no producer work in this file";
  const first = worked[0]!;
  if (worked.length === 1) {
    return `1 return · ${formatClock(first.startMs)}–${formatClock(first.endMs)}`;
  }
  return `${worked.length} returns`;
}



/**
 * Every save Recall watched in this project.
 *
 * Loaded once per project rather than per version, because the observed-parent
 * rule is a question about the SEQUENCE of saves across files — "what was
 * written just before this file first appeared" — and that cannot be answered
 * from one version's saves alone.
 */
function useObservedSaves(versions: ProjectVersion[]): ObservedSave[] {
  const [saves, setSaves] = useState<ObservedSave[]>([]);
  const sessionIds = useMemo(
    () => versions.flatMap((version) => version.sessions.map((session) => session.id)),
    [versions],
  );
  const key = sessionIds.join("|");

  useEffect(() => {
    let cancelled = false;
    if (sessionIds.length === 0) {
      setSaves([]);
      return;
    }
    void getObservedSaves(sessionIds)
      .then((rows) => {
        if (cancelled) return;
        setSaves(
          rows.map((row) => ({ alsPath: row.als_path, savedAtMs: row.saved_at_ms })),
        );
      })
      // A project captured before saves were watched has none, and the graph
      // falls back to inference — which is what the dashed lines already say.
      .catch(() => {
        if (!cancelled) setSaves([]);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return saves;
}

/**
 * A version graph measured down the page in elapsed time.
 *
 * The drawing is still a graph, and the durable text is still HTML, but the
 * space between records is now part of the record too. A producer can see an
 * afternoon of work, a five-month absence (named, never silently squeezed),
 * and the returns to each file on the same surface.
 */
function VersionLogGraph({
  nodes,
  saves,
  selectedVersionId,
  onSelectVersion,
}: {
  nodes: VersionNode[];
  saves: ObservedSave[];
  selectedVersionId: string | null;
  onSelectVersion: (versionId: string) => void;
}) {
  const layout = useMemo(() => layoutVersionGraph(nodes), [nodes]);
  const placementById = useMemo(
    () => new Map(layout.placements.map((placement) => [placement.nodeId, placement])),
    [layout],
  );
  const ordered = useMemo(
    () => [...nodes].sort((left, right) =>
      left.version.startedAtMs - right.version.startedAtMs || left.id.localeCompare(right.id)),
    [nodes],
  );
  const timeline = useMemo<VersionTimelineLayout>(
    () => layoutVersionTimeline(nodes, layout, saves),
    [nodes, layout, saves],
  );
  const rowById = useMemo(
    () => new Map(timeline.rows.map((row) => [row.nodeId, row])),
    [timeline],
  );

  // The date axis needs room to say what it means. Lanes begin after it rather
  // than making dates overlap an edge or hiding the date entirely.
  const graphWidth = Math.max(144, layout.lanes.length * 28 + 116);
  const graphHeight = Math.max(ROW_HEIGHT, timeline.height);
  const positions = new Map(
    ordered.flatMap((node) => {
      const row = rowById.get(node.id);
      if (!row) return [];
      const lane = placementById.get(node.id)?.lane ?? 0;
      return [[node.id, { x: 120 + lane * 28, y: row.y }] as const];
    }),
  );

  const laneBounds = layout.lanes.map((lane) => {
    const marks = [
      ...lane.nodeIds.map((id) => positions.get(id)?.y).filter((y): y is number => y !== undefined),
      ...timeline.sittingTicks
        .filter((tick) => placementById.get(tick.nodeId)?.lane === lane.index)
        .map((tick) => tick.y),
      ...timeline.saveTicks
        .filter((tick) => placementById.get(tick.nodeId)?.lane === lane.index)
        .map((tick) => tick.y),
    ];
    return { lane, y1: Math.min(...marks), y2: Math.max(...marks) };
  });

  const edges = layout.edges.flatMap((edge) => {
    const child = positions.get(edge.toId);
    const parent = positions.get(edge.fromId);
    if (!child || !parent) return [];
    const bend = Math.round((child.y + parent.y) / 2);
    return [{
      ...edge,
      d:
        child.x === parent.x
          ? `M ${child.x} ${child.y} V ${parent.y}`
          : `M ${child.x} ${child.y} V ${bend} H ${parent.x} V ${parent.y}`,
    }];
  });

  if (nodes.length === 0) {
    return (
      <div className="vt-graph-empty">
        <strong>No versions captured yet.</strong>
        <p>Open and save a set in Ableton while Recall is listening to build its version history.</p>
      </div>
    );
  }

  return (
    <div className="vt-graph" style={{ "--vt-graph-width": `${graphWidth}px` } as CSSProperties}>
      <svg
        className="vt-graph__drawing"
        width={graphWidth}
        height={graphHeight}
        viewBox={`0 0 ${graphWidth} ${graphHeight}`}
        aria-hidden="true"
      >
        <line className="vt-graph__axis" x1="112" y1="0" x2="112" y2={graphHeight} />
        {timeline.axis.map((tick) => (
          <text key={tick.atMs} className="vt-graph__axis-label" x="4" y={tick.y + 4}>
            {formatSessionDate(tick.atMs)}
          </text>
        ))}
        {timeline.breaks.map((brk) => (
          <g key={`${brk.y}-${brk.durationMs}`} className="vt-graph__idle-break">
            <line x1="112" y1={brk.y} x2={graphWidth} y2={brk.y} />
            <text x="4" y={brk.y - 6}>{brk.text}</text>
          </g>
        ))}
        {laneBounds.map(({ lane, y1, y2 }) => (
          <line
            key={`lane-${lane.index}`}
            className={`vt-graph__lane is-depth-${lane.depth}`}
            x1={120 + lane.index * 28}
            y1={y1}
            x2={120 + lane.index * 28}
            y2={y2}
          />
        ))}
        {edges.map((edge) => (
          <path
            key={`${edge.fromId}-${edge.toId}`}
            className={`is-depth-${placementById.get(edge.toId)?.lane ?? 0}${edge.inferred ? " is-inferred" : ""}`}
            d={edge.d}
            fill="none"
          />
        ))}
        {timeline.sittingTicks.map((tick, index) => {
          const position = positions.get(tick.nodeId);
          if (!position) return null;
          return (
            <line
              key={`sitting-${tick.nodeId}-${tick.atMs}-${index}`}
              className="vt-graph__sitting"
              x1={position.x - 1.5}
              y1={tick.y}
              x2={position.x + 1.5}
              y2={tick.y}
            />
          );
        })}
        {timeline.saveTicks.map((tick, index) => {
          const position = positions.get(tick.nodeId);
          if (!position) return null;
          return (
            <line
              key={`save-${tick.nodeId}-${tick.atMs}-${index}`}
              className="vt-graph__save"
              x1={position.x - 3}
              y1={tick.y}
              x2={position.x + 3}
              y2={tick.y}
            />
          );
        })}
        {ordered.map((node) => {
          const position = positions.get(node.id);
          if (!position) return null;
          return (
            <circle
              key={node.id}
              className={`${node.version.creativeEventCount === 0 ? "is-hollow " : ""}${node.id === selectedVersionId ? "is-selected" : ""}`}
              cx={position.x}
              cy={position.y}
              r="6"
            />
          );
        })}
      </svg>

      <ol className="vt-graph__rows" aria-label="Versions in this project">
        {ordered.map((node) => {
          const selected = node.id === selectedVersionId;
          const isLatest = latestVersion(nodes.map((item) => item.version))?.id === node.id;
          const row = rowById.get(node.id);
          return (
            <li
              key={node.id}
              style={{ "--vt-row-height": `${row?.height ?? ROW_HEIGHT}px` } as CSSProperties}
            >
              <button
                type="button"
                className={selected ? "is-selected" : undefined}
                aria-current={selected ? "true" : undefined}
                onClick={() => onSelectVersion(node.id)}
              >
                <span className="vt-graph__name">
                  {versionLabel(node.version)}
                  {isLatest && <span className="vt-badge">latest</span>}
                </span>
                <span className="vt-graph__headline">{versionWorkLine(node.version)}</span>
                <span className="vt-graph__meta">
                  Last worked {formatSessionDate(node.version.lastUpdatedAtMs)}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/**
 * When each of a project's `.als` files was actually made.
 *
 * Asked of the filesystem, once per project. Without it every version falls back
 * to its first capture — which is what the app did before, and is still right
 * for files Recall watched being created.
 */
function useAlsFileAges(captures: SavedSessionMetadata[]): AlsFileAges {
  const [ages, setAges] = useState<AlsFileAges>(() => new Map());
  const paths = useMemo(
    () => [...new Set(captures.map((capture) => capture.als_path).filter((path): path is string => Boolean(path)))],
    [captures],
  );
  const key = paths.join("|");

  useEffect(() => {
    let cancelled = false;
    if (paths.length === 0) {
      setAges(new Map());
      return;
    }
    void getAlsFileTimes(paths)
      .then((rows) => {
        if (cancelled) return;
        const next: AlsFileAges = new Map();
        for (const row of rows) {
          // Creation first, falling back to modification: a copied or restored
          // set can carry a modification time older than its creation, and the
          // earliest credible proof it existed is what the graph wants.
          const made = row.created_ms ?? row.modified_ms;
          const path = normalizeAlsPath(row.path);
          if (made !== null && made !== undefined && path) next.set(path, made);
        }
        setAges(next);
      })
      // The files may be on a drive that is not mounted. Falling back to first
      // capture is the old behaviour, not a failure worth showing.
      .catch(() => {
        if (!cancelled) setAges(new Map());
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return ages;
}

/* The graph is versions, and nothing else.
   A "Retrace N sittings" disclosure used to open inside the lane, pushing the
   version points apart and leaving a screen of empty rail behind whichever row
   was open. It also read a whole version bundle per row, on top of the one the
   detail below was already reading.
   The graph is the navigator: which files exist, how they descend, and when.
   What happened INSIDE a version belongs to the detail below, which is the
   surface built for it. */

function VersionInspector({
  selected,
  node,
  latest,
  onOpenReport,
}: {
  selected: ProjectVersion;
  node: VersionNode;
  latest: boolean;
  onOpenReport: () => void;
}) {
  const [revealStatus, setRevealStatus] = useState<string | null>(null);
  const sessionId = latestSitting(selected);
  const worked = groupSittings(selected.sessions).sittings;
  const firstWorked = worked[0] ?? null;
  const lastWorked = worked.at(-1) ?? null;

  async function revealInFolder() {
    setRevealStatus(null);
    const sourcePath = selected.sessions.at(-1)?.als_path ?? null;
    if (!sourcePath || !isTauri()) {
      setRevealStatus("Showing the file in its folder is available in the Recall desktop app.");
      return;
    }
    try {
      const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
      await revealItemInDir(sourcePath);
      setRevealStatus("Opened the folder.");
    } catch {
      setRevealStatus("Couldn't open that folder. The file may have been moved or renamed.");
    }
  }

  return (
    <aside className="vt-inspector" aria-label={`Selected version ${versionLabel(selected)}`}>
      <header className="vt-inspector__head">
        <div>
          <p className="vt__eyebrow">Selected version</p>
          <h2>{versionLabel(selected)}</h2>
        </div>
        {latest && <span className="vt-badge">latest</span>}
      </header>

      <dl className="vt-inspector__facts">
        <div>
          <dt>Came from</dt>
          <dd>{node.parentId ? node.reason : "The first version Recall knows about."}</dd>
        </div>
        <div>
          <dt>Evidence</dt>
          <dd className={node.inferred ? "is-inferred" : "is-observed"}>
            {node.parentId ? (node.inferred ? "Inferred" : "Observed") : "First captured version"}
          </dd>
        </div>
        <div>
          <dt>First worked</dt>
          <dd>
            {firstWorked
              ? `${formatSessionDate(firstWorked.startMs)} · ${formatClock(firstWorked.startMs)}`
              : "No producer work captured"}
          </dd>
        </div>
        <div>
          <dt>Left off</dt>
          <dd>
            {lastWorked
              ? `${formatSessionDate(lastWorked.endMs)} · ${formatClock(lastWorked.endMs)}`
              : "No last move captured"}
          </dd>
        </div>
      </dl>

      <div className="vt-inspector__actions">
        <button type="button" className="px-btn px-btn--primary" onClick={onOpenReport} disabled={!sessionId}>
          Open report
        </button>
        <button type="button" className="px-btn" onClick={() => void revealInFolder()} disabled={!selected.alsPath}>
          Show in folder
        </button>
      </div>
      {revealStatus && <p className="vt-inspector__status" role="status">{revealStatus}</p>}
    </aside>
  );
}

function presetRelationLabel(row: ComparedSavedPreset, parentName: string | null): string {
  const parent = parentName ?? "the parent version";
  switch (row.relation) {
    case "same":
      return `Unchanged from ${parent}`;
    case "edited":
      return `Edited since ${parent}`;
    case "renamed":
      return `Renamed from ${row.previous?.preset_name ?? "the parent patch"}`;
    case "changed":
      return `Changed from ${row.previous?.preset_name ?? "the parent patch"}`;
    case "added":
      return `Not present in ${parent}`;
    case "uncompared":
      return "Stored in this save";
  }
}

function presetByline(preset: StoredTrackPreset): string | null {
  const parts = [preset.preset_author, preset.preset_bank]
    .map((value) => value?.trim() ?? "")
    .filter((value, index, all) => value.length > 0 && all.indexOf(value) === index);
  return parts.length > 0 ? parts.join(" · ") : null;
}

/**
 * The sound state serialized into this `.als`, next to the version it belongs to.
 *
 * Deliberately separate from the movement trail: loading a Serum preset emits no
 * Live event, so placing these rows among captured moves would invent a time and
 * order that do not exist. The file proves only what was present at the save.
 */
function SavedPresetState({
  selected,
  parent,
}: {
  selected: ProjectVersion;
  parent: SelectedVersionParent | null;
}) {
  const currentPath = versionSourcePath(selected);
  const parentPath = parent?.alsPath ?? null;
  const readKey = `${currentPath ?? ""}::${parentPath ?? ""}`;
  const [rows, setRows] = useState<ComparedSavedPreset[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    setRows(null);
    if (!currentPath) return;

    const paths = [...new Set([currentPath, parentPath].filter((path): path is string => Boolean(path)))];
    void getAlsPresets(paths)
      .then((snapshots) => {
        if (cancelled) return;
        const byPath = new Map(
          snapshots.map((snapshot) => [normalizeAlsPath(snapshot.path), snapshot]),
        );
        const current = byPath.get(normalizeAlsPath(currentPath));
        if (!current?.readable || current.presets.length === 0) {
          setRows([]);
          return;
        }

        const previousSnapshot = parentPath
          ? byPath.get(normalizeAlsPath(parentPath))
          : null;
        // Null means "comparison unavailable", while [] means the readable
        // parent genuinely contained no supported Serum state.
        const previous = previousSnapshot?.readable ? previousSnapshot.presets : null;
        setRows(compareSavedPresets(current.presets, previous));
      })
      // A moved or mid-save set must not take the version Timeline down. Its
      // captured work remains useful even when this optional file evidence is not.
      .catch(() => {
        if (!cancelled) setRows([]);
      });

    return () => {
      cancelled = true;
    };
    // readKey covers both file inputs; the exact path values are intentionally
    // excluded so a new array/object identity cannot restart a 40MB read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readKey]);

  if (!rows || rows.length === 0) return null;

  return (
    <section className="vt-presets" aria-label="Serum 2 presets saved in this version">
      <header className="vt-presets__head">
        <div>
          <p className="vt__eyebrow">Saved sound state</p>
          <h2>
            {rows.length} Serum 2 {rows.length === 1 ? "patch" : "patches"} at last save
          </h2>
        </div>
        <p>
          Read from {versionLabel(selected)}. Loads between saves are not available.
        </p>
      </header>
      <ol className="vt-presets__list">
        {rows.map((row) => {
          const byline = presetByline(row.preset);
          return (
            <li key={row.key} className={`is-${row.relation}`}>
              <span className="vt-presets__track">{row.preset.track_name ?? "Track unavailable"}</span>
              <span className="vt-presets__patch">
                <strong>{row.preset.preset_name}</strong>
                {byline && <span>{byline}</span>}
              </span>
              <span className="vt-presets__relation">
                {presetRelationLabel(row, parent?.name ?? null)}
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function readableSubject(subject: string): string {
  return subject.replace(/ · /g, " — ");
}

function readablePosition(position: string): string {
  return position.replace(/\s*·\s*Beat\s*/gi, ", beat ");
}

function movementType(decision: ReportDecision): string {
  if (decision.kind === "midi") return "MIDI notes";
  if (decision.kind === "clip") return "Clip movement";
  if (decision.kind === "structure") return "Set movement";
  if (decision.kind === "moment") return "Marked moment";
  return producerWorkDefinition(decision.workKind).label;
}

/** The card's more specific label; the navigator keeps the broader work type. */
function movementCardLabel(decision: ReportDecision): string {
  if (decision.kind === "midi") return "MIDI note edit";
  if (decision.kind === "clip") {
    if (decision.workKind === "recording") return "Recorded clip";
    if (decision.workKind === "sound") return "Sample clip";
    return "Arrangement clip";
  }
  if (decision.kind === "moment") return "Producer marker";
  if (decision.kind === "structure") {
    if (decision.workKind === "arrangement") return "Arrangement change";
    if (decision.workKind === "mixing") return "Mix routing";
    return "Set structure";
  }
  if (decision.workKind === "mixing") return "Mix control";
  return "Sound control";
}

type MovementIconKind = "midi" | "clip" | "structure" | "moment" | "mixing" | "sound";

function movementIconKind(decision: ReportDecision): MovementIconKind {
  if (decision.kind === "midi") return "midi";
  if (decision.kind === "clip") return "clip";
  if (decision.kind === "structure") return "structure";
  if (decision.kind === "moment") return "moment";
  return decision.workKind === "mixing" ? "mixing" : "sound";
}

function MovementKindIcon({ decision }: { decision: ReportDecision }) {
  const icon = movementIconKind(decision);
  return (
    <span className={`vt-movement-card__icon is-${icon}`} aria-hidden="true">
      <svg viewBox="0 0 24 24" focusable="false">
        {icon === "midi" && (
          <>
            <path d="M9 17V6l10-2v11" />
            <ellipse cx="6.5" cy="17.5" rx="2.5" ry="2" />
            <ellipse cx="16.5" cy="15.5" rx="2.5" ry="2" />
          </>
        )}
        {icon === "clip" && (
          <>
            <rect x="3.5" y="5.5" width="17" height="13" rx="2" />
            <path d="M7 10h7M7 14h10" />
          </>
        )}
        {icon === "structure" && (
          <>
            <rect x="3.5" y="4" width="6" height="6" rx="1" />
            <rect x="14.5" y="14" width="6" height="6" rx="1" />
            <path d="M9.5 7H14a3.5 3.5 0 0 1 3.5 3.5V14" />
          </>
        )}
        {icon === "moment" && <path d="M6 4.5h12v15l-6-3.5-6 3.5zM9 9h6" />}
        {icon === "mixing" && (
          <>
            <path d="M6 4v16M12 4v16M18 4v16" />
            <rect x="4" y="7" width="4" height="4" rx="1" />
            <rect x="10" y="13" width="4" height="4" rx="1" />
            <rect x="16" y="9" width="4" height="4" rx="1" />
          </>
        )}
        {icon === "sound" && <path d="M3 12h3l2.2-6 3.2 12 2.6-9 2 6h5" />}
      </svg>
    </span>
  );
}

function movementShapeLabel(shape: MovementShape): string {
  switch (shape.shape) {
    case "binary": return "Switch";
    case "enum": return "Mode";
    case "scalar": return "Value";
    case "pattern": return "Piano roll";
    case "placement": return "Created";
    case "span": return "Clip span";
    case "tree": return shape.sign === "+" ? "Added" : shape.sign === "−" ? "Removed" : "Changed";
    case "global": return "Whole set";
    case "endpoints": return "Signal path";
    case "text": return "Captured note";
  }
}

const LIVE_PITCH_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"] as const;

function livePitchName(pitch: number): string {
  return `${LIVE_PITCH_NAMES[((pitch % 12) + 12) % 12]}${Math.floor(pitch / 12) - 2}`;
}

function pitchLabel(min: number | null, max: number | null, captured: string | null): string | null {
  if (captured?.trim()) {
    const value = captured.trim();
    const range = value.match(/^([A-G](?:#|b)?-?\d+)\s*-\s*([A-G](?:#|b)?-?\d+)$/i);
    return range ? `${range[1]} to ${range[2]}` : value;
  }
  if (min === null || max === null) return null;
  return min === max ? livePitchName(min) : `${livePitchName(min)}–${livePitchName(max)}`;
}

function compactNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
}

function beatOffset(value: number, origin: "clip" | "song"): string {
  if (value === 0) return origin === "clip" ? "Clip start" : "Song start";
  return `${compactNumber(value)} ${value === 1 ? "beat" : "beats"} after ${origin} start`;
}

function noteLengthLabel(beats: number): string {
  const musicalLengths = new Map<number, string>([
    [0.125, "1/32 note"],
    [0.25, "1/16 note"],
    [0.375, "dotted 1/16 note"],
    [0.5, "1/8 note"],
    [0.75, "dotted 1/8 note"],
    [1, "1/4 note"],
    [1.5, "dotted 1/4 note"],
    [2, "1/2 note"],
    [3, "dotted 1/2 note"],
    [4, "whole note"],
  ]);
  return musicalLengths.get(beats) ?? `${compactNumber(beats)} ${beats === 1 ? "beat" : "beats"}`;
}

function noteInventory(notes: MidiClipNote[]): string | null {
  const pitches = [...new Set(notes.map((note) => note.pitch))].sort((a, b) => a - b);
  return pitches.length > 0 ? pitches.map(livePitchName).join(" · ") : null;
}

function isBlackPitch(pitch: number): boolean {
  return new Set([1, 3, 6, 8, 10]).has(((pitch % 12) + 12) % 12);
}

type MidiRollRow = { key: "before" | "after"; label: string; notes: MidiClipNote[] };

function MidiPianoRoll({
  row,
  lowPitch,
  highPitch,
  startBeat,
  endBeat,
  meter,
}: {
  row: MidiRollRow;
  lowPitch: number;
  highPitch: number;
  startBeat: number;
  endBeat: number;
  /** The set's time signature, so the ruler can count the way Live's does. */
  meter: SongPositionSource | null;
}) {
  const keyboardWidth = 76;
  const viewWidth = 900;
  const rulerHeight = 26;
  const pitchCount = Math.max(1, highPitch - lowPitch + 1);
  const rowHeight = pitchCount > 28 ? 9 : pitchCount > 18 ? 11 : 14;
  const viewHeight = rulerHeight + pitchCount * rowHeight;
  const gridWidth = viewWidth - keyboardWidth;
  const timeSpan = Math.max(1, endBeat - startBeat);
  const pitches = Array.from({ length: pitchCount }, (_, index) => highPitch - index);
  const usedPitches = new Set(row.notes.map((note) => note.pitch));
  const subdivision = timeSpan > 32 ? 4 : timeSpan > 16 ? 2 : timeSpan > 8 ? 1 : 0.25;
  const firstTick = Math.ceil(startBeat / subdivision) * subdivision;
  const ticks = Array.from(
    { length: Math.floor((endBeat - firstTick) / subdivision) + 1 },
    (_, index) => firstTick + index * subdivision,
  ).filter((beat) => beat >= startBeat && beat <= endBeat);
  const beatX = (beat: number) => keyboardWidth + ((beat - startBeat) / timeSpan) * gridWidth;
  const isMajorTick = (beat: number) => Math.abs(beat - Math.round(beat)) < 0.0001;

  return (
    <section className={`vt-midi-pattern__row is-${row.key}`} aria-label={`${row.label} MIDI pattern`}>
      <header>
        <span className="vt-midi-pattern__state">{row.label}</span>
        <strong>{row.notes.length} {row.notes.length === 1 ? "note" : "notes"}</strong>
      </header>
      <svg
        viewBox={`0 0 ${viewWidth} ${viewHeight}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`${row.label}: ${row.notes.length} captured ${row.notes.length === 1 ? "note" : "notes"} on an Ableton-style piano roll`}
        style={{ ["--midi-roll-ratio" as string]: `${viewWidth} / ${viewHeight}` }}
      >
        <rect className="vt-midi-roll__ruler" x={keyboardWidth} y="0" width={gridWidth} height={rulerHeight} />
        <rect className="vt-midi-roll__loop" x={keyboardWidth} y="2" width={gridWidth} height="4" rx="2" />

        {pitches.map((pitch, index) => {
          const y = rulerHeight + index * rowHeight;
          const black = isBlackPitch(pitch);
          const labelPitch = pitch % 12 === 0 || usedPitches.has(pitch);
          return (
            <g key={pitch}>
              <rect
                className={`vt-midi-roll__lane ${black ? "is-black" : "is-white"}`}
                x={keyboardWidth}
                y={y}
                width={gridWidth}
                height={rowHeight}
              />
              <rect
                className={`vt-midi-roll__key ${black ? "is-black" : "is-white"}`}
                x="0"
                y={y}
                width={black ? keyboardWidth * 0.66 : keyboardWidth}
                height={rowHeight}
              />
              {labelPitch && rowHeight >= 9 && (
                <text
                  className="vt-midi-roll__key-label"
                  x={black ? keyboardWidth * 0.61 : keyboardWidth - 5}
                  y={y + rowHeight * 0.72}
                  textAnchor="end"
                >
                  {livePitchName(pitch)}
                </text>
              )}
            </g>
          );
        })}

        {ticks.map((beat) => {
          const x = beatX(beat);
          const major = isMajorTick(beat);
          return (
            <g key={beat}>
              <line
                className={`vt-midi-roll__tick ${major ? "is-major" : "is-subdivision"}`}
                x1={x}
                x2={x}
                y1={major ? 7 : rulerHeight - 7}
                y2={viewHeight}
              />
              {major && beat < endBeat && (
                <text className="vt-midi-roll__beat-label" x={x + 5} y="20">
                  {/* Live's own notation: 1.1 · 1.2 · 1.3 · 1.4 · 2.1. This
                      counted raw quarter-notes (1 2 3 4 5 6 7 8), so a note at
                      1.3 was labelled "beat 3" — right in Live's internal unit
                      and in the wrong language. Falls back to the plain count
                      only when the meter is unknown, never to an assumed 4/4. */}
                  {barBeatLabel(beat - startBeat, meter) ?? Math.floor(beat - startBeat) + 1}
                </text>
              )}
            </g>
          );
        })}

        {row.notes.map((note, index) => {
          const x = beatX(note.start_time);
          const width = Math.max(4, (note.duration / timeSpan) * gridWidth);
          const y = rulerHeight + (highPitch - note.pitch) * rowHeight + 1;
          const canLabel = width >= 40 && rowHeight >= 11;
          return (
            <g key={note.note_id ?? `${note.pitch}-${note.start_time}-${index}`}>
              <rect
                className={`vt-midi-roll__note is-${row.key} ${note.mute ? "is-muted" : ""}`}
                x={x}
                y={y}
                width={Math.min(width, keyboardWidth + gridWidth - x)}
                height={Math.max(5, rowHeight - 2)}
                rx="1.5"
              />
              {canLabel && (
                <text className="vt-midi-roll__note-label" x={x + 5} y={y + rowHeight * 0.69}>
                  {livePitchName(note.pitch)}
                </text>
              )}
            </g>
          );
        })}
        <line className="vt-midi-roll__keyboard-edge" x1={keyboardWidth} x2={keyboardWidth} y1="0" y2={viewHeight} />
      </svg>
    </section>
  );
}

function MidiPatternChange({
  edit,
  meter,
}: {
  edit: NoteEdit;
  /** The set's time signature. Null when it is unknown or the set changed it. */
  meter: SongPositionSource | null;
}) {
  const after = edit.midi_notes ?? [];
  const before = edit.previous_midi_notes;
  const all = [...(before ?? []), ...after];
  if (all.length === 0 && before === null) return null;

  // A piano roll starts at the clip boundary, even when the first note does
  // not. Keeping the empty lead-in is what makes a late entrance visible.
  const minStart = all.length > 0 ? Math.min(0, ...all.map((note) => note.start_time)) : 0;
  const maxEnd = Math.max(
    all.length > 0 ? Math.max(...all.map((note) => note.start_time + note.duration)) : 0,
    edit.length_beats ?? 0,
    minStart + 1,
  );
  let minPitch = all.length > 0 ? Math.max(0, Math.min(...all.map((note) => note.pitch)) - 2) : 60;
  let maxPitch = all.length > 0 ? Math.min(127, Math.max(...all.map((note) => note.pitch)) + 2) : 71;
  if (maxPitch - minPitch + 1 < 12) {
    const center = Math.round((minPitch + maxPitch) / 2);
    minPitch = Math.max(0, center - 6);
    maxPitch = Math.min(127, minPitch + 11);
    minPitch = Math.max(0, maxPitch - 11);
  }
  const rows = before !== undefined && before !== null
    ? [{ key: "before" as const, label: "Before", notes: before }, { key: "after" as const, label: "After", notes: after }]
    : [{ key: "after" as const, label: "Pattern", notes: after }];
  const details = rows.flatMap((row) => row.notes.map((note, index) => ({ ...row, note, index })));
  const valuesDiffer = <T,>(values: T[]) => new Set(values).size > 1;
  const velocities = details.map(({ note }) => note.velocity).filter((value): value is number => value !== null);
  const chances = details.map(({ note }) => note.probability).filter((value): value is number => value !== null);
  const variations = details.map(({ note }) => note.velocity_deviation).filter((value): value is number => value !== null);
  const releases = details.map(({ note }) => note.release_velocity).filter((value): value is number => value !== null);
  // Live's unchanged defaults do not belong in every row. A setting appears
  // only when it varies across the captured notes or carries a non-default
  // value that can actually help recreate the part.
  const showVelocity = valuesDiffer(velocities) || velocities.some((value) => value !== 100);
  const showChance = valuesDiffer(chances) || chances.some((value) => value !== 1);
  const showVariation = valuesDiffer(variations) || variations.some((value) => value !== 0);
  const showRelease = valuesDiffer(releases) || releases.some((value) => value !== 64);

  return (
    <section className="vt-midi-pattern" aria-label="Exact captured MIDI pattern">
      <header>
        <span>Piano roll · clip beats</span>
        <strong>{noteInventory(after) ?? (after.length === 0 ? "No notes after this edit" : "Pitch names unavailable")}</strong>
      </header>
      <div className="vt-midi-pattern__rows">
        {rows.map((row) => (
          <MidiPianoRoll
            key={row.key}
            row={row}
            lowPitch={minPitch}
            highPitch={maxPitch}
            startBeat={minStart}
            endBeat={maxEnd}
            meter={meter}
          />
        ))}
      </div>
      <div className="vt-midi-pattern__axis">
        <span>{beatOffset(minStart, "clip")}</span>
        <span>
          {barCountLabel(maxEnd - minStart, meter) ??
            `${compactNumber(maxEnd - minStart)} quarter-note ${maxEnd - minStart === 1 ? "beat" : "beats"} shown`}
          {barCountLabel(maxEnd - minStart, meter) ? " shown" : ""}
        </span>
      </div>
      {(edit.midi_notes_truncated || edit.previous_midi_notes_truncated) && (
        <p className="vt-midi-pattern__limit">
          Pattern detail reached Recall’s capture limit. Open the saved .als for notes beyond this snapshot.
        </p>
      )}
      {details.length > 0 && (
        <details className="vt-midi-note-list">
          <summary>
            Show all captured notes · {before !== undefined && before !== null ? `${before.length} before · ` : ""}{after.length} after
          </summary>
          <ol>
            {details.map(({ key, label, note, index }) => (
              <li key={`${key}-${note.note_id ?? `${note.pitch}-${note.start_time}-${index}`}`}>
                <span>{label}</span>
                <strong>{livePitchName(note.pitch)}</strong>
                <span>{note.start_time === 0 ? "Clip start" : beatOffset(note.start_time, "clip")}</span>
                <span>{noteLengthLabel(note.duration)}</span>
                {showVelocity && note.velocity !== null && <span>Velocity {compactNumber(note.velocity)}</span>}
                {showChance && note.probability !== null && <span>Chance {compactNumber(note.probability * 100)}%</span>}
                {showVariation && note.velocity_deviation !== null && <span>Variation {compactNumber(note.velocity_deviation)}</span>}
                {showRelease && note.release_velocity !== null && <span>Release {compactNumber(note.release_velocity)}</span>}
                {note.mute && <span>Muted</span>}
              </li>
            ))}
          </ol>
        </details>
      )}
    </section>
  );
}

function MidiPitchScale({ edit }: { edit: NoteEdit }) {
  const beforeLabel = pitchLabel(edit.previous_pitch_min, edit.previous_pitch_max, edit.previous_pitch_range);
  const afterLabel = pitchLabel(edit.pitch_min, edit.pitch_max, edit.pitch_range);
  const numericPitches = [
    edit.previous_pitch_min,
    edit.previous_pitch_max,
    edit.pitch_min,
    edit.pitch_max,
  ].filter((pitch): pitch is number => pitch !== null && Number.isFinite(pitch));
  if (!beforeLabel && !afterLabel && numericPitches.length === 0) {
    return <p className="vt-midi-scale__empty">Pitch range was not captured.</p>;
  }

  const changed = Boolean(
    beforeLabel &&
    (beforeLabel !== afterLabel || edit.previous_pitch_min !== edit.pitch_min || edit.previous_pitch_max !== edit.pitch_max),
  );
  const rows = changed
    ? [
        { key: "before", label: "Before", min: edit.previous_pitch_min, max: edit.previous_pitch_max, value: beforeLabel },
        { key: "after", label: "After", min: edit.pitch_min, max: edit.pitch_max, value: afterLabel ?? "No notes" },
      ]
    : [{ key: "after", label: "Pitch", min: edit.pitch_min, max: edit.pitch_max, value: afterLabel ?? beforeLabel ?? "No notes" }];

  let low = numericPitches.length > 0 ? Math.max(0, Math.min(...numericPitches)) : 0;
  let high = numericPitches.length > 0 ? Math.min(127, Math.max(...numericPitches)) : 11;
  const minimumSpan = 12;
  const observedSpan = high - low + 1;
  if (observedSpan < minimumSpan) {
    const missing = minimumSpan - observedSpan;
    low = Math.max(0, low - Math.floor(missing / 2));
    high = Math.min(127, low + minimumSpan - 1);
    low = Math.max(0, high - minimumSpan + 1);
  }
  const steps = Math.max(1, high - low + 1);
  const octaveMarkers = Array.from({ length: high - low + 1 }, (_, index) => low + index)
    .filter((pitch) => pitch % 12 === 0);
  const scaleStyle = { ["--pitch-steps" as string]: steps } as CSSProperties;

  return (
    <section
      className={`vt-midi-scale ${numericPitches.length === 0 ? "has-no-geometry" : ""}`}
      aria-label={changed
        ? `Pitch changed from ${beforeLabel} to ${afterLabel ?? "no notes"}`
        : `Pitch range ${afterLabel ?? beforeLabel ?? "not captured"}`}
    >
      <span className="vt-midi-scale__title">Pitch span · lowest to highest</span>
      {numericPitches.length > 0 && (
        <div className="vt-midi-scale__axis" aria-hidden="true">
          <span />
          <div>
            {octaveMarkers.map((pitch) => (
              <i key={pitch} style={{ left: `${((pitch - low + 0.5) / steps) * 100}%` }}>{livePitchName(pitch)}</i>
            ))}
          </div>
          <span />
        </div>
      )}
      <div className="vt-midi-scale__rows" style={scaleStyle}>
        {rows.map((row) => {
          const hasGeometry = numericPitches.length > 0 && row.min !== null && row.max !== null;
          const rowMin = hasGeometry ? Math.min(row.min!, row.max!) : 0;
          const rowMax = hasGeometry ? Math.max(row.min!, row.max!) : 0;
          return (
            <div className="vt-midi-scale__row" key={row.key}>
              <span>{row.label}</span>
              <div className="vt-midi-scale__lane" aria-hidden="true">
                {hasGeometry && (
                  <i
                    className={`vt-midi-scale__bar is-${row.key}`}
                    style={{
                      left: `${((rowMin - low) / steps) * 100}%`,
                      width: `${Math.max(2.5, ((rowMax - rowMin + 1) / steps) * 100)}%`,
                    }}
                  />
                )}
              </div>
              <strong>{row.value}</strong>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function noteCountLabel(edit: NoteEdit): string {
  const before = edit.previous_note_count;
  const after = edit.note_count;
  if (before !== null && after !== null && before !== after) return `${before} → ${after} notes`;
  const count = after ?? before;
  if (count === null) return "Not captured";
  return count === 1 ? "1 note" : `${count} notes`;
}

function midiEditLabel(edit: NoteEdit): string {
  if (!edit.change_kind) return "Changed notes";
  const label = NOTE_KIND_LABEL[edit.change_kind];
  return `${label.charAt(0).toLocaleUpperCase()}${label.slice(1)} notes`;
}

/** One complete decision card; repeated nudges remain available underneath. */
/**
 * One renderer per data shape.
 *
 * `movementShape.ts` decides WHAT a movement is; these decide how it reads. The
 * rule they all follow: show the fact in the form the fact actually has. A
 * switch shows a state, a mode shows two names, a value shows a distance, a
 * position shows a place on the grid. None of them show a sentence, because a
 * sentence is the form that lost the information in the first place.
 */
function PowerStateIcon({ on }: { on: boolean }) {
  return (
    <span className={`vt-state-icon ${on ? "is-on" : "is-off"}`} aria-hidden="true">
      <svg viewBox="0 0 24 24" focusable="false">
        <path d="M12 3v8" />
        <path d="M7.8 6.7a7 7 0 1 0 8.4 0" />
        {!on && <path className="vt-state-icon__slash" d="M4 4l16 16" />}
      </svg>
    </span>
  );
}

function BinaryState({ on, from, label }: { on: boolean; from: boolean | null; label: string }) {
  return (
    <div className="vt-shape vt-shape--binary">
      <span className="vt-binary" role="img" aria-label={`${label} is ${on ? "on" : "off"}`}>
        {/* Both states are always drawn, so the one it landed in is read as a
            position rather than as a word you have to hold in your head. */}
        <span className={`vt-binary__state ${on ? "" : "is-set"}`}>
          <PowerStateIcon on={false} />
          <span>Off</span>
        </span>
        <span className={`vt-binary__state ${on ? "is-set" : ""}`}>
          <PowerStateIcon on />
          <span>On</span>
        </span>
      </span>
      {from !== null && from !== on && (
        <span className="vt-shape__from">Previous state: {from ? "on" : "off"}</span>
      )}
    </div>
  );
}

function EnumChange({ from, to, note }: { from: string | null; to: string; note: string | null }) {
  return (
    <div>
      <div className="vt-shape vt-shape--enum">
        {from && (
          <>
            <span className="vt-enum__was">{from}</span>
            <span className="vt-shape__arrow" aria-hidden="true">→</span>
          </>
        )}
        <span className="vt-enum__is">{to}</span>
      </div>
      {note && <p className="vt-shape__note">{note}</p>}
    </div>
  );
}

const FREQUENCY_TICKS = [20, 100, 1_000, 10_000, 20_000];

function frequencyPosition(value: number) {
  const low = 20;
  const high = 20_000;
  const clamped = Math.min(high, Math.max(low, value));
  return (Math.log(clamped / low) / Math.log(high / low)) * 100;
}

function frequencyLabel(value: number) {
  return value >= 1_000 ? `${value / 1_000}k` : `${value}`;
}

/** Hz is perceived and laid out logarithmically: 20→200 Hz deserves the same
    width as 2k→20k Hz. A generic percentage or rotary control hides that. */
function FrequencyScale({
  from,
  to,
  fromLabel,
  toLabel,
}: {
  from: number;
  to: number;
  fromLabel: string | null;
  toLabel: string | null;
}) {
  const fromPosition = frequencyPosition(from);
  const toPosition = frequencyPosition(to);
  const start = Math.min(fromPosition, toPosition);
  const width = Math.max(1, Math.abs(toPosition - fromPosition));

  return (
    <div className="vt-shape vt-shape--frequency">
      <div className="vt-frequency__readings">
        <span className="vt-frequency__reading is-before"><span>Before</span>{fromLabel ?? `${from} Hz`}</span>
        <span className="vt-frequency__reading is-after"><span>After</span>{toLabel ?? `${to} Hz`}</span>
      </div>
      <div
        className="vt-frequency__scale"
        role="img"
        aria-label={`Frequency moved from ${fromLabel ?? `${from} Hz`} to ${toLabel ?? `${to} Hz`} on a logarithmic 20 Hz to 20 kHz scale`}
      >
        <span className="vt-frequency__range" style={{ left: `${start}%`, width: `${width}%` }} aria-hidden="true" />
        {FREQUENCY_TICKS.map((tick) => (
          <span
            key={tick}
            className="vt-frequency__tick"
            style={{ left: `${frequencyPosition(tick)}%` }}
            aria-hidden="true"
          >
            <i />
            <b>{frequencyLabel(tick)}</b>
          </span>
        ))}
        <span className="vt-frequency__marker is-before" style={{ left: `${fromPosition}%` }} aria-hidden="true" />
        <span className="vt-frequency__marker is-after" style={{ left: `${toPosition}%` }} aria-hidden="true" />
      </div>
    </div>
  );
}

function ScalarChange({
  fromLabel,
  toLabel,
  fromFraction,
  toFraction,
  rose,
  asMeter,
  frequency,
}: {
  fromLabel: string | null;
  toLabel: string | null;
  fromFraction: number | null;
  toFraction: number | null;
  rose: boolean | null;
  asMeter: boolean;
  frequency: { from: number; to: number } | null;
}) {
  if (frequency && !asMeter) {
    return <FrequencyScale from={frequency.from} to={frequency.to} fromLabel={fromLabel} toLabel={toLabel} />;
  }
  const drawable = fromFraction !== null && toFraction !== null;
  const knobPoint = (fraction: number, radius: number) => {
    const angle = (-135 + fraction * 270) * (Math.PI / 180);
    return {
      x: 42 + Math.cos(angle) * radius,
      y: 42 + Math.sin(angle) * radius,
    };
  };

  let knobTravel: string | null = null;
  let fromPoint = { x: 42, y: 42 };
  let toPoint = { x: 42, y: 42 };
  if (drawable) {
    const low = Math.min(fromFraction, toFraction);
    const high = Math.max(fromFraction, toFraction);
    const travelStart = knobPoint(low, 32);
    const travelEnd = knobPoint(high, 32);
    knobTravel = [
      `M ${travelStart.x} ${travelStart.y}`,
      `A 32 32 0 ${high - low > 2 / 3 ? 1 : 0} 1 ${travelEnd.x} ${travelEnd.y}`,
    ].join(" ");
    fromPoint = knobPoint(fromFraction, 21);
    toPoint = knobPoint(toFraction, 23);
  }

  return (
    <div className={`vt-shape vt-shape--scalar ${asMeter ? "is-meter" : "is-knob"}`}>
      {(!asMeter || !drawable) && <div className="vt-scalar__values">
        {fromLabel && (
          <span className="vt-scalar__reading vt-scalar__from">
            <span>Before</span>
            <strong>{fromLabel}</strong>
          </span>
        )}
        {toLabel && (
          <span className="vt-scalar__reading vt-scalar__to">
            <span>After</span>
            <strong>{toLabel}</strong>
          </span>
        )}
      </div>}
      {drawable && asMeter && (
        <div className={`vt-scalar__meter-comparison ${rose === false ? "is-lower" : "is-higher"}`}>
          <div className="vt-scalar__meter-column is-before">
            <span className="vt-scalar__meter-label">Before</span>
            <strong>{fromLabel ?? `${Math.round(fromFraction * 100)}%`}</strong>
            <div
              className="vt-scalar__meter"
              role="img"
              aria-label={`Before level ${fromLabel ?? `${Math.round(fromFraction * 100)}%`}; 0 at the top and negative infinity at the bottom`}
            >
              <span className="vt-scalar__meter-zero">0</span>
              <span className="vt-scalar__meter-rail" aria-hidden="true">
                <i
                  className="vt-scalar__meter-fill is-before"
                  style={{ top: `${(1 - fromFraction) * 100}%`, height: `${fromFraction * 100}%` }}
                />
              </span>
              <span className="vt-scalar__meter-infinity">−∞</span>
            </div>
          </div>
          <div className="vt-scalar__meter-column is-after">
            <span className="vt-scalar__meter-label">After</span>
            <strong>{toLabel ?? `${Math.round(toFraction * 100)}%`}</strong>
            <div
              className="vt-scalar__meter"
              role="img"
              aria-label={`After level ${toLabel ?? `${Math.round(toFraction * 100)}%`}; 0 at the top and negative infinity at the bottom`}
            >
              <span className="vt-scalar__meter-zero">0</span>
              <span className="vt-scalar__meter-rail" aria-hidden="true">
                <i
                  className="vt-scalar__meter-fill is-after"
                  style={{ top: `${(1 - toFraction) * 100}%`, height: `${toFraction * 100}%` }}
                />
                <i
                  className="vt-scalar__meter-change"
                  style={{
                    top: `${(1 - Math.max(fromFraction, toFraction)) * 100}%`,
                    height: `${Math.abs(toFraction - fromFraction) * 100}%`,
                  }}
                />
              </span>
              <span className="vt-scalar__meter-infinity">−∞</span>
            </div>
          </div>
        </div>
      )}
      {drawable && !asMeter && (
        // A rotary control mirrors the physical gesture: the producer turned
        // a control from the ghost hand to the bright final hand.
        <svg
          className="vt-scalar__knob"
          viewBox="0 0 84 84"
          role="img"
          aria-label={`Turned from ${Math.round(fromFraction * 100)}% to ${Math.round(toFraction * 100)}%`}
        >
          <path className="vt-scalar__knob-track" d="M 19.37 19.37 A 32 32 0 1 1 19.37 64.63" />
          {knobTravel && <path className="vt-scalar__knob-travel" d={knobTravel} />}
          <circle className="vt-scalar__knob-face" cx="42" cy="42" r="25" />
          <line
            className="vt-scalar__knob-hand is-from"
            x1="42"
            y1="42"
            x2={fromPoint.x}
            y2={fromPoint.y}
          />
          <line
            className="vt-scalar__knob-hand is-to"
            x1="42"
            y1="42"
            x2={toPoint.x}
            y2={toPoint.y}
          />
          <circle className="vt-scalar__knob-cap" cx="42" cy="42" r="3" />
        </svg>
      )}
    </div>
  );
}

/**
 * Something occupying a stretch of the arrangement.
 *
 * The same unit as the piano roll — quarter-note beats, left to right — but a
 * different origin. This span is absolute song time; the piano roll is local
 * to the clip. Both labels state that distinction instead of saying only Beat.
 */
function BeatSpan({
  startBeats,
  endBeats,
  position,
}: {
  startBeats: number;
  endBeats: number;
  position: string | null;
}) {
  const length = endBeats - startBeats;
  // These are Live's absolute quarter-note units. Do not convert them to bars:
  // that would silently assume a permanent 4/4 meter and becomes false as soon
  // as the set changes time signature.
  const frameStart = Math.max(0, Math.floor(startBeats) - 1);
  const frameEnd = Math.ceil(endBeats) + 1;
  const frame = Math.max(1, frameEnd - frameStart);
  const left = ((startBeats - frameStart) / frame) * 100;
  const width = Math.max(1.5, (length / frame) * 100);
  const gridStep = frame > 32 ? 4 : frame > 16 ? 2 : 1;

  return (
    <div className="vt-shape vt-shape--span">
      <div className="vt-span__head">
        <span className="vt-shape__label">Placed at</span>
        <span className="vt-span__where">
          {position ?? `Song beat ${compactNumber(startBeats)}`} · {compactNumber(length)} {length === 1 ? "beat" : "beats"} long
        </span>
      </div>
      <div
        className="vt-span__grid"
        role="img"
        aria-label={`Clip placed at ${position ?? `song beat ${compactNumber(startBeats)}`}; ${compactNumber(length)} ${length === 1 ? "beat" : "beats"} long`}
      >
        {Array.from({ length: Math.floor(frame / gridStep) + 1 }, (_, index) => (
          <span
            key={index}
            className="vt-span__grid-line"
            style={{ left: `${((index * gridStep) / frame) * 100}%` }}
          />
        ))}
        <span className="vt-span__block" style={{ left: `${left}%`, width: `${width}%` }} />
      </div>
    </div>
  );
}

function ClipPlacement({
  startBeats,
  endBeats,
  position,
}: {
  startBeats: number | null;
  endBeats: number | null;
  position: string | null;
}) {
  const length = startBeats !== null && endBeats !== null && endBeats > startBeats
    ? endBeats - startBeats
    : null;
  const where = position ?? (startBeats !== null ? `Song beat ${compactNumber(startBeats)}` : "Not captured");

  return (
    <dl
      className="vt-shape vt-shape--placement"
      aria-label={`Clip created at ${where}${length !== null ? `; ${compactNumber(length)} ${length === 1 ? "beat" : "beats"} long` : ""}`}
    >
      <div>
        <dt>Created at</dt>
        <dd>{where}</dd>
      </div>
      {length !== null && (
        <div>
          <dt>Length</dt>
          <dd>{compactNumber(length)} {length === 1 ? "beat" : "beats"}</dd>
        </div>
      )}
    </dl>
  );
}

function TreeChange({
  sign,
  text,
}: {
  sign: "+" | "−" | "~";
  text: string;
}) {
  return (
    <ul className="vt-shape vt-shape--tree vt-diff">
      <li className={sign === "+" ? "is-added" : sign === "−" ? "is-removed" : "is-altered"}>
        <StructuralChangeIcon sign={sign} />
        <span className="vt-diff__label">{text}</span>
      </li>
    </ul>
  );
}

function StructuralChangeIcon({ sign }: { sign: "+" | "−" | "~" }) {
  const label = sign === "+" ? "Added" : sign === "−" ? "Removed" : "Changed in place";
  return (
    <span className="vt-change-icon" role="img" aria-label={label}>
      <svg viewBox="0 0 24 24" focusable="false" aria-hidden="true">
        {sign === "+" && <path d="M12 5v14M5 12h14" />}
        {sign === "−" && <path d="M5 12h14" />}
        {sign === "~" && (
          <>
            <path d="M5 8h12l-3-3M17 8l-3 3" />
            <path d="M19 16H7l3 3M7 16l3-3" />
          </>
        )}
      </svg>
    </span>
  );
}

function GlobalValue({ label, from, to }: { label: string; from: string | null; to: string }) {
  return (
    <div className="vt-shape vt-shape--global">
      {/* Set-wide, so it is deliberately not laid out like a track's control. */}
      <span className="vt-shape__label">{label} · whole set</span>
      <span className="vt-global__value">
        {from && (
          <>
            <span className="vt-global__was">{from}</span>
            <span className="vt-shape__arrow" aria-hidden="true">→</span>
          </>
        )}
        <strong>{to}</strong>
      </span>
    </div>
  );
}

function Endpoints({ from, to }: { from: string | null; to: string }) {
  return (
    <div className="vt-shape vt-shape--endpoints">
      <span className="vt-endpoints__from">{from ?? "not captured"}</span>
      <span className="vt-shape__arrow" aria-hidden="true">→</span>
      <span className="vt-endpoints__to">{to}</span>
    </div>
  );
}

/** The whole switch, so a card never has to know about shapes individually. */
function MovementShapeView({
  shape,
  position = null,
  mixControl = false,
}: {
  shape: MovementShape;
  position?: string | null;
  mixControl?: boolean;
}) {
  switch (shape.shape) {
    case "binary":
      return <BinaryState on={shape.on} from={shape.from} label={shape.label} />;
    case "enum":
      return <EnumChange from={shape.from} to={shape.to} note={shape.note} />;
    case "scalar":
      return (
        <ScalarChange
          fromLabel={shape.fromLabel}
          toLabel={shape.toLabel}
          fromFraction={shape.fromFraction}
          toFraction={shape.toFraction}
          rose={shape.rose}
          asMeter={mixControl}
          frequency={shape.frequency}
        />
      );
    case "span":
      return (
        <BeatSpan
          startBeats={shape.startBeats}
          endBeats={shape.endBeats}
          position={position}
        />
      );
    case "placement":
      return (
        <ClipPlacement
          startBeats={shape.startBeats}
          endBeats={shape.endBeats}
          position={position}
        />
      );
    case "tree":
      return <TreeChange sign={shape.sign} text={shape.text} />;
    case "global":
      return <GlobalValue label={shape.label} from={shape.from} to={shape.to} />;
    case "endpoints":
      return <Endpoints from={shape.from} to={shape.to} />;
    case "pattern":
      // Handled by the card itself, which already owns the piano roll and its
      // degraded fallback.
      return null;
    case "text":
      return <p className="vt-shape vt-shape--text">{shape.text}</p>;
  }
}

function MovementTime({ startMs, endMs }: { startMs: number; endMs: number }) {
  const ranged = endMs > startMs;
  return (
    <aside
      className={`vt-movement-time ${ranged ? "is-range" : "is-point"}`}
      aria-label={ranged
        ? `Time from ${formatClock(startMs)} to ${formatClock(endMs)}`
        : `Time ${formatClock(startMs)}`}
    >
      {ranged ? (
        <>
          <span className="vt-movement-time__title">Time</span>
          <div className="vt-movement-time__point">
            <span>First</span>
            <time>{formatClock(startMs)}</time>
          </div>
          <span className="vt-movement-time__rail" aria-hidden="true"><i /></span>
          <div className="vt-movement-time__point">
            <span>Last</span>
            <time>{formatClock(endMs)}</time>
          </div>
          <strong>{formatDuration(endMs - startMs)} span</strong>
        </>
      ) : (
        <time>{formatClock(startMs)}</time>
      )}
    </aside>
  );
}

/**
 * Memoised because a version renders hundreds of these, and a third of them
 * build a piano-roll SVG with up to a few thousand `<rect>` elements.
 *
 * The decision and its evidence are immutable once loaded, so anything that
 * re-renders the screen for an unrelated reason — a connection poll, a library
 * refresh, opening a different sitting — must not rebuild all of them.
 */
const MovementCard = memo(function MovementCard({
  decision,
  evidence,
  domId,
  meter,
  showSongPositions,
}: {
  decision: ReportDecision;
  evidence: ReportEvidence[];
  domId: string;
  /** The set's time signature, so positions read in bars rather than beats. */
  meter: SongPositionSource | null;
  showSongPositions: boolean;
}) {
  const positions = [...new Set(evidence
    .map((row) => row.position)
    .filter((item): item is string => Boolean(item))
    .map(readablePosition))];
  const expectedEvidence = decision.evidenceIds.length;
  const missingEvidence = Math.max(0, expectedEvidence - evidence.length);
  const repeated = expectedEvidence > 1;
  const midi = decision.kind === "midi"
    ? evidence.find((row) => row.midi)?.midi ?? null
    : null;
  const shape = movementShape(decision);
  const midiSummary = midi ? describeMidiChange(midi) : null;
  const midiClip = midi ? namedMidiClip(midi) : null;
  const displayTitle = midiSummary?.headline ?? readableSubject(decision.subject);
  const hasMidiPattern = Boolean(
    midi && ((midi.note_snapshot_version ?? 0) >= 1 || (midi.midi_notes?.length ?? 0) > 0 || midi.previous_midi_notes !== undefined),
  );
  const midiPitches = midi?.midi_notes ? noteInventory(midi.midi_notes) : null;
  const midiVelocityIsUseful = Boolean(
    midi && midi.velocity_mean !== null && (
      !midi.midi_notes || midi.midi_notes.length === 0 ||
      midi.midi_notes.some((note) => note.velocity !== null && note.velocity !== 100)
    ),
  );
  // Track and device administration belongs to the set, not a point in the
  // arrangement. Keep song positions for musical work (including clip moves),
  // but do not imply that a rename or device-chain edit happened *at* a bar.
  const isSetAdministration = decision.kind === "structure" && /\b(?:track|device)\b/i.test(decision.subject);
  const showTopLevelPositions = showSongPositions && !isSetAdministration && decision.kind !== "control" && !(
    decision.kind === "clip" && (shape.shape === "span" || shape.shape === "placement")
  );
  // The bar/beat is transport context. A structural move can describe the
  // destination; every other action is simply recorded at the playhead.
  const renderedPositionLabel = decision.kind === "structure" && /\bmoved\b/i.test(decision.subject)
    ? "Moved to"
    : "At";
  const midiMissing = midi
    ? [
        midi.note_count === null && midi.previous_note_count === null ? "note count" : null,
        midi.pitch_range === null && midi.pitch_min === null &&
          midi.previous_pitch_range === null && midi.previous_pitch_min === null ? "pitch range" : null,
        midi.distinct_pitches === null ? "distinct pitches" : null,
        midi.velocity_mean === null ? "velocity" : null,
        midi.length_beats === null ? "clip length" : null,
      ].filter((fact): fact is string => fact !== null)
    : [];

  return (
    <li
      id={domId}
      className={`vt-movement-card is-${decision.kind}`}
      data-work-kind={decision.workKind}
      data-movement-shape={shape.shape}
      data-timeline-movement="true"
    >
      <article aria-label={`${movementCardLabel(decision)}: ${displayTitle}`}>
        <div className="vt-movement-card__content">
          <header className="vt-movement-card__head">
            <div className="vt-movement-card__identity">
              <MovementKindIcon decision={decision} />
              <div>
                <div className="vt-movement-card__badges">
                  <span className="vt-movement-card__kind">{movementCardLabel(decision)}</span>
                  <span className="vt-movement-card__shape-badge">{movementShapeLabel(shape)}</span>
                </div>
                <h4>{displayTitle}</h4>
              </div>
            </div>
          </header>

          <dl className="vt-movement-card__facts">
            {decision.track && <div><dt>Track</dt><dd>{decision.track}</dd></div>}
            {midiClip && <div><dt>Clip</dt><dd>{midiClip}</dd></div>}
            {midi ? (
              <>
                <div><dt>Edit</dt><dd>{midiEditLabel(midi)}</dd></div>
                <div className="vt-midi-fact-stack">
                  {midi.length_beats !== null && (
                    <div><dt>Clip length</dt><dd>{compactNumber(midi.length_beats)} {midi.length_beats === 1 ? "beat" : "beats"}</dd></div>
                  )}
                  <div><dt>Notes</dt><dd>{noteCountLabel(midi)}</dd></div>
                </div>
                {!hasMidiPattern && midiPitches ? (
                  <div><dt>Pitches used{midi.distinct_pitches !== null ? ` (${midi.distinct_pitches})` : ""}</dt><dd>{midiPitches}</dd></div>
                ) : !hasMidiPattern && midi.distinct_pitches !== null && <div><dt>Distinct pitches</dt><dd>{midi.distinct_pitches}</dd></div>}
                {midiVelocityIsUseful && <div><dt>Average velocity</dt><dd>{midi.velocity_mean}</dd></div>}
              </>
            ) : null}
            {repeated && <div><dt>Movements</dt><dd>{decision.count}</dd></div>}
          </dl>

          {/* The movement in the form its data actually has. A sentence was the
              wrong shape for almost all of this: a device toggle read "changed"
              when the fact is that it landed off, and a mode switch read like a
              magnitude. See movementShape.ts. */}
          {!midi && (
            <MovementShapeView
              shape={shape}
              position={positions[0] ?? null}
              mixControl={decision.workKind === "mixing"}
            />
          )}

          {midi && (hasMidiPattern ? <MidiPatternChange edit={midi} meter={meter} /> : <MidiPitchScale edit={midi} />)}
          {midiMissing.length > 0 && (
            <p className="vt-midi-missing">Not captured: {midiMissing.join(", ")}.</p>
          )}

          {showTopLevelPositions && positions.length > 0 && (
            <div className="vt-movement-card__positions">
              <span>{renderedPositionLabel}</span>
              <ul>
                {positions.map((position) => (
                  <li key={position}>
                    {position}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {repeated && (
            <details className="vt-movement-card__evidence">
              <summary>All {expectedEvidence} captured movements</summary>
              <ol>
                {evidence.map((row) => (
                  <li key={row.id}>
                    <time>{formatClock(row.atMs)}</time>
                    <span>
                      <strong>{readableSubject(row.subject)}</strong>
                      <span className="vt-movement-card__evidence-detail">{row.detail}</span>
                      {row.position && (
                        <span className="vt-movement-card__evidence-detail">
                          Song position: {readablePosition(row.position)}
                        </span>
                      )}
                    </span>
                  </li>
                ))}
              </ol>
              {missingEvidence > 0 && (
                <p className="vt-movement-card__missing" role="status">
                  {missingEvidence} captured {missingEvidence === 1 ? "movement is" : "movements are"} unavailable.
                </p>
              )}
            </details>
          )}
        </div>
        <MovementTime startMs={decision.atMs} endMs={decision.endMs} />
      </article>
    </li>
  );
})

/**
 * One sitting's work, in the order it is being read.
 *
 * Three readings, because there are three real questions. Chronological answers
 * "what happened at 10:34" — and carries the silences and the saves, which are
 * facts about the evening that a flat list of cards destroys. By track answers
 * "what did I do to the bass", which is how a producer usually retraces. By
 * type answers "show me the MIDI work together" without hiding any evidence.
 *
 * The toggle is per sitting, not global: you might scan one evening by time and
 * the next by track, and forcing one choice across all of them helps neither.
 */
type SittingReadMode = "time" | "track" | "type";

type SittingNavigationItem = {
  decision: ReportDecision;
  domId: string;
  positions: string[];
};

/** A local rail, owned by this sitting rather than the application's sidebar. */
function TimelineLocation({ items }: { items: SittingNavigationItem[] }) {
  const [activeIndex, setActiveIndex] = useState(0);
  const distinctPositions = new Set(items.flatMap((item) => item.positions));
  const hasUsefulPosition = items.length === 1
    ? distinctPositions.size > 0
    : distinctPositions.size > 1;

  useEffect(() => {
    let frame = 0;
    const update = () => {
      const readingLine = Math.min(Math.max(96, window.innerHeight * 0.2), 240);
      const edgeSize = 180;
      let closestIndex = 0;
      let closestDistance = Number.POSITIVE_INFINITY;
      items.forEach((item, index) => {
        const card = document.getElementById(item.domId);
        const rect = card?.getBoundingClientRect();
        if (!rect || !card) return;

        // A card should come into focus as it enters the reading viewport and
        // recede as it leaves. The value is written directly on the card so
        // hundreds of cards do not need to re-render on every scroll frame.
        const leavingTop = Math.min(1, Math.max(0, (rect.bottom + 32) / edgeSize));
        const arrivingBottom = Math.min(1, Math.max(0, (window.innerHeight - rect.top + 32) / edgeSize));
        const edgeVisibility = Math.min(leavingTop, arrivingBottom);
        card.style.setProperty("--vt-scroll-opacity", String(0.48 + edgeVisibility * 0.52));

        const distance = rect.top > readingLine
          ? rect.top - readingLine
          : rect.bottom < readingLine
            ? readingLine - rect.bottom
            : 0;
        if (distance < closestDistance) {
          closestDistance = distance;
          closestIndex = index;
        }
      });
      items.forEach((item, index) => {
        const card = document.getElementById(item.domId);
        if (card) card.dataset.timelineActive = String(index === closestIndex);
      });
      setActiveIndex(closestIndex);
    };
    const schedule = () => {
      if (frame !== 0) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        update();
      });
    };
    update();
    // The app uses an internal scrolling pane, not the browser window. Scroll
    // events do not bubble, but capture sees the pane as well as document
    // scrolling, so the location marker cannot freeze on the first card.
    document.addEventListener("scroll", schedule, { capture: true, passive: true });
    window.addEventListener("resize", schedule, { passive: true });
    return () => {
      document.removeEventListener("scroll", schedule, true);
      window.removeEventListener("resize", schedule);
      if (frame !== 0) window.cancelAnimationFrame(frame);
    };
  }, [items]);

  if (items.length === 0) return null;
  const active = items[activeIndex] ?? items[0]!;
  const jumpTo = (index: number) => {
    const next = Math.max(0, Math.min(items.length - 1, index));
    document.getElementById(items[next]!.domId)?.scrollIntoView({ behavior: "auto", block: "start" });
    setActiveIndex(next);
  };

  return (
    <aside className="vt-location" aria-label="Timeline location">
      <span className="vt-location__label">Timeline location</span>
      <strong>Movement {activeIndex + 1} / {items.length}</strong>
      <span>{formatClock(active.decision.atMs)}</span>
      {hasUsefulPosition && active.positions[0] && <span>{active.positions[0]}</span>}
      <div className="vt-location__step">
        <button type="button" onClick={() => jumpTo(activeIndex - 1)} disabled={activeIndex === 0}>Previous</button>
        <button type="button" onClick={() => jumpTo(activeIndex + 1)} disabled={activeIndex === items.length - 1}>Next</button>
      </div>
    </aside>
  );
}

/** Shared so "no evidence" is a stable reference too. */
const EMPTY_EVIDENCE: ReportEvidence[] = [];

function SittingWork({
  sitting,
  meter,
}: {
  sitting: SittingDepth;
  meter: SongPositionSource | null;
}) {
  const [readMode, setReadMode] = useState<SittingReadMode>("time");

  // Each decision's evidence, resolved once and kept.
  //
  // This used to be a function prop that built a fresh array per call, which
  // meant every card received a new `evidence` array on every render — enough
  // on its own to defeat MovementCard's memo and rebuild several hundred piano
  // rolls for an unrelated state change. The arrays are derived from immutable
  // report data, so computing them once is not a cache; it is just not doing
  // the work repeatedly.
  const evidenceByDecision = useMemo(() => {
    const map = new Map<string, ReportEvidence[]>();
    for (const decision of sitting.report.decisions) {
      map.set(
        decision.id,
        decision.evidenceIds
          .map((id) => sitting.report.evidence[id])
          .filter((row): row is ReportEvidence => row !== undefined),
      );
    }
    return map;
  }, [sitting.report]);

  const evidenceFor = useCallback(
    (decision: ReportDecision) => evidenceByDecision.get(decision.id) ?? EMPTY_EVIDENCE,
    [evidenceByDecision],
  );

  const navigationScope = useId().replace(/:/g, "");
  const decisions = sitting.report.decisions;
  const trail = useMemo(() => sittingTrail(decisions, sitting.saves), [decisions, sitting.saves]);
  const groups = useMemo(() => sittingByTrack(decisions), [decisions]);
  const typeGroups = useMemo(() => {
    const grouped = new Map<string, ReportDecision[]>();
    decisions.forEach((decision) => {
      const label = movementType(decision);
      grouped.set(label, [...(grouped.get(label) ?? []), decision]);
    });
    return [...grouped.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([label, groupedDecisions]) => ({ key: label, label, decisions: groupedDecisions }));
  }, [decisions]);
  const decisionIndex = useMemo(
    () => new Map(decisions.map((decision, index) => [decision.id, index])),
    [decisions],
  );
  const displayedGroups = readMode === "track"
    ? groups.map((group) => ({
        key: group.track ?? "set-wide",
        label: group.track ?? "The set itself",
        decisions: group.decisions,
      }))
    : typeGroups;
  const orderedDecisions = readMode === "time"
    ? trail.flatMap((entry) => entry.kind === "movement" ? [entry.decision] : [])
    : displayedGroups.flatMap((group) => group.decisions);
  const domIdFor = (decision: ReportDecision) =>
    `vt-movement-${navigationScope}-${decisionIndex.get(decision.id) ?? 0}`;
  const navigationItems = orderedDecisions.map((decision) => ({
    decision,
    domId: domIdFor(decision),
    positions: [...new Set(evidenceFor(decision)
      .map((row) => row.position)
      .filter((position): position is string => Boolean(position))
      .map(readablePosition))],
  }));
  const distinctSongPositions = new Set(navigationItems.flatMap((item) => item.positions));
  // One recorded movement still needs its location. Repetition is noise only
  // when a return has several movements that all report the same position.
  const showSongPositions = navigationItems.length === 1 || distinctSongPositions.size > 1;

  if (decisions.length === 0 && sitting.saves.length === 0) {
    return <p className="vt-depth__empty">This sitting captured no work.</p>;
  }

  return (
    <div className="vt-trail-layout">
      <div className="vt-trail-layout__content">
      <div className="vt-trail-controls">
        <span className="vt-trail-controls__label">Read</span>
        <div className="vt-trail-toggle" role="group" aria-label="How to read this sitting">
          <button
            type="button"
            className={readMode === "time" ? "is-active" : ""}
            aria-pressed={readMode === "time"}
            onClick={() => setReadMode("time")}
          >
            In order
          </button>
          <button
            type="button"
            className={readMode === "track" ? "is-active" : ""}
            aria-pressed={readMode === "track"}
            onClick={() => setReadMode("track")}
          >
            By track
          </button>
          <button
            type="button"
            className={readMode === "type" ? "is-active" : ""}
            aria-pressed={readMode === "type"}
            onClick={() => setReadMode("type")}
          >
            By type
          </button>
        </div>
      </div>

      {readMode !== "time" ? (
        <ol
          className={`vt-track-groups ${readMode === "type" ? "vt-type-groups" : ""}`}
          aria-label={readMode === "type"
            ? "Every captured movement, grouped by type"
            : "Every captured movement, grouped by track"}
        >
          {displayedGroups.map((group) => (
            <li key={group.key}>
              <p className={`vt-track-groups__head ${readMode === "type" ? "vt-type-groups__head" : ""}`}>
                <span className="vt-track-groups__label">{group.label}</span>
                <span className="vt-track-groups__count">
                  {group.decisions.length} {group.decisions.length === 1 ? "movement" : "movements"}
                </span>
              </p>
              <ol className="vt-movements">
                {group.decisions.map((decision) => (
                  <MovementCard
                    key={decision.id}
                    decision={decision}
                    evidence={evidenceFor(decision)}
                    meter={meter}
                    domId={domIdFor(decision)}
                    showSongPositions={showSongPositions}
                  />
                ))}
              </ol>
            </li>
          ))}
        </ol>
      ) : (
        <ol className="vt-movements" aria-label="Every captured movement in this sitting">
          {trail.map((entry) => {
            if (entry.kind === "movement") {
              return (
                <MovementCard
                  key={entry.key}
                  decision={entry.decision}
                  evidence={evidenceFor(entry.decision)}
                    meter={meter}
                  domId={domIdFor(entry.decision)}
                  showSongPositions={showSongPositions}
                />
              );
            }
            if (entry.kind === "save") {
              return (
                // Punctuation, not a card: everything above this line is in the
                // state that was written to disk here.
                <li key={entry.key} className="vt-trail-save">
                  <span className="vt-trail-save__rule" aria-hidden="true" />
                  <span className="vt-trail-save__label">
                    Saved · {formatClock(entry.atMs)}
                  </span>
                  <span className="vt-trail-save__rule" aria-hidden="true" />
                </li>
              );
            }
            if (entry.kind === "gap") {
              return (
                // A break that names what it removed is honest; even spacing
                // that hides twenty minutes is not.
                <li key={entry.key} className="vt-trail-gap">
                  <span aria-hidden="true" />
                  <span>{gapLabel(entry.durationMs)} with nothing captured</span>
                  <span aria-hidden="true" />
                </li>
              );
            }
            return (
              // Where the producer moved their attention. Quieter than a gap or
              // a save, because it did not interrupt the work — it is a place to
              // hold your position in a long run, not an event.
              <li key={entry.key} className="vt-trail-focus">
                <span className="vt-trail-focus__track">{entry.track}</span>
                <span className="vt-trail-focus__rule" aria-hidden="true" />
              </li>
            );
          })}
        </ol>
      )}
      </div>
      <TimelineLocation key={readMode} items={navigationItems} />
    </div>
  );
}

/**
 * The sittings, each with its own trail.
 *
 * Newest first, and openable rather than all expanded: a version with six
 * evenings in it is six returns to the desk, and the one being resumed is the
 * last. Flattening them into a single chronological list was the old behaviour
 * and it hid the boundaries that make a version legible.
 */
function SittingsBlock({
  sittings,
  meter,
}: {
  sittings: SittingDepth[];
  /** The set's time signature, so positions read in bars rather than beats. */
  meter: SongPositionSource | null;
}) {
  return (
    <section className="vt-depth__sittings" aria-label="Sittings in this version, in detail">
      {sittings.length === 0 ? (
        <p className="vt-depth__empty">Recall captured no work to retrace in this version.</p>
      ) : (
        <ol className="vt-sittings">
          {sittings.map((sitting, index) => {
            const movementCount = sitting.report.decisions.length;
            return (
              <li key={sitting.sessionId}>
                <details open={index === 0}>
                  <summary>
                    <span className="vt-sittings__identity">
                      <span className="vt-sittings__ordinal">
                        {index === 0 ? "Latest return" : `Return ${sittings.length - index}`}
                      </span>
                      <span className="vt-sittings__when">
                        {formatSessionDate(sitting.startedAtMs)}
                        {/* Four rows all reading "Aug 19, 2026" cannot be told apart.
                            The clock is what separates one evening's return from the
                            next. */}
                        <span className="vt-sittings__clock">
                          {formatClock(sitting.startedAtMs)}–{formatClock(sitting.endedAtMs)}
                        </span>
                        {sitting.merged && (
                          // Said out loud, because the producer sees fewer rows here
                          // than captures exist and should know why.
                          <span className="vt-sittings__merged" title="Recall had split this sitting across several captures">
                            merged
                          </span>
                        )}
                      </span>
                    </span>
                    <span className="vt-sittings__meta">
                      <span className="vt-sittings__count">
                        {movementCount} {movementCount === 1 ? "movement" : "movements"}
                      </span>
                      <svg className="vt-sittings__chevron" viewBox="0 0 16 16" aria-hidden="true">
                        <path d="m4 6 4 4 4-4" />
                      </svg>
                    </span>
                  </summary>
                  <div className="vt-sittings__body">
                    <SittingWork sitting={sitting} meter={meter} />
                  </div>
                </details>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

function VersionDetail({
  selected,
  parent,
}: {
  selected: ProjectVersion;
  parent: SelectedVersionParent | null;
}) {
  const sessionIds = selected.sessions.map((session) => session.id);
  const depthKey = `${sessionIds.join("|")}::${parent?.sessionId ?? ""}`;
  const [depth, setDepth] = useState<VersionDepth | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error" | "empty">("loading");

  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    setDepth(null);
    if (sessionIds.length === 0) {
      setStatus("empty");
      return;
    }
    void loadVersionDepth(sessionIds, parent)
      .then((next) => {
        if (cancelled) return;
        setDepth(next);
        setStatus("ready");
      })
      .catch(() => {
        if (!cancelled) setStatus("error");
      });
    return () => {
      cancelled = true;
    };
    // depthKey covers both inputs. Listing the arrays themselves would refire on
    // every render, because they are rebuilt each time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [depthKey]);

  if (status === "empty") {
    return (
      <section className="vt-depth" aria-label="Version detail">
        <p className="vt__eyebrow">Inside this version</p>
        <p className="vt-depth__empty">
          This version was found on disk. Recall has never had it open, so there is nothing inside
          it yet.
        </p>
      </section>
    );
  }

  if (status === "loading") {
    return (
      <section className="vt-depth" aria-label="Version detail" aria-busy="true">
        <p className="vt__eyebrow">Inside this version</p>
        {/* The Report's own loader, not a sentence. Reading a version runs the
            same loader over the same data, so it should look the same while it
            works — and a bare line of text above an empty half-screen read as a
            surface that had finished and found nothing. */}
        <ReportLoading label="Reading the work inside this version" />
      </section>
    );
  }

  if (status === "error" || !depth) {
    return (
      <section className="vt-depth" aria-label="Version detail">
        <p className="vt__eyebrow">Inside this version</p>
        <p className="vt-depth__empty">Recall could not read the captured work for this version.</p>
      </section>
    );
  }

  const returnCount = depth.sittings.length;

  return (
    <section className="vt-depth" aria-label="Version detail">
      <header className="vt-depth__head">
        <p className="vt__eyebrow">Retrace this version</p>
        <h2>
          {returnCount === 0
            ? "No captured returns"
            : `${returnCount} ${returnCount === 1 ? "return" : "returns"}, move by move`}
        </h2>
        <p>Choose a return, then follow every captured control, track, and song position in order.</p>
      </header>

      <div className="vt-depth__grid">
        <SittingsBlock meter={depth.meter} sittings={depth.sittings} />
      </div>
    </section>
  );
}

export function VersionTimelineScreen({
  projects,
  projectId,
  focusSessionId = null,
  onSelectProject,
  onOpenReport,
  onOpenProjects,
}: VersionTimelineScreenProps) {
  const project = useMemo(
    () => projects.find((candidate) => candidate.id === projectId) ?? projects[0] ?? null,
    [projects, projectId],
  );
  const fileAges = useAlsFileAges(project?.captures ?? []);
  const versions = useMemo(
    () => projectVersions(project?.captures ?? [], fileAges),
    [project, fileAges],
  );
  const saves = useObservedSaves(versions);
  const nodes = useMemo(() => versionGraph(versions, saves), [versions, saves]);
  const newest = useMemo(() => latestVersion(versions), [versions]);
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);

  useEffect(() => {
    setSelectedVersionId((current) =>
      current && versions.some((version) => version.id === current) ? current : newest?.id ?? null,
    );
  }, [newest?.id, versions]);

  // A Report is always a shortcut back to the source of truth.  Preserve the
  // version it was opened from rather than making the producer find it again.
  useEffect(() => {
    if (!focusSessionId) return;
    const focused = versions.find((version) => version.sessions.some((session) => session.id === focusSessionId));
    if (focused) setSelectedVersionId(focused.id);
  }, [focusSessionId, versions]);

  const selected = versions.find((version) => version.id === selectedVersionId) ?? newest;
  const selectedNode = selected ? nodes.find((node) => node.id === selected.id) ?? null : null;
  const sessionId = selected ? latestSitting(selected) : null;

  // What the diff compares against: the version this one DESCENDS from, which on
  // a fork is not the row printed underneath it. The graph already resolved the
  // lineage, so the parent is read off the node rather than guessed from order.
  const selectedParent = useMemo(() => {
    if (!selectedNode?.parentId) return null;
    const parent = versions.find((version) => version.id === selectedNode.parentId);
    if (!parent) return null;
    return {
      name: versionLabel(parent),
      sessionId: latestSitting(parent),
      alsPath: versionSourcePath(parent),
    };
  }, [selectedNode?.parentId, versions]);

  if (projects.length === 0) {
    return (
      <div className="vt-empty">
        <strong>No projects yet.</strong>
        <p>Start a project, then save and work in Ableton while Recall is listening.</p>
        <button type="button" className="px-btn px-btn--primary" onClick={onOpenProjects}>Go to Projects</button>
      </div>
    );
  }

  return (
    <div className="vt">
      <header className="vt__bar">
        <div>
          <p className="vt__eyebrow">Timeline</p>
          <h1>{project?.display_name ?? "Project"} — version history</h1>
          <p className="vt__subtitle">
            {versions.length} {versions.length === 1 ? "version" : "versions"}
            {versions.length > 1 && ` · ${nodes.filter((node) => node.parentId !== null).length} linked`}
          </p>
        </div>
        {projects.length > 1 && (
          <label className="vt__picker">
            <span>Project</span>
            <select value={project?.id ?? ""} onChange={(event) => onSelectProject(event.target.value)}>
              {projects.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.display_name}</option>)}
            </select>
          </label>
        )}
      </header>

      <section className="vt__surface" aria-label="Project version history">
        <header className="vt__surface-head">
          <div>
            <p className="vt__eyebrow">Version graph</p>
            <h2>How this project got here</h2>
          </div>
          <p>Solid links are captured evidence. Dashed links are inferred from the files and work Recall observed.</p>
        </header>
        <div className="vt__body">
          <section className="vt__graph-panel">
            <VersionLogGraph
              nodes={nodes}
              saves={saves}
              selectedVersionId={selected?.id ?? null}
              onSelectVersion={setSelectedVersionId}
            />
          </section>
          {selected && selectedNode && (
            <VersionInspector
              selected={selected}
              node={selectedNode}
              latest={selected.id === newest?.id}
              onOpenReport={() => sessionId && onOpenReport(sessionId, "version")}
            />
          )}
        </div>
        {selected && <SavedPresetState selected={selected} parent={selectedParent} />}
        {selected && <VersionDetail selected={selected} parent={selectedParent} />}
      </section>
    </div>
  );
}
