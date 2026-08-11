import { describe, expect, it } from "vitest";
import type { PlannerTask, SavedProject } from "../../types";
import { dailyPlanContent, delayUntilDailyPlan } from "./notifications";
import { calendarDays, connectedCalendarItems, connectedItemsForDate, localDateKey, moveMonth, tasksForDate } from "./planner";

const task = (overrides: Partial<PlannerTask> = {}): PlannerTask => ({
  id: "task-1",
  title: "Print mix notes",
  due_date: "2026-08-07",
  due_time: null,
  task_type: "mix",
  project_id: null,
  notes: null,
  completed: false,
  created_at_ms: 1,
  updated_at_ms: 1,
  ...overrides,
});

describe("calendarDays", () => {
  it("always provides whole Sunday-to-Saturday weeks", () => {
    const days = calendarDays(new Date(2026, 7, 1));
    expect(days).toHaveLength(42);
    expect(days[0].getDay()).toBe(0);
    expect(days.at(-1)?.getDay()).toBe(6);
    expect(days.some((day) => localDateKey(day) === "2026-08-01")).toBe(true);
  });

  it("moves across a year boundary", () => {
    expect(localDateKey(moveMonth(new Date(2026, 0, 1), -1))).toBe("2025-12-01");
  });
});

describe("tasksForDate", () => {
  it("keeps incomplete timed work ahead of completed and untimed work", () => {
    const tasks = tasksForDate(
      [
        task({ id: "done", due_time: "09:00", completed: true }),
        task({ id: "later", due_time: "16:00" }),
        task({ id: "first", due_time: "10:00" }),
        task({ id: "other-day", due_date: "2026-08-08" }),
      ],
      "2026-08-07",
    );
    expect(tasks.map((item) => item.id)).toEqual(["first", "later", "done"]);
  });
});

describe("connectedCalendarItems", () => {
  it("keeps Organizer release dates and captured project work on the same calendar without making either a task", () => {
    const capturedAt = new Date(2026, 7, 7, 18, 24).getTime();
    const items = connectedCalendarItems(
      [
        { id: "release-1", name: "Night fall", artist: "Gberg", releaseDate: "2026-08-07", releaseType: "single" },
        { id: "invalid", name: "Skip me", artist: "", releaseDate: "2026-02-31", releaseType: "album" },
      ],
      [{
        id: "project-1",
        display_name: "Night fall",
        captures: [{
          id: "capture-1",
          capture_name: "Final vocal pass",
          creative_event_count: 23,
          last_updated_at_ms: capturedAt,
        }],
      } as SavedProject],
    );

    expect(items).toMatchObject([
      { id: "release:release-1", date: "2026-08-07", kind: "release", title: "Night fall", detail: "Single · Gberg" },
      { id: "capture:capture-1", date: "2026-08-07", kind: "capture", title: "Night fall", detail: "23 moves · Final vocal pass" },
    ]);
    expect(connectedItemsForDate(items, "2026-08-07").map((item) => item.kind)).toEqual(["release", "capture"]);
  });

  it("does not turn empty or zero-move captures into calendar noise", () => {
    const items = connectedCalendarItems([], [{
      id: "project-1",
      display_name: "Quiet project",
      captures: [{ id: "capture-1", creative_event_count: 0, last_updated_at_ms: Date.now() }],
    } as SavedProject]);

    expect(items).toEqual([]);
  });
});

describe("daily plan reminders", () => {
  it("summarizes only unfinished tasks and releases that are due today", () => {
    expect(dailyPlanContent(
      [
        task({ title: "Print mix notes" }),
        task({ title: "Send master", completed: true }),
        task({ title: "Tomorrow", due_date: "2026-08-08" }),
      ],
      [{ name: "Night fall", releaseDate: "2026-08-07" }],
      "2026-08-07",
    )).toEqual({
      title: "Today’s studio plan",
      body: "1 task: Print mix notes  •  Release: Night fall",
    });
  });

  it("schedules the next reminder without a repeating interval", () => {
    const before = new Date(2026, 7, 7, 8, 30);
    const after = new Date(2026, 7, 7, 9, 30);
    expect(delayUntilDailyPlan(before, "09:00")).toBe(30 * 60 * 1000);
    expect(delayUntilDailyPlan(after, "09:00")).toBe(23.5 * 60 * 60 * 1000);
  });
});
