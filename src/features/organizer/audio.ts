// Audio analysis for the Project Organizer: turn an attached bounce into the
// things the mix view shows — a waveform envelope, its loudness, and its
// dynamic range. Everything here runs in the webview via Web Audio (no Rust, no
// filesystem), so an <input type="file"> hands us real bytes and we derive real
// numbers from them.
//
// Loudness is integrated LUFS and Loudness Range (LRA) per ITU-R BS.1770-4 /
// EBU R128: K-weight each channel, take mean square over gated blocks, combine.
// The K-weighting biquads are the RBJ-cookbook realisations of the standard's
// high-shelf + high-pass stages, so the coefficients track the file's real
// sample rate rather than assuming 48k.
//
// Speed: block powers come from a running per-100ms-segment sum of squares, so
// a 3-minute 192kHz file is a handful of passes, not a sliding window that
// re-reads millions of overlapping samples per step.
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
  // Loudness range (LRA) in LU — the statistical spread of short-term loudness,
  // i.e. dynamic range. Null when the bounce is too short (< ~3s) to measure.
  dynamicRangeLu: number | null;
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

// Direct-form-I biquad, returns a new array.
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

// --- Gated loudness (shared machinery for LUFS and LRA) ---

const ABSOLUTE_GATE_LUFS = -70;
const STEP_SEC = 0.1;
const SEGMENTS_PER_MOMENTARY = 4; // 400ms window for integrated loudness
const SEGMENTS_PER_SHORT_TERM = 30; // 3s window for loudness range
const REL_GATE_INTEGRATED = 10; // LU below the abs-gated mean
const REL_GATE_LRA = 20; // LU below the abs-gated mean

type Block = { loudness: number; powers: number[] };

// Loudness of a block from its per-channel mean-square powers (channel weights
// all 1 for mono/stereo).
function blockLoudness(channelPowers: number[]): number {
  const summed = channelPowers.reduce((total, p) => total + p, 0);
  if (summed <= 0) return -Infinity;
  return -0.691 + 10 * Math.log10(summed);
}

function averagePowers(blocks: Block[]): number[] {
  const channelCount = blocks[0].powers.length;
  const sums = new Array<number>(channelCount).fill(0);
  for (const b of blocks) {
    for (let c = 0; c < channelCount; c++) sums[c] += b.powers[c];
  }
  return sums.map((s) => s / blocks.length);
}

// Sum of squares per 100ms segment for one channel. The final partial segment
// is dropped so every block is full-length.
function segmentSumSquares(channel: Float32Array, segLen: number): Float64Array {
  const segCount = Math.floor(channel.length / segLen);
  const out = new Float64Array(segCount);
  for (let s = 0; s < segCount; s++) {
    let sum = 0;
    const start = s * segLen;
    for (let i = start; i < start + segLen; i++) sum += channel[i] * channel[i];
    out[s] = sum;
  }
  return out;
}

// Overlapping blocks, each `segsPerBlock` segments wide, stepping one segment.
function blocksFromSegments(
  segByChannel: Float64Array[],
  segLen: number,
  segsPerBlock: number,
): Block[] {
  const segCount = segByChannel[0].length;
  const windowSamples = segsPerBlock * segLen;
  const blocks: Block[] = [];
  for (let start = 0; start + segsPerBlock <= segCount; start++) {
    const powers = segByChannel.map((seg) => {
      let sum = 0;
      for (let s = start; s < start + segsPerBlock; s++) sum += seg[s];
      return sum / windowSamples;
    });
    blocks.push({ loudness: blockLoudness(powers), powers });
  }
  return blocks;
}

function kWeightAll(channels: Float32Array[], fs: number): Float64Array[] {
  const segLen = Math.round(STEP_SEC * fs);
  return channels.map((ch) => segmentSumSquares(kWeight(ch, fs), segLen));
}

// Integrated loudness from momentary (400ms) blocks: absolute gate at -70 LUFS,
// then a relative gate 10 LU below the abs-gated mean.
function integratedFromBlocks(blocks: Block[]): number | null {
  const absGated = blocks.filter((b) => b.loudness >= ABSOLUTE_GATE_LUFS);
  if (absGated.length === 0) return null;
  const relThreshold = blockLoudness(averagePowers(absGated)) - REL_GATE_INTEGRATED;
  const relGated = absGated.filter((b) => b.loudness >= relThreshold);
  const gated = relGated.length > 0 ? relGated : absGated;
  const loudness = blockLoudness(averagePowers(gated));
  return Number.isFinite(loudness) ? loudness : null;
}

function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 1) return sortedAsc[0];
  const idx = p * (sortedAsc.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedAsc[lo];
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (idx - lo);
}

// Loudness range from short-term (3s) blocks: absolute gate at -70 LUFS, then a
// relative gate 20 LU below the abs-gated mean, then the 95th minus the 10th
// percentile of the surviving short-term loudness values (EBU Tech 3342).
function lraFromBlocks(blocks: Block[]): number | null {
  const absGated = blocks.filter((b) => b.loudness >= ABSOLUTE_GATE_LUFS);
  if (absGated.length < 2) return null;
  const relThreshold = blockLoudness(averagePowers(absGated)) - REL_GATE_LRA;
  const relGated = absGated.filter((b) => b.loudness >= relThreshold);
  if (relGated.length < 2) return null;
  const sorted = relGated.map((b) => b.loudness).sort((a, b) => a - b);
  return percentile(sorted, 0.95) - percentile(sorted, 0.1);
}

export function integratedLoudness(channels: Float32Array[], fs: number): number | null {
  if (channels.length === 0) return null;
  const segByChannel = kWeightAll(channels, fs);
  const segLen = Math.round(STEP_SEC * fs);
  if (segByChannel[0].length < SEGMENTS_PER_MOMENTARY) return null;
  return integratedFromBlocks(blocksFromSegments(segByChannel, segLen, SEGMENTS_PER_MOMENTARY));
}

export function loudnessRange(channels: Float32Array[], fs: number): number | null {
  if (channels.length === 0) return null;
  const segByChannel = kWeightAll(channels, fs);
  const segLen = Math.round(STEP_SEC * fs);
  if (segByChannel[0].length < SEGMENTS_PER_SHORT_TERM) return null;
  return lraFromBlocks(blocksFromSegments(segByChannel, segLen, SEGMENTS_PER_SHORT_TERM));
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
  const fs = buffer.sampleRate;

  const peakAmp = samplePeak(channels);
  const peaks = bucketPeaks(mixToMono(channels), bucketCount);
  const peakDb = toDb(peakAmp);

  // K-weight once, derive both loudness figures from the same segment powers.
  const segByChannel = kWeightAll(channels, fs);
  const segLen = Math.round(STEP_SEC * fs);
  const segCount = segByChannel[0].length;
  const integratedLufs =
    segCount >= SEGMENTS_PER_MOMENTARY
      ? integratedFromBlocks(blocksFromSegments(segByChannel, segLen, SEGMENTS_PER_MOMENTARY))
      : null;
  const dynamicRangeLu =
    segCount >= SEGMENTS_PER_SHORT_TERM
      ? lraFromBlocks(blocksFromSegments(segByChannel, segLen, SEGMENTS_PER_SHORT_TERM))
      : null;

  return {
    durationSec: buffer.duration,
    sampleRate: fs,
    channelCount: buffer.numberOfChannels,
    peaks,
    integratedLufs,
    dynamicRangeLu,
    peakDb: Number.isFinite(peakDb) ? peakDb : -Infinity,
  };
}
