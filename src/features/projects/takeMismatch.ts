// Notice when the running take is filing into a different song than the one
// Ableton actually has open.
//
// A capture's project binding is permanent once set (storage.rs attaches
// project_id only "WHERE project_id IS NULL"), but the session's
// project_name/project_path keep tracking whatever set Ableton reports. So the
// two drift apart the moment a producer opens a different project — and every
// move they make lands under the previous song without a word.
//
// This compares the two and says so. It is deliberately conservative: a false
// alarm would teach producers to ignore the warning, so when the evidence is
// ambiguous it reports nothing rather than guessing (DESIGN.md §1 — Recall
// never pretends, which cuts both ways).

import type { SavedProject, SavedSessionMetadata } from "../../types";

export type TakeMismatch = {
  /** The Ableton set that is actually open right now. */
  openName: string;
  /** The project this take is still recording into. */
  boundName: string;
};

/**
 * Reduce an Ableton path to a comparable project-folder key. A live capture
 * reports the `.als` file; a connected project may store the folder. Both
 * collapse to the same key. Mirrors `project_folder_key` in storage.rs.
 */
export function abletonFolderKey(path: string | null | undefined): string | null {
  if (typeof path !== "string") return null;
  const trimmed = path.trim();
  if (!trimmed) return null;

  const normalized = trimmed.replace(/\\/g, "/");
  const isAlsFile = /\.als$/i.test(normalized);
  const folder = isAlsFile
    ? normalized.slice(0, normalized.lastIndexOf("/"))
    : normalized;

  const key = folder.replace(/\/+$/, "").toLowerCase();
  return key || null;
}

function cleanName(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export function detectTakeMismatch(
  activeSession: SavedSessionMetadata | null,
  projects: SavedProject[],
): TakeMismatch | null {
  if (!activeSession) return null;

  // An unbound take is fine — the next event from Ableton binds it correctly.
  if (!activeSession.project_id) return null;

  const bound = projects.find((project) => project.id === activeSession.project_id);
  if (!bound) return null;

  const openKey = abletonFolderKey(activeSession.project_path);
  const boundKey = abletonFolderKey(bound.ableton_path);

  let drifted: boolean;
  if (openKey && boundKey) {
    // Strongest signal: two real paths that point at different folders.
    drifted = openKey !== boundKey;
  } else {
    // No usable paths. Fall back to the Ableton-reported names (never the
    // display name — the producer may have renamed the project themselves).
    const openName = cleanName(activeSession.project_name);
    const boundName = cleanName(bound.ableton_name);
    if (!openName || !boundName) return null; // not enough to be sure
    drifted = openName.toLowerCase() !== boundName.toLowerCase();
  }

  if (!drifted) return null;

  return {
    openName:
      cleanName(activeSession.project_name) ??
      cleanName(activeSession.project_path) ??
      "another set",
    boundName: cleanName(bound.display_name) ?? cleanName(bound.ableton_name) ?? "another project",
  };
}
