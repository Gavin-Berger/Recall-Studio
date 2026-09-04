import {
  getNoteEdits,
  getParameterChanges,
  getProjectSchema,
  getTimelineClipEvents,
  loadVersionBundleRows,
  listCreativeMoments,
  loadSessionEvents,
  materializeSessionSchema,
} from "../../lib/schema/api";
import type { StoredCaptureBundle } from "../../lib/schema/api";
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

/**
 * Rename only.
 *
 * The bundle's fields are snake_case because they cross from Rust; the report
 * model is camelCase. Nothing is dropped, defaulted or reshaped — a batch read
 * that also trims is how a read path quietly starts losing information.
 */
function asReportInput(capture: StoredCaptureBundle): SessionReportInput {
  return {
    session: capture.session,
    schema: capture.schema,
    changes: capture.changes,
    noteEdits: capture.note_edits,
    clipEvents: capture.clip_events,
    moments: capture.moments,
  };
}

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

  // Two crossings for the whole version: its own captures, and the parent's
  // final sitting for the diff. It was six per capture plus one — 71 for a
  // nine-capture version, each with its own serialize, bridge hop and parse.
  const [bundle, parentBundle] = await Promise.all([
    loadVersionBundleRows(sessionIds),
    parent?.sessionId
      ? loadVersionBundleRows([parent.sessionId])
      : Promise.resolve(null),
  ]);

  return buildVersionDepth({
    captures: bundle.captures.map(asReportInput),
    parent: parent
      ? {
          name: parent.name,
          capture: parentBundle?.captures[0] ? asReportInput(parentBundle.captures[0]) : null,
        }
      : null,
    saves: bundle.saves.map((save) => ({
      sessionId: save.session_id,
      savedAtMs: save.saved_at_ms,
    })),
  });
}
