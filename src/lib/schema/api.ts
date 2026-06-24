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
  ParameterChange,
  ProjectSchema,
} from "../../types/schema";

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

export type UpdateMomentInput = {
  id: string;
  title: string;
  momentType: MomentType;
  timelineStartMs?: number | null;
  timelineEndMs?: number | null;
  note?: string | null;
  tags: string[];
  confidence: Confidence;
};

export function updateCreativeMoment(input: UpdateMomentInput): Promise<void> {
  return invoke<void>("update_creative_moment", {
    id: input.id,
    title: input.title,
    momentType: input.momentType,
    timelineStartMs: input.timelineStartMs ?? null,
    timelineEndMs: input.timelineEndMs ?? null,
    note: input.note ?? null,
    tags: input.tags,
    confidence: input.confidence,
  });
}

export function deleteCreativeMoment(id: string): Promise<void> {
  return invoke<void>("delete_creative_moment", { id });
}

export function setCreativeMomentTargets(
  momentId: string,
  targets: CreativeMomentTarget[],
): Promise<void> {
  return invoke<void>("set_creative_moment_targets", { momentId, targets });
}
