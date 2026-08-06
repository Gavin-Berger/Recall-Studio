import { describe, expect, it } from "vitest";
import { alsSetName } from "./sessionFormat";

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
