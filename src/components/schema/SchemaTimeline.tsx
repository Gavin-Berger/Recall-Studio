import { useCallback, useEffect, useMemo, useState } from "react";
import "./SchemaTimeline.css";
import {
  createCreativeMoment,
  deleteCreativeMoment,
  getParameterChanges,
  getProjectSchema,
  listCreativeMoments,
  materializeSessionSchema,
  updateCreativeMoment,
} from "../../lib/schema/api";
import { buildSchemaStream } from "../../lib/schema/timeline";
import type {
  Confidence,
  CreativeMoment,
  CreativeMomentTarget,
  ParameterChange,
  ProjectSchema,
} from "../../types/schema";
import { CreateMomentForm } from "./CreateMomentForm";
import type { MomentFormValues } from "./CreateMomentForm";
import { DetailPanel, EntityTree, SchemaStream } from "./SchemaPanels";
import type { PinRequest } from "./SchemaPanels";
import type { Selection } from "./selection";

type LoadStatus = "idle" | "loading" | "ready" | "error";

type FormState =
  | { mode: "create"; target: CreativeMomentTarget | null; summary: string; startMs?: number }
  | { mode: "edit"; moment: CreativeMoment };

export function SchemaTimeline({ sessionId }: { sessionId: string | null }) {
  const [schema, setSchema] = useState<ProjectSchema | null>(null);
  const [changes, setChanges] = useState<ParameterChange[]>([]);
  const [moments, setMoments] = useState<CreativeMoment[]>([]);
  const [status, setStatus] = useState<LoadStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [form, setForm] = useState<FormState | null>(null);

  const load = useCallback(
    async (rematerialize: boolean) => {
      if (!sessionId) return;
      setStatus("loading");
      setError(null);
      try {
        if (rematerialize) {
          await materializeSessionSchema(sessionId);
        }
        const [nextSchema, nextChanges, nextMoments] = await Promise.all([
          getProjectSchema(sessionId),
          getParameterChanges(sessionId),
          listCreativeMoments(sessionId),
        ]);
        setSchema(nextSchema);
        setChanges(nextChanges);
        setMoments(nextMoments);
        setStatus("ready");
      } catch (loadError) {
        setError(String(loadError));
        setStatus("error");
      }
    },
    [sessionId],
  );

  // Rebuild + load whenever the viewed session changes.
  useEffect(() => {
    setSelection(null);
    setForm(null);
    setSchema(null);
    setChanges([]);
    setMoments([]);
    void load(true);
  }, [sessionId, load]);

  const refreshMoments = useCallback(async () => {
    if (!sessionId) return;
    setMoments(await listCreativeMoments(sessionId));
  }, [sessionId]);

  const stream = useMemo(() => buildSchemaStream(changes, moments), [changes, moments]);

  function handlePin(request: PinRequest) {
    setForm({ mode: "create", target: request.target, summary: request.summary, startMs: request.startMs });
  }

  async function handleSubmitForm(values: MomentFormValues) {
    if (!sessionId || !form) return;

    try {
      if (form.mode === "create") {
        const id = crypto.randomUUID();
        await createCreativeMoment({
          id,
          sessionId,
          title: values.title,
          momentType: values.momentType,
          timelineStartMs: form.startMs ?? null,
          note: values.note,
          tags: values.tags,
          confidence: values.confidence,
          targets: form.target ? [form.target] : [],
        });
        await refreshMoments();
        setSelection({ kind: "moment", id });
      } else {
        await updateCreativeMoment({
          id: form.moment.id,
          title: values.title,
          momentType: values.momentType,
          timelineStartMs: form.moment.timeline_start_ms,
          timelineEndMs: form.moment.timeline_end_ms,
          note: values.note,
          tags: values.tags,
          confidence: values.confidence,
        });
        await refreshMoments();
      }
      setForm(null);
    } catch (submitError) {
      setError(String(submitError));
    }
  }

  async function handleChangeConfidence(moment: CreativeMoment, confidence: Confidence) {
    try {
      await updateCreativeMoment({
        id: moment.id,
        title: moment.title,
        momentType: moment.type,
        timelineStartMs: moment.timeline_start_ms,
        timelineEndMs: moment.timeline_end_ms,
        note: moment.note,
        tags: moment.tags,
        confidence,
      });
      await refreshMoments();
    } catch (confidenceError) {
      setError(String(confidenceError));
    }
  }

  async function handleDeleteMoment(moment: CreativeMoment) {
    if (!window.confirm(`Delete creative moment "${moment.title}"?`)) return;
    try {
      await deleteCreativeMoment(moment.id);
      setSelection(null);
      await refreshMoments();
    } catch (deleteError) {
      setError(String(deleteError));
    }
  }

  if (!sessionId) {
    return (
      <div className="schema-timeline schema-timeline--empty">
        <p className="schema-empty">
          Open or start a session to see its schema timeline.
        </p>
      </div>
    );
  }

  return (
    <div className="schema-timeline">
      <header className="schema-timeline__toolbar">
        <div className="schema-timeline__title">
          <strong>{schema?.name ?? "Session"}</strong>
          <span className="schema-timeline__status">
            {status === "loading"
              ? "Loading…"
              : status === "error"
                ? "Error"
                : `${changes.length} changes · ${moments.length} moments`}
          </span>
        </div>
        <div className="schema-timeline__toolbar-actions">
          <button
            type="button"
            className="schema-btn schema-btn--primary"
            onClick={() => setForm({ mode: "create", target: null, summary: "" })}
          >
            + Create moment
          </button>
          <button
            type="button"
            className="schema-btn"
            onClick={() => void load(true)}
            disabled={status === "loading"}
          >
            Refresh
          </button>
        </div>
      </header>

      {error && <div className="schema-timeline__error">{error}</div>}

      <div className="schema-timeline__panes">
        {schema ? (
          <EntityTree schema={schema} selection={selection} onSelect={setSelection} />
        ) : (
          <aside className="schema-pane schema-pane--tree">
            <h2 className="schema-pane__title">Project</h2>
            <p className="schema-empty">{status === "loading" ? "Loading…" : "No schema yet."}</p>
          </aside>
        )}

        <section className="schema-pane schema-pane--stream">
          <h2 className="schema-pane__title">Timeline</h2>
          <SchemaStream stream={stream} selection={selection} onSelect={setSelection} />
        </section>

        {schema ? (
          <DetailPanel
            schema={schema}
            changes={changes}
            moments={moments}
            selection={selection}
            onPin={handlePin}
            onEditMoment={(moment) => setForm({ mode: "edit", moment })}
            onChangeConfidence={handleChangeConfidence}
            onDeleteMoment={handleDeleteMoment}
          />
        ) : (
          <aside className="schema-pane schema-pane--detail">
            <h2 className="schema-pane__title">Detail</h2>
          </aside>
        )}
      </div>

      {form && (
        <CreateMomentForm
          mode={form.mode}
          targetSummary={form.mode === "create" ? form.summary || undefined : undefined}
          initial={
            form.mode === "edit"
              ? {
                  title: form.moment.title,
                  momentType: form.moment.type,
                  confidence: form.moment.confidence,
                  note: form.moment.note ?? "",
                  tags: form.moment.tags,
                }
              : undefined
          }
          onCancel={() => setForm(null)}
          onSubmit={handleSubmitForm}
        />
      )}
    </div>
  );
}
