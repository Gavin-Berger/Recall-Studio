import { useEffect, useRef, useState } from "react";
import type { DailyPlanReminderSettings } from "../types";

export type StudioTheme = "blue" | "mono";

type SettingsDialogProps = {
  open: boolean;
  theme: StudioTheme;
  onThemeChange: (theme: StudioTheme) => void;
  dailyPlanReminder: DailyPlanReminderSettings;
  onDailyPlanReminderChange: (settings: DailyPlanReminderSettings) => Promise<boolean>;
  onSendTestReminder: () => Promise<boolean>;
  onClose: () => void;
};

const shortcuts = [
  ["Alt", "1", "Projects"],
  ["Alt", "2", "Recap"],
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
  onClose,
}: SettingsDialogProps) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const [reminderMessage, setReminderMessage] = useState<string | null>(null);
  const [testingReminder, setTestingReminder] = useState(false);

  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
  }, [open]);

  if (!open) return null;

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
