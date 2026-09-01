import { useEffect, useMemo, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import type { PlannerTask, PlannerTaskInput, PlannerTaskType, SavedProject } from "../../types";
import { organizerRepository, type NativeProject } from "../organizer/repository";
import { createPlannerTask, deletePlannerTask, listPlannerTasks, updatePlannerTask } from "./api";
import {
  calendarDays,
  connectedCalendarItems,
  connectedItemsForDate,
  dateFromKey,
  formatPlannerDate,
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

function ArrowIcon({ direction }: { direction: "previous" | "next" }) {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.9" aria-hidden="true">
      <path d={direction === "previous" ? "m14.5 5-7 7 7 7" : "m9.5 5 7 7-7 7"} strokeLinecap="round" strokeLinejoin="round" />
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
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [timelinePrompt, setTimelinePrompt] = useState<{ title: string; sessionId: string } | null>(null);
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
  const selectedTask = useMemo(
    () => tasks.find((task) => task.id === selectedTaskId) ?? null,
    [selectedTaskId, tasks],
  );
  const selectedWeek = useMemo(() => {
    const weekStart = dateFromKey(selectedDate);
    weekStart.setDate(weekStart.getDate() - weekStart.getDay());
    const entries = Array.from({ length: 7 }, (_, offset) => {
      const date = new Date(weekStart);
      date.setDate(weekStart.getDate() + offset);
      const dateKey = localDateKey(date);
      const planned = tasksForDate(tasks, dateKey);
      const connected = connectedItemsForDate(connectedItems, dateKey);
      return {
        date,
        dateKey,
        planned,
        sessions: connected.filter((item) => item.kind === "capture"),
        releases: connected.filter((item) => item.kind === "release"),
      };
    });
    return {
      entries,
      label: `${formatPlannerDate(entries[0].dateKey, { month: "short", day: "numeric" })} – ${formatPlannerDate(entries[6].dateKey, { month: "short", day: "numeric" })}`,
      planned: entries.reduce((count, entry) => count + entry.planned.filter((task) => !task.completed).length, 0),
      sessions: entries.reduce((count, entry) => count + entry.sessions.length, 0),
      releases: entries.reduce((count, entry) => count + entry.releases.length, 0),
      plannedItems: entries.flatMap((entry) => entry.planned.filter((task) => !task.completed).map((task) => ({ task, dateKey: entry.dateKey }))),
      sessionItems: entries.flatMap((entry) => entry.sessions.map((session) => ({ session, dateKey: entry.dateKey }))),
      releaseItems: entries.flatMap((entry) => entry.releases.map((release) => ({ release, dateKey: entry.dateKey }))),
    };
  }, [connectedItems, selectedDate, tasks]);

  useEffect(() => {
    let mounted = true;
    void listPlannerTasks()
      .then((nextTasks) => {
        if (mounted) setTasks(nextTasks);
      })
      .catch((loadError) => {
        if (mounted) setError(String(loadError));
      })
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    function closeWithEscape(event: KeyboardEvent) {
      if (event.key === "Escape" && timelinePrompt) {
        event.preventDefault();
        setTimelinePrompt(null);
        return;
      }
      if (event.key === "Escape" && selectedTaskId) {
        event.preventDefault();
        setSelectedTaskId(null);
        return;
      }
      if (event.key === "Escape" && editorOpen) {
        event.preventDefault();
        cancelEditing();
      }
    }
    window.addEventListener("keydown", closeWithEscape);
    return () => window.removeEventListener("keydown", closeWithEscape);
  }, [editorOpen, selectedTaskId, timelinePrompt]);

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
    setError(null);
    setForm(blankForm(selectedDate));
    setEditorOpen(true);
  }

  function startEditing(task: PlannerTask) {
    setEditingId(task.id);
    setSelectedTaskId(null);
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

  function openTaskDetails(task: PlannerTask) {
    setSelectedDate(task.due_date);
    setVisibleMonth(monthStart(new Date(`${task.due_date}T12:00:00`)));
    setSelectedTaskId(task.id);
  }

  function askToOpenTimeline(title: string, sessionId: string) {
    setTimelinePrompt({ title, sessionId });
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
      if (selectedTaskId === task.id) setSelectedTaskId(null);
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
                  label: item.kind === "release" ? `Release · ${item.title}` : item.title,
                  className: `is-${item.kind}`,
                  onClick: () => {
                    if (item.kind === "release") onOpenOrganizer();
                    else if (item.session_id) askToOpenTimeline(item.title, item.session_id);
                  },
                })),
                ...dayTasks.map((task) => ({
                  id: task.id,
                  label: task.title,
                  className: `is-${task.task_type} ${task.completed ? "is-done" : ""}`,
                  onClick: () => openTaskDetails(task),
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
                    {visibleItems.map((item) => (
                      <button key={item.id} type="button" className={`planner-day__chip ${item.className}`} onClick={item.onClick} title={item.label}>{item.label}</button>
                    ))}
                  </div>
                </article>
              );
            })}
          </div>
        </section>

        <aside className="planner__aside">
          <section className="planner__week-card" aria-label="Week at a glance">
            <div className="planner__week-head">
              <div>
                <span className="planner__section-label">Week at a glance</span>
                <h2>{selectedWeek.label}</h2>
              </div>
              <span>{selectedWeek.planned} planned</span>
            </div>
            <div className="planner__week-summary">
              <div><strong>{selectedWeek.planned}</strong><span>planned</span></div>
              <div><strong>{selectedWeek.sessions}</strong><span>studio captures</span></div>
              <div><strong>{selectedWeek.releases}</strong><span>releases</span></div>
            </div>
            <div className="planner__week-work">
              {selectedWeek.plannedItems.length > 0 && (
                <section aria-labelledby="planner-week-planned-title">
                  <h3 id="planner-week-planned-title">Your next moves</h3>
                  <ol>
                    {selectedWeek.plannedItems.map(({ task, dateKey }) => (
                      <li key={task.id}>
                        <button type="button" onClick={() => openTaskDetails(task)}>
                          <time dateTime={dateKey}>{formatPlannerDate(dateKey, { weekday: "short", month: "short", day: "numeric" })}</time>
                          <span>{task.title}</span>
                        </button>
                      </li>
                    ))}
                  </ol>
                </section>
              )}
              {selectedWeek.sessionItems.length > 0 && (
                <section aria-labelledby="planner-week-captures-title">
                  <h3 id="planner-week-captures-title">What Recall captured</h3>
                  <ol>
                    {selectedWeek.sessionItems.map(({ session, dateKey }) => (
                      <li key={session.id}>
                        <button type="button" onClick={() => session.session_id && askToOpenTimeline(session.title, session.session_id)} disabled={!session.session_id}>
                          <time dateTime={dateKey}>{formatPlannerDate(dateKey, { weekday: "short", month: "short", day: "numeric" })}</time>
                          <span>{session.title}</span>
                        </button>
                      </li>
                    ))}
                  </ol>
                </section>
              )}
              {selectedWeek.releaseItems.length > 0 && (
                <section aria-labelledby="planner-week-releases-title">
                  <h3 id="planner-week-releases-title">Release dates</h3>
                  <ol>
                    {selectedWeek.releaseItems.map(({ release, dateKey }) => (
                      <li key={release.id}>
                        <button type="button" onClick={onOpenOrganizer}>
                          <time dateTime={dateKey}>{formatPlannerDate(dateKey, { weekday: "short", month: "short", day: "numeric" })}</time>
                          <span>{release.title}</span>
                        </button>
                      </li>
                    ))}
                  </ol>
                </section>
              )}
              {selectedWeek.plannedItems.length === 0 && selectedWeek.sessionItems.length === 0 && selectedWeek.releaseItems.length === 0 && (
                <p>Nothing is scheduled or captured in this week yet.</p>
              )}
            </div>
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
                <span>Notes &amp; comments <em>optional</em></span>
                <textarea value={form.notes} onChange={(event) => setForm((current) => ({ ...current, notes: event.target.value }))} placeholder="Context, notes, or a handoff for the next session" rows={3} maxLength={4000} />
              </label>
              <button type="submit" className="planner__primary" disabled={saving}>{saving ? "Saving…" : editingId ? "Save changes" : "Add to plan"}</button>
            </form>
            </section>
            </>
          , document.body)}

          {selectedTask && createPortal(
            <>
              <div className="planner-dialog__backdrop" aria-hidden="true" onMouseDown={() => setSelectedTaskId(null)} />
              <section className="planner-task-detail planner-dialog" role="dialog" aria-modal="true" aria-labelledby="planner-task-detail-title">
                <header className="planner-task-detail__head">
                  <div>
                    <span className="planner__section-label">Task details</span>
                    <h2 id="planner-task-detail-title">{selectedTask.title}</h2>
                    <p>{selectedTask.completed ? "Completed" : "Planned"} · {TASK_TYPE_LABEL[selectedTask.task_type]}</p>
                  </div>
                  <button type="button" className="planner-dialog__close" onClick={() => setSelectedTaskId(null)} aria-label="Close task details" title="Close task details · Esc">&times;</button>
                </header>
                <div className="planner-task-detail__content">
                  <dl className="planner-task-detail__facts">
                    <div>
                      <dt>What</dt>
                      <dd>{selectedTask.title}<small>{TASK_TYPE_LABEL[selectedTask.task_type]}</small></dd>
                    </div>
                    <div>
                      <dt>When</dt>
                      <dd><time dateTime={selectedTask.due_date}>{formatPlannerDate(selectedTask.due_date, { weekday: "long", month: "long", day: "numeric", year: "numeric" })}</time><small>{selectedTask.due_time ? `At ${selectedTask.due_time}` : "No time set"}</small></dd>
                    </div>
                    <div>
                      <dt>Where</dt>
                      <dd>{selectedTask.project_id && projectNames.get(selectedTask.project_id) ? projectNames.get(selectedTask.project_id) : "Not linked to a project"}<small>Studio planner</small></dd>
                    </div>
                  </dl>
                  <section className="planner-task-detail__notes" aria-label="Notes and comments">
                    <span>Notes &amp; comments</span>
                    <p>{selectedTask.notes || "No notes or comments have been added yet."}</p>
                  </section>
                </div>
                <footer className="planner-task-detail__actions">
                  <button type="button" className="planner__text-btn is-danger" onClick={() => void removeTask(selectedTask)}>Remove task</button>
                  <button type="button" className="planner__text-btn" onClick={() => void toggleTask(selectedTask)}>{selectedTask.completed ? "Mark incomplete" : "Mark complete"}</button>
                  <button type="button" className="planner__primary" onClick={() => startEditing(selectedTask)}><PencilIcon /> Edit task</button>
                </footer>
              </section>
            </>
          , document.body)}

          {timelinePrompt && createPortal(
            <>
              <div className="planner-dialog__backdrop" aria-hidden="true" onMouseDown={() => setTimelinePrompt(null)} />
              <section className="planner-timeline-prompt planner-dialog" role="dialog" aria-modal="true" aria-labelledby="planner-timeline-prompt-title">
                <div className="planner-task-detail__head">
                  <div>
                    <span className="planner__section-label">Studio capture</span>
                    <h2 id="planner-timeline-prompt-title">See the time you spent?</h2>
                    <p>Open the Timeline to review this session.</p>
                  </div>
                  <button type="button" className="planner-dialog__close" onClick={() => setTimelinePrompt(null)} aria-label="Close session prompt" title="Close · Esc">&times;</button>
                </div>
                <div className="planner-timeline-prompt__content">
                  <strong>{timelinePrompt.title}</strong>
                  <p>Would you like to see how long you worked on this and review what Recall captured?</p>
                </div>
                <footer className="planner-task-detail__actions">
                  <button type="button" className="planner__text-btn" onClick={() => setTimelinePrompt(null)}>Not now</button>
                  <button type="button" className="planner__primary" onClick={() => { onOpenTimeline(timelinePrompt.sessionId); setTimelinePrompt(null); }}>Open Timeline</button>
                </footer>
              </section>
            </>
          , document.body)}
        </aside>
      </div>
    </div>
  );
}
