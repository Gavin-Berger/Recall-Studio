import { describe, expect, it } from "vitest";
import { alsSetName, preferredProjectReportSession, preferredProjectTitle } from "./sessionFormat";

describe("alsSetName", () => {
  it("takes the filename from a path and drops the .als extension", () => {
    expect(alsSetName("C:\\Users\\g\\Music\\believeme_140_Am.als")).toBe("believeme_140_Am");
    expect(alsSetName("/home/g/music/first kiss.als")).toBe("first kiss");
  });

  it("handles a bare filename and is case-insensitive on the extension", () => {
    expect(alsSetName("track.ALS")).toBe("track");
  });

  it("returns null for missing paths and the '0' unsaved sentinel", () => {
    expect(alsSetName(null)).toBeNull();
    expect(alsSetName(undefined)).toBeNull();
    expect(alsSetName("")).toBeNull();
    expect(alsSetName("0.als")).toBeNull();
  });
});

describe("preferredProjectTitle", () => {
  it("prefers the saved Ableton filename over Recall's shorter desk label", () => {
    expect(preferredProjectTitle(
      {
        als_path: "C:\\Music\\Recall_Test\\Recall_Test.als",
        project_path: "C:\\Music\\Recall_Test\\Recall_Test.als",
        project_name: "Recall",
        display_name: "Recall",
      },
      {
        display_name: "Recall",
        ableton_name: "Recall",
        ableton_path: null,
      },
    )).toBe("Recall_Test");
  });

  it("falls back to the editable project label for an unsaved set", () => {
    expect(preferredProjectTitle(
      {
        als_path: null,
        project_path: null,
        project_name: null,
        display_name: null,
      },
      {
        display_name: "New idea",
        ableton_name: null,
        ableton_path: null,
      },
    )).toBe("New idea");
  });
});

describe("preferredProjectReportSession", () => {
  it("reopens recorded work rather than a newer empty checkpoint", () => {
    const report = preferredProjectReportSession([
      {
        id: "empty-newer",
        name: "empty-newer",
        project_id: "project-1",
        capture_name: null,
        capture_status: "complete",
        project_name: "Nightfall",
        project_path: null,
        als_path: "C:\\Music\\Nightfall.als",
        take_origin: "recorded",
        display_name: null,
        started_at_ms: 300,
        ended_at_ms: 400,
        last_updated_at_ms: 400,
        event_count: 0,
        creative_event_count: 0,
        heartbeat_count: 0,
      },
      {
        id: "recorded-earlier",
        name: "recorded-earlier",
        project_id: "project-1",
        capture_name: null,
        capture_status: "complete",
        project_name: "Nightfall",
        project_path: null,
        als_path: "C:\\Music\\Nightfall.als",
        take_origin: "recorded",
        display_name: null,
        started_at_ms: 100,
        ended_at_ms: 200,
        last_updated_at_ms: 200,
        event_count: 48,
        creative_event_count: 14,
        heartbeat_count: 0,
      },
    ]);

    expect(report?.id).toBe("recorded-earlier");
  });
});
