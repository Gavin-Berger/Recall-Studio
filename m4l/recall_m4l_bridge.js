// recall_m4l_bridge.js
//
// Recall Studio - Max for Live bridge
// v0.4.2: performance-safe delta capture + selected-track focus collector.
//
// Product goal:
// Capture meaningful Ableton session activity without constantly transmitting
// the entire Live Set.
//
// Max shell:
// (N) [js recall_m4l_bridge.js]
// LEFT OUT  -> JSON event payload to UDP
// RIGHT OUT -> debug/status text
//
// Recommended Max startup:
// (N) [live.thisdevice]
// OUT
//  |
// IN
// (N) [deferlow]
// OUT
//  |
// IN
// (N) [delay 1000]
// OUT
//  |
// IN
// (M) [start_bridge]
// OUT
//  |
// IN
// (N) [js recall_m4l_bridge.js]

autowatch = 1;

inlets = 1;
outlets = 2;

// ------------------------------------------------------------
// Protocol config
// ------------------------------------------------------------

var PROTOCOL = "recall.v2";
var SOURCE = "max_for_live";
var DEVICE_ID = "recall-m4l-bridge-dev";
var BRIDGE_VERSION = "0.5.0";

// Canonical v2 flat fields. emit() lifts any of these from its `fields` arg up
// to the TOP LEVEL of the packet, because the Rust normalizer reads canonical
// names at the top level first (see docs/recall-protocol-v2.md). Everything
// else stays in `payload` for debugging only.
var CANONICAL_FIELDS = [
    "track_name",
    "device_name",
    "parameter_name",
    "parameter_value",
    "parameter_value_min",
    "parameter_value_max",
    "clip_name",
    "bpm",
    "playing"
];

var sequence = 0;
var bridgeRunning = false;
var deviceLoadedSent = false;

// Capture toggles. Flip these at runtime by sending the matching message into
// the js object (e.g. a [safe_mode] message box) so the crash can be isolated
// without editing this file. The heavy LiveAPI traversals are the only realistic
// native-crash sources; safe_mode disables all of them and leaves only the
// tiny heartbeat + lifecycle events.
var captureTransport = true;
var captureFocus = true;
var captureLiveSet = true;

// Automatic capture limits.
var MAX_TRACK_SUMMARIES = 32;
var MAX_SCENE_SUMMARIES = 32;
var MAX_FOCUS_DEVICES = 8;
var MAX_FOCUS_PARAMETERS_PER_DEVICE = 12;
var MAX_FOCUS_CLIP_SLOTS = 16;

// Manual deep capture limits.
var MAX_DEEP_TRACKS = 64;
var MAX_DEEP_SCENES = 64;
var MAX_DEEP_CLIP_SLOTS_PER_TRACK = 32;
var MAX_DEEP_DEVICES_PER_TRACK = 16;
var MAX_DEEP_PARAMETERS_PER_DEVICE = 16;

// Timers.
// Keep automatic capture cheap. Heavy LiveAPI scans can make Ableton feel sticky,
// so deep structure snapshots stay manual and selected-track detail only runs
// when the selected track actually changes.
var HEARTBEAT_INTERVAL_MS = 2000;
var TRANSPORT_INTERVAL_MS = 2000;
var FOCUS_INTERVAL_MS = 4000;
var AUTO_LIVE_SET_SNAPSHOT_INTERVAL_MS = 0;

// Hard ceiling on a single emitted event. A snapshot that serializes larger
// than this is dropped, not sent. Why: pushing an oversized symbol out the
// outlet into [udpsend] can natively crash Max (and take Ableton with it).
// 8KB is comfortably inside a single loopback UDP datagram.
var MAX_EVENT_BYTES = 8192;

// Delay before the first heavy LiveAPI scan after start_bridge. Why: running a
// full live-set + selected-track traversal synchronously on the message that
// starts the bridge blocks Max's main thread and is the #1 crash trigger.
// Deferring it lets the scheduler settle first.
var INITIAL_CONTEXT_DELAY_MS = 800;

var heartbeatTask = new Task(heartbeat_tick, this);
var transportTask = new Task(transport_tick, this);
var focusTask = new Task(focus_tick, this);
var liveSetTask = new Task(live_set_tick, this);
var initialContextTask = new Task(initial_context_tick, this);

// Fingerprint cache.
var lastTransportSummaryFingerprint = "";
var lastLiveSetFingerprint = "";
var lastSelectedTrackFocusFingerprint = "";

var lastPlayingState = null;
var lastTempo = null;
var lastSelectedTrackId = null;
var lastFocusedTrackId = null;

post("Recall Studio M4L bridge JavaScript loaded (v" + BRIDGE_VERSION + ")\n");

// ------------------------------------------------------------
// Bridge lifecycle
// ------------------------------------------------------------

function start() {
    start_bridge();
}

function start_bridge() {
    if (bridgeRunning) {
        debug("bridge already running; start_bridge ignored");
        return;
    }

    bridgeRunning = true;

    if (!deviceLoadedSent) {
        emit("device_loaded", "Max for Live Bridge Loaded", "Recall Studio Max for Live bridge initialized.", {
            bridge_version: BRIDGE_VERSION,
            capture_mode: "baseline_delta_focus"
        });

        deviceLoadedSent = true;
    }

    emit("bridge_started", "Ableton Bridge Started", "The Max for Live bridge started sending telemetry.", {
        status: "running"
    });

    heartbeat();

    heartbeatTask.cancel();
    transportTask.cancel();
    focusTask.cancel();
    liveSetTask.cancel();
    initialContextTask.cancel();

    heartbeatTask.schedule(HEARTBEAT_INTERVAL_MS);
    transportTask.schedule(TRANSPORT_INTERVAL_MS);
    focusTask.schedule(FOCUS_INTERVAL_MS);

    if (AUTO_LIVE_SET_SNAPSHOT_INTERVAL_MS > 0) {
        liveSetTask.schedule(AUTO_LIVE_SET_SNAPSHOT_INTERVAL_MS);
    }

    // Defer the first heavy LiveAPI scan off this message. Running it inline
    // here is what was crashing Max on start.
    initialContextTask.schedule(INITIAL_CONTEXT_DELAY_MS);

    debug("bridge started");
}

// Runs the first context scans well after start, on the scheduler thread,
// each isolated so one bad scan cannot take down the others or the process.
function initial_context_tick() {
    if (!bridgeRunning) {
        return;
    }

    if (captureTransport) {
        try {
            send_transport_delta_if_changed();
        } catch (error) {
            debug("initial transport scan failed: " + error);
        }
    }

    if (captureFocus) {
        try {
            send_selected_track_focus_if_changed();
        } catch (error) {
            debug("initial focus scan failed: " + error);
        }
    }

    if (captureLiveSet) {
        try {
            send_live_set_snapshot_if_changed();
        } catch (error) {
            debug("initial live set scan failed: " + error);
        }
    }
}

function stop() {
    stop_bridge();
}

function stop_bridge() {
    if (!bridgeRunning) {
        debug("bridge already stopped; stop_bridge ignored");
        return;
    }

    bridgeRunning = false;

    heartbeatTask.cancel();
    transportTask.cancel();
    focusTask.cancel();
    liveSetTask.cancel();
    initialContextTask.cancel();

    emit("bridge_stopped", "Ableton Bridge Stopped", "The Max for Live bridge stopped sending telemetry.", {
        status: "stopped"
    });

    debug("bridge stopped");
}

function bang() {
    heartbeat();
}

function heartbeat() {
    emit("heartbeat", "Heartbeat Received", "Heartbeat received from the Max for Live bridge.", {
        status: "alive",
        bridge_running: bridgeRunning,
        bridge_version: BRIDGE_VERSION
    });
}

function heartbeat_tick() {
    if (!bridgeRunning) {
        return;
    }

    heartbeat();
    heartbeatTask.schedule(HEARTBEAT_INTERVAL_MS);
}

function transport_tick() {
    if (!bridgeRunning) {
        return;
    }

    if (captureTransport) {
        try {
            send_transport_delta_if_changed();
        } catch (error) {
            debug("transport scan failed: " + error);
        }
    }

    transportTask.schedule(TRANSPORT_INTERVAL_MS);
}

function focus_tick() {
    if (!bridgeRunning) {
        return;
    }

    if (captureFocus) {
        try {
            send_selected_track_focus_if_selected_track_changed();
        } catch (error) {
            debug("focus scan failed: " + error);
        }
    }

    focusTask.schedule(FOCUS_INTERVAL_MS);
}

function live_set_tick() {
    if (!bridgeRunning) {
        return;
    }

    if (captureLiveSet) {
        try {
            send_live_set_snapshot_if_changed();
        } catch (error) {
            debug("live set scan failed: " + error);
        }
    }

    if (AUTO_LIVE_SET_SNAPSHOT_INTERVAL_MS > 0) {
        liveSetTask.schedule(AUTO_LIVE_SET_SNAPSHOT_INTERVAL_MS);
    }
}

// ------------------------------------------------------------
// LiveAPI utilities
// ------------------------------------------------------------

function get_live_api(path) {
    try {
        var api = new LiveAPI(null, path);

        // Reject zombie objects. When a path doesn't resolve (track index past
        // the end, a device/parameter that isn't there), Max still returns a
        // LiveAPI object but with id 0. Calling .get()/.getcount() on a zombie
        // is a NATIVE crash, not a catchable JS error — this guard is what makes
        // the deep scans safe. Every collector already handles a null return.
        if (!api || Number(api.id) === 0) {
            return null;
        }

        return api;
    } catch (error) {
        debug("LiveAPI failed for path [" + path + "]: " + error);
        return null;
    }
}

function safe_path(path) {
    return get_live_api(path);
}

function get_prop(api, propertyName, fallbackValue) {
    try {
        if (!api) {
            return fallbackValue;
        }

        var value = api.get(propertyName);

        if (value === null || value === undefined) {
            return fallbackValue;
        }

        if (value instanceof Array && value.length === 1) {
            return value[0];
        }

        return value;
    } catch (error) {
        return fallbackValue;
    }
}

function get_count(api, childName, fallbackValue) {
    try {
        if (!api || typeof api.getcount !== "function") {
            return fallbackValue;
        }

        return api.getcount(childName);
    } catch (error) {
        return fallbackValue;
    }
}

function normalize_id(value) {
    if (value === null || value === undefined) {
        return null;
    }

    if (typeof value === "number" && value > 0) {
        return value;
    }

    if (typeof value === "string") {
        var parsed = Number(value);
        if (!isNaN(parsed) && parsed > 0) {
            return parsed;
        }
    }

    if (value instanceof Array) {
        for (var i = 0; i < value.length; i++) {
            if (typeof value[i] === "number" && value[i] > 0) {
                return value[i];
            }

            if (typeof value[i] === "string") {
                var n = Number(value[i]);
                if (!isNaN(n) && n > 0) {
                    return n;
                }
            }
        }
    }

    return null;
}

function value_to_string(value) {
    if (value === null || value === undefined) {
        return null;
    }

    if (value instanceof Array) {
        return value.join(" ");
    }

    return String(value);
}

function value_to_number(value, fallbackValue) {
    var n = Number(value);

    if (isNaN(n)) {
        return fallbackValue;
    }

    return n;
}

function value_to_bool(value) {
    return Number(value) === 1 || value === true || value === "1";
}

function fingerprint(value) {
    try {
        return JSON.stringify(value);
    } catch (error) {
        return String(new Date().getTime());
    }
}

// ------------------------------------------------------------
// Live Set / transport collectors
// ------------------------------------------------------------

function collect_transport_snapshot() {
    var liveSet = safe_path("live_set");

    if (!liveSet) {
        return {
            available: false,
            error: "live_set unavailable"
        };
    }

    var tempo = value_to_number(get_prop(liveSet, "tempo", 0), 0);
    var playing = value_to_bool(get_prop(liveSet, "is_playing", 0));
    var currentSongTime = value_to_number(get_prop(liveSet, "current_song_time", 0), 0);

    return {
        available: true,
        playing: playing,
        tempo: tempo,
        current_song_time: currentSongTime,
        signature_numerator: value_to_number(get_prop(liveSet, "signature_numerator", 4), 4),
        signature_denominator: value_to_number(get_prop(liveSet, "signature_denominator", 4), 4),
        arrangement_overdub: value_to_bool(get_prop(liveSet, "arrangement_overdub", 0)),
        session_record: value_to_bool(get_prop(liveSet, "session_record", 0)),
        metronome: value_to_bool(get_prop(liveSet, "metronome", 0)),
        track_count: get_count(liveSet, "tracks", 0),
        return_track_count: get_count(liveSet, "return_tracks", 0),
        scene_count: get_count(liveSet, "scenes", 0),
        selected_track_id: get_selected_track_id(),
        selected_track_name: get_selected_track_name()
    };
}

function send_transport_delta_if_changed() {
    var snapshot = collect_transport_snapshot();
    var summaryFingerprint = fingerprint({
        available: snapshot.available,
        playing: snapshot.playing,
        tempo: snapshot.tempo,
        signature_numerator: snapshot.signature_numerator,
        signature_denominator: snapshot.signature_denominator,
        arrangement_overdub: snapshot.arrangement_overdub,
        session_record: snapshot.session_record,
        metronome: snapshot.metronome,
        track_count: snapshot.track_count,
        return_track_count: snapshot.return_track_count,
        scene_count: snapshot.scene_count,
        selected_track_id: snapshot.selected_track_id,
        selected_track_name: snapshot.selected_track_name
    });

    if (summaryFingerprint === lastTransportSummaryFingerprint) {
        return;
    }

    lastTransportSummaryFingerprint = summaryFingerprint;

    if (snapshot.available) {
        if (lastPlayingState !== null && snapshot.playing !== lastPlayingState) {
            if (snapshot.playing) {
                emit("transport_play", "Transport Play", "Ableton playback started.", snapshot, {
                    playing: true,
                    bpm: snapshot.tempo,
                    track_name: snapshot.selected_track_name
                });
            } else {
                emit("transport_stop", "Transport Stop", "Ableton playback stopped.", snapshot, {
                    playing: false,
                    bpm: snapshot.tempo,
                    track_name: snapshot.selected_track_name
                });
            }
        }

        if (lastTempo !== null && snapshot.tempo !== lastTempo) {
            emit("tempo_changed", "Tempo Changed", "Ableton tempo changed.", {
                tempo: snapshot.tempo,
                previous_tempo: lastTempo
            }, {
                bpm: snapshot.tempo
            });
        }

        if (
            lastSelectedTrackId !== null &&
            snapshot.selected_track_id !== null &&
            snapshot.selected_track_id !== lastSelectedTrackId
        ) {
            emit("track_selected", "Track Selected", "Selected Ableton track changed.", {
                selected_track_id: snapshot.selected_track_id,
                selected_track_name: snapshot.selected_track_name
            }, {
                track_name: snapshot.selected_track_name
            });
        }

        lastPlayingState = snapshot.playing;
        lastTempo = snapshot.tempo;
        lastSelectedTrackId = snapshot.selected_track_id;
    }

    emit("transport_snapshot", "Transport Snapshot", "Ableton transport state changed.", snapshot);
}

function collect_live_set_snapshot() {
    var liveSet = safe_path("live_set");

    if (!liveSet) {
        return {
            available: false,
            error: "live_set unavailable"
        };
    }

    var trackCount = get_count(liveSet, "tracks", 0);
    var sceneCount = get_count(liveSet, "scenes", 0);
    var returnTrackCount = get_count(liveSet, "return_tracks", 0);

    return {
        available: true,
        bridge_version: BRIDGE_VERSION,
        tempo: value_to_number(get_prop(liveSet, "tempo", 0), 0),
        playing: value_to_bool(get_prop(liveSet, "is_playing", 0)),
        current_song_time: value_to_number(get_prop(liveSet, "current_song_time", 0), 0),
        track_count: trackCount,
        return_track_count: returnTrackCount,
        scene_count: sceneCount,
        selected_track_id: get_selected_track_id(),
        selected_track_name: get_selected_track_name(),
        tracks: collect_track_summaries(Math.min(trackCount, MAX_TRACK_SUMMARIES)),
        scenes: collect_scene_summaries(Math.min(sceneCount, MAX_SCENE_SUMMARIES))
    };
}

function send_live_set_snapshot_if_changed() {
    var snapshot = collect_live_set_snapshot();
    var fp = fingerprint(snapshot);

    if (fp === lastLiveSetFingerprint) {
        return;
    }

    lastLiveSetFingerprint = fp;

    emit("live_set_snapshot", "Live Set Snapshot", "Shallow Ableton Live Set snapshot captured.", snapshot, {
        bpm: snapshot.tempo,
        playing: snapshot.playing,
        track_name: snapshot.selected_track_name
    });
}

function collect_track_summaries(limit) {
    var tracks = [];

    for (var i = 0; i < limit; i++) {
        var track = safe_path("live_set tracks " + i);

        if (!track) {
            continue;
        }

        var canBeArmed = value_to_bool(get_prop(track, "can_be_armed", 0));
        var isFoldable = value_to_bool(get_prop(track, "is_foldable", 0));

        tracks.push({
            index: i,
            id: normalize_id(track.id),
            name: value_to_string(get_prop(track, "name", null)),
            color: get_prop(track, "color", null),
            color_index: get_prop(track, "color_index", null),
            muted: value_to_bool(get_prop(track, "mute", 0)),
            solo: value_to_bool(get_prop(track, "solo", 0)),
            can_be_armed: canBeArmed,
            arm: canBeArmed ? value_to_bool(get_prop(track, "arm", 0)) : false,
            is_foldable: isFoldable,
            fold_state: isFoldable ? get_prop(track, "fold_state", null) : null,
            device_count: get_count(track, "devices", 0),
            clip_slot_count: get_count(track, "clip_slots", 0)
        });
    }

    return tracks;
}

function collect_scene_summaries(limit) {
    var scenes = [];

    for (var i = 0; i < limit; i++) {
        var scene = safe_path("live_set scenes " + i);

        if (!scene) {
            continue;
        }

        scenes.push({
            index: i,
            name: value_to_string(get_prop(scene, "name", null)),
            color: get_prop(scene, "color", null),
            color_index: get_prop(scene, "color_index", null)
        });
    }

    return scenes;
}

// ------------------------------------------------------------
// Selected-track focus collector
// ------------------------------------------------------------

function get_selected_track_id() {
    try {
        var view = safe_path("live_set view");

        if (!view) {
            return null;
        }

        return normalize_id(get_prop(view, "selected_track", null));
    } catch (error) {
        return null;
    }
}

function get_selected_track_name() {
    var snapshot = collect_selected_track_basic();

    if (!snapshot || !snapshot.available) {
        return null;
    }

    return snapshot.name;
}

function collect_selected_track_basic() {
    var selectedTrackId = get_selected_track_id();

    if (!selectedTrackId) {
        return {
            available: false,
            id: null,
            name: null
        };
    }

    var track = safe_path("id " + selectedTrackId);

    if (!track) {
        return {
            available: false,
            id: selectedTrackId,
            name: null
        };
    }

    return {
        available: true,
        id: selectedTrackId,
        name: value_to_string(get_prop(track, "name", null))
    };
}

function find_track_index_by_id(trackId) {
    var liveSet = safe_path("live_set");

    if (!liveSet) {
        return -1;
    }

    var trackCount = get_count(liveSet, "tracks", 0);

    for (var i = 0; i < trackCount; i++) {
        var track = safe_path("live_set tracks " + i);

        if (!track) {
            continue;
        }

        if (normalize_id(track.id) === trackId) {
            return i;
        }
    }

    return -1;
}

function collect_selected_track_focus_snapshot() {
    var selectedTrackId = get_selected_track_id();

    if (!selectedTrackId) {
        return {
            available: false,
            reason: "no selected track"
        };
    }

    var selectedTrackIndex = find_track_index_by_id(selectedTrackId);

    if (selectedTrackIndex < 0) {
        return {
            available: false,
            id: selectedTrackId,
            reason: "selected track index not found"
        };
    }

    var track = safe_path("live_set tracks " + selectedTrackIndex);

    if (!track) {
        return {
            available: false,
            id: selectedTrackId,
            index: selectedTrackIndex,
            reason: "selected track api unavailable"
        };
    }

    var canBeArmed = value_to_bool(get_prop(track, "can_be_armed", 0));
    var isFoldable = value_to_bool(get_prop(track, "is_foldable", 0));
    var deviceCount = get_count(track, "devices", 0);
    var clipSlotCount = get_count(track, "clip_slots", 0);

    return {
        available: true,
        id: selectedTrackId,
        index: selectedTrackIndex,
        name: value_to_string(get_prop(track, "name", null)),
        color: get_prop(track, "color", null),
        color_index: get_prop(track, "color_index", null),
        muted: value_to_bool(get_prop(track, "mute", 0)),
        solo: value_to_bool(get_prop(track, "solo", 0)),
        can_be_armed: canBeArmed,
        arm: canBeArmed ? value_to_bool(get_prop(track, "arm", 0)) : false,
        is_foldable: isFoldable,
        fold_state: isFoldable ? get_prop(track, "fold_state", null) : null,
        device_count: deviceCount,
        clip_slot_count: clipSlotCount,
        devices: collect_focus_devices_for_track(
            selectedTrackIndex,
            Math.min(deviceCount, MAX_FOCUS_DEVICES)
        ),
        clips: collect_focus_clips_for_track(
            selectedTrackIndex,
            Math.min(clipSlotCount, MAX_FOCUS_CLIP_SLOTS)
        )
    };
}

function send_selected_track_focus_if_changed() {
    var snapshot = collect_selected_track_focus_snapshot();
    var fp = fingerprint(snapshot);

    if (fp === lastSelectedTrackFocusFingerprint) {
        return;
    }

    lastSelectedTrackFocusFingerprint = fp;

    emit(
        "selected_track_focus_snapshot",
        "Selected Track Focus Snapshot",
        "Focused detail captured for the currently selected Ableton track.",
        snapshot
    );

    if (snapshot.available && snapshot.id) {
        lastFocusedTrackId = snapshot.id;
    }
}

function send_selected_track_focus_if_selected_track_changed() {
    var selectedTrackId = get_selected_track_id();

    if (!selectedTrackId || selectedTrackId === lastFocusedTrackId) {
        return;
    }

    send_selected_track_focus_if_changed();
}

function collect_focus_devices_for_track(trackIndex, limit) {
    var devices = [];

    for (var i = 0; i < limit; i++) {
        var device = safe_path("live_set tracks " + trackIndex + " devices " + i);

        if (!device) {
            continue;
        }

        var parameterCount = get_count(device, "parameters", 0);

        devices.push({
            index: i,
            id: normalize_id(device.id),
            name: value_to_string(get_prop(device, "name", null)),
            class_name: value_to_string(get_prop(device, "class_name", null)),
            type: get_prop(device, "type", null),
            is_active: value_to_bool(get_prop(device, "is_active", 0)),
            parameter_count: parameterCount,
            main_parameters: collect_focus_parameters_for_device(
                trackIndex,
                i,
                Math.min(parameterCount, MAX_FOCUS_PARAMETERS_PER_DEVICE)
            )
        });
    }

    return devices;
}

function collect_focus_parameters_for_device(trackIndex, deviceIndex, limit) {
    var parameters = [];

    for (var i = 0; i < limit; i++) {
        var parameter = safe_path(
            "live_set tracks " +
            trackIndex +
            " devices " +
            deviceIndex +
            " parameters " +
            i
        );

        if (!parameter) {
            continue;
        }

        parameters.push({
            index: i,
            id: normalize_id(parameter.id),
            name: value_to_string(get_prop(parameter, "name", null)),
            value: get_prop(parameter, "value", null),
            min: get_prop(parameter, "min", null),
            max: get_prop(parameter, "max", null),
            is_enabled: value_to_bool(get_prop(parameter, "is_enabled", 1))
        });
    }

    return parameters;
}

function collect_focus_clips_for_track(trackIndex, limit) {
    var clips = [];

    for (var i = 0; i < limit; i++) {
        var slot = safe_path("live_set tracks " + trackIndex + " clip_slots " + i);

        if (!slot) {
            continue;
        }

        var hasClip = value_to_bool(get_prop(slot, "has_clip", 0));

        if (!hasClip) {
            continue;
        }

        var clipId = normalize_id(get_prop(slot, "clip", null));
        var clip = clipId ? safe_path("id " + clipId) : null;

        clips.push({
            slot_index: i,
            clip_id: clipId,
            is_playing: value_to_bool(get_prop(slot, "is_playing", 0)),
            is_recording: value_to_bool(get_prop(slot, "is_recording", 0)),
            is_triggered: value_to_bool(get_prop(slot, "is_triggered", 0)),
            playing_status: get_prop(slot, "playing_status", null),
            name: clip ? value_to_string(get_prop(clip, "name", null)) : null,
            color: clip ? get_prop(clip, "color", null) : null,
            color_index: clip ? get_prop(clip, "color_index", null) : null,
            length: clip ? get_prop(clip, "length", null) : null,
            looping: clip ? value_to_bool(get_prop(clip, "looping", 0)) : null,
            is_audio_clip: clip ? value_to_bool(get_prop(clip, "is_audio_clip", 0)) : null,
            is_midi_clip: clip ? value_to_bool(get_prop(clip, "is_midi_clip", 0)) : null
        });
    }

    return clips;
}

// ------------------------------------------------------------
// Manual deep capture
// ------------------------------------------------------------

function deep_session_snapshot() {
    emit("session_snapshot_started", "Session Snapshot Started", "Manual deep Ableton session snapshot started.", {
        mode: "manual_deep_capture"
    });

    emit("live_set_snapshot", "Live Set Snapshot", "Manual deep Ableton session snapshot captured.", collect_deep_session_snapshot());

    emit("session_snapshot_completed", "Session Snapshot Completed", "Manual deep Ableton session snapshot completed.", {
        mode: "manual_deep_capture"
    });
}

function collect_deep_session_snapshot() {
    var liveSet = safe_path("live_set");

    if (!liveSet) {
        return {
            available: false,
            error: "live_set unavailable"
        };
    }

    var trackCount = get_count(liveSet, "tracks", 0);
    var sceneCount = get_count(liveSet, "scenes", 0);

    return {
        available: true,
        transport: collect_transport_snapshot(),
        counts: {
            tracks: trackCount,
            return_tracks: get_count(liveSet, "return_tracks", 0),
            scenes: sceneCount
        },
        selected_track: collect_selected_track_focus_snapshot(),
        tracks: collect_deep_tracks_snapshot(Math.min(trackCount, MAX_DEEP_TRACKS)),
        scenes: collect_scene_summaries(Math.min(sceneCount, MAX_DEEP_SCENES))
    };
}

function collect_deep_tracks_snapshot(limit) {
    var tracks = [];

    for (var i = 0; i < limit; i++) {
        var track = safe_path("live_set tracks " + i);

        if (!track) {
            continue;
        }

        var canBeArmed = value_to_bool(get_prop(track, "can_be_armed", 0));
        var isFoldable = value_to_bool(get_prop(track, "is_foldable", 0));
        var deviceCount = get_count(track, "devices", 0);
        var clipSlotCount = get_count(track, "clip_slots", 0);

        tracks.push({
            index: i,
            id: normalize_id(track.id),
            name: value_to_string(get_prop(track, "name", null)),
            color: get_prop(track, "color", null),
            color_index: get_prop(track, "color_index", null),
            muted: value_to_bool(get_prop(track, "mute", 0)),
            solo: value_to_bool(get_prop(track, "solo", 0)),
            can_be_armed: canBeArmed,
            arm: canBeArmed ? value_to_bool(get_prop(track, "arm", 0)) : false,
            is_foldable: isFoldable,
            fold_state: isFoldable ? get_prop(track, "fold_state", null) : null,
            device_count: deviceCount,
            clip_slot_count: clipSlotCount,
            devices: collect_deep_devices_for_track(
                i,
                Math.min(deviceCount, MAX_DEEP_DEVICES_PER_TRACK)
            ),
            clip_slots: collect_deep_clip_slots_for_track(
                i,
                Math.min(clipSlotCount, MAX_DEEP_CLIP_SLOTS_PER_TRACK)
            )
        });
    }

    return tracks;
}

function collect_deep_devices_for_track(trackIndex, limit) {
    var devices = [];

    for (var i = 0; i < limit; i++) {
        var device = safe_path("live_set tracks " + trackIndex + " devices " + i);

        if (!device) {
            continue;
        }

        var parameterCount = get_count(device, "parameters", 0);

        devices.push({
            index: i,
            id: normalize_id(device.id),
            name: value_to_string(get_prop(device, "name", null)),
            class_name: value_to_string(get_prop(device, "class_name", null)),
            type: get_prop(device, "type", null),
            is_active: value_to_bool(get_prop(device, "is_active", 0)),
            parameter_count: parameterCount,
            parameters: collect_deep_parameters_for_device(
                trackIndex,
                i,
                Math.min(parameterCount, MAX_DEEP_PARAMETERS_PER_DEVICE)
            )
        });
    }

    return devices;
}

function collect_deep_parameters_for_device(trackIndex, deviceIndex, limit) {
    return collect_focus_parameters_for_device(trackIndex, deviceIndex, limit);
}

function collect_deep_clip_slots_for_track(trackIndex, limit) {
    var slots = [];

    for (var i = 0; i < limit; i++) {
        var slot = safe_path("live_set tracks " + trackIndex + " clip_slots " + i);

        if (!slot) {
            continue;
        }

        var hasClip = value_to_bool(get_prop(slot, "has_clip", 0));
        var clipSummary = null;

        if (hasClip) {
            var clipId = normalize_id(get_prop(slot, "clip", null));
            if (clipId) {
                clipSummary = collect_clip_by_id(clipId);
            }
        }

        slots.push({
            index: i,
            has_clip: hasClip,
            is_playing: value_to_bool(get_prop(slot, "is_playing", 0)),
            is_recording: value_to_bool(get_prop(slot, "is_recording", 0)),
            is_triggered: value_to_bool(get_prop(slot, "is_triggered", 0)),
            playing_status: get_prop(slot, "playing_status", null),
            clip: clipSummary
        });
    }

    return slots;
}

function collect_clip_by_id(clipId) {
    var clip = safe_path("id " + clipId);

    if (!clip) {
        return {
            id: clipId,
            available: false
        };
    }

    return {
        id: clipId,
        available: true,
        name: value_to_string(get_prop(clip, "name", null)),
        color: get_prop(clip, "color", null),
        color_index: get_prop(clip, "color_index", null),
        length: get_prop(clip, "length", null),
        loop_start: get_prop(clip, "loop_start", null),
        loop_end: get_prop(clip, "loop_end", null),
        looping: value_to_bool(get_prop(clip, "looping", 0)),
        is_audio_clip: value_to_bool(get_prop(clip, "is_audio_clip", 0)),
        is_midi_clip: value_to_bool(get_prop(clip, "is_midi_clip", 0))
    };
}

// ------------------------------------------------------------
// Manual Max message entry points
// ------------------------------------------------------------

function transport_snapshot() {
    send_transport_delta_if_changed();
}

function live_set_snapshot() {
    send_live_set_snapshot_if_changed();
}

function selected_track_focus_snapshot() {
    send_selected_track_focus_if_changed();
}

function selected_track_snapshot() {
    send_selected_track_focus_if_changed();
}

function session_snapshot() {
    deep_session_snapshot();
}

// ------------------------------------------------------------
// Capture toggles (crash isolation) — send these as Max messages
// ------------------------------------------------------------

// Disable every heavy LiveAPI scan. Only heartbeat + lifecycle events remain.
// If start_bridge is stable in safe_mode but crashes with full capture, the
// crash is in one of the scans — re-enable them one at a time to find it.
function safe_mode() {
    captureTransport = false;
    captureFocus = false;
    captureLiveSet = false;
    debug("SAFE MODE: all LiveAPI scans disabled (heartbeat only)");
}

function full_capture() {
    captureTransport = true;
    captureFocus = true;
    captureLiveSet = true;
    debug("FULL CAPTURE: all LiveAPI scans enabled");
}

function capture_transport(value) {
    captureTransport = Number(value) === 1;
    debug("capture_transport = " + captureTransport);
}

function capture_focus(value) {
    captureFocus = Number(value) === 1;
    debug("capture_focus = " + captureFocus);
}

function capture_live_set(value) {
    captureLiveSet = Number(value) === 1;
    debug("capture_live_set = " + captureLiveSet);
}

function deep_snapshot() {
    deep_session_snapshot();
}

function tempo(value) {
    emit("tempo_changed", "Tempo Changed", "Manual tempo event received from Max.", {
        bpm: Number(value)
    }, {
        bpm: Number(value)
    });
}

function playing(value) {
    if (Number(value) === 1) {
        emit("transport_play", "Transport Play", "Manual play event received from Max.", {
            playing: true
        }, {
            playing: true
        });
    } else {
        emit("transport_stop", "Transport Stop", "Manual stop event received from Max.", {
            playing: false
        }, {
            playing: false
        });
    }
}

function beat_time(value) {
    emit("beat_time_changed", "Beat Time Changed", "Manual beat time event received from Max.", {
        beat_time: Number(value)
    });
}

function track_name() {
    var args = arrayfromargs(arguments);

    emit("track_selected", "Track Selected", "Manual track name event received from Max.", {
        track_name: args.join(" ")
    }, {
        track_name: args.join(" ")
    });
}

function clip_event() {
    var args = arrayfromargs(arguments);

    emit("clip_launched", "Clip Launched", "Manual clip event received from Max.", {
        raw: args
    });
}

function device_event() {
    var args = arrayfromargs(arguments);

    emit("device_selected", "Device Selected", "Manual device event received from Max.", {
        raw: args
    });
}

function parameter_event() {
    var args = arrayfromargs(arguments);

    emit("parameter_changed", "Parameter Changed", "Manual parameter event received from Max.", {
        raw: args
    });
}

function anything() {
    var args = arrayfromargs(arguments);

    emit("raw_max_message", "Raw Max Message", "Raw Max message received for debugging.", {
        message: messagename,
        args: args
    });
}

// ------------------------------------------------------------
// Recall Protocol output
// ------------------------------------------------------------

function emit(eventType, title, description, payload, fields) {
    var event = {
        protocol: PROTOCOL,
        source: SOURCE,
        event_type: eventType,
        timestamp_ms: new Date().getTime(),
        title: title || eventType,
        description: description || "",
        payload: payload || {},
        session_id: null
    };

    // Lift canonical fields to the top level so the backend reads them directly
    // (no payload digging). Only known v2 keys with a real value are promoted.
    if (fields) {
        for (var f = 0; f < CANONICAL_FIELDS.length; f++) {
            var key = CANONICAL_FIELDS[f];
            var value = fields[key];

            if (value !== null && value !== undefined && value !== "") {
                event[key] = value;
            }
        }
    }

    sequence = sequence + 1;

    event.payload._bridge = {
        device_id: DEVICE_ID,
        bridge_version: BRIDGE_VERSION,
        sequence: sequence
    };

    var json;

    try {
        json = JSON.stringify(event);
    } catch (error) {
        debug("emit serialize failed for " + eventType + ": " + error);
        return;
    }

    // Hard safety net: never push an oversized symbol out the outlet into
    // [udpsend]. Doing so can natively crash Max. Drop and log instead.
    if (json.length > MAX_EVENT_BYTES) {
        post(
            "Recall Studio event DROPPED: " + eventType + " #" + sequence +
            " (" + json.length + " bytes > " + MAX_EVENT_BYTES + " cap)\n"
        );
        outlet(1, "dropped " + eventType + " #" + sequence + " (" + json.length + " bytes, over cap)");
        return;
    }

    // Never print full JSON here. Large payloads can freeze Max.
    post("Recall Studio event: " + eventType + " #" + sequence + " (" + json.length + " bytes)\n");

    outlet(0, json);
    outlet(1, "sent " + eventType + " #" + sequence + " (" + json.length + " bytes)");
}

function debug(message) {
    post("Recall Studio bridge: " + message + "\n");
    outlet(1, message);
}
