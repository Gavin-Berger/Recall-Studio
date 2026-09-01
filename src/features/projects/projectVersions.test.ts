import { describe, expect, it } from "vitest";
import type { SavedSessionMetadata } from "../../types/recall";
import {
  normalizeAlsPath,
  projectVersions,
  versionForSession,
  versionSessionsToRead,
  versionSittingCount,
} from "./projectVersions";

const day = 24 * 60 * 60 * 1000;
const start = 1_720_000_000_000;

function capture(over: Partial<SavedSessionMetadata> = {}): SavedSessionMetadata {
  return {
    id: "session-1",
    name: "capture",
    project_id: "project-1",
    capture_name: null,
    capture_status: "ended",
    project_name: "pers ep nightfall",
    project_path: "C:\\Music\\nightfall",
    als_path: "C:\\Music\\nightfall\\pers ep nightfall v4.als",
    take_origin: "recorded",
    display_name: "pers ep nightfall v4",
    started_at_ms: start,
    ended_at_ms: start + 60_000,
    last_updated_at_ms: start + 60_000,
    event_count: 10,
    creative_event_count: 8,
    heartbeat_count: 0,
    ...over,
  };
}

// The exact list from the screenshot that prompted this: one .als, five rows,
// two of them empty, work split three ways.
function nightfallCaptures(): SavedSessionMetadata[] {
  const v4 = "C:\\Music\\nightfall\\pers ep nightfall v4.als";
  return [
    capture({ id: "empty-a", als_path: v4, started_at_ms: start, event_count: 0, creative_event_count: 0 }),
    capture({ id: "empty-b", als_path: v4, started_at_ms: start + 1_000, event_count: 0, creative_event_count: 0 }),
    capture({ id: "small", als_path: v4, started_at_ms: start + 3 * 60_000, event_count: 11, creative_event_count: 11 }),
    capture({ id: "medium", als_path: v4, started_at_ms: start + 11 * 60_000, event_count: 23, creative_event_count: 23 }),
    capture({
      id: "large",
      als_path: v4,
      started_at_ms: start + day,
      last_updated_at_ms: start + day + 60_000,
      event_count: 178,
      creative_event_count: 178,
    }),
    // A genuine Save As: different file, so a different version.
    capture({
      id: "earlier-file",
      als_path: "C:\\Music\\nightfall\\pers ep nightfall.als",
      display_name: "pers ep nightfall",
      started_at_ms: start - day,
      event_count: 71,
      creative_event_count: 71,
    }),
  ];
}

describe("normalizeAlsPath", () => {
  it("matches the same file across separator and case differences", () => {
    // Paths reach us from Live, from a disk scan, and from a relink, and the
    // three do not agree on separators or case.
    expect(normalizeAlsPath("C:\\Music\\Nightfall\\V4.als"))
      .toBe(normalizeAlsPath("c:/music/nightfall/v4.als"));
  });

  it("treats Live's absent-text sentinel as no path", () => {
    expect(normalizeAlsPath("0")).toBeNull();
    expect(normalizeAlsPath("   ")).toBeNull();
    expect(normalizeAlsPath(null)).toBeNull();
  });
});

describe("projectVersions", () => {
  it("collapses every capture of one .als into a single version", () => {
    const versions = projectVersions(nightfallCaptures());

    // Six capture rows, two versions: v4 and the file it was saved from.
    expect(versions).toHaveLength(2);
    const v4 = versions.find((version) => version.name === "pers ep nightfall v4")!;
    expect(v4.sessions).toHaveLength(5);
    expect(v4.creativeEventCount).toBe(212);
  });

  it("keeps a genuine Save As as its own version", () => {
    const versions = projectVersions(nightfallCaptures());

    expect(versions.map((version) => version.name)).toEqual([
      "pers ep nightfall",
      "pers ep nightfall v4",
    ]);
  });

  it("orders versions by when work on them began", () => {
    const versions = projectVersions(nightfallCaptures());
    expect(versions[0]!.startedAtMs).toBeLessThan(versions[1]!.startedAtMs);
  });

  it("counts producer sittings, not Recall's non-empty captures", () => {
    const v4 = projectVersions(nightfallCaptures()).find((version) => version.name.endsWith("v4"))!;

    // Five captures: two empty checkpoints, two pieces Recall split only eight
    // minutes apart, and one return the next day. That is two sittings—not the
    // three non-empty capture rows the old implementation printed.
    expect(v4.sessions).toHaveLength(5);
    expect(versionSittingCount(v4)).toBe(2);
  });

  it("reports the version live while any sitting is still open", () => {
    const versions = projectVersions([
      capture({ id: "closed", ended_at_ms: start + 60_000 }),
      capture({ id: "open", started_at_ms: start + 120_000, ended_at_ms: null }),
    ]);

    expect(versions[0]!.live).toBe(true);
  });

  it("never merges captures that have no file to anchor to", () => {
    // An unsaved set has nothing stable to key on, so two of them are two
    // versions — guessing they are the same would silently fuse two songs.
    const versions = projectVersions([
      capture({ id: "unsaved-a", als_path: null, display_name: "Untitled" }),
      capture({ id: "unsaved-b", als_path: null, display_name: "Untitled" }),
    ]);

    expect(versions).toHaveLength(2);
  });
});

describe("versionSessionsToRead", () => {
  it("skips empty checkpoints so the report does not pay to load nothing", () => {
    const v4 = projectVersions(nightfallCaptures()).find((version) => version.name.endsWith("v4"))!;

    expect(versionSessionsToRead(v4).map((session) => session.id)).toEqual([
      "small",
      "medium",
      "large",
    ]);
  });

  it("falls back to the first capture when a version recorded nothing at all", () => {
    // The report still has to render and say plainly that nothing was captured,
    // rather than failing to load.
    const versions = projectVersions([
      capture({ id: "empty-only", event_count: 0, creative_event_count: 0 }),
    ]);

    expect(versionSessionsToRead(versions[0]!).map((session) => session.id)).toEqual(["empty-only"]);
  });
});

describe("versionForSession", () => {
  it("finds the version any of its captures belongs to", () => {
    const versions = projectVersions(nightfallCaptures());

    // Selecting the empty 7:06 PM checkpoint must land on v4, not on nothing.
    expect(versionForSession(versions, "empty-b")?.name).toBe("pers ep nightfall v4");
    expect(versionForSession(versions, "large")?.name).toBe("pers ep nightfall v4");
    expect(versionForSession(versions, "earlier-file")?.name).toBe("pers ep nightfall");
  });

  it("returns nothing for an unknown or absent capture", () => {
    const versions = projectVersions(nightfallCaptures());
    expect(versionForSession(versions, null)).toBeNull();
    expect(versionForSession(versions, "does-not-exist")).toBeNull();
  });
});
