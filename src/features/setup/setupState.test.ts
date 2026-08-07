/**
 * Tests for the setup state machine.
 *
 * This is the logic that decides what a first-time user sees, and whether an
 * existing user is told to restart Ableton after an update. Both are failures
 * nobody can self-diagnose: a stranded first-run user sees an app that looks
 * fine and captures nothing, and a user on a stale script sees an app that looks
 * fine and captures less than it should.
 *
 * Component rendering stays untested (this project has no component harness) —
 * same convention as takeMismatch.test.ts.
 */

import { describe, expect, it } from "vitest";
import {
  isScriptStale,
  needsShellNotice,
  resolveSetupState,
  setupNotice,
  type SetupFacts,
} from "./setupState";

function facts(overrides: Partial<SetupFacts> = {}): SetupFacts {
  return {
    installed: true,
    connected: true,
    runningVersion: "0.3.0",
    shippedVersion: "0.3.0",
    ...overrides,
  };
}

describe("resolveSetupState", () => {
  it("is first-run on a machine that has never installed the script", () => {
    expect(resolveSetupState(facts({ installed: false, connected: false }))).toBe("first-run");
  });

  it("is installed-not-wired when the script is on disk but Live is silent", () => {
    // The three causes behind this one state: Live wasn't restarted, Recall wasn't
    // selected in Preferences, or it landed in the wrong User Library.
    expect(resolveSetupState(facts({ installed: true, connected: false }))).toBe(
      "installed-not-wired",
    );
  });

  it("is ready when connected and running exactly what this build ships", () => {
    expect(resolveSetupState(facts())).toBe("ready");
  });

  it("is restart-required when Live is running an older script than we ship", () => {
    // The case that prompted this: auto-repair has already written the new file,
    // but Live only scans Remote Scripts at startup, so it is still executing the
    // old one. Capture keeps working, which is exactly why it must be said out loud.
    expect(
      resolveSetupState(facts({ runningVersion: "0.2.0", shippedVersion: "0.3.0" })),
    ).toBe("restart-required");
  });

  it("returns to first-run when the script is deleted from under it", () => {
    // Reinstalling Live wipes Remote Scripts. Deriving state from disk rather than
    // a stored "setup completed" flag is what makes this recoverable instead of
    // stranding the user on a project desk with a dead bridge.
    expect(resolveSetupState(facts({ installed: false, connected: false }))).toBe("first-run");
  });

  it("trusts a live connection over the filesystem check", () => {
    // A heartbeat is proof the script is loaded; a file on disk is only evidence
    // it should be. If the user relocated their User Library, our path check goes
    // stale while capture keeps working — telling them to install would be wrong.
    expect(resolveSetupState(facts({ installed: false, connected: true }))).toBe("ready");
  });

  it("does not claim staleness when the running version is unknown", () => {
    // Better to stay quiet than to nag someone whose setup is fine. A false
    // "restart Ableton" that survives a restart teaches users to ignore the real one.
    expect(resolveSetupState(facts({ runningVersion: null }))).toBe("ready");
  });

  it("does not claim staleness when the shipped version is unreadable", () => {
    expect(resolveSetupState(facts({ shippedVersion: null }))).toBe("ready");
  });
});

describe("isScriptStale", () => {
  it("is false for identical versions", () => {
    expect(isScriptStale("0.3.0", "0.3.0")).toBe(false);
  });

  it("is true for any difference, in either direction", () => {
    // Auto-repair always writes exactly what we ship, so a difference means Live
    // is holding a file already replaced on disk. Direction carries no extra
    // information, and ordering logic would only add ways to be wrong.
    expect(isScriptStale("0.2.0", "0.3.0")).toBe(true);
    expect(isScriptStale("0.4.0", "0.3.0")).toBe(true);
  });

  it("is false when either side is unknown", () => {
    expect(isScriptStale(null, "0.3.0")).toBe(false);
    expect(isScriptStale("0.3.0", null)).toBe(false);
    expect(isScriptStale(null, null)).toBe(false);
  });

  it("is false for empty strings rather than treating them as a mismatch", () => {
    // An empty version is a parse failure, not evidence of staleness.
    expect(isScriptStale("", "0.3.0")).toBe(false);
    expect(isScriptStale("0.3.0", "")).toBe(false);
  });
});

describe("needsShellNotice", () => {
  it("surfaces restart-required app-wide", () => {
    // The whole point: the user has no reason to visit the Setup screen after
    // setup is done, so a notice that only lives there would never be seen.
    expect(needsShellNotice("restart-required")).toBe(true);
  });

  it("surfaces installed-not-wired app-wide", () => {
    expect(needsShellNotice("installed-not-wired")).toBe(true);
  });

  it("stays quiet when everything is working", () => {
    expect(needsShellNotice("ready")).toBe(false);
  });

  it("stays quiet on first-run, which owns the whole screen already", () => {
    expect(needsShellNotice("first-run")).toBe(false);
  });
});

describe("setupNotice", () => {
  it("asks for the restart and names both versions", () => {
    const notice = setupNotice("restart-required", "0.2.0", "0.3.0");
    expect(notice?.detail).toContain("v0.2.0");
    expect(notice?.detail).toContain("v0.3.0");
  });

  it("leads with the action rather than the diagnosis", () => {
    // The producer does not care which version is running; they care what to do.
    // "Script version mismatch detected" is a log line, not a message.
    expect(setupNotice("restart-required", "0.2.0", "0.3.0")?.title).toBe(
      "Restart Ableton to finish updating",
    );
  });

  it("says the update is already done so the restart is the whole job", () => {
    // Without this the producer reasonably wonders whether they also need to
    // press something first.
    expect(setupNotice("restart-required", "0.2.0", "0.3.0")?.detail).toContain(
      "already updated",
    );
  });

  it("offers no button for the restart, because there is nothing to click", () => {
    // The one step Recall cannot take. A button here would imply otherwise.
    expect(setupNotice("restart-required", "0.2.0", "0.3.0")?.action).toBeNull();
  });

  it("degrades to a versionless sentence rather than printing null", () => {
    const notice = setupNotice("restart-required", null, null);
    expect(notice?.detail).not.toContain("null");
    expect(notice?.detail).not.toContain("undefined");
    expect(notice?.title).toBe("Restart Ableton to finish updating");
  });

  it("routes to setup when Live isn't wired up", () => {
    const notice = setupNotice("installed-not-wired", null, "0.3.0");
    expect(notice?.action).toBe("Open setup");
    expect(notice?.title).toContain("isn't connected");
  });

  it("says nothing when everything is working", () => {
    expect(setupNotice("ready", "0.3.0", "0.3.0")).toBeNull();
  });

  it("says nothing on first-run, which has a whole screen of its own", () => {
    expect(setupNotice("first-run", null, "0.3.0")).toBeNull();
  });

  it("never blames the producer in either message", () => {
    // Both states are consequences of how Live loads control surfaces. The
    // producer did nothing wrong, and copy that implies otherwise on a screen
    // they see only when something is broken is the wrong thing to read.
    for (const state of ["restart-required", "installed-not-wired"] as const) {
      const notice = setupNotice(state, "0.2.0", "0.3.0");
      const words = `${notice?.title} ${notice?.detail}`.toLowerCase();
      for (const blame of ["you didn't", "you failed", "you forgot", "you must", "error"]) {
        expect(words).not.toContain(blame);
      }
    }
  });
});
