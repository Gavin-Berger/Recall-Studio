// What Recall is actually running, as one answer.
//
// WHY THIS EXISTS: three versions have to agree before a capture change reaches
// the timeline — the app you built, the script that build carries, and the script
// Ableton actually loaded. Any two of them can match while the third is stale, and
// every one of those mismatches fails silently. The worst is a rebuilt app whose
// script Live never picked up: everything looks connected, capture keeps working,
// and the only symptom is that the thing you just added never appears.
//
// WHY IT IS A PURE FUNCTION: same reason as setupState.ts — this repo has no
// component test harness, and this is diagnostic copy that only ever gets read
// when something is already confusing. Testing it by hand means reproducing the
// broken state first.

import { resolveSetupState } from "./setupState";

export type VersionFacts = {
  /** The Recall build itself, from @tauri-apps/api/app getVersion(). */
  appVersion: string | null;
  /** The script version this build carries as a bundled resource. */
  shippedScriptVersion: string | null;
  /** The script version Ableton reports over the heartbeat. Proof, not evidence. */
  runningScriptVersion: string | null;
  /** Is a heartbeat arriving right now? */
  connected: boolean;
  /** Where auto-repair installs the script, or null if we have no library yet. */
  installPath: string | null;
  /**
   * Another Recall process holds the capture port, so THIS one receives nothing.
   *
   * Outranks every other verdict below. Closing Recall hides it to the tray
   * rather than quitting, so instances pile up — four at once during one
   * session — and only the first owns the socket. The others read the same
   * database, so their timelines show captures another process is writing while
   * they themselves are deaf. Without this, the panel says "Ableton isn't
   * talking to Recall" and sends the producer to inspect a bridge that is
   * working perfectly.
   */
  capturePortConflict: boolean;
};

export type VersionVerdict = {
  /** Drives styling only. `action` means the producer has something to do. */
  tone: "ready" | "action" | "waiting";
  /** The answer, in one line. */
  title: string;
  /** Why, naming versions whenever we know them. */
  detail: string;
};

/** A single row in the panel. `unknown` renders differently from a real value. */
export type VersionRow = {
  label: string;
  value: string | null;
  /** Set when this row is the one that disagrees, so the UI can mark it. */
  mismatch?: boolean;
};

/**
 * The one-line answer to "am I running what I just built?".
 *
 * Delegates the state decision to `resolveSetupState` rather than re-deriving it.
 * A second staleness rule here could disagree with the shell notice, and two
 * different answers to the same question on the same screen is worse than either
 * answer alone.
 */
export function versionVerdict(facts: VersionFacts): VersionVerdict {
  // Checked before anything else, and deliberately before the connection state:
  // a second instance IS disconnected, so every check below would fire and every
  // one of them would name the wrong cause. Reinstalling the script or
  // restarting Live cannot fix a socket another process is holding.
  if (facts.capturePortConflict) {
    return {
      tone: "action",
      title: "Another Recall has the capture port",
      detail:
        "A second Recall is already running and receiving from Ableton. This window shows the same history but records nothing itself. Quit the other one from the system tray — closing its window only hides it.",
    };
  }

  const state = resolveSetupState({
    installed: Boolean(facts.installPath),
    connected: facts.connected,
    runningVersion: facts.runningScriptVersion,
    shippedVersion: facts.shippedScriptVersion,
  });

  switch (state) {
    case "restart-required":
      return {
        tone: "action",
        title: "Restart Ableton",
        detail: `Ableton is still running script v${facts.runningScriptVersion}. This build ships v${facts.shippedScriptVersion} and has already written it to disk — Live only reads that folder when it starts.`,
      };
    case "installed-not-wired":
      return {
        tone: "action",
        title: "Ableton isn't talking to Recall",
        detail:
          "The script is installed but no heartbeat is arriving. Either Live hasn't been restarted since it was installed, or Recall isn't selected under Preferences → Link/Tempo/MIDI → Control Surface.",
      };
    case "first-run":
      return {
        tone: "waiting",
        title: "No script installed yet",
        detail: "Recall hasn't installed its control surface into an Ableton User Library yet.",
      };
    case "ready":
      // Connected and not stale. Say which version is proven, and stay honest
      // when the script never reported one rather than implying we checked.
      return {
        tone: "ready",
        title: facts.runningScriptVersion
          ? `Running script v${facts.runningScriptVersion}`
          : "Connected",
        detail: facts.runningScriptVersion
          ? "Ableton is loaded with the script this build ships. Captures land with everything this version knows how to send."
          : "Ableton is connected but hasn't reported which script version it loaded, so Recall can't confirm it matches this build.",
      };
  }
}

/**
 * The panel's rows, in the order that makes a mismatch obvious: what you built,
 * what it carries, what Ableton actually loaded. Reading top to bottom walks the
 * script from the repo to Live, so the row where it stops being current is the
 * step that didn't happen.
 */
export function versionRows(facts: VersionFacts): VersionRow[] {
  const stale = isRunningScriptStale(facts);

  return [
    { label: "Recall", value: facts.appVersion },
    { label: "Script shipped", value: facts.shippedScriptVersion },
    {
      label: "Script running",
      value: facts.connected ? facts.runningScriptVersion : null,
      mismatch: stale,
    },
    { label: "Installed at", value: facts.installPath },
  ];
}

/**
 * Whether the script Ableton loaded differs from the one this build ships.
 *
 * Separate from `isScriptStale` in setupState.ts only by requiring a live
 * connection: an absent heartbeat means we have no reading at all, and "no
 * reading" must never render as "mismatch" — that would flag a perfectly current
 * install as broken every time Ableton simply isn't open.
 */
export function isRunningScriptStale(facts: VersionFacts): boolean {
  if (!facts.connected) return false;
  if (!facts.runningScriptVersion || !facts.shippedScriptVersion) return false;
  return facts.runningScriptVersion !== facts.shippedScriptVersion;
}
