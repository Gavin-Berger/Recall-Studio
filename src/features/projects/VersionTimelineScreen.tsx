import { useEffect, useId, useMemo, useRef, useState, type CSSProperties } from "react";
import { isTauri } from "@tauri-apps/api/core";
import type { SavedProject } from "../../types/recall";
import { NOTE_KIND_LABEL, type MidiClipNote, type NoteEdit } from "../../types/schema";
import { formatSessionDate } from "../sessionFormat";
import { formatClock, formatDuration } from "../../components/schema/timeline/format";
import {
  describeMidiChange,
  namedMidiClip,
} from "../../components/schema/timeline/midiChange";
import { presentPassageStory } from "../../components/schema/timeline/passagePresenter";
import { producerWorkDefinition } from "../../components/schema/timeline/producerWork";
import { projectVersions, type ProjectVersion } from "./projectVersions";
import { layoutVersionGraph } from "./versionGraphLayout";
import { versionGraph, type ObservedSave, type VersionNode } from "./versionGraph";
import { sittings as groupSittings } from "./sittings";
import {
  layoutVersionTimeline,
  TIMELINE_ROW_HEIGHT,
  type VersionTimelineLayout,
} from "./versionTimelineLayout";
import { diffHeadline, diffLines } from "./commitDiff";
import { movementShape, type MovementShape } from "./movementShape";
import { gapLabel, sittingByTrack, sittingTrail } from "./sittingTrail";
import type { SittingDepth, VersionDepth } from "./versionDepth";
import { getObservedSaves } from "../../lib/schema/api";
import { ReportLoading } from "./ReportLoading";
import { loadVersionDepth } from "./versionReportLoader";
import type { ReportDecision, ReportEvidence } from "./sessionReport";
import "./VersionTimelineScreen.css";

type VersionTimelineScreenProps = {
  projects: SavedProject[];
  projectId: string | null;
  focusSessionId?: string | null;
  onSelectProject: (projectId: string) => void;
  onOpenReport: (sessionId: string, scope: "version") => void;
  onOpenProjects: () => void;
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

/** Orientation that helps someone resume: returns and dates, never rollups. */
function versionWorkLine(version: ProjectVersion): string {
  const worked = groupSittings(version.sessions).sittings;
  if (worked.length === 0) return "Recall captured no producer work in this file";
  const first = worked[0]!;
  const last = worked.at(-1)!;
  if (worked.length === 1) {
    return `One sitting · ${formatSessionDate(first.startMs)} · ${formatClock(first.startMs)}–${formatClock(first.endMs)}`;
  }
  return `${worked.length} returns · ${formatSessionDate(first.startMs)} → ${formatSessionDate(last.startMs)}`;
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
  const [expandedWorkId, setExpandedWorkId] = useState<string | null>(null);
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
    () => layoutVersionTimeline(nodes, layout, saves, expandedWorkId),
    [nodes, layout, saves, expandedWorkId],
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
          const work = groupSittings(node.version.sessions);
          const saveCount = timeline.saveTicks.filter((tick) => tick.nodeId === node.id).length;
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
              <VersionWorkStretch
                version={node.version}
                sittingCount={work.sittings.length}
                saveCount={saveCount}
                expanded={expandedWorkId === node.id}
                onExpandedChange={(expanded) => setExpandedWorkId(expanded ? node.id : null)}
              />
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/**
 * The record carried by a stretch of lane. The closed line tells a producer
 * what happened without forcing another fetch; opening it reads the sitting
 * trails, so the moves live on the Timeline rather than only in the Report.
 */
function VersionWorkStretch({
  version,
  sittingCount,
  saveCount,
  expanded,
  onExpandedChange,
}: {
  version: ProjectVersion;
  sittingCount: number;
  saveCount: number;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
}) {
  const sessionIds = version.sessions.map((session) => session.id);
  const sessionKey = sessionIds.join("|");
  const [depth, setDepth] = useState<VersionDepth | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");

  useEffect(() => {
    setDepth(null);
    setStatus("idle");
  }, [sessionKey]);

  useEffect(() => {
    if (!expanded || status !== "idle") return;
    let cancelled = false;
    setStatus("loading");
    void loadVersionDepth(sessionIds, null)
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
  }, [expanded, sessionKey, status]);

  const sittingText = sittingCount === 0
    ? "No producer work captured"
    : `${sittingCount} ${sittingCount === 1 ? "sitting" : "sittings"}`;

  return (
    <div className="vt-work" aria-label={`Work on ${versionLabel(version)}`}>
      {sittingCount > 0 && (
        <details
          className="vt-work__details"
          open={expanded}
          onToggle={(event) => onExpandedChange(event.currentTarget.open)}
        >
          <summary>
            Retrace {sittingText}
            {saveCount > 0 && ` · ${saveCount} ${saveCount === 1 ? "save" : "saves"} observed`}
          </summary>
          {status === "loading" && <p className="vt-work__status">Reading the sittings…</p>}
          {status === "error" && (
            <p className="vt-work__status">Recall could not read the moves in these sittings.</p>
          )}
          {status === "ready" && depth && (
            <ol className="vt-work__trail">
              {depth.sittings.map((sitting) => (
                <li key={sitting.sessionId}>
                  <time>{formatSessionDate(sitting.startedAtMs)} · {formatClock(sitting.startedAtMs)}</time>
                  <span>
                    {sitting.report.chapters.length > 0 ? (
                      <>
                        <strong>
                          Started with {presentPassageStory(sitting.report.chapters[0]!).title}
                        </strong>
                        <span className="vt-work__ending">
                          Left off with {presentPassageStory(sitting.report.chapters.at(-1)!).title}
                        </span>
                      </>
                    ) : (
                      <span className="vt-work__ending">This sitting captured no work trail.</span>
                    )}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </details>
      )}
      {sittingCount === 0 && (
        <p className="vt-work__summary">
          {sittingText}
          {saveCount > 0 && ` · ${saveCount} ${saveCount === 1 ? "save" : "saves"} observed`}
        </p>
      )}
    </div>
  );
}

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

/**
 * The Timeline is where a producer reads a version closely.
 *
 * The graph picks the point; this says what the point IS. It answers the two
 * questions that let a producer retrace it: what changed in the set since the
 * version this one came from, and what happened in order each time they
 * returned. Aggregates belong in the Report, not in this memory path.
 */
function DiffBlock({ depth }: { depth: VersionDepth }) {
  const { diff, parentName } = depth;
  const rendered = diff.status === "changed" ? diffLines(diff.diff) : null;

  return (
    <section className="vt-depth__diff" aria-label="Changed since the parent version">
      <p className="vt__eyebrow">Changed in the set</p>
      <h3>{parentName ? `Since ${parentName}` : "The first version"}</h3>
      {diff.status === "root" && (
        <p className="vt-depth__empty">
          Nothing came before this version, so there is nothing to compare it against.
        </p>
      )}
      {diff.status === "unknown" && (
        // Honest degradation: "no snapshot" and "nothing changed" are different
        // facts and must never be printed as the same sentence.
        <p className="vt-depth__empty">
          One of the two versions has no structure snapshot, so Recall cannot say what changed.
        </p>
      )}
      {diff.status === "unchanged" && (
        <p className="vt-depth__empty">
          Same tracks, same devices. Whatever happened here happened inside them.
        </p>
      )}
      {diff.status === "changed" && rendered && (
        <>
          <p className="vt-depth__headline">{diffHeadline(diff.diff)}</p>
          <ul className="vt-diff">
            {rendered.lines.map((line) => (
              <li key={line.key} className={line.sign === "+" ? "is-added" : "is-removed"}>
                <StructuralChangeIcon sign={line.sign} />
                <span className="vt-diff__label">{line.label}</span>
                {line.context && <span className="vt-diff__context">{line.context}</span>}
              </li>
            ))}
          </ul>
          {rendered.total > rendered.lines.length && (
            <p className="vt-depth__more">{rendered.total - rendered.lines.length} more</p>
          )}
        </>
      )}
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

function MidiPatternChange({ edit }: { edit: NoteEdit }) {
  const after = edit.midi_notes ?? [];
  const before = edit.previous_midi_notes;
  const all = [...(before ?? []), ...after];
  if (all.length === 0 && before === null) return null;

  const minStart = all.length > 0 ? Math.min(...all.map((note) => note.start_time)) : 0;
  const maxEnd = all.length > 0
    ? Math.max(...all.map((note) => note.start_time + note.duration), minStart + 1)
    : Math.max(1, edit.length_beats ?? 1);
  const minPitch = all.length > 0 ? Math.min(...all.map((note) => note.pitch)) : 60;
  const maxPitch = all.length > 0 ? Math.max(...all.map((note) => note.pitch)) : minPitch + 1;
  const pitchSpan = Math.max(3, maxPitch - minPitch + 1);
  const timeSpan = Math.max(1, maxEnd - minStart);
  const firstGridBeat = Math.floor(minStart);
  const lastGridBeat = Math.ceil(maxEnd);
  const gridStep = lastGridBeat - firstGridBeat > 32 ? 4 : lastGridBeat - firstGridBeat > 16 ? 2 : 1;
  const beatLines = Array.from(
    { length: Math.floor((lastGridBeat - firstGridBeat) / gridStep) + 1 },
    (_, index) => firstGridBeat + index * gridStep,
  ).filter((beat) => beat >= minStart && beat <= maxEnd);
  const cMarkers = Array.from({ length: maxPitch - minPitch + 1 }, (_, index) => minPitch + index)
    .filter((pitch) => pitch % 12 === 0);
  const rows = before !== undefined && before !== null
    ? [{ key: "before", label: "Before", notes: before }, { key: "after", label: "After", notes: after }]
    : [{ key: "after", label: "Pattern", notes: after }];
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
        <span>Piano roll · inside this clip</span>
        <strong>{noteInventory(after) ?? (after.length === 0 ? "No notes after this edit" : "Pitch names unavailable")}</strong>
      </header>
      <div className="vt-midi-pattern__rows">
        {rows.map((row) => (
          <div className="vt-midi-pattern__row" key={row.key}>
            <span>{row.label}</span>
            <svg
              viewBox="0 0 800 88"
              preserveAspectRatio="none"
              role="img"
              aria-label={`${row.label}: ${row.notes.length} captured ${row.notes.length === 1 ? "note" : "notes"}`}
            >
              {beatLines.map((beat) => (
                <line
                  className="vt-midi-pattern__beat"
                  key={beat}
                  x1={((beat - minStart) / timeSpan) * 800}
                  x2={((beat - minStart) / timeSpan) * 800}
                  y1="0"
                  y2="88"
                />
              ))}
              {cMarkers.map((pitch) => {
                const y = 80 - ((pitch - minPitch) / pitchSpan) * 72;
                return <line className="vt-midi-pattern__octave" key={pitch} x1="0" x2="800" y1={y} y2={y} />;
              })}
              {row.notes.map((note, index) => {
                const x = ((note.start_time - minStart) / timeSpan) * 800;
                const width = Math.max(3, (note.duration / timeSpan) * 800);
                const y = 76 - ((note.pitch - minPitch) / pitchSpan) * 68;
                return (
                  <rect
                    key={note.note_id ?? `${note.pitch}-${note.start_time}-${index}`}
                    className={`${row.key === "before" ? "is-before" : "is-after"} ${note.mute ? "is-muted" : ""}`}
                    x={x}
                    y={y}
                    width={width}
                    height="8"
                    rx="2"
                  />
                );
              })}
            </svg>
            <strong>{row.notes.length} {row.notes.length === 1 ? "note" : "notes"}</strong>
          </div>
        ))}
      </div>
      <div className="vt-midi-pattern__axis">
        <span>{beatOffset(minStart, "clip")}</span>
        <span>{beatOffset(maxEnd, "clip")}</span>
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

function ScalarChange({
  fromLabel,
  toLabel,
  fromFraction,
  toFraction,
  rose,
}: {
  fromLabel: string | null;
  toLabel: string | null;
  fromFraction: number | null;
  toFraction: number | null;
  rose: boolean | null;
}) {
  const drawable = fromFraction !== null && toFraction !== null;
  const low = drawable ? Math.min(fromFraction, toFraction) : 0;
  const high = drawable ? Math.max(fromFraction, toFraction) : 0;

  return (
    <div className="vt-shape vt-shape--scalar">
      <div className="vt-scalar__values">
        {fromLabel && <span className="vt-scalar__from">{fromLabel}</span>}
        {fromLabel && toLabel && (
          <span className="vt-shape__arrow" aria-hidden="true">
            {rose === null ? "→" : rose ? "↗" : "↘"}
          </span>
        )}
        {toLabel && <span className="vt-scalar__to">{toLabel}</span>}
      </div>
      {drawable && (
        // The bar carries the distance travelled, which the two numbers alone
        // do not: 10%→12% and 10%→90% read the same as text.
        <div
          className="vt-scalar__track"
          role="img"
          aria-label={`Moved from ${Math.round(fromFraction * 100)}% to ${Math.round(toFraction * 100)}%`}
        >
          <span
            className="vt-scalar__travel"
            style={{ left: `${low * 100}%`, width: `${Math.max(1, (high - low) * 100)}%` }}
          />
          <span className="vt-scalar__mark is-from" style={{ left: `${fromFraction * 100}%` }} />
          <span className="vt-scalar__mark is-to" style={{ left: `${toFraction * 100}%` }} />
        </div>
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
function MovementShapeView({ shape, position = null }: { shape: MovementShape; position?: string | null }) {
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

function MovementCard({
  decision,
  evidence,
  domId,
}: {
  decision: ReportDecision;
  evidence: ReportEvidence[];
  domId: string;
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
  const showTopLevelPositions = decision.kind !== "control" && !(decision.kind === "clip" && shape.shape === "span");
  const positionLabel = decision.kind === "midi"
    ? "Edited at"
    : decision.kind === "moment"
      ? "Marked at"
      : decision.kind === "structure" && /\bmoved\b/i.test(decision.subject)
        ? "Moved to"
        : "Song position";
  const renderedPositionLabel = positionLabel === "Song position" && positions.length > 1
    ? "Song positions"
    : positionLabel;
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
      data-timeline-movement="true"
    >
      <article aria-label={`${movementCardLabel(decision)}: ${displayTitle}`}>
        <div className="vt-movement-card__content">
          <header className="vt-movement-card__head">
            <div className="vt-movement-card__identity">
              <MovementKindIcon decision={decision} />
              <div>
                <span className="vt-movement-card__kind">{movementCardLabel(decision)}</span>
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
                <div><dt>Notes</dt><dd>{noteCountLabel(midi)}</dd></div>
                {!hasMidiPattern && midiPitches ? (
                  <div><dt>Pitches used{midi.distinct_pitches !== null ? ` (${midi.distinct_pitches})` : ""}</dt><dd>{midiPitches}</dd></div>
                ) : !hasMidiPattern && midi.distinct_pitches !== null && <div><dt>Distinct pitches</dt><dd>{midi.distinct_pitches}</dd></div>}
                {midiVelocityIsUseful && <div><dt>Average velocity</dt><dd>{midi.velocity_mean}</dd></div>}
                {midi.length_beats !== null && (
                  <div><dt>Clip length</dt><dd>{compactNumber(midi.length_beats)} {midi.length_beats === 1 ? "beat" : "beats"}</dd></div>
                )}
              </>
            ) : null}
            {repeated && <div><dt>Movements</dt><dd>{decision.count}</dd></div>}
          </dl>

          {/* The movement in the form its data actually has. A sentence was the
              wrong shape for almost all of this: a device toggle read "changed"
              when the fact is that it landed off, and a mode switch read like a
              magnitude. See movementShape.ts. */}
          {!midi && <MovementShapeView shape={shape} position={positions[0] ?? null} />}

          {midi && (hasMidiPattern ? <MidiPatternChange edit={midi} /> : <MidiPitchScale edit={midi} />)}
          {midiMissing.length > 0 && (
            <p className="vt-midi-missing">Not captured: {midiMissing.join(", ")}.</p>
          )}

          {showTopLevelPositions && positions.length > 0 && (
            <div className="vt-movement-card__positions">
              <span>{renderedPositionLabel}</span>
              <ul>{positions.map((position) => <li key={position}>{position}</li>)}</ul>
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
}

type JumpIconName = "first" | "previous" | "next" | "last";

function JumpIcon({ name }: { name: JumpIconName }) {
  const points = name === "previous" || name === "first" ? "15 6 9 12 15 18" : "9 6 15 12 9 18";
  return (
    <svg className="vt-jumpbar__icon" viewBox="0 0 24 24" focusable="false" aria-hidden="true">
      {(name === "first" || name === "last") && (
        <path d={name === "first" ? "M6 5v14" : "M18 5v14"} />
      )}
      <polyline points={points} />
    </svg>
  );
}

type SittingNavigationItem = {
  decision: ReportDecision;
  domId: string;
  positions: string[];
};

/** A compact map for a sitting that may contain hundreds of movement cards. */
function SittingNavigator({ items }: { items: SittingNavigationItem[] }) {
  const [activeIndex, setActiveIndex] = useState(0);
  const [motion, setMotion] = useState<"up" | "down" | null>(null);
  const navigatorRef = useRef<HTMLElement>(null);
  const activeIndexRef = useRef(0);
  const motionTimerRef = useRef<number | null>(null);
  const movementTypes = [...new Set(items.map((item) => movementType(item.decision)))];
  const songPositions = items.flatMap((item, index) =>
    item.positions.map((position) => ({ position, index })),
  ).filter((item, index, all) => all.findIndex((other) => other.position === item.position) === index);

  function setActiveMovement(next: number) {
    const previous = activeIndexRef.current;
    if (next !== previous) {
      setMotion(next > previous ? "down" : "up");
      if (motionTimerRef.current !== null) window.clearTimeout(motionTimerRef.current);
      motionTimerRef.current = window.setTimeout(() => setMotion(null), 480);
    }
    activeIndexRef.current = next;
    setActiveIndex(next);
  }

  useEffect(() => () => {
    if (motionTimerRef.current !== null) window.clearTimeout(motionTimerRef.current);
  }, []);

  useEffect(() => {
    let frame = 0;
    const updateFromScroll = () => {
      const navigator = navigatorRef.current;
      // Closed sitting disclosures remain mounted. Do no card geometry work for
      // a trail the producer cannot currently see.
      if (!navigator || navigator.getClientRects().length === 0) return;
      const readingLine = navigator.getBoundingClientRect().bottom + 12;
      let closestIndex = 0;
      let closestDistance = Number.POSITIVE_INFINITY;

      items.forEach((item, index) => {
        const rect = document.getElementById(item.domId)?.getBoundingClientRect();
        if (!rect) return;
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
      setActiveMovement(closestIndex);
    };
    const scheduleUpdate = () => {
      if (frame !== 0) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        updateFromScroll();
      });
    };

    updateFromScroll();
    window.addEventListener("scroll", scheduleUpdate, { passive: true });
    return () => {
      window.removeEventListener("scroll", scheduleUpdate);
      if (frame !== 0) window.cancelAnimationFrame(frame);
    };
  }, [items]);

  if (items.length === 0) return null;

  function jumpTo(index: number) {
    const next = Math.max(0, Math.min(items.length - 1, index));
    const target = document.getElementById(items[next]!.domId);
    target?.scrollIntoView({
      // A jump in a 100+ card sitting should be immediate and dependable. A
      // long smooth flight makes the producer wait through the list they were
      // explicitly trying to skip.
      behavior: "auto",
      block: "start",
    });
    setActiveMovement(next);
  }

  function jumpToNextType(type: string) {
    const later = items.findIndex((item, index) => index > activeIndex && movementType(item.decision) === type);
    const first = items.findIndex((item) => movementType(item.decision) === type);
    jumpTo(later >= 0 ? later : first);
  }

  return (
    <nav
      ref={navigatorRef}
      className={`vt-jumpbar ${motion ? `is-moving-${motion}` : ""}`}
      aria-label="Jump through this sitting"
    >
      <p
        className="vt-jumpbar__position"
        aria-label={`Movement ${activeIndex + 1} of ${items.length}`}
        aria-live="polite"
      >
        <strong>{activeIndex + 1}</strong>
        <span>/ {items.length}</span>
        <span className={`vt-jumpbar__motion ${motion ? "is-visible" : ""}`}>
          <svg className={motion === "down" ? "is-down" : ""} viewBox="0 0 24 24" aria-hidden="true">
            <path d="M5 14l7-7 7 7" />
          </svg>
        </span>
      </p>
      <div className="vt-jumpbar__buttons">
        <button
          type="button"
          className="is-edge"
          aria-label="Start"
          title="First movement"
          onClick={() => jumpTo(0)}
          disabled={activeIndex === 0}
        >
          <JumpIcon name="first" />
        </button>
        <button type="button" onClick={() => jumpTo(activeIndex - 1)} disabled={activeIndex === 0}>
          <JumpIcon name="previous" />
          <span>Previous</span>
        </button>
        <button type="button" onClick={() => jumpTo(activeIndex + 1)} disabled={activeIndex === items.length - 1}>
          <JumpIcon name="next" />
          <span>Next</span>
        </button>
        <button
          type="button"
          className="is-edge"
          aria-label="End"
          title="Last movement"
          onClick={() => jumpTo(items.length - 1)}
          disabled={activeIndex === items.length - 1}
        >
          <JumpIcon name="last" />
        </button>
      </div>
      <label className="vt-jumpbar__select">
        <select
          aria-label="Jump to a movement, type, or song position"
          value=""
          onChange={(event) => {
            const [kind, rawIndex] = event.target.value.split(":");
            const index = Number(rawIndex);
            if (kind === "type") jumpToNextType(movementTypes[index]!);
            if (kind === "position" || kind === "movement") jumpTo(index);
          }}
        >
          <option value="">Jump to movement, type, or position…</option>
          <optgroup label="Next movement of type">
            {movementTypes.map((type, index) => (
              <option key={type} value={`type:${index}`}>{type}</option>
            ))}
          </optgroup>
          {songPositions.length > 0 && (
            <optgroup label="Song position">
              {songPositions.map((item) => (
                <option key={item.position} value={`position:${item.index}`}>{item.position}</option>
              ))}
            </optgroup>
          )}
          <optgroup label="Every movement">
            {items.map((item, index) => (
              <option key={item.domId} value={`movement:${index}`}>
                {index + 1}. {formatClock(item.decision.atMs)} · {movementType(item.decision)} · {readableSubject(item.decision.subject)}
              </option>
            ))}
          </optgroup>
        </select>
      </label>
    </nav>
  );
}

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

function SittingWork({
  sitting,
  evidenceFor,
}: {
  sitting: SittingDepth;
  evidenceFor: (decision: ReportDecision) => ReportEvidence[];
}) {
  const [readMode, setReadMode] = useState<SittingReadMode>("time");
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

  if (decisions.length === 0 && sitting.saves.length === 0) {
    return <p className="vt-depth__empty">This sitting captured no work.</p>;
  }

  return (
    <>
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

      <SittingNavigator key={readMode} items={navigationItems} />

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
                <span>{group.label}</span>
                <span>{group.decisions.length}</span>
              </p>
              <ol className="vt-movements">
                {group.decisions.map((decision) => (
                  <MovementCard
                    key={decision.id}
                    decision={decision}
                    evidence={evidenceFor(decision)}
                    domId={domIdFor(decision)}
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
                  domId={domIdFor(entry.decision)}
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
            return (
              // A break that names what it removed is honest; even spacing that
              // hides twenty minutes is not.
              <li key={entry.key} className="vt-trail-gap">
                <span aria-hidden="true" />
                <span>{gapLabel(entry.durationMs)} with nothing captured</span>
                <span aria-hidden="true" />
              </li>
            );
          })}
        </ol>
      )}
    </>
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
function SittingsBlock({ sittings }: { sittings: SittingDepth[] }) {
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
                    <SittingWork
                      sitting={sitting}
                      evidenceFor={(decision) =>
                        decision.evidenceIds
                          .map((id) => sitting.report.evidence[id])
                          .filter((row): row is ReportEvidence => row !== undefined)
                      }
                    />
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
  parent: { name: string; sessionId: string | null } | null;
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
        <p>
          {depth.diff.status === "root" && (
            <span className="vt-depth__origin">First captured version</span>
          )}
          Choose a return, then follow every captured control, track, and song position in order.
        </p>
      </header>

      {/* The root version has nothing to diff against, and a column saying so
          costs a third of the width to deliver one sentence. It moves up into
          the header, where one sentence belongs. */}
      <div className={`vt-depth__grid ${depth.diff.status === "root" ? "is-rootless" : ""}`}>
        {depth.diff.status !== "root" && <DiffBlock depth={depth} />}
        <SittingsBlock sittings={depth.sittings} />
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
  const versions = useMemo(() => projectVersions(project?.captures ?? []), [project]);
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
    return { name: versionLabel(parent), sessionId: latestSitting(parent) };
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
        {selected && <VersionDetail selected={selected} parent={selectedParent} />}
      </section>
    </div>
  );
}
