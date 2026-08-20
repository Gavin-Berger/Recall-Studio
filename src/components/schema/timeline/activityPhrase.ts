import { area, curveCatmullRom } from "d3-shape";

type PhrasePoint = { x: number; amplitude: number };

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

/**
 * Turn exact gesture positions into a compact, DAW-like activity phrase.
 * Width still represents where work happened; thickness represents how many
 * gestures gathered locally. A single move remains visible as a small lozenge.
 */
export function activityPhrasePath(
  eventXs: number[],
  centerY: number,
  canvasWidth: number,
  maxAmplitude = 9,
): string | null {
  const xs = eventXs.filter(Number.isFinite).sort((a, b) => a - b);
  if (xs.length === 0 || canvasWidth <= 0) return null;

  const first = xs[0];
  const last = xs[xs.length - 1];
  const span = last - first;
  const neighborhood = Math.max(10, span / 7);
  const points: PhrasePoint[] = [];

  if (span < 12) {
    const x = clamp((first + last) / 2, 0, canvasWidth);
    const amplitude = Math.min(maxAmplitude, 3.6 + Math.log2(xs.length + 1) * 1.9);
    points.push(
      { x: clamp(x - 8, 0, canvasWidth), amplitude: 0 },
      { x: clamp(x - 4, 0, canvasWidth), amplitude: amplitude * 0.48 },
      { x, amplitude },
      { x: clamp(x + 4, 0, canvasWidth), amplitude: amplitude * 0.48 },
      { x: clamp(x + 8, 0, canvasWidth), amplitude: 0 },
    );
  } else {
    points.push({ x: clamp(first - 5, 0, canvasWidth), amplitude: 0 });
    xs.forEach((x) => {
      const nearby = xs.filter((candidate) => Math.abs(candidate - x) <= neighborhood).length;
      points.push({
        x: clamp(x, 0, canvasWidth),
        amplitude: Math.min(maxAmplitude, 3.2 + Math.log2(nearby + 1) * 1.65),
      });
    });
    points.push({ x: clamp(last + 5, 0, canvasWidth), amplitude: 0 });
  }

  return area<PhrasePoint>()
    .x((point) => point.x)
    .y0((point) => centerY + point.amplitude)
    .y1((point) => centerY - point.amplitude)
    .curve(curveCatmullRom.alpha(0.55))(points);
}
