import { describe, expect, it } from "vitest";
import {
  commentsCrossed,
  masteringFlags,
  normalizeProject,
  producerDynamicRangeDb,
  projectForStorage,
  spotifyNormalPreview,
} from "./ProjectOrganizerScreen";

const bounceA = {
  id: "bounce-a",
  fileName: "track-a.wav",
  sourcePath: "C:\\mixes\\track-a.wav",
  fileSizeBytes: 100,
  durationSec: 180,
  sampleRate: 48000,
  channelCount: 2,
  peaks: [0.1, 0.5],
  integratedLufs: -10,
  dynamicRangeLu: 7,
  peakDb: -1,
  added_at_ms: 1,
  timedComments: [{ id: "comment-1", timeSec: 90, text: "Bring the vocal forward.", created_at_ms: 2 }],
};

const bounceB = { ...bounceA, id: "bounce-b", fileName: "track-b.wav" };

describe("organizer project migration", () => {
  it("moves a legacy single bounce into version A without losing playback data", () => {
    const project = normalizeProject({
      id: "project-1",
      name: "Album",
      tracks: [{ id: "track-1", title: "Song", alsFile: null, bounce: bounceA }],
    });

    expect(project?.tracks[0].bounces).toEqual([{ ...bounceA, volume: 1 }]);
    expect(project?.tracks[0].finalBounceId).toBe("bounce-a");
    expect(project?.tracks[0].bounce?.sourcePath).toBe("C:\\mixes\\track-a.wav");
    expect(project?.tracks[0].bounce?.timedComments?.[0].timeSec).toBe(90);
    expect(project?.tracks[0].comment).toBe("");
    expect(project?.tracks[0].bounce?.volume).toBe(1);
  });

  it("preserves multiple versions and the selected final", () => {
    const project = normalizeProject({
      id: "project-2",
      name: "EP",
      tracks: [{
        id: "track-2",
        title: "Song",
        comment: "B has the better vocal.",
        alsFile: null,
        bounces: [{ ...bounceA, volume: 0.64 }, bounceB],
        finalBounceId: "bounce-b",
      }],
    });

    expect(project?.tracks[0].bounces).toHaveLength(2);
    expect(project?.tracks[0].finalBounceId).toBe("bounce-b");
    expect(project?.tracks[0].bounce?.id).toBe("bounce-b");
    expect(project?.tracks[0].comment).toBe("B has the better vocal.");
    expect(project?.tracks[0].bounces[0].volume).toBe(0.64);
    expect(project?.tracks[0].bounces[1].volume).toBe(1);
  });

  it("dehydrates compatibility projections and can omit persisted waveform payloads", () => {
    const project = normalizeProject({
      id: "project-native",
      name: "Native",
      tracks: [{
        id: "track-native",
        title: "Song",
        alsFile: null,
        bounces: [{ ...bounceA, waveformChannels: ["left", "right"], waveformPoints: 2 }],
        finalBounceId: "bounce-a",
      }],
    })!;

    const stored = projectForStorage(project, () => false);

    expect(stored.tracks[0].bounces[0].waveformChannels).toBeUndefined();
    expect(stored.tracks[0].bounces[0].timedComments).toHaveLength(1);
    expect("bounce" in stored.tracks[0]).toBe(false);
    expect("exports" in stored).toBe(false);
    expect("alsFiles" in stored).toBe(false);
  });
});

describe("timed comment playback cues", () => {
  const comments = [
    { id: "a", timeSec: 90, text: "First", created_at_ms: 1 },
    { id: "b", timeSec: 102, text: "Second", created_at_ms: 2 },
  ];

  it("returns only comments crossed by forward playback", () => {
    expect(commentsCrossed(comments, 89.95, 90.04).map((comment) => comment.id)).toEqual(["a"]);
    expect(commentsCrossed(comments, 90.1, 101)).toEqual([]);
  });

  it("does not fire comments when the playhead moves backward", () => {
    expect(commentsCrossed(comments, 110, 80)).toEqual([]);
  });
});

describe("producer dynamic range", () => {
  it("reports peak-to-loudness ratio in dB", () => {
    expect(producerDynamicRangeDb(-6.9, 0.2)).toBeCloseTo(7.1, 6);
    expect(producerDynamicRangeDb(-10, -1)).toBe(9);
  });

  it("does not invent a value when either measurement is unavailable", () => {
    expect(producerDynamicRangeDb(null, -1)).toBeNull();
    expect(producerDynamicRangeDb(-10, Number.NEGATIVE_INFINITY)).toBeNull();
  });
});

describe("mastering interpretation", () => {
  it("calculates Spotify Normal attenuation without altering source measurements", () => {
    expect(spotifyNormalPreview(-6.9, 0.2)).toEqual({
      requestedGainDb: -7.1,
      appliedGainDb: -7.1,
      estimatedLufs: -14,
      estimatedTruePeakDb: -6.8999999999999995,
      headroomLimited: false,
    });
  });

  it("limits positive preview gain to one dB of true-peak headroom", () => {
    const preview = spotifyNormalPreview(-20, -3)!;
    expect(preview.requestedGainDb).toBe(6);
    expect(preview.appliedGainDb).toBe(2);
    expect(preview.estimatedLufs).toBe(-18);
    expect(preview.estimatedTruePeakDb).toBe(-1);
    expect(preview.headroomLimited).toBe(true);
  });

  it("flags measured conditions without manufacturing missing measurements", () => {
    const flags = masteringFlags({
      ...bounceA,
      peakKind: "true",
      peakDb: 0.2,
      clippedSampleCount: 12,
      stereoCorrelation: -0.1,
    });
    expect(flags.map((flag) => flag.text)).toEqual(expect.arrayContaining([
      "True peak exceeds 0 dBTP",
      "12 decoded samples at or above full scale",
      "Negative stereo correlation may cancel in mono",
    ]));
    expect(masteringFlags({
      ...bounceA,
      integratedLufs: null,
      peakDb: -2,
      peakKind: "true",
    })).toHaveLength(0);
  });
});
