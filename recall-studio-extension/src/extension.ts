import { initialize, type ActivationContext } from "@ableton-extensions/sdk";
import * as dgram from "node:dgram";

// Extensions run in Node.js, so Node's dgram UDP module works directly.
const RECALL_HOST = "127.0.0.1";
const RECALL_PORT = 9000;

type RecallEvent = {
  protocol: "recall.v1";
  source: "ableton_extension_sdk";
  event_type: string;
  timestamp_ms: number;
  title: string;
  description: string;
  payload?: string;
};

function sendEvent(event: RecallEvent): void {
  const socket = dgram.createSocket("udp4");
  const message = Buffer.from(JSON.stringify(event));
  socket.send(message, RECALL_PORT, RECALL_HOST, (err) => {
    socket.close();
    if (err) {
      console.error(`[recall-studio] UDP send failed: ${err.message}`);
    }
  });
}

function makeEvent(
  event_type: string,
  title: string,
  description: string,
  payload?: Record<string, unknown>,
): RecallEvent {
  return {
    protocol: "recall.v1",
    source: "ableton_extension_sdk",
    event_type,
    timestamp_ms: Date.now(),
    title,
    description,
    ...(payload !== undefined
      ? { payload: JSON.stringify(payload) }
      : undefined),
  };
}

export function activate(activation: ActivationContext) {
  const api = initialize(activation, "1.0.0");

  // Send extension_loaded immediately on activation.
  sendEvent(
    makeEvent(
      "extension_loaded",
      "Recall Studio Extension Loaded",
      "The Recall Studio Ableton Extension SDK bridge is active.",
      { extension: "recall-studio-extension", status: "ok" },
    ),
  );

  // Read the song and send a snapshot + the test event.
  const song = api.application.song;
  const tempo = song.tempo;
  const trackNames = song.tracks.map((t) => t.name);

  sendEvent(
    makeEvent(
      "extension_test",
      "Ableton Extension Connected",
      "Recall Studio received a test event from the Ableton Extensions SDK.",
      { extension: "recall-studio-extension", status: "ok" },
    ),
  );

  sendEvent(
    makeEvent(
      "live_set_snapshot",
      "Live Set Snapshot",
      `Captured Live Set: ${trackNames.length} tracks at ${tempo} BPM.`,
      {
        tempo,
        track_count: trackNames.length,
        track_names: trackNames,
      },
    ),
  );

  console.log(
    `[recall-studio] Extension loaded. Sent snapshot: ${trackNames.length} tracks at ${tempo} BPM.`,
  );

  // Register a context menu action on any Track so the user can manually
  // trigger a snapshot from the Live UI.
  api.commands.registerCommand(
    "recallStudio.sendSnapshot",
    () => {
      const s = api.application.song;
      const snapshotTracks = s.tracks.map((t) => t.name);

      sendEvent(
        makeEvent(
          "live_set_snapshot",
          "Live Set Snapshot (Manual)",
          `Manual snapshot: ${snapshotTracks.length} tracks at ${s.tempo} BPM.`,
          {
            tempo: s.tempo,
            track_count: snapshotTracks.length,
            track_names: snapshotTracks,
          },
        ),
      );

      console.log("[recall-studio] Manual snapshot sent.");
    },
  );

  // Register on both track types since "Track" is not a valid scope.
  api.ui.registerContextMenuAction(
    "AudioTrack",
    "Send Snapshot to Recall Studio",
    "recallStudio.sendSnapshot",
  );
  api.ui.registerContextMenuAction(
    "MidiTrack",
    "Send Snapshot to Recall Studio",
    "recallStudio.sendSnapshot",
  );
}
