import { useEffect, useMemo, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import type { PlannerTask, PlannerTaskInput, PlannerTaskType, SavedProject } from "../../types";
import { organizerRepository, type NativeProject } from "../organizer/repository";
import { createPlannerTask, deletePlannerTask, listPlannerTasks, updatePlannerTask } from "./api";
import { LoadingSpinner } from "../../components/LoadingSpinner";
import {
  calendarDays,
  connectedCalendarItems,
  connectedItemsForDate,
  formatPlannerDate,
  isPastDue,
  localDateKey,
  monthStart,
  moveMonth,
  TASK_TYPE_LABEL,
  tasksForDate,
} from "./planner";
import "./PlannerScreen.css";

type TaskForm = {
  title: string;
  dueDate: string;
  dueTime: string;
  taskType: PlannerTaskType;
  projectId: string;
  notes: string;
};

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function blankForm(dueDate: string): TaskForm {
  return {
    title: "",
    dueDate,
    dueTime: "",
    taskType: "artist",
    projectId: "",
    notes: "",
  };
}

function taskForm(task: PlannerTask): TaskForm {
  return {
    title: task.title,
    dueDate: task.due_date,
    dueTime: task.due_time ?? "",
    taskType: task.task_type,
    projectId: task.project_id ?? "",
    notes: task.notes ?? "",
  };
}

function CalendarIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <rect x="3.5" y="5" width="17" height="15" rx="2.5" />
      <path d="M7.5 3v4M16.5 3v4M3.5 9h17" />
      <path d="M8 13h.01M12 13h.01M16 13h.01M8 16.5h.01M12 16.5h.01" strokeLinecap="round" strokeWidth="2.4" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="m5 12 4.2 4L19 6.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M12 5v14M5 12h14" strokeLinecap="round" />
    </svg>
  );
}

function PencilIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="m4 16.5-.8 4.3 4.3-.8L18.8 8.7 15.3 5.2 4 16.5Z" strokeLinejoin="round" />
      <path d="m13.9 6.6 3.5 3.5M19.9 7.6l.7-.7a2.45 2.45 0 0 0-3.5-3.5l-.7.7" strokeLinecap="round" />
    </svg>
  );
}

function MoreIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true">
      <circle cx="5" cy="12" r="1.6" />
      <circle cx="12" cy="12" r="1.6" />
      <circle cx="19" cy="12" r="1.6" />
    </svg>
  );
}

function ArrowIcon({ direction }: { direction: "previous" | "next" }) {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.9" aria-hidden="true">
      <path d={direction === "previous" ? "m14.5 5-7 7 7 7" : "m9.5 5 7 7-7 7"} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ReleaseIcon() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M12 3.5 14.6 9l5.9.8-4.3 4.1 1 5.8-5.2-2.8-5.2 2.8 1-5.8-4.3-4.1 5.9-.8L12 3.5Z" strokeLinejoin="round" />
    </svg>
  );
}

function CaptureIcon() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="12" cy="12" r="2.6" />
      <path d="M4 8.5h3M17 8.5h3M4 15.5h3M17 15.5h3" strokeLinecap="round" />
    </svg>
  );
}

type PlannerScreenProps = {
  projects: SavedProject[];
  onOpenOrganizer: () => void;
  onOpenTimeline: (sessionId: string) => void;
};

export function PlannerScreen({ projects, onOpenOrganizer, onOpenTimeline }: PlannerScreenProps) {
  const today = localDateKey(new Date());
  const [visibleMonth, setVisibleMonth] = useState(() => monthStart(new Date()));
  const [selectedDate, setSelectedDate] = useState(today);
  const [tasks, setTasks] = useState<PlannerTask[]>([]);
  const [organizerProjects, setOrganizerProjects] = useState<NativeProject[]>([]);
  const [form, setForm] = useState<TaskForm>(() => blankForm(today));
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [openTaskMenuId, setOpenTaskMenuId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const projectNames = useMemo(
    () => new Map(projects.map((project) => [project.id, project.display_name])),
    [projects],
  );
  const connectedItems = useMemo(
    () => connectedCalendarItems(organizerProjects, projects),
    [organizerProjects, projects],
  );
  const days = useMemo(() => calendarDays(visibleMonth), [visibleMonth]);
  const selectedTasks = useMemo(() => tasksForDate(tasks, selectedDate), [tasks, selectedDate]);
  const selectedConnectedItems = useMemo(
    () => connectedItemsForDate(connectedItems, selectedDate),
    [connectedItems, selectedDate],
  );
  const dayTitle = formatPlannerDate(selectedDate);
  const todayTasks = useMemo(() => tasksForDate(tasks, today).filter((task) => !task.completed), [tasks, today]);
  const nextSevenDays = useMemo(() => {
    const end = new Date();
    end.setDate(end.getDate() + 7);
    const endKey = localDateKey(end);
    return tasks.filter((task) => !task.completed && task.due_date >= today && task.due_date <= endKey).length;
  }, [tasks, today]);
  const completedCount = useMemo(() => tasks.filter((task) => task.completed).length, [tasks]);
  const releaseCount = useMemo(
    () => connectedItems.filter((item) => item.kind === "release").length,
    [connectedItems],
  );

  useEffect(() => {
    let mounted = true;
    void listPlannerTasks()
      .then((nextTasks) => {
        if (mounted) setTasks(nextTasks);
      })
      .catch((loadError) => {
        if (mounted) setError(String(loadError));
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    function closeWithEscape(event: KeyboardEvent) {
      if (event.key === "Escape" && openTaskMenuId) {
        event.preventDefault();
        setOpenTaskMenuId(null);
        return;
      }
      if (event.key === "Escape" && editorOpen) {
        event.preventDefault();
        cancelEditing();
      }
    }
    window.addEventListener("keydown", closeWithEscape);
    return () => window.removeEventListener("keydown", closeWithEscape);
  }, [editorOpen, openTaskMenuId]);

  useEffect(() => {
    let mounted = true;
    void organizerRepository()
      .load()
      .then((nextProjects) => {
        if (mounted) setOrganizerProjects(nextProjects);
      })
      .catch((loadError) => {
        // The planner remains useful when Organizer has not been initialized
        // yet. Avoid turning an optional connection into a blocking failure.
        console.warn("Could not load Organizer release dates for Planner:", loadError);
      });
    return () => {
      mounted = false;
    };
  }, []);

  function selectDate(dateKey: string) {
    setSelectedDate(dateKey);
    if (!editingId) setForm((current) => ({ ...current, dueDate: dateKey }));
  }

  function startNewTask() {
    setEditingId(null);
    setOpenTaskMenuId(null);
    setError(null);
    setForm(blankForm(selectedDate));
    setEditorOpen(true);
  }

  function startEditing(task: PlannerTask) {
    setEditingId(task.id);
    setOpenTaskMenuId(null);
    setError(null);
    setSelectedDate(task.due_date);
    setVisibleMonth(monthStart(new Date(`${task.due_date}T12:00:00`)));
    setForm(taskForm(task));
    setEditorOpen(true);
  }

  function cancelEditing() {
    setEditingId(null);
    setError(null);
    setForm(blankForm(selectedDate));
    setEditorOpen(false);
  }

  async function saveTask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!form.title.trim()) {
      setError("Give this task a short name so it is easy to find later.");
      return;
    }
    setSaving(true);
    setError(null);
    const existing = editingId ? tasks.find((task) => task.id === editingId) ?? null : null;
    const input: PlannerTaskInput = {
      id: editingId ?? crypto.randomUUID(),
      title: form.title,
      dueDate: form.dueDate,
      dueTime: form.dueTime || null,
      taskType: form.taskType,
      projectId: form.projectId || null,
      notes: form.notes || null,
      completed: existing?.completed ?? false,
    };
    try {
      const saved = existing ? await updatePlannerTask(input) : await createPlannerTask(input);
      setTasks((current) =>
        existing
          ? current.map((task) => (task.id === saved.id ? saved : task))
          : [...current, saved],
      );
      setSelectedDate(saved.due_date);
      setVisibleMonth(monthStart(new Date(`${saved.due_date}T12:00:00`)));
      setEditingId(null);
      setForm(blankForm(saved.due_date));
      setEditorOpen(false);
    } catch (saveError) {
      setError(String(saveError));
    } finally {
      setSaving(false);
    }
  }

  async function toggleTask(task: PlannerTask) {
    setError(null);
    try {
      const saved = await updatePlannerTask({
        id: task.id,
        title: task.title,
        dueDate: task.due_date,
        dueTime: task.due_time,
        taskType: task.task_type,
        projectId: task.project_id,
        notes: task.notes,
        completed: !task.completed,
      });
      setTasks((current) => current.map((item) => (item.id === saved.id ? saved : item)));
    } catch (saveError) {
      setError(String(saveError));
    }
  }

  async function removeTask(task: PlannerTask) {
    if (!window.confirm(`Remove “${task.title}” from your plan?`)) return;
    setError(null);
    try {
      await deletePlannerTask(task.id);
      setTasks((current) => current.filter((item) => item.id !== task.id));
      setOpenTaskMenuId(null);
      if (editingId === task.id) cancelEditing();
    } catch (deleteError) {
      setError(String(deleteError));
    }
  }

  return (
    <div className="planner">
      <header className="planner__header">
        <div>
          <span className="planner__eyebrow"><CalendarIcon /> Studio planner</span>
          <h1>Make room for the work that matters.</h1>
          <p>Plan the next move, while release dates and captured work stay connected to the same studio calendar.</p>
        </div>
        <button type="button" className="planner__primary" onClick={startNewTask}>
          <PlusIcon /> Plan a task
        </button>
      </header>

      <section className="planner__summary" aria-label="Planning summary">
        <div><strong>{todayTasks.length}</strong><span>due today</span></div>
        <div><strong>{nextSevenDays}</strong><span>next 7 days</span></div>
        <div><strong>{releaseCount}</strong><span>release dates</span></div>
        <div><strong>{completedCount}</strong><span>completed</span></div>
      </section>

      {error && <div className="planner__error" role="alert">{error}</div>}

      <div className="planner__layout">
        <section className="planner__calendar-card" aria-label="Studio calendar">
          <div className="planner__calendar-head">
            <div>
              <span className="planner__section-label">Schedule</span>
              <h2>{visibleMonth.toLocaleDateString(undefined, { month: "long", year: "numeric" })}</h2>
            </div>
            <div className="planner__calendar-nav">
              <button type="button" onClick={() => setVisibleMonth((month) => moveMonth(month, -1))} aria-label="Previous month" title="Previous month"><ArrowIcon direction="previous" /></button>
              <button type="button" onClick={() => { setVisibleMonth(monthStart(new Date())); selectDate(today); }}>Today</button>
              <button type="button" onClick={() => setVisibleMonth((month) => moveMonth(month, 1))} aria-label="Next month" title="Next month"><ArrowIcon direction="next" /></button>
            </div>
          </div>

          <div className="planner__weekdays" aria-hidden="true">
            {WEEKDAYS.map((day) => <span key={day}>{day}</span>)}
          </div>
          <div className="planner__calendar-grid">
            {days.map((day) => {
              const dateKey = localDateKey(day);
              const dayTasks = tasksForDate(tasks, dateKey);
              const dayConnectedItems = connectedItemsForDate(connectedItems, dateKey);
              const visibleItems = [
                ...dayConnectedItems.map((item) => ({
                  id: item.id,
                  label: item.kind === "release" ? `Release · ${item.title}` : `Worked on · ${item.title}`,
                  className: `is-${item.kind}`,
                  onClick: () => {
                    if (item.kind === "release") onOpenOrganizer();
                    else if (item.session_id) onOpenTimeline(item.session_id);
                  },
                })),
                ...dayTasks.map((task) => ({
                  id: task.id,
                  label: task.title,
                  className: `is-${task.task_type} ${task.completed ? "is-done" : ""}`,
                  onClick: () => selectDate(dateKey),
                })),
              ];
              const inMonth = day.getMonth() === visibleMonth.getMonth();
              const selected = dateKey === selectedDate;
              const outsideDirection = !inMonth ? (day < visibleMonth ? "is-before-month" : "is-after-month") : "";
              return (
                <article
                  key={dateKey}
                  className={`planner-day ${inMonth ? "" : "is-outside"} ${outsideDirection} ${selected ? "is-selected" : ""} ${dateKey === today ? "is-today" : ""}`}
                >
                  <button
                    type="button"
                    className="planner-day__date"
                    onClick={() => selectDate(dateKey)}
                    aria-pressed={selected}
                    aria-current={dateKey === today ? "date" : undefined}
                    title={[
                      formatPlannerDate(dateKey, { month: "long", day: "numeric", year: "numeric" }),
                      dayConnectedItems.length ? `${dayConnectedItems.length} connected studio item${dayConnectedItems.length === 1 ? "" : "s"}` : "",
                      dayTasks.length ? `${dayTasks.length} task${dayTasks.length === 1 ? "" : "s"}` : "",
                    ].filter(Boolean).join(" · ")}
                  >
                    <span className="planner-day__number">{day.getDate()}</span>
                    {!inMonth && <span className="planner-day__month" aria-hidden="true">{day.toLocaleDateString(undefined, { month: "short" })}</span>}
                  </button>
                  <div className="planner-day__tasks">
                    {visibleItems.slice(0, 2).map((item) => (
                      <button key={item.id} type="button" className={`planner-day__chip ${item.className}`} onClick={item.onClick} title={item.label}>{item.label}</button>
                    ))}
                    {visibleItems.length > 2 && <span className="planner-day__more">+{visibleItems.length - 2} more</span>}
                  </div>
                </article>
              );
            })}
          </div>
        </section>

        <aside className="planner__aside">
          <section className="planner__day-card">
            <div className="planner__day-card-head">
              <div>
                <span className="planner__section-label">Day plan</span>
                <h2>{dayTitle}</h2>
              </div>
              <button type="button" className="planner__text-btn" onClick={startNewTask}>Add task</button>
            </div>
            {selectedConnectedItems.length > 0 && (
              <section className="planner__connected" aria-label="Connected studio data">
                <div className="planner__connected-head">
                  <span>Connected studio data</span>
                  <small>Auto-synced</small>
                </div>
                <ol className="planner__connected-list">
                  {selectedConnectedItems.map((item) => (
                    <li key={item.id} className={`planner-connected-item is-${item.kind}`}>
                      <span className="planner-connected-item__icon">{item.kind === "release" ? <ReleaseIcon /> : <CaptureIcon />}</span>
                      <button
                        type="button"
                        className="planner-connected-item__body"
                        onClick={() => item.kind === "release" ? onOpenOrganizer() : item.session_id && onOpenTimeline(item.session_id)}
                        title={item.kind === "release" ? "Open Organizer" : "Open captured timeline"}
                      >
                        <span className="planner-connected-item__top">
                          <strong>{item.kind === "release" ? "Release date" : "Captured work"}</strong>
                          {item.kind === "capture" && item.timestamp_ms && (
                            <time>{new Date(item.timestamp_ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</time>
                          )}
                        </span>
                        <span>{item.title}</span>
                        <small>{item.detail}</small>
                      </button>
                    </li>
                  ))}
                </ol>
              </section>
            )}
            {loading ? (
              <p className="planner__quiet px-loading-inline" role="status"><LoadingSpinner />Loading your plan…</p>
            ) : selectedTasks.length === 0 ? (
              <div className="planner__empty-day">
                <span>{selectedConnectedItems.length ? "No planned tasks yet." : "No tasks here yet."}</span>
                <button type="button" onClick={startNewTask}><PlusIcon /> Plan this day</button>
              </div>
            ) : (
              <ol className="planner__tasks">
                {selectedTasks.map((task) => (
                  <li key={task.id} className={`planner-task is-${task.task_type} ${task.completed ? "is-complete" : ""} ${isPastDue(task, today) ? "is-overdue" : ""}`}>
                    <button type="button" className="planner-task__check" onClick={() => void toggleTask(task)} aria-label={`${task.completed ? "Reopen" : "Complete"} ${task.title}`} title={task.completed ? "Mark incomplete" : "Mark complete"}>
                      {task.completed && <CheckIcon />}
                    </button>
                    <div className="planner-task__body">
                      <span className="planner-task__top"><strong>{task.title}</strong>{task.due_time && <time>{task.due_time}</time>}</span>
                      <span className="planner-task__meta"><span>{TASK_TYPE_LABEL[task.task_type]}</span>{task.project_id && projectNames.get(task.project_id) && <span>{projectNames.get(task.project_id)}</span>}</span>
                      {task.notes && <span className="planner-task__notes">{task.notes}</span>}
                    </div>
                    <div className="planner-task__actions">
                      <button type="button" className="planner-task__edit" onClick={() => startEditing(task)} aria-label={`Edit ${task.title}`} title="Edit task">
                        <PencilIcon />
                      </button>
                      <div className="planner-task__overflow">
                        <button
                          type="button"
                          className="planner-task__more"
                          onClick={() => setOpenTaskMenuId((current) => current === task.id ? null : task.id)}
                          aria-label={`More options for ${task.title}`}
                          aria-expanded={openTaskMenuId === task.id}
                          title="More task options"
                        >
                          <MoreIcon />
                        </button>
                        {openTaskMenuId === task.id && (
                          <div className="planner-task__menu" role="menu" aria-label={`${task.title} options`}>
                            <button type="button" role="menuitem" onClick={() => startEditing(task)}>Edit task</button>
                            <button type="button" role="menuitem" className="is-danger" onClick={() => void removeTask(task)}>Remove task</button>
                          </div>
                        )}
                      </div>
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </section>

          {editorOpen && createPortal(
            <>
            <div className="planner-dialog__backdrop" aria-hidden="true" onMouseDown={cancelEditing} />
            <section className="planner__form-card planner-dialog" role="dialog" aria-modal="true" aria-labelledby="planner-task-dialog-title">
            <div className="planner__form-head">
              <div>
                <span className="planner__section-label">{editingId ? "Edit task" : "Plan work"}</span>
                <h2 id="planner-task-dialog-title">{editingId ? "Keep the plan current" : "What needs your attention?"}</h2>
              </div>
              <button type="button" className="planner-dialog__close" onClick={cancelEditing} aria-label="Close task editor" title="Close task editor · Esc">&times;</button>
            </div>
            <form className="planner-form" onSubmit={(event) => void saveTask(event)}>
              <p className="planner-form__hint">
                <strong>Quick setup:</strong> choose a work type to sort your plan, then link a project when this task belongs to a song. Release dates and captured work appear automatically in the calendar.
              </p>
              <label>
                <span>Task</span>
                <input value={form.title} onChange={(event) => setForm((current) => ({ ...current, title: event.target.value }))} placeholder="Finish the vocal mix" maxLength={160} autoFocus />
              </label>
              <div className="planner-form__split">
                <label>
                  <span>Date</span>
                  <input type="date" value={form.dueDate} onChange={(event) => setForm((current) => ({ ...current, dueDate: event.target.value }))} required />
                </label>
                <label>
                  <span>Time <em>optional</em></span>
                  <input type="time" value={form.dueTime} onChange={(event) => setForm((current) => ({ ...current, dueTime: event.target.value }))} />
                </label>
              </div>
              <div className="planner-form__split">
                <label>
                  <span>Work type <em>groups your task in the calendar</em></span>
                  <select value={form.taskType} onChange={(event) => setForm((current) => ({ ...current, taskType: event.target.value as PlannerTaskType }))}>
                    {(Object.keys(TASK_TYPE_LABEL) as PlannerTaskType[]).map((type) => <option key={type} value={type}>{TASK_TYPE_LABEL[type]}</option>)}
                  </select>
                </label>
                <label>
                  <span>Project <em>optional — links back to your library</em></span>
                  <select value={form.projectId} onChange={(event) => setForm((current) => ({ ...current, projectId: event.target.value }))}>
                    <option value="">No project</option>
                    {projects.map((project) => <option key={project.id} value={project.id}>{project.display_name}</option>)}
                  </select>
                </label>
              </div>
              <label>
                <span>Notes <em>optional</em></span>
                <textarea value={form.notes} onChange={(event) => setForm((current) => ({ ...current, notes: event.target.value }))} placeholder="What does done look like?" rows={3} maxLength={4000} />
              </label>
              <button type="submit" className="planner__primary" disabled={saving}>{saving ? "Saving…" : editingId ? "Save changes" : "Add to plan"}</button>
            </form>
            </section>
            </>
          , document.body)}
        </aside>
      </div>
    </div>
  );
}
