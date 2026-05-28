import { useMemo, useState } from "react";
import type { RecallTimelineMoment } from "../types/recall";
import type {
  AddNoteOptions,
  EditItemPayload,
  SessionNote,
  TimelineCurationActions,
  TimelineItem,
  TimelineItemEdits,
} from "../types/timeline";

// NOTE: Curation state is local (in-memory) only.
// Hidden items and edits do NOT persist across app restarts.
// Persistence requires backend support — wire it up when available.

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

export function useTimelineCuration(
  events: RecallTimelineMoment[],
): UseTimelineCurationReturn {
  const [itemCuration, setItemCuration] = useState<Map<string, ItemCuration>>(
    () => new Map(),
  );
  const [notes, setNotes] = useState<SessionNote[]>([]);

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

      next.set(id, { ...existing, edits: newEdits });
      return next;
    });
  }

  function hideItem(id: string) {
    setItemCuration((prev) => {
      const next = new Map(prev);
      const existing = next.get(id) ?? { edits: {}, isHidden: false };
      next.set(id, { ...existing, isHidden: true });
      return next;
    });
  }

  function restoreItem(id: string) {
    setItemCuration((prev) => {
      const next = new Map(prev);
      const existing = next.get(id) ?? { edits: {}, isHidden: false };
      next.set(id, { ...existing, isHidden: false });
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
  }

  function deleteNote(noteId: string) {
    setNotes((prev) => prev.filter((n) => n.id !== noteId));
  }

  function editNote(noteId: string, text: string) {
    setNotes((prev) =>
      prev.map((n) => (n.id === noteId ? { ...n, text: text.trim() } : n)),
    );
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
