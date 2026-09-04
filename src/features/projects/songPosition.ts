// Where in the song something happened, in the only unit a producer thinks in.
//
// THE RULE: A BAR, OR NOTHING.
//
// Live hands out arrangement positions in beats — quarter notes from the start
// of the song. The Timeline used to print those raw ("Song beat 128") because
// converting needs the set's time signature and the signature was not reaching
// the app. That looked like a cautious fallback and was not one: a producer
// cannot read "beat 128", cannot act on it, and cannot tell whether it is even
// in the part of the song they were working on. Correct and unusable is still
// unusable.
//
// So there is no beats fallback here. Either the meter is known and the bar is
// exact, or nothing is shown.
//
// WHY NOT JUST DIVIDE BY FOUR. Because it is wrong the moment a set is not in
// 4/4, and silently — a 3/4 set would be off by a third and still look
// plausible. The Timeline's own code carried a comment refusing to do it for
// exactly this reason; this module is what that comment was waiting for.

/** A set's time signature, as Live reports it. */
export type Meter = {
  numerator: number;
  denominator: number;
};

export type SongPositionSource = {
  /** Live's signature, when the snapshot reported one. */
  signatureNumerator?: number | null;
  signatureDenominator?: number | null;
  /**
   * True when the set changed meter while captured.
   *
   * One meter cannot convert a song that changed meter, and a bar four out is
   * worse than no bar. Building the full meter map is the follow-up; until then
   * this suppresses bars for that set entirely.
   */
  meterChanged?: boolean;
};

/**
 * The meter to convert with, or null when there is no honest answer.
 *
 * Both halves or neither: a defaulted denominator is the 4/4 assumption coming
 * back in through the side door.
 */
export function meterOf(source: SongPositionSource | null | undefined): Meter | null {
  if (!source || source.meterChanged) return null;
  const numerator = source.signatureNumerator;
  const denominator = source.signatureDenominator;
  if (
    typeof numerator !== "number" ||
    typeof denominator !== "number" ||
    !Number.isFinite(numerator) ||
    !Number.isFinite(denominator) ||
    numerator <= 0 ||
    denominator <= 0
  ) {
    return null;
  }
  return { numerator, denominator };
}

/**
 * How many of Live's beats make one bar.
 *
 * Live counts in quarter notes regardless of the denominator, so a bar of 7/8
 * is 7 eighth notes = 3.5 quarter notes. Dividing by the numerator alone would
 * make every compound meter wrong.
 */
export function beatsPerBar(meter: Meter): number {
  return meter.numerator * (4 / meter.denominator);
}

/**
 * The bar a beat falls in, one-based, the way Live's own ruler counts.
 *
 * Beat 0 is bar 1 — the start of the song, not "bar zero".
 */
export function barOfBeat(beats: number, meter: Meter): number | null {
  if (!Number.isFinite(beats) || beats < 0) return null;
  const perBar = beatsPerBar(meter);
  if (!Number.isFinite(perBar) || perBar <= 0) return null;
  return Math.floor(beats / perBar) + 1;
}

/** "Bar 33", or null when no bar can be stated honestly. */
export function barLabel(
  beats: number | null | undefined,
  source: SongPositionSource | null | undefined,
): string | null {
  if (beats === null || beats === undefined) return null;
  const meter = meterOf(source);
  if (!meter) return null;
  const bar = barOfBeat(beats, meter);
  return bar === null ? null : `Bar ${bar}`;
}

/**
 * "Bar 33" for a single bar, "Bar 33–41" for a range.
 *
 * Collapsed when a span begins and ends in the same bar: "Bar 33–33" reads like
 * a mistake, and a clip inside one bar is at one bar.
 */
export function barRangeLabel(
  startBeats: number | null | undefined,
  endBeats: number | null | undefined,
  source: SongPositionSource | null | undefined,
): string | null {
  const meter = meterOf(source);
  if (!meter || startBeats === null || startBeats === undefined) return null;

  const first = barOfBeat(startBeats, meter);
  if (first === null) return null;
  if (endBeats === null || endBeats === undefined) return `Bar ${first}`;

  // The END of a span is a boundary, not a beat inside it. A clip running beats
  // 0 to 16 in 4/4 occupies bars 1 to 4; reading beat 16 literally reports bar
  // 5, a bar the clip never touches.
  //
  // Nudging the value cannot fix this — at beat 16 the spacing of a double is
  // far coarser than Number.EPSILON, so subtracting it changes nothing. The
  // boundary case has to be tested for.
  const perBar = beatsPerBar(meter);
  const endBar = barOfBeat(endBeats, meter);
  if (endBar === null) return `Bar ${first}`;
  // A tolerance rather than an exact modulo: these beats arrive as floats from
  // Live and 16 can present as 15.999999999.
  const landsOnBarLine = Math.abs(endBeats / perBar - Math.round(endBeats / perBar)) < 1e-6;
  const last = Math.max(first, landsOnBarLine ? endBar - 1 : endBar);
  if (last === first) return `Bar ${first}`;
  return `Bar ${first}–${last}`;
}

/**
 * How long a span is, in bars and beats a producer would say out loud.
 *
 * "4 bars" beats "16 beats" for anything that lands on a bar line, and the
 * remainder is kept when it does not.
 */
export function spanLengthLabel(
  startBeats: number,
  endBeats: number,
  source: SongPositionSource | null | undefined,
): string | null {
  const meter = meterOf(source);
  const beats = endBeats - startBeats;
  if (!meter || !Number.isFinite(beats) || beats <= 0) return null;

  const perBar = beatsPerBar(meter);
  const bars = Math.floor(beats / perBar + 1e-9);
  const remainder = Math.round((beats - bars * perBar) * 1000) / 1000;

  if (bars > 0 && remainder <= 0) return `${bars} ${bars === 1 ? "bar" : "bars"}`;
  if (bars > 0) {
    return `${bars} ${bars === 1 ? "bar" : "bars"} ${remainder} ${remainder === 1 ? "beat" : "beats"}`;
  }
  return `${remainder} ${remainder === 1 ? "beat" : "beats"}`;
}

/**
 * Ableton's own ruler notation: bar, then the beat inside that bar.
 *
 * Live writes "1.1 · 1.2 · 1.3 · 1.4 · 2.1", and that is what a producer reads
 * off the piano roll. Recall was numbering the same ruler 1 2 3 4 5 6 7 8 —
 * raw quarter-notes — so a note at 1.3 was labelled "beat 3". Correct in Live's
 * internal unit and in the wrong language, which is the same mistake as "Song
 * beat 128" one level down.
 *
 * `beats` is measured from whatever the ruler starts at: a clip's roll counts
 * from the clip, the arrangement counts from the song.
 */
export function barBeatLabel(
  beats: number,
  source: SongPositionSource | null | undefined,
): string | null {
  const meter = meterOf(source);
  if (!meter || !Number.isFinite(beats) || beats < 0) return null;

  const perBar = beatsPerBar(meter);
  const bar = Math.floor(beats / perBar) + 1;
  // Live counts beats within the bar in the meter's own denominator, so 7/8
  // counts to 7 rather than to 3.5 quarter-notes.
  const intoBar = beats - (bar - 1) * perBar;
  const beat = Math.floor(intoBar * (meter.denominator / 4)) + 1;
  return `${bar}.${beat}`;
}

/** "2 bars", for the caption under a roll. Null when the meter is unknown. */
export function barCountLabel(
  beats: number,
  source: SongPositionSource | null | undefined,
): string | null {
  const meter = meterOf(source);
  if (!meter || !Number.isFinite(beats) || beats <= 0) return null;
  const bars = beats / beatsPerBar(meter);
  const rounded = Math.round(bars * 100) / 100;
  return `${rounded} ${rounded === 1 ? "bar" : "bars"}`;
}
