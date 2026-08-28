import { describe, expect, it } from "vitest";
import type { NoteEdit, ParameterChange, TimelineClipEvent } from "../../types/schema";
import { commitHeadline, CONTENTS_LIMIT, summarizeCommit } from "./commitContents";

const start = 1_720_000_000_000;

function change(over: Partial<ParameterChange> = {}): ParameterChange {
  return {
    id: `p${Math.random()}`,
    event_type: "parameter_changed",
    parameter_id: null,
    track_name: "Drums",
    track_id: "t1",
    device_id: "d1",
    device_name: "Serum",
    parameter_name: "Cutoff",
    before_value: 0,
    after_value: 1,
    before_value_percent: null,
    after_value_percent: null,
    unit: null,
    before_display_value: null,
    after_display_value: null,
    is_quantized: null,
    reason: null,
    automation_start_ms: null,
    automation_start_position: null,
    automation_end_position: null,
    changed_at_ms: start,
    ...over,
  };
}

function note(over: Partial<NoteEdit> = {}): NoteEdit {
  return {
    id: `n${Math.random()}`,
    track_name: "Bass",
    track_id: "t2",
    clip_name: "Verse",
    clip_id: "c1",
    change_kind: null,
    note_count: 8,
    previous_note_count: 4,
    distinct_pitches: 3,
    pitch_min: null,
    pitch_max: null,
    previous_pitch_min: null,
    previous_pitch_max: null,
    pitch_range: null,
    previous_pitch_range: null,
    velocity_mean: null,
    length_beats: null,
    summary: "Added 4 notes",
    changed_at_ms: start,
    ...over,
  };
}

function clip(over: Partial<TimelineClipEvent> = {}): TimelineClipEvent {
  return {
    id: `c${Math.random()}`,
    event_type: "sample_added",
    track_name: "Drums",
    track_id: "t1",
    clip_name: null,
    sample_name: "kick_01.wav",
    changed_at_ms: start,
    ...over,
  };
}

describe("summarizeCommit", () => {
  it("ranks where the work went by how many changes landed there", () => {
    const contents = summarizeCommit(
      [
        change({ track_id: "t1", track_name: "Drums" }),
        change({ track_id: "t1", track_name: "Drums" }),
        change({ track_id: "t1", track_name: "Drums" }),
        change({ track_id: "t2", track_name: "Bass" }),
        change({ track_id: "t2", track_name: "Bass" }),
      ],
      [],
      [],
    );
    expect(contents.tracks.map((entry) => entry.label)).toEqual(["Drums", "Bass"]);
    expect(contents.tracks[0]!.changes).toBe(3);
  });

  it("drops the long tail of things touched exactly once", () => {
    // Real data: one commit moved 52 parameters, 47 of them once. The "top
    // five" was five arbitrary EQ bands all showing 1, which reads as a
    // finding when it is really the shape of a plugin.
    const contents = summarizeCommit(
      [
        change({ track_id: "t1", track_name: "Drums" }),
        change({ track_id: "t1", track_name: "Drums" }),
        change({ track_id: "t2", track_name: "Bass" }),
        change({ track_id: "t3", track_name: "Pad" }),
      ],
      [],
      [],
    );
    expect(contents.tracks.map((entry) => entry.label)).toEqual(["Drums"]);
    // The total still reports all three, so nothing is hidden.
    expect(contents.totals.tracks).toBe(3);
  });

  it("says a group was evenly spread when nothing stands out", () => {
    const contents = summarizeCommit(
      [
        change({ track_id: "t1", track_name: "Drums" }),
        change({ track_id: "t2", track_name: "Bass" }),
      ],
      [],
      [],
    );
    expect(contents.tracks).toEqual([]);
    expect(contents.evenlySpread.tracks).toBe(true);
    expect(contents.totals.tracks).toBe(2);
  });

  it("does not call a group evenly spread when something does stand out", () => {
    const contents = summarizeCommit(
      [
        change({ track_id: "t1", track_name: "Drums" }),
        change({ track_id: "t1", track_name: "Drums" }),
        change({ track_id: "t2", track_name: "Bass" }),
      ],
      [],
      [],
    );
    expect(contents.evenlySpread.tracks).toBe(false);
  });

  it("keeps two identically named tracks apart", () => {
    // Ableton auto-names a track after its first device, so two separate
    // "Serum 2" tracks are routine. Keying on the name merges them, which is
    // the exact bug already found and fixed once in the Contribution Record.
    const contents = summarizeCommit(
      [
        change({ track_id: "t1", track_name: "Serum 2" }),
        change({ track_id: "t2", track_name: "Serum 2" }),
      ],
      [],
      [],
    );
    expect(contents.totals.tracks).toBe(2);
  });

  it("falls back to the name when there is no stable id", () => {
    const contents = summarizeCommit(
      [
        change({ track_id: null, track_name: "Drums" }),
        change({ track_id: null, track_name: "Drums" }),
      ],
      [],
      [],
    );
    expect(contents.totals.tracks).toBe(1);
  });

  it("does not count the mixer as a device", () => {
    // The bridge files fader and pan moves against a pseudo-device called
    // "mixer". Counting it overstates devices touched on nearly every commit.
    const contents = summarizeCommit(
      [
        change({ device_name: "mixer", device_id: null, parameter_name: "Volume" }),
        change({ device_name: "mixer", device_id: null, parameter_name: "Volume" }),
        change({ device_name: "Serum", device_id: "d1" }),
        change({ device_name: "Serum", device_id: "d1" }),
      ],
      [],
      [],
    );
    expect(contents.totals.devices).toBe(1);
    expect(contents.devices[0]!.label).toBe("Serum");
  });

  it("counts the same plugin on two tracks as two devices", () => {
    // Same plugin doing two different jobs. Merging them hides where the work
    // actually went.
    const contents = summarizeCommit(
      [
        change({ track_id: "t1", device_id: "d1", device_name: "Serum" }),
        change({ track_id: "t2", device_id: "d2", device_name: "Serum" }),
      ],
      [],
      [],
    );
    expect(contents.totals.devices).toBe(2);
  });

  it("names the track a device sits on", () => {
    const contents = summarizeCommit(
      [change({ track_name: "Drums" }), change({ track_name: "Drums" })],
      [],
      [],
    );
    expect(contents.devices[0]!.context).toBe("Drums");
  });

  it("caps each group so the panel stays a glance", () => {
    // Two changes each, so every track ranks and the cap is what limits the
    // list rather than the single-touch filter.
    const many = Array.from({ length: CONTENTS_LIMIT + 4 }, (_, index) =>
      change({ track_id: `t${index}`, track_name: `Track ${index}` }),
    ).flatMap((entry) => [entry, { ...entry, id: `${entry.id}b` }]);
    const contents = summarizeCommit(many, [], []);
    expect(contents.tracks).toHaveLength(CONTENTS_LIMIT);
    // The total still reports everything, so the surface can say "+N more".
    expect(contents.totals.tracks).toBe(CONTENTS_LIMIT + 4);
  });

  it("keeps the omitted tail available for an explicit expansion", () => {
    const many = Array.from({ length: CONTENTS_LIMIT + 2 }, (_, index) =>
      change({ track_id: `t${index}`, track_name: `Track ${index}` }),
    ).flatMap((entry) => [entry, { ...entry, id: `${entry.id}b` }]);
    const contents = summarizeCommit(many, [], []);

    expect(contents.tracks).toHaveLength(CONTENTS_LIMIT);
    expect(contents.all.tracks).toHaveLength(CONTENTS_LIMIT + 2);
    expect(contents.all.tracks.map((entry) => entry.label)).toContain("Track 6");
  });

  it("takes note edits newest first and uses the bridge's own summary", () => {
    const contents = summarizeCommit(
      [],
      [
        note({ id: "old", summary: "Older edit", changed_at_ms: start }),
        note({ id: "new", summary: "Newer edit", changed_at_ms: start + 1000 }),
      ],
      [],
    );
    expect(contents.notes.map((row) => row.label)).toEqual(["Newer edit", "Older edit"]);
  });

  it("lists what was brought into the set", () => {
    const contents = summarizeCommit([], [], [clip({ sample_name: "kick_01.wav" })]);
    expect(contents.added[0]!.label).toBe("kick_01.wav");
    expect(contents.added[0]!.context).toBe("Drums");
  });

  it("reports empty when there is nothing to summarise", () => {
    expect(summarizeCommit([], [], []).empty).toBe(true);
  });

  it("is not empty when only notes were edited", () => {
    expect(summarizeCommit([], [note()], []).empty).toBe(false);
  });

  it("does not invent a name for an untitled track", () => {
    const contents = summarizeCommit(
      [change({ track_name: null, track_id: "t9" }), change({ track_name: null, track_id: "t9" })],
      [],
      [],
    );
    expect(contents.tracks[0]!.label).toBe("Untitled track");
  });
});

describe("commitHeadline", () => {
  it("names the track the work concentrated on", () => {
    const contents = summarizeCommit(
      [change({ track_id: "t1", track_name: "Drums" }), change({ track_id: "t1", track_name: "Drums" })],
      [],
      [],
    );
    expect(commitHeadline(contents)).toContain("Worked Drums");
  });

  it("counts the other tracks rather than listing them all", () => {
    const contents = summarizeCommit(
      [
        change({ track_id: "t1", track_name: "Drums" }),
        change({ track_id: "t1", track_name: "Drums" }),
        change({ track_id: "t2", track_name: "Bass" }),
        change({ track_id: "t3", track_name: "Pad" }),
      ],
      [],
      [],
    );
    expect(commitHeadline(contents)).toContain("Drums and 2 other tracks");
  });

  it("uses the singular for exactly one other track", () => {
    const contents = summarizeCommit(
      [
        change({ track_id: "t1", track_name: "Drums" }),
        change({ track_id: "t1", track_name: "Drums" }),
        change({ track_id: "t2", track_name: "Bass" }),
      ],
      [],
      [],
    );
    expect(commitHeadline(contents)).toContain("1 other track");
  });

  it("counts tracks rather than naming one when the work was spread evenly", () => {
    // Naming a track here would imply the work concentrated there. It did not.
    const contents = summarizeCommit(
      [
        change({ track_id: "t1", track_name: "Drums" }),
        change({ track_id: "t2", track_name: "Bass" }),
        change({ track_id: "t3", track_name: "Pad" }),
      ],
      [],
      [],
    );
    expect(commitHeadline(contents)).toContain("Touched 3 tracks");
    expect(commitHeadline(contents)).not.toContain("Worked");
  });

  it("mentions notes and additions when there are any", () => {
    const contents = summarizeCommit([change(), change()], [note()], [clip()]);
    const headline = commitHeadline(contents);
    expect(headline).toContain("1 note edit");
    expect(headline).toContain("1 added");
  });

  it("says plainly when it cannot characterise the work", () => {
    // Honest degradation: a commit Recall recorded but cannot break down must
    // not get a headline that implies it knows more than it does.
    expect(commitHeadline(summarizeCommit([], [], []))).toMatch(/no detail kept/i);
  });
});
