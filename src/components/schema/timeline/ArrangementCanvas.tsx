import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { Circle, Group, Layer, Line, Path, Rect, Stage, Text } from "react-konva";
import type { TrackObj } from "../../../types/schema";
import type { Activity } from "./types";
import { describeActivity, formatClock } from "./format";
import type { TimelineBounds } from "./graph";
import { buildActivityScale } from "./activityScale";
import { activityPhrasePath } from "./activityPhrase";

type Lane = { track: TrackObj; items: Activity[] };

type Region = { start: number; end: number; count: number; events: Activity[] };
type GestureMemory = {
  activity: Activity;
  trackName: string;
  x: number;
  y: number;
};

type RegionStyle = {
  accent: string;
};

const RULER_HEIGHT = 28;
const LANE_HEIGHT = 52;
const TICK_LABEL_WIDTH = 58;

function gestureKind(activity: Activity): string {
  if (activity.kind === "note") return "Producer note";
  if (activity.kind === "noteEdit") return "MIDI edit";
  if (activity.kind === "clip") return "Clip memory";
  if (activity.kind === "memory") return activity.memoryTitle ?? "Song change";
  return activity.automation ? "Automation write" : activity.deviceName === "Mixer" ? "Mixer gesture" : "Parameter gesture";
}

function regionStyle(events: Activity[]): RegionStyle {
  if (events.some((event) => event.kind === "memory" && event.memoryCategory === "song")) {
    return { accent: "#d2b46e" };
  }
  if (events.some((event) => event.kind === "memory" && event.memoryCategory === "recording")) {
    return { accent: "#dc8f8b" };
  }
  if (events.some((event) => event.kind === "memory" && event.memoryCategory === "structure")) {
    return { accent: "#75c5bd" };
  }
  if (events.some((event) => event.kind === "memory" && event.memoryCategory === "automation")) {
    return { accent: "#9ba8ff" };
  }
  if (events.some((event) => event.kind === "memory" && event.memoryCategory === "mix")) {
    return { accent: "#82b9e8" };
  }
  if (events.some((event) => event.kind === "memory" && event.memoryCategory === "performance")) {
    return { accent: "#c29bea" };
  }
  if (events.some((event) => event.kind === "memory" && event.memoryCategory === "project")) {
    return { accent: "#a8b2c8" };
  }
  if (events.some((event) => event.kind === "clip")) {
    return { accent: "#79c7cf" };
  }
  if (events.some((event) => event.kind === "noteEdit")) {
    return { accent: "#baa7ff" };
  }
  if (events.some((event) => event.kind === "note")) {
    return { accent: "#d8b66f" };
  }
  if (events.some((event) => event.automation)) {
    return { accent: "#9ba8ff" };
  }
  if (events.some((event) => event.deviceName === "Mixer")) {
    return { accent: "#82b9e8" };
  }
  return { accent: "#9daeff" };
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
        events: [item],
      };
      regions.push(current);
    } else {
      current.end = item.atMs;
      current.count += 1;
      current.events.push(item);
    }
  }

  return regions;
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
  const activityScale = useMemo(
    () => buildActivityScale(lanes.flatMap((lane) => lane.items.map((item) => item.atMs))),
    [lanes],
  );
  const ticks = activityScale.ticks;
  const activityCellCount = Math.min(activityScale.slots.length, 48);
  const regions = useMemo(
    () => new Map(lanes.map((lane) => [lane.track.id, regionsFor(lane.items, bounds)])),
    [lanes, bounds],
  );
  const visibleGesture = pinnedGesture ?? hoveredGesture;

  useEffect(() => {
    setHoveredGesture(null);
    setPinnedGesture(null);
  }, [bounds.start, bounds.span, lanes]);

  useEffect(() => {
    if (!pinnedGesture) return;
    const clearPinnedGesture = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setPinnedGesture(null);
    };
    document.addEventListener("keydown", clearPinnedGesture);
    return () => document.removeEventListener("keydown", clearPinnedGesture);
  }, [pinnedGesture]);

  const gestureAtPointer = (
    events: Activity[],
    trackName: string,
    pointerX: number,
    laneY: number,
  ): GestureMemory => {
    const activity = events.reduce((nearest, candidate) =>
      Math.abs(activityScale.fraction(candidate.atMs) * width - pointerX) <
      Math.abs(activityScale.fraction(nearest.atMs) * width - pointerX)
        ? candidate
        : nearest,
    );
    return {
      activity,
      trackName,
      x: activityScale.fraction(activity.atMs) * width,
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
            <Rect width={width} height={height} fill="#090d13" />
            <Rect width={width} height={RULER_HEIGHT} fill="#111720" />
            <Line points={[0, RULER_HEIGHT - 0.5, width, RULER_HEIGHT - 0.5]} stroke="#30394b" strokeWidth={1} />
            {ticks.map((tick, index) => {
              const x = Math.round(tick.fraction * width) + 0.5;
              return (
                <Fragment key={`${tick.atMs}-${index}`}>
                  <Line
                    points={[x, RULER_HEIGHT, x, height]}
                    stroke="#242c3a"
                    strokeWidth={1}
                    opacity={index === 0 ? 0 : 0.52}
                  />
                  <Line points={[x, RULER_HEIGHT - 6, x, RULER_HEIGHT]} stroke="#536078" strokeWidth={1} />
                  <Text
                    x={Math.max(3, Math.min(width - TICK_LABEL_WIDTH, x + 5))}
                    y={5}
                    text={formatClock(tick.atMs)}
                    fill="#929db1"
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
                    fill={selected ? "#141c29" : index % 2 === 0 ? "#0a0e15" : "#090c12"}
                  />
                  {selected && <Rect x={0} y={y} width={2} height={LANE_HEIGHT} fill="#91a5e6" />}
                  {Array.from({ length: activityCellCount }, (_, slotIndex) => {
                    const cellWidth = width / Math.max(1, activityCellCount);
                    return (
                      <Fragment key={`${lane.track.id}-activity-cell-${slotIndex}`}>
                        {slotIndex % 2 === 0 && (
                          <Rect
                            x={slotIndex * cellWidth}
                            y={y}
                            width={cellWidth}
                            height={LANE_HEIGHT}
                            fill="#171d28"
                            opacity={0.055}
                            listening={false}
                          />
                        )}
                        {slotIndex > 0 && (
                          <Line
                            points={[slotIndex * cellWidth + 0.5, y, slotIndex * cellWidth + 0.5, y + LANE_HEIGHT]}
                            stroke="#202736"
                            strokeWidth={1}
                            opacity={0.24}
                            listening={false}
                          />
                        )}
                      </Fragment>
                    );
                  })}
                  <Line
                    points={[0, y + LANE_HEIGHT / 2, width, y + LANE_HEIGHT / 2]}
                    stroke="#273040"
                    strokeWidth={1}
                    opacity={0.34}
                    listening={false}
                  />
                  <Line points={[0, y + LANE_HEIGHT - 0.5, width, y + LANE_HEIGHT - 0.5]} stroke="#1d2430" strokeWidth={1} />
                  {laneRegions.map((region, regionIndex) => {
                    const x = activityScale.fraction(region.start) * width;
                    const end = activityScale.fraction(region.end) * width;
                    const regionWidth = Math.max(12, end - x + Math.min(width * 0.006, 14));
                    const paintedWidth = Math.min(regionWidth, width - x);
                    const centerY = y + LANE_HEIGHT / 2;
                    const style = regionStyle(region.events);
                    const eventXs = region.events.map((activity) => activityScale.fraction(activity.atMs) * width);
                    const phrasePath = activityPhrasePath(eventXs, centerY, width, selected ? 13 : 10.5);
                    return (
                      <Fragment key={`${lane.track.id}-${regionIndex}`}>
                        {phrasePath && (
                          <Path
                            data={phrasePath}
                            fill={style.accent}
                            fillOpacity={selected ? 0.25 : 0.15}
                            stroke={style.accent}
                            strokeWidth={selected ? 1.15 : 0.75}
                            opacity={selected ? 0.95 : 0.72}
                            shadowColor={style.accent}
                            shadowBlur={selected ? 7 : 0}
                            shadowOpacity={selected ? 0.14 : 0}
                            listening={false}
                          />
                        )}
                        {region.events.map((activity) => {
                          const eventX = activityScale.fraction(activity.atMs) * width;
                          return (
                            <Circle
                              key={activity.id}
                              x={eventX}
                              y={centerY}
                              radius={activity.kind === "note" ? 2.1 : activity.kind === "memory" ? 2.25 : activity.automation ? 1.75 : 1.15}
                              fill="#0a0d13"
                              stroke={style.accent}
                              strokeWidth={0.9}
                              opacity={selected ? 0.9 : 0.6}
                              listening={false}
                            />
                          );
                        })}
                        <Rect
                          x={x}
                          y={y + 5}
                          width={Math.max(24, paintedWidth)}
                          height={LANE_HEIGHT - 10}
                          fill="#ffffff"
                          opacity={0.001}
                          onMouseEnter={(event) => {
                            const stage = event.target.getStage();
                            const pointer = stage?.getPointerPosition();
                            if (!pointer) return;
                            stage!.container().style.cursor = "pointer";
                            setHoveredGesture(gestureAtPointer(region.events, lane.track.name ?? "Untitled track", pointer.x, y));
                          }}
                          onMouseMove={(event) => {
                            const pointer = event.target.getStage()?.getPointerPosition();
                            if (!pointer) return;
                            setHoveredGesture(gestureAtPointer(region.events, lane.track.name ?? "Untitled track", pointer.x, y));
                          }}
                          onMouseLeave={(event) => {
                            const stage = event.target.getStage();
                            if (stage) stage.container().style.cursor = "default";
                            setHoveredGesture(null);
                          }}
                          onClick={(event) => {
                            const pointer = event.target.getStage()?.getPointerPosition();
                            if (!pointer) return;
                            const gesture = gestureAtPointer(region.events, lane.track.name ?? "Untitled track", pointer.x, y);
                            setPinnedGesture((current) => current?.activity.id === gesture.activity.id ? null : gesture);
                          }}
                        />
                        {region.count > 1 && (
                          <Text
                            x={Math.min(width - 22, Math.max(x + 11, end + 5))}
                            y={centerY - 5}
                            width={20}
                            text={String(region.count)}
                            fill="#8995aa"
                            fontFamily="IBM Plex Mono, monospace"
                            fontSize={8}
                            opacity={0.62}
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
            {visibleGesture && (
              <Group listening={false}>
                <Line
                  points={[visibleGesture.x, RULER_HEIGHT, visibleGesture.x, height]}
                  stroke={pinnedGesture ? "#c8b470" : "#8fa5df"}
                  strokeWidth={1}
                  opacity={pinnedGesture ? 0.5 : 0.24}
                />
                <Circle
                  x={visibleGesture.x}
                  y={visibleGesture.y}
                  radius={3}
                  fill="#0a0d13"
                  stroke={pinnedGesture ? "#c8b470" : "#9bb0eb"}
                  strokeWidth={1.25}
                />
              </Group>
            )}
          </Layer>
        </Stage>
      )}
      {visibleGesture && (
        <div className={`tl-canvas-readout ${pinnedGesture ? "is-pinned" : ""}`}>
          <span className="tl-canvas-readout__kind">
            {gestureKind(visibleGesture.activity)} · {formatClock(visibleGesture.activity.atMs)}
          </span>
          <strong>{visibleGesture.trackName}</strong>
          <span className="tl-canvas-readout__change">{describeActivity(visibleGesture.activity)}</span>
          {pinnedGesture && <small>pinned · Esc to close</small>}
        </div>
      )}
    </div>
  );
}

export default ArrangementCanvas;
