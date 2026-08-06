import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { unpackWaveformEnvelope } from "./audio";

const ZOOM_LEVELS = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024] as const;

export function waveformZoomWindow(progress: number, zoom: number) {
  const clampedProgress = Math.min(1, Math.max(0, progress));
  const visibleFraction = 1 / Math.max(1, zoom);
  const start = Math.min(1 - visibleFraction, Math.max(0, clampedProgress - visibleFraction / 2));
  return { start, visibleFraction };
}

export function waveformSeekFraction(positionInView: number, start: number, visibleFraction: number) {
  return Math.min(1, Math.max(0, start + positionInView * visibleFraction));
}

type Envelope = { min: number[]; max: number[] };

type WaveformProps = {
  peaks: number[];
  waveformMin?: number[];
  waveformMax?: number[];
  waveformData?: string;
  waveformChannels?: string[];
  waveformPoints?: number;
  progress: number;
  onSeek?: (fraction: number) => void;
  animate?: boolean;
  markers?: { id: string; fraction: number; emphasis?: number }[];
  durationSec?: number;
};

function drawEnvelopePath(
  envelope: Envelope,
  channelIndex: number,
  channelCount: number,
  startIndex: number,
  endIndex: number,
  canvasWidth: number,
  canvasHeight: number,
): Path2D {
  const path = new Path2D();
  const channelHeight = canvasHeight / channelCount;
  const center = channelIndex * channelHeight + channelHeight / 2;
  const amplitudeHeight = Math.max(1, channelHeight / 2 - 3);
  const visiblePoints = Math.max(1, endIndex - startIndex);
  const columns = Math.max(1, Math.floor(canvasWidth));
  const samplesPerColumn = visiblePoints / columns;
  const lows = new Float32Array(columns);
  const highs = new Float32Array(columns);

  for (let column = 0; column < columns; column++) {
    const from = Math.min(endIndex - 1, startIndex + Math.floor(column * samplesPerColumn));
    const to = Math.max(from + 1, Math.min(endIndex, startIndex + Math.ceil((column + 1) * samplesPerColumn)));
    let low = 1;
    let high = -1;
    for (let sample = from; sample < to; sample++) {
      if (envelope.min[sample] < low) low = envelope.min[sample];
      if (envelope.max[sample] > high) high = envelope.max[sample];
    }
    lows[column] = low;
    highs[column] = high;
  }

  const y = (sample: number) => center - Math.max(-1, Math.min(1, sample)) * amplitudeHeight;
  path.moveTo(0, y(highs[0]));
  for (let column = 1; column < columns; column++) path.lineTo(column, y(highs[column]));
  for (let column = columns - 1; column >= 0; column--) path.lineTo(column, y(lows[column]));
  path.closePath();
  return path;
}

export function Waveform({ peaks, waveformMin, waveformMax, waveformData, waveformChannels, waveformPoints, progress, onSeek, animate = true, markers = [], durationSec }: WaveformProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const pathCacheRef = useRef<{
    envelopes: Envelope[];
    startIndex: number;
    endIndex: number;
    width: number;
    height: number;
    paths: Path2D[];
  } | null>(null);
  const [canvasSizeRevision, setCanvasSizeRevision] = useState(0);
  const [zoomIndex, setZoomIndex] = useState(0);
  const zoom = ZOOM_LEVELS[zoomIndex];
  const clamped = Math.min(1, Math.max(0, progress));
  const { start: windowStart, visibleFraction } = waveformZoomWindow(clamped, zoom);
  const visibleDuration = durationSec && durationSec > 0 ? durationSec / zoom : null;

  const envelopes = useMemo<Envelope[]>(() => {
    if (waveformChannels?.length && waveformPoints) {
      const unpacked = waveformChannels
        .map((channel) => unpackWaveformEnvelope(channel, waveformPoints))
        .filter((channel) => channel.min.length > 0);
      if (unpacked.length > 0) return unpacked;
    }
    if (waveformData && waveformPoints) {
      const unpacked = unpackWaveformEnvelope(waveformData, waveformPoints);
      if (unpacked.min.length > 0) return [unpacked];
    }
    if (waveformMin?.length && waveformMax?.length && waveformMin.length === waveformMax.length) {
      return [{ min: waveformMin, max: waveformMax }];
    }
    return [{ min: peaks.map((peak) => -peak), max: peaks }];
  }, [peaks, waveformChannels, waveformData, waveformMax, waveformMin, waveformPoints]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const observer = new ResizeObserver(() => {
      pathCacheRef.current = null;
      setCanvasSizeRevision((revision) => revision + 1);
    });
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const draw = () => {
      const cssWidth = Math.max(1, canvas.clientWidth);
      const cssHeight = Math.max(1, canvas.clientHeight);
      const pixelRatio = Math.min(2, window.devicePixelRatio || 1);
      const bitmapWidth = Math.round(cssWidth * pixelRatio);
      const bitmapHeight = Math.round(cssHeight * pixelRatio);
      if (canvas.width !== bitmapWidth || canvas.height !== bitmapHeight) {
        canvas.width = bitmapWidth;
        canvas.height = bitmapHeight;
      }
      const context = canvas.getContext("2d");
      if (!context) return;
      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      context.clearRect(0, 0, cssWidth, cssHeight);

      context.fillStyle = "rgba(94, 147, 255, 0.075)";
      context.fillRect(0, 0, cssWidth, cssHeight);
      context.strokeStyle = "rgba(190, 218, 220, 0.105)";
      context.lineWidth = 1;
      for (let line = 0; line <= 16; line++) {
        const x = Math.round((cssWidth * line) / 16) + 0.5;
        context.beginPath();
        context.moveTo(x, 0);
        context.lineTo(x, cssHeight);
        context.stroke();
      }

      const pointCount = envelopes[0]?.max.length ?? 0;
      if (pointCount === 0) return;
      const startIndex = Math.max(0, Math.floor(windowStart * pointCount));
      const endIndex = Math.max(startIndex + 1, Math.min(pointCount, Math.ceil((windowStart + visibleFraction) * pointCount)));
      const cached = pathCacheRef.current;
      const paths = cached
        && cached.envelopes === envelopes
        && cached.startIndex === startIndex
        && cached.endIndex === endIndex
        && cached.width === cssWidth
        && cached.height === cssHeight
        ? cached.paths
        : envelopes.map((envelope, index) =>
            drawEnvelopePath(envelope, index, envelopes.length, startIndex, endIndex, cssWidth, cssHeight),
          );
      if (paths !== cached?.paths) {
        pathCacheRef.current = { envelopes, startIndex, endIndex, width: cssWidth, height: cssHeight, paths };
      }

      context.fillStyle = "rgba(222, 231, 238, 0.52)";
      for (const path of paths) context.fill(path);
      const playedX = ((clamped - windowStart) / visibleFraction) * cssWidth;
      if (playedX > 0) {
        context.save();
        context.beginPath();
        context.rect(0, 0, Math.min(cssWidth, playedX), cssHeight);
        context.clip();
        context.fillStyle = "#7aa2ff";
        for (const path of paths) context.fill(path);
        context.restore();
      }

      for (let index = 0; index < envelopes.length; index++) {
        const centerY = (index + 0.5) * (cssHeight / envelopes.length) + 0.5;
        context.strokeStyle = "rgba(232, 240, 244, 0.2)";
        context.beginPath();
        context.moveTo(0, centerY);
        context.lineTo(cssWidth, centerY);
        context.stroke();
      }
      if (envelopes.length > 1) {
        context.strokeStyle = "rgba(7, 11, 17, 0.72)";
        context.beginPath();
        context.moveTo(0, cssHeight / 2 + 0.5);
        context.lineTo(cssWidth, cssHeight / 2 + 0.5);
        context.stroke();
      }

      for (const marker of markers) {
        const x = ((marker.fraction - windowStart) / visibleFraction) * cssWidth;
        if (x < 0 || x > cssWidth) continue;
        context.globalAlpha = 0.24 + 0.76 * Math.min(1, Math.max(0, marker.emphasis ?? 1));
        context.strokeStyle = "#7aa2ff";
        context.lineWidth = 1.25;
        context.beginPath();
        context.moveTo(x, 4);
        context.lineTo(x, cssHeight - 4);
        context.stroke();
      }
      context.globalAlpha = 1;
      if (clamped > 0 && clamped < 1 && playedX >= 0 && playedX <= cssWidth) {
        context.strokeStyle = "#f2c879";
        context.lineWidth = 1.5;
        context.beginPath();
        context.moveTo(playedX, 0);
        context.lineTo(playedX, cssHeight);
        context.stroke();
      }
    };

    draw();
  }, [canvasSizeRevision, clamped, envelopes, markers, visibleFraction, windowStart]);

  function seekFromClientX(clientX: number, element: HTMLCanvasElement) {
    if (!onSeek) return;
    const rect = element.getBoundingClientRect();
    onSeek(waveformSeekFraction((clientX - rect.left) / rect.width, windowStart, visibleFraction));
  }

  function handlePointerDown(event: PointerEvent<HTMLCanvasElement>) {
    seekFromClientX(event.clientX, event.currentTarget);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLCanvasElement>) {
    if (!onSeek) return;
    let next: number | null = null;
    if (event.key === "ArrowRight") next = clamped + 0.05;
    else if (event.key === "ArrowLeft") next = clamped - 0.05;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = 1;
    if (next === null) return;
    event.preventDefault();
    onSeek(Math.min(1, Math.max(0, next)));
  }

  return (
    <div className="orgwave-shell">
      <div className="orgwave__zoom" aria-label="Waveform zoom controls">
        <button type="button" aria-label="Zoom waveform out" title="Zoom out" disabled={zoomIndex === 0} onClick={() => setZoomIndex((current) => Math.max(0, current - 1))}>−</button>
        <input type="range" min="0" max={ZOOM_LEVELS.length - 1} step="1" value={zoomIndex} aria-label="Waveform zoom level" onChange={(event) => setZoomIndex(Number(event.target.value))} />
        <button type="button" aria-label="Zoom waveform in" title="Zoom in" disabled={zoomIndex === ZOOM_LEVELS.length - 1} onClick={() => setZoomIndex((current) => Math.min(ZOOM_LEVELS.length - 1, current + 1))}>+</button>
        <span>{zoom}x{visibleDuration == null ? "" : ` · ${Math.max(1, Math.round(visibleDuration))}s`}</span>
      </div>
      <canvas
        ref={canvasRef}
        className={`orgwave ${animate ? "orgwave--develop" : ""}`}
        role={onSeek ? "slider" : "img"}
        aria-label={onSeek ? `Playback position, waveform zoom ${zoom}x` : `Waveform, zoom ${zoom}x`}
        aria-valuemin={onSeek ? 0 : undefined}
        aria-valuemax={onSeek ? 100 : undefined}
        aria-valuenow={onSeek ? Math.round(clamped * 100) : undefined}
        tabIndex={onSeek ? 0 : undefined}
        onPointerDown={onSeek ? handlePointerDown : undefined}
        onKeyDown={onSeek ? handleKeyDown : undefined}
      />
    </div>
  );
}
