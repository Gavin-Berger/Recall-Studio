import type { RecallTimelineMoment } from "../../types/recall";
import { isProducerTimelineEvent } from "../../utils/producerEvents";
import { readMetadataBoolean, readMetadataNumber, readMetadataString } from "../transport/transportState";

// Window within which a device_chain_changed is treated as the redundant echo of
// a device add/remove on the same track (the bridge emits both at the same tick).
const DEVICE_CHAIN_DEDUP_MS = 2000;

// Rules for what appears in the creative timeline:
//
// NEVER included:
//   - Heartbeat events (health signals, not creative actions)
//   - Noise events (screenshots, debug, polls — filtered by isProducerTimelineEvent)
//
// CONDITIONALLY included (context/snapshot events):
//   - transport_snapshot, live_set_snapshot, etc. — only if a meaningful state
//     change occurred: play state toggled, tempo shifted, or track changed.
//     Identical snapshots are de-duplicated to prevent continuous updates from
//     appearing as timeline entries.
//
// ALWAYS included (deliberate creative actions):
//   - Track lifecycle (created, deleted, renamed, muted, armed).
//   - Device activity (added, removed, chain changed).
//   - Clip activity, scene triggers, arrangement edits.
//   - Tempo changes — intentional decisions.
//
// NEVER included:
//   - Transport play/stop — too frequent, not a creative signal.
//
// This boundary is the contract between raw telemetry and the curated timeline.
// Do not relax these rules without updating the comment above.

export function buildCreativeTimeline(
  events: RecallTimelineMoment[],
): RecallTimelineMoment[] {
  const output: RecallTimelineMoment[] = [];
  let previousPlaying: boolean | null = null;
  let previousTempo: number | null = null;
  let previousTrack: string | null = null;
  // Track the most recent device add/remove so we can drop the chain-change echo
  // that immediately follows it on the same track.
  let lastDeviceEditTrack: string | null = null;
  let lastDeviceEditTime = 0;

  for (const event of events) {
    if (event.type === "heartbeat") {
      continue;
    }

    // Play/stop is not a creative decision — producers do it thousands of times
    // per session. Keep it in the DB for analytics (playback count) but never
    // show it in the curated timeline.
    if (event.timelineRole === "transport") {
      const playing = readMetadataBoolean(event, "playing");
      if (typeof playing === "boolean") previousPlaying = playing;
      continue;
    }

    if (event.timelineRole === "context") {
      const playing = readMetadataBoolean(event, "playing");
      const tempo = readMetadataNumber(event, "bpm");
      const track = readMetadataString(event, "track");

      const playingChanged =
        typeof playing === "boolean" &&
        previousPlaying !== null &&
        playing !== previousPlaying;
      const tempoChanged =
        typeof tempo === "number" && previousTempo !== null && tempo !== previousTempo;
      const trackChanged = Boolean(track && previousTrack && track !== previousTrack);

      previousPlaying = typeof playing === "boolean" ? playing : previousPlaying;
      previousTempo = typeof tempo === "number" ? tempo : previousTempo;
      previousTrack = track ?? previousTrack;

      if (!playingChanged && !tempoChanged && !trackChanged) {
        continue;
      }
    }

    if (!isProducerTimelineEvent(event)) {
      continue;
    }

    const rawType = event.rawEventType?.toLowerCase();
    const eventTrack = event.trackName ?? readMetadataString(event, "track") ?? null;

    // Collapse the redundant "Reworked the chain" the bridge emits alongside a
    // device add/remove. Adding Serum 2 fires BOTH device_added and
    // device_chain_changed at the same instant — two rows for one action. If a
    // chain change lands right after an add/remove on the same track, the
    // add/remove already tells the story, so drop the chain echo. A standalone
    // chain rework (reordering, or one not tied to a recent add/remove) still
    // shows because the track/window won't match.
    if (
      rawType === "device_chain_changed" &&
      lastDeviceEditTrack !== null &&
      eventTrack === lastDeviceEditTrack &&
      event.timestamp - lastDeviceEditTime <= DEVICE_CHAIN_DEDUP_MS
    ) {
      continue;
    }

    output.push(event);

    if (rawType === "device_added" || rawType === "device_removed") {
      lastDeviceEditTrack = eventTrack;
      lastDeviceEditTime = event.timestamp;
    }

    const playing = readMetadataBoolean(event, "playing");
    const tempo = readMetadataNumber(event, "bpm");
    const track = readMetadataString(event, "track");

    if (typeof playing === "boolean") previousPlaying = playing;
    if (typeof tempo === "number") previousTempo = tempo;
    if (track) previousTrack = track;
  }

  return output;
}
