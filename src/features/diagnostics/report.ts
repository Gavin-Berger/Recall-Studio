// Build the diagnostic report a producer sends when something goes wrong.
//
// Pure on purpose: everything it needs is passed in, so the formatting is unit
// tested and the dialog stays a thin shell. The output is plain text the
// producer can read in full before deciding to share it — nothing here is
// uploaded, and the dialog shows exactly this string.

import type { LoggedError } from "./errorLog";

/** Mirrors BridgeMetricsSnapshot in src-tauri/src/metrics.rs. */
export type BridgeMetrics = {
  packets_received: number;
  malformed_packets: number;
  dropped_packets: number;
  events_queued: number;
  events_persisted: number;
  events_emitted: number;
  queue_depth: number;
  last_event_ms: number | null;
  last_error: string | null;
  protected_dropped: number;
  sequence_gaps: number;
  session_discarded: number;
  panics_recovered: number;
  oversized_packets: number;
};

export type ReportInput = {
  generatedAtMs: number;
  appVersion: string | null;
  platform: string | null;
  connection: {
    connected: boolean;
    bridgeVersion: string | null;
    lastHeartbeatMs: number | null;
  };
  metrics: BridgeMetrics | null;
  errors: LoggedError[];
  /** The producer's own description of what they were doing. */
  note?: string;
};

function stamp(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
}

function clockTime(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function ago(nowMs: number, thenMs: number | null): string {
  if (thenMs === null || !Number.isFinite(thenMs)) return "never";
  const seconds = Math.max(0, Math.round((nowMs - thenMs) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m ago`;
}

export function buildDiagnosticReport(input: ReportInput): string {
  const lines: string[] = [];

  lines.push("RECALL STUDIO — PROBLEM REPORT");
  lines.push(`Generated: ${stamp(input.generatedAtMs)}`);
  lines.push(`App version: ${input.appVersion ?? "unknown"}`);
  lines.push(`Platform: ${input.platform ?? "unknown"}`);
  lines.push("");

  lines.push("WHAT HAPPENED");
  lines.push(input.note?.trim() ? input.note.trim() : "(the producer did not add a description)");
  lines.push("");

  lines.push("ABLETON CONNECTION");
  lines.push(`Connected: ${input.connection.connected ? "yes" : "no"}`);
  lines.push(`Bridge version: ${input.connection.bridgeVersion ?? "unknown"}`);
  lines.push(
    `Last heartbeat: ${ago(input.generatedAtMs, input.connection.lastHeartbeatMs)}`,
  );
  lines.push("");

  lines.push("CAPTURE PIPELINE");
  if (!input.metrics) {
    lines.push("(metrics unavailable — the app could not reach the backend)");
  } else {
    const m = input.metrics;
    lines.push(`Packets received: ${m.packets_received}`);
    lines.push(`Malformed packets: ${m.malformed_packets}`);
    lines.push(`Dropped packets: ${m.dropped_packets} (protected: ${m.protected_dropped})`);
    lines.push(`Sequence gaps: ${m.sequence_gaps}`);
    lines.push(`Oversized packets: ${m.oversized_packets}`);
    lines.push(`Events queued / persisted / shown: ${m.events_queued} / ${m.events_persisted} / ${m.events_emitted}`);
    lines.push(`Queue depth now: ${m.queue_depth}`);
    lines.push(`Sessions discarded: ${m.session_discarded}`);
    lines.push(`Panics recovered: ${m.panics_recovered}`);
    lines.push(`Last event: ${ago(input.generatedAtMs, m.last_event_ms)}`);
    if (m.last_error) lines.push(`Last backend error: ${m.last_error}`);
  }
  lines.push("");

  lines.push(`PROBLEMS RECORDED (${input.errors.length})`);
  if (input.errors.length === 0) {
    lines.push("(none recorded this session)");
  } else {
    for (const error of input.errors) {
      lines.push(`[${clockTime(error.at_ms)}] ${error.scope}: ${error.message}`);
      if (error.detail) {
        // Indent the cause so a multi-line stack stays readable in a paste.
        for (const detailLine of error.detail.split("\n")) {
          lines.push(`    ${detailLine}`);
        }
      }
    }
  }

  lines.push("");
  lines.push("— end of report —");

  return lines.join("\n");
}

/** Filename for a saved report, safe on every platform. */
export function reportFileName(generatedAtMs: number): string {
  const iso = new Date(generatedAtMs).toISOString().replace(/[:.]/g, "-").replace(/Z$/, "");
  return `recall-studio-report-${iso}.txt`;
}
