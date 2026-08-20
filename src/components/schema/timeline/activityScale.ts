export type ActivityTick = {
  fraction: number;
  atMs: number;
};

export type ActivityScale = {
  slots: number[];
  fraction: (atMs: number) => number;
  ticks: ActivityTick[];
};

const DEFAULT_MERGE_WINDOW_MS = 1_500;
const DEFAULT_MAX_TICKS = 5;

function nearestSlot(slots: number[], atMs: number, mergeWindowMs: number): number {
  if (slots.length <= 1) return 0;
  let low = 0;
  let high = slots.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (slots[middle] < atMs) low = middle + 1;
    else high = middle;
  }
  if (low === 0) return 0;
  // Preserve the slot an event was grouped into even when it sits near that
  // burst's trailing edge and happens to be numerically closer to the next one.
  if (atMs - slots[low - 1] <= mergeWindowMs) return low - 1;
  return Math.abs(slots[low] - atMs) < Math.abs(slots[low - 1] - atMs) ? low : low - 1;
}

// The detail map is a memory of work, not a wall-clock calendar. Every slot is
// created by recorded activity; hours where nothing happened create no width.
// Events arriving in the same short callback burst share one column.
export function buildActivityScale(
  timestamps: number[],
  mergeWindowMs = DEFAULT_MERGE_WINDOW_MS,
  maxTicks = DEFAULT_MAX_TICKS,
): ActivityScale {
  const sorted = timestamps.filter(Number.isFinite).sort((a, b) => a - b);
  const slots: number[] = [];
  for (const timestamp of sorted) {
    const previous = slots[slots.length - 1];
    if (previous === undefined || timestamp - previous > mergeWindowMs) slots.push(timestamp);
  }

  const fraction = (atMs: number) => {
    if (slots.length === 0) return 0.5;
    const index = nearestSlot(slots, atMs, mergeWindowMs);
    // Centre every event inside its own equal-width activity cell. No leading
    // or trailing wall-clock padding can grow larger than half a cell.
    return (index + 0.5) / slots.length;
  };

  const tickCount = Math.min(Math.max(1, maxTicks), slots.length);
  const tickIndices = new Set<number>();
  for (let index = 0; index < tickCount; index += 1) {
    tickIndices.add(tickCount === 1 ? 0 : Math.round(index * (slots.length - 1) / (tickCount - 1)));
  }
  const ticks = [...tickIndices].sort((a, b) => a - b).map((index) => ({
    fraction: (index + 0.5) / slots.length,
    atMs: slots[index],
  }));

  return { slots, fraction, ticks };
}
