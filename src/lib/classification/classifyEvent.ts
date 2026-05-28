import type { RecallTimelineMoment } from "../../types/recall";
import type { EventClass } from "../../types/activities";

// Rules for how each event type participates in the activity system.
// This is the single source of truth — grouping and UI both read from here.
export function classifyEvent(event: RecallTimelineMoment): EventClass {
  switch (event.type) {
    case "heartbeat":
      return "system";

    // Transport is analytics-only: counts playbacks, doesn't clutter the timeline.
    case "transport":
      return "analytics";

    // Tempo changes are interesting analytically but rarely creative milestones.
    case "tempo":
      return "analytics";

    // Track selection gives grouping context but is not a creative action by itself.
    case "track":
      return "context";

    // Groups (track groups) are meaningful structural events.
    case "group":
      return "visible";

    // Device changes (added, removed, renamed) are key creative actions.
    case "device":
      return "visible";

    // Clip events (created, deleted, launched) are key creative actions.
    case "clip":
    case "scene":
      return "visible";

    // Parameter changes are frequent and noisy — folded into analytics/context.
    // The grouping layer surfaces a count, not individual changes.
    case "parameter":
    case "mixer":
      return "context";

    // Arrangement structure changes are meaningful.
    case "arrangement":
      return "visible";

    // Session and file events provide context but aren't timeline moments.
    case "session":
    case "file":
      return "context";

    // Explicit creative moment tag from Max for Live.
    case "creative_moment":
      return "visible";

    default:
      return "context";
  }
}
