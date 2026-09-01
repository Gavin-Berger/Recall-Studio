// How often the app re-reads the whole library.
//
// It used to be once a second, awake or not. `list_saved_sessions` is a
// LEFT JOIN over every event grouped by session — measured at ~47ms on a real
// 21,400-event library — and `list_projects` rides along with it. Both ran
// every second with Ableton closed and the bridge down, which is the reported
// ~5% CPU at idle, plus a full re-render of every surface built from the
// returned arrays because they are new objects on every tick.
//
// Nothing about that work is live. The library only changes when a capture is
// writing to it, so the poll follows the capture rather than the clock. The
// connection status keeps its own 1Hz poll: that is one row, it is genuinely
// live, and it is the one thing DESIGN.md allows to pulse.

/** Ableton is connected and events may be landing right now. */
export const LIBRARY_POLL_CAPTURING_MS = 5_000;

/**
 * Nothing is capturing — the bridge is down, or the window is in the tray.
 * The library can still change from another window or a background rotation,
 * so this is a backstop, not a decision that it never changes.
 */
export const LIBRARY_POLL_IDLE_MS = 30_000;

export type LibraryPollInputs = {
  /** The window is hidden in the system tray. */
  inTrayBackground: boolean;
  /** The bridge is connected, so a capture can be writing. */
  captureConnected: boolean;
};

export function libraryPollInterval({
  inTrayBackground,
  captureConnected,
}: LibraryPollInputs): number {
  // Hidden wins over connected: a producer who cannot see the window cannot be
  // reading a stale number off it, so there is nothing to keep fresh.
  if (inTrayBackground) return LIBRARY_POLL_IDLE_MS;
  return captureConnected ? LIBRARY_POLL_CAPTURING_MS : LIBRARY_POLL_IDLE_MS;
}
