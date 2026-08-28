import { useState } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  Brush,
  Cell,
  CartesianGrid,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type TooltipContentProps,
} from "recharts";
import { formatClock } from "../../components/schema/timeline/format";
import {
  PRODUCER_WORK_LEGEND,
  producerWorkDefinition,
  type ProducerWorkCounts,
  type ProducerWorkKind,
} from "../../components/schema/timeline/producerWork";
import type { ReportTrack, SessionReport } from "./sessionReport";
import { ProducerWorkIcon } from "./ReportIcons";

export type ReportChartMode = "activity" | "category" | "tracks";

type EvidenceRequest = { title: string; subtitle?: string; ids: string[] };

type ChartDatum = ProducerWorkCounts & {
  index: number;
  startMs: number;
  endMs: number;
  label: string;
  range: string;
  total: number;
};

type ChartPointer = {
  activeLabel?: string | number;
};

type BrushRange = {
  startIndex: number;
  endIndex: number;
};

type TrackChartDatum = ReportTrack & ProducerWorkCounts & {
  chartLabel: string;
};

const WORK_COLORS: Record<ProducerWorkKind, string> = {
  writing: "#5f91f7",
  recording: "#82a9f7",
  sound: "#cbd7ed",
  arrangement: "#7c8ca8",
  mixing: "#496cb5",
  project: "#9ba8bd",
  moment: "#d3a552",
};

function countLabel(value: number, singular: string, plural = `${singular}s`): string {
  return `${value.toLocaleString()} ${value === 1 ? singular : plural}`;
}

function workKindsIn(datum: ChartDatum): ProducerWorkKind[] {
  return PRODUCER_WORK_LEGEND
    .map((definition) => definition.id)
    .filter((kind) => datum[kind] > 0);
}

function trackWorkCounts(track: ReportTrack): ProducerWorkCounts {
  return Object.fromEntries(PRODUCER_WORK_LEGEND.map((definition) => (
    [definition.id, track.workCounts?.[definition.id] ?? 0]
  ))) as ProducerWorkCounts;
}

function ChartTooltip({
  active,
  payload,
  visibleWorkKinds,
  categoryMode,
}: TooltipContentProps & {
  visibleWorkKinds: ProducerWorkKind[];
  categoryMode: boolean;
}) {
  const datum = payload[0]?.payload as ChartDatum | undefined;
  if (!active || !datum) return null;
  const rows = categoryMode
    ? visibleWorkKinds.filter((kind) => datum[kind] > 0)
    : workKindsIn(datum);
  const visibleTotal = rows.reduce((total, kind) => total + datum[kind], 0);
  return (
    <div className="report-chart-tooltip">
      <time>{datum.range}</time>
      <strong>{countLabel(datum.total, "change")}</strong>
      {categoryMode && visibleTotal !== datum.total && (
        <span>{visibleTotal} shown — the rest are filtered out</span>
      )}
      {rows.length > 0 && (
        <div>
          {rows.map((kind) => (
            <span key={kind}>
              <i style={{ background: WORK_COLORS[kind] }} />
              {producerWorkDefinition(kind).label}
              <b>{datum[kind]}</b>
            </span>
          ))}
        </div>
      )}
      <small>Click to see the changes behind this point</small>
    </div>
  );
}

function TrackTooltip({ active, payload }: TooltipContentProps) {
  const track = payload[0]?.payload as TrackChartDatum | undefined;
  if (!active || !track) return null;
  const workRows = PRODUCER_WORK_LEGEND.filter((definition) => track[definition.id] > 0);
  return (
    <div className="report-chart-tooltip is-track">
      <time>What happened on this track</time>
      <strong>{track.name}</strong>
      <div>
        {workRows.map((definition) => (
          <span key={definition.id}>
            <i style={{ background: WORK_COLORS[definition.id] }} />
            {definition.label}
            <b>{track[definition.id]}</b>
          </span>
        ))}
      </div>
      <span>{countLabel(track.sourceEventCount, "change")} · {countLabel(track.actionCount, "hands-on move")}</span>
      <small>Click to see work changes on this track</small>
    </div>
  );
}

function evidenceForRange(report: SessionReport, startMs: number, endMs: number): string[] {
  return Object.values(report.evidence)
    .filter((item) => item.atMs >= startMs && item.atMs <= endMs)
    .map((item) => item.id);
}

export function InteractiveReportChart({
  report,
  mode,
  onInspect,
}: {
  report: SessionReport;
  mode: ReportChartMode;
  onInspect: (request: EvidenceRequest) => void;
}) {
  const data: ChartDatum[] = report.series.map((bucket) => ({
    ...bucket.workCounts,
    index: bucket.index,
    startMs: bucket.startMs,
    endMs: bucket.endMs,
    label: formatClock(bucket.startMs),
    range: `${formatClock(bucket.startMs)}–${formatClock(bucket.endMs)}`,
    total: bucket.total,
  }));
  const observedWorkKinds = report.workSections
    .filter((section) => section.sourceEventCount > 0)
    .map((section) => section.kind);
  const [hiddenWorkKinds, setHiddenWorkKinds] = useState<ProducerWorkKind[]>([]);
  const [brushRange, setBrushRange] = useState<BrushRange>({
    startIndex: 0,
    endIndex: Math.max(0, data.length - 1),
  });
  const visibleWorkKinds = observedWorkKinds.filter((kind) => !hiddenWorkKinds.includes(kind));
  const reducedMotion = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const peak = [...data].sort((a, b) => b.total - a.total || a.index - b.index)[0] ?? null;
  const strongestWork = [...report.workSections]
    .filter((section) => section.sourceEventCount > 0)
    .sort((a, b) => b.sourceEventCount - a.sourceEventCount)[0] ?? null;
  const activeTracks = [...report.tracks]
    .filter((track) => track.sourceEventCount > 0)
    .sort((a, b) => b.sourceEventCount - a.sourceEventCount || a.name.localeCompare(b.name))
    .slice(0, 10);
  const trackData: TrackChartDatum[] = activeTracks.map((track) => ({
    ...track,
    ...trackWorkCounts(track),
    chartLabel: `${track.name} · ${track.sourceEventCount}`,
  }));
  const topTrack = activeTracks[0] ?? null;
  const visibleTrackKinds = observedWorkKinds.filter((kind) => (
    activeTracks.some((track) => (track.workCounts?.[kind] ?? 0) > 0)
  ));
  const sessionCapturedEvents = report.workSections.reduce((total, section) => total + section.sourceEventCount, 0);
  const workMixData = report.workSections
    .filter((section) => section.sourceEventCount > 0)
    .map((section) => ({
      kind: section.kind,
      label: section.label,
      value: section.sourceEventCount,
    }));
  const shownWorkEvents = workMixData
    .filter((item) => visibleWorkKinds.includes(item.kind))
    .reduce((total, item) => total + item.value, 0);
  const workMixIsFiltered = hiddenWorkKinds.length > 0;
  const topTrackShare = topTrack && sessionCapturedEvents > 0
    ? Math.round((topTrack.sourceEventCount / sessionCapturedEvents) * 100)
    : 0;

  function inspectBucket(pointer: ChartPointer) {
    const index = Number(pointer.activeLabel);
    const datum = data.find((item) => item.index === index);
    if (!datum || datum.total === 0) return;
    const work = workKindsIn(datum).map((kind) => producerWorkDefinition(kind).label).join(" · ");
    onInspect({
      title: datum.range,
      subtitle: `${countLabel(datum.total, "change")}${work ? ` · ${work}` : ""}`,
      ids: evidenceForRange(report, datum.startMs, datum.endMs),
    });
  }

  function inspectTrack(pointer: ChartPointer) {
    const track = trackData.find((item) => item.chartLabel === pointer.activeLabel);
    if (!track) return;
    onInspect({
      title: track.name,
      subtitle: `${track.workLabel} · ${countLabel(track.sourceEventCount, "change")}`,
      ids: track.evidenceIds,
    });
  }

  function focusWorkKind(kind: ProducerWorkKind) {
    const isIsolated = visibleWorkKinds.length === 1 && visibleWorkKinds[0] === kind;
    setHiddenWorkKinds(isIsolated ? [] : observedWorkKinds.filter((candidate) => candidate !== kind));
  }

  function updateBrush(next: { startIndex?: number; endIndex?: number }) {
    if (typeof next.startIndex !== "number" || typeof next.endIndex !== "number") return;
    setBrushRange({ startIndex: next.startIndex, endIndex: next.endIndex });
  }

  const chartMargin = { top: 18, right: 18, bottom: 8, left: 0 };
  const tick = { fill: "#8f9aad", fontSize: 11, fontFamily: "var(--font-mono)" };
  const grid = "rgb(139 151 174 / 0.14)";

  if (mode === "tracks") {
    return (
      <section className="report-interactive-chart is-tracks" aria-label="Interactive track focus graph">
        <div className="report-chart-insights">
          <span><small>Busiest track</small><strong>{topTrack?.name ?? "No track activity"}</strong></span>
          <span><small>Share of the work</small><strong>{topTrack ? `${topTrackShare}% · ${countLabel(topTrack.sourceEventCount, "change")}` : "None"}</strong></span>
          <span><small>Track spread</small><strong>{countLabel(activeTracks.length, "active track")}</strong></span>
        </div>
        <div className="report-chart-work-key" aria-label="Producer work color key">
          <span>Work colors</span>
          {visibleTrackKinds.map((kind) => (
            <span key={kind} style={{ color: WORK_COLORS[kind] }}>
              <ProducerWorkIcon kind={kind} />
              <b>{producerWorkDefinition(kind).label}</b>
            </span>
          ))}
        </div>
        <div className="report-interactive-chart__canvas is-track-canvas" style={{ height: Math.max(330, activeTracks.length * 58) }}>
          <ResponsiveContainer width="100%" height="100%" debounce={80}>
            <BarChart
              data={trackData}
              layout="vertical"
              margin={{ top: 12, right: 54, bottom: 12, left: 12 }}
              onClick={inspectTrack}
              accessibilityLayer
            >
              <CartesianGrid stroke={grid} horizontal={false} />
              <XAxis type="number" allowDecimals={false} tick={tick} axisLine={false} tickLine={false} />
              <YAxis
                type="category"
                dataKey="chartLabel"
                width={154}
                tick={tick}
                axisLine={false}
                tickLine={false}
              />
              <Tooltip
                content={(props) => <TrackTooltip {...props} />}
                cursor={false}
                shared
                isAnimationActive={false}
                wrapperStyle={{ pointerEvents: "none", outline: "none", zIndex: 4 }}
              />
              {visibleTrackKinds.map((kind, index) => (
                <Bar
                  key={kind}
                  dataKey={kind}
                  name={producerWorkDefinition(kind).label}
                  stackId="producer-work-by-track"
                  fill={WORK_COLORS[kind]}
                  fillOpacity={0.88}
                  radius={index === visibleTrackKinds.length - 1 ? [0, 4, 4, 0] : 0}
                  maxBarSize={24}
                  activeBar={false}
                  isAnimationActive={false}
                />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </div>
      </section>
    );
  }

  return (
    <section className={`report-interactive-chart is-${mode}`} aria-label={mode === "activity" ? "Interactive activity pulse graph" : "Interactive producer work graph"}>
      <div className="report-chart-insights">
        {/* A bar is one slice of clock time, not one of the session's chapters.
            Calling it a passage put a word on screen that meant something else
            two panels up. */}
        <span><small>Your busiest stretch</small><strong>{peak?.range ?? "No activity"}</strong></span>
        <span>
          <small>{mode === "category" ? "Most of the work" : "Changes in that stretch"}</small>
          <strong>{mode === "category" ? strongestWork?.label ?? "None" : peak ? countLabel(peak.total, "change") : "None"}</strong>
        </span>
        <span><small>Showing</small><strong>{brushRange.endIndex - brushRange.startIndex + 1} of {data.length} time slices</strong></span>
        <button
          type="button"
          disabled={brushRange.startIndex === 0 && brushRange.endIndex === data.length - 1}
          onClick={() => setBrushRange({ startIndex: 0, endIndex: Math.max(0, data.length - 1) })}
        >
          Reset zoom
        </button>
      </div>

      {mode === "category" && (
        <div className="report-chart-work-groups" aria-label="Producer work groups">
          <div className="report-chart-work-groups__intro">
            <span>Work mix</span>
            <p>Select a tile to isolate it on the timeline.</p>
          </div>
          <div className="report-chart-work-groups__visual">
            <div className="report-chart-work-donut" aria-hidden="true">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={workMixData}
                    dataKey="value"
                    nameKey="label"
                    cx="50%"
                    cy="50%"
                    innerRadius={48}
                    outerRadius={72}
                    paddingAngle={3}
                    cornerRadius={4}
                    stroke="#11151e"
                    strokeWidth={2}
                    isAnimationActive={false}
                  >
                    {workMixData.map((item) => (
                      <Cell
                        key={item.kind}
                        fill={WORK_COLORS[item.kind]}
                        fillOpacity={hiddenWorkKinds.includes(item.kind) ? 0.16 : 1}
                      />
                    ))}
                  </Pie>
                </PieChart>
              </ResponsiveContainer>
              <span><strong>{shownWorkEvents}</strong><small>{workMixIsFiltered ? "shown" : "captured"}</small></span>
            </div>
            <div className="report-chart-series" aria-label="Toggle producer work areas">
            {report.workSections.filter((section) => section.sourceEventCount > 0).map((section) => {
              const visible = !hiddenWorkKinds.includes(section.kind);
              const involvedTracks = activeTracks.filter((track) => (track.workCounts?.[section.kind] ?? 0) > 0);
              const share = sessionCapturedEvents > 0
                ? Math.round((section.sourceEventCount / sessionCapturedEvents) * 100)
                : 0;
              const trackLabel = involvedTracks.length > 0
                ? countLabel(involvedTracks.length, "track")
                : "Project-wide";
              const trackNames = involvedTracks.map((track) => track.name).join(", ");
              return (
                <button
                  key={section.kind}
                  type="button"
                  className={visible ? "is-active" : ""}
                  aria-label={`${section.label}: ${share}% of captured work, ${countLabel(section.sourceEventCount, "event")}, ${trackNames || "project-wide"}`}
                  aria-pressed={visible}
                  title={section.description}
                  onClick={() => focusWorkKind(section.kind)}
                >
                  <span className="report-chart-work-tile__icon" style={{ color: WORK_COLORS[section.kind] }}>
                    <ProducerWorkIcon kind={section.kind} />
                  </span>
                  <span className="report-chart-work-tile__name"><strong>{section.label}</strong><small>{trackLabel}</small></span>
                  <b>{share}%<small>{section.sourceEventCount}</small></b>
                  <span className="report-chart-work-tile__bar"><i style={{ width: `${share}%`, background: WORK_COLORS[section.kind] }} /></span>
                </button>
              );
            })}
            {hiddenWorkKinds.length > 0 && (
              <button type="button" className="report-chart-series__all" onClick={() => setHiddenWorkKinds([])}>Show all</button>
            )}
            </div>
          </div>
        </div>
      )}

      <div className="report-interactive-chart__hint">
        <span>Hover for the exact numbers</span><span>Click a point to read its changes</span><span>Drag the strip below to zoom</span>
      </div>
      <div className="report-interactive-chart__canvas">
        <ResponsiveContainer width="100%" height="100%" debounce={80}>
          <AreaChart
            data={data}
            margin={chartMargin}
            onClick={inspectBucket}
            accessibilityLayer
          >
            <defs>
              <linearGradient id="report-activity-fill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#6498fb" stopOpacity={0.58} />
                <stop offset="72%" stopColor="#4d76c8" stopOpacity={0.12} />
                <stop offset="100%" stopColor="#4d76c8" stopOpacity={0} />
              </linearGradient>
              {PRODUCER_WORK_LEGEND.map((definition) => (
                <linearGradient key={definition.id} id={`report-work-${definition.id}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={WORK_COLORS[definition.id]} stopOpacity={0.76} />
                  <stop offset="100%" stopColor={WORK_COLORS[definition.id]} stopOpacity={0.22} />
                </linearGradient>
              ))}
            </defs>
            <CartesianGrid stroke={grid} vertical={false} />
            <XAxis
              dataKey="index"
              tickFormatter={(value) => data[Number(value)]?.label ?? ""}
              tick={tick}
              minTickGap={50}
              axisLine={{ stroke: grid }}
              tickLine={false}
            />
            <YAxis
              allowDecimals={false}
              width={32}
              tick={tick}
              axisLine={false}
              tickLine={false}
            />
            <Tooltip
              content={(props) => (
                <ChartTooltip {...props} visibleWorkKinds={visibleWorkKinds} categoryMode={mode === "category"} />
              )}
              cursor={{ stroke: "#6fa0ff", strokeWidth: 1, strokeDasharray: "3 4" }}
              wrapperStyle={{ outline: "none", zIndex: 4 }}
            />
            {mode === "activity" ? (
              <Area
                type="monotone"
                dataKey="total"
                name="Work changes"
                stroke="#6498fb"
                strokeWidth={2.5}
                fill="url(#report-activity-fill)"
                activeDot={{ r: 5, stroke: "#dce7ff", strokeWidth: 2, fill: "#6498fb" }}
                dot={{ r: 2.5, strokeWidth: 0, fill: "#86acfa" }}
                isAnimationActive={!reducedMotion}
                animationDuration={700}
              />
            ) : (
              visibleWorkKinds.map((kind) => (
                <Area
                  key={kind}
                  type="monotone"
                  dataKey={kind}
                  name={producerWorkDefinition(kind).label}
                  stackId="producer-work"
                  stroke={WORK_COLORS[kind]}
                  strokeWidth={1.5}
                  fill={`url(#report-work-${kind})`}
                  activeDot={{ r: 4, strokeWidth: 1.5, fill: WORK_COLORS[kind] }}
                  dot={false}
                  isAnimationActive={!reducedMotion}
                  animationDuration={600}
                />
              ))
            )}
            <Brush
              dataKey="index"
              startIndex={brushRange.startIndex}
              endIndex={brushRange.endIndex}
              height={34}
              travellerWidth={7}
              tickFormatter={(value) => data[Number(value)]?.label ?? ""}
              stroke="#608fe8"
              fill="#11151e"
              onChange={updateBrush}
              ariaLabel="Drag to zoom the session time range"
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </section>
  );
}
