import { invoke } from "@tauri-apps/api/core";
import type { PlannerTask, PlannerTaskInput } from "../../types";

export function listPlannerTasks(): Promise<PlannerTask[]> {
  return invoke<PlannerTask[]>("list_planner_tasks");
}

export function createPlannerTask(input: PlannerTaskInput): Promise<PlannerTask> {
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
  return invoke<void>("delete_planner_task", { id });
}
