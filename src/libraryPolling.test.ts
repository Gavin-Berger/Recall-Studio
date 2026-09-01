import { describe, expect, it } from "vitest";
import {
  LIBRARY_POLL_CAPTURING_MS,
  LIBRARY_POLL_IDLE_MS,
  libraryPollInterval,
} from "./libraryPolling";

describe("libraryPollInterval", () => {
  // The reported bug: ~5% CPU with Ableton closed and the remote script not
  // running, because the whole library was re-read once a second regardless.
  it("does not re-read the library every second when nothing is capturing", () => {
    expect(
      libraryPollInterval({ inTrayBackground: false, captureConnected: false }),
    ).toBe(LIBRARY_POLL_IDLE_MS);
  });

  it("keeps the library fresh while a capture is connected", () => {
    expect(
      libraryPollInterval({ inTrayBackground: false, captureConnected: true }),
    ).toBe(LIBRARY_POLL_CAPTURING_MS);
  });

  it("backs off in the tray even mid-capture, because nothing is on screen", () => {
    expect(
      libraryPollInterval({ inTrayBackground: true, captureConnected: true }),
    ).toBe(LIBRARY_POLL_IDLE_MS);
  });

  it("never polls the library faster than the connection status", () => {
    // The 1Hz poll is for connection status only — one row, genuinely live.
    // The library aggregate must always be slower than that.
    for (const inTrayBackground of [true, false]) {
      for (const captureConnected of [true, false]) {
        expect(
          libraryPollInterval({ inTrayBackground, captureConnected }),
        ).toBeGreaterThan(1_000);
      }
    }
  });
});
