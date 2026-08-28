import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "../../lib/schema/api";
import { LoadingSpinner } from "../../components/LoadingSpinner";

// A producer notebook: free-form documents that live outside any one session or
// take — lyric ideas, mix checklists, reference notes, arrangement plans. One
// list of notes on the left, a document-style writing page on the right.
//
// Storage: localStorage for now (same tier as the producer name). Good enough
// for a notebook v1; moving notes into SQLite alongside sessions is the durable
// follow-up so they survive profile resets and can sync with take history.

export type NoteDoc = {
  id: string;
  title: string;
  body: string;
  created_at_ms: number;
  updated_at_ms: number;
};

const NOTES_STORAGE_KEY = "recall-studio.notes.v1";
const AUTOSAVE_DELAY_MS = 400;

function loadNotes(): NoteDoc[] {
  try {
    const raw = window.localStorage.getItem(NOTES_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (note): note is NoteDoc =>
        typeof note === "object" &&
        note !== null &&
        typeof note.id === "string" &&
        typeof note.body === "string",
    );
  } catch {
    return [];
  }
}

function persistNotes(notes: NoteDoc[]) {
  try {
    window.localStorage.setItem(NOTES_STORAGE_KEY, JSON.stringify(notes));
  } catch {
    // Storage can be full or unavailable; the in-memory copy still works and
    // the next successful write will catch up.
  }
}

function formatNoteDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function wordCount(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean);
  return words.length;
}

export function NotesScreen() {
  const [notes, setNotes] = useState<NoteDoc[]>(loadNotes);
  const [selectedId, setSelectedId] = useState<string | null>(() => loadNotes()[0]?.id ?? null);
  const [query, setQuery] = useState("");
  const [saveState, setSaveState] = useState<"saved" | "saving">("saved");
  const [exportError, setExportError] = useState<string | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const saveTimer = useRef<number | null>(null);

  // Newest-touched notes first, like a stack of pages on a desk.
  const ordered = useMemo(
    () => [...notes].sort((a, b) => b.updated_at_ms - a.updated_at_ms),
    [notes],
  );
  const selected = ordered.find((note) => note.id === selectedId) ?? ordered[0] ?? null;
  const visibleNotes = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return ordered;
    return ordered.filter((note) =>
      `${note.title}\n${note.body}`.toLocaleLowerCase().includes(needle),
    );
  }, [ordered, query]);

  // Debounced autosave: every edit lands in localStorage shortly after the
  // producer stops typing, and the header says so.
  useEffect(() => {
    setSaveState("saving");
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      persistNotes(notes);
      setSaveState("saved");
      saveTimer.current = null;
    }, AUTOSAVE_DELAY_MS);
    return () => {
      if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    };
  }, [notes]);

  // Flush pending edits if the page unmounts mid-debounce.
  const latestNotes = useRef(notes);
  latestNotes.current = notes;
  useEffect(() => {
    return () => persistNotes(latestNotes.current);
  }, []);

  const updateSelected = useCallback(
    (patch: Partial<Pick<NoteDoc, "title" | "body">>) => {
      if (!selected) return;
      const now = Date.now();
      setNotes((prev) =>
        prev.map((note) =>
          note.id === selected.id ? { ...note, ...patch, updated_at_ms: now } : note,
        ),
      );
    },
    [selected],
  );

  function handleNewNote() {
    const now = Date.now();
    const note: NoteDoc = {
      id: `note-${now}`,
      title: "",
      body: "",
      created_at_ms: now,
      updated_at_ms: now,
    };
    setNotes((prev) => [note, ...prev]);
    setSelectedId(note.id);
    window.setTimeout(() => titleRef.current?.focus(), 0);
  }

  function handleDelete(note: NoteDoc) {
    const label = note.title.trim() || "Untitled note";
    const confirmed = window.confirm(`Delete "${label}"? This cannot be undone.`);
    if (!confirmed) return;
    setNotes((prev) => prev.filter((candidate) => candidate.id !== note.id));
    if (selectedId === note.id) setSelectedId(null);
  }

  async function handleExport() {
    if (!selected) return;
    setExportError(null);
    const stem = (selected.title.trim() || "note").replace(/[\\/:*?"<>|]/g, "-");
    try {
      const path = await save({
        title: "Export note",
        defaultPath: `${stem}.md`,
        filters: [
          { name: "Markdown", extensions: ["md"] },
          { name: "Text", extensions: ["txt"] },
        ],
      });
      if (!path) return;
      const heading = selected.title.trim();
      const contents = heading ? `# ${heading}\n\n${selected.body}` : selected.body;
      await writeTextFile(path, contents);
    } catch (error) {
      setExportError(String(error));
    }
  }

  return (
    <div className="notes">
      <aside className="notes__list" aria-label="Notes">
        <div className="notes__list-head">
          <span className="eyebrow">Notebook</span>
          <button type="button" className="px-btn px-btn--primary" onClick={handleNewNote}>
            New note
          </button>
        </div>

        {ordered.length > 0 && (
          <div className="notes__search">
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape" && query) {
                  event.preventDefault();
                  setQuery("");
                }
              }}
              placeholder="Find a note"
              aria-label="Find a note"
            />
            {query && (
              <button type="button" onClick={() => setQuery("")} aria-label="Clear note search" title="Clear search">
                ×
              </button>
            )}
          </div>
        )}

        {ordered.length === 0 ? (
          <p className="notes__list-empty">
            Lyric ideas, mix checklists, things to try next session — notes live here, outside any
            one take.
          </p>
        ) : visibleNotes.length === 0 ? (
          <div className="notes__list-empty">
            <p>No notes match “{query}”.</p>
            <button type="button" onClick={() => setQuery("")}>Clear search</button>
          </div>
        ) : (
          <div className="notes__items">
            {visibleNotes.map((note) => (
              <button
                key={note.id}
                type="button"
                className={`notes__item ${selected?.id === note.id ? "is-selected" : ""}`}
                onClick={() => setSelectedId(note.id)}
              >
                <span className="notes__item-title">{note.title.trim() || "Untitled note"}</span>
                <span className="notes__item-meta">
                  {formatNoteDate(note.updated_at_ms)}
                  {note.body.trim() && ` · ${wordCount(note.body)} words`}
                </span>
              </button>
            ))}
          </div>
        )}
      </aside>

      {selected ? (
        <section className="notes__page" aria-label="Note editor">
          <div className="notes__page-bar">
            <span
              className={`notes__save ${saveState === "saved" ? "is-saved" : ""} ${saveState === "saving" ? "px-loading-inline" : ""}`}
              role={saveState === "saving" ? "status" : undefined}
            >
              {saveState === "saving" && <LoadingSpinner />}
              {saveState === "saved" ? "Saved" : "Saving…"}
            </span>
            <div className="notes__page-actions">
              <button type="button" className="px-btn" onClick={() => void handleExport()}>
                Export…
              </button>
              <button
                type="button"
                className="px-btn px-btn--danger"
                onClick={() => handleDelete(selected)}
              >
                Delete
              </button>
            </div>
          </div>

          {exportError && <p className="notes__error">{exportError}</p>}

          <div className="notes__sheet">
            <input
              ref={titleRef}
              className="notes__title"
              value={selected.title}
              placeholder="Untitled note"
              aria-label="Note title"
              onChange={(event) => updateSelected({ title: event.target.value })}
            />
            <textarea
              className="notes__body"
              value={selected.body}
              placeholder="Write anything — it saves as you type."
              aria-label="Note body"
              onChange={(event) => updateSelected({ body: event.target.value })}
            />
            <div className="notes__foot">
              <span>{wordCount(selected.body)} words</span>
              <span>Started {formatNoteDate(selected.created_at_ms)}</span>
            </div>
          </div>
        </section>
      ) : (
        <section className="notes__page notes__page--empty">
          <div className="notes__blank">
            <strong>Your notebook is empty.</strong>
            <p>Keep session notes, lyric sketches, and mix reminders here — they save as you type.</p>
            <button type="button" className="px-btn px-btn--primary" onClick={handleNewNote}>
              Start a note
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
