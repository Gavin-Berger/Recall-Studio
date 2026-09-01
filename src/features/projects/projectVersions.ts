// What a "version" is, and how capture sessions roll up into one.
//
// THE PROBLEM THIS SOLVES
//
// The version picker was listing capture sessions and calling them versions.
// They are not the same thing. A session ends when the app closes, when four
// hours pass idle (`STALE_SESSION_IDLE_MS`), or when a different `.als` opens
// (`rotate_session_if_project_changed`) — none of which is a musical event. So
// one `.als` file collected a row every time any of those happened:
//
//     pers ep nightfall v4 · 7:06 PM · Checkpoint - no captured changes
//     pers ep nightfall v4 · 7:06 PM · Checkpoint - no captured changes
//     pers ep nightfall v4 · 7:09 PM · 11 recorded events
//     pers ep nightfall v4 · 7:17 PM · 23 recorded events
//     pers ep nightfall v4 · 2:01 PM · 178 recorded events
//
// Five entries, one file, work split four ways, two of them empty and
// unreadable. To a producer "v4" is a file they can open, not a login session.
//
// So: a version is the `.als` file. The sessions captured against it are its
// sittings, and the Report reads them as one span.

import type { SavedSessionMetadata } from "../../types/recall";
import { alsSetName } from "../sessionFormat";
import { sittings } from "./sittings";

export type ProjectVersion = {
  /** Stable across reloads: the normalized `.als` path, or the session id. */
  id: string;
  /** What the producer calls it — the `.als` filename without extension. */
  name: string;
  /** Normalized `.als` path, or null for a capture with no file anchor yet. */
  alsPath: string | null;
  /** Every capture against this file, oldest first. Never empty. */
  sessions: SavedSessionMetadata[];
  /** Sessions that recorded at least one event, oldest first. */
  recordedSessions: SavedSessionMetadata[];
  /** When the first capture against this file began. */
  startedAtMs: number;
  /** The last moment any capture against this file was updated. */
  lastUpdatedAtMs: number;
  /** Total events across every sitting. */
  eventCount: number;
  /** Total creative events across every sitting. */
  creativeEventCount: number;
  /** True while any sitting is still open. */
  live: boolean;
};

/**
 * Two captures belong to the same version when they point at the same file.
 *
 * Windows paths arrive with mixed separators and mixed case depending on
 * whether they came from Live, from a scan, or from a relink, so compare
 * normalized. A capture with no `.als` path cannot be grouped with anything —
 * an unsaved set has nothing stable to key on — and stands alone.
 */
export function normalizeAlsPath(path: string | null | undefined): string | null {
  const normalized = path?.replace(/\\/g, "/").trim().toLocaleLowerCase();
  return normalized && normalized !== "0" ? normalized : null;
}

function versionName(sessions: SavedSessionMetadata[]): string {
  for (const session of sessions) {
    const named = alsSetName(session.als_path);
    if (named) return named;
  }
  for (const session of sessions) {
    const fallback = session.display_name?.trim() ?? session.name?.trim();
    if (fallback) return fallback;
  }
  return "Untitled version";
}

/**
 * Roll a project's captures up into the versions a producer would recognise.
 *
 * Ordering is by first capture, oldest first, so the picker reads as the
 * project's history in the order it happened. Sessions inside a version keep
 * the same ordering for the same reason.
 */
export function projectVersions(sessions: SavedSessionMetadata[]): ProjectVersion[] {
  const groups = new Map<string, SavedSessionMetadata[]>();

  for (const session of sessions) {
    const path = normalizeAlsPath(session.als_path);
    // An unanchored capture keys on its own id: it may later be relinked to a
    // file, but until then merging it with anything would be a guess.
    const key = path ?? `session:${session.id}`;
    groups.set(key, [...(groups.get(key) ?? []), session]);
  }

  return [...groups.entries()]
    .map(([key, group]): ProjectVersion => {
      const ordered = [...group].sort((a, b) => a.started_at_ms - b.started_at_ms);
      const first = ordered[0]!;
      return {
        id: key,
        name: versionName(ordered),
        alsPath: normalizeAlsPath(first.als_path),
        sessions: ordered,
        recordedSessions: ordered.filter((session) => session.event_count > 0),
        startedAtMs: first.started_at_ms,
        lastUpdatedAtMs: Math.max(...ordered.map((session) => session.last_updated_at_ms)),
        eventCount: ordered.reduce((total, session) => total + session.event_count, 0),
        creativeEventCount: ordered.reduce((total, session) => total + session.creative_event_count, 0),
        live: ordered.some((session) => session.ended_at_ms === null),
      };
    })
    .sort((a, b) => a.startedAtMs - b.startedAtMs);
}

/** The version a given capture belongs to. */
export function versionForSession(
  versions: ProjectVersion[],
  sessionId: string | null,
): ProjectVersion | null {
  if (!sessionId) return null;
  return versions.find((version) => version.sessions.some((session) => session.id === sessionId)) ?? null;
}

/**
 * Which captures the Report should actually read for a version.
 *
 * Empty sittings are dropped: an anchored session that recorded nothing is a
 * checkpoint, not work, and `close_abandoned_session` only deletes the
 * never-anchored ones so they accumulate. They still count in
 * `version.sessions` — the version knows how many times it was opened — but
 * loading them would add nothing and cost a schema materialization each.
 *
 * A version with no recorded sitting at all falls back to its first session, so
 * the Report has something to render and can say plainly that nothing was
 * captured rather than failing to load.
 */
export function versionSessionsToRead(version: ProjectVersion): SavedSessionMetadata[] {
  return version.recordedSessions.length > 0
    ? version.recordedSessions
    : version.sessions.slice(0, 1);
}

/** How many sittings this version was worked across, for the picker line. */
export function versionSittingCount(version: ProjectVersion): number {
  // Captures are Recall's bookkeeping, not returns to the desk. A bridge
  // reconnect can split one continuous sitting into several captures only
  // milliseconds apart, so counting `recordedSessions` here made the picker
  // confidently overstate how many times the producer came back.
  return sittings(version.sessions).sittings.length;
}
