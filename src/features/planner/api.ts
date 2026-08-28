import { invoke, isTauri } from "@tauri-apps/api/core";
import type { PlannerTask, PlannerTaskInput } from "../../types";

// The browser preview is a supported way to inspect the app, but it has no
// Tauri command bridge. Keeping a small local planner there makes the surface
// useful instead of rendering a technical error over an otherwise calm page.
const PREVIEW_TASKS_KEY = "recall-studio.planner-preview-tasks";

function previewTasks(): PlannerTask[] {
  try {
    const stored = window.localStorage.getItem(PREVIEW_TASKS_KEY);
    const parsed: unknown = stored ? JSON.parse(stored) : [];
    return Array.isArray(parsed) ? parsed as PlannerTask[] : [];
  } catch {
    return [];
  }
}

function storePreviewTasks(tasks: PlannerTask[]) {
  try {
    window.localStorage.setItem(PREVIEW_TASKS_KEY, JSON.stringify(tasks));
  } catch {
    // Preview storage is a convenience, never a reason to block a task edit.
  }
}

function previewTask(input: PlannerTaskInput, existing?: PlannerTask): PlannerTask {
  const now = Date.now();
  return {
    id: input.id,
    title: input.title,
    due_date: input.dueDate,
    due_time: input.dueTime ?? null,
    task_type: input.taskType,
    project_id: input.projectId ?? null,
    notes: input.notes ?? null,
    completed: input.completed ?? existing?.completed ?? false,
    created_at_ms: existing?.created_at_ms ?? now,
    updated_at_ms: now,
  };
}

export function listPlannerTasks(): Promise<PlannerTask[]> {
  if (!isTauri()) return Promise.resolve(previewTasks());
  return invoke<PlannerTask[]>("list_planner_tasks");
}

export function createPlannerTask(input: PlannerTaskInput): Promise<PlannerTask> {
  if (!isTauri()) {
    const task = previewTask(input);
    storePreviewTasks([...previewTasks(), task]);
    return Promise.resolve(task);
  }
  return invoke<PlannerTask>("create_planner_task", {
    id: input.id,
    title: input.title,
    dueDate: input.dueDate,
    dueTime: input.dueTime ?? null,
    taskType: input.taskType,
    projectId: input.projectId ?? null,
    notes: input.notes ?? null,
  });
}

export function updatePlannerTask(input: PlannerTaskInput): Promise<PlannerTask> {
  if (!isTauri()) {
    const tasks = previewTasks();
    const existing = tasks.find((task) => task.id === input.id);
    const task = previewTask(input, existing);
    storePreviewTasks(tasks.map((current) => current.id === task.id ? task : current));
    return Promise.resolve(task);
  }
  return invoke<PlannerTask>("update_planner_task", {
    id: input.id,
    title: input.title,
    dueDate: input.dueDate,
    dueTime: input.dueTime ?? null,
    taskType: input.taskType,
    projectId: input.projectId ?? null,
    notes: input.notes ?? null,
    completed: input.completed ?? false,
  });
}

export function deletePlannerTask(id: string): Promise<void> {
  if (!isTauri()) {
    storePreviewTasks(previewTasks().filter((task) => task.id !== id));
    return Promise.resolve();
  }
  return invoke<void>("delete_planner_task", { id });
}
