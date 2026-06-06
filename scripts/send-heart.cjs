// send-heart.js
// Simulates an Ableton session over UDP for demo/debugging without Max for Live.
// Plays through a realistic sequence of events: bridge start, track selection,
// playback, tempo change, device edits, then stop.
//
// Usage:
//   node scripts/send-heart.js
//   node scripts/send-heart.js --port 9000

const dgram = require("dgram");

const args = process.argv.slice(2);
const get = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : fallback;
};

const PORT = Number(get("--port", 9000));
const HOST = "127.0.0.1";

const socket = dgram.createSocket("udp4");
let sequence = 0;

function send(eventType, title, description, payload, fields = {}) {
  sequence++;

  const event = {
    protocol: "recall.v2",
    source: "max_for_live",
    event_type: eventType,
    timestamp_ms: Date.now(),
    title,
    description,
    payload: {
      ...payload,
      _bridge: { device_id: "recall-m4l-bridge-dev", bridge_version: "0.7.3-node-sim", sequence },
    },
    session_id: null,
    ...fields,
  };

  const json = JSON.stringify(event);
  const buf = Buffer.from(json);

  socket.send(buf, PORT, HOST, (err) => {
    if (err) console.error(`send error: ${err.message}`);
    else console.log(`  → ${eventType} #${sequence}`);
  });
}

// Helpers
function heartbeat() {
  send("heartbeat", "Heartbeat Received", "Heartbeat received from the Max for Live bridge.",
    { status: "alive", bridge_running: true, bridge_version: "0.7.3-node-sim" });
}

function selectTrack(name, deviceChain, devices, clips) {
  send("track_selected", "Track Selected", "Selected Ableton track changed.",
    { selected_track_name: name },
    { track_name: name });

  send("selected_track_focus_snapshot", "Selected Track Focus Snapshot",
    "Focused detail captured for the currently selected Ableton track.",
    { available: true, name, device_chain: deviceChain, devices, clips },
    { track_name: name, device_chain: deviceChain });
}

function play(bpm, trackName) {
  send("transport_play", "Playback Started", "Ableton playback started.",
    { playing: true, tempo: bpm, selected_track_name: trackName },
    { playing: true, bpm, track_name: trackName });
}

function stop(bpm, trackName) {
  send("transport_stop", "Playback Stopped", "Ableton playback stopped.",
    { playing: false, tempo: bpm, selected_track_name: trackName },
    { playing: false, bpm, track_name: trackName });
}

function tempoChange(from, to) {
  send("tempo_changed", "Tempo Changed", "Ableton tempo changed.",
    { tempo: to, previous_tempo: from },
    { bpm: to });
}

function deviceAdded(trackName, deviceName, chain) {
  send("device_added", "Device Added", "A device was added to the selected track.",
    { track_name: trackName, device_name: deviceName, device_chain: chain },
    { track_name: trackName, device_name: deviceName, device_chain: chain });
}

function chainChanged(trackName, chain) {
  send("device_chain_changed", "Signal Chain Changed", "The device chain on the selected track changed.",
    { track_name: trackName, device_chain: chain },
    { track_name: trackName, device_chain: chain });
}

function clipCreated(trackName, clipName) {
  send("clip_created", "Clip Created", "A clip was created on the selected track.",
    { track_name: trackName, clip_name: clipName },
    { track_name: trackName, clip_name: clipName });
}

// ── Demo sequence ─────────────────────────────────────────────────────────────

const steps = [
  [0,    () => { console.log("\n[bridge starts]");
                  send("bridge_started", "Ableton Bridge Started", "The Max for Live bridge started sending telemetry.", { status: "running" }); }],
  [800,  () => { console.log("\n[select Drums track]");
                  selectTrack("Drums", "Drum Rack", [{ index: 0, name: "Drum Rack", is_active: true }], []); }],
  [2000, () => { console.log("\n[select Bass track]");
                  selectTrack("Bass", "Operator : Saturator",
                    [{ index: 0, name: "Operator", is_active: true }, { index: 1, name: "Saturator", is_active: true }],
                    [{ slot_index: 0, clip_id: 101, name: "Bass Intro", is_midi_clip: true }]); }],
  [3500, () => { console.log("\n[play at 120 bpm]");  play(120, "Bass"); }],
  [5500, () => { console.log("\n[tempo bump to 124]"); tempoChange(120, 124); }],
  [7000, () => { console.log("\n[add Reverb to Bass]");
                  deviceAdded("Bass", "Reverb", "Operator : Saturator : Reverb");
                  chainChanged("Bass", "Operator : Saturator : Reverb"); }],
  [9000, () => { console.log("\n[select Lead Synth track]");
                  selectTrack("Lead Synth", "Serum 2 : Chorus",
                    [{ index: 0, name: "Serum 2", is_active: true }, { index: 1, name: "Chorus", is_active: true }],
                    [{ slot_index: 0, clip_id: 201, name: "Lead A", is_midi_clip: true },
                     { slot_index: 1, clip_id: 202, name: "Lead B", is_midi_clip: true }]); }],
  [11000, () => { console.log("\n[create new clip on Lead Synth]"); clipCreated("Lead Synth", "Lead C"); }],
  [13000, () => { console.log("\n[stop]"); stop(124, "Lead Synth"); }],
  [15000, () => { console.log("\n[done — heartbeats continuing every 2s. Ctrl+C to quit]\n");
                   setInterval(heartbeat, 2000); }],
];

console.log(`Sending demo session to ${HOST}:${PORT}\n`);

for (const [delay, fn] of steps) {
  setTimeout(fn, delay);
}
