import { describe, it, expect } from "vitest";
import { canonicalEventType, EVENT_TYPE_MAP } from "./eventTypeMap";

// These tests are the guardrail against vocabulary drift between the bridge, the
// Rust event catalog, and the frontend. When the catalog gains a creative event,
// it must map to a real category here — never fall through to "unknown".
describe("event-type vocabulary", () => {
  it("maps every always-show creative action to a non-unknown category", () => {
    // Mirrors the "always show" list in the loop spec / product goal.
    const creative = [
      "sample_added",
      "audio_clip_added",
      "midi_clip_created",
      "device_added",
      "device_removed",
      "device_chain_changed",
      "automation_created",
      "automation_edited",
      "track_created",
      "track_name_changed",
      "track_deleted",
      "track_muted",
      "track_soloed",
      "track_armed",
      // Newly synced from the Rust catalog — these used to fall through:
      "track_duplicated",
      "track_frozen",
      "track_flattened",
      "device_toggled",
      "scene_created",
    ];

    for (const eventType of creative) {
      expect(
        canonicalEventType(eventType),
        `${eventType} should map to a known category, not "unknown"`,
      ).not.toBe("unknown");
    }
  });

  it("routes track lifecycle to the track category", () => {
    for (const eventType of [
      "track_frozen",
      "track_flattened",
      "track_duplicated",
    ]) {
      expect(canonicalEventType(eventType)).toBe("track");
    }
  });

  it("routes transport_snapshot to transport so it is hidden explicitly", () => {
    // Previously unmapped → resolved to "transport" only via a legacy heuristic.
    // Mapping it explicitly makes the hide deterministic.
    expect(canonicalEventType("transport_snapshot")).toBe("transport");
  });

  it("keeps samples and clips under the clip category", () => {
    expect(canonicalEventType("sample_added")).toBe("clip");
    expect(canonicalEventType("audio_clip_added")).toBe("clip");
    expect(canonicalEventType("midi_clip_created")).toBe("clip");
  });

  it("treats unknown strings as unknown, case-insensitively for known ones", () => {
    expect(canonicalEventType("totally_made_up")).toBe("unknown");
    expect(canonicalEventType(undefined)).toBe("unknown");
    expect(canonicalEventType("TRACK_CREATED")).toBe("track");
  });

  it("never maps anything to an empty/whitespace category", () => {
    for (const value of Object.values(EVENT_TYPE_MAP)) {
      expect(value.trim().length).toBeGreaterThan(0);
    }
  });
});
