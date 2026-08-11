export type PlannerTaskType = "artist" | "mix" | "master" | "admin";

export type PlannerTask = {
  id: string;
  title: string;
  due_date: string;
  due_time: string | null;
  task_type: PlannerTaskType;
  project_id: string | null;
  notes: string | null;
  completed: boolean;
  created_at_ms: number;
  updated_at_ms: number;
};

export type PlannerTaskInput = {
  id: string;
  title: string;
  dueDate: string;
  dueTime?: string | null;
  taskType: PlannerTaskType;
  projectId?: string | null;
  notes?: string | null;
  completed?: boolean;
};

export type DailyPlanReminderSettings = {
  enabled: boolean;
  time: string;
};
