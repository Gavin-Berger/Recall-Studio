import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { analyzeAudioFile, type AudioAnalysis } from "./audio";
import {
  organizerRepository,
  runLegacyMigration,
  type NativeProject,
  type OrganizerRepository,
} from "./repository";
import { ReleasePreview } from "./ReleasePreview";
import {
  buildReleaseCommentsText,
  buildReleasePreviewHtml,
  portableCoverAsset,
  portablePreviewFolderName,
  portableTrackFileName,
  selectReleasePreviewTracks,
} from "./previewExport";
import { Waveform } from "./Waveform";

// The Project Organizer: a place to lay out a release as the thing you ship — a
// name, the Ableton sets that make it up, and the bounces you exported, each
// shown like a mix-review file (waveform + loudness + range + level). A project
// holds many sets, because this is about organization (an EP is several songs),
// not linking one file.
//
// Structured data persists through the native organizer repository (SQLite in
// Tauri, IndexedDB in browser development). Large waveform and cover assets are
// dehydrated by the native backend into app-data files.

type ReleaseType = "album" | "ep" | "single";

const RELEASE_TYPES: ReleaseType[] = ["album", "ep", "single"];

function releaseTypeLabel(type: ReleaseType): string {
  return type === "album" ? "Album" : type === "ep" ? "EP" : "Single";
}

type AlsFile = {
  id: string;
  path: string;
  name: string;
};

export type TimedComment = {
  id: string;
  timeSec: number;
  text: string;
  created_at_ms: number;
};

export function commentsCrossed(
  comments: readonly TimedComment[],
  previousTime: number,
  currentTime: number,
): TimedComment[] {
  if (currentTime < previousTime) return [];
  return comments.filter(
    (comment) => comment.timeSec > previousTime + 0.01 && comment.timeSec <= currentTime + 0.05,
  );
}

type ExportBounce = {
  id: string;
  fileName: string;
  sourcePath?: string;
  fileSizeBytes: number;
  durationSec: number;
  sampleRate: number;
  channelCount: number;
  peaks: number[];
  waveformMin?: number[];
  waveformMax?: number[];
  waveformData?: string;
  waveformChannels?: string[];
  waveformPoints?: number;
  integratedLufs: number | null;
  dynamicRangeLu: number | null;
  maxMomentaryLufs?: number | null;
  maxMomentaryTimeSec?: number | null;
  maxShortTermLufs?: number | null;
  maxShortTermTimeSec?: number | null;
  peakDb: number;
  samplePeakDb?: number | null;
  clippedSampleCount?: number | null;
  dcOffsetDb?: number | null;
  stereoCorrelation?: number | null;
  stereoBalanceDb?: number | null;
  bitDepth?: number | null;
  leadingSilenceSec?: number | null;
  trailingSilenceSec?: number | null;
  // Older saved entries are sample peak; newly analyzed entries are true peak.
  peakKind?: "sample" | "true";
  analysisVersion?: number;
  added_at_ms: number;
  timedComments?: TimedComment[];
  volume?: number;
};

type OrganizerTrack = {
  id: string;
  title: string;
  comment: string;
  alsFile: AlsFile | null;
  bounces: ExportBounce[];
  finalBounceId: string | null;
  // Compatibility projection used by the hidden v1 renderer.
  bounce: ExportBounce | null;
};

export type OrganizerProject = {
  id: string;
  name: string;
  artist: string;
  releaseDate: string;
  notes: string;
  releaseType: ReleaseType;
  coverImageDataUrl: string | null;
  // Array order is album order. Each track owns its source set and final mix.
  tracks: OrganizerTrack[];
  // Read-only compatibility projections for the pre-tracklist renderer below.
  alsFiles: AlsFile[];
  exports: ExportBounce[];
  created_at_ms: number;
  updated_at_ms: number;
};

function normalizeBounceVolume(bounce: ExportBounce): ExportBounce {
  return {
    ...bounce,
    volume: typeof bounce.volume === "number" ? clampVolume(bounce.volume) : 1,
  };
}

function measuredBounceFields(analysis: AudioAnalysis) {
  return {
    integratedLufs: analysis.integratedLufs,
    dynamicRangeLu: analysis.dynamicRangeLu,
    maxMomentaryLufs: analysis.maxMomentaryLufs,
    maxMomentaryTimeSec: analysis.maxMomentaryTimeSec,
    maxShortTermLufs: analysis.maxShortTermLufs,
    maxShortTermTimeSec: analysis.maxShortTermTimeSec,
    peakDb: analysis.truePeakDb,
    samplePeakDb: analysis.samplePeakDb,
    clippedSampleCount: analysis.clippedSampleCount,
    dcOffsetDb: analysis.dcOffsetDb,
    stereoCorrelation: analysis.stereoCorrelation,
    stereoBalanceDb: analysis.stereoBalanceDb,
    bitDepth: analysis.bitDepth,
    leadingSilenceSec: analysis.leadingSilenceSec,
    trailingSilenceSec: analysis.trailingSilenceSec,
    peakKind: "true" as const,
    analysisVersion: 4,
  };
}

// Coerce a stored record into a project, tolerating older shapes. The original
// organizer kept Ableton sets and exports in separate arrays; pair them by
// position so existing releases become Track 1, Track 2, etc. without loss.
export function normalizeProject(raw: unknown): OrganizerProject | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || typeof r.name !== "string") {
    return null;
  }

  let alsFiles: AlsFile[] = [];
  if (Array.isArray(r.alsFiles)) {
    alsFiles = r.alsFiles
      .filter((f): f is Record<string, unknown> => typeof f === "object" && f !== null && typeof f.path === "string")
      .map((f) => ({
        id: typeof f.id === "string" ? f.id : makeAlsId(),
        path: f.path as string,
        name: typeof f.name === "string" ? f.name : basename(f.path as string),
      }));
  } else if (typeof r.alsPath === "string") {
    alsFiles = [
      {
        id: makeAlsId(),
        path: r.alsPath,
        name: typeof r.alsName === "string" ? r.alsName : basename(r.alsPath),
      },
    ];
  }

  const oldExports = Array.isArray(r.exports)
    ? (r.exports as ExportBounce[]).map(normalizeBounceVolume)
    : [];
  let tracks: OrganizerTrack[];
  if (Array.isArray(r.tracks)) {
    tracks = r.tracks
      .filter((track): track is Record<string, unknown> => typeof track === "object" && track !== null)
      .map((track) => {
        const rawAls = typeof track.alsFile === "object" && track.alsFile !== null
          ? track.alsFile as Record<string, unknown>
          : null;
        const alsFile = rawAls && typeof rawAls.path === "string"
          ? {
              id: typeof rawAls.id === "string" ? rawAls.id : makeAlsId(),
              path: rawAls.path,
              name: typeof rawAls.name === "string" ? rawAls.name : basename(rawAls.path),
            }
          : null;
        const legacyBounce = typeof track.bounce === "object" && track.bounce !== null
          ? normalizeBounceVolume(track.bounce as ExportBounce)
          : null;
        const bounces = Array.isArray(track.bounces)
          ? track.bounces
              .filter((bounce): bounce is ExportBounce => typeof bounce === "object" && bounce !== null)
              .map(normalizeBounceVolume)
          : legacyBounce ? [legacyBounce] : [];
        const requestedFinalId = typeof track.finalBounceId === "string" ? track.finalBounceId : null;
        const finalBounceId = bounces.some((bounce) => bounce.id === requestedFinalId)
          ? requestedFinalId
          : bounces[0]?.id ?? null;
        const bounce = bounces.find((candidate) => candidate.id === finalBounceId) ?? bounces[0] ?? null;
        return {
          id: typeof track.id === "string" ? track.id : makeTrackId(),
          title: typeof track.title === "string" ? track.title : "",
          comment: typeof track.comment === "string" ? track.comment : "",
          alsFile,
          bounces,
          finalBounceId,
          bounce,
        };
      });
  } else {
    const trackCount = Math.max(alsFiles.length, oldExports.length);
    tracks = Array.from({ length: trackCount }, (_, index) => ({
      id: makeTrackId(),
      title: "",
      comment: "",
      alsFile: alsFiles[index] ?? null,
      bounces: oldExports[index] ? [oldExports[index]] : [],
      finalBounceId: oldExports[index]?.id ?? null,
      bounce: oldExports[index] ?? null,
    }));
  }

  const releaseType: ReleaseType =
    r.releaseType === "album" || r.releaseType === "ep" || r.releaseType === "single"
      ? r.releaseType
      : "album";

  return {
    id: r.id,
    name: r.name,
    artist: typeof r.artist === "string" ? r.artist : "",
    releaseDate: typeof r.releaseDate === "string" ? r.releaseDate : "",
    notes: typeof r.notes === "string" ? r.notes : "",
    releaseType,
    coverImageDataUrl:
      typeof r.coverImageDataUrl === "string" && r.coverImageDataUrl.startsWith("data:image/")
        ? r.coverImageDataUrl
        : null,
    tracks,
    alsFiles: tracks.flatMap((track) => track.alsFile ? [track.alsFile] : []),
    exports: tracks.flatMap((track) => track.bounces),
    created_at_ms: typeof r.created_at_ms === "number" ? r.created_at_ms : Date.now(),
    updated_at_ms: typeof r.updated_at_ms === "number" ? r.updated_at_ms : Date.now(),
  };
}

export function projectForStorage(
  project: OrganizerProject,
  includeWaveform: (bounceId: string) => boolean = () => true,
): NativeProject {
  return {
    id: project.id,
    name: project.name,
    artist: project.artist,
    releaseDate: project.releaseDate,
    notes: project.notes,
    releaseType: project.releaseType,
    coverImageDataUrl: project.coverImageDataUrl,
    tracks: project.tracks.map((track) => ({
      id: track.id,
      title: track.title,
      comment: track.comment,
      alsFile: track.alsFile,
      finalBounceId: track.finalBounceId,
      bounces: track.bounces.map((bounce) => ({
        id: bounce.id,
        fileName: bounce.fileName,
        sourcePath: bounce.sourcePath,
        fileSizeBytes: bounce.fileSizeBytes,
        durationSec: bounce.durationSec,
        sampleRate: bounce.sampleRate,
        channelCount: bounce.channelCount,
        peaks: bounce.peaks,
        waveformChannels: includeWaveform(bounce.id) ? bounce.waveformChannels : undefined,
        waveformPoints: bounce.waveformPoints,
        integratedLufs: bounce.integratedLufs,
        dynamicRangeLu: bounce.dynamicRangeLu,
        maxMomentaryLufs: bounce.maxMomentaryLufs,
        maxMomentaryTimeSec: bounce.maxMomentaryTimeSec,
        maxShortTermLufs: bounce.maxShortTermLufs,
        maxShortTermTimeSec: bounce.maxShortTermTimeSec,
        peakDb: bounce.peakDb,
        samplePeakDb: bounce.samplePeakDb,
        clippedSampleCount: bounce.clippedSampleCount,
        dcOffsetDb: bounce.dcOffsetDb,
        stereoCorrelation: bounce.stereoCorrelation,
        stereoBalanceDb: bounce.stereoBalanceDb,
        bitDepth: bounce.bitDepth,
        leadingSilenceSec: bounce.leadingSilenceSec,
        trailingSilenceSec: bounce.trailingSilenceSec,
        peakKind: bounce.peakKind,
        analysisVersion: bounce.analysisVersion,
        volume: clampVolume(bounce.volume ?? 1),
        added_at_ms: bounce.added_at_ms,
        timedComments: bounce.timedComments ?? [],
      })),
    })),
    created_at_ms: project.created_at_ms,
    updated_at_ms: project.updated_at_ms,
  };
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

function formatDuration(sec: number): string {
  if (!Number.isFinite(sec)) return "—";
  const total = Math.round(sec);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

// Total runtime, hours-aware — a release can run past an hour.
function formatTotalDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return "0:00";
  const total = Math.round(sec);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = h > 0 ? m.toString().padStart(2, "0") : m.toString();
  return h > 0 ? `${h}:${mm}:${s.toString().padStart(2, "0")}` : `${mm}:${s.toString().padStart(2, "0")}`;
}

function formatLufs(lufs: number | null): string {
  return lufs === null ? "—" : `${lufs.toFixed(1)} LUFS`;
}

export function producerDynamicRangeDb(
  integratedLufs: number | null | undefined,
  peakDb: number | null | undefined,
): number | null {
  if (
    integratedLufs == null
    || peakDb == null
    || !Number.isFinite(integratedLufs)
    || !Number.isFinite(peakDb)
  ) {
    return null;
  }
  return peakDb - integratedLufs;
}

function formatDynamicRange(value: number | null): string {
  return value == null ? "—" : `${value.toFixed(1)} dB`;
}

function formatLoudnessRange(value: number | null | undefined): string {
  return value == null ? "—" : `${value.toFixed(1)} LU`;
}

export type MasteringFlag = {
  severity: "critical" | "warning" | "note";
  text: string;
};

export function masteringFlags(bounce: ExportBounce): MasteringFlag[] {
  const flags: MasteringFlag[] = [];
  if (bounce.peakKind === "true" && Number.isFinite(bounce.peakDb)) {
    if (bounce.peakDb >= 0) {
      flags.push({ severity: "critical", text: "True peak exceeds 0 dBTP" });
    } else if (bounce.peakDb > -1) {
      flags.push({ severity: "warning", text: "Less than 1 dB true-peak headroom" });
    }
    if (bounce.integratedLufs != null && bounce.integratedLufs > -14 && bounce.peakDb > -2) {
      flags.push({ severity: "warning", text: "Limited headroom for lossy streaming encodes" });
    }
  }
  if ((bounce.clippedSampleCount ?? 0) > 0) {
    flags.push({
      severity: "critical",
      text: `${bounce.clippedSampleCount!.toLocaleString()} decoded samples at or above full scale`,
    });
  }
  if (bounce.stereoCorrelation != null && bounce.stereoCorrelation < 0) {
    flags.push({ severity: "warning", text: "Negative stereo correlation may cancel in mono" });
  }
  if (bounce.stereoBalanceDb != null && Math.abs(bounce.stereoBalanceDb) > 1) {
    flags.push({ severity: "note", text: "Average left/right level differs by more than 1 dB" });
  }
  if (bounce.dcOffsetDb != null && bounce.dcOffsetDb > -60) {
    flags.push({ severity: "note", text: "DC offset is above -60 dBFS" });
  }
  if ((bounce.leadingSilenceSec ?? 0) > 2) {
    flags.push({ severity: "note", text: "More than 2 seconds of leading audio below -60 dBFS" });
  }
  if ((bounce.trailingSilenceSec ?? 0) > 2) {
    flags.push({ severity: "note", text: "More than 2 seconds of trailing audio below -60 dBFS" });
  }
  return flags;
}

export function spotifyNormalPreview(
  integratedLufs: number | null | undefined,
  truePeakDb: number | null | undefined,
) {
  if (
    integratedLufs == null
    || truePeakDb == null
    || !Number.isFinite(integratedLufs)
    || !Number.isFinite(truePeakDb)
  ) {
    return null;
  }
  const requestedGainDb = -14 - integratedLufs;
  const appliedGainDb = requestedGainDb > 0
    ? Math.min(requestedGainDb, -1 - truePeakDb)
    : requestedGainDb;
  return {
    requestedGainDb,
    appliedGainDb,
    estimatedLufs: integratedLufs + appliedGainDb,
    estimatedTruePeakDb: truePeakDb + appliedGainDb,
    headroomLimited: appliedGainDb < requestedGainDb,
  };
}

function formatSignedDb(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(1)} dB`;
}

// Unique enough for a batch added in the same millisecond.
function makeExportId(index: number): string {
  return `exp-${Date.now().toString(36)}-${index}-${Math.random().toString(36).slice(2, 7)}`;
}

function makeAlsId(): string {
  return `als-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function makeTrackId(): string {
  return `track-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function makeTrack(): OrganizerTrack {
  return {
    id: makeTrackId(),
    title: "",
    comment: "",
    alsFile: null,
    bounces: [],
    finalBounceId: null,
    bounce: null,
  };
}

function withTrackBounces(
  track: OrganizerTrack,
  bounces: ExportBounce[],
  requestedFinalId: string | null = track.finalBounceId,
): OrganizerTrack {
  const finalBounceId = bounces.some((bounce) => bounce.id === requestedFinalId)
    ? requestedFinalId
    : bounces[0]?.id ?? null;
  return {
    ...track,
    bounces,
    finalBounceId,
    bounce: bounces.find((bounce) => bounce.id === finalBounceId) ?? null,
  };
}

function titleFromFile(name: string): string {
  return name.replace(/\.(als|wav|aiff?|mp3|flac|m4a|ogg)$/i, "");
}

function formatDb(db: number, unit: "dBTP" | "dBFS"): string {
  return Number.isFinite(db) ? `${db >= 0 ? "+" : ""}${db.toFixed(1)} ${unit}` : "—";
}

function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function clampVolume(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function volumePercent(value: number | undefined): number {
  return Math.round(clampVolume(value ?? 1) * 100);
}

function versionLabel(index: number): string {
  return index < 26 ? String.fromCharCode(65 + index) : `${index + 1}`;
}

async function prepareCoverImage(file: File): Promise<string> {
  const objectUrl = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = objectUrl;
    await image.decode();

    const size = 1000;
    const sourceSize = Math.min(image.naturalWidth, image.naturalHeight);
    const sourceX = (image.naturalWidth - sourceSize) / 2;
    const sourceY = (image.naturalHeight - sourceSize) / 2;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Cover art could not be processed.");
    context.drawImage(image, sourceX, sourceY, sourceSize, sourceSize, 0, 0, size, size);
    return canvas.toDataURL("image/webp", 0.86);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

export function ProjectOrganizerScreen() {
  const repository = useMemo<OrganizerRepository>(() => organizerRepository(), []);
  const nativeStorage = useMemo(() => isTauri(), []);
  const [projects, setProjects] = useState<OrganizerProject[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [storageReady, setStorageReady] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewExporting, setPreviewExporting] = useState(false);
  const [previewExportStatus, setPreviewExportStatus] = useState<string | null>(null);
  const [activeExportId, setActiveExportId] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [expandedTrackIds, setExpandedTrackIds] = useState<Set<string>>(() => new Set());
  const [, setPlaybackRevision] = useState(0);
  const [analyzing, setAnalyzing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draggedTrackId, setDraggedTrackId] = useState<string | null>(null);
  const [dragOverTrackId, setDragOverTrackId] = useState<string | null>(null);
  const [timedCommentDrafts, setTimedCommentDrafts] = useState<Record<string, string>>({});
  const [attentionCommentIds, setAttentionCommentIds] = useState<Set<string>>(() => new Set());

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const coverInputRef = useRef<HTMLInputElement | null>(null);
  const pendingExportTrackId = useRef<string | null>(null);
  const pendingReplaceBounceId = useRef<string | null>(null);
  const pendingExportAutoPlay = useRef(false);
  // Session-only object URLs for the attached bounces, keyed by export id.
  const urls = useRef<Map<string, string>>(new Map());
  const rafRef = useRef<number | null>(null);
  const lastProgressPaintRef = useRef(0);
  const playbackCursorRef = useRef<{ exportId: string | null; timeSec: number }>({ exportId: null, timeSec: 0 });
  const commentAttentionTimers = useRef<Map<string, number>>(new Map());
  const waveformUpgradeIds = useRef<Set<string>>(new Set());
  const dirtyWaveformIds = useRef<Set<string>>(new Set());
  const persistedRevisions = useRef<Map<string, number>>(new Map());
  const saveTimers = useRef<Map<string, number>>(new Map());
  const saveQueues = useRef<Map<string, Promise<void>>>(new Map());

  const ordered = useMemo(
    () => [...projects].sort((a, b) => b.updated_at_ms - a.updated_at_ms),
    [projects],
  );
  const selected = ordered.find((p) => p.id === selectedId) ?? ordered[0] ?? null;
  const previewTracks = useMemo(
    () => selected ? selectReleasePreviewTracks(selected) : [],
    [selected],
  );

  // Release-level totals for the summary row.
  const releaseStats = useMemo(() => {
    if (!selected) return null;
    const bounces = selected.tracks
      .map((track) => track.bounce)
      .filter((bounce): bounce is ExportBounce => bounce !== null);
    const trackCount = selected.tracks.length;
    const totalSec = bounces.reduce(
      (total, e) => total + (Number.isFinite(e.durationSec) ? e.durationSec : 0),
      0,
    );
    const lufs = bounces
      .map((e) => e.integratedLufs)
      .filter((v): v is number => v != null);
    const loudnessSpan = lufs.length > 0 ? { min: Math.min(...lufs), max: Math.max(...lufs) } : null;
    const plr = bounces
      .map((bounce) => producerDynamicRangeDb(bounce.integratedLufs, bounce.peakDb))
      .filter((value): value is number => value != null);
    const plrSpan = plr.length > 0 ? { min: Math.min(...plr), max: Math.max(...plr) } : null;
    const truePeaks = bounces
      .filter((bounce) => bounce.peakKind === "true" && Number.isFinite(bounce.peakDb))
      .map((bounce) => bounce.peakDb);
    const sampleRates = new Set(bounces.map((bounce) => bounce.sampleRate));
    const channelCounts = new Set(bounces.map((bounce) => bounce.channelCount));
    const knownBitDepths = new Set(
      bounces
        .map((bounce) => bounce.bitDepth)
        .filter((value): value is number => value != null),
    );
    return {
      trackCount,
      completedCount: bounces.length,
      totalSec,
      loudnessSpan,
      plrSpan,
      maximumTruePeak: truePeaks.length > 0 ? Math.max(...truePeaks) : null,
      clippedSampleCount: bounces.reduce(
        (total, bounce) => total + (bounce.clippedSampleCount ?? 0),
        0,
      ),
      formatsMatch:
        sampleRates.size <= 1
        && channelCounts.size <= 1
        && knownBitDepths.size <= 1,
    };
  }, [selected]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let migrationError: string | null = null;
      try {
        await runLegacyMigration(repository, window.localStorage);
      } catch (migrationFailure) {
        migrationError = `Organizer migration needs attention: ${String(migrationFailure)}`;
      }

      try {
        const stored = await repository.load();
        if (cancelled) return;
        const hydrated = stored
          .map(normalizeProject)
          .filter((project): project is OrganizerProject => project !== null);
        persistedRevisions.current = new Map(
          hydrated.map((project) => [project.id, project.updated_at_ms]),
        );
        setProjects(hydrated);
        setSelectedId(hydrated[0]?.id ?? null);
        if (migrationError) setError(migrationError);
      } catch (loadFailure) {
        if (!cancelled) {
          setError(`Couldn't load Organizer storage: ${String(loadFailure)}`);
        }
      } finally {
        if (!cancelled) setStorageReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [repository]);

  useEffect(() => {
    setPreviewOpen(false);
    setPreviewExportStatus(null);
  }, [selected?.id]);

  useEffect(() => {
    if (!storageReady) return;
    for (const project of projects) {
      if (persistedRevisions.current.get(project.id) === project.updated_at_ms) continue;
      const existingTimer = saveTimers.current.get(project.id);
      if (existingTimer !== undefined) window.clearTimeout(existingTimer);
      const timer = window.setTimeout(() => {
        saveTimers.current.delete(project.id);
        const projectWaveforms = new Set(
          project.tracks
            .flatMap((track) => track.bounces)
            .filter((bounce) => dirtyWaveformIds.current.has(bounce.id))
            .map((bounce) => bounce.id),
        );
        const payload = projectForStorage(
          project,
          (bounceId) => !nativeStorage || projectWaveforms.has(bounceId),
        );
        const previous = saveQueues.current.get(project.id) ?? Promise.resolve();
        const operation = previous
          .catch(() => undefined)
          .then(() => repository.save(payload));
        saveQueues.current.set(project.id, operation);
        void operation
          .then(() => {
            if (saveQueues.current.get(project.id) === operation) {
              saveQueues.current.delete(project.id);
            }
            persistedRevisions.current.set(project.id, project.updated_at_ms);
            for (const bounceId of projectWaveforms) dirtyWaveformIds.current.delete(bounceId);
          })
          .catch((saveFailure) => {
            setError(`Couldn't save ${project.name.trim() || "Untitled project"}: ${String(saveFailure)}`);
          });
      }, 300);
      saveTimers.current.set(project.id, timer);
    }
  }, [nativeStorage, projects, repository, storageReady]);

  useEffect(() => {
    if (!activeExportId) return;
    const exp = selected?.tracks
      .flatMap((track) => track.bounces)
      .find((bounce) => bounce.id === activeExportId);
    if (!exp || !Number.isFinite(exp.durationSec) || exp.durationSec <= 0) return;
    const currentTime = Math.min(exp.durationSec, Math.max(0, progress * exp.durationSec));
    const previous = playbackCursorRef.current;
    if (previous.exportId !== exp.id || !isPlaying || currentTime < previous.timeSec) {
      playbackCursorRef.current = { exportId: exp.id, timeSec: currentTime };
      return;
    }
    const crossed = commentsCrossed(exp.timedComments ?? [], previous.timeSec, currentTime);
    playbackCursorRef.current = { exportId: exp.id, timeSec: currentTime };
    if (crossed.length === 0) return;
    setAttentionCommentIds((current) => {
      const next = new Set(current);
      for (const comment of crossed) next.add(comment.id);
      return next;
    });
    for (const comment of crossed) {
      const existingTimer = commentAttentionTimers.current.get(comment.id);
      if (existingTimer !== undefined) window.clearTimeout(existingTimer);
      const timer = window.setTimeout(() => {
        setAttentionCommentIds((current) => {
          const next = new Set(current);
          next.delete(comment.id);
          return next;
        });
        commentAttentionTimers.current.delete(comment.id);
      }, Math.min(2200, 700 + comment.text.length * 22));
      commentAttentionTimers.current.set(comment.id, timer);
    }
  }, [activeExportId, isPlaying, progress, selected]);

  // Revoke every object URL on unmount so we don't leak the session's audio.
  useEffect(() => {
    const map = urls.current;
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      for (const timer of commentAttentionTimers.current.values()) window.clearTimeout(timer);
      commentAttentionTimers.current.clear();
      for (const url of map.values()) URL.revokeObjectURL(url);
      map.clear();
    };
  }, []);

  const stopRaf = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  const ensureBounceUrl = useCallback(async (bounce: ExportBounce) => {
    const existing = urls.current.get(bounce.id);
    if (existing) return existing;
    if (!bounce.sourcePath || !isTauri()) return null;
    const bytes = await invoke<ArrayBuffer>("read_organizer_audio", { path: bounce.sourcePath });
    const url = URL.createObjectURL(new Blob([bytes]));
    urls.current.set(bounce.id, url);
    setPlaybackRevision((revision) => revision + 1);
    return url;
  }, []);

  useEffect(() => {
    const lastTrackId = selected?.tracks[selected.tracks.length - 1]?.id;
    setExpandedTrackIds(lastTrackId ? new Set([lastTrackId]) : new Set());
  }, [selected?.id]);

  useEffect(() => {
    const bounces = selected?.tracks
      .filter((track) => expandedTrackIds.has(track.id))
      .flatMap((track) => track.bounce ? [track.bounce] : [])
      .filter((bounce) => bounce.sourcePath && !urls.current.has(bounce.id)) ?? [];
    if (bounces.length === 0) return;
    let cancelled = false;
    void Promise.all(bounces.map(async (bounce) => {
      const url = await ensureBounceUrl(bounce);
      if (cancelled && url) {
        URL.revokeObjectURL(url);
        urls.current.delete(bounce.id);
      }
    }))
      .catch(() => {
        if (!cancelled) {
          const name = bounces[0]?.fileName ?? "audio export";
          setError(`Couldn't reopen ${name}. Use Replace to locate it again.`);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [ensureBounceUrl, expandedTrackIds, selected]);

  const tick = useCallback((timestamp: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    const dur = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0;
    if (dur > 0 && timestamp - lastProgressPaintRef.current >= 33) {
      lastProgressPaintRef.current = timestamp;
      setProgress(Math.min(1, audio.currentTime / dur));
    }
    rafRef.current = requestAnimationFrame(tick);
  }, []);

  const mutateProject = useCallback(
    (id: string, patch: (p: OrganizerProject) => OrganizerProject) => {
      setProjects((prev) =>
        prev.map((p) => (p.id === id
          ? { ...patch(p), updated_at_ms: Math.max(Date.now(), p.updated_at_ms + 1) }
          : p)),
      );
    },
    [],
  );

  useEffect(() => {
    if (!selected || expandedTrackIds.size === 0 || !isTauri()) return;
    const staleBounces = selected.tracks
      .filter((track) => expandedTrackIds.has(track.id))
      .flatMap((track) => track.bounces.map((bounce) => ({ trackId: track.id, bounce })))
      .filter(({ bounce }) => bounce.sourcePath
        && (!bounce.waveformChannels?.length || (bounce.analysisVersion ?? 0) < 4)
        && !waveformUpgradeIds.current.has(bounce.id));
    if (staleBounces.length === 0) return;
    let cancelled = false;

    void (async () => {
      for (const { trackId, bounce } of staleBounces) {
        if (cancelled) return;
        waveformUpgradeIds.current.add(bounce.id);
        try {
          setAnalyzing(`${bounce.fileName} waveform`);
          const bytes = await invoke<ArrayBuffer>("read_organizer_audio", { path: bounce.sourcePath! });
          const file = new File([bytes], bounce.fileName);
          if (!urls.current.has(bounce.id)) {
            urls.current.set(bounce.id, URL.createObjectURL(file));
            setPlaybackRevision((revision) => revision + 1);
          }
          const analysis = await analyzeAudioFile(file);
          if (cancelled) return;
          dirtyWaveformIds.current.add(bounce.id);
          mutateProject(selected.id, (project) => ({
            ...project,
            tracks: project.tracks.map((candidate) => {
              if (candidate.id !== trackId) return candidate;
              const bounces = candidate.bounces.map((current) => current.id === bounce.id
                ? {
                    ...current,
                    waveformChannels: analysis.waveformChannels,
                    waveformPoints: analysis.waveformPoints,
                    ...measuredBounceFields(analysis),
                  }
                : current);
              return withTrackBounces(candidate, bounces);
            }),
          }));
        } catch {
          if (!cancelled) setError(`Couldn't upgrade the waveform for ${bounce.fileName}. Use Replace to locate it again.`);
        } finally {
          waveformUpgradeIds.current.delete(bounce.id);
          if (!cancelled) setAnalyzing(null);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [expandedTrackIds, mutateProject, selected]);

  function handleNewProject() {
    const now = Date.now();
    const firstTrack = makeTrack();
    const project: OrganizerProject = {
      id: `org-${now}`,
      name: "",
      artist: "",
      releaseDate: "",
      notes: "",
      releaseType: "album",
      coverImageDataUrl: null,
      tracks: [firstTrack],
      alsFiles: [],
      exports: [],
      created_at_ms: now,
      updated_at_ms: now,
    };
    setProjects((prev) => [project, ...prev]);
    setSelectedId(project.id);
    setExpandedTrackIds(new Set([firstTrack.id]));
  }

  function handleRename(name: string) {
    if (!selected) return;
    mutateProject(selected.id, (p) => ({ ...p, name }));
  }

  function handleSetType(type: ReleaseType) {
    if (!selected) return;
    mutateProject(selected.id, (p) => ({ ...p, releaseType: type }));
  }

  function handleSetArtist(artist: string) {
    if (!selected) return;
    mutateProject(selected.id, (p) => ({ ...p, artist }));
  }

  function handleSetReleaseDate(releaseDate: string) {
    if (!selected) return;
    mutateProject(selected.id, (p) => ({ ...p, releaseDate }));
  }

  function handleSetNotes(notes: string) {
    if (!selected) return;
    mutateProject(selected.id, (p) => ({ ...p, notes }));
  }

  function handleCoverPicked(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || !selected) return;
    setError(null);
    void prepareCoverImage(file)
      .then((coverImageDataUrl) => {
        mutateProject(selected.id, (project) => ({ ...project, coverImageDataUrl }));
      })
      .catch(() => setError("Couldn't read that cover image. Try a PNG, JPG, or WebP file."));
  }

  function handleRemoveCover() {
    if (!selected) return;
    mutateProject(selected.id, (project) => ({ ...project, coverImageDataUrl: null }));
  }

  function handleAddTrack() {
    if (!selected) return;
    const track = makeTrack();
    setExpandedTrackIds((current) => new Set(current).add(track.id));
    mutateProject(selected.id, (project) => ({ ...project, tracks: [...project.tracks, track] }));
  }

  function handleRenameTrack(trackId: string, title: string) {
    if (!selected) return;
    mutateProject(selected.id, (project) => ({
      ...project,
      tracks: project.tracks.map((track) => track.id === trackId ? { ...track, title } : track),
    }));
  }

  function handleTrackComment(trackId: string, comment: string) {
    if (!selected) return;
    mutateProject(selected.id, (project) => ({
      ...project,
      tracks: project.tracks.map((track) => track.id === trackId ? { ...track, comment } : track),
    }));
  }

  function handleVersionVolume(trackId: string, bounceId: string, volume: number) {
    if (!selected) return;
    const nextVolume = clampVolume(volume);
    if (activeExportId === bounceId && audioRef.current) {
      audioRef.current.volume = nextVolume;
    }
    mutateProject(selected.id, (project) => ({
      ...project,
      tracks: project.tracks.map((candidate) => {
        if (candidate.id !== trackId) return candidate;
        const bounces = candidate.bounces.map((bounce) => bounce.id === bounceId ? { ...bounce, volume: nextVolume } : bounce);
        return withTrackBounces(candidate, bounces);
      }),
    }));
  }

  // Move a whole song, keeping its Ableton set and exported mix together.
  function moveTrack(trackId: string, dir: -1 | 1) {
    if (!selected) return;
    mutateProject(selected.id, (p) => {
      const idx = p.tracks.findIndex((track) => track.id === trackId);
      const next = idx + dir;
      if (idx < 0 || next < 0 || next >= p.tracks.length) return p;
      const tracks = [...p.tracks];
      [tracks[idx], tracks[next]] = [tracks[next], tracks[idx]];
      return { ...p, tracks };
    });
  }

  function reorderTrack(sourceTrackId: string, targetTrackId: string) {
    if (!selected || sourceTrackId === targetTrackId) return;
    mutateProject(selected.id, (project) => {
      const from = project.tracks.findIndex((track) => track.id === sourceTrackId);
      const to = project.tracks.findIndex((track) => track.id === targetTrackId);
      if (from < 0 || to < 0) return project;
      const tracks = [...project.tracks];
      const [moved] = tracks.splice(from, 1);
      tracks.splice(to, 0, moved);
      return { ...project, tracks };
    });
  }

  function beginTrackDrag(event: React.MouseEvent<HTMLButtonElement>, sourceTrackId: string) {
    event.preventDefault();
    setDraggedTrackId(sourceTrackId);
    setDragOverTrackId(sourceTrackId);

    const handleMove = (moveEvent: MouseEvent) => {
      const target = document.elementFromPoint(moveEvent.clientX, moveEvent.clientY)?.closest<HTMLElement>("[data-track-id]");
      if (!target?.dataset.trackId) return;
      setDragOverTrackId(target.dataset.trackId);
      if (target.dataset.trackId !== sourceTrackId) reorderTrack(sourceTrackId, target.dataset.trackId);
    };
    const handleUp = (upEvent: MouseEvent) => {
      const target = document.elementFromPoint(upEvent.clientX, upEvent.clientY)?.closest<HTMLElement>("[data-track-id]");
      if (target?.dataset.trackId) reorderTrack(sourceTrackId, target.dataset.trackId);
      setDraggedTrackId(null);
      setDragOverTrackId(null);
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
    };

    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
  }

  function handleDeleteTrack(track: OrganizerTrack) {
    if (!selected) return;
    setExpandedTrackIds((current) => {
      const next = new Set(current);
      next.delete(track.id);
      return next;
    });
    for (const bounce of track.bounces) releaseBounce(bounce);
    mutateProject(selected.id, (project) => ({
      ...project,
      tracks: project.tracks.filter((candidate) => candidate.id !== track.id),
    }));
  }

  async function handleDeleteProject(project: OrganizerProject) {
    const label = project.name.trim() || "Untitled project";
    if (!window.confirm(`Delete "${label}" and its exports? This can't be undone.`)) return;
    const saveTimer = saveTimers.current.get(project.id);
    if (saveTimer !== undefined) {
      window.clearTimeout(saveTimer);
      saveTimers.current.delete(project.id);
    }
    try {
      await saveQueues.current.get(project.id)?.catch(() => undefined);
      await repository.remove(project.id);
    } catch (deleteFailure) {
      setError(`Couldn't delete ${label}: ${String(deleteFailure)}`);
      return;
    }
    for (const track of project.tracks) {
      for (const bounce of track.bounces) releaseBounce(bounce);
    }
    persistedRevisions.current.delete(project.id);
    saveQueues.current.delete(project.id);
    setProjects((prev) => prev.filter((p) => p.id !== project.id));
    if (selectedId === project.id) setSelectedId(null);
  }

  async function handleAddAls(trackId = selected?.tracks[0]?.id ?? "") {
    if (!selected) return;
    setError(null);
    try {
      const picked = await open({
        multiple: false,
        title: "Link the Ableton set for this track",
        filters: [{ name: "Ableton Live Set", extensions: ["als"] }],
      });
      if (picked == null) return;
      const path = Array.isArray(picked) ? picked[0] : picked;
      if (!path) return;
      const alsFile: AlsFile = {
        id: makeAlsId(),
        path,
        name: basename(path),
      };
      mutateProject(selected.id, (project) => ({
        ...project,
        tracks: project.tracks.map((track) => track.id === trackId
          ? { ...track, alsFile, title: track.title || titleFromFile(alsFile.name) }
          : track),
      }));
    } catch (err) {
      setError(String(err));
    }
  }

  function moveExport(exportId: string, dir: -1 | 1) {
    const trackId = selected?.tracks.find((track) => track.bounces.some((bounce) => bounce.id === exportId))?.id;
    if (trackId) moveTrack(trackId, dir);
  }

  function handleRemoveAls(trackId: string) {
    if (!selected) return;
    mutateProject(selected.id, (project) => ({
      ...project,
      tracks: project.tracks.map((track) => track.id === trackId ? { ...track, alsFile: null } : track),
    }));
  }

  async function startAddExport(trackId: string, playWhenReady = false, replaceBounceId: string | null = null) {
    setExpandedTrackIds((current) => new Set(current).add(trackId));
    if (isTauri()) {
      try {
        const picked = await open({
          multiple: false,
          title: "Choose the exported mix for this track",
          filters: [{
            name: "Audio exports",
            extensions: ["wav", "wave", "aif", "aiff", "flac", "mp3", "m4a", "aac", "ogg"],
          }],
        });
        const path = Array.isArray(picked) ? picked[0] : picked;
        if (!path) return;
        const bytes = await invoke<ArrayBuffer>("read_organizer_audio", { path });
        const bounce = await attachExportFile(trackId, new File([bytes], basename(path)), path, replaceBounceId);
        if (playWhenReady && bounce) playExport(bounce);
      } catch (err) {
        setError(String(err));
      }
      return;
    }
    pendingExportTrackId.current = trackId;
    pendingReplaceBounceId.current = replaceBounceId;
    pendingExportAutoPlay.current = playWhenReady;
    fileInputRef.current?.click();
  }

  async function handleFilePicked(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = ""; // allow re-adding the same file(s)
    const trackId = pendingExportTrackId.current;
    const playWhenReady = pendingExportAutoPlay.current;
    const replaceBounceId = pendingReplaceBounceId.current;
    pendingExportTrackId.current = null;
    pendingReplaceBounceId.current = null;
    pendingExportAutoPlay.current = false;
    if (!file || !selected || !trackId) return;
    const bounce = await attachExportFile(trackId, file, undefined, replaceBounceId);
    if (playWhenReady && bounce) playExport(bounce);
  }

  async function attachExportFile(
    trackId: string,
    file: File,
    sourcePath?: string,
    replaceBounceId: string | null = null,
  ) {
    if (!selected) return;
    setError(null);
    setAnalyzing(file.name);
    try {
      const analysis = await analyzeAudioFile(file);
      const previous = replaceBounceId
        ? selected.tracks.find((track) => track.id === trackId)?.bounces.find((candidate) => candidate.id === replaceBounceId)
        : null;
      const bounce: ExportBounce = {
        id: replaceBounceId ?? makeExportId(0),
        fileName: file.name,
        sourcePath,
        fileSizeBytes: file.size,
        durationSec: analysis.durationSec,
        sampleRate: analysis.sampleRate,
        channelCount: analysis.channelCount,
        peaks: analysis.peaks,
        waveformChannels: analysis.waveformChannels,
        waveformPoints: analysis.waveformPoints,
        ...measuredBounceFields(analysis),
        added_at_ms: Date.now(),
        timedComments: previous?.timedComments ?? [],
        volume: previous?.volume ?? 1,
      };
      dirtyWaveformIds.current.add(bounce.id);
      if (previous) releaseBounce(previous);
      urls.current.set(bounce.id, URL.createObjectURL(file));
      mutateProject(selected.id, (project) => ({
        ...project,
        tracks: project.tracks.map((track) => {
          if (track.id !== trackId) return track;
          const bounces = replaceBounceId
            ? track.bounces.map((candidate) => candidate.id === replaceBounceId ? bounce : candidate)
            : [...track.bounces, bounce];
          return {
            ...withTrackBounces(track, bounces, track.finalBounceId ?? bounce.id),
            title: track.title || titleFromFile(file.name),
          };
        }),
      }));
      setExpandedTrackIds((current) => new Set(current).add(trackId));
      return bounce;
    } catch {
      setError(`Couldn't read ${file.name}.`);
      return null;
    } finally {
      setAnalyzing(null);
    }
  }

  function releaseBounce(exp: ExportBounce) {
    if (activeExportId === exp.id) {
      audioRef.current?.pause();
      stopRaf();
      setIsPlaying(false);
      setActiveExportId(null);
      setProgress(0);
    }
    const url = urls.current.get(exp.id);
    if (url) {
      URL.revokeObjectURL(url);
      urls.current.delete(exp.id);
    }
  }

  function handleDeleteExport(trackIdOrExport: string | ExportBounce, maybeExport?: ExportBounce) {
    if (!selected) return;
    const exp = typeof trackIdOrExport === "string" ? maybeExport : trackIdOrExport;
    if (!exp) return;
    const trackId = typeof trackIdOrExport === "string"
      ? trackIdOrExport
      : selected.tracks.find((track) => track.bounces.some((bounce) => bounce.id === exp.id))?.id;
    if (!trackId) return;
    releaseBounce(exp);
    mutateProject(selected.id, (project) => ({
      ...project,
      tracks: project.tracks.map((track) => track.id === trackId
        ? withTrackBounces(track, track.bounces.filter((bounce) => bounce.id !== exp.id))
        : track),
    }));
  }

  function handleSetFinalBounce(trackId: string, bounceId: string) {
    if (!selected) return;
    mutateProject(selected.id, (project) => ({
      ...project,
      tracks: project.tracks.map((track) => track.id === trackId
        ? withTrackBounces(track, track.bounces, bounceId)
        : track),
    }));
  }

  function currentBounceTime(exp: ExportBounce): number {
    if (activeExportId !== exp.id) return 0;
    const currentTime = audioRef.current?.currentTime;
    if (currentTime != null && Number.isFinite(currentTime)) {
      return Math.min(exp.durationSec, Math.max(0, currentTime));
    }
    return Math.min(exp.durationSec, Math.max(0, progress * exp.durationSec));
  }

  function addTimedComment(trackId: string, exp: ExportBounce) {
    if (!selected) return;
    const text = (timedCommentDrafts[exp.id] ?? "").trim();
    if (!text) return;
    const timedComment: TimedComment = {
      id: `comment-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      timeSec: currentBounceTime(exp),
      text,
      created_at_ms: Date.now(),
    };
    mutateProject(selected.id, (project) => ({
      ...project,
      tracks: project.tracks.map((track) => {
        if (track.id !== trackId) return track;
        const bounces = track.bounces.map((bounce) => bounce.id === exp.id
          ? { ...bounce, timedComments: [...(bounce.timedComments ?? []), timedComment] }
          : bounce);
        return withTrackBounces(track, bounces);
      }),
    }));
    setTimedCommentDrafts((drafts) => ({ ...drafts, [exp.id]: "" }));
  }

  function deleteTimedComment(trackId: string, bounceId: string, commentId: string) {
    if (!selected) return;
    mutateProject(selected.id, (project) => ({
      ...project,
      tracks: project.tracks.map((track) => {
        if (track.id !== trackId) return track;
        const bounces = track.bounces.map((bounce) => bounce.id === bounceId
          ? { ...bounce, timedComments: (bounce.timedComments ?? []).filter((comment) => comment.id !== commentId) }
          : bounce);
        return withTrackBounces(track, bounces);
      }),
    }));
  }

  async function jumpToTimedComment(exp: ExportBounce, timeSec: number) {
    if (!urls.current.has(exp.id) && exp.sourcePath) {
      try {
        await ensureBounceUrl(exp);
      } catch {
        setError(`Couldn't reopen ${exp.fileName}. Use Replace to locate it again.`);
        return;
      }
    }
    if (!urls.current.has(exp.id)) {
      setError(`Locate ${exp.fileName} before jumping to its comments.`);
      return;
    }
    seekExport(exp, exp.durationSec > 0 ? timeSec / exp.durationSec : 0);
  }

  function playExport(exp: ExportBounce) {
    const audio = audioRef.current;
    const url = urls.current.get(exp.id);
    if (!audio || !url) return;
    if (activeExportId !== exp.id) {
      audio.src = url;
      setActiveExportId(exp.id);
      setProgress(0);
    }
    audio.volume = clampVolume(exp.volume ?? 1);
    void audio.play();
    setIsPlaying(true);
    stopRaf();
    lastProgressPaintRef.current = 0;
    rafRef.current = requestAnimationFrame(tick);
  }

  function togglePlay(exp: ExportBounce) {
    if (activeExportId === exp.id && isPlaying) {
      audioRef.current?.pause();
      setIsPlaying(false);
      stopRaf();
    } else {
      playExport(exp);
    }
  }

  async function handleMixPlay(trackId: string, exp: ExportBounce) {
    if (urls.current.has(exp.id)) {
      togglePlay(exp);
      return;
    }
    if (exp.sourcePath) {
      try {
        await ensureBounceUrl(exp);
        playExport(exp);
      } catch {
        setError(`Couldn't reopen ${exp.fileName}. Choose its current location.`);
        await startAddExport(trackId, true, exp.id);
      }
      return;
    }
    await startAddExport(trackId, true, exp.id);
  }

  function seekExport(exp: ExportBounce, fraction: number) {
    const audio = audioRef.current;
    const url = urls.current.get(exp.id);
    if (!audio || !url) return;
    if (activeExportId !== exp.id) {
      audio.src = url;
      setActiveExportId(exp.id);
    }
    const dur = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : exp.durationSec;
    audio.currentTime = fraction * dur;
    playbackCursorRef.current = { exportId: exp.id, timeSec: audio.currentTime };
    setProgress(fraction);
  }

  function handleEnded() {
    setIsPlaying(false);
    setProgress(0);
    stopRaf();
  }

  async function handleExportPreview() {
    if (!selected || previewTracks.length === 0) return;
    if (!isTauri()) {
      setPreviewExportStatus("Portable export is available in the Recall desktop app.");
      return;
    }
    const missingSources = previewTracks.filter((track) => !track.bounce.sourcePath);
    if (missingSources.length > 0) {
      setPreviewExportStatus(
        `${missingSources.length} final mix${missingSources.length === 1 ? "" : "es"} must be located before export.`,
      );
      return;
    }

    const outputPath = await save({
      title: "Save release package",
      defaultPath: `${portablePreviewFolderName(selected.name)}.zip`,
      filters: [{ name: "ZIP archive", extensions: ["zip"] }],
    });
    if (typeof outputPath !== "string") return;

    const portableTracks = previewTracks.map((track, index) => ({
      title: track.title,
      durationSec: track.bounce.durationSec,
      audioFileName: portableTrackFileName(index, track.title, track.bounce.fileName),
    }));
    const cover = portableCoverAsset(selected.coverImageDataUrl);
    const comments = buildReleaseCommentsText(selected, previewTracks);
    const html = buildReleasePreviewHtml(selected, portableTracks, cover?.fileName);
    setPreviewExporting(true);
    setPreviewExportStatus(null);
    try {
      const exportedPath = await invoke<string>("export_organizer_preview", {
        outputPath,
        html,
        comments,
        cover,
        files: previewTracks.map((track, index) => ({
          sourcePath: track.bounce.sourcePath!,
          outputName: portableTracks[index].audioFileName,
        })),
      });
      setPreviewExportStatus(`Exported to ${exportedPath}`);
    } catch (exportFailure) {
      setPreviewExportStatus(`Export failed: ${String(exportFailure)}`);
    } finally {
      setPreviewExporting(false);
    }
  }

  function toggleTrackPlayer(trackId: string) {
    const closing = expandedTrackIds.has(trackId);
    const closingActiveTrack = closing && selected?.tracks
      .find((track) => track.id === trackId)
      ?.bounces.some((bounce) => bounce.id === activeExportId);
    if (closingActiveTrack) {
      audioRef.current?.pause();
      stopRaf();
      setIsPlaying(false);
    }
    setExpandedTrackIds((current) => {
      const next = new Set(current);
      if (next.has(trackId)) next.delete(trackId);
      else next.add(trackId);
      return next;
    });
  }

  if (!storageReady) {
    return (
      <div className="organizer organizer--loading" aria-live="polite">
        <section className="organizer__detail organizer__detail--empty">
          <div className="organizer__blank">
            <strong>Opening Organizer…</strong>
            <p>Loading projects and mix-review assets from native storage.</p>
          </div>
        </section>
      </div>
    );
  }

  if (previewOpen && selected) {
    return (
      <>
        <audio ref={audioRef} preload="none" onEnded={handleEnded} hidden />
        <ReleasePreview
          project={selected}
          tracks={previewTracks}
          activeBounceId={activeExportId}
          isPlaying={isPlaying}
          progress={progress}
          incompleteTrackCount={selected.tracks.length - previewTracks.length}
          exporting={previewExporting}
          exportStatus={previewExportStatus}
          onBack={() => setPreviewOpen(false)}
          onExport={() => void handleExportPreview()}
          onPlay={(track) => void handleMixPlay(track.trackId, track.bounce)}
          onSeek={(track, fraction) => seekExport(track.bounce, fraction)}
        />
      </>
    );
  }

  return (
    <div className={`organizer ${selected?.coverImageDataUrl ? "has-gutter-art" : ""}`}>
      <audio ref={audioRef} preload="none" onEnded={handleEnded} hidden />
      <input
        ref={fileInputRef}
        type="file"
        accept="audio/*"
        hidden
        onChange={handleFilePicked}
      />
      <input
        ref={coverInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        hidden
        onChange={handleCoverPicked}
      />

      {selected?.coverImageDataUrl && (
        <>
          <div
            className="organizer__gutter-art organizer__gutter-art--left"
            style={{ backgroundImage: `url("${selected.coverImageDataUrl}")` }}
            aria-hidden="true"
          />
          <div
            className="organizer__gutter-art organizer__gutter-art--right"
            style={{ backgroundImage: `url("${selected.coverImageDataUrl}")` }}
            aria-hidden="true"
          />
        </>
      )}

      <aside className="organizer__list" aria-label="Projects">
        <div className="organizer__list-head">
          <span className="eyebrow">Organizer</span>
          <button type="button" className="px-btn px-btn--primary" onClick={handleNewProject}>
            New project
          </button>
        </div>

        {ordered.length === 0 ? (
          <p className="organizer__list-empty">
            Lay out a release — the Ableton sets that make it up and the bounces you exported.
            An EP is several songs in one project.
          </p>
        ) : (
          <div className="organizer__items">
            {ordered.map((project) => (
              <button
                key={project.id}
                type="button"
                className={`organizer__item ${selected?.id === project.id ? "is-selected" : ""}`}
                onClick={() => setSelectedId(project.id)}
              >
                <span className="organizer__item-title">
                  {project.name.trim() || "Untitled project"}
                </span>
                <span className="organizer__item-meta">
                  {project.tracks.length === 0
                    ? "No tracks"
                    : `${project.tracks.length} track${project.tracks.length === 1 ? "" : "s"}`}
                  {project.tracks.some((track) => track.bounces.length > 0)
                    ? ` · ${project.tracks.reduce((total, track) => total + track.bounces.length, 0)} mixes`
                    : ""}
                </span>
              </button>
            ))}
          </div>
        )}
      </aside>

      {selected ? (
        <section className="organizer__detail" aria-label="Project">
          <div className="organizer__detail-bar">
            <input
              className="organizer__name"
              value={selected.name}
              placeholder="Untitled project"
              aria-label="Project name"
              onChange={(event) => handleRename(event.target.value)}
            />
            <div className="organizer__detail-actions">
              <button
                type="button"
                className="px-btn"
                onClick={() => {
                  setPreviewExportStatus(null);
                  setPreviewOpen(true);
                }}
              >
                Preview release
              </button>
              <button
                type="button"
                className="px-btn px-btn--danger"
                onClick={() => void handleDeleteProject(selected)}
              >
                Delete
              </button>
            </div>
          </div>

          {error && <p className="organizer__error">{error}</p>}

          <div className="organizer__album-head">
            <div className="organizer__cover">
              {selected.coverImageDataUrl ? (
                <img src={selected.coverImageDataUrl} alt={`${selected.name || "Untitled"} cover`} />
              ) : (
                <div className="organizer__cover-empty">Cover art</div>
              )}
              <div className="organizer__cover-actions">
                <button type="button" className="px-btn" onClick={() => coverInputRef.current?.click()}>
                  {selected.coverImageDataUrl ? "Change image" : "Add image"}
                </button>
                {selected.coverImageDataUrl && (
                  <button type="button" className="px-btn px-btn--danger" onClick={handleRemoveCover}>Remove</button>
                )}
              </div>
            </div>
            <div className="organizer__album-meta">
              <div className="organizer__type" role="group" aria-label="Release type">
                {RELEASE_TYPES.map((type) => (
                  <button key={type} type="button" className={`organizer__type-btn ${selected.releaseType === type ? "is-active" : ""}`} aria-pressed={selected.releaseType === type} onClick={() => handleSetType(type)}>
                    {releaseTypeLabel(type)}
                  </button>
                ))}
              </div>

              <div className="organizer__project-fields">
                <label className="organizer__project-field">
                  <span className="organizer__field-label">Artist</span>
                  <input
                    className="organizer__project-input"
                    value={selected.artist}
                    placeholder="Artist or alias"
                    aria-label="Artist"
                    onChange={(event) => handleSetArtist(event.target.value)}
                  />
                </label>
                <label className="organizer__project-field organizer__project-field--date">
                  <span className="organizer__field-label">Release date</span>
                  <input
                    className="organizer__project-input"
                    type="date"
                    value={selected.releaseDate}
                    aria-label="Release date"
                    onChange={(event) => handleSetReleaseDate(event.target.value)}
                  />
                </label>
              </div>

              <label className="organizer__project-field organizer__project-field--notes">
                <span className="organizer__field-label">Notes</span>
                <textarea
                  className="organizer__project-notes"
                  value={selected.notes}
                  placeholder="The concept, the vibe, the order in your head — what this release is."
                  aria-label="Project notes"
                  rows={2}
                  onChange={(event) => handleSetNotes(event.target.value)}
                />
              </label>

              {releaseStats && (
                <div className="organizer__release-meta">
                  <span>{releaseStats.trackCount} track{releaseStats.trackCount === 1 ? "" : "s"}</span>
                  {releaseStats.completedCount > 0 && <span>{releaseStats.completedCount} mixed</span>}
                  {releaseStats.completedCount > 0 && <span>{formatTotalDuration(releaseStats.totalSec)}</span>}
                  {releaseStats.loudnessSpan && <span title="Integrated loudness span across tracks">{releaseStats.loudnessSpan.min.toFixed(1)} to {releaseStats.loudnessSpan.max.toFixed(1)} LUFS</span>}
                </div>
              )}
            </div>
          </div>

          {releaseStats && releaseStats.completedCount > 0 && (
            <section className="organizer__mastering-overview" aria-label="Release mastering consistency">
              <div>
                <span className="organizer__field-label">Release consistency</span>
                <strong>{releaseStats.completedCount} selected mix{releaseStats.completedCount === 1 ? "" : "es"}</strong>
              </div>
              <dl>
                <div>
                  <dt>LUFS span</dt>
                  <dd>{releaseStats.loudnessSpan ? `${releaseStats.loudnessSpan.min.toFixed(1)} to ${releaseStats.loudnessSpan.max.toFixed(1)}` : "Unavailable"}</dd>
                </div>
                <div>
                  <dt>PLR span</dt>
                  <dd>{releaseStats.plrSpan ? `${releaseStats.plrSpan.min.toFixed(1)} to ${releaseStats.plrSpan.max.toFixed(1)} dB` : "Unavailable"}</dd>
                </div>
                <div>
                  <dt>Highest true peak</dt>
                  <dd>{releaseStats.maximumTruePeak == null ? "Unavailable" : formatDb(releaseStats.maximumTruePeak, "dBTP")}</dd>
                </div>
                <div>
                  <dt>Full-scale samples</dt>
                  <dd className={releaseStats.clippedSampleCount > 0 ? "is-warning" : undefined}>{releaseStats.clippedSampleCount.toLocaleString()}</dd>
                </div>
                <div>
                  <dt>Delivery format</dt>
                  <dd className={!releaseStats.formatsMatch ? "is-warning" : undefined}>{releaseStats.formatsMatch ? "Consistent" : "Mismatch"}</dd>
                </div>
              </dl>
            </section>
          )}

          <div className="organizer__tracklist-head">
            <span className="organizer__field-label">Tracklist</span>
            <button type="button" className="px-btn px-btn--primary" onClick={handleAddTrack}>Add track</button>
          </div>
          {analyzing && (
            <p className="organizer__analyzing organizer__analyzing--tracklist">
              Measuring loudness of {analyzing}…
            </p>
          )}

          <div className="organizer__tracklist">
            {selected.tracks.map((track, index) => {
              const expanded = expandedTrackIds.has(track.id);
              const label = track.title.trim() || `Track ${index + 1}`;
              return (
                <article
                  key={track.id}
                  data-track-id={track.id}
                  className={`organizer__track ${track.bounces.some((bounce) => bounce.id === activeExportId) ? "has-active-playback" : ""} ${draggedTrackId === track.id ? "is-dragging" : ""} ${dragOverTrackId === track.id ? "is-drag-over" : ""}`}
                >
                  <header className="organizer__track-head">
                    <button
                      type="button"
                      className="organizer__drag-handle"
                      aria-label={`Drag ${label} to reorder`}
                      title="Drag to reorder"
                      onMouseDown={(event) => beginTrackDrag(event, track.id)}
                    >⠿</button>
                    <span className="organizer__track-num">{(index + 1).toString().padStart(2, "0")}</span>
                    <input className="organizer__track-title" value={track.title} placeholder={`Track ${index + 1} title`} aria-label={`Track ${index + 1} title`} onChange={(event) => handleRenameTrack(track.id, event.target.value)} />
                    <div className="organizer__bounce-actions">
                      <button type="button" className="organizer__reorder" disabled={index === 0} aria-label={`Move ${label} up`} onClick={() => moveTrack(track.id, -1)}>↑</button>
                      <button type="button" className="organizer__reorder" disabled={index === selected.tracks.length - 1} aria-label={`Move ${label} down`} onClick={() => moveTrack(track.id, 1)}>↓</button>
                      <button type="button" className="px-btn px-btn--danger" onClick={() => handleDeleteTrack(track)}>Remove track</button>
                    </div>
                  </header>

                  <div className="organizer__source-row">
                    <div className="organizer__source-file">
                      <span className="organizer__field-label">Ableton set</span>
                      {track.alsFile ? <span className="organizer__als-name" title={track.alsFile.path}>{track.alsFile.name}</span> : <span className="organizer__als-none">No .als linked</span>}
                    </div>
                    <div className="organizer__source-actions">
                      <button type="button" className="px-btn" onClick={() => void handleAddAls(track.id)}>{track.alsFile ? "Change .als" : "Link .als"}</button>
                      {track.alsFile && <button type="button" className="px-btn px-btn--danger" onClick={() => handleRemoveAls(track.id)}>Unlink</button>}
                    </div>
                  </div>

                  <div className="organizer__versions-head">
                    <div>
                      <span className="organizer__field-label">Mix versions</span>
                      <span>{track.bounces.length} export{track.bounces.length === 1 ? "" : "s"}</span>
                    </div>
                    <div className="organizer__bounce-actions">
                      {track.bounces.length > 0 && <button type="button" className="px-btn" aria-expanded={expanded} onClick={() => toggleTrackPlayer(track.id)}>{expanded ? "Hide players" : "Compare versions"}</button>}
                      <button type="button" className="px-btn px-btn--primary" disabled={analyzing !== null} onClick={() => void startAddExport(track.id)}>Add version</button>
                    </div>
                  </div>

                  {track.bounces.length > 0 ? track.bounces.map((exp, bounceIndex) => {
                    const playable = urls.current.has(exp.id);
                    const active = activeExportId === exp.id;
                    const isFinal = track.finalBounceId === exp.id;
                    const version = versionLabel(bounceIndex);
                    const timedComments = [...(exp.timedComments ?? [])].sort((a, b) => a.timeSec - b.timeSec);
                    const playbackTime = active ? progress * exp.durationSec : 0;
                    const nextComment = active
                      ? timedComments.find((comment) => comment.timeSec > playbackTime)
                      : undefined;
                    const secondsUntilNextComment = nextComment ? nextComment.timeSec - playbackTime : null;
                    const flags = masteringFlags(exp);
                    const spotifyPreview = spotifyNormalPreview(exp.integratedLufs, exp.peakDb);
                    const commentEmphasis = (comment: TimedComment) => {
                      if (!active || comment.timeSec <= playbackTime) return 1;
                      return Math.max(0, 1 - (comment.timeSec - playbackTime) / 20);
                    };
                    return (
                      <div key={exp.id} className={`organizer__mix organizer__mix--version ${isFinal ? "is-final" : ""} ${active ? "is-active" : ""} ${active && isPlaying ? "is-playing" : ""}`}>
                        <div className="organizer__bounce-head">
                          <div className="organizer__bounce-title">
                            <span className="organizer__version-line"><span className="organizer__version-badge">{version}</span>{isFinal && <span className="organizer__final-badge">Final</span>}</span>
                            <span className="organizer__bounce-name">{exp.fileName}</span>
                          </div>
                          <div className="organizer__bounce-actions">
                            <span className="organizer__bounce-added">{formatDate(exp.added_at_ms)}</span>
                            <button type="button" className="px-btn" disabled={isFinal} onClick={() => handleSetFinalBounce(track.id, exp.id)}>{isFinal ? "Selected final" : "Mark final"}</button>
                            <button type="button" className="px-btn" onClick={() => void startAddExport(track.id, false, exp.id)}>Replace</button>
                            <button type="button" className="px-btn px-btn--danger" onClick={() => handleDeleteExport(track.id, exp)}>Remove</button>
                          </div>
                        </div>
                        {expanded && (
                          <>
                            <div className="organizer__player">
                              <button type="button" className={`organizer__play ${active && isPlaying ? "is-playing" : ""}`} aria-label={active && isPlaying ? `Pause version ${version}` : playable ? `Play version ${version}` : `Locate version ${version} and play`} title={playable ? `Play version ${version}` : "Locate audio file to play"} onClick={() => void handleMixPlay(track.id, exp)}>{active && isPlaying ? "❚❚" : "▶"}</button>
                              <div className="organizer__player-main">
                                {nextComment && secondsUntilNextComment != null && secondsUntilNextComment <= 20 && (
                                  <div
                                    className="organizer__comment-coming"
                                    style={{ opacity: 0.38 + commentEmphasis(nextComment) * 0.62 }}
                                    aria-live="polite"
                                  >
                                    <span>Comment in {formatDuration(Math.ceil(secondsUntilNextComment))}</span>
                                    <strong>{nextComment.text}</strong>
                                  </div>
                                )}
                                <Waveform
                                  peaks={exp.peaks}
                                  waveformMin={exp.waveformMin}
                                  waveformMax={exp.waveformMax}
                                  waveformData={exp.waveformData}
                                  waveformChannels={exp.waveformChannels}
                                  waveformPoints={exp.waveformPoints}
                                  progress={active ? progress : 0}
                                  durationSec={exp.durationSec}
                                  markers={timedComments.map((comment) => ({
                                    id: comment.id,
                                    fraction: exp.durationSec > 0 ? comment.timeSec / exp.durationSec : 0,
                                    emphasis: commentEmphasis(comment),
                                  }))}
                                  onSeek={playable ? (fraction) => seekExport(exp, fraction) : undefined}
                                />
                                <label className="organizer__volume organizer__volume--version">
                                  <span className="organizer__volume-label">Version volume</span>
                                  <input
                                    type="range"
                                    min="0"
                                    max="1"
                                    step="0.01"
                                    value={exp.volume ?? 1}
                                    aria-label={`Version ${version} volume`}
                                    onChange={(event) => handleVersionVolume(track.id, exp.id, Number(event.target.value))}
                                  />
                                  <output>{volumePercent(exp.volume)}%</output>
                                </label>
                              </div>
                            </div>
                            <dl className="organizer__stats">
                              <div className="organizer__stat"><dt>Length</dt><dd>{formatDuration(exp.durationSec)}</dd></div>
                              <div className="organizer__stat"><dt>Integrated</dt><dd>{formatLufs(exp.integratedLufs)}</dd></div>
                              <div className="organizer__stat">
                                <dt title="Peak-to-loudness ratio: peak level minus integrated LUFS.">
                                  Dynamics (PLR)
                                </dt>
                                <dd className={producerDynamicRangeDb(exp.integratedLufs, exp.peakDb) == null ? "organizer__stat-empty" : undefined}>
                                  {formatDynamicRange(producerDynamicRangeDb(exp.integratedLufs, exp.peakDb))}
                                </dd>
                              </div>
                              <div className="organizer__stat">
                                <dt title="EBU R128 loudness range: the statistical spread of short-term loudness across the track.">
                                  Loudness range (LRA)
                                </dt>
                                <dd className={exp.dynamicRangeLu == null ? "organizer__stat-empty" : undefined}>
                                  {exp.dynamicRangeLu == null ? "Not long enough" : formatLoudnessRange(exp.dynamicRangeLu)}
                                </dd>
                              </div>
                              <div className="organizer__stat"><dt>{exp.peakKind === "true" ? "True peak" : "Sample peak"}</dt><dd>{formatDb(exp.peakDb, exp.peakKind === "true" ? "dBTP" : "dBFS")}</dd></div>
                              <div className="organizer__stat"><dt>Format</dt><dd>{Math.round(exp.sampleRate / 100) / 10} kHz · {exp.bitDepth == null ? "" : `${exp.bitDepth}-bit · `}{exp.channelCount === 1 ? "mono" : exp.channelCount === 2 ? "stereo" : `${exp.channelCount}ch`}</dd></div>
                            </dl>
                            <details className="organizer__mastering-details">
                              <summary>
                                <span>Mastering details</span>
                                {flags.length > 0 && <span className="organizer__mastering-count">{flags.length} item{flags.length === 1 ? "" : "s"} to review</span>}
                              </summary>
                              {flags.length > 0 && (
                                <ul className="organizer__mastering-flags">
                                  {flags.map((flag) => (
                                    <li key={`${flag.severity}-${flag.text}`} className={`is-${flag.severity}`}>{flag.text}</li>
                                  ))}
                                </ul>
                              )}
                              <dl className="organizer__mastering-grid">
                                <div><dt>Max momentary</dt><dd>{exp.maxMomentaryLufs == null ? "Unavailable" : `${exp.maxMomentaryLufs.toFixed(1)} LUFS${exp.maxMomentaryTimeSec == null ? "" : ` at ${formatDuration(exp.maxMomentaryTimeSec)}`}`}</dd></div>
                                <div><dt>Max short-term</dt><dd>{exp.maxShortTermLufs == null ? "Unavailable" : `${exp.maxShortTermLufs.toFixed(1)} LUFS${exp.maxShortTermTimeSec == null ? "" : ` at ${formatDuration(exp.maxShortTermTimeSec)}`}`}</dd></div>
                                <div><dt>Sample peak</dt><dd>{exp.samplePeakDb == null ? "Unavailable" : formatDb(exp.samplePeakDb, "dBFS")}</dd></div>
                                <div><dt>Full-scale samples</dt><dd>{exp.clippedSampleCount == null ? "Unavailable" : exp.clippedSampleCount.toLocaleString()}</dd></div>
                                <div><dt>DC offset</dt><dd>{exp.dcOffsetDb == null ? "Unavailable" : formatDb(exp.dcOffsetDb, "dBFS")}</dd></div>
                                <div><dt>Stereo correlation</dt><dd>{exp.stereoCorrelation == null ? "Unavailable" : exp.stereoCorrelation.toFixed(3)}</dd></div>
                                <div><dt>L/R balance</dt><dd>{exp.stereoBalanceDb == null ? "Unavailable" : `${formatSignedDb(exp.stereoBalanceDb)} ${exp.stereoBalanceDb > 0 ? "L" : exp.stereoBalanceDb < 0 ? "R" : ""}`}</dd></div>
                                <div><dt>Source depth</dt><dd>{exp.bitDepth == null ? "Unavailable" : `${exp.bitDepth}-bit`}</dd></div>
                                <div><dt>Leading below -60 dBFS</dt><dd>{exp.leadingSilenceSec == null ? "Unavailable" : `${exp.leadingSilenceSec.toFixed(2)} s`}</dd></div>
                                <div><dt>Trailing below -60 dBFS</dt><dd>{exp.trailingSilenceSec == null ? "Unavailable" : `${exp.trailingSilenceSec.toFixed(2)} s`}</dd></div>
                              </dl>
                              <div className="organizer__streaming-preview">
                                <span className="organizer__field-label">Spotify Normal estimate</span>
                                {spotifyPreview ? (
                                  <dl>
                                    <div><dt>Playback gain</dt><dd>{formatSignedDb(spotifyPreview.appliedGainDb)}</dd></div>
                                    <div><dt>Estimated loudness</dt><dd>{spotifyPreview.estimatedLufs.toFixed(1)} LUFS</dd></div>
                                    <div><dt>Estimated true peak</dt><dd>{formatDb(spotifyPreview.estimatedTruePeakDb, "dBTP")}</dd></div>
                                    <div><dt>Gain limited by headroom</dt><dd>{spotifyPreview.headroomLimited ? "Yes" : "No"}</dd></div>
                                  </dl>
                                ) : (
                                  <p>Unavailable until integrated loudness and true peak are measured.</p>
                                )}
                                <small>Playback-policy estimate, not a measured property of the source or a delivery guarantee.</small>
                              </div>
                            </details>
                            <div className="organizer__timed-comments">
                              <form className="organizer__timed-comment-form" onSubmit={(event) => { event.preventDefault(); addTimedComment(track.id, exp); }}>
                                <label>
                                  <span className="organizer__field-label">Comment at {formatDuration(currentBounceTime(exp))}</span>
                                  <input
                                    type="text"
                                    value={timedCommentDrafts[exp.id] ?? ""}
                                    placeholder="Leave a note at this playhead position…"
                                    aria-label={`Comment on version ${version} at ${formatDuration(currentBounceTime(exp))}`}
                                    onChange={(event) => setTimedCommentDrafts((drafts) => ({ ...drafts, [exp.id]: event.target.value }))}
                                  />
                                </label>
                                <button type="submit" className="px-btn px-btn--primary" disabled={!(timedCommentDrafts[exp.id] ?? "").trim()}>Add comment</button>
                              </form>
                              {timedComments.length > 0 && (
                                <ol className="organizer__comment-chain" aria-label={`Timed comments for version ${version}`}>
                                  {timedComments.map((comment) => (
                                    <li
                                      key={comment.id}
                                      className={attentionCommentIds.has(comment.id) ? "is-attention" : comment.timeSec > playbackTime && active ? "is-upcoming" : undefined}
                                      style={{ opacity: active && comment.timeSec > playbackTime ? 0.28 + commentEmphasis(comment) * 0.72 : 1 }}
                                    >
                                      <button type="button" className="organizer__comment-time" onClick={() => void jumpToTimedComment(exp, comment.timeSec)}>{formatDuration(comment.timeSec)}</button>
                                      <span className={`organizer__comment-text ${attentionCommentIds.has(comment.id) ? "is-rolling" : ""}`} aria-label={comment.text}>
                                        {attentionCommentIds.has(comment.id)
                                          ? comment.text.split("").map((letter, letterIndex) => (
                                              <span key={`${comment.id}-${letterIndex}`} aria-hidden="true" style={{ animationDelay: `${letterIndex * 22}ms` }}>{letter === " " ? "\u00a0" : letter}</span>
                                            ))
                                          : comment.text}
                                      </span>
                                      <button type="button" className="organizer__comment-delete" aria-label={`Delete comment at ${formatDuration(comment.timeSec)}`} onClick={() => deleteTimedComment(track.id, exp.id, comment.id)}>×</button>
                                    </li>
                                  ))}
                                </ol>
                              )}
                            </div>
                          </>
                        )}
                      </div>
                    );
                  }) : (
                    <div className="organizer__export-slot">
                      <div><strong>No exports attached yet.</strong></div>
                    </div>
                  )}

                  <label className="organizer__comment">
                    <span className="organizer__field-label">Track comments</span>
                    <textarea value={track.comment} placeholder="Mix notes, revisions, arrangement decisions…" aria-label={`${label} comments`} onChange={(event) => handleTrackComment(track.id, event.target.value)} />
                  </label>
                </article>
              );
            })}
            {selected.tracks.length === 0 && <div className="organizer__exports-empty"><strong>No tracks yet.</strong><button type="button" className="px-btn px-btn--primary" onClick={handleAddTrack}>Add track</button></div>}
          </div>

          <div className="organizer__release">
            <div className="organizer__type" role="group" aria-label="Release type">
              {RELEASE_TYPES.map((type) => (
                <button
                  key={type}
                  type="button"
                  className={`organizer__type-btn ${selected.releaseType === type ? "is-active" : ""}`}
                  aria-pressed={selected.releaseType === type}
                  onClick={() => handleSetType(type)}
                >
                  {releaseTypeLabel(type)}
                </button>
              ))}
            </div>
            {releaseStats && (
              <div className="organizer__release-meta">
                <span>
                  {releaseStats.trackCount} track{releaseStats.trackCount === 1 ? "" : "s"}
                </span>
                {releaseStats.trackCount > 0 && (
                  <span>{formatTotalDuration(releaseStats.totalSec)}</span>
                )}
                {releaseStats.loudnessSpan != null && (
                  <span title="Integrated loudness span across tracks">
                    {releaseStats.loudnessSpan.min.toFixed(1)} to{" "}
                    {releaseStats.loudnessSpan.max.toFixed(1)} LUFS
                  </span>
                )}
              </div>
            )}
          </div>

          <div className="organizer__als">
            <div className="organizer__als-head">
              <span className="organizer__field-label">Ableton projects</span>
              <button type="button" className="px-btn" onClick={() => void handleAddAls()}>
                Add .als…
              </button>
            </div>
            {selected.alsFiles.length === 0 ? (
              <span className="organizer__als-none">No sets linked yet</span>
            ) : (
              <ul className="organizer__als-list">
                {selected.alsFiles.map((file) => (
                  <li key={file.id} className="organizer__als-item">
                    <span className="organizer__als-name" title={file.path}>
                      {file.name}
                    </span>
                    <button
                      type="button"
                      className="px-btn px-btn--danger"
                      onClick={() => handleRemoveAls(file.id)}
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="organizer__exports-head">
            <span className="organizer__field-label">Exports</span>
            <button
              type="button"
              className="px-btn px-btn--primary"
              disabled={analyzing !== null}
              onClick={() => fileInputRef.current?.click()}
            >
              {analyzing ? "Reading…" : "Add exports…"}
            </button>
          </div>

          {analyzing && (
            <p className="organizer__analyzing">Measuring loudness of {analyzing}…</p>
          )}

          {selected.exports.length === 0 && !analyzing ? (
            <div className="organizer__exports-empty">
              <strong>No bounces yet.</strong>
              <p>
                Add a rendered mixdown (WAV, AIFF, MP3, FLAC) and Recall shows its waveform,
                integrated LUFS, loudness range, and true peak.
              </p>
            </div>
          ) : (
            <div className="organizer__exports">
              {selected.exports.map((exp, index) => {
                const playable = urls.current.has(exp.id);
                const active = activeExportId === exp.id;
                return (
                  <article key={exp.id} className="organizer__bounce">
                    <div className="organizer__bounce-head">
                      <div className="organizer__bounce-title">
                        <span className="organizer__track-num" aria-hidden="true">
                          {index + 1}
                        </span>
                        <span className="organizer__bounce-name">
                          <span className="sr-only">{`Track ${index + 1}: `}</span>
                          {exp.fileName}
                        </span>
                      </div>
                      <div className="organizer__bounce-actions">
                        <span className="organizer__bounce-added">
                          {formatDate(exp.added_at_ms)}
                        </span>
                        <button
                          type="button"
                          className="organizer__reorder"
                          disabled={index === 0}
                          aria-label={`Move ${exp.fileName} up`}
                          onClick={() => moveExport(exp.id, -1)}
                        >
                          ↑
                        </button>
                        <button
                          type="button"
                          className="organizer__reorder"
                          disabled={index === selected.exports.length - 1}
                          aria-label={`Move ${exp.fileName} down`}
                          onClick={() => moveExport(exp.id, 1)}
                        >
                          ↓
                        </button>
                        <button
                          type="button"
                          className="px-btn px-btn--danger"
                          onClick={() => handleDeleteExport(exp)}
                        >
                          Remove
                        </button>
                      </div>
                    </div>

                    <div className="organizer__player">
                      <button
                        type="button"
                        className="organizer__play"
                        disabled={!playable}
                        aria-label={active && isPlaying ? "Pause" : "Play"}
                        title={playable ? undefined : "Re-add this file to play it again"}
                        onClick={() => togglePlay(exp)}
                      >
                        {active && isPlaying ? "❚❚" : "►"}
                      </button>
                      <Waveform
                        peaks={exp.peaks}
                        waveformMin={exp.waveformMin}
                        waveformMax={exp.waveformMax}
                        waveformData={exp.waveformData}
                        waveformChannels={exp.waveformChannels}
                        waveformPoints={exp.waveformPoints}
                        progress={active ? progress : 0}
                        onSeek={playable ? (f) => seekExport(exp, f) : undefined}
                      />
                    </div>

                    <dl className="organizer__stats">
                      <div className="organizer__stat">
                        <dt>Length</dt>
                        <dd>{formatDuration(exp.durationSec)}</dd>
                      </div>
                      <div className="organizer__stat">
                        <dt>Integrated</dt>
                        <dd>{formatLufs(exp.integratedLufs)}</dd>
                      </div>
                      <div className="organizer__stat">
                        <dt title="Peak-to-loudness ratio: peak level minus integrated LUFS.">
                          Dynamics (PLR)
                        </dt>
                        {producerDynamicRangeDb(exp.integratedLufs, exp.peakDb) == null ? (
                          <dd
                            className="organizer__stat-empty"
                            title="Integrated loudness or peak measurement is unavailable."
                          >
                            Unavailable
                          </dd>
                        ) : (
                          <dd>{formatDynamicRange(producerDynamicRangeDb(exp.integratedLufs, exp.peakDb))}</dd>
                        )}
                      </div>
                      <div className="organizer__stat">
                        <dt title="EBU R128 loudness range: the statistical spread of short-term loudness across the track.">
                          Loudness range (LRA)
                        </dt>
                        {exp.dynamicRangeLu == null ? (
                          <dd
                            className="organizer__stat-empty"
                            title="Bounce is under approximately 3 seconds, so loudness range cannot be measured."
                          >
                            Not long enough
                          </dd>
                        ) : (
                          <dd>{formatLoudnessRange(exp.dynamicRangeLu)}</dd>
                        )}
                      </div>
                      <div className="organizer__stat">
                        <dt>{exp.peakKind === "true" ? "True peak" : "Sample peak"}</dt>
                        <dd>
                          {formatDb(exp.peakDb, exp.peakKind === "true" ? "dBTP" : "dBFS")}
                        </dd>
                      </div>
                      <div className="organizer__stat">
                        <dt>Format</dt>
                        <dd>
                          {Math.round(exp.sampleRate / 100) / 10} kHz ·{" "}
                          {exp.channelCount === 1 ? "mono" : exp.channelCount === 2 ? "stereo" : `${exp.channelCount}ch`}
                        </dd>
                      </div>
                    </dl>
                  </article>
                );
              })}
            </div>
          )}
        </section>
      ) : (
        <section className="organizer__detail organizer__detail--empty">
          <div className="organizer__blank">
            <strong>Nothing laid out yet.</strong>
            <p>Create a project, link its Ableton set, and drop in the bounces you exported.</p>
            <button type="button" className="px-btn px-btn--primary" onClick={handleNewProject}>
              New project
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
