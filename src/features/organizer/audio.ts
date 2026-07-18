// Audio analysis for the Project Organizer: turn an attached bounce into the
// things the mix view shows — a waveform envelope, its loudness, and its
// dynamic range. Everything here runs in the webview via Web Audio (no Rust, no
// filesystem), so an <input type="file"> hands us real bytes and we derive real
// numbers from them.
//
// Loudness is integrated LUFS and Loudness Range (LRA) per ITU-R BS.1770-5 /
// EBU R128: K-weight each channel, take mean square over gated blocks, combine.
// The K-weighting biquads use the De Man parameterisation of the standard's
// high-shelf + high-pass stages. At 48 kHz they reproduce the published
// BS.1770-5 coefficients; at other rates they preserve that response.
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
  // High-resolution, full-scale waveform envelope. Each pair is the actual
  // minimum and maximum sample excursion in that time slice, not a normalized
  // magnitude block, so zooming preserves the waveform's real contour.
  waveformChannels: string[];
  waveformPoints: number;
  // Integrated loudness in LUFS, or null when the bounce is too short (< 400ms)
  // or too quiet to measure. Null is honest: the UI shows "—", never a fake 0.
  integratedLufs: number | null;
  // Loudness range (LRA) in LU — the statistical spread of short-term loudness,
  // i.e. dynamic range. Null when the bounce is too short (< ~3s) to measure.
  dynamicRangeLu: number | null;
  maxMomentaryLufs: number | null;
  maxMomentaryTimeSec: number | null;
  maxShortTermLufs: number | null;
  maxShortTermTimeSec: number | null;
  // True peak in dBTP (BS.1770-5): oversampled so inter-sample peaks above 0
  // dBFS are caught, not just the loudest stored sample.
  truePeakDb: number;
  samplePeakDb: number;
  clippedSampleCount: number;
  dcOffsetDb: number | null;
  stereoCorrelation: number | null;
  stereoBalanceDb: number | null;
  bitDepth: number | null;
  leadingSilenceSec: number;
  trailingSilenceSec: number;
};

// --- K-weighting filters (BS.1770 stages 1 & 2) ---

// Stage 1: high-shelf "pre-filter". Constants are the standard's.
export function highShelfCoeffs(fs: number): BiquadCoeffs {
  const f0 = 1681.974450955533;
  const G = 3.999843853973347; // dB
  const Q = 0.7071752369554196;

  const K = Math.tan((Math.PI * f0) / fs);
  const Vh = Math.pow(10, G / 20);
  const Vb = Math.pow(Vh, 0.4996667741545416);
  const a0 = 1 + K / Q + K * K;

  return {
    b0: (Vh + (Vb * K) / Q + K * K) / a0,
    b1: (2 * (K * K - Vh)) / a0,
    b2: (Vh - (Vb * K) / Q + K * K) / a0,
    a1: (2 * (K * K - 1)) / a0,
    a2: (1 - K / Q + K * K) / a0,
  };
}

// Stage 2: high-pass (RLB weighting).
export function highPassCoeffs(fs: number): BiquadCoeffs {
  const f0 = 38.13547087602444;
  const Q = 0.5003270373238773;

  const K = Math.tan((Math.PI * f0) / fs);
  const a0 = 1 + K / Q + K * K;

  // BS.1770 deliberately leaves the numerator unnormalised. At 48 kHz this
  // gives b=[1,-2,1], a=[1,-1.9900474548,0.9900722504] exactly.
  return {
    b0: 1,
    b1: -2,
    b2: 1,
    a1: (2 * (K * K - 1)) / a0,
    a2: (1 - K / Q + K * K) / a0,
  };
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

type Block = { loudness: number; powers: number[]; startSec: number };

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
    blocks.push({ loudness: blockLoudness(powers), powers, startSec: start * STEP_SEC });
  }
  return blocks;
}

function kWeightAll(channels: Float32Array[], fs: number): Float64Array[] {
  const segLen = Math.round(STEP_SEC * fs);
  const channelWeights = channels.length === 4
    ? [1, 1, 1.41, 1.41]
    : channels.length === 6
      ? [1, 1, 1, 0, 1.41, 1.41]
      : new Array<number>(channels.length).fill(1);

  return channels.map((ch, index) => {
    const weight = channelWeights[index];
    const segmentCount = Math.floor(ch.length / segLen);
    if (weight === 0) return new Float64Array(segmentCount); // 5.1 LFE is excluded.
    const powers = segmentSumSquares(kWeight(ch, fs), segLen);
    if (weight !== 1) {
      for (let i = 0; i < powers.length; i++) powers[i] *= weight;
    }
    return powers;
  });
}

// Integrated loudness from momentary (400ms) blocks: absolute gate at -70 LUFS,
// then a relative gate 10 LU below the abs-gated mean.
function integratedFromBlocks(blocks: Block[]): number | null {
  const absGated = blocks.filter((b) => b.loudness > ABSOLUTE_GATE_LUFS);
  if (absGated.length === 0) return null;
  const relThreshold = blockLoudness(averagePowers(absGated)) - REL_GATE_INTEGRATED;
  const relGated = absGated.filter((b) => b.loudness > relThreshold);
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
  const absGated = blocks.filter((b) => b.loudness > ABSOLUTE_GATE_LUFS);
  if (absGated.length < 2) return null;
  const relThreshold = blockLoudness(averagePowers(absGated)) - REL_GATE_LRA;
  const relGated = absGated.filter((b) => b.loudness > relThreshold);
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

function maximumBlockLoudness(
  blocks: Block[],
): { loudness: number; timeSec: number } | null {
  let maximum: Block | null = null;
  for (const block of blocks) {
    if (!Number.isFinite(block.loudness)) continue;
    if (maximum === null || block.loudness > maximum.loudness) maximum = block;
  }
  return maximum === null
    ? null
    : { loudness: maximum.loudness, timeSec: maximum.startSec };
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

export type SignalMetrics = {
  samplePeakAmplitude: number;
  clippedSampleCount: number;
  dcOffsetDb: number | null;
  stereoCorrelation: number | null;
  stereoBalanceDb: number | null;
  leadingSilenceSec: number;
  trailingSilenceSec: number;
};

const SILENCE_THRESHOLD_AMPLITUDE = 0.001; // -60 dBFS.

export function signalMetrics(channels: Float32Array[], fs: number): SignalMetrics {
  if (channels.length === 0 || fs <= 0) {
    return {
      samplePeakAmplitude: 0,
      clippedSampleCount: 0,
      dcOffsetDb: null,
      stereoCorrelation: null,
      stereoBalanceDb: null,
      leadingSilenceSec: 0,
      trailingSilenceSec: 0,
    };
  }

  const length = Math.min(...channels.map((channel) => channel.length));
  const sums = new Float64Array(channels.length);
  let samplePeakAmplitude = 0;
  let clippedSampleCount = 0;
  let firstAudible = length;
  let lastAudible = -1;
  let leftPower = 0;
  let rightPower = 0;
  let crossPower = 0;

  for (let index = 0; index < length; index++) {
    let audible = false;
    for (let channelIndex = 0; channelIndex < channels.length; channelIndex++) {
      const value = channels[channelIndex][index];
      const absolute = Math.abs(value);
      sums[channelIndex] += value;
      if (absolute > samplePeakAmplitude) samplePeakAmplitude = absolute;
      if (absolute >= 1) clippedSampleCount++;
      if (absolute > SILENCE_THRESHOLD_AMPLITUDE) audible = true;
    }
    if (audible) {
      if (firstAudible === length) firstAudible = index;
      lastAudible = index;
    }
    if (channels.length === 2) {
      const left = channels[0][index];
      const right = channels[1][index];
      leftPower += left * left;
      rightPower += right * right;
      crossPower += left * right;
    }
  }

  const largestDc = length === 0
    ? 0
    : sums.reduce((largest, sum) => Math.max(largest, Math.abs(sum / length)), 0);
  const stereoDenominator = Math.sqrt(leftPower * rightPower);
  const stereoCorrelation = channels.length === 2 && stereoDenominator > 0
    ? Math.max(-1, Math.min(1, crossPower / stereoDenominator))
    : null;
  const stereoBalanceDb = channels.length === 2 && leftPower > 0 && rightPower > 0
    ? 10 * Math.log10(leftPower / rightPower)
    : null;
  const leadingSilenceSec = firstAudible === length ? length / fs : firstAudible / fs;
  const trailingSilenceSec = lastAudible < 0 ? length / fs : (length - 1 - lastAudible) / fs;

  return {
    samplePeakAmplitude,
    clippedSampleCount,
    dcOffsetDb: largestDc > 0 ? toDb(largestDc) : null,
    stereoCorrelation,
    stereoBalanceDb,
    leadingSilenceSec,
    trailingSilenceSec,
  };
}

export function wavBitDepth(bytes: ArrayBuffer): number | null {
  if (bytes.byteLength < 36) return null;
  const view = new DataView(bytes);
  const ascii = (offset: number, length: number) => {
    let value = "";
    for (let index = 0; index < length; index++) {
      value += String.fromCharCode(view.getUint8(offset + index));
    }
    return value;
  };
  const container = ascii(0, 4);
  if ((container !== "RIFF" && container !== "RF64") || ascii(8, 4) !== "WAVE") return null;

  let offset = 12;
  while (offset + 8 <= view.byteLength) {
    const chunkId = ascii(offset, 4);
    const chunkSize = view.getUint32(offset + 4, true);
    const payload = offset + 8;
    if (chunkId === "fmt " && chunkSize >= 16 && payload + chunkSize <= view.byteLength) {
      const format = view.getUint16(payload, true);
      const containerBits = view.getUint16(payload + 14, true);
      if (format !== 1 && format !== 3 && format !== 0xfffe) return null;
      if (format === 0xfffe && chunkSize >= 40) {
        const validBits = view.getUint16(payload + 18, true);
        return validBits > 0 ? validBits : containerBits || null;
      }
      return containerBits || null;
    }
    const next = payload + chunkSize + (chunkSize % 2);
    if (next <= offset) break;
    offset = next;
  }
  return null;
}

// True-peak meter (BS.1770-5). Oversample so peaks that fall *between* stored
// samples are caught — those are what clip a DAC even when no sample reads over
// 0 dBFS. The oversampling factor scales down with sample rate to hold the
// effective rate near 192kHz (at/above 192kHz the sample peak already suffices).
// At 48 kHz, use the exact order-48, four-phase FIR published in Annex 2.
const ITU_TRUE_PEAK_4X: readonly (readonly number[])[] = [
  [0.001708984375, 0.010986328125, -0.0196533203125, 0.033203125, -0.0594482421875, 0.1373291015625, 0.97216796875, -0.102294921875, 0.047607421875, -0.026611328125, 0.014892578125, -0.00830078125],
  [-0.0291748046875, 0.029296875, -0.0517578125, 0.089111328125, -0.16650390625, 0.465087890625, 0.77978515625, -0.2003173828125, 0.1015625, -0.0582275390625, 0.0330810546875, -0.0189208984375],
  [-0.0189208984375, 0.0330810546875, -0.0582275390625, 0.1015625, -0.2003173828125, 0.77978515625, 0.465087890625, -0.16650390625, 0.089111328125, -0.0517578125, 0.029296875, -0.0291748046875],
  [-0.00830078125, 0.014892578125, -0.026611328125, 0.047607421875, -0.102294921875, 0.97216796875, 0.1373291015625, -0.0594482421875, 0.033203125, -0.0196533203125, 0.010986328125, 0.001708984375],
];

function truePeakFactor(fs: number): number {
  return Math.max(1, Math.min(4, Math.round(192000 / fs)));
}

function buildPolyphase(factor: number): Float64Array[] {
  const taps = 16;
  const phases: Float64Array[] = [];
  for (let p = 1; p < factor; p++) {
    const d = p / factor;
    const row = new Float64Array(taps);
    let sum = 0;
    for (let t = 0; t < taps; t++) {
      const k = t - 7; // sample offset relative to n
      const x = k - d;
      const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
      const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * t) / (taps - 1)); // Hann
      row[t] = sinc * w;
      sum += row[t];
    }
    for (let t = 0; t < taps; t++) row[t] /= sum; // unity DC gain
    phases.push(row);
  }
  return phases;
}

export function truePeak(
  channels: Float32Array[],
  fs: number,
  knownSamplePeak = samplePeak(channels),
): number {
  const factor = truePeakFactor(fs);
  let peak = knownSamplePeak; // the stored samples are phase 0
  if (factor === 1 || channels.length === 0) return peak;

  const phases = factor === 4 && fs === 48000
    ? ITU_TRUE_PEAK_4X
    : buildPolyphase(factor);
  const center = phases[0].length === 12 ? 6 : 7;
  for (const ch of channels) {
    const n = ch.length;
    for (let i = 0; i < n; i++) {
      for (let ph = 0; ph < phases.length; ph++) {
        const row = phases[ph];
        let acc = 0;
        for (let t = 0; t < row.length; t++) {
          const idx = i + t - center;
          if (idx >= 0 && idx < n) acc += ch[idx] * row[t];
        }
        const a = Math.abs(acc);
        if (a > peak) peak = a;
      }
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

export function waveformEnvelope(
  mono: Float32Array,
  bucketCount: number,
): { min: number[]; max: number[] } {
  if (mono.length === 0 || bucketCount <= 0) return { min: [], max: [] };
  const count = Math.min(bucketCount, mono.length);
  const min = new Array<number>(count);
  const max = new Array<number>(count);
  const per = mono.length / count;
  for (let bucket = 0; bucket < count; bucket++) {
    const start = Math.floor(bucket * per);
    const end = Math.max(start + 1, Math.min(mono.length, Math.floor((bucket + 1) * per)));
    let low = 1;
    let high = -1;
    for (let sample = start; sample < end; sample++) {
      const value = mono[sample];
      if (value < low) low = value;
      if (value > high) high = value;
    }
    // Millisample precision is visually lossless here and keeps persisted
    // album projects comfortably below localStorage limits.
    min[bucket] = Math.round(Math.max(-1, low) * 1000) / 1000;
    max[bucket] = Math.round(Math.min(1, high) * 1000) / 1000;
  }
  return { min, max };
}

export function packWaveformEnvelope(min: number[], max: number[]): string {
  if (min.length !== max.length) throw new Error("Waveform envelope channels must have equal lengths.");
  const bytes = new Uint8Array(min.length * 2);
  const quantize = (value: number) => Math.round((Math.max(-1, Math.min(1, value)) + 1) * 127.5);
  for (let index = 0; index < min.length; index++) {
    bytes[index * 2] = quantize(min[index]);
    bytes[index * 2 + 1] = quantize(max[index]);
  }
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 32768) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
  }
  return btoa(binary);
}

export function unpackWaveformEnvelope(data: string, pointCount: number) {
  if (!data || pointCount <= 0) return { min: [] as number[], max: [] as number[] };
  const binary = atob(data);
  if (binary.length !== pointCount * 2) return { min: [] as number[], max: [] as number[] };
  const min = new Array<number>(pointCount);
  const max = new Array<number>(pointCount);
  for (let index = 0; index < pointCount; index++) {
    min[index] = binary.charCodeAt(index * 2) / 127.5 - 1;
    max[index] = binary.charCodeAt(index * 2 + 1) / 127.5 - 1;
  }
  return { min, max };
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

  const measuredSignal = signalMetrics(channels, fs);
  const peakAmp = truePeak(channels, fs, measuredSignal.samplePeakAmplitude);
  const mono = mixToMono(channels);
  const peaks = bucketPeaks(mono, bucketCount);
  const channelWaveforms = channels.slice(0, 2).map((channel) => waveformEnvelope(channel, 65536));
  const waveformChannels = channelWaveforms.map((waveform) => packWaveformEnvelope(waveform.min, waveform.max));
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
  const momentaryMaximum =
    segCount >= SEGMENTS_PER_MOMENTARY
      ? maximumBlockLoudness(
          blocksFromSegments(segByChannel, segLen, SEGMENTS_PER_MOMENTARY),
        )
      : null;
  const shortTermMaximum =
    segCount >= SEGMENTS_PER_SHORT_TERM
      ? maximumBlockLoudness(
          blocksFromSegments(segByChannel, segLen, SEGMENTS_PER_SHORT_TERM),
        )
      : null;

  return {
    durationSec: buffer.duration,
    sampleRate: fs,
    channelCount: buffer.numberOfChannels,
    peaks,
    waveformChannels,
    waveformPoints: channelWaveforms[0]?.min.length ?? 0,
    integratedLufs,
    dynamicRangeLu,
    maxMomentaryLufs: momentaryMaximum?.loudness ?? null,
    maxMomentaryTimeSec: momentaryMaximum?.timeSec ?? null,
    maxShortTermLufs: shortTermMaximum?.loudness ?? null,
    maxShortTermTimeSec: shortTermMaximum?.timeSec ?? null,
    truePeakDb: Number.isFinite(peakDb) ? peakDb : -Infinity,
    samplePeakDb: toDb(measuredSignal.samplePeakAmplitude),
    clippedSampleCount: measuredSignal.clippedSampleCount,
    dcOffsetDb: measuredSignal.dcOffsetDb,
    stereoCorrelation: measuredSignal.stereoCorrelation,
    stereoBalanceDb: measuredSignal.stereoBalanceDb,
    bitDepth: wavBitDepth(bytes),
    leadingSilenceSec: measuredSignal.leadingSilenceSec,
    trailingSilenceSec: measuredSignal.trailingSilenceSec,
  };
}
