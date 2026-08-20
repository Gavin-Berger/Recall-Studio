export type ProducerWorkKind =
  | "writing"
  | "recording"
  | "sound"
  | "arrangement"
  | "mixing"
  | "project"
  | "moment";

export type ProducerWorkDefinition = {
  id: ProducerWorkKind;
  label: string;
  phrase: string;
  description: string;
  evidenceRule: string;
};

export type ProducerWorkCounts = Record<ProducerWorkKind, number>;

export type ProducerWorkSignal = {
  kind: "move" | "midi" | "clip" | "memory" | "moment";
  deviceName?: string | null;
  parameterName?: string | null;
  eventType?: string | null;
  memoryCategory?: string | null;
};

export const PRODUCER_WORK_LEGEND: readonly ProducerWorkDefinition[] = [
  {
    id: "writing",
    label: "Writing",
    phrase: "writing",
    description: "Melody, harmony, rhythm, or MIDI content changed.",
    evidenceRule: "MIDI notes were added, removed, repitched, or edited.",
  },
  {
    id: "recording",
    label: "Recording & performance",
    phrase: "recording and performance",
    description: "A part was performed, recorded, captured, or comped.",
    evidenceRule: "Recording, capture, comping, or a performed clip or scene was observed.",
  },
  {
    id: "sound",
    label: "Sound & samples",
    phrase: "sound and sample work",
    description: "The source, tone, timing, or texture of a sound changed.",
    evidenceRule: "A device, preset, non-mixer control, sample, pitch, warp, or sound process changed.",
  },
  {
    id: "arrangement",
    label: "Arrangement",
    phrase: "arrangement",
    description: "The song's form, timing, or material was reorganized.",
    evidenceRule: "A clip, scene, loop, named song section, tempo, key, meter, groove, or swing changed.",
  },
  {
    id: "mixing",
    label: "Mixing",
    phrase: "mixing",
    description: "Level, placement, routing, or mix behavior changed.",
    evidenceRule: "A mixer level, pan, send, crossfade, routing, or captured mix value changed.",
  },
  {
    id: "project",
    label: "Project changes",
    phrase: "project changes",
    description: "The Live Set's working structure or saved version changed.",
    evidenceRule: "A track or group was added, removed, renamed, frozen, flattened, or the project version was saved.",
  },
  {
    id: "moment",
    label: "Marked moments",
    phrase: "marked moments",
    description: "An idea or result was explicitly saved for later.",
    evidenceRule: "The producer created a Recall moment or keeper note.",
  },
] as const;

const DEFINITION_BY_ID = new Map(PRODUCER_WORK_LEGEND.map((definition) => [definition.id, definition]));

const ARRANGEMENT_EVENT_PREFIXES = ["cue_point_", "scene_", "clip_"];
const WRITING_EVENTS = new Set(["notes_quantized", "quantize_applied"]);
const MIX_EVENTS = new Set([
  "crossfade_assignment_changed",
  "mix_energy_summary",
  "track_routing_changed",
]);
const PROJECT_EVENT_PREFIXES = ["track_", "device_", "rack_", "chain_", "drum_pad_"];

export function emptyProducerWorkCounts(): ProducerWorkCounts {
  return {
    writing: 0,
    recording: 0,
    sound: 0,
    arrangement: 0,
    mixing: 0,
    project: 0,
    moment: 0,
  };
}

export function producerWorkDefinition(kind: ProducerWorkKind): ProducerWorkDefinition {
  return DEFINITION_BY_ID.get(kind) ?? PRODUCER_WORK_LEGEND[5]!;
}

export function classifyProducerWork(signal: ProducerWorkSignal): ProducerWorkKind {
  if (signal.kind === "moment") return "moment";
  if (signal.kind === "midi") return "writing";

  const eventType = signal.eventType?.trim().toLocaleLowerCase() ?? "";
  if (signal.kind === "clip") {
    if (eventType.includes("recorded") || eventType.includes("capture")) return "recording";
    if (eventType === "sample_added" || eventType === "audio_clip_added") return "sound";
    return "arrangement";
  }

  if (signal.kind === "move") {
    const device = signal.deviceName?.trim().toLocaleLowerCase() ?? "";
    const parameter = signal.parameterName?.trim().toLocaleLowerCase() ?? "";
    const mixerControl = /\b(volume|pan|send|crossfade|cue volume|track volume)\b/u.test(parameter);
    return device === "mixer" && mixerControl ? "mixing" : "sound";
  }

  const category = signal.memoryCategory?.trim().toLocaleLowerCase() ?? "";
  if (category === "recording" || category === "performance") return "recording";
  if (WRITING_EVENTS.has(eventType)) return "writing";
  if (category === "mix" || MIX_EVENTS.has(eventType)) return "mixing";
  if (category === "sound" || category === "automation") return "sound";
  if (category === "song") return "arrangement";
  if (category === "project") return "project";
  if (ARRANGEMENT_EVENT_PREFIXES.some((prefix) => eventType.startsWith(prefix))) return "arrangement";
  if (PROJECT_EVENT_PREFIXES.some((prefix) => eventType.startsWith(prefix))) return "project";
  return "project";
}

export function dominantProducerWork(
  counts: ProducerWorkCounts,
): { kind: ProducerWorkKind | "mixed"; observed: ProducerWorkKind[] } {
  const observed = PRODUCER_WORK_LEGEND
    .map((definition) => definition.id)
    .filter((kind) => counts[kind] > 0)
    .sort((a, b) => counts[b] - counts[a]);
  const first = observed[0];
  const second = observed[1];
  if (!first) return { kind: "mixed", observed: [] };
  if (second && counts[second] >= counts[first] * 0.5) return { kind: "mixed", observed };
  return { kind: first, observed };
}
