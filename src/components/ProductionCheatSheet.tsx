import { useMemo, useState } from "react";

type CheatTerm = {
  term: string;
  category: CheatCategory;
  def: string;
  tip?: string;
};

type CheatCategory =
  | "Arrangement"
  | "Signal Flow"
  | "Sound Design"
  | "Mix & Master"
  | "Workflow"
  | "Ableton";

const CATEGORIES: CheatCategory[] = [
  "Arrangement",
  "Signal Flow",
  "Sound Design",
  "Mix & Master",
  "Workflow",
  "Ableton",
];

// A focused, hand-picked subset of the full terminology reference — the terms a
// producer actually wants at a glance, with a practical tip rather than a dry
// definition. This is the cheat sheet, not the encyclopedia.
const TERMS: CheatTerm[] = [
  {
    term: "Drop",
    category: "Arrangement",
    def: "The peak-energy moment where the full beat lands, usually right after a build-up.",
    tip: "Make everything before it feel smaller so the drop hits harder by contrast.",
  },
  {
    term: "Build-Up",
    category: "Arrangement",
    def: "A rising-tension section before a drop — risers, drum rolls, filter sweeps.",
    tip: "Automate a high-pass filter opening up over 4–8 bars to pull the ear forward.",
  },
  {
    term: "Breakdown",
    category: "Arrangement",
    def: "A stripped-back section, often with drums removed, that gives the track room to breathe.",
    tip: "Use it to reintroduce your hook in a new, quieter light.",
  },
  {
    term: "Hook",
    category: "Arrangement",
    def: "The most memorable idea in the track — melodic, lyrical, or a signature sound.",
    tip: "If you can't hum it after one listen, it's not the hook yet.",
  },
  {
    term: "Fill",
    category: "Arrangement",
    def: "A short flourish that marks the end of a phrase and pushes into the next section.",
    tip: "A single well-placed fill sells a transition better than a stack of effects.",
  },
  {
    term: "Send & Return",
    category: "Signal Flow",
    def: "A send taps a copy of a track's signal to a Return track for shared effects like reverb.",
    tip: "One reverb on a Return, fed by many tracks, glues a mix into the same space.",
  },
  {
    term: "Bus / Group",
    category: "Signal Flow",
    def: "A track that collects several tracks into one fader for processing them together.",
    tip: "Group your drums and compress the bus gently — instant cohesion.",
  },
  {
    term: "Gain Staging",
    category: "Signal Flow",
    def: "Keeping levels healthy at every stage so nothing clips or gets buried.",
    tip: "Aim for peaks around -6 dB on individual tracks to leave headroom.",
  },
  {
    term: "Sidechain",
    category: "Signal Flow",
    def: "Using one signal to trigger compression on another — the classic kick-ducks-bass pump.",
    tip: "Subtle sidechain on pads and reverb makes space for the kick without you noticing.",
  },
  {
    term: "ADSR",
    category: "Sound Design",
    def: "Attack, Decay, Sustain, Release — the envelope shaping how a sound evolves over time.",
    tip: "Slow the attack on a synth to turn a stab into a swell.",
  },
  {
    term: "LFO",
    category: "Sound Design",
    def: "Low-Frequency Oscillator — a slow, cyclical modulator that adds movement.",
    tip: "Map an LFO to filter cutoff for evolving, never-static textures.",
  },
  {
    term: "Filter Cutoff",
    category: "Sound Design",
    def: "The frequency where a filter starts removing content; the main knob for brightness.",
    tip: "Automate the cutoff across a section instead of layering more sounds.",
  },
  {
    term: "Granular Synthesis",
    category: "Sound Design",
    def: "Chopping audio into tiny grains and rearranging them into new textures.",
    tip: "Feed a vocal into a granular engine for instant atmospheric pads.",
  },
  {
    term: "EQ",
    category: "Mix & Master",
    def: "Boosting or cutting specific frequency ranges without touching the rest.",
    tip: "Cut before you boost — carving space beats piling on volume.",
  },
  {
    term: "Compression",
    category: "Mix & Master",
    def: "Reducing dynamic range by taming peaks, evening out a performance.",
    tip: "Fast attack tames transients; slow attack keeps punch. Listen, don't stare.",
  },
  {
    term: "Headroom",
    category: "Mix & Master",
    def: "The safety margin between your loudest peak and the digital ceiling (0 dBFS).",
    tip: "Leave -6 dB on the master so mastering has room to work.",
  },
  {
    term: "LUFS",
    category: "Mix & Master",
    def: "Loudness Units Full Scale — the loudness standard streaming platforms measure against.",
    tip: "Around -14 LUFS integrated is a safe target for streaming.",
  },
  {
    term: "Reference Track",
    category: "Mix & Master",
    def: "A professionally finished song you A/B against to keep your mix honest.",
    tip: "Match its loudness before comparing, or the louder one always 'wins'.",
  },
  {
    term: "Sketch",
    category: "Workflow",
    def: "A rough, exploratory idea — not meant to be finished, just to capture a spark.",
    tip: "Save sketches freely. Today's throwaway loop is next month's hook.",
  },
  {
    term: "Bounce / Render",
    category: "Workflow",
    def: "Exporting a track, group, or session to a flat audio file.",
    tip: "Bounce stems before a big change so you can always retrace your steps.",
  },
  {
    term: "Comping",
    category: "Workflow",
    def: "Stitching the best moments from several takes into one ideal performance.",
    tip: "Mark the magic moments as you record so comping later is fast.",
  },
  {
    term: "Happy Accident",
    category: "Workflow",
    def: "A mistake that sounds better than what you intended.",
    tip: "Keep a 'parking lot' track for accidents you don't want to lose.",
  },
  {
    term: "Reference Pass",
    category: "Workflow",
    def: "A focused listen-through where you only note what needs fixing — no tweaking yet.",
    tip: "Separate listening from editing; you'll make sharper decisions.",
  },
  {
    term: "Rack",
    category: "Ableton",
    def: "A container holding multiple devices in chains — Instrument, Audio, MIDI, or Drum Rack.",
    tip: "Map a Macro to several params at once and perform your sound with one knob.",
  },
  {
    term: "Macro",
    category: "Ableton",
    def: "One knob mapped to control many parameters across devices simultaneously.",
    tip: "Eight Macros turn a complex Rack into a playable instrument.",
  },
  {
    term: "Scene",
    category: "Ableton",
    def: "A row of clips in Session View that launch together as one moment.",
    tip: "Lay out song sections as scenes, then record the perform into Arrangement.",
  },
  {
    term: "Warp",
    category: "Ableton",
    def: "Time-stretching audio to follow the project tempo without changing pitch.",
    tip: "Set warp markers on the transients of a loop for tight, clean stretching.",
  },
  {
    term: "Clip Envelope",
    category: "Ableton",
    def: "Per-clip automation of any device or mixer parameter.",
    tip: "Automate a filter inside the clip so the movement travels with it everywhere.",
  },
  {
    term: "Follow Actions",
    category: "Ableton",
    def: "Rules for what a clip does when it finishes — loop, play next, stop, or jump randomly.",
    tip: "Chain clips with random follow actions for generative, never-repeating ideas.",
  },
];

export function ProductionCheatSheet() {
  const [query, setQuery] = useState("");
  const [activeCategory, setActiveCategory] = useState<CheatCategory | "All">(
    "All",
  );
  const [flipped, setFlipped] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return TERMS.filter((t) => {
      const matchesCategory =
        activeCategory === "All" || t.category === activeCategory;
      const matchesQuery =
        q.length === 0 ||
        t.term.toLowerCase().includes(q) ||
        t.def.toLowerCase().includes(q) ||
        t.category.toLowerCase().includes(q);
      return matchesCategory && matchesQuery;
    });
  }, [query, activeCategory]);

  function surpriseMe() {
    const pool = filtered.length > 0 ? filtered : TERMS;
    const pick = pool[Math.floor(Math.random() * pool.length)];
    setFlipped(pick.term);
    // Scroll the picked card into view if it exists in the DOM.
    requestAnimationFrame(() => {
      document
        .querySelector(`[data-term="${CSS.escape(pick.term)}"]`)
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  }

  return (
    <section className="cheat-sheet">
      <header className="cheat-sheet__head">
        <div>
          <div className="section-kicker">Producer Cheat Sheet</div>
          <h1 className="cheat-sheet__title">The Language of the Session</h1>
          <p className="cheat-sheet__lede">
            Plain-English definitions and one practical tip per term. Search it,
            filter it, or hit <em>Surprise me</em> when you want to learn
            something new.
          </p>
        </div>

        <div className="cheat-sheet__controls">
          <input
            type="search"
            className="cheat-sheet__search"
            placeholder="Search terms, e.g. sidechain…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search the cheat sheet"
          />
          <button
            type="button"
            className="cheat-sheet__surprise"
            onClick={surpriseMe}
          >
            🎲 Surprise me
          </button>
        </div>
      </header>

      <div className="cheat-sheet__chips" role="tablist" aria-label="Categories">
        <button
          type="button"
          className={`cheat-chip ${activeCategory === "All" ? "is-active" : ""}`}
          onClick={() => setActiveCategory("All")}
        >
          All
          <span className="cheat-chip__count">{TERMS.length}</span>
        </button>
        {CATEGORIES.map((cat) => {
          const count = TERMS.filter((t) => t.category === cat).length;
          return (
            <button
              key={cat}
              type="button"
              className={`cheat-chip ${
                activeCategory === cat ? "is-active" : ""
              }`}
              onClick={() => setActiveCategory(cat)}
            >
              {cat}
              <span className="cheat-chip__count">{count}</span>
            </button>
          );
        })}
      </div>

      {filtered.length === 0 ? (
        <p className="cheat-sheet__empty">
          No terms match “{query}”. Try a broader word or clear the search.
        </p>
      ) : (
        <div className="cheat-sheet__grid">
          {filtered.map((t) => {
            const isFlipped = flipped === t.term;
            return (
              <button
                key={t.term}
                type="button"
                data-term={t.term}
                className={`cheat-card cheat-card--${categoryKey(t.category)} ${
                  isFlipped ? "is-flipped" : ""
                }`}
                onClick={() =>
                  setFlipped((cur) => (cur === t.term ? null : t.term))
                }
                aria-pressed={isFlipped}
              >
                <span className="cheat-card__category">{t.category}</span>
                <span className="cheat-card__term">{t.term}</span>
                <span className="cheat-card__def">{t.def}</span>
                {t.tip && (
                  <span className="cheat-card__tip">
                    <span className="cheat-card__tip-label">Pro tip</span>
                    {t.tip}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}

      <p className="cheat-sheet__foot">
        Showing {filtered.length} of {TERMS.length} terms · Tap any card for a pro
        tip
      </p>
    </section>
  );
}

function categoryKey(category: CheatCategory): string {
  return category.toLowerCase().replace(/[^a-z]+/g, "-");
}
