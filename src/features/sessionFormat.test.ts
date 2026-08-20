import { describe, expect, it } from "vitest";
import { alsSetName, preferredProjectTitle } from "./sessionFormat";

describe("alsSetName", () => {
  it("takes the filename from a path and drops the .als extension", () => {
    expect(alsSetName("C:\\Users\\g\\Music\\believeme_140_Am.als")).toBe("believeme_140_Am");
    expect(alsSetName("/home/g/music/first kiss.als")).toBe("first kiss");
  });

  it("handles a bare filename and is case-insensitive on the extension", () => {
    expect(alsSetName("track.ALS")).toBe("track");
  });

  it("returns null for missing paths and the '0' unsaved sentinel", () => {
    expect(alsSetName(null)).toBeNull();
    expect(alsSetName(undefined)).toBeNull();
    expect(alsSetName("")).toBeNull();
    expect(alsSetName("0.als")).toBeNull();
  });
});

describe("preferredProjectTitle", () => {
  it("prefers the saved Ableton filename over Recall's shorter desk label", () => {
    expect(preferredProjectTitle(
      {
        als_path: "C:\\Music\\Recall_Test\\Recall_Test.als",
        project_path: "C:\\Music\\Recall_Test\\Recall_Test.als",
        project_name: "Recall",
        display_name: "Recall",
      },
      {
        display_name: "Recall",
        ableton_name: "Recall",
        ableton_path: null,
      },
    )).toBe("Recall_Test");
  });

  it("falls back to the editable project label for an unsaved set", () => {
    expect(preferredProjectTitle(
      {
        als_path: null,
        project_path: null,
        project_name: null,
        display_name: null,
      },
      {
        display_name: "New idea",
        ableton_name: null,
        ableton_path: null,
      },
    )).toBe("New idea");
  });
});
