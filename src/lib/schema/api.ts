// Tauri command wrappers for the normalized schema + creative-memory layer.
// Command argument keys are camelCase here; Tauri maps them to the snake_case
// Rust parameters (e.g. `sessionId` -> `session_id`). Return values are the raw
// serde JSON (snake_case), typed by src/types/schema.ts.

import { invoke } from "@tauri-apps/api/core";
import type {
  Confidence,
  CreativeMoment,
  CreativeMomentTarget,
  MomentType,
  NoteEdit,
  ParameterChange,
  ProjectSchema,
  TimelineClipEvent,
} from "../../types/schema";
import type { SavedSession } from "../../types/recall";

/** Rebuild the normalized tables for a session from its event log. */
export function materializeSessionSchema(sessionId: string): Promise<void> {
  return invoke<void>("materialize_session_schema", { sessionId });
}

/** Write a UTF-8 text document to a user-chosen path (used by share/export). */
export function writeTextFile(path: string, contents: string): Promise<void> {
  return invoke<void>("write_text_file", { path, contents });
}

export function getProjectSchema(sessionId: string): Promise<ProjectSchema> {
  return invoke<ProjectSchema>("get_project_schema", { sessionId });
}

export function getParameterChanges(sessionId: string): Promise<ParameterChange[]> {
  return invoke<ParameterChange[]>("get_parameter_changes", { sessionId });
}

export function getNoteEdits(sessionId: string): Promise<NoteEdit[]> {
  return invoke<NoteEdit[]>("get_note_edits", { sessionId });
}

/** Audio/sample drops and newly created clips, for timeline activity density. */
export function getTimelineClipEvents(sessionId: string): Promise<TimelineClipEvent[]> {
  return invoke<TimelineClipEvent[]>("get_timeline_clip_events", { sessionId });
}

/**
 * When each `.als` was made, straight off the filesystem.
 *
 * A version's birth used to be its first capture, which is a birth date only if
 * Recall was watching when the file was created. Read live rather than stored: a
 * file's age is a fact about the disk, and copying or restoring a set changes
 * it, so a cached copy would go stale silently.
 */
export function getAlsFileTimes(paths: string[]): Promise<StoredAlsFileTimes[]> {
  return invoke<StoredAlsFileTimes[]>("get_als_file_times", { paths });
}

export type StoredAlsFileTimes = {
  path: string;
  created_ms: number | null;
  modified_ms: number | null;
};

/**
 * One version's captures in a single crossing.
 *
 * Opening a version used to be six calls per capture plus one for the saves —
 * 71 IPC round trips for a nine-capture version. The rows are identical; the
 * backend simply assembles them before they cross, so nothing here summarises
 * or trims. See `load_version_bundle` in storage.rs.
 */
export function loadVersionBundleRows(sessionIds: string[]): Promise<StoredVersionBundle> {
  return invoke<StoredVersionBundle>("load_version_bundle", { sessionIds });
}

export type StoredCaptureBundle = {
  session: SavedSession;
  schema: ProjectSchema;
  changes: ParameterChange[];
  note_edits: NoteEdit[];
  clip_events: TimelineClipEvent[];
  moments: CreativeMoment[];
};

export type StoredVersionBundle = {
  captures: StoredCaptureBundle[];
  saves: StoredObservedSave[];
};

/**
 * Saves the control surface watched, across a set of captures. Oldest first.
 *
 * The only evidence in the version graph that is observed rather than inferred:
 * Live exposes no save callback, so the remote script watches the open `.als`'s
 * modification stamp and emits `project_saved` when it moves.
 */
export function getObservedSaves(sessionIds: string[]): Promise<StoredObservedSave[]> {
  return invoke<StoredObservedSave[]>("get_observed_saves", { sessionIds });
}

export type StoredObservedSave = {
  id: string;
  session_id: string;
  als_path: string | null;
  saved_at_ms: number;
};

/** Complete immutable event record for producer-facing timeline context. */
export function loadSessionEvents(sessionId: string): Promise<SavedSession> {
  return invoke<SavedSession>("load_session_events", { sessionId });
}

export function listCreativeMoments(sessionId: string): Promise<CreativeMoment[]> {
  return invoke<CreativeMoment[]>("list_creative_moments", { sessionId });
}

export type CreateMomentInput = {
  id: string;
  sessionId: string;
  title: string;
  momentType: MomentType;
  timelineStartMs?: number | null;
  timelineEndMs?: number | null;
  note?: string | null;
  tags: string[];
  confidence: Confidence;
  targets: CreativeMomentTarget[];
};

export function createCreativeMoment(input: CreateMomentInput): Promise<void> {
  return invoke<void>("create_creative_moment", {
    id: input.id,
    sessionId: input.sessionId,
    title: input.title,
    momentType: input.momentType,
    timelineStartMs: input.timelineStartMs ?? null,
    timelineEndMs: input.timelineEndMs ?? null,
    note: input.note ?? null,
    tags: input.tags,
    confidence: input.confidence,
    targets: input.targets,
  });
}

export function deleteCreativeMoment(id: string): Promise<void> {
  return invoke<void>("delete_creative_moment", { id });
}
