// recall_m4l_bridge.js
//
// Recall Studio - Max for Live bridge
// Sends heartbeat and future Ableton telemetry events to the
// Recall Studio Rust backend over UDP.
//
// Max object:
// [js recall_m4l_bridge.js]
//
// LEFT OUT  = JSON event payload
// RIGHT OUT = debug/status text

autowatch = 1;

inlets = 1;
outlets = 2;

var PROTOCOL = "recall.protocol.v1";
var SCHEMA_VERSION = 1;
var SOURCE = "max_for_live";
var DEVICE_ID = "recall-m4l-bridge-dev";

var sequence = 0;
var bridgeRunning = false;
var heartbeatTask = new Task(heartbeat_tick, this);

post("Recall Studio M4L bridge JavaScript loaded\n");

function start() {
    start_bridge();
}

function start_bridge() {
    bridgeRunning = true;

    emit("bridge_started", {
        status: "running"
    });

    heartbeat();

    heartbeatTask.cancel();
    heartbeatTask.schedule(1000);

    debug("bridge started");
}

function stop() {
    stop_bridge();
}

function stop_bridge() {
    bridgeRunning = false;

    heartbeatTask.cancel();

    emit("bridge_stopped", {
        status: "stopped"
    });

    debug("bridge stopped");
}

function bang() {
    heartbeat();
}

function heartbeat() {
    emit("heartbeat", {
        status: "alive",
        bridge_running: bridgeRunning
    });
}

function heartbeat_tick() {
    if (!bridgeRunning) {
        return;
    }

    heartbeat();
    heartbeatTask.schedule(1000);
}

// Future Ableton telemetry entry points.

function tempo(value) {
    emit("tempo_changed", {
        bpm: Number(value)
    });
}

function playing(value) {
    emit("playback_state_changed", {
        playing: Number(value) === 1
    });
}

function beat_time(value) {
    emit("beat_time_changed", {
        beat_time: Number(value)
    });
}

function track_name() {
    var args = arrayfromargs(arguments);

    emit("track_name_changed", {
        track_name: args.join(" ")
    });
}

function clip_event() {
    var args = arrayfromargs(arguments);

    emit("clip_event", {
        raw: args
    });
}

function device_event() {
    var args = arrayfromargs(arguments);

    emit("device_event", {
        raw: args
    });
}

function anything() {
    var args = arrayfromargs(arguments);

    emit("raw_max_message", {
        message: messagename,
        args: args
    });
}

function emit(eventType, payload) {
    var event = {
        protocol: PROTOCOL,
        schema_version: SCHEMA_VERSION,
        source: SOURCE,
        device_id: DEVICE_ID,
        sequence: sequence,
        timestamp_ms: new Date().getTime(),
        event_type: eventType,
        payload: payload || {}
    };

    sequence = sequence + 1;

    var json = JSON.stringify(event);

    post("Recall Studio event: " + json + "\n");

    outlet(0, json);
    outlet(1, "sent " + eventType + " #" + event.sequence);
}

function debug(message) {
    post("Recall Studio bridge: " + message + "\n");
    outlet(1, message);
}