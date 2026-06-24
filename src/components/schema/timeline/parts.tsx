// Presentational pieces of the schema timeline: the empty/scan state, the
// activity spark graph, the per-row move nodes, and the inline icons. Kept apart
// from the component so the big file is mostly state + layout. Styling comes from
// the global SchemaTimeline.css imported by the parent.

import type { Activity } from "./types";
import { formatMoveValue } from "./format";

export function ScanEmptyState({
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

// Renders a cumulative activity curve as a glowing, gradient-filled spark that
// draws itself in on mount. Shared by the track lanes and the session pulse so
// the timeline reads like a living waveform rather than a chart. The vertical
// gradient (currentColor → transparent) is defined per instance so each lane can
// carry its own track color.
export function ActivitySpark({
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

// Left column of a move row: "Device · Parameter", so the eye can lock onto
// what was touched separately from the value.
export function moveWhatNode(item: Activity) {
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
export function moveValueNode(beforeItem: Activity, afterItem: Activity, count: number) {
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

export function ScanIcon() {
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

export function CopyIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
      <path d="M10.5 5.5V4a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5" strokeLinecap="round" />
    </svg>
  );
}

export function ExportIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
      <path d="M8 10V2.5M8 2.5 5.5 5M8 2.5 10.5 5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M3 9.5v3A1.5 1.5 0 0 0 4.5 14h7a1.5 1.5 0 0 0 1.5-1.5v-3" strokeLinecap="round" />
    </svg>
  );
}
