import { useMemo, useState } from "react";
import type { PlaybackState, SessionStats, SessionViewMode } from "../types/recall";
import type {
  AddNoteOptions,
  EditItemPayload,
  SessionNote,
  TimelineItem,
} from "../types/timeline";
import { buildMarkdownDocument, deriveTempoRange } from "../lib/documentation/buildMarkdown";
import { buildSessionInsights } from "../utils/sessionInsights";
import {
  categoryForEvent,
  formatProducerMoment,
  labelForCategory,
  producerEventIcon,
  type ProducerEventCategory,
} from "../utils/producerEvents";
import { RecallMark } from "./RecallMark";

type SessionDocumentProps = {
  visibleItems: TimelineItem[];
  freeNotes: SessionNote[];
  playback: PlaybackState;
  stats: SessionStats;
  viewMode: SessionViewMode;
  curationEnabled: boolean;
  onEditItem: (id: string, payload: EditItemPayload) => void;
  onHideItem: (id: string) => void;
  onAddNote: (text: string, options?: AddNoteOptions) => void;
  onDeleteNote: (noteId: string) => void;
};

export function SessionDocument({
  visibleItems,
  freeNotes,
  playback,
  stats,
  viewMode,
  curationEnabled,
  onEditItem,
  onHideItem,
  onAddNote,
  onDeleteNote,
}: SessionDocumentProps) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [notingId, setNotingId] = useState<string | null>(null);
  const [noteValue, setNoteValue] = useState("");
  // Empty set = show everything. Otherwise only the selected categories render.
  const [activeFilters, setActiveFilters] = useState<Set<ProducerEventCategory>>(
    () => new Set(),
  );

  function toggleFilter(category: ProducerEventCategory) {
    setActiveFilters((prev) => {
      const next = new Set(prev);
      if (next.has(category)) {
        next.delete(category);
      } else {
        next.add(category);
      }
      return next;
    });
  }

  function startEdit(id: string, current: string) {
    setNotingId(null);
    setEditingId(id);
    setEditValue(current);
  }

  function commitEdit(item: TimelineItem) {
    const trimmed = editValue.trim();
    const fallback = formatProducerMoment(item.raw).title;
    // Empty or unchanged-from-raw clears the override; otherwise store it.
    onEditItem(item.id, { title: trimmed && trimmed !== fallback ? trimmed : null });
    setEditingId(null);
    setEditValue("");
  }

  function startNote(id: string) {
    setEditingId(null);
    setNotingId(id);
    setNoteValue("");
  }

  function commitNote(item: TimelineItem) {
    const trimmed = noteValue.trim();
    if (trimmed) {
      onAddNote(trimmed, {
        linkedEventId: item.id,
        sessionTimecode: item.raw.sessionTimecode,
      });
    }
    setNotingId(null);
    setNoteValue("");
  }

  // Insights run on curated raw events — hidden items excluded.
  const curatedRawEvents = useMemo(
    () => visibleItems.map((i) => i.raw),
    [visibleItems],
  );

  // Stats derived from visible (curated) items only.
  const curatedStats = useMemo<SessionStats>(
    () => ({
      totalEvents: visibleItems.length,
      creativeEvents: visibleItems.length,
      transportEvents: visibleItems.filter((i) => i.raw.type === "transport").length,
      tempoEvents: visibleItems.filter((i) => i.raw.type === "tempo").length,
      trackEvents: visibleItems.filter((i) => i.raw.type === "track").length,
      deviceEvents: visibleItems.filter((i) => i.raw.type === "device").length,
      parameterEvents: visibleItems.filter((i) => i.raw.type === "parameter").length,
      heartbeatEvents: 0,
    }),
    [visibleItems],
  );

  const insights = useMemo(
    () => buildSessionInsights(curatedRawEvents, curatedStats),
    [curatedRawEvents, curatedStats],
  );

  const tempoRange = useMemo(
    () => deriveTempoRange(visibleItems, playback),
    [visibleItems, playback],
  );

  const markdown = useMemo(
    () => buildMarkdownDocument(visibleItems, freeNotes, playback, viewMode),
    [visibleItems, freeNotes, playback, viewMode],
  );

  const activityBreakdown = useMemo(
    () => buildActivityBreakdown(visibleItems),
    [visibleItems],
  );

  // Filter options are derived from what's actually in the curated timeline, so
  // chips never offer a category with zero moments.
  const filterOptions = useMemo(() => {
    const counts = new Map<ProducerEventCategory, number>();
    for (const item of visibleItems) {
      const category = categoryForEvent(item.raw.type);
      counts.set(category, (counts.get(category) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([category, count]) => ({ category, count }))
      .sort((a, b) => b.count - a.count);
  }, [visibleItems]);

  const filteredItems = useMemo(() => {
    if (activeFilters.size === 0) {
      return visibleItems;
    }
    return visibleItems.filter((item) =>
      activeFilters.has(categoryForEvent(item.raw.type)),
    );
  }, [visibleItems, activeFilters]);

  async function handleCopyMarkdown() {
    try {
      await navigator.clipboard.writeText(markdown);
      setCopyState("copied");
      window.setTimeout(() => setCopyState("idle"), 1600);
    } catch {
      setCopyState("failed");
      window.setTimeout(() => setCopyState("idle"), 1800);
    }
  }

  const sessionLabel = viewMode === "live" ? "Live Capture Notes" : "Saved Session Notes";
  const hasContent = visibleItems.length > 0 || freeNotes.length > 0;

  return (
    <section className="session-document">
      {/* ── Document header ─────────────────────────────────────── */}
      <header className="document-hero">
        <RecallMark />
        <div>
          <p className="eyebrow">Session Document</p>
          <h1>{sessionLabel}</h1>
          <span>
            Curated session memory — edits and notes included, hidden items excluded.
          </span>
        </div>

        <button
          type="button"
          className={`doc-copy-btn ${copyState !== "idle" ? `doc-copy-btn--${copyState}` : ""}`}
          onClick={handleCopyMarkdown}
          disabled={!hasContent}
        >
          {copyState === "copied"
            ? "Copied"
            : copyState === "failed"
              ? "Failed"
              : "Copy Markdown"}
        </button>
      </header>

      <div className="document-grid">
        {/* ── Main document page ────────────────────────────────── */}
        <section className="document-page">
          {/* Session metadata strip */}
          <div className="document-meta-strip">
            {tempoRange && (
              <div className="document-meta-chip">
                <span>Tempo</span>
                <strong>{tempoRange}</strong>
              </div>
            )}
            <div className="document-meta-chip">
              <span>Moments</span>
              <strong>{visibleItems.length}</strong>
            </div>
            {playback.projectClock && (
              <div className="document-meta-chip">
                <span>Duration</span>
                <strong>{playback.projectClock}</strong>
              </div>
            )}
            {playback.selectedTrack && (
              <div className="document-meta-chip">
                <span>Last track</span>
                <strong>{playback.selectedTrack}</strong>
              </div>
            )}
            {(stats.totalEvents - curatedStats.creativeEvents) > 0 && (
              <div className="document-meta-chip document-meta-chip--dim">
                <span>Hidden</span>
                <strong>{stats.totalEvents - curatedStats.creativeEvents}</strong>
              </div>
            )}
          </div>

          {/* Timeline */}
          <section className="document-section">
            <h2>Timeline</h2>

            {filterOptions.length > 0 && (
              <div className="document-filters" role="group" aria-label="Filter timeline by type">
                <button
                  type="button"
                  className={`document-filter ${activeFilters.size === 0 ? "is-active" : ""}`}
                  onClick={() => setActiveFilters(new Set())}
                >
                  All
                  <span className="document-filter__count">{visibleItems.length}</span>
                </button>
                {filterOptions.map(({ category, count }) => (
                  <button
                    key={category}
                    type="button"
                    className={`document-filter ${activeFilters.has(category) ? "is-active" : ""}`}
                    onClick={() => toggleFilter(category)}
                  >
                    {labelForCategory(category)}
                    <span className="document-filter__count">{count}</span>
                  </button>
                ))}
              </div>
            )}

            {visibleItems.length === 0 ? (
              <p className="document-empty">
                No creative moments in the curated timeline yet. Capture events
                in Ableton to build this document.
              </p>
            ) : filteredItems.length === 0 ? (
              <p className="document-empty">
                No moments match the active filters.
              </p>
            ) : (
              <ol className="document-timeline">
                {filteredItems.map((item) => {
                  const p = formatProducerMoment(item.raw);
                  const displayTitle = item.edits.title ?? p.title;
                  const displayDetail = item.edits.description ?? p.detail;
                  const hasEdits = Boolean(item.edits.title || item.edits.description);

                  return (
                    <li key={item.id} className={hasEdits ? "is-edited" : ""}>
                      <div className="doc-event-row">
                        <time>{item.raw.sessionTimecode}</time>
                        <span
                          className={`event-glyph event-glyph--${item.raw.type} event-glyph--sm`}
                          aria-hidden="true"
                        >
                          {producerEventIcon(item.raw.type)}
                        </span>
                        <div className="doc-event-content">
                          {editingId === item.id ? (
                            <input
                              className="doc-edit-input"
                              value={editValue}
                              autoFocus
                              onChange={(e) => setEditValue(e.target.value)}
                              onBlur={() => commitEdit(item)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") commitEdit(item);
                                if (e.key === "Escape") {
                                  setEditingId(null);
                                  setEditValue("");
                                }
                              }}
                            />
                          ) : (
                            <strong>{displayTitle}</strong>
                          )}
                          {displayDetail && <p>{displayDetail}</p>}

                          {item.notes.length > 0 && (
                            <div className="doc-event-notes">
                              {item.notes.map((note) => (
                                <blockquote key={note.id} className="doc-note">
                                  <span>{note.text}</span>
                                  {curationEnabled && (
                                    <button
                                      type="button"
                                      className="doc-note__delete"
                                      aria-label="Delete note"
                                      onClick={() => onDeleteNote(note.id)}
                                    >
                                      ×
                                    </button>
                                  )}
                                </blockquote>
                              ))}
                            </div>
                          )}

                          {notingId === item.id && (
                            <textarea
                              className="doc-note-input"
                              value={noteValue}
                              autoFocus
                              placeholder="Add a note for this moment…"
                              onChange={(e) => setNoteValue(e.target.value)}
                              onBlur={() => commitNote(item)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                                  commitNote(item);
                                }
                                if (e.key === "Escape") {
                                  setNotingId(null);
                                  setNoteValue("");
                                }
                              }}
                            />
                          )}
                        </div>

                        {curationEnabled && (
                          <div className="doc-event-actions">
                            <button
                              type="button"
                              onClick={() => startEdit(item.id, displayTitle)}
                            >
                              Rename
                            </button>
                            <button type="button" onClick={() => startNote(item.id)}>
                              Note
                            </button>
                            <button
                              type="button"
                              className="doc-event-actions__hide"
                              onClick={() => onHideItem(item.id)}
                            >
                              Hide
                            </button>
                          </div>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ol>
            )}
          </section>

          {/* Free-standing session notes */}
          {freeNotes.length > 0 && (
            <section className="document-section">
              <h2>Session Notes</h2>
              <div className="doc-free-notes">
                {freeNotes.map((note) => (
                  <div key={note.id} className="doc-free-note">
                    <time>{note.sessionTimecode}</time>
                    <p>{note.text}</p>
                    {curationEnabled && (
                      <button
                        type="button"
                        className="doc-note__delete"
                        aria-label="Delete note"
                        onClick={() => onDeleteNote(note.id)}
                      >
                        ×
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </section>
          )}
        </section>

        {/* ── Sidebar ──────────────────────────────────────────── */}
        <aside className="document-sidebar">
          <section>
            <h2>Session Intelligence</h2>
            <div className="document-insights">
              {insights.slice(0, 4).map((insight) => (
                <article key={insight.label} className="doc-insight">
                  <span>{insight.label}</span>
                  <strong>{insight.value}</strong>
                  <p>{insight.detail}</p>
                </article>
              ))}
            </div>
          </section>

          <section>
            <h2>Activity</h2>
            <div className="document-breakdown">
              {activityBreakdown.map((row) => (
                <div key={row.label} className="doc-breakdown-row">
                  <span>{row.label}</span>
                  <div className="doc-breakdown-bar">
                    <div
                      className="doc-breakdown-bar__fill"
                      style={{ width: `${row.pct}%` }}
                    />
                  </div>
                  <strong>{row.count}</strong>
                </div>
              ))}
            </div>
          </section>

          <section>
            <h2>Markdown Preview</h2>
            <pre className="doc-markdown-preview">{markdown}</pre>
          </section>
        </aside>
      </div>
    </section>
  );
}

function buildActivityBreakdown(items: TimelineItem[]) {
  const rows = [
    { label: "Track", type: "track" },
    { label: "Device", type: "device" },
    { label: "Parameter", type: "parameter" },
    { label: "Clip", type: "clip" },
    { label: "Tempo", type: "tempo" },
    { label: "Transport", type: "transport" },
    { label: "Group", type: "group" },
  ] as const;

  const max = Math.max(1, ...rows.map((r) => items.filter((i) => i.raw.type === r.type).length));

  return rows.map((r) => {
    const count = items.filter((i) => i.raw.type === r.type).length;
    return { label: r.label, count, pct: Math.round((count / max) * 100) };
  });
}
