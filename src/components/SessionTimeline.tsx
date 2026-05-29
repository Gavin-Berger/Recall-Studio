import { useMemo, useState } from "react";
import type {
  ConnectionStatus,
  PlaybackState,
  RecallTimelineMoment,
  SessionStats,
  SessionViewMode,
} from "../types/recall";
import type { AddNoteOptions, EditItemPayload, TimelineItem } from "../types/timeline";
import type { ActivityBlock } from "../types/activities";
import { formatProducerMoment, producerEventIcon } from "../utils/producerEvents";
import { CaptureReadinessPanel } from "./CaptureReadinessPanel";
import { MemoryChamber } from "./MemoryChamber";
import { TimelineEvent } from "./TimelineEvent";
import { ActivityBlockCard } from "./ActivityBlock";

type TimelineViewStyle = "blocks" | "raw";

// How many raw-event rows to mount at once. A long session can accumulate tens
// of thousands of curated moments; each one is a rich interactive TimelineEvent
// (edit/note/hide controls), so mounting them all freezes the app. We render
// only the most recent window (the live edge is what producers watch) and let
// them reveal older batches on demand. Blocks view is already aggregated, so it
// needs no cap.
const RAW_RENDER_STEP = 200;

type SessionTimelineProps = {
  connection: ConnectionStatus;
  items: TimelineItem[];
  allItems: TimelineItem[];
  rawEvents: RecallTimelineMoment[];
  activityBlocks: ActivityBlock[];
  playback: PlaybackState;
  selectedEventId: string | null;
  stats: SessionStats;
  viewMode: SessionViewMode;
  onSelectEvent: (eventId: string) => void;
  onHideItem: (id: string) => void;
  onRestoreItem: (id: string) => void;
  onEditItem: (id: string, payload: EditItemPayload) => void;
  onAddNote: (text: string, options?: AddNoteOptions) => void;
};

const FILTERS = [
  { id: "all", label: "All" },
  { id: "track", label: "Tracks" },
  { id: "group", label: "Groups" },
  { id: "device", label: "Devices" },
  { id: "parameter", label: "Params" },
  { id: "transport", label: "Transport" },
  { id: "tempo", label: "Tempo" },
  { id: "clip", label: "Clips" },
  { id: "notes", label: "Notes" },
] as const;

type TimelineFilter = (typeof FILTERS)[number]["id"];

export function SessionTimeline({
  connection,
  items,
  allItems,
  rawEvents,
  activityBlocks,
  playback,
  selectedEventId,
  stats,
  viewMode,
  onSelectEvent,
  onHideItem,
  onRestoreItem,
  onEditItem,
  onAddNote,
}: SessionTimelineProps) {
  const [viewStyle, setViewStyle] = useState<TimelineViewStyle>("blocks");
  const [activeFilter, setActiveFilter] = useState<TimelineFilter>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [showHidden, setShowHidden] = useState(false);
  const [rawRenderLimit, setRawRenderLimit] = useState(RAW_RENDER_STEP);

  const hiddenItems = useMemo(
    () => allItems.filter((item) => item.isHidden),
    [allItems],
  );

  const filteredItems = useMemo(() => {
    if (activeFilter === "notes") {
      return items.filter((item) => item.notes.length > 0);
    }
    if (activeFilter !== "all") {
      return items.filter((item) => item.raw.type === activeFilter);
    }
    return items;
  }, [activeFilter, items]);

  const displayItems = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return filteredItems;

    return filteredItems.filter((item) => {
      const title = (item.edits.title ?? item.raw.summary ?? "").toLowerCase();
      const track = (item.raw.trackName ?? "").toLowerCase();
      const device = (item.raw.deviceName ?? "").toLowerCase();
      const group = (item.raw.groupName ?? "").toLowerCase();
      return (
        title.includes(q) ||
        track.includes(q) ||
        device.includes(q) ||
        group.includes(q)
      );
    });
  }, [filteredItems, searchQuery]);

  // Window the raw stream to the most recent rawRenderLimit items (the tail,
  // since events are oldest-first and the live edge is newest). Older moments
  // stay one click away rather than all mounting at once.
  const windowedItems = useMemo(() => {
    if (displayItems.length <= rawRenderLimit) return displayItems;
    return displayItems.slice(displayItems.length - rawRenderLimit);
  }, [displayItems, rawRenderLimit]);

  const olderHiddenCount = displayItems.length - windowedItems.length;

  // Collapsing the visible set (changing filter/search) should reset the window
  // so the user isn't stranded scrolled past a now-shorter list.
  const resetRawWindow = () => setRawRenderLimit(RAW_RENDER_STEP);

  const activityLanes = useMemo(
    () => buildActivityLanes(rawEvents),
    [rawEvents],
  );

  return (
    <section className="timeline-stage">
      <header className="timeline-stage__header">
        <div>
          <p className="eyebrow">
            {viewMode === "live" ? "Live Session" : "Saved Session"}
          </p>
          <h1>What Happened, When</h1>
          <span>
            A timecoded memory of producer decisions captured from Ableton Live.
          </span>
        </div>

        <div className="timeline-stage__header-right">
          <div className="timeline-view-toggle" role="group" aria-label="Timeline view">
            <button
              type="button"
              className={`timeline-view-toggle__btn ${viewStyle === "blocks" ? "is-active" : ""}`}
              onClick={() => setViewStyle("blocks")}
            >
              Activity
            </button>
            <button
              type="button"
              className={`timeline-view-toggle__btn ${viewStyle === "raw" ? "is-active" : ""}`}
              onClick={() => setViewStyle("raw")}
            >
              Raw
            </button>
          </div>

          <div className="timeline-stage__counter">
            <strong>{viewStyle === "blocks" ? activityBlocks.length : items.length}</strong>
            <span>{viewStyle === "blocks" ? "blocks" : "moments"}</span>
          </div>
        </div>
      </header>

      <div className="signal-field" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>

      <MemoryChamber events={rawEvents} />

      <div className="session-map" aria-label="Session activity map">
        {activityLanes.map((lane) => (
          <div
            className={`session-map__lane session-map__lane--${lane.id}`}
            key={lane.id}
          >
            <span>{lane.label}</span>
            <div>
              {lane.cells.map((isActive, index) => (
                <i className={isActive ? "is-active" : ""} key={index} />
              ))}
            </div>
            <strong>{lane.count}</strong>
          </div>
        ))}
      </div>

      {/* ── Search + filter bar (raw view only) ──────────────────── */}
      {viewStyle === "raw" && <div className="timeline-controls">
        <div className="timeline-search">
          <input
            type="text"
            className="timeline-search__input"
            value={searchQuery}
            onChange={(e) => {
              setSearchQuery(e.target.value);
              resetRawWindow();
            }}
            placeholder="Search timeline…"
            aria-label="Search timeline"
          />
          {searchQuery && (
            <button
              type="button"
              className="timeline-search__clear"
              aria-label="Clear search"
              onClick={() => {
                setSearchQuery("");
                resetRawWindow();
              }}
            >
              ×
            </button>
          )}
        </div>

        <div className="timeline-filter-bar" aria-label="Timeline filters">
          {FILTERS.map((filter) => (
            <button
              type="button"
              key={filter.id}
              className={`timeline-filter ${
                activeFilter === filter.id ? "is-active" : ""
              }`}
              onClick={() => {
                setActiveFilter(filter.id);
                resetRawWindow();
              }}
            >
              {filter.label}
              <span>{countItemsForFilter(items, filter.id)}</span>
            </button>
          ))}
        </div>
      </div>}

      {/* ── Timeline stream ────────────────────────────────────── */}
      <div className="timeline-editor">
        <div className="timeline-ruler" aria-hidden="true">
          <span>00:00</span>
          <span>Session Memory</span>
          <span>Live Edge</span>
        </div>

        <div className="timeline-stream">
          {/* Activity blocks view */}
          {viewStyle === "blocks" && (
            activityBlocks.length === 0 ? (
              <CaptureReadinessPanel
                connection={connection}
                playback={playback}
                stats={stats}
                viewMode={viewMode}
              />
            ) : (
              activityBlocks.map((block, index) => (
                <ActivityBlockCard key={block.id} block={block} index={index} />
              ))
            )
          )}

          {/* Raw events view */}
          {viewStyle === "raw" && (
            displayItems.length === 0 && hiddenItems.length === 0 ? (
              <CaptureReadinessPanel
                connection={connection}
                playback={playback}
                stats={stats}
                viewMode={viewMode}
              />
            ) : displayItems.length === 0 ? (
              <div className="timeline-empty-filter">
                <p>No events match this filter{searchQuery ? " and search" : ""}.</p>
              </div>
            ) : (
              <>
                {olderHiddenCount > 0 && (
                  <button
                    type="button"
                    className="timeline-load-older"
                    onClick={() =>
                      setRawRenderLimit((limit) => limit + RAW_RENDER_STEP)
                    }
                  >
                    Load {Math.min(olderHiddenCount, RAW_RENDER_STEP)} older
                    <span>{olderHiddenCount} earlier moments hidden</span>
                  </button>
                )}
                {windowedItems.map((item) => (
                  <TimelineEvent
                    key={item.id}
                    item={item}
                    isSelected={selectedEventId === item.id}
                    onSelect={onSelectEvent}
                    onHide={onHideItem}
                    onEdit={onEditItem}
                    onAddNote={onAddNote}
                  />
                ))}
              </>
            )
          )}

          {/* ── Hidden items section ─────────────────────────── */}
          {hiddenItems.length > 0 && (
            <div className="timeline-hidden-section">
              <button
                type="button"
                className="timeline-hidden-section__toggle"
                onClick={() => setShowHidden((v) => !v)}
                aria-expanded={showHidden}
              >
                <span className="timeline-hidden-section__chevron">
                  {showHidden ? "▾" : "▸"}
                </span>
                Hidden
                <span className="timeline-hidden-section__count">
                  {hiddenItems.length}
                </span>
              </button>

              {showHidden && (
                <div className="timeline-hidden-list">
                  {hiddenItems.map((item) => {
                    const p = formatProducerMoment(item.raw);
                    return (
                      <div key={item.id} className="timeline-hidden-row">
                        <span
                          className={`event-glyph event-glyph--${item.raw.type}`}
                          aria-hidden="true"
                        >
                          {producerEventIcon(item.raw.type)}
                        </span>
                        <span className="timeline-hidden-row__timecode">
                          {item.raw.sessionTimecode}
                        </span>
                        <span className="timeline-hidden-row__title">
                          {item.edits.title ?? p.title}
                        </span>
                        <button
                          type="button"
                          className="timeline-hidden-row__restore"
                          onClick={() => onRestoreItem(item.id)}
                        >
                          Restore
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function buildActivityLanes(events: RecallTimelineMoment[]) {
  const laneDefinitions = [
    { id: "track", label: "Track" },
    { id: "group", label: "Group" },
    { id: "device", label: "Device" },
    { id: "parameter", label: "Param" },
    { id: "clip", label: "Clip" },
    { id: "transport", label: "Play" },
  ] as const;

  return laneDefinitions.map((lane) => {
    const laneEvents = events.filter((event) => event.type === lane.id);
    const density = Math.min(16, Math.max(0, laneEvents.length));

    return {
      ...lane,
      count: laneEvents.length,
      cells: Array.from({ length: 16 }, (_, index) => index < density),
    };
  });
}

function countItemsForFilter(
  items: TimelineItem[],
  filter: TimelineFilter,
): number {
  if (filter === "all") return items.length;
  if (filter === "notes") return items.filter((i) => i.notes.length > 0).length;
  return items.filter((item) => item.raw.type === filter).length;
}
