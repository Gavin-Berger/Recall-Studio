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
  DeviceObj,
  ParameterChange,
  ProjectSchema,
  TrackObj,
} from "../../types/schema";
import type { SavedSessionMetadata } from "../../types/recall";
import { CreateMomentForm } from "./CreateMomentForm";
import type { MomentFormValues } from "./CreateMomentForm";
import { DetailPanel, EntityTree, SchemaStream } from "./SchemaPanels";
import type { PinRequest } from "./SchemaPanels";
import type { Selection } from "./selection";

type LoadStatus = "idle" | "loading" | "ready" | "error";

type WorkspaceMode = "overview" | "tracks" | "devices" | "moves" | "moments";

type FormState =
  | { mode: "create"; target: CreativeMomentTarget | null; summary: string; startMs?: number }
  | { mode: "edit"; moment: CreativeMoment };

const WORKSPACE_MODES: Array<{ id: WorkspaceMode; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "tracks", label: "Tracks" },
  { id: "devices", label: "Devices" },
  { id: "moves", label: "Moves" },
  { id: "moments", label: "Moments" },
];

export function SchemaTimeline({
  sessionId,
  session,
}: {
  sessionId: string | null;
  session: SavedSessionMetadata | null;
}) {
  const [schema, setSchema] = useState<ProjectSchema | null>(null);
  const [changes, setChanges] = useState<ParameterChange[]>([]);
  const [moments, setMoments] = useState<CreativeMoment[]>([]);
  const [status, setStatus] = useState<LoadStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>("overview");

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
  const moveStream = useMemo(() => stream.filter((item) => item.kind === "change"), [stream]);
  const momentStream = useMemo(() => stream.filter((item) => item.kind === "moment"), [stream]);

  const schemaStats = useMemo(() => {
    const tracks = schema?.tracks.length ?? 0;
    const devices = schema?.tracks.reduce((total, track) => total + track.devices.length, 0) ?? 0;
    const returns = schema?.tracks.filter((track) => track.type === "return").length ?? 0;
    const missingBefore = changes.filter((change) => change.before_value === null).length;
    return { tracks, devices, returns, missingBefore };
  }, [changes, schema]);

  const takeTitle = session?.name ?? schema?.name ?? "Take";
  const isRecording = session?.ended_at_ms === null;
  const projectContext = session?.display_name ?? session?.project_name ?? session?.project_path ?? null;
  const statusText =
    status === "loading"
      ? "Loading..."
      : status === "error"
        ? "Error"
        : `${changes.length} changes / ${moments.length} moments`;

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
          Open or start a take to see what changed and what worked.
        </p>
      </div>
    );
  }

  return (
    <div className="schema-timeline">
      <header className="schema-timeline__toolbar">
        <div className="schema-timeline__title">
          <span className="schema-timeline__eyebrow">
            {isRecording ? "Recording now" : "Viewing take"}
          </span>
          <strong>{takeTitle}</strong>
          <span className="schema-timeline__status">{statusText}</span>
          <span className="schema-timeline__context">
            {projectContext ? `${projectContext} / ` : ""}
            {session ? formatSessionDate(session.started_at_ms) : sessionId}
          </span>
        </div>
        <div className="schema-timeline__toolbar-actions">
          <button
            type="button"
            className="schema-btn schema-btn--primary"
            onClick={() => setForm({ mode: "create", target: null, summary: "" })}
          >
            Save moment
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

      <div className="schema-timeline__control-strip" aria-label="Captured sections">
        <div className="schema-timeline__filters">
          {WORKSPACE_MODES.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`schema-filter ${workspaceMode === item.id ? "is-active" : ""}`}
              onClick={() => setWorkspaceMode(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
        <div className="schema-timeline__summary">
          <span><strong>{schemaStats.tracks}</strong> tracks</span>
          <span><strong>{schemaStats.devices}</strong> devices</span>
          <span><strong>{schemaStats.returns}</strong> returns</span>
          <span><strong>{schemaStats.missingBefore}</strong> need before</span>
        </div>
      </div>

      {error && <div className="schema-timeline__error">{error}</div>}

      <div className="schema-timeline__panes">
        {schema ? (
          <EntityTree schema={schema} selection={selection} onSelect={setSelection} />
        ) : (
          <aside className="schema-pane schema-pane--tree">
            <span className="schema-pane__kicker">Take map</span>
            <h2 className="schema-pane__title">Project</h2>
            <p className="schema-empty">{status === "loading" ? "Loading..." : "Nothing captured yet."}</p>
          </aside>
        )}

        <section className="schema-pane schema-pane--stream">
          <span className="schema-pane__kicker">{workspaceKicker(workspaceMode)}</span>
          <h2 className="schema-pane__title">{workspaceTitle(workspaceMode)}</h2>
          {workspaceMode === "tracks" && schema ? (
            <CapturedTracks schema={schema} selection={selection} onSelect={setSelection} />
          ) : workspaceMode === "devices" && schema ? (
            <CapturedDevices schema={schema} selection={selection} onSelect={setSelection} />
          ) : workspaceMode === "moves" ? (
            <SchemaStream stream={moveStream} selection={selection} onSelect={setSelection} />
          ) : workspaceMode === "moments" ? (
            <SchemaStream stream={momentStream} selection={selection} onSelect={setSelection} />
          ) : (
            <SchemaStream stream={stream} selection={selection} onSelect={setSelection} />
          )}
        </section>

        {schema ? (
          <DetailPanel
            schema={schema}
            changes={changes}
            moments={moments}
            selection={selection}
            onSelect={setSelection}
            onPin={handlePin}
            onEditMoment={(moment) => setForm({ mode: "edit", moment })}
            onChangeConfidence={handleChangeConfidence}
            onDeleteMoment={handleDeleteMoment}
          />
        ) : (
          <aside className="schema-pane schema-pane--detail">
            <span className="schema-pane__kicker">What happened</span>
            <h2 className="schema-pane__title">Details</h2>
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

function workspaceKicker(mode: WorkspaceMode): string {
  if (mode === "tracks") return "Captured tracks";
  if (mode === "devices") return "Captured devices";
  if (mode === "moves") return "Captured moves";
  if (mode === "moments") return "Saved moments";
  return "Take timeline";
}

function workspaceTitle(mode: WorkspaceMode): string {
  if (mode === "tracks") return "Track view";
  if (mode === "devices") return "Device view";
  if (mode === "moves") return "Knob moves";
  if (mode === "moments") return "Moments";
  return "What changed";
}

function CapturedTracks({
  schema,
  selection,
  onSelect,
}: {
  schema: ProjectSchema;
  selection: Selection | null;
  onSelect: (selection: Selection) => void;
}) {
  if (schema.tracks.length === 0) {
    return (
      <div className="schema-stream-empty">
        <h3>No tracks captured yet</h3>
        <p>Run a scan from Ableton or select tracks while the bridge is connected.</p>
      </div>
    );
  }

  return (
    <ol className="schema-section-list">
      {schema.tracks.map((track) => (
        <li key={track.id} className={selection?.kind === "track" && selection.id === track.id ? "is-selected" : ""}>
          <button type="button" onClick={() => onSelect({ kind: "track", id: track.id })}>
            <span className={`schema-badge schema-badge--${track.type}`}>{track.type}</span>
            <span className="schema-section-list__body">
              <strong>{track.name ?? "Untitled track"}</strong>
              <small>{describeTrackCapture(track)}</small>
            </span>
          </button>
        </li>
      ))}
    </ol>
  );
}

function CapturedDevices({
  schema,
  selection,
  onSelect,
}: {
  schema: ProjectSchema;
  selection: Selection | null;
  onSelect: (selection: Selection) => void;
}) {
  const devices = schema.tracks.flatMap((track) =>
    track.devices.map((device) => ({ track, device })),
  );

  if (devices.length === 0) {
    return (
      <div className="schema-stream-empty">
        <h3>No devices captured yet</h3>
        <p>Select a track or run a deeper scan in Ableton to capture devices.</p>
      </div>
    );
  }

  return (
    <ol className="schema-section-list">
      {devices.map(({ track, device }) => (
        <li key={device.id} className={selection?.kind === "device" && selection.id === device.id ? "is-selected" : ""}>
          <button type="button" onClick={() => onSelect({ kind: "device", id: device.id })}>
            <span className={`schema-badge schema-badge--${device.role}`}>{formatDeviceRole(device)}</span>
            <span className="schema-section-list__body">
              <strong>{device.name ?? "Device"}</strong>
              <small>{track.name ?? "Untitled track"} / slot {device.chain_index + 1}</small>
            </span>
          </button>
        </li>
      ))}
    </ol>
  );
}

function describeTrackCapture(track: TrackObj): string {
  const instruments = track.devices.filter((device) => device.role === "instrument").length;
  const midiFx = track.devices.filter((device) => device.role === "midi_effect").length;
  const audioFx = track.devices.filter((device) => device.role === "audio_effect").length;

  if (track.type === "midi") {
    return `${instruments} instrument / ${midiFx} MIDI FX / ${audioFx} audio FX`;
  }

  if (track.type === "return") {
    return `${audioFx} audio FX / shared return`;
  }

  if (track.type === "group") {
    return `${track.devices.length} group device(s)`;
  }

  return `${audioFx} audio FX`;
}

function formatDeviceRole(device: DeviceObj): string {
  if (device.role === "midi_effect") return "MIDI FX";
  if (device.role === "audio_effect") return "Audio FX";
  return "Instrument";
}

function formatSessionDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}
