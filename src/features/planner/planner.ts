import type { SavedProject, PlannerTask, PlannerTaskType } from "../../types";
import type { NativeProject } from "../organizer/repository";

export const TASK_TYPE_LABEL: Record<PlannerTaskType, string> = {
  artist: "Artist work",
  mix: "Mixing",
  master: "Mastering",
  admin: "Studio admin",
};

export function localDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function dateFromKey(key: string): Date {
  const [year, month, day] = key.split("-").map(Number);
  return new Date(year, month - 1, day);
}

export function monthStart(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

export function moveMonth(date: Date, amount: number): Date {
  return new Date(date.getFullYear(), date.getMonth() + amount, 1);
}

export function calendarDays(month: Date): Date[] {
  const start = monthStart(month);
  const leading = start.getDay();
  const first = new Date(start.getFullYear(), start.getMonth(), 1 - leading);
  return Array.from({ length: 42 }, (_, index) =>
    new Date(first.getFullYear(), first.getMonth(), first.getDate() + index),
  );
}

export function tasksForDate(tasks: PlannerTask[], dateKey: string): PlannerTask[] {
  return tasks
    .filter((task) => task.due_date === dateKey)
    .sort(
      (left, right) =>
        Number(left.completed) - Number(right.completed) ||
        (left.due_time ?? "99:99").localeCompare(right.due_time ?? "99:99") ||
        left.created_at_ms - right.created_at_ms,
    );
}

export function formatPlannerDate(key: string, options?: Intl.DateTimeFormatOptions): string {
  return dateFromKey(key).toLocaleDateString(
    undefined,
    options ?? { weekday: "long", month: "long", day: "numeric" },
  );
}

export function isPastDue(task: PlannerTask, today: string): boolean {
  return !task.completed && task.due_date < today;
}

// Planner tasks are things the producer chooses to schedule. Connected entries
// are deliberately read-only: they reflect an Organizer release date or a take
// Recall actually captured, without duplicating either source of truth.
export type ConnectedCalendarItem = {
  id: string;
  date: string;
  kind: "release" | "capture";
  title: string;
  detail: string;
  timestamp_ms: number | null;
  organizer_project_id?: string;
  session_id?: string;
};

function validDateKey(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = dateFromKey(value);
  return localDateKey(date) === value ? value : null;
}

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

export function connectedCalendarItems(
  organizerProjects: Array<Pick<NativeProject, "id" | "name" | "artist" | "releaseDate" | "releaseType">>,
  projects: SavedProject[],
): ConnectedCalendarItem[] {
  const releases = organizerProjects.flatMap((project): ConnectedCalendarItem[] => {
    const date = validDateKey(project.releaseDate.trim());
    if (!date) return [];
    const artist = project.artist.trim();
    const type = project.releaseType === "ep" ? "EP" : project.releaseType === "single" ? "Single" : "Album";
    return [{
      id: `release:${project.id}`,
      date,
      kind: "release",
      title: project.name.trim() || "Untitled release",
      detail: [type, artist].filter(Boolean).join(" · "),
      timestamp_ms: null,
      organizer_project_id: project.id,
    }];
  });

  const captures = projects.flatMap((project): ConnectedCalendarItem[] =>
    project.captures.flatMap((capture) => {
      if (capture.creative_event_count <= 0 || !Number.isFinite(capture.last_updated_at_ms) || capture.last_updated_at_ms <= 0) {
        return [];
      }
      const captureName = capture.capture_name?.trim();
      return [{
        id: `capture:${capture.id}`,
        date: localDateKey(new Date(capture.last_updated_at_ms)),
        kind: "capture",
        title: project.display_name,
        detail: `${pluralize(capture.creative_event_count, "move")}${captureName ? ` · ${captureName}` : ""}`,
        timestamp_ms: capture.last_updated_at_ms,
        session_id: capture.id,
      }];
    }),
  );

  return [...releases, ...captures].sort(
    (left, right) =>
      left.date.localeCompare(right.date) ||
      (left.kind === right.kind ? 0 : left.kind === "release" ? -1 : 1) ||
      (right.timestamp_ms ?? 0) - (left.timestamp_ms ?? 0) ||
      left.title.localeCompare(right.title),
  );
}

export function connectedItemsForDate(items: ConnectedCalendarItem[], dateKey: string): ConnectedCalendarItem[] {
  return items.filter((item) => item.date === dateKey);
}
