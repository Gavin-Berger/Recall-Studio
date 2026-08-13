import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { Group, Layer, Line, Rect, Stage, Text } from "react-konva";
import type { TrackObj } from "../../../types/schema";
import type { Activity } from "./types";
import { describeActivity, formatClock } from "./format";
import { buildTicks, pct, type TimelineBounds } from "./graph";

type Lane = { track: TrackObj; items: Activity[] };

type Region = { start: number; end: number; count: number; hasNote: boolean; events: Activity[] };
type GestureMemory = {
  activity: Activity;
  trackName: string;
  x: number;
  y: number;
};

const RULER_HEIGHT = 24;
const LANE_HEIGHT = 46;
const TICK_LABEL_WIDTH = 58;
const MEMORY_CARD_HEIGHT = 76;

function gestureKind(activity: Activity): string {
  if (activity.kind === "note") return "Producer note";
  if (activity.kind === "noteEdit") return "MIDI edit";
  if (activity.kind === "clip") return "Clip memory";
  return activity.automation ? "Automation write" : activity.deviceName === "Mixer" ? "Mixer gesture" : "Parameter gesture";
}

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

function regionsFor(items: Activity[], bounds: TimelineBounds): Region[] {
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
        events: [item],
      };
      regions.push(current);
    } else {
      current.end = item.atMs;
      current.count += 1;
      current.hasNote ||= item.kind !== "move";
      current.events.push(item);
    }
  }

  return regions;
}

function fraction(atMs: number, bounds: TimelineBounds) {
  return pct(atMs, bounds) / 100;
}

export function ArrangementCanvas({
  lanes,
  bounds,
  selectedTrackId,
  onSelectTrack,
  recording,
}: {
  lanes: Lane[];
  bounds: TimelineBounds;
  selectedTrackId: string | null;
  onSelectTrack: (trackId: string) => void;
  recording: boolean;
}) {
  const { ref, width } = useWidth();
  const [hoveredGesture, setHoveredGesture] = useState<GestureMemory | null>(null);
  const [pinnedGesture, setPinnedGesture] = useState<GestureMemory | null>(null);
  const height = RULER_HEIGHT + lanes.length * LANE_HEIGHT;
  const ticks = useMemo(() => buildTicks(bounds), [bounds]);
  const regions = useMemo(
    () => new Map(lanes.map((lane) => [lane.track.id, regionsFor(lane.items, bounds)])),
    [lanes, bounds],
  );
  const visibleGesture = pinnedGesture ?? hoveredGesture;

  useEffect(() => {
    setHoveredGesture(null);
    setPinnedGesture(null);
  }, [bounds.start, bounds.span, lanes]);

  const gestureAtPointer = (
    events: Activity[],
    trackName: string,
    pointerX: number,
    laneY: number,
  ): GestureMemory => {
    const activity = events.reduce((nearest, candidate) =>
      Math.abs(fraction(candidate.atMs, bounds) * width - pointerX) <
      Math.abs(fraction(nearest.atMs, bounds) * width - pointerX)
        ? candidate
        : nearest,
    );
    return {
      activity,
      trackName,
      x: fraction(activity.atMs, bounds) * width,
      y: laneY + LANE_HEIGHT / 2,
    };
  };

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
          <Layer>
            <Rect width={width} height={height} fill="#080b12" />
            <Rect width={width} height={RULER_HEIGHT} fill="#111725" />
            <Line points={[0, RULER_HEIGHT - 0.5, width, RULER_HEIGHT - 0.5]} stroke="#30394c" strokeWidth={1} />
            {ticks.map((tick, index) => {
              const x = Math.round(tick.pct / 100 * width) + 0.5;
              return (
                <Fragment key={`${tick.label}-${index}`}>
                  <Line
                    points={[x, RULER_HEIGHT, x, height]}
                    stroke="#2a3243"
                    strokeWidth={1}
                    opacity={index === 0 ? 0 : 0.72}
                  />
                  <Line points={[x, RULER_HEIGHT - 6, x, RULER_HEIGHT]} stroke="#536078" strokeWidth={1} />
                  <Text
                    x={Math.max(3, Math.min(width - TICK_LABEL_WIDTH, x + 5))}
                    y={5}
                    text={tick.label}
                    fill="#a4aec4"
                    fontFamily="IBM Plex Mono, monospace"
                    fontSize={10}
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
                  <Rect
                    x={0}
                    y={y}
                    width={width}
                    height={LANE_HEIGHT}
                    fill={selected ? "#16243c" : index % 2 === 0 ? "#0b0f18" : "#090d15"}
                  />
                  {selected && <Rect x={0} y={y} width={3} height={LANE_HEIGHT} fill="#88a5ff" shadowColor="#88a5ff" shadowBlur={8} />}
                  <Line points={[0, y + LANE_HEIGHT - 0.5, width, y + LANE_HEIGHT - 0.5]} stroke="#1d2432" strokeWidth={1} />
                  {laneRegions.map((region, regionIndex) => {
                    const x = fraction(region.start, bounds) * width;
                    const end = fraction(region.end, bounds) * width;
                    const regionWidth = Math.max(32, end - x + Math.min(width * 0.012, 30));
                    const paintedWidth = Math.min(regionWidth, width - x);
                    const clipY = y + 8;
                    const clipHeight = LANE_HEIGHT - 16;
                    const density = Math.min(1, region.count / 8);
                    return (
                      <Fragment key={`${lane.track.id}-${regionIndex}`}>
                        <Rect
                          x={x}
                          y={clipY}
                          width={paintedWidth}
                          height={clipHeight}
                          cornerRadius={2}
                          stroke={region.hasNote ? "#bac8ff" : selected ? "#9fb4ee" : "#7787a8"}
                          strokeWidth={1}
                          fillLinearGradientStartPoint={{ x: 0, y: 0 }}
                          fillLinearGradientEndPoint={{ x: 0, y: clipHeight }}
                          fillLinearGradientColorStops={region.hasNote
                            ? [0, "#53699a", 0.55, "#3d4f79", 1, "#293753"]
                            : [0, "#52627e", 0.55, "#394760", 1, "#273247"]}
                          opacity={(selected ? 0.86 : 0.68) + density * 0.12}
                          onMouseEnter={(event) => {
                            const stage = event.target.getStage();
                            const pointer = stage?.getPointerPosition();
                            if (!pointer) return;
                            stage!.container().style.cursor = "crosshair";
                            setHoveredGesture(gestureAtPointer(region.events, lane.track.name ?? "Untitled track", pointer.x, y));
                          }}
                          onMouseMove={(event) => {
                            const pointer = event.target.getStage()?.getPointerPosition();
                            if (!pointer) return;
                            setHoveredGesture(gestureAtPointer(region.events, lane.track.name ?? "Untitled track", pointer.x, y));
                          }}
                          onMouseLeave={(event) => {
                            const stage = event.target.getStage();
                            if (stage) stage.container().style.cursor = "pointer";
                            setHoveredGesture(null);
                          }}
                          onClick={(event) => {
                            const pointer = event.target.getStage()?.getPointerPosition();
                            if (!pointer) return;
                            const gesture = gestureAtPointer(region.events, lane.track.name ?? "Untitled track", pointer.x, y);
                            setPinnedGesture((current) => current?.activity.id === gesture.activity.id ? null : gesture);
                          }}
                        />
                        <Line
                          points={[x + 2, clipY + 1.5, Math.min(x + paintedWidth - 2, width - 2), clipY + 1.5]}
                          stroke={region.hasNote ? "#d2d9ff" : "#c5cfdf"}
                          strokeWidth={1}
                          opacity={0.55 + density * 0.35}
                          listening={false}
                        />
                        {region.events.slice(-24).map((item, eventIndex) => {
                          const eventX = Math.max(x + 3, Math.min(x + paintedWidth - 3, fraction(item.atMs, bounds) * width));
                          return (
                            <Line
                              key={`${item.id}-${eventIndex}`}
                              points={[eventX, clipY + 5, eventX, clipY + clipHeight - 4]}
                              stroke={item.kind === "note" ? "#f2c66d" : item.kind === "noteEdit" ? "#c2adff" : "#d7dfef"}
                              strokeWidth={item.kind === "move" ? 1 : 2}
                              opacity={0.32 + Math.min(0.5, density * 0.55)}
                              listening={false}
                            />
                          );
                        })}
                        {paintedWidth >= 74 && (
                          <Text
                            x={x + 7}
                            y={clipY + 8}
                            width={paintedWidth - 12}
                            text={`${region.count} ${region.count === 1 ? "gesture" : "gestures"}`}
                            fill="#e0e6f4"
                            fontFamily="IBM Plex Mono, monospace"
                            fontSize={9}
                            ellipsis
                            listening={false}
                          />
                        )}
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
            {visibleGesture && (() => {
              const cardWidth = Math.min(330, Math.max(230, width * 0.32));
              const cardX = Math.max(7, Math.min(width - cardWidth - 7, visibleGesture.x + 13));
              const aboveY = visibleGesture.y - MEMORY_CARD_HEIGHT - 10;
              const cardY = aboveY >= RULER_HEIGHT + 3
                ? aboveY
                : Math.min(height - MEMORY_CARD_HEIGHT - 5, visibleGesture.y + 12);
              const pinned = pinnedGesture?.activity.id === visibleGesture.activity.id;
              return (
                <Group listening={false}>
                  <Line
                    points={[visibleGesture.x, RULER_HEIGHT, visibleGesture.x, height]}
                    stroke={pinned ? "#f2c66d" : "#9fb4ff"}
                    strokeWidth={1}
                    dash={[3, 4]}
                    opacity={0.52}
                  />
                  <Rect
                    x={visibleGesture.x - 2}
                    y={visibleGesture.y - 2}
                    width={5}
                    height={5}
                    fill={pinned ? "#f2c66d" : "#b6c6ff"}
                    shadowColor={pinned ? "#f2c66d" : "#88a5ff"}
                    shadowBlur={8}
                  />
                  <Group x={cardX} y={cardY}>
                    <Rect
                      width={cardWidth}
                      height={MEMORY_CARD_HEIGHT}
                      cornerRadius={4}
                      fill="#121827"
                      stroke={pinned ? "#a98d55" : "#52658f"}
                      strokeWidth={1}
                      shadowColor="#000000"
                      shadowBlur={12}
                      shadowOpacity={0.42}
                    />
                    <Rect
                      width={3}
                      height={MEMORY_CARD_HEIGHT}
                      fill={pinned ? "#f2c66d" : "#88a5ff"}
                    />
                    <Text
                      x={12}
                      y={9}
                      text={`${gestureKind(visibleGesture.activity).toUpperCase()}  ·  ${formatClock(visibleGesture.activity.atMs)}`}
                      fill={pinned ? "#f0cf8e" : "#9fb4ff"}
                      fontFamily="IBM Plex Mono, monospace"
                      fontSize={9}
                      fontStyle="bold"
                    />
                    <Text
                      x={12}
                      y={25}
                      width={cardWidth - 24}
                      text={visibleGesture.trackName}
                      fill="#f0f3fa"
                      fontFamily="IBM Plex Sans, sans-serif"
                      fontSize={11}
                      fontStyle="bold"
                      ellipsis
                      wrap="none"
                    />
                    <Text
                      x={12}
                      y={43}
                      width={cardWidth - 24}
                      height={25}
                      text={describeActivity(visibleGesture.activity)}
                      fill="#aab5cc"
                      fontFamily="IBM Plex Mono, monospace"
                      fontSize={9}
                      lineHeight={1.25}
                      ellipsis
                      wrap="word"
                    />
                  </Group>
                </Group>
              );
            })()}
          </Layer>
        </Stage>
      )}
    </div>
  );
}

export default ArrangementCanvas;
