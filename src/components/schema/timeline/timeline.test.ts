import { describe, expect, it } from "vitest";
import type { CreativeMoment, ParameterChange } from "../../../types";
import {
  buildLookups,
  buildShareData,
  buildShareDocument,
  buildTicks,
  cumulativeMovePaths,
  formatDuration,
  formatElapsed,
  formatMoveValue,
  formatPercent,
  formatTakeTitle,
  noteTrackId,
  pct,
  trackColor,
  type Highlight,
} from "./index";

function makeChange(overrides: Partial<ParameterChange> = {}): ParameterChange {
  return {
    id: "pc1",
    parameter_id: null,
    track_name: "Bass",
    device_name: "Operator",
    parameter_name: "Filter Freq",
    before_value: 100,
    after_value: 440,
    before_value_percent: 10,
    after_value_percent: 80,
    unit: "Hz",
    before_display_value: null,
    after_display_value: null,
    is_quantized: false,
    reason: null,
    changed_at_ms: 5_000,
    ...overrides,
  };
}

describe("formatElapsed", () => {
  it("renders minutes:seconds", () => {
    expect(formatElapsed(0)).toBe("0:00");
    expect(formatElapsed(65_000)).toBe("1:05");
  });

  it("promotes to h:mm:ss past an hour", () => {
    expect(formatElapsed(3_661_000)).toBe("1:01:01");
  });
});

describe("formatDuration", () => {
  it("scales seconds → minutes → hours", () => {
    expect(formatDuration(30_000)).toBe("30 sec");
    expect(formatDuration(90_000)).toBe("1 min");
    expect(formatDuration(3_600_000)).toBe("1 hr");
    expect(formatDuration(4_500_000)).toBe("1 hr 15 min");
  });
});

describe("formatPercent", () => {
  it("rounds to one decimal and drops trailing zeros", () => {
    expect(formatPercent(50)).toBe("50%");
    expect(formatPercent(33.33)).toBe("33.3%");
    expect(formatPercent(null)).toBe("—");
  });
});

describe("formatMoveValue", () => {
  it("prefers the Live display string when present", () => {
    expect(formatMoveValue(null, null, null, "Sinefold")).toBe("Sinefold");
  });

  it("falls back to percent, then value+unit", () => {
    expect(formatMoveValue(null, 50, null, null)).toBe("50%");
    expect(formatMoveValue(440, null, "Hz", null)).toBe("440 Hz");
  });

  it("ignores an empty display string", () => {
    expect(formatMoveValue(5, null, null, "")).toBe("5");
  });
});

describe("formatTakeTitle", () => {
  it("passes through a real name", () => {
    expect(formatTakeTitle({ name: "Late Night Jam" } as never, null)).toBe("Late Night Jam");
  });

  it("falls back to the schema name for auto-generated names with no start time", () => {
    expect(formatTakeTitle({ name: "session-5" } as never, "My Set")).toBe("My Set");
  });
});

describe("trackColor", () => {
  it("uses the track's own hex when valid", () => {
    expect(trackColor({ color: "#ff0000", type: "midi" } as never)).toBe("#ff0000");
  });

  it("falls back per track type when color is missing/invalid", () => {
    expect(trackColor({ color: null, type: "audio" } as never)).toBe("#aaccf0");
  });
});

describe("pct", () => {
  it("projects a timestamp into 0–100 and clamps", () => {
    expect(pct(50, { start: 0, span: 100 })).toBe(50);
    expect(pct(200, { start: 0, span: 100 })).toBe(100);
    expect(pct(-50, { start: 0, span: 100 })).toBe(0);
  });

  it("returns the midpoint for a degenerate span", () => {
    expect(pct(10, { start: 0, span: 0 })).toBe(50);
  });
});

describe("cumulativeMovePaths", () => {
  it("returns null when there's nothing to draw", () => {
    expect(cumulativeMovePaths([], { start: 0, span: 100 }, 0, 100)).toBeNull();
  });

  it("builds a step line and a closed area", () => {
    const paths = cumulativeMovePaths([25, 50], { start: 0, span: 100 }, 2, 100);
    expect(paths).not.toBeNull();
    expect(paths?.line.startsWith("M 0")).toBe(true);
    expect(paths?.area.endsWith("Z")).toBe(true);
  });
});

describe("buildTicks", () => {
  it("returns five evenly spaced ticks", () => {
    const ticks = buildTicks({ start: 0, span: 100_000, sessionStart: 0 });
    expect(ticks.map((t) => t.pct)).toEqual([0, 25, 50, 75, 100]);
  });
});

describe("noteTrackId", () => {
  it("resolves a track target directly", () => {
    const moment = { targets: [{ target_type: "track", target_id: "t1" }] } as CreativeMoment;
    expect(noteTrackId(moment, buildLookups(null))).toBe("t1");
  });

  it("returns null when no target resolves", () => {
    const moment = { targets: [] } as unknown as CreativeMoment;
    expect(noteTrackId(moment, buildLookups(null))).toBeNull();
  });
});

describe("buildShareData / buildShareDocument", () => {
  const data = buildShareData({
    title: "Take",
    project: null,
    duration: "1 min",
    recordedAtMs: 0,
    changes: [makeChange()],
    stats: { moves: 1, characterMoves: 0, tracksTouched: 1, keepers: 0 },
    story: ["A take."],
    highlights: [] as Highlight[],
    sessionStart: 1_000,
  });

  it("groups changes by track and computes elapsed from session start", () => {
    expect(data.title).toBe("Take");
    expect(data.story).toBe("A take.");
    expect(data.tracks).toHaveLength(1);
    expect(data.tracks[0].name).toBe("Bass");
    expect(data.tracks[0].changes[0].elapsedMs).toBe(4_000); // 5000 - 1000
  });

  it("renders every format from one snapshot", () => {
    expect(JSON.parse(buildShareDocument(data, "json")).title).toBe("Take");
    expect(buildShareDocument(data, "md")).toContain("# Take");
    expect(buildShareDocument(data, "txt")).toContain("Take");
  });
});
