const dgram = require("dgram");

const client = dgram.createSocket("udp4");

const HOST = "127.0.0.1";
const PORT = 9000;

function nowMs() {
  return Date.now();
}

function sendRecallEvent(event) {
  const message = Buffer.from(JSON.stringify(event));

  client.send(message, PORT, HOST, (error) => {
    if (error) {
      console.error("Failed to send event:", error);
      return;
    }

    console.log(`sent: ${event.event_type} - ${event.title}`);
  });
}

function createEvent(eventType, title, description, payload = null) {
  return {
    protocol: "recall.v1",
    source: "test_sender",
    event_type: eventType,
    timestamp_ms: nowMs(),
    title,
    description,
    payload: payload ? JSON.stringify(payload) : null,
  };
}

// Keeps connection alive
setInterval(() => {
  sendRecallEvent(
    createEvent(
      "heartbeat",
      "Heartbeat Received",
      "Recall Studio test sender is still connected.",
      {
        device: "RecallStudioDevice",
        version: "1.0.0",
      }
    )
  );
}, 2000);

// Test timeline events
const testEvents = [
  createEvent(
    "session_started",
    "Session Started",
    "Producer session started in Ableton Live.",
    {
      project_name: "Dubstep Idea 001",
      daw: "Ableton Live",
    }
  ),

  createEvent(
    "transport_play",
    "Playback Started",
    "Ableton transport playback started.",
    {
      state: "playing",
    }
  ),

  createEvent(
    "tempo_changed",
    "Tempo Changed",
    "Tempo changed to 140 BPM.",
    {
      bpm: 140,
      previous_bpm: 128,
    }
  ),

  createEvent(
    "track_selected",
    "Track Selected",
    "Selected track changed to Bass Group.",
    {
      track_name: "Bass Group",
      track_index: 4,
    }
  ),

  createEvent(
    "device_selected",
    "Device Selected",
    "Selected device changed to Serum.",
    {
      track_name: "Bass Group",
      device_name: "Serum",
    }
  ),

  createEvent(
    "parameter_changed",
    "Parameter Changed",
    "Serum wavetable position was adjusted.",
    {
      track_name: "Bass Group",
      device_name: "Serum",
      parameter_name: "WT Pos",
      value: 0.72,
    }
  ),

  createEvent(
    "clip_launched",
    "Clip Launched",
    "Bass loop clip was launched.",
    {
      track_name: "Bass Group",
      clip_name: "Bass Loop A",
      scene_index: 1,
    }
  ),

  createEvent(
    "automation_changed",
    "Automation Changed",
    "Filter cutoff automation was edited.",
    {
      track_name: "Bass Group",
      device_name: "Auto Filter",
      parameter_name: "Frequency",
      min_value: 220,
      max_value: 8500,
    }
  ),

  createEvent(
    "file_changed",
    "Project File Changed",
    "Ableton project file was modified.",
    {
      file_name: "Dubstep Idea 001.als",
      change_type: "modified",
    }
  ),

  createEvent(
    "session_marker",
    "Creative Decision",
    "Producer changed direction from intro sound design to bass arrangement.",
    {
      marker_type: "creative_decision",
      note: "Moved from sound design into arranging drop section.",
    }
  ),
];

let eventIndex = 0;

setInterval(() => {
  const event = testEvents[eventIndex];

  // Refresh timestamp before sending
  event.timestamp_ms = nowMs();

  sendRecallEvent(event);

  eventIndex = (eventIndex + 1) % testEvents.length;
}, 3000);