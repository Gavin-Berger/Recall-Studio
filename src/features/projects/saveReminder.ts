// Nudging a producer to save, without becoming the thing they mute.
//
// Recall watches saves already: the control surface polls the open `.als`'s
// modification stamp and emits `project_saved` (Live exposes no save callback).
// That means Recall knows something the producer does not while they are deep
// in a set — how long the work in front of them has been sitting unwritten.
//
// A save is also the act that creates a version, so an unsaved hour is not only
// risk, it is an hour the version graph cannot attribute to anything.
//
// WHAT THIS REFUSES TO DO
//
// A reminder that fires while nothing is happening is an alarm clock, and one
// that fires twice for the same stretch of work is noise. Both make the producer
// turn the feature off, at which point it protects nobody. So the rule needs
// every one of these to be true, and says so in one place rather than being
// spread across a component:
//
//   1. Work has actually happened since the last save. Otherwise nothing is
//      unsaved and there is nothing to protect.
//   2. That work is RECENT. A producer who left the room an hour ago does not
//      need a notification; they need to be left alone.
//   3. Enough time has passed to be worth interrupting for.
//   4. They have not just been told.

/** Unsaved work is worth mentioning after this long. */
export const UNSAVED_WORK_MS = 20 * 60 * 1000;

/**
 * How recently work must have landed for the producer to still be at the desk.
 *
 * Deliberately short. The cost of missing a reminder is one more nudge twenty
 * minutes later; the cost of firing at someone who walked away is that they
 * learn the notification is not about them.
 */
export const STILL_WORKING_MS = 5 * 60 * 1000;

/** Never remind about the same unsaved stretch twice inside this window. */
export const REMINDER_COOLDOWN_MS = 20 * 60 * 1000;

export type SaveReminderInputs = {
  nowMs: number;
  /**
   * The last save Recall watched on the open set, or null when it has never
   * seen one — a set open since before capture started, or a brand-new set that
   * has never been written to disk.
   */
  lastSaveMs: number | null;
  /** When the active capture last recorded producer work. */
  lastActivityMs: number | null;
  /** When the active capture began, which bounds "since" when nothing is saved. */
  captureStartedMs: number | null;
  /** When this reminder last fired, so it does not repeat. */
  lastRemindedMs: number | null;
  /** The set's name, for the notification body. */
  setName: string | null;
};

export type SaveReminder = {
  title: string;
  body: string;
  /** The moment the unsaved stretch is measured from. Callers store it. */
  unsavedSinceMs: number;
};

function minutes(ms: number): number {
  return Math.floor(ms / 60_000);
}

/**
 * Should the producer be nudged to save right now?
 *
 * Pure: the caller supplies the clock and the last-reminded stamp, so the rule
 * can be tested without timers and without a backend.
 */
export function saveReminder(inputs: SaveReminderInputs): SaveReminder | null {
  const { nowMs, lastSaveMs, lastActivityMs, captureStartedMs, lastRemindedMs, setName } = inputs;

  // No capture, no work, nothing to protect.
  if (lastActivityMs === null) return null;

  // (2) Still at the desk. Checked before anything else because it is the one
  // condition whose failure means "say nothing", not "say it later".
  if (nowMs - lastActivityMs > STILL_WORKING_MS) return null;

  // Where the unsaved stretch starts. With no save ever seen, the capture's own
  // start is the honest floor — Recall cannot claim work is unsaved from before
  // it was watching.
  const since = lastSaveMs ?? captureStartedMs;
  if (since === null) return null;

  // (1) Work has to have landed AFTER that point, or the set is already written.
  if (lastActivityMs <= since) return null;

  // (3) Long enough to be worth an interruption.
  const unsavedFor = nowMs - since;
  if (unsavedFor < UNSAVED_WORK_MS) return null;

  // (4) And they have not just been told about this same stretch.
  if (lastRemindedMs !== null && lastRemindedMs >= since) {
    if (nowMs - lastRemindedMs < REMINDER_COOLDOWN_MS) return null;
  }

  const where = setName?.trim();
  return {
    title: "Worth saving",
    body: lastSaveMs
      ? `${minutes(unsavedFor)} minutes of work since you last saved${where ? ` ${where}` : ""}.`
      : `${minutes(unsavedFor)} minutes of work and Recall has not seen a save${where ? ` in ${where}` : ""} yet.`,
    unsavedSinceMs: since,
  };
}

export const SAVE_REMINDER_STORAGE_KEY = "recall-studio.save-reminder";

/**
 * Off by default, like every notification in the app.
 *
 * A producer who did not ask for an interruption and gets one learns to
 * distrust the whole feature, and the first thing they will mute is the
 * reminder that was trying to protect their work.
 */
export function loadSaveReminderEnabled(): boolean {
  try {
    return window.localStorage.getItem(SAVE_REMINDER_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

export function storeSaveReminderEnabled(enabled: boolean) {
  try {
    window.localStorage.setItem(SAVE_REMINDER_STORAGE_KEY, String(enabled));
  } catch {
    // Stays on for this session even when storage is unavailable.
  }
}
