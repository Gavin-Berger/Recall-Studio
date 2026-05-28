import type { PlaybackState, RecallTimelineMoment, SessionViewMode } from "../../types/recall";

// Transport state tracks the current playback context — what Ableton is doing right now.
// It is derived from ALL events in the stream (including transport_snapshot heartbeats)
// because we always want the most current tempo, position, and play state.
//
// Transport state is NOT the creative timeline. It updates continuously.
// The creative timeline only records deliberate actions — see creativeTimeline.ts.

export const EMPTY_TRANSPORT_STATE: PlaybackState = {
  playing: null,
  tempo: null,
  projectClock: null,
  arrangementPosition: null,
  rawSongTime: null,
  selectedTrack: null,
  lastUpdatedAt: null,
};

export function deriveTransportFromEvents(events: RecallTimelineMoment[]): PlaybackState {
  return events.reduce<PlaybackState>((state, event) => {
    const playing = readMetadataBoolean(event, "playing");
    const tempo = readMetadataNumber(event, "bpm");
    const rawSongTime = readMetadataNumber(event, "songTime");
    const projectTimeSeconds = readMetadataNumber(event, "projectTimeSeconds");
    const selectedTrack = readMetadataString(event, "track");

    return {
      playing: typeof playing === "boolean" ? playing : state.playing,
      tempo: typeof tempo === "number" ? tempo : state.tempo,
      projectClock:
        typeof projectTimeSeconds === "number"
          ? formatProjectClock(projectTimeSeconds)
          : state.projectClock,
      arrangementPosition:
        typeof rawSongTime === "number"
          ? formatArrangementPosition(rawSongTime)
          : state.arrangementPosition,
      rawSongTime: typeof rawSongTime === "number" ? rawSongTime : state.rawSongTime,
      selectedTrack: selectedTrack ?? state.selectedTrack,
      lastUpdatedAt:
        event.type === "transport" || event.type === "tempo" || selectedTrack
          ? event.timestamp
          : state.lastUpdatedAt,
    };
  }, EMPTY_TRANSPORT_STATE);
}

export function deriveCaptureDuration(
  events: RecallTimelineMoment[],
  viewMode: SessionViewMode,
): string {
  if (events.length === 0) return "0:00";

  const timestamps = events.map((e) => e.timestamp).filter((t) => Number.isFinite(t));
  const first = Math.min(...timestamps);
  const last = viewMode === "live" ? Date.now() : Math.max(...timestamps);

  if (!Number.isFinite(first) || !Number.isFinite(last)) return "0:00";

  return formatProjectClock((last - first) / 1000);
}

export function formatProjectClock(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(safe / 3600);
  const m = Math.floor((safe % 3600) / 60);
  const s = safe % 60;

  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export function formatArrangementPosition(songTime: number): string {
  const safe = Math.max(0, songTime);
  const beatsPerBar = 4;
  const bar = Math.floor(safe / beatsPerBar) + 1;
  const beat = Math.floor(safe % beatsPerBar) + 1;
  const sub = safe % 1;

  return sub > 0.05
    ? `Bar ${bar} Beat ${beat}.${Math.round(sub * 100)}`
    : `Bar ${bar} Beat ${beat}`;
}

export function convertAbletonBeatsToSeconds(beats: number, bpm?: number): number {
  if (typeof bpm === "number" && bpm > 0) {
    return beats / (bpm / 60);
  }
  return beats;
}

// Shared metadata readers — used by both transport derivation and creative timeline filtering.

export function readMetadataNumber(event: RecallTimelineMoment, key: string): number | null {
  const v = event.metadata?.[key];
  return typeof v === "number" ? v : null;
}

export function readMetadataString(event: RecallTimelineMoment, key: string): string | null {
  const v = event.metadata?.[key];
  return typeof v === "string" && v.trim() ? v : null;
}

export function readMetadataBoolean(event: RecallTimelineMoment, key: string): boolean | null {
  const v = event.metadata?.[key];
  return typeof v === "boolean" ? v : null;
}

function pad(n: number): string {
  return n.toString().padStart(2, "0");
}
