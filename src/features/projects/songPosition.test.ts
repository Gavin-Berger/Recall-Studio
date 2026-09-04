import { describe, expect, it } from "vitest";
import {
  barBeatLabel,
  barCountLabel,
  barLabel,
  barOfBeat,
  barRangeLabel,
  beatsPerBar,
  meterOf,
  spanLengthLabel,
} from "./songPosition";

const fourFour = { signatureNumerator: 4, signatureDenominator: 4 };
const threeFour = { signatureNumerator: 3, signatureDenominator: 4 };
const sevenEight = { signatureNumerator: 7, signatureDenominator: 8 };

describe("songPosition · a bar, or nothing", () => {
  it("turns Live's beats into the bar a producer would say", () => {
    // "Song beat 128" is unreadable. In 4/4 it is bar 33.
    expect(barLabel(128, fourFour)).toBe("Bar 33");
  });

  it("starts the song at bar 1, not bar 0", () => {
    expect(barLabel(0, fourFour)).toBe("Bar 1");
    expect(barLabel(3.99, fourFour)).toBe("Bar 1");
    expect(barLabel(4, fourFour)).toBe("Bar 2");
  });

  it("does not silently assume 4/4", () => {
    // The failure this module exists to prevent: dividing by four is wrong the
    // moment a set is not in 4/4, and wrong plausibly, which is worse.
    expect(barLabel(128, threeFour)).toBe("Bar 43");
    expect(barLabel(128, fourFour)).toBe("Bar 33");
  });

  it("counts a compound meter in Live's quarter notes", () => {
    // Live counts beats as quarter notes whatever the denominator says, so a
    // bar of 7/8 is 3.5 of them. Dividing by the numerator alone would make
    // every compound meter wrong.
    expect(beatsPerBar({ numerator: 7, denominator: 8 })).toBe(3.5);
    expect(barLabel(3.5, sevenEight)).toBe("Bar 2");
  });

  it("shows nothing rather than a bar it cannot prove", () => {
    // No beats fallback. A producer cannot read "beat 128", so printing it is
    // not a cautious fallback — it is an unusable label that happens to be true.
    expect(barLabel(128, null)).toBeNull();
    expect(barLabel(128, {})).toBeNull();
    expect(barLabel(null, fourFour)).toBeNull();
  });

  it("refuses half a meter", () => {
    // A defaulted denominator is the 4/4 assumption coming back in.
    expect(meterOf({ signatureNumerator: 7 })).toBeNull();
    expect(meterOf({ signatureDenominator: 8 })).toBeNull();
    expect(meterOf({ signatureNumerator: 0, signatureDenominator: 4 })).toBeNull();
  });

  it("shows nothing for a set that changed meter", () => {
    // One meter cannot convert a song that changed meter, and a bar four out
    // is worse than no bar at all.
    expect(barLabel(128, { ...fourFour, meterChanged: true })).toBeNull();
  });

  it("rejects a negative beat rather than inventing bar 0", () => {
    expect(barOfBeat(-1, { numerator: 4, denominator: 4 })).toBeNull();
  });
});

describe("songPosition · ranges", () => {
  it("reports the bars a clip actually occupies", () => {
    // A clip running beats 0 to 16 in 4/4 sits in bars 1 to 4. Taking beat 16
    // literally would claim bar 5 — a bar the clip never touches.
    expect(barRangeLabel(0, 16, fourFour)).toBe("Bar 1–4");
  });

  it("collapses a span that lives inside one bar", () => {
    // "Bar 33–33" reads like a mistake.
    expect(barRangeLabel(128, 130, fourFour)).toBe("Bar 33");
  });

  it("states a single bar when there is no end", () => {
    expect(barRangeLabel(128, null, fourFour)).toBe("Bar 33");
  });

  it("shows nothing without a meter", () => {
    expect(barRangeLabel(0, 16, {})).toBeNull();
  });
});

describe("songPosition · lengths", () => {
  it("says bars when a span lands on the bar line", () => {
    expect(spanLengthLabel(0, 16, fourFour)).toBe("4 bars");
    expect(spanLengthLabel(0, 4, fourFour)).toBe("1 bar");
  });

  it("keeps the remainder when it does not", () => {
    expect(spanLengthLabel(0, 18, fourFour)).toBe("4 bars 2 beats");
  });

  it("falls back to beats for anything under a bar", () => {
    expect(spanLengthLabel(0, 2, fourFour)).toBe("2 beats");
    expect(spanLengthLabel(0, 1, fourFour)).toBe("1 beat");
  });

  it("measures a compound meter's bars correctly", () => {
    // 7/8 is 3.5 quarter notes per bar, so 7 beats is two bars.
    expect(spanLengthLabel(0, 7, sevenEight)).toBe("2 bars");
  });

  it("shows nothing for an empty or backwards span", () => {
    expect(spanLengthLabel(16, 16, fourFour)).toBeNull();
    expect(spanLengthLabel(16, 8, fourFour)).toBeNull();
  });
});

describe("songPosition · Ableton's bar.beat ruler", () => {
  it("counts the way Live's ruler does", () => {
    // Live writes 1.1 · 1.2 · 1.3 · 1.4 · 2.1. Recall numbered the same ruler
    // 1 2 3 4 5 6 7 8, so a note at 1.3 was labelled "beat 3".
    expect(barBeatLabel(0, fourFour)).toBe("1.1");
    expect(barBeatLabel(1, fourFour)).toBe("1.2");
    expect(barBeatLabel(2, fourFour)).toBe("1.3");
    expect(barBeatLabel(3, fourFour)).toBe("1.4");
    expect(barBeatLabel(4, fourFour)).toBe("2.1");
    expect(barBeatLabel(7, fourFour)).toBe("2.4");
  });

  it("counts within the bar in the meter's own denominator", () => {
    // 7/8 counts to 7, not to 3.5 quarter-notes.
    expect(barBeatLabel(0, sevenEight)).toBe("1.1");
    expect(barBeatLabel(0.5, sevenEight)).toBe("1.2");
    expect(barBeatLabel(3.5, sevenEight)).toBe("2.1");
  });

  it("counts a three-four bar to three", () => {
    expect(barBeatLabel(2, threeFour)).toBe("1.3");
    expect(barBeatLabel(3, threeFour)).toBe("2.1");
  });

  it("shows nothing without a meter rather than assuming 4/4", () => {
    expect(barBeatLabel(2, {})).toBeNull();
    expect(barBeatLabel(2, { ...fourFour, meterChanged: true })).toBeNull();
  });

  it("captions a roll in bars instead of quarter-notes", () => {
    expect(barCountLabel(8, fourFour)).toBe("2 bars");
    expect(barCountLabel(4, fourFour)).toBe("1 bar");
    expect(barCountLabel(6, fourFour)).toBe("1.5 bars");
    expect(barCountLabel(8, {})).toBeNull();
  });
});
