import { describe, expect, it } from "vitest";
import {
  REMINDER_COOLDOWN_MS,
  saveReminder,
  STILL_WORKING_MS,
  UNSAVED_WORK_MS,
  type SaveReminderInputs,
} from "./saveReminder";

const now = 1_720_000_000_000;
const minute = 60_000;

function inputs(over: Partial<SaveReminderInputs> = {}): SaveReminderInputs {
  return {
    nowMs: now,
    lastSaveMs: now - 30 * minute,
    lastActivityMs: now - minute,
    captureStartedMs: now - 90 * minute,
    lastRemindedMs: null,
    setName: "Night EP v3",
    ...over,
  };
}

describe("saveReminder", () => {
  it("nudges after a long unsaved stretch that is still being worked on", () => {
    const reminder = saveReminder(inputs());

    expect(reminder).not.toBeNull();
    expect(reminder!.title).toBe("Worth saving");
    expect(reminder!.body).toContain("30 minutes");
    expect(reminder!.body).toContain("Night EP v3");
  });

  it("says nothing when the producer has walked away", () => {
    // The cost of a missed nudge is one more in twenty minutes. The cost of
    // firing at an empty room is that the producer learns to ignore it.
    expect(
      saveReminder(inputs({ lastActivityMs: now - STILL_WORKING_MS - minute })),
    ).toBeNull();
  });

  it("says nothing when nothing has happened since the last save", () => {
    // The set is already written. There is no unsaved work to protect.
    expect(
      saveReminder(inputs({ lastSaveMs: now - minute, lastActivityMs: now - 2 * minute })),
    ).toBeNull();
  });

  it("says nothing before the stretch is long enough to interrupt for", () => {
    expect(
      saveReminder(inputs({ lastSaveMs: now - (UNSAVED_WORK_MS - minute) })),
    ).toBeNull();
  });

  it("does not repeat itself for the same unsaved stretch", () => {
    const since = now - 30 * minute;
    expect(
      saveReminder(inputs({ lastSaveMs: since, lastRemindedMs: now - minute })),
    ).toBeNull();
  });

  it("nudges again once the cooldown has passed and the work is still unsaved", () => {
    const since = now - 90 * minute;
    const reminder = saveReminder(
      inputs({ lastSaveMs: since, lastRemindedMs: now - REMINDER_COOLDOWN_MS - minute }),
    );

    expect(reminder).not.toBeNull();
  });

  it("reminds again immediately after a save that started a NEW unsaved stretch", () => {
    // Reminded at 10:00, saved at 10:05, worked another half hour. The old
    // reminder was about work that is now on disk; this is different work.
    const reminder = saveReminder({
      nowMs: now,
      lastSaveMs: now - 25 * minute,
      lastActivityMs: now - minute,
      captureStartedMs: now - 5 * 60 * minute,
      lastRemindedMs: now - 40 * minute,
      setName: "Night EP v3",
    });

    expect(reminder).not.toBeNull();
    expect(reminder!.unsavedSinceMs).toBe(now - 25 * minute);
  });

  it("measures from the capture when Recall has never watched a save", () => {
    // A set open since before capture started. Recall must not claim work is
    // unsaved from before it was watching.
    const reminder = saveReminder(
      inputs({ lastSaveMs: null, captureStartedMs: now - 45 * minute }),
    );

    expect(reminder).not.toBeNull();
    expect(reminder!.body).toContain("has not seen a save");
    expect(reminder!.unsavedSinceMs).toBe(now - 45 * minute);
  });

  it("says nothing when there is no capture at all", () => {
    expect(saveReminder(inputs({ lastActivityMs: null }))).toBeNull();
    expect(
      saveReminder(inputs({ lastSaveMs: null, captureStartedMs: null })),
    ).toBeNull();
  });
});
