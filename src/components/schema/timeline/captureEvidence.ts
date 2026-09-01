import type { SavedSessionEvent } from "../../../types/recall";

export type EvidenceFact = { label: string; value: string };

export type AutomationEvidencePoint = {
  beat: number;
  value: number;
  displayValue: string | null;
};

export type MidiEvidenceNote = {
  pitch: number;
  startBeats: number;
  durationBeats: number;
  velocity: number | null;
  probability: number | null;
  velocityDeviation: number | null;
  releaseVelocity: number | null;
  muted: boolean;
};

export type WarpEvidenceMarker = {
  beat: number;
  sampleTime: number;
};

export type CapturedEvidence = {
  facts: EvidenceFact[];
  automationPoints: AutomationEvidencePoint[];
  midiNotes: MidiEvidenceNote[];
  warpMarkers: WarpEvidenceMarker[];
};

type Payload = Record<string, unknown>;

function payloadOf(event: SavedSessionEvent): Payload {
  if (!event.payload) return {};
  try {
    const parsed = JSON.parse(event.payload) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Payload : {};
  } catch {
    return {};
  }
}

function finite(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const clean = value.trim();
  return clean && clean !== "0" ? clean : null;
}

function boolean(value: unknown): boolean {
  return value === true || value === 1;
}

function array(payload: Payload, ...keys: string[]): unknown[] {
  for (const key of keys) {
    const value = payload[key];
    if (Array.isArray(value)) return value;
  }
  return [];
}

function valueAt(record: Payload, ...keys: string[]): unknown {
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null) return record[key];
  }
  return null;
}

function automationPoints(payload: Payload, eventType: string): AutomationEvidencePoint[] {
  if (!eventType.includes("automation")) return [];
  return array(payload, "automation_points", "envelope_points", "points")
    .map((value): AutomationEvidencePoint | null => {
      if (Array.isArray(value)) {
        const beat = finite(value[0]);
        const pointValue = finite(value[1]);
        return beat !== null && pointValue !== null
          ? { beat, value: pointValue, displayValue: text(value[2]) }
          : null;
      }
      if (!value || typeof value !== "object") return null;
      const record = value as Payload;
      const beat = finite(valueAt(record, "beat", "time", "position", "position_beats"));
      const pointValue = finite(valueAt(record, "value", "parameter_value"));
      return beat !== null && pointValue !== null
        ? { beat, value: pointValue, displayValue: text(valueAt(record, "display_value", "label")) }
        : null;
    })
    .filter((point): point is AutomationEvidencePoint => point !== null)
    .sort((a, b) => a.beat - b.beat);
}

function midiNotes(payload: Payload): MidiEvidenceNote[] {
  return array(payload, "midi_notes", "notes", "note_snapshot")
    .map((value): MidiEvidenceNote | null => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return null;
      const record = value as Payload;
      const pitch = finite(record.pitch);
      const startBeats = finite(valueAt(record, "start_time", "start", "start_beats"));
      const durationBeats = finite(valueAt(record, "duration", "duration_beats"));
      if (pitch === null || startBeats === null || durationBeats === null) return null;
      return {
        pitch,
        startBeats,
        durationBeats,
        velocity: finite(record.velocity),
        probability: finite(record.probability),
        velocityDeviation: finite(record.velocity_deviation),
        releaseVelocity: finite(record.release_velocity),
        muted: boolean(record.mute),
      };
    })
    .filter((note): note is MidiEvidenceNote => note !== null)
    .sort((a, b) => a.startBeats - b.startBeats || a.pitch - b.pitch);
}

function warpMarkers(payload: Payload): WarpEvidenceMarker[] {
  return array(payload, "warp_markers")
    .map((value): WarpEvidenceMarker | null => {
      if (Array.isArray(value)) {
        const beat = finite(value[0]);
        const sampleTime = finite(value[1]);
        return beat !== null && sampleTime !== null ? { beat, sampleTime } : null;
      }
      if (!value || typeof value !== "object") return null;
      const record = value as Payload;
      const beat = finite(valueAt(record, "beat_time", "beat", "position_beats"));
      const sampleTime = finite(valueAt(record, "sample_time", "sample_seconds", "time"));
      return beat !== null && sampleTime !== null ? { beat, sampleTime } : null;
    })
    .filter((marker): marker is WarpEvidenceMarker => marker !== null)
    .sort((a, b) => a.beat - b.beat);
}

function formattedNumber(value: unknown, suffix = ""): string | null {
  const parsed = finite(value);
  if (parsed === null) return null;
  const display = Number.isInteger(parsed) ? String(parsed) : parsed.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
  return `${display}${suffix}`;
}

function addFact(facts: EvidenceFact[], label: string, value: string | null) {
  if (value && !facts.some((fact) => fact.label === label && fact.value === value)) facts.push({ label, value });
}

/** Parse optional, durable recreation evidence without assuming it was captured. */
export function captureEvidence(event: SavedSessionEvent | null | undefined): CapturedEvidence | null {
  if (!event) return null;
  const payload = payloadOf(event);
  const facts: EvidenceFact[] = [];
  const sourcePath = event.file_path ?? text(valueAt(payload, "file_path", "path"));
  addFact(facts, "Source", sourcePath);
  addFact(facts, "Clip length", formattedNumber(valueAt(payload, "length_beats", "span_beats"), " quarter-note beats"));
  addFact(facts, "Notes", formattedNumber(valueAt(payload, "note_count", "count")));
  addFact(facts, "Pitch range", text(payload.pitch_range));
  addFact(facts, "Pitches used", formattedNumber(payload.distinct_pitches));
  addFact(facts, "Average velocity", formattedNumber(payload.velocity_mean));
  addFact(facts, "Warp mode", text(valueAt(payload, "warp_mode_name", "warp_mode")));
  addFact(facts, "Gain", text(valueAt(payload, "gain_display_string", "gain_display")) ?? formattedNumber(payload.gain));
  addFact(facts, "Transpose", formattedNumber(payload.pitch_coarse, " st"));
  addFact(facts, "Detune", formattedNumber(payload.pitch_fine, " ct"));
  addFact(facts, "Sample rate", formattedNumber(payload.sample_rate, " Hz"));
  addFact(facts, "Loop start", formattedNumber(payload.loop_start, " beats"));
  addFact(facts, "Loop end", formattedNumber(payload.loop_end, " beats"));
  addFact(facts, "Input", text(valueAt(payload, "input_routing_type", "input_routing_channel")));
  addFact(facts, "Output", text(valueAt(payload, "output_routing_type", "output_routing_channel")));
  addFact(facts, "Average level", formattedNumber(valueAt(payload, "average_db", "mean_db"), " dB"));
  addFact(facts, "Peak level", formattedNumber(payload.peak_db, " dB"));
  addFact(facts, "Dynamic range", formattedNumber(valueAt(payload, "dynamic_range_db", "crest_db"), " dB"));
  addFact(facts, "Scene tempo", formattedNumber(payload.tempo, " BPM"));
  const numerator = finite(valueAt(payload, "time_signature_numerator", "signature_numerator"));
  const denominator = finite(valueAt(payload, "time_signature_denominator", "signature_denominator"));
  addFact(facts, "Scene meter", numerator !== null && denominator !== null ? `${numerator}/${denominator}` : null);
  addFact(facts, "Song position", formattedNumber(valueAt(payload, "cue_time", "time"), " beats"));

  const curve = automationPoints(payload, event.type);
  const notes = midiNotes(payload);
  const markers = warpMarkers(payload);
  // Every capped read reports its cap. A curve stopped at the ceiling reads as
  // the whole envelope unless we say otherwise, and "the whole envelope" is a
  // claim a producer would act on.
  if (curve.length > 0) addFact(facts, "Envelope", `${curve.length} captured point${curve.length === 1 ? "" : "s"}`);
  if (curve.length > 0 && boolean(payload.automation_points_truncated)) addFact(facts, "Envelope limit", `Showing the first ${curve.length} points`);
  if (notes.length > 0) addFact(facts, "Pattern", `${notes.length} captured note${notes.length === 1 ? "" : "s"}`);
  if (notes.length > 0 && boolean(payload.midi_notes_truncated)) addFact(facts, "Pattern limit", `Showing the first ${notes.length} notes`);
  if (markers.length > 0) addFact(facts, "Warping", `${markers.length} captured marker${markers.length === 1 ? "" : "s"}`);
  if (markers.length > 0 && boolean(payload.warp_markers_truncated)) addFact(facts, "Warping limit", `Showing the first ${markers.length} markers`);

  if (facts.length === 0 && curve.length === 0 && notes.length === 0 && markers.length === 0) return null;
  return { facts, automationPoints: curve, midiNotes: notes, warpMarkers: markers };
}

export function rawEventId(derivedId: string): string | null {
  for (const prefix of ["pc::", "note-edit-", "clip-event-"]) {
    if (derivedId.startsWith(prefix)) return derivedId.slice(prefix.length);
  }
  return null;
}
