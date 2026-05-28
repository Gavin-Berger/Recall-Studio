import type { RecallTimelineMoment } from "../../types/recall";
import type { ActivityBlock } from "../../types/activities";
import { classifyEvent } from "../classification/classifyEvent";
import {
  buildAnalytics,
  buildSummary,
  deriveCategory,
  deriveKeyActions,
  derivePrimaryTrack,
  deriveTitle,
} from "./deriveBlockMeta";

// Inactivity gap: silence longer than this splits into a new block.
const INACTIVITY_GAP_MS = 3 * 60 * 1000;

// Minimum visible events in a block before a track switch causes a split.
// Prevents micro-blocks from a single stray event on another track.
const TRACK_SWITCH_MIN_VISIBLE = 2;

export function groupIntoActivities(events: RecallTimelineMoment[]): ActivityBlock[] {
  if (events.length === 0) return [];

  const sorted = [...events].sort((a, b) => a.timestamp - b.timestamp);
  const rawBlocks: RecallTimelineMoment[][] = [];
  let current: RecallTimelineMoment[] = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const event = sorted[i];
    const prev = current[current.length - 1];
    const gap = event.timestamp - prev.timestamp;

    // Gap-based split.
    if (gap > INACTIVITY_GAP_MS) {
      rawBlocks.push(current);
      current = [event];
      continue;
    }

    // Track-switch split: only when we see a definitive creative action on a
    // different track and the current block already has substance.
    if (shouldSplitOnTrackSwitch(event, current)) {
      rawBlocks.push(current);
      current = [event];
      continue;
    }

    current.push(event);
  }

  rawBlocks.push(current);

  return rawBlocks.map((blockEvents, index) => buildBlock(blockEvents, index));
}

function shouldSplitOnTrackSwitch(
  event: RecallTimelineMoment,
  current: RecallTimelineMoment[],
): boolean {
  // Only split on device or clip events — definitive actions on a specific track.
  if (event.type !== "device" && event.type !== "clip") return false;
  if (!event.trackName) return false;

  const currentPrimary = derivePrimaryTrack(current);
  if (!currentPrimary || event.trackName === currentPrimary) return false;

  const visibleCount = current.filter((e) => classifyEvent(e) === "visible").length;
  return visibleCount >= TRACK_SWITCH_MIN_VISIBLE;
}

function buildBlock(events: RecallTimelineMoment[], index: number): ActivityBlock {
  const sorted = [...events].sort((a, b) => a.timestamp - b.timestamp);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];

  const visibleEvents = sorted.filter((e) => classifyEvent(e) === "visible");
  const contextEvents = sorted.filter((e) => classifyEvent(e) === "context");

  const primaryTrack = derivePrimaryTrack(sorted);
  const analytics = buildAnalytics(sorted);
  const category = deriveCategory(sorted, primaryTrack);
  const title = deriveTitle(category, primaryTrack);
  const keyActions = deriveKeyActions(visibleEvents, analytics);
  const summary = buildSummary(last.timestamp - first.timestamp, primaryTrack, analytics);

  return {
    id: `block-${index}-${first.timestamp}`,
    startTime: first.timestamp,
    endTime: last.timestamp,
    startTimecode: first.sessionTimecode,
    endTimecode: last.sessionTimecode,
    durationMs: last.timestamp - first.timestamp,
    primaryTrack,
    category,
    title,
    summary,
    keyActions,
    visibleEvents,
    contextEvents,
    analytics,
  };
}
