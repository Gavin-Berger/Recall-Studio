// Driving the map without a mouse.
//
// DESIGN.md §9 is unconditional: every surface reachable and operable without a
// mouse. The map failed it twice.
//
// Panning was drag-only, so a producer on a keyboard could not move the drawing
// at all. Zoom was better off — the scale slider and Fit are real controls and
// already reachable — but the map itself answered no keys.
//
// And every point was its own tab stop. That is fine at eight sessions and
// hostile once a session opens into its steps: crossing the map to reach the
// list becomes thirty presses. The list solved this months ago with a single
// roving stop; the map never did.
//
// WHY ARROWS MOVE BETWEEN POINTS RATHER THAN SCROLLING THE VIEW
//
// Scrolling by a fixed number of pixels is what a scrollbar does, and it makes
// the producer aim. Moving point to point is what they actually want — the
// interesting places on this map are the stretches of work, not the gaps — and
// bringing each one into view as it is reached pans the map as a side effect.
// One gesture, both jobs.

export type MapKey = {
  key: string;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
};

export type MapAction =
  /** Move to the point at this index and bring it into view. */
  | { kind: "focus"; index: number }
  /** Open whatever is focused. */
  | { kind: "open"; index: number }
  | { kind: "zoomIn" }
  | { kind: "zoomOut" }
  | { kind: "fit" }
  | { kind: "none" };

export type MapNavState = {
  /** Index of the focused point in the map's visual reading order, or -1 for none. */
  index: number;
  /** How many points are drawn. */
  count: number;
};

function clamp(index: number, count: number): number {
  if (count === 0) return -1;
  return Math.max(0, Math.min(count - 1, index));
}

/**
 * Resolve one keypress over the map.
 *
 * Modified keys are left alone: Ctrl and Cmd belong to the browser's own zoom,
 * and Alt reaches the app's surface shortcuts. Swallowing either would trap a
 * producer on this screen.
 */
export function mapKeyAction(event: MapKey, state: MapNavState): MapAction {
  const { index, count } = state;
  if (count === 0) return { kind: "none" };
  if (event.ctrlKey || event.metaKey || event.altKey) return { kind: "none" };

  // Nothing focused yet: the first move lands on a point rather than stepping
  // past one, so the producer never wonders what they skipped.
  const current = index < 0 ? 0 : index;
  const step = index < 0 ? 0 : 1;

  switch (event.key) {
    case "ArrowRight":
    case "ArrowDown":
      return { kind: "focus", index: clamp(current + step, count) };
    case "ArrowLeft":
    case "ArrowUp":
      return { kind: "focus", index: clamp(current - step, count) };
    case "Home":
      // The current work is at the top of the vertical history tree.
      return { kind: "focus", index: 0 };
    case "End":
      // The earliest captured work is at the bottom of the tree.
      return { kind: "focus", index: count - 1 };
    case "Enter":
    case " ":
      return index < 0 ? { kind: "none" } : { kind: "open", index };
    case "+":
    case "=":
      return { kind: "zoomIn" };
    case "-":
    case "_":
      return { kind: "zoomOut" };
    case "0":
      return { kind: "fit" };
    default:
      return { kind: "none" };
  }
}
