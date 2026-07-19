// A small, app-wide record of things that went wrong.
//
// Screens show an error and then clear it — which is right for the producer, but
// it means by the time they think "I should report this", the evidence is gone.
// This keeps the last N problems in memory so a report can carry real detail
// instead of "something broke earlier".
//
// In-memory only and never written to disk on its own: it leaves the machine
// only when the producer explicitly copies or saves a report (PRD §9).

import { useSyncExternalStore } from "react";

export type LoggedError = {
  id: string;
  at_ms: number;
  /** Which part of the app it came from, e.g. "Organizer". */
  scope: string;
  /** The plain-language message the producer saw. */
  message: string;
  /** The underlying cause, when we have one. This is the bit that makes a
   *  report actionable — a message alone rarely says what actually failed. */
  detail?: string;
};

const MAX_ERRORS = 50;

// Replaced (never mutated) so useSyncExternalStore sees a stable reference
// between changes and doesn't re-render in a loop.
let errors: LoggedError[] = [];
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

/** Normalize whatever was thrown into something readable in a report. */
export function describeCause(cause: unknown): string | undefined {
  if (cause === undefined || cause === null) return undefined;
  if (typeof cause === "string") return cause.trim() || undefined;
  if (cause instanceof Error) {
    return cause.stack?.trim() || `${cause.name}: ${cause.message}`;
  }
  try {
    return JSON.stringify(cause);
  } catch {
    return String(cause);
  }
}

export function recordError(scope: string, message: string, cause?: unknown): void {
  const entry: LoggedError = {
    id: `err-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    at_ms: Date.now(),
    scope,
    message,
    detail: describeCause(cause),
  };
  // Newest last, oldest trimmed — a report reads like a timeline.
  errors = [...errors, entry].slice(-MAX_ERRORS);
  emit();
}

export function getLoggedErrors(): LoggedError[] {
  return errors;
}

export function clearLoggedErrors(): void {
  if (errors.length === 0) return;
  errors = [];
  emit();
}

export function subscribeToErrorLog(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useErrorLog(): LoggedError[] {
  return useSyncExternalStore(subscribeToErrorLog, getLoggedErrors, getLoggedErrors);
}
