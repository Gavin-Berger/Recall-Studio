import { useId, useMemo, type KeyboardEvent, type PointerEvent } from "react";

// A mix-review waveform: the stored envelope drawn as mirrored bars, with the
// played portion brightened behind a clip rect and a transport playhead. The
// bars are drawn once and referenced twice with <use>, so playback only moves
// the clip width and the playhead line — not 480 DOM nodes per frame.
//
// Motion (DESIGN.md §6): the waveform is a finished bounce, so it *develops*
// once on mount and holds. The playhead moves only while audio is genuinely
// playing, which is the one honest "now" here.

const VIEW_H = 100;
const MIN_BAR = 0.03; // a hairline so silence still reads as a bar, not a gap

type WaveformProps = {
  peaks: number[];
  progress: number; // 0..1
  onSeek?: (fraction: number) => void;
  animate?: boolean;
};

export function Waveform({ peaks, progress, onSeek, animate = true }: WaveformProps) {
  const uid = useId().replace(/:/g, "");
  const barsId = `orgwave-bars-${uid}`;
  const clipId = `orgwave-clip-${uid}`;
  const width = Math.max(1, peaks.length);
  const clamped = Math.min(1, Math.max(0, progress));

  const bars = useMemo(() => {
    return peaks.map((amp, i) => {
      const h = Math.max(MIN_BAR, amp) * VIEW_H;
      const y = (VIEW_H - h) / 2;
      return <rect key={i} x={i + 0.12} y={y} width={0.76} height={h} rx={0.3} />;
    });
  }, [peaks]);

  function seekFromClientX(clientX: number, el: SVGSVGElement) {
    if (!onSeek) return;
    const rect = el.getBoundingClientRect();
    const fraction = (clientX - rect.left) / rect.width;
    onSeek(Math.min(1, Math.max(0, fraction)));
  }

  function handlePointerDown(event: PointerEvent<SVGSVGElement>) {
    seekFromClientX(event.clientX, event.currentTarget);
  }

  function handleKeyDown(event: KeyboardEvent<SVGSVGElement>) {
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
    <svg
      className={`orgwave ${animate ? "orgwave--develop" : ""}`}
      viewBox={`0 0 ${width} ${VIEW_H}`}
      preserveAspectRatio="none"
      role={onSeek ? "slider" : "img"}
      aria-label={onSeek ? "Playback position" : "Waveform"}
      aria-valuemin={onSeek ? 0 : undefined}
      aria-valuemax={onSeek ? 100 : undefined}
      aria-valuenow={onSeek ? Math.round(clamped * 100) : undefined}
      tabIndex={onSeek ? 0 : undefined}
      onPointerDown={onSeek ? handlePointerDown : undefined}
      onKeyDown={onSeek ? handleKeyDown : undefined}
    >
      <defs>
        <g id={barsId}>{bars}</g>
        <clipPath id={clipId}>
          <rect x={0} y={0} width={width * clamped} height={VIEW_H} />
        </clipPath>
      </defs>
      <use href={`#${barsId}`} className="orgwave__base" />
      <use href={`#${barsId}`} className="orgwave__played" clipPath={`url(#${clipId})`} />
      {clamped > 0 && clamped < 1 && (
        <line
          className="orgwave__head"
          x1={width * clamped}
          x2={width * clamped}
          y1={0}
          y2={VIEW_H}
          vectorEffect="non-scaling-stroke"
        />
      )}
    </svg>
  );
}
