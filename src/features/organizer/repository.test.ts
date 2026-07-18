import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  LEGACY_STORAGE_KEY,
  MIGRATION_MARKER_KEY,
  mapLegacyToNative,
  parseLegacyProjects,
  runLegacyMigration,
  type NativeProject,
} from "./repository";

// A minimal localStorage stand-in backed by a Map.
function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
  };
}

const legacyTracksProject = {
  id: "org-1",
  name: "Perseus EP",
  artist: "Inspected",
  releaseDate: "2026-08-01",
  notes: "the concept",
  releaseType: "ep",
  coverImageDataUrl: "data:image/webp;base64,Zm9v",
  // compatibility projections the UI keeps — must be ignored, not migrated as data
  alsFiles: [{ id: "als-x", path: "C:/x.als", name: "x.als" }],
  exports: [],
  tracks: [
    {
      id: "track-1",
      title: "Intro",
      comment: "mix notes",
      alsFile: { id: "als-1", path: "C:/music/intro.als", name: "intro.als" },
      finalBounceId: "b-1b",
      bounce: { id: "b-1a" }, // compat projection
      bounces: [
        {
          id: "b-1a",
          fileName: "intro v1.wav",
          sourcePath: "C:/music/intro v1.wav",
          fileSizeBytes: 111,
          durationSec: 90,
          sampleRate: 48000,
          channelCount: 2,
          peaks: [0.1, 0.2],
          waveformChannels: ["AAAA", "BBBB"],
          waveformPoints: 2,
          integratedLufs: -9.1,
          dynamicRangeLu: 7.5,
          maxMomentaryLufs: -6.2,
          maxMomentaryTimeSec: 38.4,
          maxShortTermLufs: -7.1,
          maxShortTermTimeSec: 37.2,
          peakDb: -0.4,
          samplePeakDb: -0.7,
          clippedSampleCount: 0,
          dcOffsetDb: -88,
          stereoCorrelation: 0.81,
          stereoBalanceDb: -0.15,
          bitDepth: 24,
          leadingSilenceSec: 0.12,
          trailingSilenceSec: 0.42,
          peakKind: "true",
          analysisVersion: 4,
          volume: 0.8,
          added_at_ms: 1000,
          timedComments: [
            { id: "c-1", timeSec: 12.5, text: "drop", created_at_ms: 900 },
          ],
        },
        {
          id: "b-1b",
          fileName: "intro v2.wav",
          durationSec: 92,
          sampleRate: 48000,
          channelCount: 2,
          peaks: [],
          integratedLufs: null,
          dynamicRangeLu: null,
          peakDb: 0.1,
          volume: 1,
          added_at_ms: 2000,
          timedComments: [],
        },
      ],
    },
    {
      id: "track-2",
      title: "Outro",
      comment: "",
      alsFile: null,
      finalBounceId: null,
      bounces: [],
    },
  ],
  created_at_ms: 500,
  updated_at_ms: 600,
};

describe("mapLegacyToNative", () => {
  it("preserves the full tree without data loss", () => {
    const native = mapLegacyToNative(legacyTracksProject)!;
    expect(native.id).toBe("org-1");
    expect(native.artist).toBe("Inspected");
    expect(native.releaseDate).toBe("2026-08-01");
    expect(native.notes).toBe("the concept");
    expect(native.releaseType).toBe("ep");
    expect(native.coverImageDataUrl).toBe("data:image/webp;base64,Zm9v");
    expect(native.tracks).toHaveLength(2);

    const [t1, t2] = native.tracks;
    expect(t1.title).toBe("Intro");
    expect(t1.alsFile?.name).toBe("intro.als");
    expect(t1.bounces).toHaveLength(2);
    // Track order and version order preserved.
    expect(t1.bounces.map((b) => b.id)).toEqual(["b-1a", "b-1b"]);
    expect(t1.finalBounceId).toBe("b-1b");

    const b1 = t1.bounces[0];
    expect(b1.integratedLufs).toBe(-9.1);
    expect(b1.dynamicRangeLu).toBe(7.5);
    expect(b1.maxMomentaryLufs).toBe(-6.2);
    expect(b1.maxShortTermTimeSec).toBe(37.2);
    expect(b1.peakDb).toBe(-0.4);
    expect(b1.samplePeakDb).toBe(-0.7);
    expect(b1.stereoCorrelation).toBe(0.81);
    expect(b1.bitDepth).toBe(24);
    expect(b1.peakKind).toBe("true");
    expect(b1.volume).toBe(0.8);
    expect(b1.sourcePath).toBe("C:/music/intro v1.wav");
    expect(b1.waveformChannels).toEqual(["AAAA", "BBBB"]);
    expect(b1.timedComments).toEqual([
      { id: "c-1", timeSec: 12.5, text: "drop", created_at_ms: 900 },
    ]);

    expect(t2.bounces).toHaveLength(0);
  });

  it("repairs a final selection that points at a missing version", () => {
    const raw = structuredClone(legacyTracksProject);
    raw.tracks[0].finalBounceId = "does-not-exist";
    const native = mapLegacyToNative(raw)!;
    expect(native.tracks[0].finalBounceId).toBe("b-1a"); // first version
  });

  it("pairs the pre-tracklist alsFiles/exports shape into tracks", () => {
    const legacy = {
      id: "org-legacy",
      name: "Old",
      alsFiles: [
        { id: "a1", path: "C:/1.als", name: "1.als" },
        { id: "a2", path: "C:/2.als", name: "2.als" },
      ],
      exports: [
        { id: "e1", fileName: "1.wav", integratedLufs: -8, peakDb: -1, volume: 1, added_at_ms: 1 },
      ],
      created_at_ms: 1,
      updated_at_ms: 2,
    };
    const native = mapLegacyToNative(legacy)!;
    expect(native.tracks).toHaveLength(2);
    expect(native.tracks[0].alsFile?.name).toBe("1.als");
    expect(native.tracks[0].bounces[0]?.id).toBe("e1");
    expect(native.tracks[1].alsFile?.name).toBe("2.als");
    expect(native.tracks[1].bounces).toHaveLength(0);
  });

  it("rejects records without an id or name", () => {
    expect(mapLegacyToNative({ name: "x" })).toBeNull();
    expect(mapLegacyToNative(null)).toBeNull();
  });
});

describe("parseLegacyProjects", () => {
  it("returns [] for missing, invalid, or non-array JSON", () => {
    expect(parseLegacyProjects(null)).toEqual([]);
    expect(parseLegacyProjects("not json")).toEqual([]);
    expect(parseLegacyProjects('{"id":"x"}')).toEqual([]);
  });

  it("maps an array and drops malformed records", () => {
    const json = JSON.stringify([legacyTracksProject, { junk: true }]);
    const projects = parseLegacyProjects(json);
    expect(projects).toHaveLength(1);
    expect(projects[0].id).toBe("org-1");
  });
});

describe("runLegacyMigration", () => {
  const workingRepo = () => {
    const store = new Map<string, NativeProject>();
    return {
      store,
      load: vi.fn(async () => [...store.values()]),
      save: vi.fn(async (project: NativeProject) => void store.set(project.id, project)),
    };
  };

  beforeEach(() => vi.clearAllMocks());

  it("migrates, verifies, then clears the legacy key and sets the marker", async () => {
    const storage = fakeStorage({
      [LEGACY_STORAGE_KEY]: JSON.stringify([legacyTracksProject]),
    });
    const repo = workingRepo();

    const result = await runLegacyMigration(repo, storage);

    expect(result).toEqual({ status: "migrated", migrated: 1 });
    expect(repo.save).toHaveBeenCalledTimes(1);
    expect(storage.getItem(MIGRATION_MARKER_KEY)).toBe("1");
    expect(storage.getItem(LEGACY_STORAGE_KEY)).toBeNull();
  });

  it("is a no-op when the marker is already set", async () => {
    const storage = fakeStorage({
      [MIGRATION_MARKER_KEY]: "1",
      [LEGACY_STORAGE_KEY]: JSON.stringify([legacyTracksProject]),
    });
    const repo = workingRepo();

    const result = await runLegacyMigration(repo, storage);

    expect(result.status).toBe("skipped");
    expect(repo.save).not.toHaveBeenCalled();
    // Legacy key is left alone; the marker already guarded this run.
    expect(storage.getItem(LEGACY_STORAGE_KEY)).not.toBeNull();
  });

  it("marks empty storage migrated without touching the repo", async () => {
    const storage = fakeStorage();
    const repo = workingRepo();

    const result = await runLegacyMigration(repo, storage);

    expect(result).toEqual({ status: "empty", migrated: 0 });
    expect(repo.save).not.toHaveBeenCalled();
    expect(storage.getItem(MIGRATION_MARKER_KEY)).toBe("1");
  });

  it("preserves localStorage and does not set the marker when a save fails", async () => {
    const storage = fakeStorage({
      [LEGACY_STORAGE_KEY]: JSON.stringify([legacyTracksProject]),
    });
    const repo = {
      load: vi.fn(async () => [] as NativeProject[]),
      save: vi.fn(async () => {
        throw new Error("native write failed");
      }),
    };

    await expect(runLegacyMigration(repo, storage)).rejects.toThrow("native write failed");
    expect(storage.getItem(MIGRATION_MARKER_KEY)).toBeNull();
    expect(storage.getItem(LEGACY_STORAGE_KEY)).not.toBeNull();
  });

  it("throws and preserves data when the read-back verification fails", async () => {
    const storage = fakeStorage({
      [LEGACY_STORAGE_KEY]: JSON.stringify([legacyTracksProject]),
    });
    const repo = {
      // save succeeds but load returns nothing — a broken store.
      load: vi.fn(async () => [] as NativeProject[]),
      save: vi.fn(async () => {}),
    };

    await expect(runLegacyMigration(repo, storage)).rejects.toThrow(/could not be verified/);
    expect(storage.getItem(MIGRATION_MARKER_KEY)).toBeNull();
    expect(storage.getItem(LEGACY_STORAGE_KEY)).not.toBeNull();
  });
});
