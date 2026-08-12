import { describe, expect, it } from "vitest";
import type { NoteEdit } from "../../../types/schema";
import { describeMidiChange, midiChangeSubject } from "./midiChange";

// A clip with four notes sitting between C1 and G2. Each test bends exactly one
// thing away from this, so the assertion is always about the single difference.
function edit(overrides: Partial<NoteEdit> = {}): NoteEdit {
  return {
    id: "edit-1",
    track_name: "14-MIDI",
    track_id: "6636696888",
    clip_name: null,
    clip_id: "clip-1",
    change_kind: "notes_edited",
    note_count: 4,
    previous_note_count: 4,
    distinct_pitches: 4,
    pitch_min: 36,
    pitch_max: 55,
    previous_pitch_min: 36,
    previous_pitch_max: 55,
    pitch_range: "C1-G2",
    previous_pitch_range: "C1-G2",
    velocity_mean: 100,
    length_beats: 8,
    summary: null,
    changed_at_ms: 1_700_000_000_000,
    ...overrides,
  };
}

describe("describeMidiChange", () => {
  it("names writing a part from nothing", () => {
    const { headline, detail } = describeMidiChange(
      edit({ previous_note_count: 0, note_count: 6, change_kind: "notes_added" }),
    );
    expect(headline).toBe("Wrote a new part");
    expect(detail).toContain("6 notes");
  });

  it("names clearing a part, and says how much went", () => {
    const { headline, detail } = describeMidiChange(
      edit({ note_count: 0, previous_note_count: 9, change_kind: "cleared" }),
    );
    expect(headline).toBe("Cleared the part");
    expect(detail).toContain("9 notes");
  });

  // The headline case: an octave move is what the producer did, and the old
  // display buried it as "4 notes, C1-G2 → C2-G3".
  it("recognises a whole part moving up an octave", () => {
    const { headline } = describeMidiChange(
      edit({
        pitch_min: 48,
        pitch_max: 67,
        pitch_range: "C2-G3",
        previous_pitch_range: "C1-G2",
      }),
    );
    expect(headline).toBe("Moved up 1 octave");
  });

  it("counts multiple octaves and names the direction", () => {
    const { headline } = describeMidiChange(
      edit({ pitch_min: 12, pitch_max: 31, pitch_range: "C-1-G0" }),
    );
    expect(headline).toBe("Moved down 2 octaves");
  });

  it("calls a non-octave block move a transposition", () => {
    const { headline } = describeMidiChange(
      edit({ pitch_min: 39, pitch_max: 58, pitch_range: "D#1-A#2" }),
    );
    expect(headline).toBe("Transposed up 3 semitones");
  });

  // If only one end moved, the producer re-voiced the part — they did not
  // transpose it. Saying "moved up an octave" would describe an act they never
  // performed, which is the specific way this feature could start lying.
  it("does not call a one-sided range change a transposition", () => {
    const { headline } = describeMidiChange(
      edit({
        note_count: 5,
        pitch_max: 67,
        pitch_range: "C1-G3",
        change_kind: "notes_added",
      }),
    );
    expect(headline).toBe("Added 1 note");
  });

  it("names notes added and removed with the count that changed, not the total", () => {
    expect(describeMidiChange(edit({ note_count: 7, previous_note_count: 4 })).headline).toBe(
      "Added 3 notes",
    );
    expect(describeMidiChange(edit({ note_count: 1, previous_note_count: 4 })).headline).toBe(
      "Removed 3 notes",
    );
  });

  // The one case where the note count genuinely says nothing: same number of
  // notes, but an edit fired, so the content moved underneath.
  it("calls a same-count change a rewrite", () => {
    const { headline, detail } = describeMidiChange(edit());
    expect(headline).toBe("Rewrote the part");
    expect(detail).toContain("4 notes");
  });

  it("prefers a summary the bridge supplied over anything derived here", () => {
    const { headline } = describeMidiChange(edit({ summary: "Doubled the hook" }));
    expect(headline).toBe("Doubled the hook");
  });

  // The exact row that prompted this: one note replaced by one note. The old
  // display read "1 → 1 notes · 1 pitches · F#4 · vel 100 · 20 beats".
  it("makes the real one-note-for-one-note edit readable", () => {
    const { headline } = describeMidiChange(
      edit({
        note_count: 1,
        previous_note_count: 1,
        distinct_pitches: 1,
        pitch_min: 66,
        pitch_max: 66,
        previous_pitch_min: 66,
        previous_pitch_max: 66,
        pitch_range: "F#4",
        previous_pitch_range: "F#4",
      }),
    );
    expect(headline).toBe("Rewrote the part");
  });
});

describe("midiChangeSubject", () => {
  // "Untitled clip" was on nearly every row — most MIDI clips in Live are never
  // named — and it reads as a findable object that does not exist.
  it("never says Untitled clip, naming the track instead", () => {
    expect(midiChangeSubject(edit({ clip_name: null }))).toBe("14-MIDI");
    expect(midiChangeSubject(edit({ clip_name: "   " }))).toBe("14-MIDI");
  });

  it("treats Live's 0 sentinel as no name", () => {
    expect(midiChangeSubject(edit({ clip_name: "0" }))).toBe("14-MIDI");
  });

  it("uses a real clip name when the producer gave one", () => {
    expect(midiChangeSubject(edit({ clip_name: "Hook A" }))).toBe("Hook A");
  });

  it("falls back to a plain label when there is no track either", () => {
    expect(midiChangeSubject(edit({ clip_name: null, track_name: null }))).toBe("MIDI changes");
  });
});
