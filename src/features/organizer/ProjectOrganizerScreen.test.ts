import { describe, expect, it } from "vitest";
import { commentsCrossed, normalizeProject } from "./ProjectOrganizerScreen";

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
