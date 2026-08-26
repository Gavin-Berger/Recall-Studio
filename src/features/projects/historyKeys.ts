// Moving through the history from the keyboard.
//
// A commit is a stretch of work now, so a busy month is a long list and the
// mouse stops being the fast way through it. Two vocabularies are supported at
// once because both are already muscle memory for this list's audience: the
// arrow keys everyone expects, and j/k from less and git log.
//
// The interesting one is `p`. Walking to a commit's PARENT is the move a graph
// specifically wants and a flat list cannot offer — it follows the lineage
// rather than the page, so on a fork it jumps across lanes instead of stepping
// into whatever happens to be printed underneath. That is the difference
// between a list you scroll and a history you traverse.
//
// Pure and index-based: the semantics are decided here and tested without a
// DOM, and the screen only has to move a selection.

export type HistoryAction =
  | { kind: "select"; index: number }
  | { kind: "openReport"; index: number }
  | { kind: "openWorkspace"; index: number }
  | { kind: "none" };

export type HistoryKey = {
  key: string;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
};

/** What the list needs to know to resolve a key into a move. */
export type HistoryNavState = {
  /** Index of the selected row, or -1 when nothing is selected. */
  index: number;
  /** Total rows. */
  count: number;
  /** Row index of each row's parent, indexed by row. */
  parentRows: (number | null)[];
};

function clamp(index: number, count: number): number {
  if (count === 0) return -1;
  return Math.max(0, Math.min(count - 1, index));
}

/**
 * Resolve one keypress against the list.
 *
 * Modified keys are deliberately ignored (except the documented Shift+Enter):
 * Ctrl/Cmd and Alt belong to the browser and to the app's own surface
 * shortcuts, and swallowing them here would break Alt+3 while the list has
 * focus.
 */
export function historyKeyAction(
  event: HistoryKey,
  state: HistoryNavState,
): HistoryAction {
  const { index, count, parentRows } = state;
  if (count === 0) return { kind: "none" };
  if (event.ctrlKey || event.metaKey || event.altKey) return { kind: "none" };

  const current = index < 0 ? 0 : index;

  switch (event.key) {
    case "ArrowDown":
    case "j":
      return { kind: "select", index: clamp(current + (index < 0 ? 0 : 1), count) };
    case "ArrowUp":
    case "k":
      return { kind: "select", index: clamp(current - (index < 0 ? 0 : 1), count) };
    case "Home":
      return { kind: "select", index: 0 };
    case "End":
      return { kind: "select", index: count - 1 };
    case "p": {
      // Follow the lineage, not the page. On a fork this crosses lanes, which
      // is the whole point — the commit printed below a branch tip usually
      // belongs to a different line entirely.
      const parent = parentRows[current];
      return parent === null || parent === undefined
        ? { kind: "none" }
        : { kind: "select", index: parent };
    }
    case "Enter":
      return event.shiftKey
        ? { kind: "openWorkspace", index: current }
        : { kind: "openReport", index: current };
    default:
      return { kind: "none" };
  }
}

/** Keys this list consumes, for the screen's preventDefault decision. */
export function handlesKey(event: HistoryKey, state: HistoryNavState): boolean {
  return historyKeyAction(event, state).kind !== "none";
}
