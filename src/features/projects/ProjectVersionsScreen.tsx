import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  getParameterChanges,
  getProjectSchema,
  materializeSessionSchema,
} from "../../lib/schema/api";
import type { ProjectSchema } from "../../types/schema";
import type { ConnectionStatus, SavedProject, SavedSessionMetadata } from "../../types/recall";
import { formatSessionDate, formatSessionDuration, preferredCaptureTitle } from "../sessionFormat";
import { RelinkDialog, type AlsFileChoice } from "./RelinkDialog";
import { compareSchemas, countDevices, diffIsEmpty, type VersionDiff } from "./versionDiff";
import { projectVersions, versionForSession } from "./projectVersions";
import { VersionGraphView } from "./VersionGraphView";

// The version-memory view for one project: every `.als` take on a chronological
// rail, and a detail pane that answers "what changed, what was recorded, which
// file is this" for the selected version. The raw event timeline stays one click
// away as supporting evidence — it is not the surface itself.

type SchemaState =
  | { status: "loading" }
  | { status: "ready"; schema: ProjectSchema }
  // Loaded fine, but there is no structure snapshot to compare with.
  | { status: "none" }
  | { status: "error"; message: string };

type ActivityState =
  | { status: "loading" }
  | { status: "ready"; moves: number; devices: number; tracks: number }
  | { status: "error" };

type ProjectVersionsScreenProps = {
  project: SavedProject | null;
  connection: ConnectionStatus;
  onBack: () => void;
  onOpenProject: (projectId: string) => Promise<void>;
  onRescanFolder: (projectId: string) => Promise<number>;
  onConnectFolder: (projectId?: string | null) => Promise<number>;
  onOpenTimeline: (sessionId: string) => void;
  onOpenRecap: (sessionId: string) => void;
  onDeleteCapture: (sessionId: string) => Promise<void>;
  onListProjectAlsFiles: (projectId: string) => Promise<AlsFileChoice[]>;
  onRelinkTake: (sessionId: string, alsPath: string) => Promise<void>;
};

export function ProjectVersionsScreen({
  project,
  connection,
  onBack,
  onOpenProject,
  onRescanFolder,
  onConnectFolder,
  onOpenTimeline,
  onOpenRecap,
  onDeleteCapture,
  onListProjectAlsFiles,
  onRelinkTake,
}: ProjectVersionsScreenProps) {
  const [selectedTakeId, setSelectedTakeId] = useState<string | null>(null);
  const [busyLabel, setBusyLabel] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [relinkOpen, setRelinkOpen] = useState(false);
  // Per-take structure snapshots and recorded-activity summaries, cached by take
  // id so switching between versions doesn't refetch. The ref guards against
  // duplicate fetches (effects can re-run before state lands).
  const [schemas, setSchemas] = useState<Record<string, SchemaState>>({});
  const [activity, setActivity] = useState<Record<string, ActivityState>>({});
  const requested = useRef(new Set<string>());

  const busy = busyLabel !== null;

  // Newest first — the top of the rail is where the song is now.
  const takes = useMemo(
    () =>
      project ? [...project.captures].sort((a, b) => b.started_at_ms - a.started_at_ms) : [],
    [project],
  );

  const selected = useMemo(
    () => takes.find((take) => take.id === selectedTakeId) ?? takes[0] ?? null,
    [takes, selectedTakeId],
  );
  // The same captures rolled up into the .als files they belong to, so the
  // graph can show lineage while the rail below stays per-capture.
  const versions = useMemo(() => projectVersions(project?.captures ?? []), [project]);
  const selectedVersionId = useMemo(
    () => versionForSession(versions, selected?.id ?? null)?.id ?? null,
    [versions, selected],
  );

  const selectedIndex = selected ? takes.indexOf(selected) : -1;
  // "Previous" is the next-older version on the rail.
  const previous = selectedIndex >= 0 ? takes[selectedIndex + 1] ?? null : null;

  const loadSchema = useCallback((take: SavedSessionMetadata) => {
    // A scanned take has no recorded events, so it cannot have a snapshot yet —
    // skip the round trip and state that honestly.
    if (take.take_origin === "scanned" || take.creative_event_count === 0) {
      setSchemas((prev) => (prev[take.id] ? prev : { ...prev, [take.id]: { status: "none" } }));
      return;
    }
    const key = `schema:${take.id}`;
    if (requested.current.has(key)) return;
    requested.current.add(key);
    setSchemas((prev) => ({ ...prev, [take.id]: { status: "loading" } }));
    void (async () => {
      try {
        await materializeSessionSchema(take.id);
        const schema = await getProjectSchema(take.id);
        setSchemas((current) => ({
          ...current,
          [take.id]: schema.has_snapshot ? { status: "ready", schema } : { status: "none" },
        }));
      } catch (loadError) {
        setSchemas((current) => ({
          ...current,
          [take.id]: { status: "error", message: String(loadError) },
        }));
      }
    })();
  }, []);

  const loadActivity = useCallback((take: SavedSessionMetadata) => {
    if (take.take_origin === "scanned") return;
    const key = `activity:${take.id}`;
    if (requested.current.has(key)) return;
    requested.current.add(key);
    setActivity((prev) => ({ ...prev, [take.id]: { status: "loading" } }));
    void (async () => {
      try {
        const changes = await getParameterChanges(take.id);
        const devices = new Set<string>();
        const tracks = new Set<string>();
        for (const change of changes) {
          if (change.device_name) devices.add(change.device_name);
          if (change.track_name) tracks.add(change.track_name);
        }
        setActivity((current) => ({
          ...current,
          [take.id]: {
            status: "ready",
            moves: changes.length,
            devices: devices.size,
            tracks: tracks.size,
          },
        }));
      } catch {
        setActivity((current) => ({ ...current, [take.id]: { status: "error" } }));
      }
    })();
  }, []);

  useEffect(() => {
    if (selected) {
      loadSchema(selected);
      loadActivity(selected);
    }
    if (previous) {
      loadSchema(previous);
      loadActivity(previous);
    }
  }, [selected, previous, loadSchema, loadActivity]);

  async function runAction(label: string, action: () => Promise<void>) {
    setBusyLabel(label);
    setError(null);
    try {
      await action();
    } catch (actionError) {
      setError(String(actionError));
    } finally {
      setBusyLabel(null);
    }
  }

  if (!project) {
    return (
      <div className="versions">
        <header className="versions__bar">
          <button type="button" className="px-btn" onClick={onBack}>
            <BackIcon />
            Projects
          </button>
        </header>
        <div className="versions__empty">
          <strong>Project not found.</strong>
          <p>It may have been archived or removed. Head back to your projects.</p>
        </div>
      </div>
    );
  }

  const hasFolder = Boolean(project.ableton_path);

  return (
    <div className="versions">
      <header className="versions__bar">
        <div className="versions__crumb">
          <button type="button" className="px-btn" onClick={onBack}>
            <BackIcon />
            Projects
          </button>
          <div className="versions__title">
            <h1>{project.display_name}</h1>
            <span className="versions__subtitle">
              {takes.length} {takes.length === 1 ? "version" : "versions"}
              {hasFolder && project.ableton_path ? (
                <span className="versions__folder" title={project.ableton_path}>
                  {" · "}
                  {project.ableton_path}
                </span>
              ) : (
                " · no Ableton folder connected"
              )}
            </span>
          </div>
        </div>

        <div className="versions__tools">
          {hasFolder && (
            <button
              type="button"
              className="px-btn"
              disabled={busy}
              onClick={() =>
                void runAction("Checking folder for new versions...", () =>
                  onRescanFolder(project.id).then(() => undefined),
                )
              }
            >
              Check for new versions
            </button>
          )}
          <button
            type="button"
            className="px-btn px-btn--primary"
            disabled={busy}
            title={
              connection.connected
                ? "Resume the take for the version open in Ableton"
                : "Ableton isn't connected — opens the most recent take"
            }
            onClick={() => void runAction("Opening take...", () => onOpenProject(project.id))}
          >
            {connection.connected ? "Open live take" : "Open latest take"}
          </button>
        </div>
      </header>

      {(busyLabel || error) && (
        <div className={`versions__notice ${error ? "versions__notice--error" : ""}`}>
          {error ?? busyLabel}
        </div>
      )}

      {takes.length === 0 ? (
        <div className="versions__empty">
          <strong>No versions yet.</strong>
          {hasFolder ? (
            <p>Recall found no .als files in this project's folder. Save the set in Ableton, then check again.</p>
          ) : (
            <p>Connect this project's Ableton folder and Recall will find every saved version of the set.</p>
          )}
          <button
            type="button"
            className="px-btn px-btn--primary"
            disabled={busy}
            onClick={() =>
              void runAction(
                hasFolder ? "Checking folder..." : "Connecting folder...",
                () =>
                  (hasFolder
                    ? onRescanFolder(project.id)
                    : onConnectFolder(project.id)
                  ).then(() => undefined),
              )
            }
          >
            {hasFolder ? "Check folder" : "Connect Ableton folder"}
          </button>
        </div>
      ) : (
        <>
        <section className="versions__graph" aria-label="Version lineage">
          <VersionGraphView
            versions={versions}
            selectedVersionId={selectedVersionId}
            onSelectVersion={(versionId) => {
              const version = versions.find((candidate) => candidate.id === versionId);
              // Selecting a version means selecting the sitting a producer would
              // expect to land on: the most recent one against that file.
              const latest = version?.sessions[version.sessions.length - 1];
              if (latest) setSelectedTakeId(latest.id);
            }}
          />
        </section>
        <div className="versions__body">
          <nav className="version-rail" aria-label="Project versions">
            {takes.map((take, index) => (
              <VersionRailItem
                key={take.id}
                take={take}
                latest={index === 0}
                selected={take.id === selected?.id}
                onSelect={() => setSelectedTakeId(take.id)}
              />
            ))}
          </nav>

          {selected && (
            <VersionDetail
              take={selected}
              previous={previous}
              schemaState={schemas[selected.id] ?? { status: "loading" }}
              previousSchemaState={previous ? schemas[previous.id] ?? { status: "loading" } : null}
              activityState={
                selected.take_origin === "scanned"
                  ? null
                  : activity[selected.id] ?? { status: "loading" }
              }
              previousActivityState={
                previous && previous.take_origin !== "scanned"
                  ? activity[previous.id] ?? { status: "loading" }
                  : null
              }
              busy={busy}
              onOpenTimeline={onOpenTimeline}
              onOpenRecap={onOpenRecap}
              onRelink={() => setRelinkOpen(true)}
              onDelete={() => {
                const confirmed = window.confirm(
                  `Delete this take ("${takeName(selected)}")? This removes its recorded history and cannot be undone.`,
                );
                if (!confirmed) return;
                void runAction("Deleting take...", () => onDeleteCapture(selected.id));
              }}
            />
          )}
        </div>
        </>
      )}

      {relinkOpen && selected && (
        <RelinkDialog
          projectId={project.id}
          currentAlsPath={selected.als_path}
          busy={busy}
          onList={onListProjectAlsFiles}
          onChoose={(alsPath) =>
            runAction("Relinking take...", () => onRelinkTake(selected.id, alsPath))
          }
          onClose={() => setRelinkOpen(false)}
        />
      )}
    </div>
  );
}

function VersionRailItem({
  take,
  latest,
  selected,
  onSelect,
}: {
  take: SavedSessionMetadata;
  latest: boolean;
  selected: boolean;
  onSelect: () => void;
}) {
  const status = takeStatus(take);
  return (
    <button
      type="button"
      className={`vr-item ${selected ? "is-selected" : ""} ${status === "live" ? "is-live" : ""}`}
      onClick={onSelect}
      aria-current={selected ? "true" : undefined}
    >
      <span className="vr-item__node" aria-hidden="true" />
      <span className="vr-item__body">
        <span className="vr-item__top">
          <span className="vr-item__name" title={takeName(take)}>
            {takeName(take)}
          </span>
          <StatusBadge status={status} />
        </span>
        <span className="vr-item__meta">
          {formatSessionDate(take.started_at_ms)}
          {take.take_origin !== "scanned" && take.creative_event_count > 0 && (
            <>
              {" · "}
              {take.creative_event_count} {take.creative_event_count === 1 ? "moment" : "moments"}
            </>
          )}
          {latest && <span className="vr-item__latest"> · latest</span>}
        </span>
      </span>
    </button>
  );
}

function VersionDetail({
  take,
  previous,
  schemaState,
  previousSchemaState,
  activityState,
  previousActivityState,
  busy,
  onOpenTimeline,
  onOpenRecap,
  onRelink,
  onDelete,
}: {
  take: SavedSessionMetadata;
  previous: SavedSessionMetadata | null;
  schemaState: SchemaState;
  previousSchemaState: SchemaState | null;
  activityState: ActivityState | null;
  previousActivityState: ActivityState | null;
  busy: boolean;
  onOpenTimeline: (sessionId: string) => void;
  onOpenRecap: (sessionId: string) => void;
  onRelink: () => void;
  onDelete: () => void;
}) {
  const status = takeStatus(take);
  const isScanned = take.take_origin === "scanned";

  return (
    <section className="version-detail" aria-label={`Version ${takeName(take)}`}>
      <header className="vd-head">
        <div className="vd-head__id">
          <h2 title={takeName(take)}>{takeName(take)}</h2>
          <StatusBadge status={status} />
        </div>
        <span className="vd-head__meta">
          {formatSessionDate(take.started_at_ms)}
          {!isScanned && (
            <>
              {" · "}
              {formatSessionDuration(take)}
            </>
          )}
          {schemaState.status === "ready" && (
            <>
              {" · "}
              {schemaState.schema.tracks.length}{" "}
              {schemaState.schema.tracks.length === 1 ? "track" : "tracks"}
              {" · "}
              {countDevices(schemaState.schema)}{" "}
              {countDevices(schemaState.schema) === 1 ? "device" : "devices"}
            </>
          )}
        </span>
      </header>

      <ComparePanel
        take={take}
        previous={previous}
        schemaState={schemaState}
        previousSchemaState={previousSchemaState}
      />

      <section className="vd-card" aria-label="Recorded activity">
        <h3>Recorded activity</h3>
        {isScanned ? (
          <p className="vd-card__quiet">
            No recorded activity — this version was found on disk. Recall wasn't listening while it
            was made. Open it in Ableton with the bridge on and new moves will land here.
          </p>
        ) : activityState === null || activityState.status === "loading" ? (
          <p className="vd-card__quiet">Reading recorded activity…</p>
        ) : activityState.status === "error" ? (
          <p className="vd-card__quiet">Couldn't read this take's recorded activity.</p>
        ) : (
          <>
            <div className="vd-stats">
              <div className="vd-stat">
                <strong>{take.creative_event_count}</strong>
                <span>{take.creative_event_count === 1 ? "moment" : "moments"}</span>
              </div>
              <div className="vd-stat">
                <strong>{activityState.moves}</strong>
                <span>sound &amp; mix moves</span>
              </div>
              <div className="vd-stat">
                <strong>{activityState.devices}</strong>
                <span>{activityState.devices === 1 ? "device touched" : "devices touched"}</span>
              </div>
              <div className="vd-stat">
                <strong>{activityState.tracks}</strong>
                <span>{activityState.tracks === 1 ? "track touched" : "tracks touched"}</span>
              </div>
            </div>
            {previous && previousActivityState?.status === "ready" && (
              <ActivityMoveComparison
                currentMoves={activityState.moves}
                previousMoves={previousActivityState.moves}
                previousName={takeName(previous)}
              />
            )}
            <div className="vd-card__actions">
              <button type="button" className="px-btn" disabled={busy} onClick={() => onOpenTimeline(take.id)}>
                Open timeline
              </button>
              <button type="button" className="px-btn" disabled={busy} onClick={() => onOpenRecap(take.id)}>
                Report
              </button>
            </div>
          </>
        )}
      </section>

      <section className="vd-card" aria-label="Take file">
        <h3>This version</h3>
        <dl className="vd-file">
          <div>
            <dt>File</dt>
            <dd>
              {take.als_path ? (
                <span className="vd-file__path" title={take.als_path}>
                  {fileName(take.als_path)}
                </span>
              ) : (
                <span className="vd-card__quiet">Not linked to a file</span>
              )}
            </dd>
          </div>
          <div>
            <dt>Origin</dt>
            <dd>{isScanned ? "Found on disk" : "Captured live"}</dd>
          </div>
          {take.als_path && (
            <div className="vd-file__full">
              <dt>Location</dt>
              <dd>
                <span className="vd-file__path vd-file__path--full" title={take.als_path}>
                  {take.als_path}
                </span>
              </dd>
            </div>
          )}
        </dl>
        <div className="vd-card__actions">
          <button type="button" className="px-btn" disabled={busy} onClick={onRelink}>
            Relink to file…
          </button>
          <button type="button" className="px-btn px-btn--danger" disabled={busy} onClick={onDelete}>
            Delete take
          </button>
        </div>
      </section>
    </section>
  );
}

function ActivityMoveComparison({
  currentMoves,
  previousMoves,
  previousName,
}: {
  currentMoves: number;
  previousMoves: number;
  previousName: string;
}) {
  const largest = Math.max(currentMoves, previousMoves, 1);
  const change = currentMoves - previousMoves;
  const changeLabel = change === 0 ? "same amount of activity" : `${change > 0 ? "+" : ""}${change} moves`;

  return (
    <div
      className="vd-activity-compare"
      role="img"
      aria-label={`${currentMoves} recorded sound and mix moves in this version, ${changeLabel} compared with ${previousName}`}
    >
      <div className="vd-activity-compare__head">
        <span>Mix activity vs. previous</span>
        <strong>{changeLabel}</strong>
      </div>
      <div className="vd-activity-compare__row">
        <span>This version</span>
        <div className="vd-activity-compare__track" aria-hidden="true">
          <i style={{ width: `${(currentMoves / largest) * 100}%` }} />
        </div>
        <b>{currentMoves}</b>
      </div>
      <div className="vd-activity-compare__row is-previous">
        <span title={previousName}>Previous</span>
        <div className="vd-activity-compare__track" aria-hidden="true">
          <i style={{ width: `${(previousMoves / largest) * 100}%` }} />
        </div>
        <b>{previousMoves}</b>
      </div>
    </div>
  );
}

function ComparePanel({
  take,
  previous,
  schemaState,
  previousSchemaState,
}: {
  take: SavedSessionMetadata;
  previous: SavedSessionMetadata | null;
  schemaState: SchemaState;
  previousSchemaState: SchemaState | null;
}) {
  return (
    <section className="vd-card vd-card--compare" aria-label="What changed">
      <h3>
        What changed
        {previous && <span className="vd-card__vs"> vs {takeName(previous)}</span>}
      </h3>
      <CompareBody
        take={take}
        previous={previous}
        schemaState={schemaState}
        previousSchemaState={previousSchemaState}
      />
    </section>
  );
}

function CompareBody({
  take,
  previous,
  schemaState,
  previousSchemaState,
}: {
  take: SavedSessionMetadata;
  previous: SavedSessionMetadata | null;
  schemaState: SchemaState;
  previousSchemaState: SchemaState | null;
}) {
  if (!previous) {
    return (
      <p className="vd-card__quiet">
        This is the earliest version Recall knows for this project — nothing older to compare with.
      </p>
    );
  }

  if (schemaState.status === "loading" || previousSchemaState?.status === "loading") {
    return <p className="vd-card__quiet">Reading version structure…</p>;
  }

  if (schemaState.status === "ready" && previousSchemaState?.status === "ready") {
    const diff = compareSchemas(previousSchemaState.schema, schemaState.schema);
    if (diffIsEmpty(diff)) {
      return (
        <p className="vd-card__quiet">
          Same tracks and devices as {takeName(previous)}. Parameter and clip compare isn't built
          yet, so smaller moves won't show here.
        </p>
      );
    }
    return <DiffList diff={diff} />;
  }

  // At least one side has no structure snapshot — say exactly which, and what
  // would fix it. Never invent a diff.
  return (
    <div className="vd-compare-missing">
      <p className="vd-card__quiet">Snapshot needed to compare structure.</p>
      <ul className="vd-compare-missing__list">
        <SnapshotStatusLine take={take} state={schemaState} />
        <SnapshotStatusLine take={previous} state={previousSchemaState} />
      </ul>
      <p className="vd-card__hint">
        Open a version in Ableton with the bridge running and Recall snapshots its structure.
      </p>
    </div>
  );
}

function SnapshotStatusLine({
  take,
  state,
}: {
  take: SavedSessionMetadata;
  state: SchemaState | null;
}) {
  const ok = state?.status === "ready";
  return (
    <li className={ok ? "is-ok" : ""}>
      <span className="vd-compare-missing__name" title={takeName(take)}>
        {takeName(take)}
      </span>
      <span className="vd-compare-missing__state">
        {ok
          ? "structure captured"
          : state?.status === "error"
            ? "couldn't read structure"
            : "no structure snapshot"}
      </span>
    </li>
  );
}

function DiffList({ diff }: { diff: VersionDiff }) {
  return (
    <ul className="vd-diff">
      {diff.addedTracks.map((name) => (
        <li key={`track-add-${name}`} className="vd-diff__item vd-diff__item--add">
          <span className="vd-diff__sign">+</span>
          Added track <strong>{name}</strong>
        </li>
      ))}
      {diff.removedTracks.map((name) => (
        <li key={`track-del-${name}`} className="vd-diff__item vd-diff__item--del">
          <span className="vd-diff__sign">−</span>
          Removed track <strong>{name}</strong>
        </li>
      ))}
      {diff.addedDevices.map((change, index) => (
        <li key={`device-add-${index}`} className="vd-diff__item vd-diff__item--add">
          <span className="vd-diff__sign">+</span>
          Added <strong>{change.device}</strong> on {change.track}
        </li>
      ))}
      {diff.removedDevices.map((change, index) => (
        <li key={`device-del-${index}`} className="vd-diff__item vd-diff__item--del">
          <span className="vd-diff__sign">−</span>
          Removed <strong>{change.device}</strong> from {change.track}
        </li>
      ))}
    </ul>
  );
}

type TakeStatus = "live" | "recorded" | "found";

function takeStatus(take: SavedSessionMetadata): TakeStatus {
  if (take.take_origin === "scanned") return "found";
  if (take.ended_at_ms === null) return "live";
  return "recorded";
}

const STATUS_LABEL: Record<TakeStatus, string> = {
  live: "Live",
  recorded: "Recorded",
  found: "On disk",
};

function StatusBadge({ status }: { status: TakeStatus }) {
  return <span className={`v-badge v-badge--${status}`}>{STATUS_LABEL[status]}</span>;
}

function takeName(take: SavedSessionMetadata): string {
  return preferredCaptureTitle(take) ?? "Untitled capture";
}

function fileName(path: string): string {
  const segments = path.split(/[\\/]/);
  return segments[segments.length - 1] || path;
}

function BackIcon() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
      <path d="M10 3L5 8l5 5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
