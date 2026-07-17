// Typed access to durable organizer storage.
//
// In the Tauri app this talks to the native SQLite + file store through the
// `*_organizer_project` commands. In a plain browser (dev only) it falls back to
// IndexedDB — never localStorage, which is the quota-limited, silently-failing
// tier this migration exists to leave behind.
//
// The legacy localStorage shape is mapped to the native shape by pure functions
// (`mapLegacyToNative`, `parseLegacyProjects`) so the one-time migration is unit
// tested without a database.

import { invoke, isTauri } from "@tauri-apps/api/core";

export const LEGACY_STORAGE_KEY = "recall-studio.organizer.v1";
export const MIGRATION_MARKER_KEY = "recall-studio.organizer.migrated.v1";
const IDB_NAME = "recall-studio-organizer";
const IDB_STORE = "projects";

export type ReleaseType = "album" | "ep" | "single";

export type NativeAls = { id: string; path: string; name: string };

export type NativeComment = {
  id: string;
  timeSec: number;
  text: string;
  created_at_ms: number;
};

export type NativeBounce = {
  id: string;
  fileName: string;
  sourcePath?: string;
  fileSizeBytes: number;
  durationSec: number;
  sampleRate: number;
  channelCount: number;
  peaks: number[];
  waveformChannels?: string[];
  waveformPoints?: number;
  integratedLufs: number | null;
  dynamicRangeLu: number | null;
  peakDb: number;
  peakKind?: "sample" | "true";
  analysisVersion?: number;
  volume: number;
  added_at_ms: number;
  timedComments: NativeComment[];
};

export type NativeTrack = {
  id: string;
  title: string;
  comment: string;
  alsFile: NativeAls | null;
  bounces: NativeBounce[];
  finalBounceId: string | null;
};

export type NativeProject = {
  id: string;
  name: string;
  artist: string;
  releaseDate: string;
  notes: string;
  releaseType: ReleaseType;
  coverImageDataUrl: string | null;
  tracks: NativeTrack[];
  created_at_ms: number;
  updated_at_ms: number;
};

export type OrganizerRepository = {
  load: () => Promise<NativeProject[]>;
  save: (project: NativeProject) => Promise<void>;
  remove: (projectId: string) => Promise<void>;
};

// --- Legacy → native mapping (pure) ----------------------------------------

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function num(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function optNum(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

function mapAls(raw: unknown): NativeAls | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.path !== "string") return null;
  return {
    id: str(r.id) || `als-${Math.random().toString(36).slice(2, 8)}`,
    path: r.path,
    name: str(r.name) || basename(r.path),
  };
}

function mapComment(raw: unknown): NativeComment | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string") return null;
  return {
    id: r.id,
    timeSec: num(r.timeSec),
    text: str(r.text),
    created_at_ms: num(r.created_at_ms, Date.now()),
  };
}

function mapBounce(raw: unknown): NativeBounce | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string") return null;
  const peakKind = r.peakKind === "true" || r.peakKind === "sample" ? r.peakKind : undefined;
  return {
    id: r.id,
    fileName: str(r.fileName),
    sourcePath: typeof r.sourcePath === "string" ? r.sourcePath : undefined,
    fileSizeBytes: num(r.fileSizeBytes),
    durationSec: num(r.durationSec),
    sampleRate: num(r.sampleRate),
    channelCount: num(r.channelCount),
    peaks: Array.isArray(r.peaks) ? (r.peaks.filter((v) => typeof v === "number") as number[]) : [],
    waveformChannels: Array.isArray(r.waveformChannels)
      ? (r.waveformChannels.filter((v) => typeof v === "string") as string[])
      : undefined,
    waveformPoints: typeof r.waveformPoints === "number" ? r.waveformPoints : undefined,
    integratedLufs: optNum(r.integratedLufs),
    dynamicRangeLu: optNum(r.dynamicRangeLu),
    peakDb: num(r.peakDb),
    peakKind,
    analysisVersion: typeof r.analysisVersion === "number" ? r.analysisVersion : undefined,
    volume: typeof r.volume === "number" ? Math.min(1, Math.max(0, r.volume)) : 1,
    added_at_ms: num(r.added_at_ms, Date.now()),
    timedComments: Array.isArray(r.timedComments)
      ? r.timedComments.map(mapComment).filter((c): c is NativeComment => c !== null)
      : [],
  };
}

function mapReleaseType(value: unknown): ReleaseType {
  return value === "album" || value === "ep" || value === "single" ? value : "album";
}

/// Map one stored record — the current tracks shape *or* the pre-tracklist
/// alsFiles/exports shape — into a native project, preserving order, versions,
/// final selections, comments, measurements, volume, paths, cover, and waveform.
export function mapLegacyToNative(raw: unknown): NativeProject | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || typeof r.name !== "string") return null;

  let tracks: NativeTrack[];
  if (Array.isArray(r.tracks)) {
    tracks = r.tracks
      .filter((t): t is Record<string, unknown> => typeof t === "object" && t !== null)
      .map((t) => {
        const bounces = Array.isArray(t.bounces)
          ? t.bounces.map(mapBounce).filter((b): b is NativeBounce => b !== null)
          : typeof t.bounce === "object" && t.bounce !== null
            ? [mapBounce(t.bounce)].filter((b): b is NativeBounce => b !== null)
            : [];
        const requestedFinal = typeof t.finalBounceId === "string" ? t.finalBounceId : null;
        const finalBounceId = bounces.some((b) => b.id === requestedFinal)
          ? requestedFinal
          : bounces[0]?.id ?? null;
        return {
          id: str(t.id) || `track-${Math.random().toString(36).slice(2, 8)}`,
          title: str(t.title),
          comment: str(t.comment),
          alsFile: mapAls(t.alsFile),
          bounces,
          finalBounceId,
        };
      });
  } else {
    // Pre-tracklist shape: pair alsFiles and exports by position.
    const alsFiles = Array.isArray(r.alsFiles)
      ? r.alsFiles.map(mapAls).filter((a): a is NativeAls => a !== null)
      : typeof r.alsPath === "string"
        ? [mapAls({ path: r.alsPath, name: r.alsName })].filter((a): a is NativeAls => a !== null)
        : [];
    const exports = Array.isArray(r.exports)
      ? r.exports.map(mapBounce).filter((b): b is NativeBounce => b !== null)
      : [];
    const count = Math.max(alsFiles.length, exports.length);
    tracks = Array.from({ length: count }, (_, index) => {
      const bounce = exports[index] ?? null;
      return {
        id: `track-${Math.random().toString(36).slice(2, 8)}-${index}`,
        title: "",
        comment: "",
        alsFile: alsFiles[index] ?? null,
        bounces: bounce ? [bounce] : [],
        finalBounceId: bounce?.id ?? null,
      };
    });
  }

  const cover =
    typeof r.coverImageDataUrl === "string" && r.coverImageDataUrl.startsWith("data:image/")
      ? r.coverImageDataUrl
      : null;

  return {
    id: r.id,
    name: r.name,
    artist: str(r.artist),
    releaseDate: str(r.releaseDate),
    notes: str(r.notes),
    releaseType: mapReleaseType(r.releaseType),
    coverImageDataUrl: cover,
    tracks,
    created_at_ms: num(r.created_at_ms, Date.now()),
    updated_at_ms: num(r.updated_at_ms, Date.now()),
  };
}

export function parseLegacyProjects(json: string | null): NativeProject[] {
  if (!json) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.map(mapLegacyToNative).filter((p): p is NativeProject => p !== null);
}

// --- Native repository (Tauri) ---------------------------------------------

export function nativeRepository(): OrganizerRepository {
  return {
    load: () => invoke<NativeProject[]>("list_organizer_projects"),
    // Errors reject and are surfaced by the caller — never swallowed.
    save: (project) => invoke<void>("save_organizer_project", { project }),
    remove: (projectId) => invoke<void>("delete_organizer_project", { projectId }),
  };
}

// --- IndexedDB repository (browser dev fallback) ----------------------------

function openIdb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(IDB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
  });
}

function idbRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

export function indexedDbRepository(): OrganizerRepository {
  return {
    async load() {
      const db = await openIdb();
      try {
        const store = db.transaction(IDB_STORE, "readonly").objectStore(IDB_STORE);
        const all = await idbRequest(store.getAll() as IDBRequest<NativeProject[]>);
        return [...all].sort((a, b) => b.updated_at_ms - a.updated_at_ms);
      } finally {
        db.close();
      }
    },
    async save(project) {
      const db = await openIdb();
      try {
        const tx = db.transaction(IDB_STORE, "readwrite");
        tx.objectStore(IDB_STORE).put(project);
        await new Promise<void>((resolve, reject) => {
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error ?? new Error("IndexedDB save failed"));
        });
      } finally {
        db.close();
      }
    },
    async remove(projectId) {
      const db = await openIdb();
      try {
        const tx = db.transaction(IDB_STORE, "readwrite");
        tx.objectStore(IDB_STORE).delete(projectId);
        await new Promise<void>((resolve, reject) => {
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error ?? new Error("IndexedDB delete failed"));
        });
      } finally {
        db.close();
      }
    },
  };
}

export function organizerRepository(): OrganizerRepository {
  return isTauri() ? nativeRepository() : indexedDbRepository();
}

// --- One-time legacy migration ---------------------------------------------

export type MigrationResult = {
  status: "skipped" | "empty" | "migrated";
  migrated: number;
};

type MigrationStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/// Import localStorage organizer data into the native repository exactly once.
/// The original localStorage data is only removed after every project is saved
/// AND read back successfully. Any failure leaves localStorage untouched and
/// throws, so the producer's work is never lost to a half-finished migration.
export async function runLegacyMigration(
  repo: Pick<OrganizerRepository, "load" | "save">,
  storage: MigrationStorage,
): Promise<MigrationResult> {
  if (storage.getItem(MIGRATION_MARKER_KEY) === "1") {
    return { status: "skipped", migrated: 0 };
  }

  const projects = parseLegacyProjects(storage.getItem(LEGACY_STORAGE_KEY));
  if (projects.length === 0) {
    storage.setItem(MIGRATION_MARKER_KEY, "1");
    return { status: "empty", migrated: 0 };
  }

  for (const project of projects) {
    await repo.save(project);
  }

  const saved = await repo.load();
  const savedIds = new Set(saved.map((project) => project.id));
  const allPresent = projects.every((project) => savedIds.has(project.id));
  if (!allPresent) {
    throw new Error(
      "Organizer migration could not be verified — your original data was preserved.",
    );
  }

  storage.setItem(MIGRATION_MARKER_KEY, "1");
  storage.removeItem(LEGACY_STORAGE_KEY);
  return { status: "migrated", migrated: projects.length };
}
