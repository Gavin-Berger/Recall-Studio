// Share/export for the schema timeline. One structured snapshot of the take
// (buildShareData) feeds every format so JSON, Markdown, plain text, and the
// print-ready HTML never drift apart. Pure except exportPdf, which drives the
// webview's print dialog through a hidden iframe.

import type { ParameterChange } from "../../../types/schema";
import type { ExportFormat, Highlight } from "./types";
import { formatElapsed, formatMoveValue } from "./format";

// Everything the share snapshot needs from the component, passed in so the
// builder stays pure and testable.
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
  highlights: Highlight[];
  sessionStart: number;
};

// One structured snapshot of the take, shared by every export format so JSON,
// Markdown, and plain text never drift apart. Strings are the producer-facing
// display values; raw numeric fields are kept alongside for machine consumers.
export function buildShareData(input: ShareInput) {
  const { changes, highlights, sessionStart } = input;
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
    title: input.title,
    project: input.project,
    duration: input.duration,
    recordedAtMs: input.recordedAtMs,
    exportedAtMs: Date.now(),
    stats: input.stats,
    story: input.story ? input.story.join(" ") : null,
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
        elapsedMs: h.atMs - sessionStart,
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
        elapsedMs: c.changed_at_ms - sessionStart,
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

export function buildShareDocument(data: ShareData, format: Exclude<ExportFormat, "pdf">): string {
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
  // Let the iframe lay out before invoking the print/save-as-PDF dialog.
  window.setTimeout(() => {
    frame.contentWindow?.focus();
    frame.contentWindow?.print();
    window.setTimeout(() => document.body.removeChild(frame), 1500);
  }, 250);
}
