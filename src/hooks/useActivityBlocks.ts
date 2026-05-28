import { useMemo } from "react";
import type { RecallTimelineMoment } from "../types/recall";
import type { ActivityBlock } from "../types/activities";
import { groupIntoActivities } from "../lib/grouping/groupActivities";

export function useActivityBlocks(events: RecallTimelineMoment[]): ActivityBlock[] {
  return useMemo(() => groupIntoActivities(events), [events]);
}
