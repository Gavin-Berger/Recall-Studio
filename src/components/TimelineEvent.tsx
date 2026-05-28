import { useEffect, useRef, useState } from "react";
import type { AddNoteOptions, EditItemPayload, TimelineItem } from "../types/timeline";
import { findAbletonInstrumentReference } from "../utils/abletonInstruments";
import { formatProducerMoment, producerEventIcon } from "../utils/producerEvents";

type TimelineEventProps = {
  item: TimelineItem;
  isSelected: boolean;
  onSelect: (id: string) => void;
  onHide: (id: string) => void;
  onEdit: (id: string, payload: EditItemPayload) => void;
  onAddNote: (text: string, options?: AddNoteOptions) => void;
};

export function TimelineEvent({
  item,
  isSelected,
  onSelect,
  onHide,
  onEdit,
  onAddNote,
}: TimelineEventProps) {
  const presentation = formatProducerMoment(item.raw);

  // User edits overlay the raw presentation — raw is never mutated.
  const displayTitle = item.edits.title ?? presentation.title;
  const displayDetail = item.edits.description ?? presentation.detail;
  const isEdited = Boolean(item.edits.title || item.edits.description);

  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [editTitleValue, setEditTitleValue] = useState("");

  const [isAddingNote, setIsAddingNote] = useState(false);
  const [noteText, setNoteText] = useState("");

  const titleInputRef = useRef<HTMLInputElement>(null);
  const noteTextareaRef = useRef<HTMLTextAreaElement>(null);

  const instrument = findAbletonInstrumentReference(
    item.raw.deviceName ?? String(item.raw.metadata?.device ?? ""),
  );

  // Close note input when deselected
  useEffect(() => {
    if (!isSelected) {
      setIsAddingNote(false);
      setNoteText("");
    }
  }, [isSelected]);

  // Auto-focus title input when it appears
  useEffect(() => {
    if (isEditingTitle) {
      titleInputRef.current?.focus();
      titleInputRef.current?.select();
    }
  }, [isEditingTitle]);

  // Auto-focus note textarea when it appears
  useEffect(() => {
    if (isAddingNote) {
      noteTextareaRef.current?.focus();
    }
  }, [isAddingNote]);

  function handleTitleEditStart(e: React.MouseEvent) {
    e.stopPropagation();
    setEditTitleValue(item.edits.title ?? presentation.title);
    setIsEditingTitle(true);
  }

  function handleTitleSave() {
    const trimmed = editTitleValue.trim();
    if (!trimmed || trimmed === presentation.title) {
      // Clear override — revert to raw
      onEdit(item.id, { title: null });
    } else {
      onEdit(item.id, { title: trimmed });
    }
    setIsEditingTitle(false);
  }

  function handleTitleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      handleTitleSave();
    }
    if (e.key === "Escape") {
      setIsEditingTitle(false);
    }
  }

  function handleNoteSubmit() {
    const trimmed = noteText.trim();
    if (trimmed) {
      onAddNote(trimmed, {
        linkedEventId: item.id,
        sessionTimecode: item.raw.sessionTimecode,
      });
      setNoteText("");
      setIsAddingNote(false);
    }
  }

  function handleNoteKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleNoteSubmit();
    }
    if (e.key === "Escape") {
      setIsAddingNote(false);
      setNoteText("");
    }
  }

  return (
    <article
      className={[
        "timeline-event",
        `timeline-event--${item.raw.type}`,
        isSelected ? "is-selected" : "",
        isEdited ? "is-edited" : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {/* ── Main row ─────────────────────────────────────────────── */}
      <div className="timeline-event__row-wrap">
        <button
          type="button"
          className="timeline-event__row"
          onClick={() => onSelect(item.id)}
        >
          <span className="timeline-event__timecode">
            {item.raw.sessionTimecode}
          </span>

          <span
            className={`event-glyph event-glyph--${item.raw.type}`}
            aria-hidden="true"
          >
            {producerEventIcon(item.raw.type)}
          </span>

          <span className="timeline-event__main">
            <span className="timeline-event__label">
              {presentation.categoryLabel}
            </span>

            {isEditingTitle ? (
              <input
                ref={titleInputRef}
                className="timeline-event__title-input"
                value={editTitleValue}
                onChange={(e) => setEditTitleValue(e.target.value)}
                onKeyDown={handleTitleKeyDown}
                onBlur={handleTitleSave}
                onClick={(e) => e.stopPropagation()}
                placeholder={presentation.title}
              />
            ) : (
              <strong
                className={item.edits.title ? "is-edited" : ""}
                title="Double-click to edit"
                onDoubleClick={handleTitleEditStart}
              >
                {displayTitle}
              </strong>
            )}

            {displayDetail && !isEditingTitle && (
              <small>{displayDetail}</small>
            )}
          </span>

          <span className="timeline-event__context">
            {presentation.contextLabel}
          </span>

          {item.notes.length > 0 && (
            <span
              className="timeline-event__note-badge"
              aria-label={`${item.notes.length} note${item.notes.length === 1 ? "" : "s"}`}
            >
              {item.notes.length}
            </span>
          )}
        </button>

        <button
          type="button"
          className="timeline-event__hide"
          title="Hide from timeline"
          aria-label="Hide this event"
          onClick={(e) => {
            e.stopPropagation();
            onHide(item.id);
          }}
        >
          Hide
        </button>
      </div>

      {/* ── Note input (shown when selected) ─────────────────────── */}
      {isSelected && !isEditingTitle && (
        <div className="timeline-event__actions-row">
          {!isAddingNote ? (
            <button
              type="button"
              className="timeline-event__add-note-btn"
              onClick={() => setIsAddingNote(true)}
            >
              + Add note
            </button>
          ) : (
            <div className="timeline-event__note-input-area">
              <textarea
                ref={noteTextareaRef}
                className="timeline-event__note-textarea"
                value={noteText}
                onChange={(e) => setNoteText(e.target.value)}
                onKeyDown={handleNoteKeyDown}
                placeholder="Note at this moment… (Enter to save, Shift+Enter for newline)"
                rows={2}
              />
              <div className="timeline-event__note-input-controls">
                <button
                  type="button"
                  className="note-btn note-btn--submit"
                  onClick={handleNoteSubmit}
                  disabled={!noteText.trim()}
                >
                  Add
                </button>
                <button
                  type="button"
                  className="note-btn note-btn--cancel"
                  onClick={() => {
                    setIsAddingNote(false);
                    setNoteText("");
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Details (metadata + instrument + notes) ──────────────── */}
      <details className="timeline-event__details">
        <summary>Details</summary>

        {instrument && (
          <div className="instrument-reference-card">
            <div>
              <span>Ableton Instrument</span>
              <strong>{instrument.name}</strong>
            </div>
            <p>{instrument.role}</p>
            <div className="instrument-reference-card__chips">
              <span>{instrument.family}</span>
              <span>{instrument.engine}</span>
              {instrument.focus.slice(0, 3).map((focus) => (
                <span key={focus}>{focus}</span>
              ))}
            </div>
            {instrument.performanceNote && (
              <small>{instrument.performanceNote}</small>
            )}
          </div>
        )}

        {presentation.metadataPills.length > 0 && (
          <div className="timeline-event__meta">
            {presentation.metadataPills.map((pill) => (
              <span key={pill.label}>
                {pill.label}: <strong>{pill.value}</strong>
              </span>
            ))}
          </div>
        )}

        {item.notes.length > 0 && (
          <div className="timeline-event__notes">
            {item.notes.map((note) => (
              <div key={note.id} className="timeline-note">
                <span className="timeline-note__timecode">
                  {note.sessionTimecode}
                </span>
                <p>{note.text}</p>
              </div>
            ))}
          </div>
        )}
      </details>
    </article>
  );
}
