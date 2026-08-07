// What Recall should be asking of the producer right now, as one decision.
//
// WHY THIS IS A PURE FUNCTION AND NOT COMPONENT STATE: this repo has no
// component test harness (see setupState.test.ts), and this is the logic that
// decides what a brand-new user sees. Same shape as `takeMismatch.ts` — the
// decision lives here, the screen just renders it.
//
// WHY IT ASKS THESE FOUR QUESTIONS: setup is not one boolean. A script can be on
// disk without Ableton knowing about it, and Ableton can be happily connected to
// a script that is older than the one this build ships. Both of those are silent
// failures if nobody is told, and the second one is the dangerous one — a stale
// script keeps working, just captures less than it should.
//
//   connected?   versions match?   installed?   →  state
//   ───────────────────────────────────────────────────────────────────
//      yes            no            (either)    →  restart-required
//      yes           yes / unknown  (either)    →  ready
//      no             —              yes        →  installed-not-wired
//      no             —              no         →  first-run

export type SetupState =
  /** Nothing on disk and nothing talking. Show the introduction and install. */
  | "first-run"
  /** Script is installed but Live isn't talking: not restarted, not selected in
   *  Preferences, or installed into the wrong User Library. */
  | "installed-not-wired"
  /** Capture works, but Ableton is running an older script than this build ships.
   *  The user must restart Live — nothing else can load the new file. */
  | "restart-required"
  /** Connected, and running what we ship. */
  | "ready";

export type SetupFacts = {
  /** Is the script present at the library path we know about? */
  installed: boolean;
  /** Is a heartbeat arriving? This is proof, where `installed` is only evidence. */
  connected: boolean;
  /** Version reported by the script Live actually loaded. Null when unknown. */
  runningVersion: string | null;
  /** Version this app build ships as a bundled resource. Null when unreadable. */
  shippedVersion: string | null;
};

/**
 * Whether Ableton needs restarting to pick up a newer script.
 *
 * Deliberately plain inequality rather than a semver comparison. Auto-repair
 * always writes exactly the version this build ships, so ANY difference means
 * Live is holding a file we have already replaced on disk — the direction of the
 * difference tells us nothing extra and ordering logic would only add ways to be
 * wrong. Explicit beats clever.
 *
 * An unknown version on either side is never treated as stale. We would rather
 * stay quiet than nag someone whose setup is fine: a false "restart Ableton" that
 * survives a restart is the fastest way to teach a user to ignore the message
 * that matters.
 */
export function isScriptStale(
  runningVersion: string | null,
  shippedVersion: string | null,
): boolean {
  if (!runningVersion || !shippedVersion) return false;
  return runningVersion !== shippedVersion;
}

/**
 * Resolve what the app should be asking of the producer.
 *
 * Connection is checked before installation on purpose. A heartbeat is proof the
 * script is loaded and working; a file on disk is only evidence that it should
 * be. If Live is talking to us, telling the user to install something would be
 * both wrong and alarming — whatever the filesystem check believes.
 */
export function resolveSetupState({
  installed,
  connected,
  runningVersion,
  shippedVersion,
}: SetupFacts): SetupState {
  if (connected) {
    return isScriptStale(runningVersion, shippedVersion) ? "restart-required" : "ready";
  }
  return installed ? "installed-not-wired" : "first-run";
}

/**
 * Whether this state needs to reach the producer wherever they are, rather than
 * waiting on the Setup screen for them to happen to visit.
 *
 * `restart-required` qualifies because ignoring it costs captured work silently:
 * the app looks connected, Ableton looks fine, and the only symptom is that
 * something the update added never shows up.
 */
export function needsShellNotice(state: SetupState): boolean {
  return state === "restart-required" || state === "installed-not-wired";
}

export type SetupNotice = {
  /** The ask, in the imperative. What the producer does, not what we detected. */
  title: string;
  /** Why, in one sentence. Names versions when we know them. */
  detail: string;
  /** Label for the escape hatch, or null when the producer needs no screen. */
  action: string | null;
};

/**
 * The message for a state that has to reach the producer, or null when there is
 * nothing to say.
 *
 * Kept out of the component so the words are testable — this is copy that only
 * ever appears when something is already wrong, which is exactly when it is
 * hardest to check by hand.
 *
 * Two rules the wording follows:
 *
 * 1. **Lead with the action, not the diagnosis.** "Restart Ableton to finish
 *    updating" beats "Script version mismatch detected". The producer does not
 *    care which version is running; they care what to do about it.
 * 2. **Never blame the producer.** They did nothing wrong in either state. The
 *    restart case in particular is a consequence of how Live loads control
 *    surfaces, and the app has already done its half silently.
 */
export function setupNotice(
  state: SetupState,
  runningVersion: string | null,
  shippedVersion: string | null,
): SetupNotice | null {
  if (state === "restart-required") {
    // Versions are named only when both are known. `resolveSetupState` cannot
    // reach this state otherwise, but the belt is cheap and the alternative is a
    // sentence with "null" in it.
    const versions =
      runningVersion && shippedVersion
        ? ` Ableton is still running v${runningVersion}; Recall v${shippedVersion} is ready.`
        : "";
    return {
      title: "Restart Ableton to finish updating",
      // "already updated" matters: it tells the producer the app did its part, so
      // the restart is the whole remaining job rather than step one of several.
      detail: `Recall has already updated the control surface.${versions} Live only loads it when it starts up.`,
      action: null,
    };
  }

  if (state === "installed-not-wired") {
    return {
      title: "Ableton isn't connected to Recall",
      detail:
        "The control surface is installed, but Live isn't talking to it yet. Setup walks through the two steps only you can do.",
      action: "Open setup",
    };
  }

  return null;
}
