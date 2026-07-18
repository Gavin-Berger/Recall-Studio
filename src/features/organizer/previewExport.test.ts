import { describe, expect, it } from "vitest";
import {
  buildReleaseCommentsText,
  buildReleasePreviewHtml,
  portableCoverAsset,
  portablePreviewFolderName,
  portableTrackFileName,
  selectReleasePreviewTracks,
} from "./previewExport";

describe("release preview track selection", () => {
  it("uses only explicitly selected final versions and keeps album order", () => {
    const tracks = selectReleasePreviewTracks({
      tracks: [
        {
          id: "one",
          title: "Opening",
          finalBounceId: "one-b",
          bounces: [
            { id: "one-a", fileName: "a.wav", durationSec: 10 },
            { id: "one-b", fileName: "b.wav", durationSec: 11 },
          ],
        },
        {
          id: "two",
          title: "Unfinished",
          finalBounceId: null,
          bounces: [{ id: "two-a", fileName: "two.wav", durationSec: 20 }],
        },
        {
          id: "three",
          title: "",
          finalBounceId: "three-a",
          bounces: [{ id: "three-a", fileName: "three.wav", durationSec: 30 }],
        },
      ],
    });

    expect(tracks.map((track) => track.bounce.id)).toEqual(["one-b", "three-a"]);
    expect(tracks.map((track) => track.title)).toEqual(["Opening", "Track 3"]);
  });
});

describe("portable preview naming", () => {
  it("creates ordered, path-safe filenames while retaining audio extensions", () => {
    expect(portableTrackFileName(0, "Back / To Me", "master.WAV")).toBe("01-back-to-me.wav");
    expect(portableTrackFileName(11, "../../Final", "mix.flac")).toBe("12-final.flac");
    expect(portablePreviewFolderName("Perseus EP")).toBe("perseus-ep-preview");
  });
});

describe("portable preview page", () => {
  it("escapes producer text and references only packaged audio", () => {
    const html = buildReleasePreviewHtml({
      name: "<Perseus>",
      artist: `A "Producer"`,
      releaseDate: "2026-07-17",
      notes: "<script>alert('no')</script>",
      releaseType: "ep",
      coverImageDataUrl: null,
    }, [{
      title: "Opening & Closing",
      durationSec: 202,
      audioFileName: "01-opening-closing.wav",
    }]);

    expect(html).toContain("&lt;Perseus&gt;");
    expect(html).toContain("A &quot;Producer&quot;");
    expect(html).toContain("&lt;script&gt;alert(&#39;no&#39;)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert('no')</script>");
    expect(html).toContain('src="audio/01-opening-closing.wav"');
    expect(html).toContain("3:22");
  });

  it("references the packaged cover instead of embedding it in the page", () => {
    const html = buildReleasePreviewHtml({
      name: "Perseus",
      artist: "Recall",
      releaseDate: "",
      notes: "",
      releaseType: "album",
      coverImageDataUrl: "data:image/webp;base64,Zm9v",
    }, [], "cover.webp");

    expect(html).toContain('src="cover.webp"');
    expect(html).not.toContain("data:image/webp");
  });
});

describe("portable release assets", () => {
  it("decodes supported cover data URLs into a top-level image asset", () => {
    expect(portableCoverAsset("data:image/png;base64,Zm9v")).toEqual({
      fileName: "cover.png",
      bytes: [102, 111, 111],
    });
    expect(portableCoverAsset("https://example.com/cover.png")).toBeNull();
  });

  it("builds album-ordered track notes and sorted final-mix timestamp comments", () => {
    const comments = buildReleaseCommentsText({
      name: "Perseus",
      artist: "Berg",
      releaseDate: "2026-07-17",
      notes: "Sequence notes",
    }, [
      {
        trackId: "one",
        title: "Opening",
        comment: "Bring the vocal forward.",
        bounce: {
          id: "final",
          fileName: "opening-final.wav",
          durationSec: 200,
          timedComments: [
            { timeSec: 90, text: "Drop lands here." },
            { timeSec: 12, text: "Trim the intro." },
          ],
        },
      },
      {
        trackId: "two",
        title: "Closer",
        comment: "",
        bounce: {
          id: "closer-final",
          fileName: "closer.wav",
          durationSec: 180,
        },
      },
    ]);

    expect(comments).toContain("RELEASE NOTES\r\nSequence notes");
    expect(comments).toContain("01 - Opening");
    expect(comments).toContain("Track notes: Bring the vocal forward.");
    expect(comments.indexOf("[0:12] Trim the intro.")).toBeLessThan(
      comments.indexOf("[1:30] Drop lands here."),
    );
    expect(comments).toContain("02 - Closer");
    expect(comments).toContain("Timestamped comments: None");
  });
});
