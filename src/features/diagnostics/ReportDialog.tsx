import { useEffect, useMemo, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "../../lib/schema/api";
import { clearLoggedErrors, useErrorLog } from "./errorLog";
import { buildDiagnosticReport, reportFileName, type BridgeMetrics } from "./report";
import type { ConnectionStatus } from "../../types";

// "Report a problem": gather what went wrong into one piece of text the producer
// can read in full, then copy or save and send on.
//
// Nothing is transmitted from here. The report is built locally and shown
// verbatim before the producer decides to share it — the same rule the recap
// export follows (PRD §9: musical content leaves only on an explicit export).

type ReportDialogProps = {
  open: boolean;
  onClose: () => void;
  connection: ConnectionStatus;
};

export function ReportDialog({ open, onClose, connection }: ReportDialogProps) {
  const errors = useErrorLog();
  const [note, setNote] = useState("");
  const [metrics, setMetrics] = useState<BridgeMetrics | null>(null);
  const [appVersion, setAppVersion] = useState<string | null>(null);
  const [generatedAtMs, setGeneratedAtMs] = useState(() => Date.now());
  const [status, setStatus] = useState<string | null>(null);

  // Refresh the snapshot each time the dialog opens, so the report describes the
  // moment the producer is reporting — not whenever the app happened to start.
  useEffect(() => {
    if (!open) return;
    setGeneratedAtMs(Date.now());
    setStatus(null);
    if (!isTauri()) return;

    let cancelled = false;
    void (async () => {
      try {
        const snapshot = await invoke<BridgeMetrics>("get_bridge_metrics");
        if (!cancelled) setMetrics(snapshot);
      } catch {
        // Report says "metrics unavailable" rather than failing to open.
      }
      try {
        const version = await getVersion();
        if (!cancelled) setAppVersion(version);
      } catch {
        // Same: an unknown version must not block a report.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  // Close on Escape, like every other dismissible surface.
  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  const report = useMemo(
    () =>
      buildDiagnosticReport({
        generatedAtMs,
        appVersion,
        platform: typeof navigator === "undefined" ? null : navigator.userAgent,
        connection: {
          connected: connection.connected,
          bridgeVersion: connection.bridge_version,
          lastHeartbeatMs: connection.last_heartbeat_ms,
        },
        metrics,
        errors,
        note,
      }),
    [generatedAtMs, appVersion, connection, metrics, errors, note],
  );

  if (!open) return null;

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(report);
      setStatus("Report copied. Paste it into a message to send it.");
    } catch {
      setStatus("Couldn't reach the clipboard — select the text below and copy it manually.");
    }
  }

  async function handleSave() {
    try {
      const path = await save({
        title: "Save problem report",
        defaultPath: reportFileName(generatedAtMs),
        filters: [{ name: "Text", extensions: ["txt"] }],
      });
      if (!path) return;
      await writeTextFile(path, report);
      setStatus("Report saved.");
    } catch (error) {
      setStatus(`Couldn't save the report: ${String(error)}`);
    }
  }

  function handleClear() {
    clearLoggedErrors();
    setStatus("Recorded problems cleared.");
  }

  return (
    <div className="report-scrim" role="presentation" onClick={onClose}>
      <div
        className="report-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="report-dialog-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="report-dialog__head">
          <div>
            <h2 id="report-dialog-title">Report a problem</h2>
            <p className="report-dialog__sub">
              {errors.length === 0
                ? "Nothing has gone wrong this session, but you can still send a report."
                : `${errors.length} problem${errors.length === 1 ? "" : "s"} recorded this session.`}
            </p>
          </div>
          <button type="button" className="px-btn" onClick={onClose}>
            Close
          </button>
        </div>

        <label className="report-dialog__note">
          <span className="organizer__field-label">What were you doing?</span>
          <textarea
            value={note}
            rows={3}
            placeholder="e.g. I clicked Add version and a red message appeared."
            aria-label="What were you doing when it went wrong?"
            onChange={(event) => setNote(event.target.value)}
          />
        </label>

        <div className="report-dialog__preview">
          <span className="organizer__field-label">This is everything the report contains</span>
          <pre aria-label="Report contents">{report}</pre>
        </div>

        {status && <p className="report-dialog__status">{status}</p>}

        <div className="report-dialog__actions">
          <p className="report-dialog__privacy">
            Nothing is sent automatically. Copy or save this, then send it however you like.
          </p>
          <div className="report-dialog__buttons">
            {errors.length > 0 && (
              <button type="button" className="px-btn" onClick={handleClear}>
                Clear recorded problems
              </button>
            )}
            {isTauri() && (
              <button type="button" className="px-btn" onClick={() => void handleSave()}>
                Save as file…
              </button>
            )}
            <button type="button" className="px-btn px-btn--primary" onClick={() => void handleCopy()}>
              Copy report
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
