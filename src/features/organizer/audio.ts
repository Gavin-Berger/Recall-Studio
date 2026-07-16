// Audio analysis for the Project Organizer: turn an attached bounce into the two
// things the mix view shows — a waveform envelope and its loudness. Everything
// here runs in the webview via Web Audio (no Rust, no filesystem), so an
// <input type="file"> hands us real bytes and we derive real numbers from them.
//
// Loudness is integrated LUFS per ITU-R BS.1770-4: K-weight each channel, take
// mean square over gated 400ms blocks, combine. The K-weighting biquads are the
// RBJ-cookbook realisations of the standard's high-shelf + high-pass stages, so
// the coefficients track the file's real sample rate rather than assuming 48k.
//
// The math (biquads, loudness, bucketing) is pure and unit-tested. Only
// analyzeAudioFile touches the AudioContext.

export type BiquadCoeffs = {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
};

export type AudioAnalysis = {
  durationSec: number;
  sampleRate: number;
  channelCount: number;
  // Waveform envelope, one amplitude per bucket, normalized so the loudest
  // bucket is 1. Shape only — level lives in the loudness fields below.
  peaks: number[];
  // Integrated loudness in LUFS, or null when the bounce is too short (< 400ms)
  // or too quiet to measure. Null is honest: the UI shows "—", never a fake 0.
  integratedLufs: number | null;
  // Sample peak in dBFS (a true-peak approximation — no oversampling).
  peakDb: number;
};

// --- K-weighting filters (BS.1770 stages 1 & 2), RBJ cookbook realisations ---

// Stage 1: high-shelf "pre-filter". Constants are the standard's.
export function highShelfCoeffs(fs: number): BiquadCoeffs {
  const f0 = 1681.974450955533;
  const G = 3.999843853973347; // dB
  const Q = 0.7071752369554196;

  const A = Math.pow(10, G / 40);
  const w0 = (2 * Math.PI * f0) / fs;
  const cos = Math.cos(w0);
  const sin = Math.sin(w0);
  const alpha = sin / (2 * Q);
  const beta = 2 * Math.sqrt(A) * alpha;

  const b0 = A * (A + 1 + (A - 1) * cos + beta);
  const b1 = -2 * A * (A - 1 + (A + 1) * cos);
  const b2 = A * (A + 1 + (A - 1) * cos - beta);
  const a0 = A + 1 - (A - 1) * cos + beta;
  const a1 = 2 * (A - 1 - (A + 1) * cos);
  const a2 = A + 1 - (A - 1) * cos - beta;

  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

// Stage 2: high-pass (RLB weighting).
export function highPassCoeffs(fs: number): BiquadCoeffs {
  const f0 = 38.13547087602444;
  const Q = 0.5003270373238773;

  const w0 = (2 * Math.PI * f0) / fs;
  const cos = Math.cos(w0);
  const sin = Math.sin(w0);
  const alpha = sin / (2 * Q);

  const b0 = (1 + cos) / 2;
  const b1 = -(1 + cos);
  const b2 = (1 + cos) / 2;
  const a0 = 1 + alpha;
  const a1 = -2 * cos;
  const a2 = 1 - alpha;

  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

// Direct-form-I biquad, applied in place-safe fashion (returns a new array).
export function applyBiquad(input: Float32Array, c: BiquadCoeffs): Float32Array {
  const out = new Float32Array(input.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < input.length; i++) {
    const x0 = input[i];
    const y0 = c.b0 * x0 + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
    out[i] = y0;
    x2 = x1;
    x1 = x0;
    y2 = y1;
    y1 = y0;
  }
  return out;
}

export function kWeight(channel: Float32Array, fs: number): Float32Array {
  return applyBiquad(applyBiquad(channel, highShelfCoeffs(fs)), highPassCoeffs(fs));
}

// --- Integrated loudness (BS.1770 gating) ---

const ABSOLUTE_GATE_LUFS = -70;
const BLOCK_SEC = 0.4;
const STEP_SEC = 0.1;

// Block loudness from per-channel mean-square powers (channel weights all 1 for
// mono/stereo). Returns LUFS.
function blockLoudness(channelPowers: number[]): number {
  const summed = channelPowers.reduce((total, p) => total + p, 0);
  if (summed <= 0) return -Infinity;
  return -0.691 + 10 * Math.log10(summed);
}

export function integratedLoudness(channels: Float32Array[], fs: number): number | null {
  if (channels.length === 0) return null;
  const weighted = channels.map((ch) => kWeight(ch, fs));
  const blockLen = Math.round(BLOCK_SEC * fs);
  const step = Math.round(STEP_SEC * fs);
  const total = weighted[0].length;
  if (total < blockLen) return null;

  // Per-block: mean-square power for each channel, plus the block's loudness.
  const blocks: { loudness: number; powers: number[] }[] = [];
  for (let start = 0; start + blockLen <= total; start += step) {
    const powers = weighted.map((ch) => {
      let sum = 0;
      for (let i = start; i < start + blockLen; i++) sum += ch[i] * ch[i];
      return sum / blockLen;
    });
    blocks.push({ loudness: blockLoudness(powers), powers });
  }

  // Absolute gate at -70 LUFS.
  const absGated = blocks.filter((b) => b.loudness >= ABSOLUTE_GATE_LUFS);
  if (absGated.length === 0) return null;

  // Relative gate at (mean gated loudness - 10 LU).
  const meanPowers = averagePowers(absGated);
  const relThreshold = blockLoudness(meanPowers) - 10;
  const relGated = absGated.filter((b) => b.loudness >= relThreshold);
  const gated = relGated.length > 0 ? relGated : absGated;

  const finalLoudness = blockLoudness(averagePowers(gated));
  return Number.isFinite(finalLoudness) ? finalLoudness : null;
}

function averagePowers(blocks: { powers: number[] }[]): number[] {
  const channelCount = blocks[0].powers.length;
  const sums = new Array<number>(channelCount).fill(0);
  for (const b of blocks) {
    for (let c = 0; c < channelCount; c++) sums[c] += b.powers[c];
  }
  return sums.map((s) => s / blocks.length);
}

// --- Waveform envelope + peak ---

export function mixToMono(channels: Float32Array[]): Float32Array {
  if (channels.length === 1) return channels[0];
  const len = channels[0].length;
  const mono = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    let sum = 0;
    for (const ch of channels) sum += ch[i];
    mono[i] = sum / channels.length;
  }
  return mono;
}

export function samplePeak(channels: Float32Array[]): number {
  let peak = 0;
  for (const ch of channels) {
    for (let i = 0; i < ch.length; i++) {
      const a = Math.abs(ch[i]);
      if (a > peak) peak = a;
    }
  }
  return peak;
}

// Bucket a mono signal into `bucketCount` amplitude values (max-abs per bucket),
// normalized so the loudest bucket is 1. Shape for the eye, not a measurement.
export function bucketPeaks(mono: Float32Array, bucketCount: number): number[] {
  if (mono.length === 0 || bucketCount <= 0) return [];
  const buckets = new Array<number>(bucketCount).fill(0);
  const per = mono.length / bucketCount;
  for (let b = 0; b < bucketCount; b++) {
    const start = Math.floor(b * per);
    const end = Math.min(mono.length, Math.floor((b + 1) * per));
    let max = 0;
    for (let i = start; i < end; i++) {
      const a = Math.abs(mono[i]);
      if (a > max) max = a;
    }
    buckets[b] = max;
  }
  const loudest = buckets.reduce((m, v) => (v > m ? v : m), 0);
  if (loudest <= 0) return buckets;
  return buckets.map((v) => Math.min(1, v / loudest));
}

export function toDb(amplitude: number): number {
  if (amplitude <= 0) return -Infinity;
  return 20 * Math.log10(amplitude);
}

// --- Orchestrator (impure: needs an AudioContext) ---

let sharedCtx: AudioContext | null = null;
function audioContext(): AudioContext {
  if (!sharedCtx) {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) throw new Error("Web Audio is not available in this environment.");
    sharedCtx = new Ctor();
  }
  return sharedCtx;
}

export async function analyzeAudioFile(file: File, bucketCount = 480): Promise<AudioAnalysis> {
  const bytes = await file.arrayBuffer();
  const ctx = audioContext();
  const buffer = await ctx.decodeAudioData(bytes);

  const channels: Float32Array[] = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    channels.push(buffer.getChannelData(c));
  }

  const peakAmp = samplePeak(channels);
  const peaks = bucketPeaks(mixToMono(channels), bucketCount);
  const integratedLufs = integratedLoudness(channels, buffer.sampleRate);
  const peakDb = toDb(peakAmp);

  return {
    durationSec: buffer.duration,
    sampleRate: buffer.sampleRate,
    channelCount: buffer.numberOfChannels,
    peaks,
    integratedLufs,
    peakDb: Number.isFinite(peakDb) ? peakDb : -Infinity,
  };
}
