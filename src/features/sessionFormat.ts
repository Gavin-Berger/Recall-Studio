// Shared session date/duration formatting for the project + recap screens, so
// the two surfaces render takes identically.

import type { SavedSessionMetadata } from "../types";

export function formatSessionDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function formatSessionDuration(session: SavedSessionMetadata): string {
  if (session.ended_at_ms === null) return "In progress";
  const ms = Math.max(0, session.ended_at_ms - session.started_at_ms);
  const totalMinutes = Math.floor(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return "< 1m";
}

// The name of the set Ableton has open, or null when there isn't one.
//
// Treats "0" as absent, not as a name. Ableton's LOM returns the number 0 for an
// unsaved set's name and file_path, and anything that stringifies it produces a
// truthy "0" that reads as a real name everywhere downstream. The bridge and the
// Rust storage layer both strip it now, but databases written before that fix
// still hold it — a stale row should render as "unsaved", not as a set called 0.
//
// Every surface that displays the set name goes through here so they cannot
// disagree about what counts as named.
export function abletonSetName(session: SavedSessionMetadata | null): string | null {
  const raw = session?.project_name?.trim() ?? "";
  return raw === "" || raw === "0" ? null : raw;
}

/** What the connection chip should say about the set Ableton has open. */
export type BridgeSetLabel = {
  text: string;
  /**
   * Guidance shown on hover, never inline. An unsaved set is a normal state, not
   * an error — rendering the instruction at status weight made a routine
   * condition read like something had gone wrong, and grew a one-line header
   * chip into a two-line block. Status stays status; the "why" is there when
   * someone goes looking for it.
   */
  hint: string | null;
};

// Why an unsaved set gets its own state instead of falling back to a bare
// "connected": a set with no name is not a cosmetic gap. Takes anchor to the
// .als file on disk, so until the producer saves, there is nothing stable to
// attach this session's work to. The chip is the only place they'd notice, so
// it has to say what to do rather than shrug.
//
// Distinguishing "unsaved" from "not scanned yet" matters — telling someone to
// save a set they already saved is worse than saying nothing. A session that
// exists means the bridge scanned and reported no path; no session at all means
// we simply have not heard yet.
export function describeBridgeSet(
  connected: boolean,
  session: SavedSessionMetadata | null,
): BridgeSetLabel {
  if (!connected) {
    return { text: "Listening for Ableton…", hint: null };
  }

  const name = abletonSetName(session);

  if (name) {
    return { text: `Ableton: ${name}`, hint: null };
  }

  if (session) {
    return {
      // No keyboard shortcut in the copy: this ships on Mac too, and Ctrl+S is
      // wrong there.
      text: "Ableton · unsaved set",
      hint: "Save the set so Recall can track versions of it.",
    };
  }

  return { text: "Ableton connected", hint: null };
}
