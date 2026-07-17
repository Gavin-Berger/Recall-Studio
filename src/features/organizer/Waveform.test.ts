import { describe, expect, it } from "vitest";
import { waveformSeekFraction, waveformZoomWindow } from "./Waveform";

describe("waveform detail zoom", () => {
  it("shows exactly one one-thousand-twenty-fourth of the track at maximum zoom", () => {
    const window = waveformZoomWindow(0.5, 1024);
    expect(window.visibleFraction).toBe(1 / 1024);
    expect(window.start).toBeCloseTo(0.5 - 1 / 2048);
  });

  it("keeps the detail window inside the beginning and end of the track", () => {
    expect(waveformZoomWindow(0, 1024).start).toBe(0);
    expect(waveformZoomWindow(1, 1024).start).toBe(1023 / 1024);
  });

  it("maps a click in a zoomed view back to the full-track position", () => {
    const window = waveformZoomWindow(0.5, 8);
    expect(waveformSeekFraction(0.5, window.start, window.visibleFraction)).toBeCloseTo(0.5);
  });
});
