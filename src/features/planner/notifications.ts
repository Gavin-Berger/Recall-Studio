import { invoke, isTauri } from "@tauri-apps/api/core";
import type { DailyPlanReminderSettings, PlannerTask } from "../../types";
import type { NativeProject } from "../organizer/repository";

export const DAILY_PLAN_REMINDER_STORAGE_KEY = "recall-studio.daily-plan-reminder";

export const DEFAULT_DAILY_PLAN_REMINDER: DailyPlanReminderSettings = {
  enabled: false,
  time: "09:00",
};

type DailyPlanContent = {
  title: string;
  body: string;
};

function shortList(names: string[], extraLabel: string): string {
  const visible = names.slice(0, 2);
  const extra = names.length - visible.length;
  return `${visible.join(" · ")}${extra > 0 ? ` · +${extra} ${extraLabel}` : ""}`;
}

export function dailyPlanContent(
  tasks: PlannerTask[],
  releases: Array<Pick<NativeProject, "name" | "releaseDate">>,
  dateKey: string,
): DailyPlanContent {
  const dueTasks = tasks.filter((task) => !task.completed && task.due_date === dateKey);
  const dueReleases = releases.filter((project) => project.releaseDate === dateKey && project.name.trim());
  const sections: string[] = [];

  if (dueTasks.length) {
    sections.push(`${dueTasks.length} ${dueTasks.length === 1 ? "task" : "tasks"}: ${shortList(dueTasks.map((task) => task.title), "more")}`);
  }
  if (dueReleases.length) {
    sections.push(`${dueReleases.length === 1 ? "Release" : "Releases"}: ${shortList(dueReleases.map((project) => project.name.trim()), "more")}`);
  }

  return {
    title: sections.length ? "Today’s studio plan" : "Your studio plan is clear",
    body: sections.length ? sections.join("  •  ") : "No scheduled tasks or releases for today.",
  };
}

export function delayUntilDailyPlan(now: Date, time: string): number {
  const [hours, minutes] = time.split(":").map(Number);
  const next = new Date(now);
  next.setHours(
    Number.isInteger(hours) && hours >= 0 && hours <= 23 ? hours : 9,
    Number.isInteger(minutes) && minutes >= 0 && minutes <= 59 ? minutes : 0,
    0,
    0,
  );
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

export function loadDailyPlanReminder(): DailyPlanReminderSettings {
  try {
    const saved = window.localStorage.getItem(DAILY_PLAN_REMINDER_STORAGE_KEY);
    if (!saved) return DEFAULT_DAILY_PLAN_REMINDER;
    const parsed = JSON.parse(saved) as Partial<DailyPlanReminderSettings>;
    const savedTime = parsed.time;
    const validTime = typeof savedTime === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(savedTime);
    return {
      enabled: parsed.enabled === true,
      time: validTime ? savedTime : DEFAULT_DAILY_PLAN_REMINDER.time,
    };
  } catch {
    return DEFAULT_DAILY_PLAN_REMINDER;
  }
}

export function storeDailyPlanReminder(settings: DailyPlanReminderSettings) {
  try {
    window.localStorage.setItem(DAILY_PLAN_REMINDER_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // The reminder remains active for this session even when storage is unavailable.
  }
}

async function notificationApi() {
  return import("@tauri-apps/plugin-notification");
}

export async function requestDailyPlanPermission(): Promise<boolean> {
  if (!isTauri()) return false;
  const { isPermissionGranted, requestPermission } = await notificationApi();
  return (await isPermissionGranted()) || (await requestPermission()) === "granted";
}

export async function sendDailyPlanNotification(content: DailyPlanContent): Promise<boolean> {
  return sendDesktopNotification(content, "the daily studio plan");
}

/**
 * One desktop notification path for the whole app.
 *
 * `what` names the caller for the console when it fails, so a silent
 * notification failure can be told apart from a notification nobody sent.
 */
export async function sendDesktopNotification(
  content: { title: string; body: string },
  what: string,
): Promise<boolean> {
  if (!isTauri()) return false;
  try {
    await invoke("send_desktop_notification", content);
    return true;
  } catch (error) {
    console.error(`Failed to send ${what} notification:`, error);
    return false;
  }
}

/**
 * Notifications are opt-in, and the permission prompt is the opt-in. Shared
 * with the daily plan because the OS grants Recall one permission, not one per
 * feature — asking twice would look like the first answer was not heard.
 */
export async function requestNotificationPermission(): Promise<boolean> {
  return requestDailyPlanPermission();
}
