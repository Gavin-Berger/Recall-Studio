import { describe, expect, it } from "vitest";
import { abletonFolderKey, detectTakeMismatch } from "./takeMismatch";
import type { SavedProject, SavedSessionMetadata } from "../../types";

function session(overrides: Partial<SavedSessionMetadata> = {}): SavedSessionMetadata {
  return {
    id: "take-1",
    name: "Take 1",
    project_id: "proj-joe",
    capture_name: null,
    capture_status: "active",
    project_name: "joe",
    project_path: "C:/Music/joe/joe.als",
    als_path: null,
    take_origin: "recorded",
    display_name: null,
    started_at_ms: 0,
    ended_at_ms: null,
    last_updated_at_ms: 0,
    event_count: 0,
    creative_event_count: 0,
    heartbeat_count: 0,
    ...overrides,
  };
}

function project(overrides: Partial<SavedProject> = {}): SavedProject {
  return {
    id: "proj-joe",
    display_name: "joe",
    ableton_name: "joe",
    ableton_path: "C:/Music/joe",
    archived_at_ms: null,
    created_at_ms: 0,
    updated_at_ms: 0,
    last_updated_at_ms: 0,
    capture_count: 1,
    active_capture_count: 1,
    captures: [],
    ...overrides,
  };
}

describe("abletonFolderKey", () => {
  it("reduces an .als file to its folder", () => {
    expect(abletonFolderKey("C:/Music/joe/joe.als")).toBe("c:/music/joe");
  });

  it("treats a folder path and its .als as the same project", () => {
    expect(abletonFolderKey("C:\\Music\\joe\\joe.als")).toBe(abletonFolderKey("C:/Music/joe"));
  });

  it("ignores separator style, case, and trailing slashes", () => {
    expect(abletonFolderKey("C:\\Music\\Joe\\")).toBe("c:/music/joe");
  });

  it("returns null for nothing usable", () => {
    expect(abletonFolderKey(null)).toBeNull();
    expect(abletonFolderKey("   ")).toBeNull();
  });
});

describe("detectTakeMismatch", () => {
  it("is quiet when the take is on the set Ableton has open", () => {
    expect(detectTakeMismatch(session(), [project()])).toBeNull();
  });

  it("is quiet when the same project is reported as folder vs .als file", () => {
    const result = detectTakeMismatch(
      session({ project_path: "C:\\Music\\joe\\joe.als" }),
      [project({ ableton_path: "C:/Music/joe/" })],
    );
    expect(result).toBeNull();
  });

  it("flags a take still filing into the previous song", () => {
    const result = detectTakeMismatch(
      session({ project_name: "idols v9", project_path: "C:/Music/idols v9/idols v9.als" }),
      [project()],
    );
    expect(result).toEqual({ openName: "idols v9", boundName: "joe" });
  });

  it("says nothing when there is no take running", () => {
    expect(detectTakeMismatch(null, [project()])).toBeNull();
  });

  it("says nothing for an unbound take — it binds correctly on its own", () => {
    expect(detectTakeMismatch(session({ project_id: null }), [project()])).toBeNull();
  });

  it("says nothing when the bound project is not in the library", () => {
    expect(detectTakeMismatch(session({ project_id: "gone" }), [project()])).toBeNull();
  });

  it("falls back to Ableton names when paths are missing", () => {
    const result = detectTakeMismatch(
      session({ project_path: null, project_name: "idols v9" }),
      [project({ ableton_path: null, ableton_name: "joe" })],
    );
    expect(result?.openName).toBe("idols v9");
  });

  it("does not cry wolf when a renamed project still matches Ableton", () => {
    // The producer renamed the project; ableton_name is what to compare against.
    const result = detectTakeMismatch(
      session({ project_path: null, project_name: "joe" }),
      [project({ ableton_path: null, ableton_name: "joe", display_name: "Joe (final mix)" })],
    );
    expect(result).toBeNull();
  });

  it("stays silent rather than guessing when there is nothing to compare", () => {
    const result = detectTakeMismatch(
      session({ project_path: null, project_name: null }),
      [project({ ableton_path: null, ableton_name: null })],
    );
    expect(result).toBeNull();
  });
});
