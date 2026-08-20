export type MemoryCable = {
  path: string;
  anchorX: number;
  anchorY: number;
};

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

// Route a patch-cable curve from a gesture jack to the nearest card edge. The
// control points leave and enter perpendicular to that edge, so the connection
// reads as plugged in rather than as an arbitrary annotation arrow.
export function memoryCable(
  sourceX: number,
  sourceY: number,
  cardX: number,
  cardY: number,
  cardWidth: number,
  cardHeight: number,
): MemoryCable {
  const right = cardX + cardWidth;
  const bottom = cardY + cardHeight;
  const inset = 12;

  if (sourceX < cardX) {
    const anchorY = clamp(sourceY, cardY + inset, bottom - inset);
    const span = cardX - sourceX;
    return {
      anchorX: cardX,
      anchorY,
      path: `M ${sourceX} ${sourceY} C ${sourceX + span * 0.42} ${sourceY}, ${cardX - span * 0.32} ${anchorY}, ${cardX} ${anchorY}`,
    };
  }
  if (sourceX > right) {
    const anchorY = clamp(sourceY, cardY + inset, bottom - inset);
    const span = sourceX - right;
    return {
      anchorX: right,
      anchorY,
      path: `M ${sourceX} ${sourceY} C ${sourceX - span * 0.42} ${sourceY}, ${right + span * 0.32} ${anchorY}, ${right} ${anchorY}`,
    };
  }

  const anchorX = clamp(sourceX, cardX + inset, right - inset);
  if (sourceY < cardY) {
    const span = cardY - sourceY;
    return {
      anchorX,
      anchorY: cardY,
      path: `M ${sourceX} ${sourceY} C ${sourceX} ${sourceY + span * 0.42}, ${anchorX} ${cardY - span * 0.32}, ${anchorX} ${cardY}`,
    };
  }

  const span = sourceY - bottom;
  return {
    anchorX,
    anchorY: bottom,
    path: `M ${sourceX} ${sourceY} C ${sourceX} ${sourceY - span * 0.42}, ${anchorX} ${bottom + span * 0.32}, ${anchorX} ${bottom}`,
  };
}
