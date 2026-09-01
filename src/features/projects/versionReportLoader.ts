import {
  getNoteEdits,
  getParameterChanges,
  getProjectSchema,
  getObservedSaves,
  getTimelineClipEvents,
  listCreativeMoments,
  loadSessionEvents,
  materializeSessionSchema,
} from "../../lib/schema/api";
import {
  buildVersionReport,
  type SessionReport,
  type SessionReportInput,
} from "./sessionReport";
import {
  buildReportPreview,
  isReportPreviewSession,
  reportPreviewInput,
} from "./sessionReportPreview";
import { buildVersionDepth, type VersionDepth } from "./versionDepth";

async function loadCapture(sessionId: string): Promise<SessionReportInput> {
  await materializeSessionSchema(sessionId);
  const [session, schema, changes, noteEdits, clipEvents, moments] = await Promise.all([
    loadSessionEvents(sessionId),
    getProjectSchema(sessionId),
    getParameterChanges(sessionId),
    getNoteEdits(sessionId),
    getTimelineClipEvents(sessionId),
    listCreativeMoments(sessionId),
  ]);
  return { session, schema, changes, noteEdits, clipEvents, moments };
}

/** Reads every sitting belonging to one .als version as one unit of work. */
export async function loadVersionReport(sessionIds: string[]): Promise<SessionReport> {
  if (import.meta.env.DEV && sessionIds.some(isReportPreviewSession)) {
    return buildReportPreview(sessionIds[0]!);
  }
  const captures = await Promise.all(sessionIds.map(loadCapture));
  return buildVersionReport(captures);
}

/**
 * Everything the Timeline shows about one version, in one read.
 *
 * The parent's newest sitting is loaded too, and only that one: the diff needs
 * the state the parent version ENDED in, not its whole history, so pulling the
 * parent's other sittings would be work whose result is thrown away.
 */
export async function loadVersionDepth(
  sessionIds: string[],
  parent: { name: string; sessionId: string | null } | null,
): Promise<VersionDepth> {
  if (import.meta.env.DEV && sessionIds.some(isReportPreviewSession)) {
    return buildVersionDepth({
      captures: sessionIds.map(reportPreviewInput),
      parent: parent
        ? {
            name: parent.name,
            capture: parent.sessionId && isReportPreviewSession(parent.sessionId)
              ? reportPreviewInput(parent.sessionId)
              : null,
          }
        : null,
      saves: [],
    });
  }

  const [captures, parentCapture, saves] = await Promise.all([
    Promise.all(sessionIds.map(loadCapture)),
    parent?.sessionId ? loadCapture(parent.sessionId) : Promise.resolve(null),
    // One query for the whole version rather than one per sitting: the rows
    // carry their own session_id, so the split happens in the model.
    getObservedSaves(sessionIds).catch(() => []),
  ]);

  return buildVersionDepth({
    captures,
    parent: parent ? { name: parent.name, capture: parentCapture } : null,
    saves: saves.map((save) => ({ sessionId: save.session_id, savedAtMs: save.saved_at_ms })),
  });
}
