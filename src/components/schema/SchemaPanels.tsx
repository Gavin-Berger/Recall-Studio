import { useState } from "react";
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
  const looseTracks = ungrouped.filter((track) => track.type !== "return");
  const returnTracks = ungrouped.filter((track) => track.type === "return");
  const deviceCount = schema.tracks.reduce((total, track) => total + track.devices.length, 0);

  return (
    <aside className="schema-pane schema-pane--tree">
      <span className="schema-pane__kicker">Session map</span>
      <h2 className="schema-pane__title">{schema.name}</h2>

      <div className="schema-tree__overview" aria-label="Session summary">
        <span><strong>{schema.tracks.length}</strong><small>tracks</small></span>
        <span><strong>{deviceCount}</strong><small>devices</small></span>
        <span><strong>{returnTracks.length}</strong><small>returns</small></span>
      </div>

      {!schema.has_snapshot && (
        <p className="schema-empty">
          Nothing captured yet. Run a full scan in Ableton, then press
          Refresh.
        </p>
      )}

      {groups.length > 0 && <p className="schema-tree__section-title">Groups</p>}
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

      {looseTracks.length > 0 && <p className="schema-tree__section-title">Tracks</p>}
      {looseTracks.map((track) => (
        <TrackNode key={track.id} track={track} selection={selection} onSelect={onSelect} />
      ))}

      {returnTracks.length > 0 && <p className="schema-tree__section-title">Returns</p>}
      {returnTracks.map((track) => (
        <TrackNode key={track.id} track={track} selection={selection} onSelect={onSelect} />
      ))}

      <div className="schema-legend" aria-label="Device type legend">
        <span className="schema-badge schema-badge--instrument">Instrument</span>
        <span className="schema-badge schema-badge--midi_effect">MIDI FX</span>
        <span className="schema-badge schema-badge--audio_effect">Audio FX</span>
      </div>
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
        <span className="schema-node__content">
          <span className="schema-node__name">{track.name ?? "Untitled track"}</span>
          <span className="schema-node__meta">{formatTrackMeta(track)}</span>
        </span>
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
      <span className="schema-node__content">
        <span className="schema-node__name">{device.name ?? "Device"}</span>
        <span className="schema-node__meta">{formatDeviceMeta(device)}</span>
      </span>
    </button>
  );
}

// ── Center pane: chronological change + moment stream ────────────────────────

function formatTrackMeta(track: TrackObj): string {
  if (track.type === "midi") {
    const hasInstrument = track.devices.some((device) => device.role === "instrument");
    const midiFx = track.devices.filter((device) => device.role === "midi_effect").length;
    const audioFx = track.devices.filter((device) => device.role === "audio_effect").length;
    return `${hasInstrument ? "1 instrument" : "no instrument"} · ${midiFx} MIDI FX · ${audioFx} audio FX`;
  }

  if (track.type === "return") {
    return `${track.devices.length} audio FX · shared return`;
  }

  if (track.type === "group") {
    return `${track.devices.length} group device(s)`;
  }

  return `${track.devices.length} audio FX`;
}

function formatDeviceMeta(device: DeviceObj): string {
  const parameterCount = countParams(device.parameters);
  return `${parameterCount} control${parameterCount === 1 ? "" : "s"} · slot ${device.chain_index + 1}`;
}

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
      <div className="schema-stream-empty">
        <h3>Waiting for your first move</h3>
        <p>
          Capture your Ableton set, tweak a sound, or save a moment to start the timeline.
        </p>
      </div>
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
  const needsBefore = change.before_value === null;

  return (
    <li className={`schema-row schema-row--change ${selected ? "is-selected" : ""}`}>
      <button type="button" className="schema-row__button" onClick={onSelect}>
        <span className="schema-row__time">{formatClock(change.changed_at_ms)}</span>
        <span className="schema-row__body">
          <span className="schema-row__chips">
            <span className="schema-chip schema-chip--mapped">Saved move</span>
            <span className="schema-chip">Control</span>
            {needsBefore && <span className="schema-chip schema-chip--needs-data">Before missing</span>}
          </span>
          <span className="schema-row__headline">{formatParameterChange(change)}</span>
          {context && <span className="schema-row__context">{context}</span>}
        </span>
        <BeforeAfterMini beforeValue={change.before_value} afterValue={change.after_value} />
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
          <span className="schema-row__chips">
            <span className="schema-chip schema-chip--mapped">Moment</span>
            {moment.targets.length === 0 && (
              <span className="schema-chip schema-chip--needs-data">Not linked yet</span>
            )}
          </span>
          <span className="schema-row__headline">{moment.title}</span>
          <span className="schema-row__context">
            {MOMENT_TYPE_LABEL[moment.type]} / {moment.targets.length} linked
          </span>
        </span>
        <ConfidenceBadge confidence={moment.confidence} />
      </button>
    </li>
  );
}

function BeforeAfterMini({
  beforeValue,
  afterValue,
}: {
  beforeValue: number | null;
  afterValue: number | null;
}) {
  return (
    <span className="schema-diff" aria-label="Before and after value">
      <span className="schema-diff__value">
        <small>Before</small>
        <strong>{formatValue(beforeValue)}</strong>
      </span>
      <span className="schema-diff__arrow">-&gt;</span>
      <span className="schema-diff__value">
        <small>After</small>
        <strong>{formatValue(afterValue)}</strong>
      </span>
    </span>
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
  onSelect,
  onPin,
  onEditMoment,
  onChangeConfidence,
  onDeleteMoment,
}: {
  schema: ProjectSchema;
  changes: ParameterChange[];
  moments: CreativeMoment[];
  selection: Selection | null;
  onSelect: (selection: Selection) => void;
  onPin: (request: PinRequest) => void;
  onEditMoment: (moment: CreativeMoment) => void;
  onChangeConfidence: (moment: CreativeMoment, confidence: Confidence) => void;
  onDeleteMoment: (moment: CreativeMoment) => void;
}) {
  return (
    <aside className="schema-pane schema-pane--detail">
      <span className="schema-pane__kicker">What happened</span>
      <h2 className="schema-pane__title">Details</h2>
      {renderDetail()}
    </aside>
  );

  function renderDetail() {
    if (!selection) {
      return (
        <div className="detail-empty">
          <div className="detail-empty__lens" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
          <p>Pick a track, device, knob move, or saved moment.</p>
        </div>
      );
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
          <AutoDocBlock text={buildTrackDoc(track)} />
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
            <Fact term="Controls" value={String(countParams(device.parameters))} />
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
          <AutoDocBlock text={buildDeviceDoc(track, device)} />
        </div>
      );
    }

    if (selection.kind === "parameter") {
      const found = findParameter(schema, selection.id);
      if (!found) return notFound();
      const { device, parameter } = found;
      return (
        <div className="detail">
          <DetailHead label="Control" title={parameter.name ?? "Control"} />
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
                summary: `Control "${parameter.name ?? ""}"`,
              })
            }
          />
          <AutoDocBlock text={buildParameterDoc(device, parameter)} />
        </div>
      );
    }

    if (selection.kind === "change") {
      const change = changes.find((candidate) => candidate.id === selection.id);
      if (!change) return notFound();
      return (
        <div className="detail">
          <DetailHead label="Knob move" title={change.parameter_name ?? "Control"} />
          <dl className="detail__facts">
            <Fact term="Context" value={formatChangeContext(change) || "—"} />
            <Fact term="Before" value={formatValue(change.before_value)} />
            <Fact term="After" value={formatValue(change.after_value)} />
            <Fact term="At" value={formatClock(change.changed_at_ms)} />
          </dl>
          <BeforeAfterDetail change={change} />
          <PinButton
            onClick={() =>
              onPin({
                target: { target_type: "parameter_change", target_id: change.id },
                summary: formatParameterChange(change),
                startMs: change.changed_at_ms,
              })
            }
          />
          <AutoDocBlock text={buildChangeDoc(change)} />
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
        <p className="detail__meta">{moment.targets.length} linked item(s)</p>
        <TargetList targets={moment.targets} schema={schema} changes={changes} onSelect={onSelect} />
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
        <AutoDocBlock text={buildMomentDoc(moment, schema, changes)} />
      </div>
    );
  }

  function onSelectParam(id: string) {
    onSelect({ kind: "parameter", id });
  }

  function notFound() {
    return <p className="schema-empty">That item is no longer in the current session.</p>;
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
            <span>{parameter.name ?? "Control"}</span>
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
      Save as moment
    </button>
  );
}

// ── lookups ──────────────────────────────────────────────────────────────────

function BeforeAfterDetail({ change }: { change: ParameterChange }) {
  return (
    <section className="detail-diff" aria-label="Before and after value">
      <div className="detail-diff__cell">
        <span>Before</span>
        <strong>{formatValue(change.before_value)}</strong>
      </div>
      <div className="detail-diff__arrow">-&gt;</div>
      <div className="detail-diff__cell">
        <span>After</span>
        <strong>{formatValue(change.after_value)}</strong>
      </div>
      {change.before_value === null && (
        <p className="detail-diff__note">Recall does not know the earlier value yet. A before/after scan will fill this in.</p>
      )}
    </section>
  );
}

function TargetList({
  targets,
  schema,
  changes,
  onSelect,
}: {
  targets: CreativeMomentTarget[];
  schema: ProjectSchema;
  changes: ParameterChange[];
  onSelect: (selection: Selection) => void;
}) {
  if (targets.length === 0) {
    return <p className="detail__meta">Nothing linked yet.</p>;
  }

  return (
    <div className="target-list" aria-label="Linked items">
      {targets.map((target) => {
        const selection = targetToSelection(target);
        return (
          <button
            key={`${target.target_type}:${target.target_id}`}
            type="button"
            className="target-pill"
            disabled={!selection}
            onClick={() => selection && onSelect(selection)}
          >
            <span>{formatTargetType(target)}</span>
            <strong>{describeTarget(target, schema, changes)}</strong>
          </button>
        );
      })}
    </div>
  );
}

function AutoDocBlock({ text }: { text: string }) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopyState("copied");
      window.setTimeout(() => setCopyState("idle"), 1400);
    } catch {
      setCopyState("failed");
      window.setTimeout(() => setCopyState("idle"), 1800);
    }
  }

  return (
    <section className="auto-doc">
      <div className="auto-doc__head">
        <span>Session note</span>
        <button type="button" className="schema-btn schema-btn--compact" onClick={handleCopy}>
          {copyState === "copied" ? "Copied" : copyState === "failed" ? "Copy failed" : "Copy"}
        </button>
      </div>
      <pre>{text}</pre>
    </section>
  );
}

function buildTrackDoc(track: TrackObj): string {
  return [
    `Track: ${track.name ?? "Untitled track"}`,
    `Type: ${TRACK_TYPE_LABEL[track.type]}`,
    `Number: ${track.number}`,
    `Devices: ${track.devices.length}`,
    "",
    "Chain:",
    ...track.devices.map(
      (device) =>
        `- [${DEVICE_ROLE_LABEL[device.role]}] ${device.name ?? "Device"} (${countParams(device.parameters)} controls)`,
    ),
  ].join("\n");
}

function buildDeviceDoc(track: TrackObj, device: DeviceObj): string {
  return [
    `Device: ${device.name ?? "Device"}`,
    `Role: ${DEVICE_ROLE_LABEL[device.role]}`,
    `Track: ${track.name ?? "Untitled track"}`,
    `Enabled: ${device.enabled ? "Yes" : "No"}`,
    `Chain slot: ${device.chain_index + 1}`,
    `Controls: ${countParams(device.parameters)}`,
  ].join("\n");
}

function buildParameterDoc(device: DeviceObj, parameter: ParameterObj): string {
  return [
    `Control: ${parameter.name ?? "Control"}`,
    `Device: ${device.name ?? "Device"}`,
    `Current value: ${formatValue(parameter.value)}`,
    `Range: ${parameter.min !== null && parameter.max !== null ? `${formatValue(parameter.min)} to ${formatValue(parameter.max)}` : "Unknown"}`,
    `Nested children: ${parameter.children.length}`,
  ].join("\n");
}

function buildChangeDoc(change: ParameterChange): string {
  return [
    "Knob Move",
    `Context: ${formatChangeContext(change) || "Unknown"}`,
    `Control: ${change.parameter_name ?? "Control"}`,
    `Before: ${formatValue(change.before_value)}`,
    `After: ${formatValue(change.after_value)}`,
    `At: ${formatClock(change.changed_at_ms)}`,
    `Status: ${change.before_value === null ? "Before value missing" : "Ready"}`,
  ].join("\n");
}

function buildMomentDoc(
  moment: CreativeMoment,
  schema: ProjectSchema,
  changes: ParameterChange[],
): string {
  return [
    `Saved Moment: ${moment.title}`,
    `Type: ${MOMENT_TYPE_LABEL[moment.type]}`,
    `Confidence: ${CONFIDENCE_LABEL[moment.confidence]}`,
    `When: ${formatClock(moment.timeline_start_ms ?? moment.created_at_ms)}`,
    "",
    "Linked to:",
    ...(moment.targets.length > 0
      ? moment.targets.map((target) => `- ${describeTarget(target, schema, changes)}`)
      : ["- No linked items"]),
    "",
    `Note: ${moment.note || "No note yet."}`,
    `Tags: ${moment.tags.length > 0 ? moment.tags.map((tag) => `#${tag}`).join(" ") : "None"}`,
  ].join("\n");
}

function targetToSelection(target: CreativeMomentTarget): Selection | null {
  if (target.target_type === "track") return { kind: "track", id: target.target_id };
  if (target.target_type === "device") return { kind: "device", id: target.target_id };
  if (target.target_type === "parameter") return { kind: "parameter", id: target.target_id };
  if (target.target_type === "parameter_change") return { kind: "change", id: target.target_id };
  return null;
}

function formatTargetType(target: CreativeMomentTarget): string {
  if (target.target_type === "parameter") return "control";
  if (target.target_type === "parameter_change") return "knob move";
  if (target.target_type === "clip") return "clip";
  return target.target_type;
}

function describeTarget(
  target: CreativeMomentTarget,
  schema: ProjectSchema,
  changes: ParameterChange[],
): string {
  if (target.target_type === "track") {
    return findTrack(schema, target.target_id)?.name ?? "Unknown track";
  }

  if (target.target_type === "device") {
    const found = findDevice(schema, target.target_id);
    return found ? `${found.device.name ?? "Device"} on ${found.track.name ?? "track"}` : "Unknown device";
  }

  if (target.target_type === "parameter") {
    const found = findParameter(schema, target.target_id);
    return found
      ? `${found.parameter.name ?? "Control"} on ${found.device.name ?? "device"}`
      : "Unknown control";
  }

  if (target.target_type === "parameter_change") {
    const change = changes.find((candidate) => candidate.id === target.target_id);
    return change ? formatParameterChange(change) : "Unknown knob move";
  }

  return "Clip target";
}

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
