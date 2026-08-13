import { describe, expect, it } from "vitest";
import {
  isRunningScriptStale,
  versionRows,
  versionVerdict,
  type VersionFacts,
} from "./versionStatus";

// A fully healthy setup. Each test bends exactly one fact away from this so the
// thing under test is always the single difference.
const HEALTHY: VersionFacts = {
  appVersion: "0.1.0",
  shippedScriptVersion: "0.5.0",
  runningScriptVersion: "0.5.0",
  connected: true,
  installPath: "M:\\Ableton Library\\User Library\\Remote Scripts\\Recall",
  capturePortConflict: false,
};

describe("versionVerdict", () => {
  it("confirms the running version when everything agrees", () => {
    const verdict = versionVerdict(HEALTHY);
    expect(verdict.tone).toBe("ready");
    expect(verdict.title).toContain("0.5.0");
  });

  // The failure this panel exists for: you rebuild, the app writes the new script
  // to disk, and Live keeps running the old one because it only reads that folder
  // at startup. Everything looks fine; the new capture fields just never arrive.
  it("asks for an Ableton restart when Live is running an older script", () => {
    const verdict = versionVerdict({ ...HEALTHY, runningScriptVersion: "0.4.1" });
    expect(verdict.tone).toBe("action");
    expect(verdict.title).toBe("Restart Ableton");
    // Both numbers must appear — "restart Ableton" without them is unactionable.
    expect(verdict.detail).toContain("0.4.1");
    expect(verdict.detail).toContain("0.5.0");
  });

  it("names the wiring problem when the script is installed but silent", () => {
    const verdict = versionVerdict({
      ...HEALTHY,
      connected: false,
      runningScriptVersion: null,
    });
    expect(verdict.tone).toBe("action");
    expect(verdict.detail).toContain("Control Surface");
  });

  it("reports a first run when nothing is installed", () => {
    const verdict = versionVerdict({
      ...HEALTHY,
      connected: false,
      runningScriptVersion: null,
      installPath: null,
    });
    expect(verdict.tone).toBe("waiting");
    expect(verdict.title).toContain("No script installed");
  });

  // Claiming "you're running the right version" when the script never told us
  // which one it is would be inventing proof we do not have.
  it("does not claim a version match when the script reported no version", () => {
    const verdict = versionVerdict({ ...HEALTHY, runningScriptVersion: null });
    expect(verdict.tone).toBe("ready");
    expect(verdict.detail).toContain("can't confirm");
  });

  // A second instance is disconnected BY DEFINITION, so every other verdict
  // would fire and every one of them would name the wrong cause. Reinstalling
  // the script or restarting Live cannot free a socket another process holds.
  it("names the port conflict ahead of every other verdict", () => {
    const verdict = versionVerdict({
      ...HEALTHY,
      connected: false,
      runningScriptVersion: null,
      capturePortConflict: true,
    });
    expect(verdict.tone).toBe("action");
    expect(verdict.title).toContain("capture port");
    expect(verdict.detail).toContain("system tray");
  });

  // Even a fully healthy-looking instance must say so if it is the deaf one.
  it("reports the conflict even when everything else looks fine", () => {
    expect(versionVerdict({ ...HEALTHY, capturePortConflict: true }).title).toContain(
      "capture port",
    );
  });
});

describe("isRunningScriptStale", () => {
  it("is true only when a live connection reports a different version", () => {
    expect(isRunningScriptStale({ ...HEALTHY, runningScriptVersion: "0.4.1" })).toBe(true);
    expect(isRunningScriptStale(HEALTHY)).toBe(false);
  });

  // Ableton simply being closed must never render as a mismatch, or a perfectly
  // current install looks broken every time the producer isn't working.
  it("is false when nothing is connected, however stale the last reading looked", () => {
    expect(
      isRunningScriptStale({
        ...HEALTHY,
        connected: false,
        runningScriptVersion: "0.4.1",
      }),
    ).toBe(false);
  });

  it("is false when either version is unknown", () => {
    expect(isRunningScriptStale({ ...HEALTHY, runningScriptVersion: null })).toBe(false);
    expect(isRunningScriptStale({ ...HEALTHY, shippedScriptVersion: null })).toBe(false);
  });
});

describe("versionRows", () => {
  it("walks the script from the repo to Live in order", () => {
    expect(versionRows(HEALTHY).map((row) => row.label)).toEqual([
      "Recall",
      "Script shipped",
      "Script running",
      "Installed at",
    ]);
  });

  it("marks the running row when it is the one that disagrees", () => {
    const rows = versionRows({ ...HEALTHY, runningScriptVersion: "0.4.1" });
    const running = rows.find((row) => row.label === "Script running");
    expect(running?.mismatch).toBe(true);
    expect(running?.value).toBe("0.4.1");
  });

  // A disconnected Ableton has no reading to show. Rendering the last known
  // version would present a stale number as current fact.
  it("shows no running version when nothing is connected", () => {
    const rows = versionRows({ ...HEALTHY, connected: false });
    expect(rows.find((row) => row.label === "Script running")?.value).toBeNull();
  });
});
