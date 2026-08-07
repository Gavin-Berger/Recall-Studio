import { useEffect, useMemo, useState } from "react";
import "./ProjectBriefingScreen.css";
import { getParameterChanges, getProjectSchema, materializeSessionSchema } from "../../lib/schema/api";
import { buildLookups, deviceColor, trackColor } from "../../components/schema/timeline";
import { DEVICE_ROLE_LABEL } from "../../types";
import type {
  DeviceRole,
  ParameterChange,
  ParameterObj,
  ProjectSchema,
  TrackObj,
  TrackType,
} from "../../types/schema";
import type { SavedProject, SavedSessionMetadata } from "../../types/recall";
import { abletonSetName, alsSetName, formatSessionDate } from "../sessionFormat";
import {
  buildSittings,
  groupByTrack,
  splitTracksBySurvival,
  storyLedger,
  type StoryActivity,
} from "./songStory";
import { ContributionRecord } from "./ContributionRecord";

type ProjectBriefingScreenProps = {
  project: SavedProject | null;
  onBack: () => void;
  onOpenAllVersions: () => void;
  onOpenTimeline: (sessionId: string) => void;
};

type LoadState = "idle" | "loading" | "ready" | "error";

// The take whose snapshot stands for the project's current shape: the most
// recently updated capture that actually has activity. A freshly scanned .als
// version (take_origin "scanned", no moves yet) is skipped so the board reflects
// real work, not an empty baseline — unless that's all there is.
function pickLatestTake(captures: SavedSessionMetadata[]): SavedSessionMetadata | null {
  if (captures.length === 0) return null;
  const byRecency = [...captures].sort((a, b) => b.last_updated_at_ms - a.last_updated_at_ms);
  return byRecency.find((take) => take.creative_event_count > 0) ?? byRecency[0];
}

// Rough, human "when" for the orientation line — precise enough to place a
// session in memory ("3 days ago"), not a clock.
function timeAgo(ms: number): string {
  const delta = Date.now() - ms;
  const hour = 3_600_000;
  const day = 86_400_000;
  if (delta < hour) return "in the last hour";
  if (delta < day) return `${Math.round(delta / hour)}h ago`;
  const days = Math.round(delta / day);
  if (days <= 1) return "yesterday";
  if (days < 14) return `${days} days ago`;
  return formatSessionDate(ms);
}

// A parameter change carries only its id, so resolve device role by walking the
// schema once and mapping every parameter (and nested macro child) to the role
// of its device. Lets the story classifier tell a synth tweak from an EQ move.
function collectParamRoles(param: ParameterObj, role: DeviceRole, into: Map<string, DeviceRole>) {
  into.set(param.id, role);
  for (const child of param.children) collectParamRoles(child, role, into);
}

type TrackCard = {
  track: TrackObj;
  moveCount: number;
  lastTouchedMs: number | null;
  // active  — moved in the latest take
  // quiet   — in the project, but untouched in the latest take
  // empty   — no devices and nothing recorded (a hole in the arrangement)
  state: "active" | "quiet" | "empty";
};

function ProjectsIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true">
      <rect x="4" y="4" width="6" height="6" rx="1" />
      <rect x="14" y="4" width="6" height="6" rx="1" />
      <rect x="4" y="14" width="6" height="6" rx="1" />
      <rect x="14" y="14" width="6" height="6" rx="1" />
    </svg>
  );
}

function VersionHistoryIcon() {
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true">
      <path d="M4 12a8 8 0 1 0 2.2-5.5" />
      <path d="M4 5.5v4.3h4.3" />
      <path d="M12 8v4.5l3 1.8" />
    </svg>
  );
}

function ResumeIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true">
      <path d="M8 5.7a1 1 0 0 1 1.52-.86l8.1 5.3a1 1 0 0 1 0 1.68l-8.1 5.3A1 1 0 0 1 8 16.28V5.7Z" />
    </svg>
  );
}

export function ProjectBriefingScreen({
  project,
  onBack,
  onOpenAllVersions,
  onOpenTimeline,
}: ProjectBriefingScreenProps) {
  const [schema, setSchema] = useState<ProjectSchema | null>(null);
  const [changes, setChanges] = useState<ParameterChange[]>([]);
  const [allChanges, setAllChanges] = useState<ParameterChange[] | null>(null);
  const [status, setStatus] = useState<LoadState>("idle");
  const [error, setError] = useState<string | null>(null);

  const captures = useMemo(() => project?.captures ?? [], [project]);
  const latestTake = useMemo(() => pickLatestTake(captures), [captures]);
  const latestTakeId = latestTake?.id ?? null;

  useEffect(() => {
    if (!latestTakeId) {
      setSchema(null);
      setChanges([]);
      setStatus("idle");
      return;
    }

    let cancelled = false;
    setStatus("loading");
    setError(null);

    (async () => {
      try {
        await materializeSessionSchema(latestTakeId);
        const [nextSchema, nextChanges] = await Promise.all([
          getProjectSchema(latestTakeId),
          getParameterChanges(latestTakeId),
        ]);
        if (cancelled) return;
        setSchema(nextSchema);
        setChanges(nextChanges);
        setStatus("ready");
      } catch (loadError) {
        if (cancelled) return;
        setError(String(loadError));
        setStatus("error");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [latestTakeId]);

  // The full project history, aggregated across every take — the arc and the
  // survived-vs-cut split need the whole life of the project, not just the latest
  // take. Best-effort: if any take can't be read, the story falls back to the
  // latest take alone rather than showing nothing.
  useEffect(() => {
    if (captures.length === 0) {
      setAllChanges(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const perTake = await Promise.all(
          captures.map(async (take) => {
            await materializeSessionSchema(take.id);
            return getParameterChanges(take.id);
          }),
        );
        if (!cancelled) setAllChanges(perTake.flat());
      } catch {
        if (!cancelled) setAllChanges(null);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [captures]);

  const lookups = useMemo(() => buildLookups(schema), [schema]);

  // Per-track activity from the latest take: how many moves landed on it and
  // when the last one was. Cross-take recency ("untouched 6 days") arrives with
  // the diff slice; for now this is honestly scoped to the most recent take.
  const trackStats = useMemo(() => {
    const stats = new Map<string, { count: number; lastMs: number }>();
    for (const change of changes) {
      const trackId =
        (change.parameter_id ? lookups.paramTrack.get(change.parameter_id) : undefined) ??
        (change.track_name ? lookups.nameTrack.get(change.track_name.toLowerCase()) : undefined);
      if (!trackId) continue;
      const current = stats.get(trackId) ?? { count: 0, lastMs: 0 };
      current.count += 1;
      current.lastMs = Math.max(current.lastMs, change.changed_at_ms);
      stats.set(trackId, current);
    }
    return stats;
  }, [changes, lookups]);

  const cards = useMemo<TrackCard[]>(() => {
    if (!schema) return [];
    const rank = (type: string) => (type === "master" ? 2 : type === "return" ? 1 : 0);
    return [...schema.tracks]
      .sort((a, b) => rank(a.type) - rank(b.type) || a.number - b.number)
      .map((track) => {
        const stat = trackStats.get(track.id);
        const moveCount = stat?.count ?? 0;
        const hasDevices = track.devices.length > 0;
        const state: TrackCard["state"] =
          moveCount > 0 ? "active" : hasDevices ? "quiet" : "empty";
        return {
          track,
          moveCount,
          lastTouchedMs: stat?.lastMs ?? null,
          state,
        };
      });
  }, [schema, trackStats]);

  // Role/type resolution for the story classifier, built once per schema.
  const paramMeta = useMemo(() => {
    const roles = new Map<string, DeviceRole>();
    const typeByName = new Map<string, TrackType>();
    if (schema) {
      for (const track of schema.tracks) {
        if (track.name) typeByName.set(track.name.toLowerCase(), track.type);
        for (const device of track.devices) {
          for (const param of device.parameters) collectParamRoles(param, device.role, roles);
        }
      }
    }
    return { roles, typeByName };
  }, [schema]);

  // The contribution record: the arc (sittings), the labour ledger, and the
  // net-change recap. Prefer the whole-project history; fall back to the latest
  // take alone while the cross-take load is in flight or if it fails.
  const storyChanges = allChanges ?? changes;

  // Track names in the latest take's schema — the delivered shape. Anything
  // worked but absent here is "cut": labour, not credit (DESIGN discussion).
  const currentTrackNames = useMemo(() => {
    const names = new Set<string>();
    if (schema) {
      for (const track of schema.tracks) {
        if (track.name) names.add(track.name.toLowerCase());
      }
    }
    return names;
  }, [schema]);

  const sittings = useMemo(() => {
    const activities: StoryActivity[] = storyChanges.map((change) => ({
      atMs: change.changed_at_ms,
      trackName: change.track_name,
      trackId: change.track_id,
      deviceName: change.device_name,
      role: change.parameter_id ? paramMeta.roles.get(change.parameter_id) ?? null : null,
      trackType: change.track_name
        ? paramMeta.typeByName.get(change.track_name.toLowerCase()) ?? null
        : null,
      kind: "move" as const,
    }));
    return buildSittings(activities);
  }, [storyChanges, paramMeta]);

  const ledger = useMemo(() => storyLedger(sittings), [sittings]);
  const { survived: survivedTracks, cut: removedTracks } = useMemo(
    () => splitTracksBySurvival(groupByTrack(storyChanges), currentTrackNames),
    [storyChanges, currentTrackNames],
  );

  // The set identity for the record, pulled from the latest take's .als filename
  // (falling back to Ableton's live LOM name). Grounds "captured live" in the
  // actual Live Set the work happened in.
  const setName = useMemo(
    () => alsSetName(latestTake?.als_path) ?? abletonSetName(latestTake ?? null),
    [latestTake],
  );

  const lastWorkedMs = latestTake?.last_updated_at_ms ?? null;
  const firstTakeMs = useMemo(
    () => (captures.length ? Math.min(...captures.map((take) => take.started_at_ms)) : null),
    [captures],
  );
  const emptyCount = cards.filter((card) => card.state === "empty").length;

  if (!project) {
    return (
      <div className="brief brief--empty">
        <span className="brief__eyebrow">Project re-entry</span>
        <h1>No project selected.</h1>
        <p>Open a project to see where you left off.</p>
        <button type="button" className="brief__btn brief__btn--primary brief__btn--with-icon" onClick={onBack}>
          <ProjectsIcon />
          Back to projects
        </button>
      </div>
    );
  }

  return (
    <div className="brief">
      <header className="brief__top">
        <div className="brief__id">
          <div className="brief__crumb">
            <button
              type="button"
              className="brief__icon-btn brief__back"
              onClick={onBack}
              aria-label="Back to project library"
              title="Project library"
            >
              <ProjectsIcon />
            </button>
            <span className="brief__eyebrow">Project briefing</span>
          </div>
          <h1 className="brief__title">{project.display_name}</h1>
          <p className="brief__meta">
            {lastWorkedMs ? (
              <>
                Last worked <b>{timeAgo(lastWorkedMs)}</b>
                {" · "}
              </>
            ) : null}
            <span className="brief__num">{captures.length}</span> take
            {captures.length === 1 ? "" : "s"}
            {firstTakeMs && captures.length > 1 ? (
              <>
                {" over "}
                {formatSessionDate(firstTakeMs)}–{formatSessionDate(lastWorkedMs ?? firstTakeMs)}
              </>
            ) : null}
          </p>
        </div>
        <div className="brief__actions">
          <button
            type="button"
            className="brief__icon-btn"
            onClick={onOpenAllVersions}
            aria-label="View all versions"
            title="All versions"
          >
            <VersionHistoryIcon />
          </button>
          {latestTakeId && (
            <button
              type="button"
              className="brief__btn brief__btn--primary brief__btn--with-icon"
              onClick={() => onOpenTimeline(latestTakeId)}
              title="Resume your latest take"
            >
              <ResumeIcon />
              Resume
            </button>
          )}
        </div>
      </header>

      {status === "error" && <div className="brief__error">{error}</div>}

      {status === "ready" && sittings.length > 0 && (
        <ContributionRecord
          setName={setName}
          ledger={ledger}
          sittings={sittings}
          survivedTracks={survivedTracks}
          removedTracks={removedTracks}
        />
      )}

      <section className="brief__section">
        <div className="brief__kick">
          <h2>The project right now</h2>
          <span>
            every track and its current chain
            {latestTake ? <> · from your most recent take</> : null}
          </span>
        </div>

        {status === "loading" && cards.length === 0 ? (
          <p className="brief__hint">Reading the latest take…</p>
        ) : cards.length === 0 ? (
          <p className="brief__hint">
            No tracks captured yet. Open this project in Ableton and make a move — the map builds
            itself from there.
          </p>
        ) : (
          <div className="brief__board">
            {cards.map((card) => {
              const color = trackColor(card.track);
              return (
                <article
                  key={card.track.id}
                  className="brief-card"
                  style={{ ["--tc" as string]: color }}
                >
                  <div className="brief-card__top">
                    <span className="brief-card__name">{card.track.name ?? "Untitled track"}</span>
                    <span className={`brief-state is-${card.state}`}>
                      {card.state === "active"
                        ? "active"
                        : card.state === "empty"
                          ? "empty"
                          : "not this take"}
                    </span>
                  </div>

                  <div className="brief-card__chain">
                    {card.track.devices.length > 0 ? (
                      [...card.track.devices]
                        .sort((a, b) => a.chain_index - b.chain_index)
                        .map((device) => (
                          <span key={device.id} className={`brief-pill ${device.enabled ? "" : "is-off"}`}>
                            <span className="brief-dot" style={{ background: deviceColor(device) }} />
                            {device.name ?? DEVICE_ROLE_LABEL[device.role]}
                          </span>
                        ))
                    ) : (
                      <span className="brief-card__none">No devices yet</span>
                    )}
                  </div>

                  <div className="brief-card__foot">
                    <span className="brief-card__when">
                      {card.lastTouchedMs ? timeAgo(card.lastTouchedMs) : "—"}
                    </span>
                    <span className="brief-card__moves">
                      {card.moveCount > 0 ? (
                        <>
                          <span className="brief__num">{card.moveCount}</span> move
                          {card.moveCount === 1 ? "" : "s"}
                        </>
                      ) : card.state === "empty" ? (
                        "never touched"
                      ) : (
                        "untouched this take"
                      )}
                    </span>
                  </div>
                </article>
              );
            })}
          </div>
        )}

        {emptyCount > 0 && status === "ready" && (
          <p className="brief__footnote">
            <span className="brief__num">{emptyCount}</span> track{emptyCount === 1 ? "" : "s"} with
            nothing on {emptyCount === 1 ? "it" : "them"} yet — likely holes still to fill.
          </p>
        )}
      </section>

    </div>
  );
}
