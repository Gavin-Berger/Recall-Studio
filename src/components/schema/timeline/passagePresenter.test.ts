import { describe, expect, it } from "vitest";
import type { SessionPassage } from "./sessionAnalysis";
import {
  describePathCleanup,
  presentPassage,
  presentPassageStory,
  presentedControl,
} from "./passagePresenter";
import { emptyProducerWorkCounts, type ProducerWorkCounts } from "./producerWork";

function workCounts(overrides: Partial<ProducerWorkCounts> = {}): ProducerWorkCounts {
  return { ...emptyProducerWorkCounts(), ...overrides };
}

function passage(overrides: Partial<SessionPassage> = {}): SessionPassage {
  return {
    id: "passage-0",
    order: 1,
    pathPosition: "only",
    kind: "sound",
    label: "Sound & samples",
    startMs: 0,
    endMs: 1000,
    gapBeforeMs: null,
    actionCount: 3,
    controlMoveCount: 3,
    midiEditCount: 0,
    clipEventCount: 0,
    structureEventCount: 0,
    markerCount: 0,
    workKinds: ["sound"],
    workCounts: workCounts({ sound: 3 }),
    primaryWorkCounts: workCounts({ sound: 3 }),
    markers: [],
    sourceLabels: [],
    trackNames: ["Lead"],
    primaryTrackCounts: [{ name: "Lead", count: 3 }],
    primaryTrackNames: ["Lead"],
    observedArrangementPositions: [],
    primaryTrackName: "Lead",
    firstAction: null,
    lastAction: null,
    controls: [],
    ...overrides,
  };
}

describe("presented control", () => {
  // "1 Filter Type A" next to "26 control changes" reads as a tally. The device
  // name is what disambiguates it, and it was being dropped at render time.
  it("keeps the device name with the parameter", () => {
    expect(
      presentedControl({
        deviceName: "EQ Eight",
        parameterName: "1 Frequency A",
        trackName: null,
        count: 4,
        beforeDisplay: "400 Hz",
        afterDisplay: "2.1 kHz",
      }),
    ).toEqual({ name: "EQ Eight · 1 Frequency A", trackName: null, outcome: "400 Hz → 2.1 kHz", count: 4 });
  });

  it("states no outcome when the control ended where it started", () => {
    expect(
      presentedControl({
        deviceName: "Mixer",
        parameterName: "Volume",
        trackName: null,
        count: 6,
        beforeDisplay: "0.0 dB",
        afterDisplay: "0.0 dB",
      }).outcome,
    ).toBeNull();
  });

  it("states no outcome when the capture carried no readable value", () => {
    expect(
      presentedControl({
        deviceName: null,
        parameterName: "Macro 1",
        trackName: null,
        count: 1,
        beforeDisplay: null,
        afterDisplay: null,
      }),
    ).toEqual({ name: "Macro 1", trackName: null, outcome: null, count: 1 });
  });
});

describe("presented passage", () => {
  it("leads a chronological trail with the actual control and net result, not its category count", () => {
    const story = presentPassageStory(passage({
      primaryTrackNames: ["Bass Main"],
      controls: [{
        deviceName: "EQ Eight",
        parameterName: "1 Frequency A",
        trackName: "Bass Main",
        count: 21,
        beforeDisplay: "400 Hz",
        afterDisplay: "2.1 kHz",
      }],
      observedArrangementPositions: ["Bar 33 · Beat 2", "Bar 41 · Beat 1"],
      workCounts: workCounts({ sound: 21, arrangement: 2 }),
    }));

    expect(story).toEqual({
      title: "EQ Eight — 1 Frequency A",
      lead: {
        deviceName: "EQ Eight",
        parameterName: "1 Frequency A",
        trackName: "Bass Main",
        outcome: "400 Hz → 2.1 kHz",
      },
      note: null,
      groups: [],
      position: "Bar 33, beat 2 → bar 41, beat 1",
      markers: [],
    });
  });

  it("groups supporting controls by device and track instead of making a delimiter sentence", () => {
    const story = presentPassageStory(passage({
      controls: [
        {
          deviceName: "Serum 2",
          parameterName: "Filter 1 Freq",
          trackName: "14-Serum 2",
          count: 1,
          beforeDisplay: "8 Hz",
          afterDisplay: "4400 Hz",
        },
        {
          deviceName: "EQ Eight",
          parameterName: "1 Frequency A",
          trackName: "14-Serum 2",
          count: 1,
          beforeDisplay: "30.0 Hz",
          afterDisplay: "104 Hz",
        },
        {
          deviceName: "EQ Eight",
          parameterName: "1 Gain A",
          trackName: "14-Serum 2",
          count: 1,
          beforeDisplay: "0.00 dB",
          afterDisplay: "0.87 dB",
        },
      ],
    }));

    expect(story.groups).toEqual([{
      deviceName: "EQ Eight",
      trackName: "14-Serum 2",
      changes: [
        { parameterName: "1 Frequency A", outcome: "30.0 Hz → 104 Hz" },
        { parameterName: "1 Gain A", outcome: "0.00 dB → 0.87 dB" },
      ],
    }]);
  });

  it("uses the actual MIDI or clip cue when a passage has no named control", () => {
    expect(presentPassageStory(passage({
      kind: "writing",
      firstAction: "MIDI edit · Verse hook",
      lastAction: "MIDI edit · Verse hook",
      controls: [],
    }))).toMatchObject({ title: "MIDI edit — Verse hook" });
  });

  it("counts only touched tracks in a mixing headline", () => {
    const presented = presentPassage(
      passage({
        kind: "mixing",
        workKinds: ["mixing"],
        workCounts: workCounts({ mixing: 2 }),
        primaryTrackName: null,
        primaryTrackNames: ["Kick", "Snare"],
        trackNames: ["Kick", "Snare", "Pad", "Bass", "Keys"],
      }),
    );
    expect(presented.title).toBe("Mixed 2 tracks");
  });

  it("reads a single observed position as a point and several as a span", () => {
    expect(presentPassage(passage({ observedArrangementPositions: ["Bar 33 · Beat 2"] })).where).toBe(
      "Bar 33 · Beat 2",
    );
    expect(
      presentPassage(
        passage({ observedArrangementPositions: ["Bar 33 · Beat 2", "Bar 37 · Beat 1", "Bar 41 · Beat 1"] }),
      ).where,
    ).toBe("Bar 33 · Beat 2 → Bar 41 · Beat 1");
  });

  it("has no where when the capture observed no arrangement position", () => {
    expect(presentPassage(passage()).where).toBeNull();
  });

  it("uses the classified producer work instead of guessing from raw counters", () => {
    expect(
      presentPassage(passage({ midiEditCount: 22, controlMoveCount: 6, clipEventCount: 0 })).breakdown,
    ).toBe("3 sound changes");
  });

  it("uses producer work areas in a mixed breakdown", () => {
    expect(
      presentPassage(passage({
        workKinds: ["writing", "sound"],
        workCounts: workCounts({ writing: 22, sound: 6 }),
      })).breakdown,
    ).toBe("22 MIDI edits · 6 sound changes");
  });

  it("singularises a lone action", () => {
    expect(presentPassage(passage({
      controlMoveCount: 1,
      midiEditCount: 0,
      workCounts: workCounts({ sound: 1 }),
    })).breakdown).toBe(
      "1 sound change",
    );
  });
});

describe("path cleanup", () => {
  it("says nothing when nothing was set aside", () => {
    expect(describePathCleanup({ duplicateReportCount: 0, openingStateEventCount: 0 })).toEqual([]);
  });

  it("names what was collapsed and what was excluded", () => {
    expect(describePathCleanup({ duplicateReportCount: 1, openingStateEventCount: 3 })).toEqual([
      "1 repeated report collapsed",
      "3 opening-state observations excluded",
    ]);
  });
});

describe("passage attribution", () => {
  // A step that named one track while listing a control from another told the
  // producer something untrue about their own session, in two ways at once.
  it("names the track only when that track really carried the step", () => {
    const carried = presentPassage(passage({
      primaryTrackNames: ["Bass Main", "Drum Group"],
      primaryTrackCounts: [{ name: "Bass Main", count: 8 }, { name: "Drum Group", count: 1 }],
      primaryTrackName: "Bass Main",
    }));
    expect(carried.title).toBe("Shaped sound and samples on Bass Main");
  });

  it("names both tracks rather than picking a winner from an even split", () => {
    const split = presentPassage(passage({
      primaryTrackNames: ["Bass Main", "Drum Group"],
      primaryTrackCounts: [{ name: "Bass Main", count: 1 }, { name: "Drum Group", count: 1 }],
      primaryTrackName: "Bass Main",
    }));
    expect(split.title).toBe("Shaped sound and samples on Bass Main and Drum Group");
  });

  it("says how many tracks when the work is spread across more than two", () => {
    const spread = presentPassage(passage({
      primaryTrackNames: ["Bass Main", "Drum Group", "Lead"],
      primaryTrackCounts: [
        { name: "Bass Main", count: 2 },
        { name: "Drum Group", count: 2 },
        { name: "Lead", count: 1 },
      ],
      primaryTrackName: "Bass Main",
    }));
    expect(spread.title).toBe("Shaped sound and samples on 3 tracks");
  });

  it("puts the track on a control that does not belong to the headline track", () => {
    const presented = presentPassage(passage({
      primaryTrackNames: ["Bass Main"],
      primaryTrackCounts: [{ name: "Bass Main", count: 3 }],
      primaryTrackName: "Bass Main",
      controls: [
        {
          deviceName: "Glue Compressor",
          parameterName: "Threshold",
          trackName: "Drum Group",
          count: 2,
          beforeDisplay: "−8.2 dB",
          afterDisplay: "−13.7 dB",
        },
        {
          deviceName: "Serum",
          parameterName: "Cutoff",
          trackName: "Bass Main",
          count: 1,
          beforeDisplay: "18%",
          afterDisplay: "42%",
        },
      ],
    }));

    expect(presented.controls[0]?.trackName).toBe("Drum Group");
    // Repeating the headline track on every control underneath is noise.
    expect(presented.controls[1]?.trackName).toBeNull();
  });

  it("addresses every control when the headline names no single track", () => {
    const presented = presentPassage(passage({
      primaryTrackNames: ["Bass Main", "Drum Group"],
      primaryTrackCounts: [{ name: "Bass Main", count: 1 }, { name: "Drum Group", count: 1 }],
      primaryTrackName: "Bass Main",
      controls: [{
        deviceName: "Serum",
        parameterName: "Cutoff",
        trackName: "Bass Main",
        count: 1,
        beforeDisplay: "18%",
        afterDisplay: "42%",
      }],
    }));

    expect(presented.controls[0]?.trackName).toBe("Bass Main");
  });
});
