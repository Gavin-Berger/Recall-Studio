import { useEffect, useRef, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import type { DailyPlanReminderSettings } from "../types";
import type { ConnectionStatus } from "../types/recall";
import { versionRows, versionVerdict, type VersionFacts } from "../features/setup/versionStatus";

export type StudioTheme = "blue" | "mono";

type SettingsDialogProps = {
  open: boolean;
  theme: StudioTheme;
  onThemeChange: (theme: StudioTheme) => void;
  dailyPlanReminder: DailyPlanReminderSettings;
  onDailyPlanReminderChange: (settings: DailyPlanReminderSettings) => Promise<boolean>;
  onSendTestReminder: () => Promise<boolean>;
  connection: ConnectionStatus;
  onClose: () => void;
};

/** Mirrors install.rs::InstallDetection — the same shape BridgeSetup reads. */
type InstallDetection = {
  candidates: { path: string; exists: boolean }[];
  recommended: string | null;
  script_version: string | null;
};

/** The one field of metrics.rs::BridgeMetricsSnapshot this panel needs. */
type BridgeMetricsSnapshot = {
  capture_port_conflict: boolean;
};

const shortcuts = [
  ["Alt", "1", "Projects"],
  ["Alt", "2", "Report"],
  ["Alt", "3", "Timeline"],
  ["Alt", "4", "Organizer"],
  ["Alt", "5", "Planner"],
  ["Alt", "6", "Notes"],
  ["Alt", "7", "Reference"],
  ["Ctrl", ",", "Settings"],
];

export function SettingsDialog({
  open,
  theme,
  onThemeChange,
  dailyPlanReminder,
  onDailyPlanReminderChange,
  onSendTestReminder,
  connection,
  onClose,
}: SettingsDialogProps) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const [reminderMessage, setReminderMessage] = useState<string | null>(null);
  const [testingReminder, setTestingReminder] = useState(false);
  const [appVersion, setAppVersion] = useState<string | null>(null);
  const [detection, setDetection] = useState<InstallDetection | null>(null);
  const [portConflict, setPortConflict] = useState(false);

  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
  }, [open]);

  // Read the build's own version and where the script is installed, each time the
  // dialog opens rather than once at mount: the whole point of this panel is to
  // be checked right after an install, and a value cached from app start would be
  // the one thing guaranteed to be stale. `cancelled` guards a dialog closed
  // before either read lands.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;

    getVersion()
      .then((version) => {
        if (!cancelled) setAppVersion(version);
      })
      .catch(() => {
        // A version we cannot read renders as "unknown", which is honest. It must
        // never take the rest of the panel down with it.
        if (!cancelled) setAppVersion(null);
      });

    invoke<InstallDetection>("detect_bridge_install_targets")
      .then((result) => {
        if (!cancelled) setDetection(result);
      })
      .catch(() => {
        if (!cancelled) setDetection(null);
      });

    // Whether THIS process lost the race for the capture port. Sticky in the
    // backend (the listener binds once at startup), so one read per open is
    // enough — it cannot change while the app is running.
    invoke<BridgeMetricsSnapshot>("get_bridge_metrics")
      .then((metrics) => {
        if (!cancelled) setPortConflict(metrics.capture_port_conflict);
      })
      .catch(() => {
        // Can't prove a conflict, so don't claim one. The panel falls back to
        // the ordinary connection verdicts, which is the pre-existing behaviour.
        if (!cancelled) setPortConflict(false);
      });

    return () => {
      cancelled = true;
    };
  }, [open]);

  if (!open) return null;

  const versionFacts: VersionFacts = {
    appVersion,
    shippedScriptVersion: detection?.script_version ?? null,
    runningScriptVersion: connection.bridge_version,
    connected: connection.connected,
    installPath:
      detection?.recommended ??
      detection?.candidates.find((candidate) => candidate.exists)?.path ??
      null,
    capturePortConflict: portConflict,
  };

  async function handleReminderToggle(enabled: boolean) {
    const applied = await onDailyPlanReminderChange({ ...dailyPlanReminder, enabled });
    setReminderMessage(
      applied
        ? enabled
          ? "Daily studio plan is on."
          : "Daily studio plan is off."
        : "Windows notifications are unavailable or were not allowed.",
    );
  }

  async function handleTestReminder() {
    setTestingReminder(true);
    const sent = await onSendTestReminder();
    setTestingReminder(false);
    setReminderMessage(sent ? "Test notification sent." : "Windows notifications are unavailable or were not allowed.");
  }

  return (
    <div
      className="settings-dialog__backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section className="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <header className="settings-dialog__head">
          <div>
            <span className="eyebrow">Personal settings</span>
            <h2 id="settings-title">Make Recall feel right</h2>
            <p>These preferences stay on this computer and never change your project files.</p>
          </div>
          <button
            ref={closeRef}
            type="button"
            className="settings-dialog__close"
            aria-label="Close settings"
            title="Close settings · Esc"
            onClick={onClose}
          >
            <CloseIcon />
          </button>
        </header>

        <div className="settings-dialog__body">
          <section aria-labelledby="appearance-title">
            <div className="settings-dialog__section-head">
              <div>
                <h3 id="appearance-title">Appearance</h3>
                <p>Choose the amount of color you want around your work.</p>
              </div>
            </div>
            <div className="settings-dialog__themes" role="radiogroup" aria-label="Color theme">
              <button
                type="button"
                role="radio"
                aria-checked={theme === "blue"}
                className={`settings-dialog__theme ${theme === "blue" ? "is-selected" : ""}`}
                onClick={() => onThemeChange("blue")}
              >
                <span className="settings-dialog__swatch settings-dialog__swatch--blue" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </span>
                <span>
                  <strong>Recall blue</strong>
                  <small>Blue focus and active states.</small>
                </span>
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={theme === "mono"}
                className={`settings-dialog__theme ${theme === "mono" ? "is-selected" : ""}`}
                onClick={() => onThemeChange("mono")}
              >
                <span className="settings-dialog__swatch settings-dialog__swatch--mono" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </span>
                <span>
                  <strong>Monochrome dark</strong>
                  <small>Neutral UI accents for a quieter desk.</small>
                </span>
              </button>
            </div>
          </section>

          {/* Second, not last. This is the panel a producer opens Settings to
              CHECK — "did the build I just made actually reach Ableton" — and the
              dialog scrolls (max-height 80vh). Sitting at the bottom meant the one
              section with a job to do was the only one you had to hunt for. */}
          <section aria-labelledby="versions-title">
            <div className="settings-dialog__section-head">
              <div>
                <h3 id="versions-title">What's running</h3>
                <p>
                  Three things have to agree before a change reaches your timeline: Recall, the
                  script it ships, and the script Ableton actually loaded.
                </p>
              </div>
            </div>
            <VersionPanel facts={versionFacts} />
          </section>

          <section aria-labelledby="notifications-title">
            <div className="settings-dialog__section-head">
              <div>
                <h3 id="notifications-title">Daily studio plan</h3>
                <p>Get one Windows notification with today’s unfinished tasks and release dates.</p>
              </div>
            </div>
            <div className="settings-dialog__reminder">
              <label className="settings-dialog__reminder-toggle">
                <span className="settings-dialog__reminder-icon" aria-hidden="true"><BellIcon /></span>
                <span>
                  <strong>Daily reminder</strong>
                  <small>At your chosen local time.</small>
                </span>
                <input
                  type="checkbox"
                  checked={dailyPlanReminder.enabled}
                  onChange={(event) => void handleReminderToggle(event.target.checked)}
                  aria-label="Enable daily studio plan reminder"
                />
              </label>
              <div className="settings-dialog__reminder-controls">
                <label>
                  <span>Reminder time</span>
                  <input
                    type="time"
                    value={dailyPlanReminder.time}
                    disabled={!dailyPlanReminder.enabled}
                    onChange={(event) => {
                      setReminderMessage(null);
                      void onDailyPlanReminderChange({ ...dailyPlanReminder, time: event.target.value });
                    }}
                  />
                </label>
                <button
                  type="button"
                  className="settings-dialog__test-reminder"
                  disabled={!dailyPlanReminder.enabled || testingReminder}
                  onClick={() => void handleTestReminder()}
                >
                  {testingReminder ? "Sending…" : "Send test"}
                </button>
              </div>
              <p className="settings-dialog__background-note">
                Closing Recall keeps it in the system tray. Use <strong>Quit Recall</strong> in that tray menu to fully stop background reminders.
              </p>
              {reminderMessage ? <p className="settings-dialog__reminder-message" role="status">{reminderMessage}</p> : null}
            </div>
          </section>

          <section aria-labelledby="shortcuts-title">
            <div className="settings-dialog__section-head">
              <div>
                <h3 id="shortcuts-title">Move around faster</h3>
                <p>Navigation is always one click away in the sidebar; these shortcuts make switching immediate.</p>
              </div>
            </div>
            <ul className="settings-dialog__shortcuts">
              {shortcuts.map(([modifier, key, label]) => (
                <li key={label}>
                  <span>{label}</span>
                  <span aria-label={`${modifier} ${key}`}>
                    <kbd>{modifier}</kbd>
                    <kbd>{key}</kbd>
                  </span>
                </li>
              ))}
            </ul>
          </section>

        </div>
      </section>
    </div>
  );
}

/**
 * The version rows plus the one-line verdict.
 *
 * The verdict comes last in the markup on purpose: the rows are the evidence, and
 * a producer who already knows what they are looking at can read the numbers and
 * skip the sentence entirely.
 */
function VersionPanel({ facts }: { facts: VersionFacts }) {
  const verdict = versionVerdict(facts);
  const rows = versionRows(facts);

  return (
    <div className="settings-versions">
      <dl className="settings-versions__rows">
        {rows.map((row) => (
          <div
            key={row.label}
            className={`settings-versions__row ${row.mismatch ? "is-mismatch" : ""}`}
          >
            <dt>{row.label}</dt>
            <dd title={row.value ?? undefined}>
              {row.value ?? <span className="settings-versions__unknown">unknown</span>}
            </dd>
          </div>
        ))}
      </dl>
      <div
        className={`settings-versions__verdict settings-versions__verdict--${verdict.tone}`}
        role="status"
      >
        <strong>{verdict.title}</strong>
        <p>{verdict.detail}</p>
      </div>
    </div>
  );
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
      <path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function BellIcon() {
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M18 10a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 22h4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
