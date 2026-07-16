import { describe, expect, it } from "vitest";
import { bucketPeaks, integratedLoudness, samplePeak, toDb } from "./audio";

const FS = 48000;

// A sine at `freq` Hz, `amp` linear amplitude, `seconds` long.
function sine(freq: number, amp: number, seconds: number, fs = FS): Float32Array {
  const n = Math.round(seconds * fs);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / fs);
  return out;
}

describe("integratedLoudness", () => {
  it("returns null for silence (below the absolute gate)", () => {
    const silence = new Float32Array(FS); // 1s of zeros
    expect(integratedLoudness([silence], FS)).toBeNull();
  });

  it("returns null for a bounce shorter than one 400ms block", () => {
    expect(integratedLoudness([sine(1000, 0.5, 0.2)], FS)).toBeNull();
  });

  it("measures a 1kHz tone in a sane LUFS range", () => {
    // A -20 dBFS (amplitude 0.1) 1kHz tone lands near -23 LUFS after
    // K-weighting; assert a loose but meaningful window, not an exact value.
    const lufs = integratedLoudness([sine(1000, 0.1, 2)], FS);
    expect(lufs).not.toBeNull();
    expect(lufs!).toBeGreaterThan(-30);
    expect(lufs!).toBeLessThan(-16);
  });

  it("reports a louder tone as louder", () => {
    const quiet = integratedLoudness([sine(1000, 0.1, 2)], FS)!;
    const loud = integratedLoudness([sine(1000, 0.5, 2)], FS)!;
    // ~14 dB amplitude difference should move LUFS up by roughly that much.
    expect(loud).toBeGreaterThan(quiet + 10);
  });

  it("treats stereo the same as dual-mono for a centered tone", () => {
    const tone = sine(1000, 0.25, 2);
    const mono = integratedLoudness([tone], FS)!;
    const stereo = integratedLoudness([tone, tone.slice()], FS)!;
    // Summing two equal channels adds ~3 LU over a single channel.
    expect(stereo - mono).toBeGreaterThan(2);
    expect(stereo - mono).toBeLessThan(4);
  });
});

describe("bucketPeaks", () => {
  it("returns the requested number of buckets", () => {
    expect(bucketPeaks(sine(200, 0.8, 1), 64)).toHaveLength(64);
  });

  it("normalizes the loudest bucket to 1", () => {
    const peaks = bucketPeaks(sine(200, 0.3, 1), 32);
    expect(Math.max(...peaks)).toBeCloseTo(1, 5);
  });

  it("returns an empty envelope for an empty signal", () => {
    expect(bucketPeaks(new Float32Array(0), 32)).toEqual([]);
  });
});

describe("samplePeak / toDb", () => {
  it("finds the largest absolute sample across channels", () => {
    const a = new Float32Array([0.1, -0.4, 0.2]);
    const b = new Float32Array([0.3, 0.5, -0.6]);
    expect(samplePeak([a, b])).toBeCloseTo(0.6, 6);
  });

  it("maps full scale to 0 dBFS and half to about -6 dBFS", () => {
    expect(toDb(1)).toBeCloseTo(0, 6);
    expect(toDb(0.5)).toBeCloseTo(-6.02, 1);
  });
});
