import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { RecallTimelineMoment } from "../types/recall";
import type {
  AddNoteOptions,
  EditItemPayload,
  SessionNote,
  TimelineCurationActions,
  TimelineItem,
  TimelineItemEdits,
} from "../types/timeline";

// Curation (edits, hidden state, notes) is persisted per session in SQLite via
// the Rust backend. It is keyed by (sessionId, eventId). Saved sessions have
// stable rowid-backed event IDs, so curation rehydrates reliably on reload.
// Live-mode event IDs are positional and ephemeral, so curation is only
// persisted when a sessionId is supplied (review/saved surface).

type ItemCuration = {
  edits: TimelineItemEdits;
  isHidden: boolean;
};

type UseTimelineCurationReturn = {
  allItems: TimelineItem[];
  visibleItems: TimelineItem[];
  freeNotes: SessionNote[];
  actions: TimelineCurationActions;
};

type BackendEventCuration = {
  event_id: string;
  hidden: boolean;
  title_override: string | null;
  description_override: string | null;
};

type BackendSessionNote = {
  id: string;
  linked_event_id: string | null;
  text: string;
  session_timecode: string;
  created_at_ms: number;
};

type BackendSessionCuration = {
  curations: BackendEventCuration[];
  notes: BackendSessionNote[];
};

export function useTimelineCuration(
  events: RecallTimelineMoment[],
  sessionId: string | null,
): UseTimelineCurationReturn {
  const [itemCuration, setItemCuration] = useState<Map<string, ItemCuration>>(
    () => new Map(),
  );
  const [notes, setNotes] = useState<SessionNote[]>([]);

  // Hydrate curation from the backend whenever the session changes.
  useEffect(() => {
    let cancelled = false;

    if (!sessionId) {
      setItemCuration(new Map());
      setNotes([]);
      return;
    }

    async function hydrate(id: string) {
      try {
        const result = await invoke<BackendSessionCuration>(
          "list_session_curation",
          { sessionId: id },
        );
        if (cancelled) return;

        const map = new Map<string, ItemCuration>();
        for (const c of result.curations) {
          const edits: TimelineItemEdits = {};
          if (c.title_override !== null) edits.title = c.title_override;
          if (c.description_override !== null)
            edits.description = c.description_override;
          map.set(c.event_id, { edits, isHidden: c.hidden });
        }
        setItemCuration(map);

        setNotes(
          result.notes.map((n) => ({
            id: n.id,
            text: n.text,
            createdAt: n.created_at_ms,
            sessionTimecode: n.session_timecode,
            linkedEventId: n.linked_event_id,
          })),
        );
      } catch (error) {
        console.error("Failed to load session curation:", error);
      }
    }

    hydrate(sessionId);

    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  const allItems = useMemo<TimelineItem[]>(() => {
    return events.map((event) => {
      const curation = itemCuration.get(event.id) ?? {
        edits: {},
        isHidden: false,
      };

      return {
        id: event.id,
        raw: event,
        edits: curation.edits,
        isHidden: curation.isHidden,
        notes: notes.filter((n) => n.linkedEventId === event.id),
        source: "captured" as const,
      };
    });
  }, [events, itemCuration, notes]);

  const visibleItems = useMemo(
    () => allItems.filter((item) => !item.isHidden),
    [allItems],
  );

  const freeNotes = useMemo(
    () => notes.filter((n) => n.linkedEventId === null),
    [notes],
  );

  function persistCuration(id: string, curation: ItemCuration) {
    if (!sessionId) return;
    invoke("set_event_curation", {
      sessionId,
      eventId: id,
      hidden: curation.isHidden,
      titleOverride: curation.edits.title ?? null,
      descriptionOverride: curation.edits.description ?? null,
    }).catch((error) => console.error("Failed to persist curation:", error));
  }

  function editItem(id: string, payload: EditItemPayload) {
    setItemCuration((prev) => {
      const next = new Map(prev);
      const existing = next.get(id) ?? { edits: {}, isHidden: false };
      const newEdits: TimelineItemEdits = { ...existing.edits };

      // null = clear the field (revert to raw); string = set override; undefined = no change
      if (payload.title === null) {
        delete newEdits.title;
      } else if (payload.title !== undefined) {
        newEdits.title = payload.title;
      }

      if (payload.description === null) {
        delete newEdits.description;
      } else if (payload.description !== undefined) {
        newEdits.description = payload.description;
      }

      const updated = { ...existing, edits: newEdits };
      next.set(id, updated);
      persistCuration(id, updated);
      return next;
    });
  }

  function hideItem(id: string) {
    setItemCuration((prev) => {
      const next = new Map(prev);
      const existing = next.get(id) ?? { edits: {}, isHidden: false };
      const updated = { ...existing, isHidden: true };
      next.set(id, updated);
      persistCuration(id, updated);
      return next;
    });
  }

  function restoreItem(id: string) {
    setItemCuration((prev) => {
      const next = new Map(prev);
      const existing = next.get(id) ?? { edits: {}, isHidden: false };
      const updated = { ...existing, isHidden: false };
      next.set(id, updated);
      persistCuration(id, updated);
      return next;
    });
  }

  function addNote(text: string, options?: AddNoteOptions) {
    const note: SessionNote = {
      id: `note-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      text: text.trim(),
      createdAt: Date.now(),
      sessionTimecode: options?.sessionTimecode ?? "0:00",
      linkedEventId: options?.linkedEventId ?? null,
    };
    setNotes((prev) => [...prev, note]);

    if (sessionId) {
      invoke("add_session_note", {
        sessionId,
        noteId: note.id,
        linkedEventId: note.linkedEventId,
        text: note.text,
        sessionTimecode: note.sessionTimecode,
        createdAtMs: note.createdAt,
      }).catch((error) => console.error("Failed to persist note:", error));
    }
  }

  function deleteNote(noteId: string) {
    setNotes((prev) => prev.filter((n) => n.id !== noteId));

    if (sessionId) {
      invoke("delete_session_note", { noteId }).catch((error) =>
        console.error("Failed to delete note:", error),
      );
    }
  }

  function editNote(noteId: string, text: string) {
    const trimmed = text.trim();
    setNotes((prev) =>
      prev.map((n) => (n.id === noteId ? { ...n, text: trimmed } : n)),
    );

    if (sessionId) {
      invoke("update_session_note", { noteId, text: trimmed }).catch((error) =>
        console.error("Failed to update note:", error),
      );
    }
  }

  const actions: TimelineCurationActions = {
    editItem,
    hideItem,
    restoreItem,
    addNote,
    deleteNote,
    editNote,
  };

  return { allItems, visibleItems, freeNotes, actions };
}
