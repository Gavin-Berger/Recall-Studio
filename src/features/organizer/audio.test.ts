import { describe, expect, it } from "vitest";
import {
  bucketPeaks,
  highPassCoeffs,
  highShelfCoeffs,
  integratedLoudness,
  loudnessRange,
  packWaveformEnvelope,
  samplePeak,
  signalMetrics,
  toDb,
  truePeak,
  unpackWaveformEnvelope,
  wavBitDepth,
  waveformEnvelope,
} from "./audio";

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

  it("measures the BS.1770 1 kHz reference level", () => {
    // A mono 1 kHz sine at -20 dBFS peak measures -23.00 LUFS after the
    // published K-weighting filters (steady-state analytic result: -23.0036).
    expect(integratedLoudness([sine(1000, 0.1, 5)], FS)).toBeCloseTo(-23.0, 1);
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

  it("holds the reference level across common production sample rates", () => {
    for (const fs of [44100, 96000]) {
      expect(integratedLoudness([sine(1000, 0.1, 5, fs)], fs)).toBeCloseTo(-23.0, 1);
    }
  });

  it("applies BS.1770 channel weights to a Web Audio 5.1 layout", () => {
    const silence = () => new Float32Array(FS * 2);
    const front = integratedLoudness([sine(1000, 0.1, 2), silence(), silence(), silence(), silence(), silence()], FS)!;
    const surround = integratedLoudness([silence(), silence(), silence(), silence(), sine(1000, 0.1, 2), silence()], FS)!;
    const lfeOnly = integratedLoudness([silence(), silence(), silence(), sine(1000, 0.5, 2), silence(), silence()], FS);

    expect(surround - front).toBeCloseTo(1.5, 1);
    expect(lfeOnly).toBeNull();
  });
});

describe("K-weighting coefficients", () => {
  it("matches the coefficients published by BS.1770-5 at 48 kHz", () => {
    const shelf = highShelfCoeffs(FS);
    expect(shelf.b0).toBeCloseTo(1.53512485958697, 12);
    expect(shelf.b1).toBeCloseTo(-2.69169618940638, 12);
    expect(shelf.b2).toBeCloseTo(1.19839281085285, 12);
    expect(shelf.a1).toBeCloseTo(-1.69065929318241, 12);
    expect(shelf.a2).toBeCloseTo(0.73248077421585, 12);

    const highPass = highPassCoeffs(FS);
    expect(highPass.b0).toBe(1);
    expect(highPass.b1).toBe(-2);
    expect(highPass.b2).toBe(1);
    expect(highPass.a1).toBeCloseTo(-1.99004745483398, 12);
    expect(highPass.a2).toBeCloseTo(0.99007225036621, 12);
  });
});

// Concatenate segments into one signal.
function concat(...parts: Float32Array[]): Float32Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Float32Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

describe("loudnessRange", () => {
  it("returns null for a bounce shorter than one 3s short-term window", () => {
    expect(loudnessRange([sine(1000, 0.5, 2)], FS)).toBeNull();
  });

  it("reports a small range for a steady tone", () => {
    const lra = loudnessRange([sine(1000, 0.3, 8)], FS);
    expect(lra).not.toBeNull();
    expect(lra!).toBeLessThan(2);
  });

  it("reports a large range for a quiet-then-loud signal", () => {
    // 4s at -26 dBFS into 4s at -6 dBFS: the short-term spread is wide.
    const quietThenLoud = concat(sine(1000, 0.05, 4), sine(1000, 0.5, 4));
    const lra = loudnessRange([quietThenLoud], FS);
    expect(lra).not.toBeNull();
    expect(lra!).toBeGreaterThan(5);
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

describe("waveformEnvelope", () => {
  it("preserves real positive and negative sample excursions", () => {
    const waveform = waveformEnvelope(new Float32Array([-0.75, 0.25, -0.1, 0.9]), 2);
    expect(waveform.min).toEqual([-0.75, -0.1]);
    expect(waveform.max).toEqual([0.25, 0.9]);
  });

  it("does not normalize a quiet waveform to full height", () => {
    const waveform = waveformEnvelope(new Float32Array([-0.1, 0.08]), 1);
    expect(waveform.min[0]).toBe(-0.1);
    expect(waveform.max[0]).toBe(0.08);
  });

  it("round-trips a compact envelope within display-pixel precision", () => {
    const min = [-1, -0.48, -0.03];
    const max = [0.04, 0.51, 1];
    const packed = packWaveformEnvelope(min, max);
    const unpacked = unpackWaveformEnvelope(packed, min.length);
    for (let index = 0; index < min.length; index++) {
      expect(unpacked.min[index]).toBeCloseTo(min[index], 2);
      expect(unpacked.max[index]).toBeCloseTo(max[index], 2);
    }
  });
});

describe("truePeak", () => {
  it("keeps digital silence at zero", () => {
    expect(truePeak([new Float32Array(4096)], 48000)).toBe(0);
  });

  it("recovers the 3 dB quarter-sample-rate under-read described by BS.1770", () => {
    const tone = new Float32Array(FS);
    for (let i = 0; i < tone.length; i++) {
      tone[i] = Math.sin((Math.PI / 2) * i + Math.PI / 4);
    }
    const sp = samplePeak([tone]);
    const tp = truePeak([tone], 48000);
    expect(toDb(sp)).toBeCloseTo(-3.01, 1);
    expect(Math.abs(toDb(tp))).toBeLessThan(0.1);
  });

  it("never reports below the sample peak", () => {
    const tone = sine(1000, 0.4, 1, 48000);
    expect(truePeak([tone], 48000)).toBeGreaterThanOrEqual(samplePeak([tone]) - 1e-6);
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

describe("signalMetrics", () => {
  it("measures clipping, DC offset, silence, and stereo relationships from samples", () => {
    const left = new Float32Array([0, 0, 0.25, 1, 0.25, 0]);
    const right = new Float32Array([0, 0, 0.25, 1, 0.25, 0]);
    const metrics = signalMetrics([left, right], 2);

    expect(metrics.samplePeakAmplitude).toBe(1);
    expect(metrics.clippedSampleCount).toBe(2);
    expect(metrics.leadingSilenceSec).toBe(1);
    expect(metrics.trailingSilenceSec).toBe(0.5);
    expect(metrics.stereoCorrelation).toBeCloseTo(1, 6);
    expect(metrics.stereoBalanceDb).toBeCloseTo(0, 6);
    expect(metrics.dcOffsetDb).toBeCloseTo(toDb(0.25), 5);
  });

  it("leaves stereo-only values unavailable for mono audio", () => {
    const metrics = signalMetrics([new Float32Array([0.2, -0.2])], FS);
    expect(metrics.stereoCorrelation).toBeNull();
    expect(metrics.stereoBalanceDb).toBeNull();
  });

  it("reports negative correlation for opposite-polarity stereo", () => {
    const left = new Float32Array([0.5, -0.25, 0.75]);
    const right = new Float32Array([-0.5, 0.25, -0.75]);
    expect(signalMetrics([left, right], FS).stereoCorrelation).toBeCloseTo(-1, 6);
  });
});

describe("wavBitDepth", () => {
  function pcmWav(bits: number, format = 1): ArrayBuffer {
    const bytes = new ArrayBuffer(44);
    const view = new DataView(bytes);
    const write = (offset: number, value: string) => {
      for (let index = 0; index < value.length; index++) {
        view.setUint8(offset + index, value.charCodeAt(index));
      }
    };
    write(0, "RIFF");
    view.setUint32(4, 36, true);
    write(8, "WAVE");
    write(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, format, true);
    view.setUint16(22, 2, true);
    view.setUint32(24, 48000, true);
    view.setUint16(34, bits, true);
    write(36, "data");
    return bytes;
  }

  it("reads PCM and float WAV container bit depth", () => {
    expect(wavBitDepth(pcmWav(24))).toBe(24);
    expect(wavBitDepth(pcmWav(32, 3))).toBe(32);
  });

  it("does not guess bit depth for non-WAV data", () => {
    expect(wavBitDepth(new ArrayBuffer(64))).toBeNull();
  });
});
