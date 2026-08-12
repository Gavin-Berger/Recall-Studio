import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { Layer, Line, Rect, Stage, Text } from "react-konva";
import type { TrackObj } from "../../../types/schema";
import type { Activity } from "./types";
import { buildTicks } from "./graph";

type Lane = { track: TrackObj; items: Activity[] };

type Bounds = {
  start: number;
  span: number;
  sessionStart: number;
};

type Region = { start: number; end: number; count: number; hasNote: boolean };
type SittingBreak = { atMs: number };

const RULER_HEIGHT = 24;
const LANE_HEIGHT = 46;
const TICK_LABEL_WIDTH = 58;

function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = () => setWidth(Math.floor(element.clientWidth));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return { ref, width };
}

function regionsFor(items: Activity[], bounds: Bounds): Region[] {
  const sorted = [...items].sort((a, b) => a.atMs - b.atMs);
  if (sorted.length === 0) return [];

  // A close cluster of decisions reads as one clip-like stretch of work. The
  // threshold scales with the visible take so a 20-second idea and a two-hour
  // session both stay legible rather than fragmenting into tiny rectangles.
  const joinGap = Math.max(3_000, bounds.span / 18);
  const regions: Region[] = [];
  let current: Region | null = null;

  for (const item of sorted) {
    if (!current || item.atMs - current.end > joinGap) {
      current = {
        start: item.atMs,
        end: item.atMs,
        count: 1,
        hasNote: item.kind !== "move",
      };
      regions.push(current);
    } else {
      current.end = item.atMs;
      current.count += 1;
      current.hasNote ||= item.kind !== "move";
    }
  }

  return regions;
}

function fraction(atMs: number, bounds: Bounds) {
  return Math.max(0, Math.min(1, (atMs - bounds.start) / bounds.span));
}

export function ArrangementCanvas({
  lanes,
  bounds,
  selectedTrackId,
  onSelectTrack,
  recording,
  sittingBreaks,
}: {
  lanes: Lane[];
  bounds: Bounds;
  selectedTrackId: string | null;
  onSelectTrack: (trackId: string) => void;
  recording: boolean;
  sittingBreaks: SittingBreak[];
}) {
  const { ref, width } = useWidth();
  const height = RULER_HEIGHT + lanes.length * LANE_HEIGHT;
  const ticks = useMemo(() => buildTicks(bounds), [bounds]);
  const regions = useMemo(
    () => new Map(lanes.map((lane) => [lane.track.id, regionsFor(lane.items, bounds)])),
    [lanes, bounds],
  );

  const selectAt = (clientY: number) => {
    const host = ref.current;
    if (!host) return;
    const y = clientY - host.getBoundingClientRect().top - RULER_HEIGHT;
    const index = Math.floor(y / LANE_HEIGHT);
    if (index >= 0 && index < lanes.length) onSelectTrack(lanes[index].track.id);
  };

  return (
    <div className="tl-arrangement-canvas" ref={ref}>
      {width > 0 && (
        <Stage
          width={width}
          height={height}
          onMouseDown={(event) => selectAt(event.evt.clientY)}
        >
          <Layer listening={false}>
            <Rect width={width} height={height} fill="#0b0e16" />
            <Rect width={width} height={RULER_HEIGHT} fill="#0e121c" />
            <Line points={[0, RULER_HEIGHT - 0.5, width, RULER_HEIGHT - 0.5]} stroke="#272e3d" strokeWidth={1} />
            {ticks.map((tick, index) => {
              const x = Math.round(tick.pct / 100 * width) + 0.5;
              return (
                <Text
                  key={`${tick.label}-${index}`}
                  x={Math.max(3, Math.min(width - TICK_LABEL_WIDTH, x + 5))}
                  y={6}
                  text={tick.label}
                  fill="#8992a8"
                  fontFamily="IBM Plex Mono, monospace"
                  fontSize={11}
                />
              );
            })}

            {/* A take can rotate while the same song stays open. Keep the work
                on one map, then mark the real pause as a visible page break. */}
            {sittingBreaks.map((sitting) => {
              const x = Math.round(fraction(sitting.atMs, bounds) * width) + 0.5;
              return (
                <Fragment key={sitting.atMs}>
                  <Rect
                    x={Math.max(0, x - 4)}
                    y={RULER_HEIGHT}
                    width={8}
                    height={height - RULER_HEIGHT}
                    fill="#0a0d15"
                    opacity={0.92}
                  />
                  <Line
                    points={[x, RULER_HEIGHT, x, height]}
                    stroke="#8d9ab1"
                    strokeWidth={1}
                    dash={[3, 4]}
                    opacity={0.72}
                  />
                </Fragment>
              );
            })}

            {lanes.map((lane, index) => {
              const y = RULER_HEIGHT + index * LANE_HEIGHT;
              const selected = lane.track.id === selectedTrackId;
              const laneRegions = regions.get(lane.track.id) ?? [];
              return (
                <Fragment key={lane.track.id}>
                  {selected && <Rect x={0} y={y} width={width} height={LANE_HEIGHT} fill="#18243a" />}
                  <Line points={[0, y + LANE_HEIGHT - 0.5, width, y + LANE_HEIGHT - 0.5]} stroke="#171d2a" strokeWidth={1} />
                  {laneRegions.map((region, regionIndex) => {
                    const x = fraction(region.start, bounds) * width;
                    const end = fraction(region.end, bounds) * width;
                    const regionWidth = Math.max(32, end - x + Math.min(width * 0.012, 30));
                    const clipY = y + 8;
                    const clipHeight = LANE_HEIGHT - 16;
                    const density = Math.min(1, region.count / 8);
                    return (
                      <Fragment key={`${lane.track.id}-${regionIndex}`}>
                        <Rect
                          x={x}
                          y={clipY}
                          width={Math.min(regionWidth, width - x)}
                          height={clipHeight}
                          cornerRadius={3}
                          stroke={region.hasNote ? "#b8c5e2" : "#8391ab"}
                          strokeWidth={1}
                          fillLinearGradientStartPoint={{ x: 0, y: 0 }}
                          fillLinearGradientEndPoint={{ x: 0, y: clipHeight }}
                          fillLinearGradientColorStops={[0, "#596982", 0.55, "#3e4a60", 1, "#2f394b"]}
                          opacity={(selected ? 0.82 : 0.62) + density * 0.18}
                        />
                        <Line
                          points={[x + 2, clipY + 1.5, Math.min(x + regionWidth - 2, width - 2), clipY + 1.5]}
                          stroke="#c5cfdf"
                          strokeWidth={1}
                          opacity={0.55 + density * 0.35}
                        />
                      </Fragment>
                    );
                  })}
                </Fragment>
              );
            })}
            {recording && (
              <Line
                points={[width - 1, RULER_HEIGHT, width - 1, height]}
                stroke="#78a0ff"
                strokeWidth={2}
                shadowColor="#78a0ff"
                shadowBlur={7}
              />
            )}
          </Layer>
        </Stage>
      )}
    </div>
  );
}

export default ArrangementCanvas;
