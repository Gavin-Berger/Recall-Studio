import type { RecallTimelineMoment } from "./recall";

// The curated timeline layer sits on top of raw backend events.
// Raw events are immutable — they represent what Ableton reported.
// TimelineItem is what the user sees and can manipulate.

export type TimelineItemEdits = {
  title?: string;       // undefined = use raw presentation; string = user override
  description?: string; // undefined = use raw detail; string = user override
};

export type TimelineItem = {
  id: string;
  raw: RecallTimelineMoment;
  edits: TimelineItemEdits;
  isHidden: boolean;
  notes: SessionNote[];
  source: "captured" | "manual";
};

export type SessionNote = {
  id: string;
  text: string;
  createdAt: number;
  sessionTimecode: string;
  linkedEventId: string | null;
};

// ─── Curation actions ──────────────────────────────────────────────────────────

// Pass null to explicitly clear a field (revert to raw).
// Pass undefined or omit to leave the field unchanged.
export type EditItemPayload = {
  title?: string | null;
  description?: string | null;
};

export type AddNoteOptions = {
  linkedEventId?: string;
  sessionTimecode?: string;
};

export type TimelineCurationActions = {
  editItem: (id: string, payload: EditItemPayload) => void;
  hideItem: (id: string) => void;
  restoreItem: (id: string) => void;
  addNote: (text: string, options?: AddNoteOptions) => void;
  deleteNote: (noteId: string) => void;
  editNote: (noteId: string, text: string) => void;
};
