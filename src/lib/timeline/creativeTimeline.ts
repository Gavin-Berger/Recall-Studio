import type { RecallTimelineMoment } from "../../types/recall";
import { isProducerTimelineEvent } from "../../utils/producerEvents";
import { readMetadataBoolean, readMetadataNumber, readMetadataString } from "../transport/transportState";

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
//   - Track selection, device activity, parameter changes, clip launches,
//     scene triggers, mixer changes, arrangement edits.
//   - Explicit transport play/stop events — these are intentional decisions.
//   - Explicit tempo change events — also intentional decisions.
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

  for (const event of events) {
    if (event.type === "heartbeat") {
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

    output.push(event);

    const playing = readMetadataBoolean(event, "playing");
    const tempo = readMetadataNumber(event, "bpm");
    const track = readMetadataString(event, "track");

    if (typeof playing === "boolean") previousPlaying = playing;
    if (typeof tempo === "number") previousTempo = tempo;
    if (track) previousTrack = track;
  }

  return output;
}
