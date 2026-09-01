// How a movement should be READ, decided by the shape of its data.
//
// `ReportDecisionKind` answers "what kind of work was this" — control, midi,
// clip, structure, moment. That is a useful question and it is not this one.
// Two decisions can share a kind and need opposite renderings: a filter sweep
// and a filter TYPE switch are both `control`, but one is a continuous value
// with a direction and a unit, and the other is a categorical choice with
// neither. Drawing a percentage bar on a mode change states a magnitude that
// does not exist.
//
// So this classifies by shape instead, and the surface renders one component
// per shape:
//
//   binary     — it is on or it is off. Never "changed".
//   enum       — one named option replaced another. No magnitude, no direction.
//   scalar     — a value moved, in a unit, in a direction, by an amount.
//   pattern    — notes on a grid. Only a piano roll reads this.
//   span       — something occupies a range of beats in the arrangement.
//   tree       — something arrived in or left the set's structure.
//   global     — a set-wide value: tempo, key, meter, groove.
//   endpoints  — a route from one place to another.
//   text       — nothing better is known. The honest last resort.
//
// Pure, and deliberately conservative: when the data does not prove a shape,
// it falls back to `text` rather than inventing structure. A wrong shape is a
// confident lie about what the producer did.

import type { NoteEdit, ParameterChange, TimelineClipEvent } from "../../types/schema";
import type { DecisionFacts, ReportDecision } from "./sessionReport";

export type MovementShape =
  | {
      shape: "binary";
      /** What it landed on. The fact a producer needs. */
      on: boolean;
      /** Where it came from, when that was captured. */
      from: boolean | null;
      label: string;
    }
  | { shape: "enum"; from: string | null; to: string; note: string | null }
  | {
      shape: "scalar";
      /** Live's own rendering, unit included, preferred over the raw number. */
      fromLabel: string | null;
      toLabel: string | null;
      /** 0–1 positions for the bar. Null when Live gave no percentage. */
      fromFraction: number | null;
      toFraction: number | null;
      /** True when the value ended higher than it started. */
      rose: boolean | null;
    }
  | { shape: "pattern"; edit: NoteEdit }
  | {
      shape: "span";
      startBeats: number;
      endBeats: number;
    }
  | { shape: "tree"; sign: "+" | "−" | "~"; text: string }
  | { shape: "global"; label: string; from: string | null; to: string }
  | { shape: "endpoints"; from: string | null; to: string }
  | { shape: "text"; text: string };

/**
 * Parameters that are switches wearing a parameter's clothes.
 *
 * Live models a device's on/off as a DeviceParameter called "Device On", and a
 * mixer's mute/solo/arm the same way. They arrive through the parameter path
 * with values 0 and 1, and rendering them as a continuous scale asks the
 * producer to read "0% → 100%" and translate it back to "off → on".
 */
const TOGGLE_PARAMETERS = new Set([
  "device on",
  "activator",
  "mute",
  "solo",
  "arm",
  "record arm",
]);

/** Event types that are a set-wide value, not a track's. */
const GLOBAL_EVENTS = new Map<string, string>([
  ["tempo_changed", "Tempo"],
  ["signature_changed", "Time signature"],
  ["scale_changed", "Key"],
  ["key_changed", "Key"],
  ["time_signature_changed", "Time signature"],
  ["groove_changed", "Groove"],
  ["swing_changed", "Swing"],
]);

/** Event types that add something to the set's structure. */
const ARRIVED = new Set([
  "track_created",
  "track_duplicated",
  "return_track_added",
  "device_added",
  "chain_added",
  "scene_created",
  "clip_duplicated",
  "cue_point_added",
  "tracks_grouped",
  "rack_variation_stored",
  "macro_mapped",
]);

/** Event types that remove something. */
const LEFT = new Set([
  "track_deleted",
  "device_removed",
  "chain_removed",
  "scene_deleted",
  "clip_deleted",
  "cue_point_deleted",
  "automation_deleted",
  "automation_envelope_cleared",
  "rack_variation_deleted",
  "macro_unmapped",
]);

/** Event types that change something in place — renames, reorders, moves. */
const CHANGED_IN_PLACE = new Set([
  "track_renamed",
  "track_name_changed",
  "chain_renamed",
  "scene_renamed",
  "clip_renamed",
  "clip_moved",
  "device_chain_changed",
  "drum_pad_renamed",
  "track_list_changed",
]);

const ROUTING_EVENTS = new Set([
  "track_routing_changed",
  "input_routing_changed",
  "output_routing_changed",
  "crossfade_assignment_changed",
]);

function clean(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  // "0" is Live's sentinel for an absent text property and survives as truthy.
  return trimmed && trimmed !== "0" && trimmed !== "—" ? trimmed : null;
}

function isToggleParameter(name: string | null | undefined): boolean {
  const key = name?.trim().toLocaleLowerCase();
  if (key === undefined) return false;
  if (TOGGLE_PARAMETERS.has(key)) return true;

  // Instruments and Max devices frequently prefix their switches ("Arp
  // Enable", "Oscillator Enabled"). The captured 0/1 state below is still
  // required before this hint can produce a binary shape, so a parameter merely
  // containing the word "enable" cannot turn a multi-option mode into a switch.
  return /\b(?:enable|enabled|bypass|bypassed)$/.test(key);
}

/**
 * Read a captured value as a boolean.
 *
 * Live sends 0/1 for a switch. A display value ("On"/"Off") is used first when
 * present, because it is what Live itself would show the producer.
 */
function asBoolean(display: string | null, raw: number | null): boolean | null {
  const label = clean(display)?.toLocaleLowerCase();
  if (label === "on" || label === "yes" || label === "true") return true;
  if (label === "off" || label === "no" || label === "false") return false;
  if (raw === null) return null;
  if (raw === 1) return true;
  if (raw === 0) return false;
  return null;
}

function controlShape(first: ParameterChange, last: ParameterChange): MovementShape {
  const name = last.parameter_name ?? first.parameter_name;
  const toBoolean = asBoolean(last.after_display_value, last.after_value);
  const fromBoolean = asBoolean(first.before_display_value, first.before_value);
  const hasBooleanDisplay = [
    first.before_display_value,
    first.after_display_value,
    last.before_display_value,
    last.after_display_value,
  ].some((value) => {
    const label = clean(value)?.toLocaleLowerCase();
    return label === "on" || label === "off" || label === "yes" || label === "no" ||
      label === "true" || label === "false";
  });

  // A switch: report the state it landed in, never that it "changed".
  if (toBoolean !== null && (isToggleParameter(name) || hasBooleanDisplay)) {
    return {
      shape: "binary",
      on: toBoolean,
      from: fromBoolean,
      label: clean(name) ?? "Switch",
    };
  }

  const toDisplay = clean(last.after_display_value);
  const fromDisplay = clean(first.before_display_value);
  const toLabel = toDisplay ?? capturedValue(last.after_value, last.after_value_percent, last.unit);
  const fromLabel = fromDisplay ?? capturedValue(first.before_value, first.before_value_percent, first.unit);

  // A quantized parameter is a list of named options. There is no "amount" to
  // draw, and the numbers behind it are indices, not magnitudes.
  if (last.is_quantized === true) {
    if (toLabel) {
      return {
        shape: "enum",
        from: fromLabel,
        to: toLabel,
        note: toDisplay ? null : "Option names were not captured by Live.",
      };
    }
    return { shape: "text", text: "Switched settings — the value was not captured." };
  }

  const fromFraction = fractionOf(first.before_value_percent);
  const toFraction = fractionOf(last.after_value_percent);
  const rose =
    fromFraction !== null && toFraction !== null && fromFraction !== toFraction
      ? toFraction > fromFraction
      : null;

  if (toLabel === null && toFraction === null) {
    return { shape: "text", text: "Adjusted — the value was not captured." };
  }

  return { shape: "scalar", fromLabel, toLabel, fromFraction, toFraction, rose };
}

function capturedValue(raw: number | null, percent: number | null, unit: string | null): string | null {
  if (raw !== null && Number.isFinite(raw)) {
    const number = Number.isInteger(raw) ? String(raw) : raw.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
    const capturedUnit = clean(unit);
    return capturedUnit ? `${number} ${capturedUnit}` : number;
  }
  if (percent !== null && Number.isFinite(percent)) return `${Math.round(percent * 100) / 100}%`;
  return null;
}

/**
 * A 0–1 position for the bar.
 *
 * Live's explicit percent is the only evidence that a bounded range exists.
 * A raw value between 0 and 1 is not enough: it could be 0.4 dB, 0.5 ms, or
 * another real-world value that merely happens to sit inside that interval.
 */
function fractionOf(percent: number | null): number | null {
  if (percent !== null && Number.isFinite(percent)) {
    return Math.min(1, Math.max(0, percent / 100));
  }
  return null;
}

function clipShape(event: TimelineClipEvent, outcome: string): MovementShape {
  const start = event.arrangement_start_beats;
  const end = event.arrangement_end_beats;
  if (start !== null && start !== undefined && end !== null && end !== undefined && end > start) {
    return {
      shape: "span",
      startBeats: start,
      endBeats: end,
    };
  }

  // No range captured — a Session-view clip, or an older event. It still
  // ARRIVED, which is the other true thing about it.
  return { shape: "tree", sign: "+", text: outcome };
}

function structureShape(eventType: string, title: string, summary: string): MovementShape {
  const global = GLOBAL_EVENTS.get(eventType);
  if (global) {
    const arrow = splitTransition(summary);
    if (arrow) return { shape: "global", label: global, from: arrow.from, to: arrow.to };
    return { shape: "global", label: global, from: null, to: summary };
  }

  if (ROUTING_EVENTS.has(eventType)) {
    const arrow = routingTransition(summary);
    if (arrow) return { shape: "endpoints", from: arrow.from, to: arrow.to };
    return { shape: "text", text: summary };
  }

  if (eventType === "device_toggled") {
    const on = summaryToggleState(`${title} ${summary}`);
    if (on !== null) return { shape: "binary", on, from: null, label: clean(summary) ?? clean(title) ?? "Device" };
  }

  if (ARRIVED.has(eventType)) return { shape: "tree", sign: "+", text: summary };
  if (LEFT.has(eventType)) return { shape: "tree", sign: "−", text: summary };
  if (CHANGED_IN_PLACE.has(eventType)) return { shape: "tree", sign: "~", text: summary };

  return { shape: "text", text: summary };
}

/** A genuine before/after arrow, not any sentence that happens to contain "to". */
function splitTransition(summary: string): { from: string | null; to: string } | null {
  const parts = summary.split(/\s*(?:→|->)\s*/);
  if (parts.length !== 2) return null;
  const from = clean(parts[0]);
  const to = clean(parts[1]);
  return to ? { from, to } : null;
}

function routingTransition(summary: string): { from: string | null; to: string } | null {
  const arrow = splitTransition(summary);
  if (arrow) return arrow;

  const routed = summary.match(/\bnow\s+(?:listens\s+to|feeds)\s+(.+?)\s+instead\s+of\s+(.+)$/i);
  if (routed) return { from: clean(routed[2]), to: routed[1]!.trim() };

  const disconnected = summary.match(/\bnow\s+has\s+no\s+output\s+instead\s+of\s+(.+)$/i);
  return disconnected ? { from: clean(disconnected[1]), to: "No output" } : null;
}

function summaryToggleState(summary: string): boolean | null {
  const text = summary.toLocaleLowerCase();
  // Negative states win when a bridge phrase happens to carry both words.
  if (/\b(off|disabled|bypassed|deactivated)\b/.test(text)) return false;
  if (/\b(on|enabled|active|activated)\b/.test(text)) return true;
  return null;
}

/**
 * Classify one decision.
 *
 * Takes the decision rather than raw facts so the fallback can use `outcome`,
 * which is the sentence the rest of the app already agrees on.
 */
export function movementShape(decision: ReportDecision): MovementShape {
  const facts: DecisionFacts = decision.facts;

  switch (facts.of) {
    case "midi":
      return { shape: "pattern", edit: facts.edit };
    case "control":
      return controlShape(facts.first, facts.last);
    case "clip":
      return clipShape(facts.event, decision.outcome);
    case "structure":
      return structureShape(
        facts.eventType,
        facts.event.title,
        facts.event.summary,
      );
    case "moment":
      return { shape: "text", text: decision.outcome };
  }
}
