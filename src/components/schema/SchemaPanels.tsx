import {
  CONFIDENCE_LABEL,
  CONFIDENCE_ORDER,
  DEVICE_ROLE_LABEL,
  MOMENT_TYPE_LABEL,
  TRACK_TYPE_LABEL,
} from "../../types/schema";
import type {
  Confidence,
  CreativeMoment,
  CreativeMomentTarget,
  DeviceObj,
  ParameterChange,
  ParameterObj,
  ProjectSchema,
  TrackObj,
} from "../../types/schema";
import {
  formatChangeContext,
  formatParameterChange,
  formatValue,
  groupTracksByParent,
} from "../../lib/schema/timeline";
import type { SchemaStreamItem } from "../../lib/schema/timeline";
import type { Selection } from "./selection";

export type PinRequest = {
  target: CreativeMomentTarget;
  summary: string;
  startMs?: number;
};

// ── Left pane: Project → Group → Track → Device ──────────────────────────────

export function EntityTree({
  schema,
  selection,
  onSelect,
}: {
  schema: ProjectSchema;
  selection: Selection | null;
  onSelect: (selection: Selection) => void;
}) {
  const { groups, ungrouped } = groupTracksByParent(schema);

  return (
    <aside className="schema-pane schema-pane--tree">
      <h2 className="schema-pane__title">{schema.name}</h2>

      {!schema.has_snapshot && (
        <p className="schema-empty">
          No snapshot captured yet. Trigger a deep snapshot in Ableton, then press
          Refresh.
        </p>
      )}

      {groups.map((group) => (
        <div key={group.group.id} className="schema-tree__group">
          <TrackNode track={group.group} selection={selection} onSelect={onSelect} />
          <div className="schema-tree__children">
            {group.children.map((track) => (
              <TrackNode
                key={track.id}
                track={track}
                selection={selection}
                onSelect={onSelect}
              />
            ))}
          </div>
        </div>
      ))}

      {ungrouped.map((track) => (
        <TrackNode key={track.id} track={track} selection={selection} onSelect={onSelect} />
      ))}
    </aside>
  );
}

function TrackNode({
  track,
  selection,
  onSelect,
}: {
  track: TrackObj;
  selection: Selection | null;
  onSelect: (selection: Selection) => void;
}) {
  const selected = selection?.kind === "track" && selection.id === track.id;

  return (
    <div className="schema-tree__track">
      <button
        type="button"
        className={`schema-node ${selected ? "is-selected" : ""}`}
        onClick={() => onSelect({ kind: "track", id: track.id })}
      >
        <span className={`schema-badge schema-badge--${track.type}`}>
          {TRACK_TYPE_LABEL[track.type]}
        </span>
        <span className="schema-node__name">{track.name ?? "Untitled track"}</span>
      </button>

      {track.type !== "group" && track.devices.length > 0 && (
        <div className="schema-tree__devices">
          {track.devices.map((device) => (
            <DeviceNode
              key={device.id}
              device={device}
              selection={selection}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function DeviceNode({
  device,
  selection,
  onSelect,
}: {
  device: DeviceObj;
  selection: Selection | null;
  onSelect: (selection: Selection) => void;
}) {
  const selected = selection?.kind === "device" && selection.id === device.id;

  return (
    <button
      type="button"
      className={`schema-node schema-node--device ${selected ? "is-selected" : ""} ${
        device.enabled ? "" : "is-disabled"
      }`}
      onClick={() => onSelect({ kind: "device", id: device.id })}
    >
      <span className={`schema-badge schema-badge--${device.role}`}>
        {DEVICE_ROLE_LABEL[device.role]}
      </span>
      <span className="schema-node__name">{device.name ?? "Device"}</span>
    </button>
  );
}

// ── Center pane: chronological change + moment stream ────────────────────────

export function SchemaStream({
  stream,
  selection,
  onSelect,
}: {
  stream: SchemaStreamItem[];
  selection: Selection | null;
  onSelect: (selection: Selection) => void;
}) {
  if (stream.length === 0) {
    return (
      <p className="schema-empty">
        No parameter changes or creative moments yet. As you tweak devices in
        Ableton, changes appear here — pin the ones that matter as creative moments.
      </p>
    );
  }

  return (
    <ol className="schema-stream">
      {stream.map((item) =>
        item.kind === "change" ? (
          <ChangeRow
            key={item.id}
            change={item.change}
            selected={selection?.kind === "change" && selection.id === item.id}
            onSelect={() => onSelect({ kind: "change", id: item.id })}
          />
        ) : (
          <MomentRow
            key={item.id}
            moment={item.moment}
            selected={selection?.kind === "moment" && selection.id === item.id}
            onSelect={() => onSelect({ kind: "moment", id: item.id })}
          />
        ),
      )}
    </ol>
  );
}

function ChangeRow({
  change,
  selected,
  onSelect,
}: {
  change: ParameterChange;
  selected: boolean;
  onSelect: () => void;
}) {
  const context = formatChangeContext(change);

  return (
    <li className={`schema-row schema-row--change ${selected ? "is-selected" : ""}`}>
      <button type="button" className="schema-row__button" onClick={onSelect}>
        <span className="schema-row__time">{formatClock(change.changed_at_ms)}</span>
        <span className="schema-row__body">
          <span className="schema-row__headline">{formatParameterChange(change)}</span>
          {context && <span className="schema-row__context">{context}</span>}
        </span>
      </button>
    </li>
  );
}

function MomentRow({
  moment,
  selected,
  onSelect,
}: {
  moment: CreativeMoment;
  selected: boolean;
  onSelect: () => void;
}) {
  const at = moment.timeline_start_ms ?? moment.created_at_ms;

  return (
    <li className={`schema-row schema-row--moment ${selected ? "is-selected" : ""}`}>
      <button type="button" className="schema-row__button" onClick={onSelect}>
        <span className="schema-row__time">{formatClock(at)}</span>
        <span className="schema-row__body">
          <span className="schema-row__headline">★ {moment.title}</span>
          <span className="schema-row__context">
            {MOMENT_TYPE_LABEL[moment.type]}
          </span>
        </span>
        <ConfidenceBadge confidence={moment.confidence} />
      </button>
    </li>
  );
}

export function ConfidenceBadge({ confidence }: { confidence: Confidence }) {
  return (
    <span className={`confidence-badge confidence-badge--${confidence}`}>
      {CONFIDENCE_LABEL[confidence]}
    </span>
  );
}

// ── Right pane: detail for the current selection ─────────────────────────────

export function DetailPanel({
  schema,
  changes,
  moments,
  selection,
  onPin,
  onEditMoment,
  onChangeConfidence,
  onDeleteMoment,
}: {
  schema: ProjectSchema;
  changes: ParameterChange[];
  moments: CreativeMoment[];
  selection: Selection | null;
  onPin: (request: PinRequest) => void;
  onEditMoment: (moment: CreativeMoment) => void;
  onChangeConfidence: (moment: CreativeMoment, confidence: Confidence) => void;
  onDeleteMoment: (moment: CreativeMoment) => void;
}) {
  return (
    <aside className="schema-pane schema-pane--detail">
      <h2 className="schema-pane__title">Detail</h2>
      {renderDetail()}
    </aside>
  );

  function renderDetail() {
    if (!selection) {
      return <p className="schema-empty">Select a track, device, change, or moment.</p>;
    }

    if (selection.kind === "track") {
      const track = findTrack(schema, selection.id);
      if (!track) return notFound();
      return (
        <div className="detail">
          <DetailHead label={TRACK_TYPE_LABEL[track.type]} title={track.name ?? "Untitled track"} />
          <dl className="detail__facts">
            <Fact term="Type" value={`${TRACK_TYPE_LABEL[track.type]} track`} />
            <Fact term="Number" value={String(track.number)} />
            <Fact term="Devices" value={String(track.devices.length)} />
          </dl>
          <PinButton
            onClick={() =>
              onPin({
                target: { target_type: "track", target_id: track.id },
                summary: `${TRACK_TYPE_LABEL[track.type]} track "${track.name ?? ""}"`,
              })
            }
          />
        </div>
      );
    }

    if (selection.kind === "device") {
      const found = findDevice(schema, selection.id);
      if (!found) return notFound();
      const { track, device } = found;
      return (
        <div className="detail">
          <DetailHead label={DEVICE_ROLE_LABEL[device.role]} title={device.name ?? "Device"} />
          <dl className="detail__facts">
            <Fact term="Role" value={DEVICE_ROLE_LABEL[device.role]} />
            <Fact term="On track" value={track.name ?? "—"} />
            <Fact term="Enabled" value={device.enabled ? "Yes" : "No"} />
            <Fact term="Parameters" value={String(countParams(device.parameters))} />
          </dl>
          {device.parameters.length > 0 && (
            <ParameterList parameters={device.parameters} onSelect={(id) => onSelectParam(id)} />
          )}
          <PinButton
            onClick={() =>
              onPin({
                target: { target_type: "device", target_id: device.id },
                summary: `${DEVICE_ROLE_LABEL[device.role]} "${device.name ?? ""}"`,
              })
            }
          />
        </div>
      );
    }

    if (selection.kind === "parameter") {
      const found = findParameter(schema, selection.id);
      if (!found) return notFound();
      const { device, parameter } = found;
      return (
        <div className="detail">
          <DetailHead label="Parameter" title={parameter.name ?? "Parameter"} />
          <dl className="detail__facts">
            <Fact term="On device" value={device.name ?? "—"} />
            <Fact term="Value" value={formatValue(parameter.value)} />
            {parameter.min !== null && parameter.max !== null && (
              <Fact term="Range" value={`${formatValue(parameter.min)} – ${formatValue(parameter.max)}`} />
            )}
          </dl>
          <PinButton
            onClick={() =>
              onPin({
                target: { target_type: "parameter", target_id: parameter.id },
                summary: `Parameter "${parameter.name ?? ""}"`,
              })
            }
          />
        </div>
      );
    }

    if (selection.kind === "change") {
      const change = changes.find((candidate) => candidate.id === selection.id);
      if (!change) return notFound();
      return (
        <div className="detail">
          <DetailHead label="Parameter change" title={change.parameter_name ?? "Parameter"} />
          <dl className="detail__facts">
            <Fact term="Context" value={formatChangeContext(change) || "—"} />
            <Fact term="Before" value={formatValue(change.before_value)} />
            <Fact term="After" value={formatValue(change.after_value)} />
            <Fact term="At" value={formatClock(change.changed_at_ms)} />
          </dl>
          <PinButton
            onClick={() =>
              onPin({
                target: { target_type: "parameter_change", target_id: change.id },
                summary: formatParameterChange(change),
                startMs: change.changed_at_ms,
              })
            }
          />
        </div>
      );
    }

    // moment
    const moment = moments.find((candidate) => candidate.id === selection.id);
    if (!moment) return notFound();
    return (
      <div className="detail">
        <DetailHead label={MOMENT_TYPE_LABEL[moment.type]} title={moment.title} />
        <label className="detail__confidence">
          <span>Confidence</span>
          <select
            value={moment.confidence}
            onChange={(changeEvent) =>
              onChangeConfidence(moment, changeEvent.target.value as Confidence)
            }
          >
            {CONFIDENCE_ORDER.map((level) => (
              <option key={level} value={level}>
                {CONFIDENCE_LABEL[level]}
              </option>
            ))}
          </select>
        </label>
        {moment.note && <p className="detail__note">{moment.note}</p>}
        {moment.tags.length > 0 && (
          <div className="detail__tags">
            {moment.tags.map((tag) => (
              <span key={tag} className="detail__tag">
                #{tag}
              </span>
            ))}
          </div>
        )}
        <p className="detail__meta">{moment.targets.length} linked target(s)</p>
        <div className="detail__actions">
          <button type="button" className="schema-btn" onClick={() => onEditMoment(moment)}>
            Edit
          </button>
          <button
            type="button"
            className="schema-btn schema-btn--danger"
            onClick={() => onDeleteMoment(moment)}
          >
            Delete
          </button>
        </div>
      </div>
    );
  }

  function onSelectParam(_id: string) {
    // Parameter selection from the detail list is a no-op hook for now; the value
    // is already shown inline. Kept so the list rows are clickable-ready.
  }

  function notFound() {
    return <p className="schema-empty">That item is no longer in the current snapshot.</p>;
  }
}

function ParameterList({
  parameters,
  onSelect,
}: {
  parameters: ParameterObj[];
  onSelect: (id: string) => void;
}) {
  return (
    <ul className="detail__params">
      {parameters.map((parameter) => (
        <li key={parameter.id}>
          <button type="button" className="detail__param" onClick={() => onSelect(parameter.id)}>
            <span>{parameter.name ?? "Parameter"}</span>
            <span className="detail__param-value">{formatValue(parameter.value)}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function DetailHead({ label, title }: { label: string; title: string }) {
  return (
    <div className="detail__head">
      <span className="detail__label">{label}</span>
      <h3 className="detail__title">{title}</h3>
    </div>
  );
}

function Fact({ term, value }: { term: string; value: string }) {
  return (
    <div className="detail__fact">
      <dt>{term}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function PinButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" className="schema-btn schema-btn--primary detail__pin" onClick={onClick}>
      + Pin as creative moment
    </button>
  );
}

// ── lookups ──────────────────────────────────────────────────────────────────

function findTrack(schema: ProjectSchema, id: string): TrackObj | null {
  return schema.tracks.find((track) => track.id === id) ?? null;
}

function findDevice(
  schema: ProjectSchema,
  id: string,
): { track: TrackObj; device: DeviceObj } | null {
  for (const track of schema.tracks) {
    const device = track.devices.find((candidate) => candidate.id === id);
    if (device) return { track, device };
  }
  return null;
}

function findParameter(
  schema: ProjectSchema,
  id: string,
): { track: TrackObj; device: DeviceObj; parameter: ParameterObj } | null {
  for (const track of schema.tracks) {
    for (const device of track.devices) {
      const parameter = findParamInList(device.parameters, id);
      if (parameter) return { track, device, parameter };
    }
  }
  return null;
}

function findParamInList(parameters: ParameterObj[], id: string): ParameterObj | null {
  for (const parameter of parameters) {
    if (parameter.id === id) return parameter;
    const child = findParamInList(parameter.children, id);
    if (child) return child;
  }
  return null;
}

function countParams(parameters: ParameterObj[]): number {
  return parameters.reduce((total, parameter) => total + 1 + countParams(parameter.children), 0);
}

function formatClock(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}
