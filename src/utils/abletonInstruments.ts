export type AbletonInstrumentReference = {
  name: string;
  family: string;
  engine: string;
  role: string;
  focus: string[];
  performanceNote?: string;
};

const INSTRUMENTS: AbletonInstrumentReference[] = [
  {
    name: "Analog",
    family: "Virtual Analog",
    engine: "physical-modelled analog synth",
    role: "Warm oscillators, dual filters, envelopes, and LFO movement.",
    focus: ["oscillators", "filters", "envelopes", "LFO"],
  },
  {
    name: "Collision",
    family: "Physical Modeling",
    engine: "mallet and resonator synth",
    role: "Percussive resonant bodies, tuned impacts, and metallic tones.",
    focus: ["mallet", "noise", "resonators", "MPE"],
    performanceNote: "Disable unused sections when sketching dense sets.",
  },
  {
    name: "Drift",
    family: "Subtractive Synth",
    engine: "minimal-CPU MPE synth",
    role: "Fast subtractive patches, basses, keys, and expressive macros.",
    focus: ["oscillators", "dynamic filter", "envelopes", "modulation"],
    performanceNote: "Built for quick sound design with low CPU overhead.",
  },
  {
    name: "Drum Sampler",
    family: "Drum Instrument",
    engine: "single-pad drum sampler",
    role: "One-shot drum design with sample shaping and playback effects.",
    focus: ["sample", "playback", "filter", "global"],
  },
  {
    name: "Electric",
    family: "Physical Modeling",
    engine: "electric piano model",
    role: "Modeled tine/pickup-style keys, tone shaping, and performance dynamics.",
    focus: ["hammer", "fork", "damper", "pickup"],
  },
  {
    name: "External Instrument",
    family: "Routing",
    engine: "hardware and plugin MIDI/audio bridge",
    role: "Routes MIDI out and returns audio from external instruments.",
    focus: ["MIDI routing", "audio return", "latency", "hardware"],
  },
  {
    name: "Impulse",
    family: "Drum Instrument",
    engine: "eight-slot drum sampler",
    role: "Compact drum kit triggering, transposition, stretch, and decay shaping.",
    focus: ["sample slots", "filter", "saturator", "decay"],
  },
  {
    name: "Meld",
    family: "Macro Synth",
    engine: "dual macro-oscillator synth",
    role: "Layered, experimental tones with two engines and modulation matrix control.",
    focus: ["engines A/B", "macro oscillators", "filters", "matrix"],
    performanceNote: "Stacked voices can create a heavy CPU load.",
  },
  {
    name: "Operator",
    family: "FM Synth",
    engine: "four-oscillator FM/subtractive synth",
    role: "FM basses, bells, digital keys, complex timbres, and algorithm changes.",
    focus: ["oscillators A-D", "algorithm", "filter", "LFO"],
    performanceNote: "Spread and extra voices are CPU-sensitive.",
  },
  {
    name: "Sampler",
    family: "Sampling Instrument",
    engine: "multisampling instrument",
    role: "Layered multisamples, velocity zones, key zones, and deep modulation.",
    focus: ["zones", "sample", "pitch/osc", "modulation"],
  },
  {
    name: "Simpler",
    family: "Sampling Instrument",
    engine: "single-sample instrument",
    role: "Classic sample playback, one-shots, slicing, and fast sample replacement.",
    focus: ["classic", "one-shot", "slicing", "warp"],
    performanceNote: "Tiny loops and complex warp modes can raise CPU load.",
  },
  {
    name: "Tension",
    family: "Physical Modeling",
    engine: "string excitation model",
    role: "Plucked, bowed, hammered, and resonant string-like sounds.",
    focus: ["exciter", "string", "damper", "body"],
  },
  {
    name: "Wavetable",
    family: "Wavetable Synth",
    engine: "dual wavetable oscillator synth",
    role: "Evolving timbres, modern basses, pads, wavetable movement, and modulation.",
    focus: ["oscillators", "filters", "matrix", "unison"],
    performanceNote: "Hi-Quality mode can be disabled to save CPU in large sets.",
  },
];

export function findAbletonInstrumentReference(
  deviceName?: string | null,
): AbletonInstrumentReference | null {
  if (!deviceName) {
    return null;
  }

  const normalizedDevice = normalize(deviceName);

  return (
    INSTRUMENTS.find((instrument) => {
      const normalizedInstrument = normalize(instrument.name);

      return (
        normalizedDevice === normalizedInstrument ||
        normalizedDevice.includes(normalizedInstrument)
      );
    }) ?? null
  );
}

export function isKnownAbletonInstrument(deviceName?: string | null): boolean {
  return findAbletonInstrumentReference(deviceName) !== null;
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
