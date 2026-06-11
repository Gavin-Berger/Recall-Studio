// Pure assembly helpers for the schema timeline. These take the data returned by
// the backend (project tree, parameter changes, creative moments) and shape it for
// the UI: a chronological change/moment stream, group→track nesting, and
// before→after value formatting. No I/O — unit-testable in isolation.

import type {
  CreativeMoment,
  ParameterChange,
  ProjectSchema,
  TrackObj,
} from "../../types/schema";

export type SchemaStreamItem =
  | { kind: "change"; id: string; at: number; change: ParameterChange }
  | { kind: "moment"; id: string; at: number; moment: CreativeMoment };

/**
 * Merge the factual parameter-change stream with user-created creative moments
 * into one chronological list. Moments anchor to their timeline start, falling
 * back to when they were created.
 */
export function buildSchemaStream(
  changes: ParameterChange[],
  moments: CreativeMoment[],
): SchemaStreamItem[] {
  const items: SchemaStreamItem[] = [];

  for (const change of changes) {
    items.push({ kind: "change", id: change.id, at: change.changed_at_ms, change });
  }

  for (const moment of moments) {
    items.push({
      kind: "moment",
      id: moment.id,
      at: moment.timeline_start_ms ?? moment.created_at_ms,
      moment,
    });
  }

  items.sort((a, b) => a.at - b.at);
  return items;
}

export type TrackGroup = {
  group: TrackObj;
  children: TrackObj[];
};

/**
 * Nest tracks under their parent group. Group tracks become headers with their
 * member tracks; everything ungrouped (including return tracks) is returned flat.
 */
export function groupTracksByParent(schema: ProjectSchema): {
  groups: TrackGroup[];
  ungrouped: TrackObj[];
} {
  const byGroupId = new Map<string, TrackGroup>();
  for (const track of schema.tracks) {
    if (track.type === "group") {
      byGroupId.set(track.id, { group: track, children: [] });
    }
  }

  const ungrouped: TrackObj[] = [];
  for (const track of schema.tracks) {
    if (track.type === "group") continue;
    const parent = track.group_id ? byGroupId.get(track.group_id) : undefined;
    if (parent) {
      parent.children.push(track);
    } else {
      ungrouped.push(track);
    }
  }

  return { groups: [...byGroupId.values()], ungrouped };
}

/** Render a control change as "Name: before → after" (or "Name → after" when the pre-value is unknown). */
export function formatParameterChange(change: ParameterChange): string {
  const name = change.parameter_name ?? "Control";
  const after = formatValue(change.after_value);

  if (change.before_value === null || change.before_value === undefined) {
    return `${name} → ${after}`;
  }

  return `${name}: ${formatValue(change.before_value)} → ${after}`;
}

/** A short "Track · Device" context line for a change, omitting missing parts. */
export function formatChangeContext(change: ParameterChange): string {
  return [change.track_name, change.device_name].filter(Boolean).join(" · ");
}

export function formatValue(value: number | null | undefined): string {
  if (value === null || value === undefined) {
    return "—";
  }

  if (Number.isInteger(value)) {
    return String(value);
  }

  return value.toFixed(2).replace(/\.?0+$/, "");
}
