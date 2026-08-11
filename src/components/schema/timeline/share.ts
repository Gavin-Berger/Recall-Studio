// Share/export for the schema timeline. Every format is rendered from one
// structured project record: context first, a short Song Story second, then a
// chronological record of the actual work. The raw controls are still there,
// but repeated adjustments to one control are collected into one decision so a
// producer can read the document instead of decoding a stream of knob events.

import type { CreativeMoment, NoteEdit, ParameterChange } from "../../../types/schema";
import type { ExportFormat, SessionBlock } from "./types";
import { formatMoveValue } from "./format";

const TIMELINE_BLOCK_GAP_MS = 2 * 60 * 1000;
const UNKNOWN_VALUE = "—";

export type ShareTimelineSource = {
  id: string;
  label: string;
  startedAtMs: number | null;
  changes: ParameterChange[];
  noteEdits?: NoteEdit[];
  moments?: CreativeMoment[];
};

export type ShareProjectRecord = {
  name: string | null;
  setName: string | null;
  producerName: string | null;
  captureCount: number;
  firstCapturedAtMs: number | null;
  lastCapturedAtMs: number | null;
};

export type ShareProjectStory = {
  summary: string;
  chapters: {
    startMs: number;
    endMs: number;
    label: string;
    work: string;
    moves: number;
    noteEdits: number;
    activeMs: number;
  }[];
};

type ShareInput = {
  title: string;
  project: string | null;
  duration: string | null;
  recordedAtMs: number | null;
  changes: ParameterChange[];
  stats: {
    moves: number;
    characterMoves: number;
    tracksTouched: number;
    keepers: number;
  };
  story: string[] | null;
  blocks: SessionBlock[];
  sessionStart: number;
  timelineSources?: ShareTimelineSource[];
  projectRecord?: ShareProjectRecord | null;
  projectStory?: ShareProjectStory | null;
};

type TimelineParameter = {
  device: string | null;
  parameter: string;
  before: string;
  after: string;
  moveCount: number;
  firstAtMs: number;
};

type TimelineEntry =
  | {
      kind: "moves";
      id: string;
      sourceId: string;
      sourceLabel: string;
      atMs: number;
      endMs: number;
      track: string;
      moveCount: number;
      parameters: TimelineParameter[];
    }
  | {
      kind: "midi";
      id: string;
      sourceId: string;
      sourceLabel: string;
      atMs: number;
      endMs: number;
      track: string;
      clip: string;
      detail: string;
    }
  | {
      kind: "note";
      id: string;
      sourceId: string;
      sourceLabel: string;
      atMs: number;
      endMs: number;
      track: string | null;
      detail: string;
    };

type RawTimelineItem =
  | { kind: "move"; source: ShareTimelineSource; atMs: number; change: ParameterChange }
  | { kind: "midi"; source: ShareTimelineSource; atMs: number; edit: NoteEdit }
  | { kind: "note"; source: ShareTimelineSource; atMs: number; moment: CreativeMoment };

function cleanName(value: string | null | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return !trimmed || trimmed === "0" ? fallback : trimmed;
}

function valueOf(change: ParameterChange, side: "before" | "after"): string {
  return side === "before"
    ? formatMoveValue(
        change.before_value,
        change.before_value_percent,
        change.unit,
        change.before_display_value,
      )
    : formatMoveValue(
        change.after_value,
        change.after_value_percent,
        change.unit,
        change.after_display_value,
      );
}

function describeNoteEdit(edit: NoteEdit): string {
  if (edit.summary?.trim()) return edit.summary.trim();
  const previous = edit.previous_note_count ?? 0;
  const count = edit.note_count ?? 0;
  if (edit.change_kind === "cleared") return `Cleared ${previous} ${previous === 1 ? "note" : "notes"}`;

  const countLabel = `${count} ${count === 1 ? "note" : "notes"}`;
  const delta =
    edit.previous_note_count !== null &&
    edit.previous_note_count !== undefined &&
    edit.previous_note_count !== count
      ? ` (${count - edit.previous_note_count > 0 ? "+" : ""}${count - edit.previous_note_count})`
      : "";
  const range =
    edit.pitch_range && edit.previous_pitch_range && edit.pitch_range !== edit.previous_pitch_range
      ? `${edit.previous_pitch_range} → ${edit.pitch_range}`
      : edit.pitch_range;
  return [countLabel + delta, range].filter(Boolean).join(", ");
}

function eventTrackKey(change: ParameterChange): string {
  return change.track_id?.trim() || cleanName(change.track_name, "Unassigned track").toLowerCase();
}

function buildChronologicalTimeline(sources: ShareTimelineSource[]): TimelineEntry[] {
  const raw: RawTimelineItem[] = [];
  for (const source of sources) {
    for (const change of source.changes) {
      if (Number.isFinite(change.changed_at_ms)) {
        raw.push({ kind: "move", source, atMs: change.changed_at_ms, change });
      }
    }
    for (const edit of source.noteEdits ?? []) {
      if (Number.isFinite(edit.changed_at_ms)) raw.push({ kind: "midi", source, atMs: edit.changed_at_ms, edit });
    }
    for (const moment of source.moments ?? []) {
      const atMs = moment.timeline_start_ms ?? moment.created_at_ms;
      if (Number.isFinite(atMs)) raw.push({ kind: "note", source, atMs, moment });
    }
  }
  raw.sort((a, b) => a.atMs - b.atMs);

  const entries: TimelineEntry[] = [];
  for (const item of raw) {
    if (item.kind === "midi") {
      entries.push({
        kind: "midi",
        id: item.edit.id,
        sourceId: item.source.id,
        sourceLabel: item.source.label,
        atMs: item.atMs,
        endMs: item.atMs,
        track: cleanName(item.edit.track_name, "Unassigned track"),
        clip: cleanName(item.edit.clip_name, "Untitled clip"),
        detail: describeNoteEdit(item.edit),
      });
      continue;
    }
    if (item.kind === "note") {
      entries.push({
        kind: "note",
        id: item.moment.id,
        sourceId: item.source.id,
        sourceLabel: item.source.label,
        atMs: item.atMs,
        endMs: item.atMs,
        track: null,
        detail: cleanName(item.moment.title, "Saved note"),
      });
      continue;
    }

    const track = cleanName(item.change.track_name, "Unassigned track");
    const key = eventTrackKey(item.change);
    const previous = entries.at(-1);
    const canContinue =
      previous?.kind === "moves" &&
      previous.sourceId === item.source.id &&
      previous.track === track &&
      item.atMs - previous.endMs <= TIMELINE_BLOCK_GAP_MS;
    const entry = canContinue
      ? previous
      : (() => {
          const next: Extract<TimelineEntry, { kind: "moves" }> = {
            kind: "moves",
            id: `block-${item.source.id}-${key}-${item.atMs}`,
            sourceId: item.source.id,
            sourceLabel: item.source.label,
            atMs: item.atMs,
            endMs: item.atMs,
            track,
            moveCount: 0,
            parameters: [],
          };
          entries.push(next);
          return next;
        })();

    entry.endMs = item.atMs;
    entry.moveCount += 1;
    const device = item.change.device_name?.trim() || null;
    const parameter = cleanName(item.change.parameter_name, "Unlabelled control");
    const paramKey = `${device ?? ""}\u0000${parameter}`;
    const parameterEntry = entry.parameters.find((candidate) => `${candidate.device ?? ""}\u0000${candidate.parameter}` === paramKey);
    if (parameterEntry) {
      parameterEntry.after = valueOf(item.change, "after");
      parameterEntry.moveCount += 1;
    } else {
      entry.parameters.push({
        device,
        parameter,
        before: valueOf(item.change, "before"),
        after: valueOf(item.change, "after"),
        moveCount: 1,
        firstAtMs: item.atMs,
      });
    }
  }
  return entries;
}

function formatClock(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" });
}

function formatDateTime(ms: number | null): string | null {
  if (!ms || !Number.isFinite(ms)) return null;
  return new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function transition(before: string, after: string): string {
  if (after === UNKNOWN_VALUE) {
    return before === UNKNOWN_VALUE
      ? "adjusted (values not captured)"
      : `from ${before} (final value not captured)`;
  }
  if (before === UNKNOWN_VALUE || before === after) return `set to ${after}`;
  return `${before} → ${after}`;
}

function moveLabel(count: number): string {
  return `${count} move${count === 1 ? "" : "s"}`;
}

function timelineDayKey(ms: number): string {
  const date = new Date(ms);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function projectRecordOf(input: ShareInput, sources: ShareTimelineSource[]): ShareProjectRecord {
  const inferredTimes = sources
    .flatMap((source) => [source.startedAtMs, ...source.changes.map((change) => change.changed_at_ms)])
    .filter((time): time is number => time !== null && Number.isFinite(time));
  return (
    input.projectRecord ?? {
      name: input.project,
      setName: null,
      producerName: null,
      captureCount: sources.length,
      firstCapturedAtMs: inferredTimes.length ? Math.min(...inferredTimes) : input.recordedAtMs,
      lastCapturedAtMs: inferredTimes.length ? Math.max(...inferredTimes) : input.recordedAtMs,
    }
  );
}

// One structured snapshot of the take/project, shared by JSON, Markdown, text,
// and the print-ready PDF. `tracks` and `sections` stay in the JSON model for
// backwards compatibility; people-facing formats render the chronological log.
export function buildShareData(input: ShareInput) {
  const fallbackSource: ShareTimelineSource = {
    id: "current-take",
    label: input.title,
    startedAtMs: input.recordedAtMs,
    changes: input.changes,
  };
  const sources = input.timelineSources?.length ? input.timelineSources : [fallbackSource];
  const changes = sources.flatMap((source) => source.changes);
  const byTrack = new Map<string, ParameterChange[]>();
  for (const change of [...changes].sort((a, b) => a.changed_at_ms - b.changed_at_ms)) {
    const key = change.track_id ?? change.track_name ?? "Unknown track";
    const list = byTrack.get(key);
    if (list) list.push(change);
    else byTrack.set(key, [change]);
  }

  return {
    title: input.title,
    project: input.project,
    duration: input.duration,
    recordedAtMs: input.recordedAtMs,
    exportedAtMs: Date.now(),
    stats: input.stats,
    // Kept for JSON consumers from the first exporter. `takeSummary` names its
    // scope more clearly in the redesigned document.
    story: input.story ? input.story.join(" ") : null,
    takeSummary: input.story ? input.story.join(" ") : null,
    projectRecord: projectRecordOf(input, sources),
    projectStory: input.projectStory ?? null,
    timeline: buildChronologicalTimeline(sources),
    sections: input.blocks.map((block) => ({
      track: block.trackName,
      moves: block.moveCount,
      params: block.topParams.map((parameter) => parameter.name),
      device: block.devices[0] ?? null,
      elapsedMs: block.startMs - input.sessionStart,
      durationMs: Math.max(0, block.endMs - block.startMs),
    })),
    tracks: [...byTrack.entries()].map(([key, list]) => ({
      key,
      name: list[0]?.track_name ?? "Unknown track",
      moves: list.length,
      changes: list.map((change) => ({
        device: change.device_name,
        parameter: change.parameter_name,
        before: valueOf(change, "before"),
        after: valueOf(change, "after"),
        beforeValue: change.before_value,
        afterValue: change.after_value,
        unit: change.unit,
        isQuantized: change.is_quantized ?? false,
        atMs: change.changed_at_ms,
        elapsedMs: change.changed_at_ms - input.sessionStart,
      })),
    })),
  };
}

type ShareData = ReturnType<typeof buildShareData>;

function detailRowsMarkdown(entry: Extract<TimelineEntry, { kind: "moves" }>): string[] {
  return entry.parameters.map((parameter) => {
    const where = [parameter.device, parameter.parameter].filter(Boolean).join(" · ");
    const repeat = parameter.moveCount > 1 ? ` · ${moveLabel(parameter.moveCount)}` : "";
    return `  - ${where}: ${transition(parameter.before, parameter.after)}${repeat}`;
  });
}

function appendTimelineMarkdown(lines: string[], timeline: TimelineEntry[]) {
  if (timeline.length === 0) return;
  lines.push("## Full timeline", "", "All work is ordered by the time it happened. Repeated moves to the same control in one short stretch are combined into a single result.", "");
  let day = "";
  let sourceId = "";
  for (const entry of timeline) {
    const nextDay = timelineDayKey(entry.atMs);
    if (nextDay !== day) {
      day = nextDay;
      sourceId = "";
      lines.push(`### ${formatDate(entry.atMs)}`, "");
    }
    if (entry.sourceId !== sourceId) {
      sourceId = entry.sourceId;
      lines.push(`**Take — ${entry.sourceLabel}**`, "");
    }
    if (entry.kind === "moves") {
      lines.push(`- **${formatClock(entry.atMs)} · ${entry.track}** — ${moveLabel(entry.moveCount)}`);
      lines.push(...detailRowsMarkdown(entry));
      continue;
    }
    if (entry.kind === "midi") {
      lines.push(`- **${formatClock(entry.atMs)} · ${entry.track}** — MIDI · **${entry.clip}**: ${entry.detail}`);
      continue;
    }
    lines.push(`- **${formatClock(entry.atMs)}** — Saved note: ${entry.detail}`);
  }
  lines.push("");
}

function appendProjectHeaderMarkdown(lines: string[], d: ShareData) {
  const record = d.projectRecord;
  const heading = record.name ?? d.project ?? d.title;
  lines.push(`# ${heading}`, "", "_Project record · Recall Studio_", "");
  lines.push("## Project details", "");
  lines.push(`- **Project:** ${record.name ?? d.project ?? "Unassigned project"}`);
  lines.push(`- **Take:** ${d.title}`);
  if (record.setName) lines.push(`- **Ableton set:** ${record.setName}`);
  if (record.producerName) lines.push(`- **Producer:** ${record.producerName}`);
  if (record.captureCount > 0) lines.push(`- **Captured takes:** ${record.captureCount}`);
  if (d.duration) lines.push(`- **This take:** ${d.duration}`);
  const captured = formatDateTime(record.firstCapturedAtMs ?? d.recordedAtMs);
  if (captured) lines.push(`- **First captured:** ${captured}`);
  lines.push(`- **Exported:** ${formatDateTime(d.exportedAtMs)}`);
  lines.push("");
}

function appendStoryMarkdown(lines: string[], d: ShareData) {
  const story = d.projectStory;
  if (!story && !d.takeSummary) return;
  lines.push("## Song story", "");
  if (story) {
    lines.push(story.summary, "");
    for (const chapter of story.chapters) {
      const work = chapter.work ? ` — ${chapter.work}` : "";
      const noteEdits = chapter.noteEdits > 0 ? ` · ${chapter.noteEdits} MIDI edit${chapter.noteEdits === 1 ? "" : "s"}` : "";
      lines.push(`- **${formatDateTime(chapter.startMs)}** — ${chapter.label}${work} · ${moveLabel(chapter.moves)}${noteEdits}`);
    }
    lines.push("");
    return;
  }
  lines.push(d.takeSummary ?? "", "");
}

function renderMarkdown(d: ShareData): string {
  const lines: string[] = [];
  appendProjectHeaderMarkdown(lines, d);
  appendStoryMarkdown(lines, d);
  appendTimelineMarkdown(lines, d.timeline);
  if (d.timeline.length === 0) lines.push("No recorded changes yet.", "");
  lines.push("---", "_Exported from Recall Studio_");
  return lines.join("\n");
}

function renderText(d: ShareData): string {
  const lines: string[] = [];
  const record = d.projectRecord;
  lines.push(record.name ?? d.project ?? d.title, "PROJECT RECORD · RECALL STUDIO", "");
  lines.push("PROJECT DETAILS");
  lines.push(`Project: ${record.name ?? d.project ?? "Unassigned project"}`);
  lines.push(`Take: ${d.title}`);
  if (record.setName) lines.push(`Ableton set: ${record.setName}`);
  if (record.producerName) lines.push(`Producer: ${record.producerName}`);
  if (record.captureCount > 0) lines.push(`Captured takes: ${record.captureCount}`);
  if (d.duration) lines.push(`This take: ${d.duration}`);
  lines.push(`Exported: ${formatDateTime(d.exportedAtMs)}`, "");

  if (d.projectStory || d.takeSummary) {
    lines.push("SONG STORY");
    if (d.projectStory) {
      lines.push(d.projectStory.summary);
      for (const chapter of d.projectStory.chapters) {
        lines.push(`- ${formatDateTime(chapter.startMs)} — ${chapter.label}: ${chapter.work} (${moveLabel(chapter.moves)})`);
      }
    } else if (d.takeSummary) {
      lines.push(d.takeSummary);
    }
    lines.push("");
  }

  if (d.timeline.length > 0) {
    lines.push("FULL TIMELINE", "All work is in chronological order. Repeated moves in one short stretch are combined.", "");
    let day = "";
    let sourceId = "";
    for (const entry of d.timeline) {
      const nextDay = timelineDayKey(entry.atMs);
      if (nextDay !== day) {
        day = nextDay;
        sourceId = "";
        lines.push(formatDate(entry.atMs));
      }
      if (entry.sourceId !== sourceId) {
        sourceId = entry.sourceId;
        lines.push(`  Take: ${entry.sourceLabel}`);
      }
      if (entry.kind === "moves") {
        lines.push(`  ${formatClock(entry.atMs)}  ${entry.track} — ${moveLabel(entry.moveCount)}`);
        for (const parameter of entry.parameters) {
          const where = [parameter.device, parameter.parameter].filter(Boolean).join(" · ");
          lines.push(`      ${where}: ${transition(parameter.before, parameter.after)}${parameter.moveCount > 1 ? ` (${moveLabel(parameter.moveCount)})` : ""}`);
        }
      } else if (entry.kind === "midi") {
        lines.push(`  ${formatClock(entry.atMs)}  ${entry.track} — MIDI · ${entry.clip}: ${entry.detail}`);
      } else {
        lines.push(`  ${formatClock(entry.atMs)}  Saved note: ${entry.detail}`);
      }
    }
  } else {
    lines.push("FULL TIMELINE", "No recorded changes yet.");
  }
  lines.push("", "Exported from Recall Studio");
  return lines.join("\n");
}

export function buildShareDocument(data: ShareData, format: Exclude<ExportFormat, "pdf">): string {
  if (format === "json") return JSON.stringify(data, null, 2);
  if (format === "txt") return renderText(data);
  return renderMarkdown(data);
}

function esc(value: string | null | undefined): string {
  return (value ?? "").replace(/[&<>]/g, (character) =>
    character === "&" ? "&amp;" : character === "<" ? "&lt;" : "&gt;",
  );
}

function projectDetailsHtml(d: ShareData): string {
  const record = d.projectRecord;
  const rows = [
    ["Project", record.name ?? d.project ?? "Unassigned project"],
    ["Take", d.title],
    record.setName ? ["Ableton set", record.setName] : null,
    record.producerName ? ["Producer", record.producerName] : null,
    record.captureCount > 0 ? ["Captured takes", String(record.captureCount)] : null,
    d.duration ? ["This take", d.duration] : null,
    formatDateTime(record.firstCapturedAtMs ?? d.recordedAtMs)
      ? ["First captured", formatDateTime(record.firstCapturedAtMs ?? d.recordedAtMs) as string]
      : null,
    ["Exported", formatDateTime(d.exportedAtMs) ?? "Now"],
  ].filter((row): row is string[] => row !== null);
  return rows.map(([label, value]) => `<div><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`).join("");
}

function storyHtml(d: ShareData): string {
  if (!d.projectStory && !d.takeSummary) return "";
  if (!d.projectStory) return `<section><h2>Song story</h2><p class="summary">${esc(d.takeSummary)}</p></section>`;
  const chapters = d.projectStory.chapters
    .map((chapter) => {
      const noteEdits = chapter.noteEdits > 0 ? ` · ${chapter.noteEdits} MIDI edit${chapter.noteEdits === 1 ? "" : "s"}` : "";
      return `<li><time>${esc(formatDateTime(chapter.startMs))}</time><div><b>${esc(chapter.label)}</b><span>${esc(chapter.work)}</span><small>${chapter.moves} move${chapter.moves === 1 ? "" : "s"}${noteEdits}</small></div></li>`;
    })
    .join("");
  return `<section><h2>Song story</h2><p class="summary">${esc(d.projectStory.summary)}</p>${chapters ? `<ol class="story">${chapters}</ol>` : ""}</section>`;
}

function timelineHtml(d: ShareData): string {
  if (d.timeline.length === 0) return `<section><h2>Full timeline</h2><p class="quiet">No recorded changes yet.</p></section>`;
  let day = "";
  let sourceId = "";
  const output: string[] = [
    `<section><h2>Full timeline</h2><p class="quiet">All work is ordered by the time it happened. Repeated moves to one control in a short stretch are combined into a single result.</p>`,
  ];
  for (const entry of d.timeline) {
    const nextDay = timelineDayKey(entry.atMs);
    if (nextDay !== day) {
      if (day) output.push(`</ol></section>`);
      day = nextDay;
      sourceId = "";
      output.push(`<section class="day"><h3>${esc(formatDate(entry.atMs))}</h3><ol>`);
    }
    const take = entry.sourceId !== sourceId ? `<p class="take">Take · ${esc(entry.sourceLabel)}</p>` : "";
    sourceId = entry.sourceId;
    if (entry.kind === "moves") {
      const parameters = entry.parameters
        .map((parameter) => {
          const where = [parameter.device, parameter.parameter].filter(Boolean).join(" · ");
          const repeat = parameter.moveCount > 1 ? ` <small>· ${moveLabel(parameter.moveCount)}</small>` : "";
          return `<li><b>${esc(where)}</b><span>${esc(transition(parameter.before, parameter.after))}</span>${repeat}</li>`;
        })
        .join("");
      output.push(`<li class="entry"><time>${esc(formatClock(entry.atMs))}</time><div>${take}<h4>${esc(entry.track)} <small>${moveLabel(entry.moveCount)}</small></h4><ul>${parameters}</ul></div></li>`);
      continue;
    }
    if (entry.kind === "midi") {
      output.push(`<li class="entry"><time>${esc(formatClock(entry.atMs))}</time><div>${take}<h4>${esc(entry.track)} <small>MIDI edit</small></h4><p><b>${esc(entry.clip)}</b> · ${esc(entry.detail)}</p></div></li>`);
      continue;
    }
    output.push(`<li class="entry"><time>${esc(formatClock(entry.atMs))}</time><div>${take}<h4>Saved note</h4><p>${esc(entry.detail)}</p></div></li>`);
  }
  output.push(`</ol></section></section>`);
  return output.join("");
}

// A print-ready HTML document for the PDF path. The print dialog remains the
// renderer so users can choose their own PDF destination, paper, and printer.
function renderHtml(d: ShareData): string {
  const record = d.projectRecord;
  const heading = record.name ?? d.project ?? d.title;
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(heading)} — Recall Studio</title>
<style>
  @page { margin: 0.68in; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #202228; line-height: 1.45; margin: 0; }
  header { border-top: 4px solid #526fbd; padding: 18px 0 16px; border-bottom: 1px solid #dfe2e8; }
  .brand { color: #66708a; font-size: 10px; font-weight: 700; letter-spacing: .14em; text-transform: uppercase; }
  h1 { margin: 5px 0 2px; font-size: 27px; letter-spacing: -.025em; }
  .sub { margin: 0; color: #626976; font-size: 12px; }
  h2 { margin: 28px 0 9px; padding-bottom: 5px; border-bottom: 1px solid #dfe2e8; color: #526fbd; font-size: 11px; font-weight: 750; letter-spacing: .1em; text-transform: uppercase; }
  h3 { margin: 20px 0 7px; color: #343945; font-size: 14px; }
  h4 { margin: 0 0 5px; color: #2d313a; font-size: 13px; }
  .details { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0; margin: 12px 0 0; border-top: 1px solid #e4e6eb; border-left: 1px solid #e4e6eb; }
  .details div { min-height: 54px; padding: 8px 10px; border-right: 1px solid #e4e6eb; border-bottom: 1px solid #e4e6eb; }
  dt { color: #737987; font-size: 9px; font-weight: 700; letter-spacing: .09em; text-transform: uppercase; }
  dd { margin: 2px 0 0; color: #282c34; font-size: 12px; font-weight: 600; overflow-wrap: anywhere; }
  .summary { max-width: 78ch; margin: 0; color: #444a56; font-size: 13px; }
  .story { display: grid; gap: 8px; margin: 12px 0 0; padding: 0; list-style: none; }
  .story li { display: grid; grid-template-columns: 130px minmax(0, 1fr); gap: 10px; }
  .story time, .entry > time { color: #767d8a; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 10px; }
  .story span, .story small { display: block; color: #606774; font-size: 11px; }
  .story small { margin-top: 1px; }
  .quiet { margin: 0; color: #656c78; font-size: 12px; }
  .day { break-inside: avoid; }
  .day > ol { margin: 0; padding: 0; list-style: none; }
  .entry { display: grid; grid-template-columns: 72px minmax(0, 1fr); gap: 12px; padding: 10px 0; border-top: 1px solid #e6e8ed; break-inside: avoid; }
  .entry > time { padding-top: 2px; white-space: nowrap; }
  .entry p { margin: 0; color: #474d59; font-size: 12px; }
  .entry ul { display: grid; gap: 3px; margin: 0; padding: 0; list-style: none; }
  .entry ul li { display: flex; flex-wrap: wrap; gap: 4px 8px; color: #4b5260; font-size: 11px; }
  .entry ul b { color: #323742; font-weight: 650; }
  .entry small, h4 small { color: #777f8c; font-size: 10px; font-weight: 500; }
  .take { margin: 0 0 4px; color: #707887 !important; font-size: 10px !important; font-weight: 650; letter-spacing: .04em; text-transform: uppercase; }
  .foot { margin-top: 30px; color: #9298a3; font-size: 10px; }
</style></head><body>
  <header><div class="brand">Recall Studio · Project record</div><h1>${esc(heading)}</h1><p class="sub">A readable record of the project’s captured decisions.</p></header>
  <section><h2>Project details</h2><dl class="details">${projectDetailsHtml(d)}</dl></section>
  ${storyHtml(d)}
  ${timelineHtml(d)}
  <div class="foot">Exported from Recall Studio</div>
</body></html>`;
}

export function exportPdf(data: ShareData) {
  const html = renderHtml(data);
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
  window.setTimeout(() => {
    frame.contentWindow?.focus();
    frame.contentWindow?.print();
    window.setTimeout(() => document.body.removeChild(frame), 1500);
  }, 250);
}
