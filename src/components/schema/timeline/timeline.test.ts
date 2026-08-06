import { describe, expect, it } from "vitest";
import type { CreativeMoment, ParameterChange } from "../../../types";
import {
  activeDurationMs,
  buildLookups,
  buildShareData,
  buildShareDocument,
  buildTicks,
  cumulativeMovePaths,
  describeActivity,
  describeNoteEdit,
  clipLabel,
  formatDuration,
  formatElapsed,
  formatWhen,
  formatClock,
  LONG_TAKE_MS,
  formatMoveValue,
  formatPercent,
  formatTakeTitle,
  noteTrackId,
  pct,
  trackColor,
  type Activity,
  type SessionBlock,
} from "./index";

function makeChange(overrides: Partial<ParameterChange> = {}): ParameterChange {
  return {
    id: "pc1",
    parameter_id: null,
    track_name: "Bass",
    track_id: null,
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

describe("activeDurationMs", () => {
  const MIN = 60_000;

  it("returns 0 with no activity — an idle take accrues nothing", () => {
    expect(activeDurationMs([])).toBe(0);
    expect(activeDurationMs([], Date.now())).toBe(0);
  });

  it("counts one burst as its span plus the pad", () => {
    // Moves at 0, 2, 5 minutes → 5 min span + 1 min pad.
    expect(activeDurationMs([0 * MIN, 2 * MIN, 5 * MIN].map((t) => t + MIN))).toBe(6 * MIN);
  });

  it("splits on idle gaps instead of counting them", () => {
    // Two bursts an hour apart: 3 min + pad and 0 min + pad — never 63 min.
    const stamps = [MIN, 2 * MIN, 4 * MIN, 64 * MIN];
    expect(activeDurationMs(stamps)).toBe(3 * MIN + MIN + MIN);
  });

  it("extends the live block to now only when recently active", () => {
    const last = 10 * MIN;
    const recentNow = last + 5 * MIN;
    const staleNow = last + 60 * MIN;
    // Recently active: block runs to "now". Idle: now is ignored.
    expect(activeDurationMs([MIN, last], recentNow)).toBe(14 * MIN + MIN);
    expect(activeDurationMs([MIN, last], staleNow)).toBe(9 * MIN + MIN);
  });

  it("counts an isolated move as the pad, not zero and not the wall clock", () => {
    expect(activeDurationMs([5 * MIN])).toBe(MIN);
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
  it("returns the neutral lane color for every track (DESIGN v2 monochrome)", () => {
    expect(trackColor({ color: "#ff0000", type: "midi" } as never)).toBe("#868d9c");
    expect(trackColor({ color: null, type: "audio" } as never)).toBe("#868d9c");
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
    blocks: [] as SessionBlock[],
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

describe("describeNoteEdit", () => {
  const edit = (overrides: Partial<Activity> = {}): Activity => ({
    id: "ne1",
    kind: "noteEdit",
    trackId: "t1",
    atMs: 1_000,
    clipName: "Verse",
    changeKind: "notes_added",
    noteCount: 16,
    previousNoteCount: 12,
    pitchRange: "C1-G2",
    previousPitchRange: "C1-G1",
    summary: null,
    ...overrides,
  });

  it("prefers the bridge's own summary", () => {
    // Written where Live's note naming was in hand — nothing here improves on it.
    expect(describeNoteEdit(edit({ summary: "16 notes (+4), C1-G1 -> C1-G2" }))).toBe(
      "16 notes (+4), C1-G1 -> C1-G2",
    );
  });

  it("reassembles a line when an older payload carried no summary", () => {
    expect(describeNoteEdit(edit())).toBe("16 notes (+4), C1-G1 → C1-G2");
  });

  it("shows a single range when the part did not change shape", () => {
    expect(describeNoteEdit(edit({ previousPitchRange: "C1-G2" }))).toBe("16 notes (+4), C1-G2");
  });

  it("signs a removal", () => {
    expect(
      describeNoteEdit(edit({ noteCount: 8, previousNoteCount: 12, previousPitchRange: "C1-G2" })),
    ).toBe("8 notes (-4), C1-G2");
  });

  it("omits the delta when the count held steady", () => {
    // Transposing or re-timing a part changes it without changing how many
    // notes it has; "(+0)" would be noise.
    expect(
      describeNoteEdit(edit({ noteCount: 12, previousNoteCount: 12, previousPitchRange: "C1-G2" })),
    ).toBe("12 notes, C1-G2");
  });

  it("names a cleared clip by what it used to hold", () => {
    expect(describeNoteEdit(edit({ changeKind: "cleared", noteCount: 0 }))).toBe("Cleared 12 notes");
  });

  it("says '1 note', never '1 notes'", () => {
    expect(describeNoteEdit(edit({ noteCount: 1, previousNoteCount: 2, previousPitchRange: "C1-G2" }))).toBe(
      "1 note (-1), C1-G2",
    );
    expect(describeNoteEdit(edit({ changeKind: "cleared", noteCount: 0, previousNoteCount: 1 }))).toBe(
      "Cleared 1 note",
    );
  });

  it("names an unnamed clip rather than leaving a hole", () => {
    // Live reports no name as "" — and as a literal "0" for absent text props.
    expect(clipLabel(null)).toBe("Untitled clip");
    expect(clipLabel("")).toBe("Untitled clip");
    expect(clipLabel("   ")).toBe("Untitled clip");
    expect(clipLabel("0")).toBe("Untitled clip");
    expect(clipLabel("Verse")).toBe("Verse");
  });

  it("describes an activity as clip plus change", () => {
    expect(describeActivity(edit({ summary: "16 notes (+4)" }))).toBe("Verse: 16 notes (+4)");
  });
});

describe("formatWhen", () => {
  const start = new Date("2026-07-21T21:36:00").getTime();

  it("uses elapsed for a normal take", () => {
    expect(formatWhen(start + 65_000, start, 90 * 60_000)).toBe("1:05");
  });

  it("switches to the clock once a take outgrows elapsed", () => {
    // 39 hours in, "39:24:22" is a number you decode; the clock is a memory.
    const span = 39 * 60 * 60 * 1000;
    const when = formatWhen(start + span, start, span);
    expect(when).toBe(formatClock(start + span));
    expect(when).not.toContain("39:");
  });

  it("holds elapsed right up to the threshold, and flips just past it", () => {
    const at = start + 1000;
    expect(formatWhen(at, start, LONG_TAKE_MS)).toBe("0:01");
    expect(formatWhen(at, start, LONG_TAKE_MS + 1)).toBe(formatClock(at));
  });

  it("gives the axis and the rows the same clock", () => {
    // One source of truth, so a tick and a row can never disagree.
    const span = 39 * 60 * 60 * 1000;
    const bounds = { start, span, sessionStart: start };
    const ticks = buildTicks(bounds);
    expect(ticks[0].label).toBe(formatWhen(start, start, span));
    expect(ticks[4].label).toBe(formatWhen(start + span, start, span));
  });
});
