// recall_m4l_bridge.js
//
// Recall Studio - Max for Live bridge
// v0.21.3: baseline captures every track's device chain, not just its count.
// baseline the whole set on every start so Main/returns are always registered.
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
var BRIDGE_VERSION = "0.21.3";

// Canonical v2 flat fields. emit() lifts any of these from its `fields` arg up
// to the TOP LEVEL of the packet, because the Rust normalizer reads canonical
// names at the top level first (see docs/recall-protocol-v2.md). Everything
// else stays in `payload` for debugging only.
var CANONICAL_FIELDS = [
    "track_name",
    "track_type",
    "device_name",
    "parameter_name",
    "parameter_value",
    "previous_parameter_value",
    "parameter_value_percent",
    "previous_parameter_value_percent",
    "parameter_value_min",
    "parameter_value_max",
    "parameter_display_value",
    "previous_parameter_display_value",
    "parameter_is_quantized",
    "clip_name",
    "sample_name",
    "file_path",
    "project_name",
    "project_path",
    "device_chain",
    "bpm",
    "playing"
];

var sequence = 0;
var bridgeRunning = false;
var deviceLoadedSent = false;
var lastProjectContextFingerprint = null;

// Capture toggles. Flip these at runtime by sending the matching message into
// the js object (e.g. a [safe_mode] message box) so the crash can be isolated
// without editing this file. The heavy LiveAPI traversals are the only realistic
// native-crash sources; safe_mode disables all of them and leaves only the
// tiny heartbeat + lifecycle events.
var captureTransport = true;
var captureFocus = true;
// Live knob/fader move capture, owned by the DEDICATED parameter poller (see the
// "Focused-device parameter poller" section). Unlike the old approach this no
// longer piggybacks on the 4s focus scan — it polls ONLY the device the producer
// currently has open (Live's selected_device) at a fast cadence, value-only, so a
// heavy plugin (Serum 2 has 1000+ parameters, far past the focus scan's 128 cap)
// can be tracked across its WHOLE parameter set without missing a tweak and
// without the per-tick cost of scanning every device on the track. Each knob ride
// is coalesced into one settled event. Gated so [capture_parameter_moves 0]
// disables only this, not the whole focus scan.
var captureParameterMoves = true;
// The Main (master) bus and the return tracks. ON by default, and deliberately
// NOT folded into captureStructure: that scanner is off because guessing numeric
// track indices ("live_set tracks 19") reads stale/wrong data in real sets, but
// "live_set master_track" and "live_set return_tracks N" are stable singleton
// paths that always resolve. Cost is a handful of name reads (no parameters), and
// Main is where mixdown/mastering work happens, so it has to be captured even
// when the producer never selects it. Main is also SEEDED once at session start
// (see seed_bus_tracks) so it exists on the timeline from the first scan rather
// than only appearing once someone touches it.
var captureBuses = true;
// Experimental/debug only. In real Ableton sets, numeric background paths like
// "live_set tracks 19" are not reliable enough to treat as live capture unless
// the producer selects that track. Keep normal Recall capture focused on the
// selected track + focused device; use [capture_structure 1] only when explicitly
// testing the old background scanner.
var captureStructure = false;
// Off by default. The full live-set summary is the heaviest single scan: it
// walks every track and serializes them in one packet. On large sets (40+
// tracks, groups, many active plugins) running it synchronously while audio is
// playing is the dominant native-crash trigger, and nothing in the curated
// timeline depends on it (the timeline is built from transport + focus + diff
// events). Re-enable on demand with a [capture_live_set 1] message if needed.
var captureLiveSet = false;

// Automatic capture limits.
var MAX_TRACK_SUMMARIES = 16;
var MAX_SCENE_SUMMARIES = 16;
var MAX_FOCUS_DEVICES = 8;
var MAX_FOCUS_PARAMETERS_PER_DEVICE = 128;
// Floor for parameter_changed: ignore sub-epsilon value wobble so floating-point
// representation noise never fires a move. Any real knob/fader change clears it.
var PARAMETER_VALUE_EPSILON = 1e-6;
var MAX_FOCUS_CLIP_SLOTS = 16;

// ── Focused-device parameter poller limits ──────────────────────────────────
// The poller scans ONLY the currently open device, so it can afford a fast
// cadence and a high parameter ceiling that the all-device focus scan cannot.
//
// The cadence is ADAPTIVE. While something on the focused device is actually
// moving (or a freshly-focused device is still being seeded) the poller runs
// HOT, so a knob ride is sampled with good resolution. Once everything has been
// still past the hold window it drops to the IDLE cadence — which is where a
// session spends the vast majority of its time. Dormant polling is the largest
// recurring cost the bridge imposes on Live, so idling hard matters more than
// polling fast.
var PARAMETER_POLL_HOT_MS = 200;
var PARAMETER_POLL_IDLE_MS = 1200;
// Keep polling HOT for this long after the last observed change, so multi-part
// gestures (grab, listen, grab again) stay at full resolution end to end.
var PARAMETER_HOT_HOLD_MS = 4000;
// Focus/navigation debounce. A burst of clicks changes selected_track /
// selected_device faster than a producer can mean any of them. Wait for the
// selection to hold still this long before paying the expensive rebuild + full
// reseed of the focused device, so clicking THROUGH devices no longer pins the
// poller HOT and storms LiveAPI construction on Live's main thread. Once the
// selection lands and holds, seeding + ride capture behave exactly as before.
var FOCUS_DEBOUNCE_MS = 300;
// Per tick we read at most this many parameter VALUES (one cheap read each), then
// advance a round-robin cursor. A 1000+ param plugin is therefore swept over a few
// ticks instead of in one heavy tick — bounding per-tick cost regardless of how
// huge the plugin is.
var PARAMETER_POLL_CHUNK = 256;
// ...AND the tick stops early once it has spent this long reading, whichever
// comes first. A count bound assumes every read is cheap; some VST wrappers are
// not. The time budget turns "256 reads" into "at most a few ms", so a plugin
// with slow parameter reads takes smaller bites instead of spiking the tick —
// tick spikes on Max's scheduler thread are exactly what makes Live feel sticky.
var PARAMETER_POLL_BUDGET_MS = 3;
// Absolute ceiling on parameters considered for one device (pathological guard).
var MAX_POLL_PARAMETERS_PER_DEVICE = 4096;
// Slow-changing focused-device metadata does not need to be read on every hot
// parameter tick. Parameter values remain full cadence; only count/name refreshes
// are throttled, cutting several LiveAPI gets from the steady-state hot path.
var PARAMETER_CONTEXT_REFRESH_MS = 3000;
// Gesture baselines are plain JS data, but retaining every parameter for every
// device ever focused grows without bound in long sessions. Keep a small LRU;
// revisiting an evicted device simply seeds it silently again.
var PARAMETER_DEVICE_CACHE_LIMIT = 8;
// A knob ride is emitted as ONE settled event once its value has stopped changing
// for this long. Decoupled from the poll/round-robin cadence (wall-clock based) so
// chunking never splits a gesture. ~one comfortable pause after letting go.
var PARAMETER_SETTLE_MS = 450;
// How many devices we scan to map the selected device's id back to its chain
// index. Only paid when focus actually moves — the resolved location (and every
// LiveAPI object it holds) is cached across ticks.
var MAX_DEVICE_LOOKUP = 64;
// How many tracks the lightweight lifecycle roster scan covers each transport
// tick. Only cheap props are read per track (name/mute/solo/arm), so this can be
// generous; tracks beyond it won't get create/rename/mute/solo/arm detection.
var MAX_TRACK_STATES = 32;

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

// Optional structure-scan cadence. This scanner is off by default because
// background track reads have proven unreliable unless the track is selected.
// When enabled for debugging, only STRUCTURE_TRACKS_PER_TICK tracks are scanned
// per tick and playback throttling still applies.
var STRUCTURE_INTERVAL_MS = 4000;
var STRUCTURE_TRACKS_PER_TICK = 4;
var STRUCTURE_SKIP_TICKS_WHILE_PLAYING = 2;
var structureTicksSkippedWhilePlaying = 0;
var structureScanCursor = 0;

// While transport is PLAYING the audio thread is under the most pressure, so we
// run the heavy focus scan at a reduced cadence: skip this many focus ticks
// between scans while playing (2 -> scan every 3rd tick ~= every 12s). When
// stopped, every tick scans as before, so edits made while paused are caught
// promptly. The task keeps firing at FOCUS_INTERVAL_MS either way, so the moment
// playback stops the next tick runs a full scan with no added latency.
var FOCUS_SKIP_TICKS_WHILE_PLAYING = 2;
var focusTicksSkippedWhilePlaying = 0;

// Windows may deprioritize Max's scheduler while Live is backgrounded. When the
// scheduler wakes, several overdue Tasks can otherwise enter LiveAPI back to
// back and briefly pin Live's main thread. Detect that wall-clock gap and give
// each scanner a separate recovery slot. No missed interval is replayed.
var SCHEDULER_GAP_MS = 5000;
var schedulerLastTickAt = 0;
var schedulerRecoveryStartedAt = 0;
var SCHEDULER_RECOVERY_OFFSETS = {
    heartbeat: 75,
    transport: 350,
    parameter: 750,
    initial_context: 950,
    focus: 1350,
    initial_focus: 1650,
    structure: 2200,
    live_set: 2850,
    initial_live_set: 3150,
    baseline: 3600
};

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

// Gap between the staggered first scans. The three initial scans used to run
// back-to-back in one tick; on a large set that single synchronous block was
// long enough to crash Max. Spacing them lets the scheduler (and the audio
// thread) breathe between each heavy traversal.
var INITIAL_STAGGER_MS = 600;

// One-shot whole-set baseline. The first time the bridge meets a set (or you
// open a different one), snapshot everything already in it once, so a project
// built before Recall existed gets captured instead of only its future changes.
// Deferred off the message thread like the other heavy scans.
var BASELINE_SNAPSHOT_DELAY_MS = 1500;

var heartbeatTask = new Task(heartbeat_tick, this);
var transportTask = new Task(transport_tick, this);
var focusTask = new Task(focus_tick, this);
var parameterTask = new Task(parameter_tick, this);
var structureTask = new Task(structure_tick, this);
var liveSetTask = new Task(live_set_tick, this);
var initialContextTask = new Task(initial_context_tick, this);
var initialFocusTask = new Task(initial_focus_tick, this);
var initialLiveSetTask = new Task(initial_live_set_tick, this);
var baselineTask = new Task(baseline_tick, this);

function scheduler_tick_ready(kind, task) {
    var now = (new Date()).getTime();
    var gap = schedulerLastTickAt > 0 ? now - schedulerLastTickAt : 0;
    schedulerLastTickAt = now;

    if (gap >= SCHEDULER_GAP_MS) {
        schedulerRecoveryStartedAt = now;

        // These cheap handles may point at stale selection objects after Live
        // regains focus. Preserve the device/parameter caches and gesture
        // baselines; their existing id checks will rebuild only what is dead.
        paramLiveSetViewApi = null;
        paramSelectedTrackViewApi = null;

        debug("scheduler resumed after " + gap + "ms; staggering LiveAPI scans");
    }

    if (schedulerRecoveryStartedAt > 0) {
        var offset = SCHEDULER_RECOVERY_OFFSETS[kind] || 0;
        var readyAt = schedulerRecoveryStartedAt + offset;
        if (now < readyAt) {
            task.cancel();
            task.schedule(Math.max(50, readyAt - now));
            return false;
        }
    }

    return true;
}

// Fingerprint cache.
var lastTransportSummaryFingerprint = "";
var lastLiveSetFingerprint = "";
var lastSelectedTrackFocusFingerprint = "";

// Which set fingerprint we've already baselined this session, so opening a set
// captures its existing contents exactly once (not on every heartbeat).
var lastBaselinedFingerprint = null;

var lastPlayingState = null;
var lastTempo = null;
var lastSelectedTrackId = null;
var lastFocusedTrackId = null;

// Track lifecycle diff cache. Keyed by track id so renames, mutes, solos, and
// arm changes on existing tracks are detected separately from add/delete.
var lastTrackCacheById = null; // null = not seeded yet

// Diff state for creative-action detection. We compare each focus snapshot of a
// track against the previous snapshot of THE SAME track to emit discrete
// device_added/removed and clip_created/deleted events. Keyed by track id so
// switching tracks never produces false diffs. Why diff instead of LiveAPI
// observers: live observers on many objects are a native-crash risk; diffing
// reuses the already-hardened focus scan.
var focusDeviceCacheByTrack = {};
var focusClipCacheByTrack = {};

// Last emitted device-chain string per track ("Serum 2 : Saturator : Vocoder").
// Lets us emit a device_chain_changed event only when the ordered chain of
// device names on a track actually changes, instead of on every focus scan.
var lastDeviceChainByTrack = {};

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
    schedulerLastTickAt = (new Date()).getTime();
    schedulerRecoveryStartedAt = 0;

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

    send_project_context_if_changed(true);
    heartbeat();

    heartbeatTask.cancel();
    transportTask.cancel();
    focusTask.cancel();
    parameterTask.cancel();
    structureTask.cancel();
    liveSetTask.cancel();
    initialContextTask.cancel();
    initialFocusTask.cancel();
    initialLiveSetTask.cancel();

    heartbeatTask.schedule(HEARTBEAT_INTERVAL_MS);
    transportTask.schedule(TRANSPORT_INTERVAL_MS);
    focusTask.schedule(FOCUS_INTERVAL_MS);
    // The dedicated parameter poller runs independently of (and faster than) the
    // focus scan, so a tweak on the open device is caught even mid-playback.
    parameterTask.schedule(PARAMETER_POLL_HOT_MS);
    // Background structure capture is experimental and off by default. If it is
    // enabled manually, offset it from the focus scan so their LiveAPI work does
    // not stack on the same tick.
    schedule_structure_scan(STRUCTURE_INTERVAL_MS + 2000);

    // Clear the dedupe fingerprints so this start re-seeds whatever database is
    // live. Dedupe is right while the bridge keeps running, wrong across a
    // restart: if the database was reset under a still-open project the
    // fingerprint still matched and the fresh database never learned the set
    // exists.
    lastBaselinedFingerprint = null;
    lastLiveSetFingerprint = null;

    if (AUTO_LIVE_SET_SNAPSHOT_INTERVAL_MS > 0) {
        liveSetTask.schedule(AUTO_LIVE_SET_SNAPSHOT_INTERVAL_MS);
    }

    // Defer and STAGGER the first heavy LiveAPI scans off this message. Running
    // them inline (or all in one deferred tick) is what crashed Max on start in
    // large sets. Each scan runs on its own task, spaced apart, so the main
    // thread never holds a long synchronous traversal.
    initialContextTask.schedule(INITIAL_CONTEXT_DELAY_MS);
    initialFocusTask.schedule(INITIAL_CONTEXT_DELAY_MS + INITIAL_STAGGER_MS);
    initialLiveSetTask.schedule(INITIAL_CONTEXT_DELAY_MS + INITIAL_STAGGER_MS * 2);

    // Baseline the whole set on EVERY start, not just on first meeting a project.
    //
    // WHY THIS IS NOT REDUNDANT with the two paths above:
    //   - initial_live_set_tick is gated on captureLiveSet, which is false by
    //     default, so it normally does nothing.
    //   - the automatic baseline is scheduled only from
    //     send_project_context_if_changed, which returns early when the set
    //     reports no project name or path (unsaved set, unreadable path).
    // On a default-config bridge with a pathless set that left NOTHING sending
    // the whole-set snapshot — and that snapshot is the only carrier of
    // master_track / return_tracks, so Main never got registered as a track no
    // matter how many devices were added to it.
    //
    // baseline_tick is deliberately NOT gated on captureLiveSet: it is the
    // "seed the set once, regardless of config" path. Scheduled last in the
    // stagger so the heaviest traversal lands after the cheaper scans.
    baselineTask.schedule(INITIAL_CONTEXT_DELAY_MS + INITIAL_STAGGER_MS * 3);

    debug("bridge started");
}

// The first context scans run well after start, on the scheduler thread, and
// are STAGGERED across three separate tasks (transport, then focus, then live
// set) so no single tick holds a long synchronous LiveAPI traversal. Each is
// isolated in try/catch so one bad scan cannot take down the others.
function initial_context_tick() {
    if (!bridgeRunning) {
        return;
    }
    if (!scheduler_tick_ready("initial_context", initialContextTask)) {
        return;
    }

    if (captureTransport) {
        try {
            send_transport_delta_if_changed();
        } catch (error) {
            debug("initial transport scan failed: " + error);
        }
    }
}

function initial_focus_tick() {
    if (!bridgeRunning) {
        return;
    }
    if (!scheduler_tick_ready("initial_focus", initialFocusTask)) {
        return;
    }

    if (captureFocus) {
        try {
            send_selected_track_focus_if_changed();
        } catch (error) {
            debug("initial focus scan failed: " + error);
        }
    }
}

function initial_live_set_tick() {
    if (!bridgeRunning) {
        return;
    }
    if (!scheduler_tick_ready("initial_live_set", initialLiveSetTask)) {
        return;
    }

    if (captureLiveSet) {
        try {
            send_live_set_snapshot_if_changed();
        } catch (error) {
            debug("initial live set scan failed: " + error);
        }
    }
}

// Fire one whole-set snapshot off the scheduler thread (never inline on the
// message that triggered it), isolated so a heavy traversal can't take Max
// down. Shared by the automatic first-meet baseline and the manual recapture.
function baseline_tick() {
    if (!bridgeRunning) {
        return;
    }
    if (!scheduler_tick_ready("baseline", baselineTask)) {
        return;
    }
    try {
        send_live_set_snapshot_if_changed();
    } catch (error) {
        debug("baseline snapshot failed: " + error);
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

    // Final flush: the move detector only samples on the focus poll (every
    // FOCUS_INTERVAL_MS, and throttled while playing), so a knob moved to its
    // resting spot right before stopping would otherwise never be read. Run one
    // last focus scan here to capture that last value. Guarded + try/catch like
    // focus_tick, and done while bridgeRunning is still true so emit() works.
    if (captureFocus) {
        try {
            send_selected_track_focus_if_changed();
        } catch (error) {
            debug("final focus flush failed: " + error);
        }
    }

    // Flush any in-progress knob ride so a tweak made right before stopping isn't
    // lost waiting for its settle window. Done while bridgeRunning is still true so
    // emit() works.
    if (captureParameterMoves) {
        try {
            flush_all_param_gestures();
        } catch (error) {
            debug("final parameter flush failed: " + error);
        }
    }

    bridgeRunning = false;
    schedulerLastTickAt = 0;
    schedulerRecoveryStartedAt = 0;

    heartbeatTask.cancel();
    transportTask.cancel();
    focusTask.cancel();
    parameterTask.cancel();
    structureTask.cancel();
    liveSetTask.cancel();
    initialContextTask.cancel();
    initialFocusTask.cancel();
    initialLiveSetTask.cancel();

    emit("bridge_stopped", "Ableton Bridge Stopped", "The Max for Live bridge stopped sending telemetry.", {
        status: "stopped"
    });

    debug("bridge stopped");
}

function bang() {
    heartbeat();
}

function heartbeat() {
    var projectContext = collect_project_context();
    emit("heartbeat", "Heartbeat Received", "Heartbeat received from the Max for Live bridge.", {
        status: "alive",
        bridge_running: bridgeRunning,
        bridge_version: BRIDGE_VERSION,
        project_name: projectContext.project_name,
        project_path: projectContext.project_path
    }, {
        project_name: projectContext.project_name,
        project_path: projectContext.project_path
    });
}

function heartbeat_tick() {
    if (!bridgeRunning) {
        return;
    }
    if (!scheduler_tick_ready("heartbeat", heartbeatTask)) {
        return;
    }

    send_project_context_if_changed(false);
    heartbeat();
    heartbeatTask.schedule(HEARTBEAT_INTERVAL_MS);
}

function collect_project_context() {
    var liveSet = safe_path("live_set");

    if (!liveSet) {
        return {
            available: false,
            project_name: null,
            project_path: null
        };
    }

    // An UNSAVED set has no name and no file on disk, and the LOM signals that by
    // returning the number 0 rather than an empty string. value_to_string turns
    // that into the literal "0", which is a truthy non-empty string, so it sails
    // through every emptiness check downstream and gets stored as the project's
    // real name — the UI then reads "Ableton: 0". Map the sentinel back to null
    // here, at the only place that knows 0 means "absent" rather than a name.
    var rawName = lom_text_or_null(get_prop(liveSet, "name", null));
    var rawPath = lom_text_or_null(get_prop(liveSet, "file_path", null));
    var nameFromPath = rawPath ? project_name_from_path(rawPath) : null;
    var projectName = rawName || nameFromPath || null;

    return {
        available: true,
        project_name: projectName,
        project_path: rawPath
    };
}

function send_project_context_if_changed(force) {
    var context = collect_project_context();
    var nextFingerprint = fingerprint({
        project_name: context.project_name,
        project_path: context.project_path
    });

    if (!force && nextFingerprint === lastProjectContextFingerprint) {
        return;
    }

    lastProjectContextFingerprint = nextFingerprint;

    if (!context.project_name && !context.project_path) {
        return;
    }

    emit("project_context", "Project Name Captured", "Ableton project name captured.", context, {
        project_name: context.project_name,
        project_path: context.project_path
    });

    // First time we've seen this set (or you switched to a different one):
    // baseline the whole set once so pre-existing tracks and devices get
    // captured, not just future changes. Deferred + staggered so the heavy
    // traversal never blocks Max's message thread.
    if (nextFingerprint !== lastBaselinedFingerprint) {
        lastBaselinedFingerprint = nextFingerprint;
        baselineTask.cancel();
        baselineTask.schedule(BASELINE_SNAPSHOT_DELAY_MS);
    }
}

function transport_tick() {
    if (!bridgeRunning) {
        return;
    }
    if (!scheduler_tick_ready("transport", transportTask)) {
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
    if (!scheduler_tick_ready("focus", focusTask)) {
        return;
    }

    if (captureFocus) {
        // Throttle the heavy scan while playing to leave the audio thread
        // headroom; full cadence resumes the instant transport stops.
        var skipForPlayback =
            lastPlayingState === true &&
            focusTicksSkippedWhilePlaying < FOCUS_SKIP_TICKS_WHILE_PLAYING;

        if (skipForPlayback) {
            focusTicksSkippedWhilePlaying++;
        } else {
            focusTicksSkippedWhilePlaying = 0;

            try {
                // Re-scan the selected track every tick (not only on track switch),
                // so device/clip changes made while staying on a track are caught.
                send_selected_track_focus_if_changed();
            } catch (error) {
                debug("focus scan failed: " + error);
            }
        }
    }

    // Buses ride the focus tick, NOT the structure scanner. See captureBuses:
    // their paths are stable singletons, so they carry none of the numeric-path
    // unreliability that keeps captureStructure off. Runs even when the playback
    // throttle skips the selected-track scan above — it is a handful of name
    // reads, and mastering moves happen while the track is playing.
    if (captureBuses) {
        try {
            scan_bus_tracks();
        } catch (error) {
            debug("bus scan failed: " + error);
        }
    }

    focusTask.schedule(FOCUS_INTERVAL_MS);
}

function structure_tick() {
    if (!bridgeRunning) {
        return;
    }
    if (!captureStructure) {
        return;
    }
    if (!scheduler_tick_ready("structure", structureTask)) {
        return;
    }

    // Throttle while playing like the focus scan; full cadence resumes the
    // instant transport stops.
    var skipForPlayback =
        lastPlayingState === true &&
        structureTicksSkippedWhilePlaying < STRUCTURE_SKIP_TICKS_WHILE_PLAYING;

    if (skipForPlayback) {
        structureTicksSkippedWhilePlaying++;
    } else {
        structureTicksSkippedWhilePlaying = 0;

        try {
            scan_track_structure_batch();
        } catch (error) {
            debug("structure scan failed: " + error);
        }
    }

    structureTask.schedule(STRUCTURE_INTERVAL_MS);
}

function schedule_structure_scan(delayMs) {
    structureTask.cancel();
    if (bridgeRunning && captureStructure) {
        structureTask.schedule(delayMs);
    }
}

// Optional round-robin shallow scan across numeric track paths. This is kept for
// debugging only: in production the selected-track focus scan owns live capture,
// because background track reads are not dependable in large real sets. This
// path never calls detect_automation_created, so automation stays confined to
// the selected track. The selected track is skipped here since the focus scan
// owns it.
function scan_track_structure_batch() {
    var liveSet = safe_path("live_set");

    if (!liveSet) {
        return;
    }

    // NOTE: buses are NOT scanned here anymore. They moved to focus_tick under
    // captureBuses, because this scanner is off by default and Main must be
    // captured regardless of whether anyone enables it.

    var trackCount = get_count(liveSet, "tracks", 0);

    if (trackCount <= 0) {
        return;
    }

    var selectedId = get_selected_track_id();
    var scanned = 0;

    while (scanned < STRUCTURE_TRACKS_PER_TICK && scanned < trackCount) {
        if (structureScanCursor >= trackCount) {
            structureScanCursor = 0;
        }

        var index = structureScanCursor;
        structureScanCursor++;
        scanned++;

        var snapshot = collect_track_focus_snapshot(index);

        if (!snapshot || !snapshot.available || !snapshot.id) {
            continue;
        }

        // The selected track is fully handled (with automation) by the focus
        // scan. Skip it here so we never double-process it.
        if (selectedId && snapshot.id === selectedId) {
            continue;
        }

        detect_focus_changes(snapshot);
    }
}

// Build a device-only focus snapshot for a bus track (the master or a return) by
// path. Buses have no clip slots, so clips is always empty and detect_focus_changes
// only diffs devices + chain — exactly the "added a plugin to the master" case.
function collect_bus_devices_snapshot(trackPath) {
    var track = safe_path(trackPath);

    if (!track) {
        return null;
    }

    var trackId = normalize_id(track.id);

    if (!trackId) {
        return null;
    }

    var deviceCount = get_count(track, "devices", 0);
    var devices = collect_focus_devices_for_path(
        trackPath,
        Math.min(deviceCount, MAX_FOCUS_DEVICES)
    );

    return {
        available: true,
        id: trackId,
        index: -1,
        name: value_to_string(get_prop(track, "name", null)),
        device_count: deviceCount,
        device_chain: build_device_chain(devices),
        devices: devices,
        clips: []
    };
}

// Collect an array of bus tracks (the returns) by base path — each a device
// snapshot — so the whole-set baseline includes return FX, not just regular
// tracks.
function collect_bus_track_array(basePath, count) {
    var out = [];
    for (var i = 0; i < count; i++) {
        var bus = collect_bus_devices_snapshot(basePath + " " + i);
        if (bus && bus.id) {
            out.push(bus);
        }
    }
    return out;
}

// Diff the master track and every return track for device/chain changes. They
// live outside `live_set tracks`, so the round-robin scan never reaches them.
// Reuses the same per-track diff cache (keyed by track id) and emits the same
// device_added / device_removed / device_chain_changed events, now attributed to
// "Master" or the return's name.
function scan_bus_tracks() {
    var liveSet = safe_path("live_set");

    if (!liveSet) {
        return;
    }

    var master = collect_bus_devices_snapshot("live_set master_track");
    if (master && master.id) {
        detect_focus_changes(master);
    }

    var returnCount = get_count(liveSet, "return_tracks", 0);
    for (var i = 0; i < returnCount && i < MAX_TRACK_STATES; i++) {
        var returnTrack = collect_bus_devices_snapshot("live_set return_tracks " + i);
        if (returnTrack && returnTrack.id) {
            detect_focus_changes(returnTrack);
        }
    }
}

function live_set_tick() {
    if (!bridgeRunning) {
        return;
    }
    if (!scheduler_tick_ready("live_set", liveSetTask)) {
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

// Read a LOM property that is EITHER text or Live's "nothing here" sentinel.
//
// Live returns the number 0 (not "", not null) for text properties that have no
// value — an unsaved set's name and file_path being the case that bit us. Passed
// through value_to_string that becomes "0": non-empty, truthy, and indistinguish-
// able downstream from a set genuinely named "0". Anything reading a LOM string
// that can be absent should come through here rather than value_to_string.
//
// Only the bare sentinel is rejected. A path or name that merely CONTAINS a zero
// ("Track 0", "C:/sets/0.als") is real text and passes through untouched.
function lom_text_or_null(value) {
    var text = value_to_string(value);

    if (text === null || text === "" || text === "0") {
        return null;
    }

    return text;
}

function value_to_number(value, fallbackValue) {
    var n = Number(value);

    if (isNaN(n)) {
        return fallbackValue;
    }

    return n;
}

function parameter_value_percent(value, minValue, maxValue) {
    var numericValue = value_to_number(value, null);
    var numericMin = value_to_number(minValue, null);
    var numericMax = value_to_number(maxValue, null);

    if (numericValue === null || numericMin === null || numericMax === null) {
        return null;
    }

    var span = numericMax - numericMin;

    if (span === 0) {
        return null;
    }

    var percent = ((numericValue - numericMin) / span) * 100;

    if (!isFinite(percent)) {
        return null;
    }

    return Math.max(0, Math.min(100, percent));
}

// Safe wrapper for LiveAPI function calls (e.g. DeviceParameter.str_for_value).
// Calling .call() on a zombie/closed object is a native crash, so guard like the
// property readers do and swallow any error into null.
function safe_call(api, fnName, arg) {
    try {
        if (!api || typeof api.call !== "function") {
            return null;
        }

        return api.call(fnName, arg);
    } catch (error) {
        return null;
    }
}

// Human-readable display for a parameter value — the string the producer
// actually sees in Live, so the app can show "what it is" instead of a raw
// float. Two cases:
//   • quantized params (mode selectors like Saturate's "Analog Clip" /
//     "Sinefold") — value is an index into value_items; return that label.
//   • continuous params (Filter 1 Freq, etc.) — ask Live to format the value,
//     which yields the unit-bearing string ("440 Hz", "-12.0 dB").
function parameter_display(param, value, isQuantized) {
    if (!param || value === null || value === undefined) {
        return null;
    }

    if (isQuantized) {
        var items = get_prop(param, "value_items", null);
        if (items instanceof Array) {
            var index = Math.round(value);
            if (index >= 0 && index < items.length) {
                return value_to_string(items[index]);
            }
        }
        return null;
    }

    return value_to_string(safe_call(param, "str_for_value", value));
}

// Classify a device by its chain role from the Live API Device.type integer.
// Live Object Model: 1 = instrument, 2 = audio_effect, 4 = midi_effect (0 =
// undefined). The app reads this `role` string directly, so the MIDI chain
// (midi_effects -> instrument -> audio_effects) is recoverable downstream without
// re-guessing. If a future Live build changes these integers, this is the one
// place to adjust.
function device_role(device) {
    var type = get_prop(device, "type", null);

    if (type === 1) {
        return "instrument";
    }

    if (type === 4) {
        return "midi_effect";
    }

    return "audio_effect";
}

// Classify a track for the app: group (foldable container), midi (accepts MIDI),
// else audio. Return tracks live in a separate Live collection and are typed by the
// app, so they never reach this helper.
function track_type(track) {
    if (value_to_bool(get_prop(track, "is_foldable", 0))) {
        return "group";
    }

    if (value_to_bool(get_prop(track, "has_midi_input", 0))) {
        return "midi";
    }

    return "audio";
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

    // Track lifecycle (create / delete / rename / mute / solo / arm) is diffed
    // here on its own lightweight roster scan, and crucially BEFORE the transport
    // dedup below. A mute or arm toggle doesn't change the transport fingerprint
    // (track_count and the selected track are unchanged), so if this ran after the
    // early return it would be swallowed. detect_track_changes only emits on a real
    // change, so running it every tick is cheap and correct.
    if (snapshot.available) {
        try {
            detect_track_changes(
                collect_track_states(Math.min(snapshot.track_count, MAX_TRACK_STATES))
            );
        } catch (error) {
            debug("track roster scan failed: " + error);
        }
    }

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

        if (lastTempo !== null && snapshot.tempo !== lastTempo && snapshot.tempo > 10) {
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
        // (track lifecycle is diffed at the top of this function, before the dedup)
    }

    emit("transport_snapshot", "Transport Snapshot", "Ableton transport state changed.", snapshot);
}

// Diff the current track list against the previous one and emit discrete events
// for: track added, track deleted, track renamed, mute toggled, solo toggled,
// arm toggled. Uses track id as the stable key so reorders don't fire false events.
function detect_track_changes(currentTracks) {
    if (!currentTracks || !(currentTracks instanceof Array)) {
        return;
    }

    // Build a map of id -> track for fast lookup.
    var currentById = {};
    for (var i = 0; i < currentTracks.length; i++) {
        var t = currentTracks[i];
        if (t && t.id !== null && t.id !== undefined) {
            currentById[String(t.id)] = t;
        }
    }

    // First call seeds the cache silently — no events for pre-existing tracks.
    if (lastTrackCacheById === null) {
        lastTrackCacheById = currentById;
        return;
    }

    // Detect added tracks.
    for (var newId in currentById) {
        if (!currentById.hasOwnProperty(newId)) { continue; }
        if (!lastTrackCacheById.hasOwnProperty(newId)) {
            var added = currentById[newId];
            emit("track_created", "Track Created", "A new track was created in Ableton.",
                { track_name: added.name, track_index: added.index, track_type: added.track_type },
                { track_name: added.name, track_type: added.track_type });
        }
    }

    // Detect deleted tracks.
    for (var oldId in lastTrackCacheById) {
        if (!lastTrackCacheById.hasOwnProperty(oldId)) { continue; }
        if (!currentById.hasOwnProperty(oldId)) {
            var removed = lastTrackCacheById[oldId];
            emit("track_deleted", "Track Deleted", "A track was deleted in Ableton.",
                { track_name: removed.name, track_index: removed.index },
                { track_name: removed.name });
        }
    }

    // Detect changes on existing tracks: rename, mute, solo, arm.
    for (var id in currentById) {
        if (!currentById.hasOwnProperty(id) || !lastTrackCacheById.hasOwnProperty(id)) { continue; }

        var cur = currentById[id];
        var prev = lastTrackCacheById[id];

        if (cur.name !== prev.name) {
            emit("track_name_changed", "Track Renamed",
                "Track renamed from \"" + prev.name + "\" to \"" + cur.name + "\".",
                { track_name: cur.name, previous_name: prev.name, track_type: cur.track_type },
                { track_name: cur.name, track_type: cur.track_type });
        }

        if (cur.muted !== prev.muted) {
            emit(cur.muted ? "track_muted" : "track_unmuted",
                cur.muted ? "Track Muted" : "Track Unmuted",
                "\"" + cur.name + "\" was " + (cur.muted ? "muted" : "unmuted") + ".",
                { track_name: cur.name, muted: cur.muted },
                { track_name: cur.name });
        }

        if (cur.solo !== prev.solo) {
            emit(cur.solo ? "track_soloed" : "track_unsoloed",
                cur.solo ? "Track Soloed" : "Track Unsoloed",
                "\"" + cur.name + "\" was " + (cur.solo ? "soloed" : "unsoloed") + ".",
                { track_name: cur.name, solo: cur.solo },
                { track_name: cur.name });
        }

        if (cur.can_be_armed && cur.arm !== prev.arm) {
            emit(cur.arm ? "track_armed" : "track_unarmed",
                cur.arm ? "Track Armed" : "Track Unarmed",
                "\"" + cur.name + "\" was " + (cur.arm ? "armed" : "unarmed") + " for recording.",
                { track_name: cur.name, armed: cur.arm },
                { track_name: cur.name });
        }
    }

    lastTrackCacheById = currentById;
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
        // No track cap on the whole-set baseline: capture EVERY track in the
        // set, so opening a large existing project imports all of it.
        tracks: collect_track_summaries(trackCount),
        // Buses live outside `live_set tracks`. Include them so the baseline
        // also captures return FX and the Main/Master mastering chain.
        return_tracks: collect_bus_track_array("live_set return_tracks", returnTrackCount),
        master_track: collect_bus_devices_snapshot("live_set master_track"),
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

        // The device CHAIN, not just the count. Without this the baseline
        // registers a track and nothing on it, so a track the producer never
        // happens to select reads as empty in Recall while Ableton plainly shows
        // a Saturator on it — the set looks half-captured for no reason the
        // producer can see.
        //
        // Safe to do here specifically because this is the once-per-start
        // baseline: names only, capped at MAX_FOCUS_DEVICES per track, and NO
        // parameter reads — parameters are the expensive, crash-prone path and
        // stay confined to the focused device.
        var deviceCount = get_count(track, "devices", 0);
        var devices = collect_focus_devices_for_path(
            "live_set tracks " + i,
            Math.min(deviceCount, MAX_FOCUS_DEVICES)
        );

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
            device_chain: build_device_chain(devices),
            devices: devices,
            clip_slot_count: get_count(track, "clip_slots", 0)
        });
    }

    return tracks;
}

// Lightweight per-track roster used for lifecycle diffing on every transport tick.
// Unlike collect_track_summaries this reads ONLY the cheap props detect_track_changes
// needs (no device/clip counts), so it's safe to run frequently across many tracks.
function collect_track_states(limit) {
    var states = [];

    for (var i = 0; i < limit; i++) {
        var track = safe_path("live_set tracks " + i);

        if (!track) {
            continue;
        }

        var canBeArmed = value_to_bool(get_prop(track, "can_be_armed", 0));

        states.push({
            index: i,
            id: normalize_id(track.id),
            name: value_to_string(get_prop(track, "name", null)),
            muted: value_to_bool(get_prop(track, "mute", 0)),
            solo: value_to_bool(get_prop(track, "solo", 0)),
            can_be_armed: canBeArmed,
            arm: canBeArmed ? value_to_bool(get_prop(track, "arm", 0)) : false,
            track_type: track_type(track)
        });
    }

    return states;
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

// Cache of trackId -> index. The focus scan runs every few seconds and used to
// walk EVERY track on the set to map the selected track's id back to its index,
// even though the selection rarely moves. On a 40+ track set that full loop ran
// on Max's main thread during playback (worst-case audio contention). Now we
// remember the last index for each id and validate it cheaply: read only the
// track at the cached index and confirm its id still matches. Tracks only shift
// index when one is added/removed/reordered, so the expensive full scan is the
// rare path, not the per-tick path.
var trackIndexCacheById = {};

function find_track_index_by_id(trackId) {
    var liveSet = safe_path("live_set");

    if (!liveSet) {
        return -1;
    }

    var trackCount = get_count(liveSet, "tracks", 0);

    var cachedIndex = trackIndexCacheById[trackId];

    if (typeof cachedIndex === "number" && cachedIndex >= 0 && cachedIndex < trackCount) {
        var cachedTrack = safe_path("live_set tracks " + cachedIndex);

        if (cachedTrack && normalize_id(cachedTrack.id) === trackId) {
            return cachedIndex;
        }
    }

    for (var i = 0; i < trackCount; i++) {
        var track = safe_path("live_set tracks " + i);

        if (!track) {
            continue;
        }

        if (normalize_id(track.id) === trackId) {
            trackIndexCacheById[trackId] = i;
            return i;
        }
    }

    delete trackIndexCacheById[trackId];

    return -1;
}

// Build a focus snapshot for the track at the given index. This is the shared
// per-track collector used by the selected-track focus scan and the optional
// structure scanner. It reads only bounded structural data (track props, device
// names, clip presence + sample paths) and no device parameters.
function collect_track_focus_snapshot(trackIndex) {
    var track = safe_path("live_set tracks " + trackIndex);

    if (!track) {
        return {
            available: false,
            index: trackIndex,
            reason: "track api unavailable"
        };
    }

    var trackId = normalize_id(track.id);
    var canBeArmed = value_to_bool(get_prop(track, "can_be_armed", 0));
    var isFoldable = value_to_bool(get_prop(track, "is_foldable", 0));
    var deviceCount = get_count(track, "devices", 0);
    var clipSlotCount = get_count(track, "clip_slots", 0);

    var devices = collect_focus_devices_for_track(
        trackIndex,
        Math.min(deviceCount, MAX_FOCUS_DEVICES)
    );

    return {
        available: true,
        id: trackId,
        index: trackIndex,
        name: value_to_string(get_prop(track, "name", null)),
        color: get_prop(track, "color", null),
        color_index: get_prop(track, "color_index", null),
        muted: value_to_bool(get_prop(track, "mute", 0)),
        solo: value_to_bool(get_prop(track, "solo", 0)),
        can_be_armed: canBeArmed,
        arm: canBeArmed ? value_to_bool(get_prop(track, "arm", 0)) : false,
        is_foldable: isFoldable,
        fold_state: isFoldable ? get_prop(track, "fold_state", null) : null,
        has_midi_input: value_to_bool(get_prop(track, "has_midi_input", 0)),
        device_count: deviceCount,
        clip_slot_count: clipSlotCount,
        device_chain: build_device_chain(devices),
        devices: devices,
        clips: collect_focus_clips_for_track(
            trackIndex,
            Math.min(clipSlotCount, MAX_FOCUS_CLIP_SLOTS)
        )
    };
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

    return collect_track_focus_snapshot(selectedTrackIndex);
}

// Build the producer-readable signal chain for a track as an ordered, colon-
// separated string of device names — e.g. "Serum 2 : Saturator : Vocoder".
// Why device.name (not class_name): name is what the producer sees in Live's
// title bar, including VST/AU plugin display names and any user rename, so it
// matches what they'd recognise. class_name is the internal type id ("Operator",
// "PluginDevice") and would read wrong for plugins. Empty/unnamed devices are
// skipped so a half-loaded chain never emits stray separators.
function build_device_chain(devices) {
    if (!(devices instanceof Array) || devices.length === 0) {
        return null;
    }

    var names = [];

    for (var i = 0; i < devices.length; i++) {
        var device = devices[i];
        var name = device && device.name ? String(device.name) : "";

        if (name && name.length > 0) {
            names.push(name);
        }
    }

    if (names.length === 0) {
        return null;
    }

    return names.join(" : ");
}

// Re-scan a specific track's parameters by id and emit any pending move. Used to
// flush a track's FINAL knob position the moment focus leaves it — otherwise a
// tweak made right before switching tracks would never be read, because the poll
// only ever scans the currently-selected track. Reads live via path, so the
// track must still exist; a deleted/missing track is a safe no-op.
function flush_track_parameter_moves(trackId) {
    if (!trackId) {
        return;
    }

    var index = find_track_index_by_id(trackId);
    if (index < 0) {
        return;
    }

    var snapshot = collect_track_focus_snapshot(index);
    if (snapshot && snapshot.available && snapshot.id) {
        detect_automation_created(snapshot, String(snapshot.id), snapshot.name);
    }
}

function send_selected_track_focus_if_changed() {
    var snapshot = collect_selected_track_focus_snapshot();

    // If focus moved to a different track since the last scan, flush the OUTGOING
    // track first so its last knob position is captured before we move on. Done
    // before the new track's scan; the two use separate per-track caches so order
    // is otherwise independent.
    var currentId = snapshot && snapshot.available && snapshot.id ? String(snapshot.id) : null;
    if (lastFocusedTrackId && currentId && currentId !== String(lastFocusedTrackId)) {
        try {
            flush_track_parameter_moves(lastFocusedTrackId);
        } catch (error) {
            debug("outgoing-track flush failed: " + error);
        }
    }

    // Detect discrete creative actions BEFORE the snapshot dedup, so we emit
    // device_added/clip_created etc. even though the bulky snapshot itself may
    // be deduped away.
    detect_focus_changes(snapshot);

    // Parameter scanning (automation creation + live value moves) reads device
    // parameters - the expensive path - so it runs ONLY here, for the selected
    // track, never in the optional structure scanner.
    if (snapshot && snapshot.available && snapshot.id) {
        detect_automation_created(snapshot, String(snapshot.id), snapshot.name);
    }

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

// Diff a focus snapshot against the previous snapshot of the SAME track and
// emit discrete creative-action events. The first snapshot of a track only
// seeds the cache (no events) so pre-existing devices/clips don't fire as
// "added" the moment you select a track.
function detect_focus_changes(snapshot) {
    if (!snapshot || !snapshot.available || !snapshot.id) {
        return;
    }

    var trackKey = String(snapshot.id);
    var trackName = snapshot.name;
    var chain = snapshot.device_chain || null;

    var newDevices = build_id_name_map(snapshot.devices, "id", "name");
    var newClips = build_clip_slot_map(snapshot.clips);

    var hadDeviceBaseline = focusDeviceCacheByTrack.hasOwnProperty(trackKey);
    var hadClipBaseline = focusClipCacheByTrack.hasOwnProperty(trackKey);

    if (hadDeviceBaseline) {
        var oldDevices = focusDeviceCacheByTrack[trackKey];

        for (var newId in newDevices) {
            if (newDevices.hasOwnProperty(newId) && !oldDevices.hasOwnProperty(newId)) {
                emit("device_added", "Device Added", "A device was added to the selected track.",
                    { track_name: trackName, device_name: newDevices[newId], device_chain: chain },
                    { track_name: trackName, device_name: newDevices[newId], device_chain: chain });
            }
        }

        for (var oldId in oldDevices) {
            if (oldDevices.hasOwnProperty(oldId) && !newDevices.hasOwnProperty(oldId)) {
                emit("device_removed", "Device Removed", "A device was removed from the selected track.",
                    { track_name: trackName, device_name: oldDevices[oldId], device_chain: chain },
                    { track_name: trackName, device_name: oldDevices[oldId], device_chain: chain });
            }
        }
    }

    // Emit the full signal chain whenever its ordered string changes (device
    // added, removed, or reordered). Seeded silently on the first snapshot of a
    // track so an unchanged pre-existing chain never fires on track select.
    var hadChainBaseline = lastDeviceChainByTrack.hasOwnProperty(trackKey);

    if (hadChainBaseline && chain && lastDeviceChainByTrack[trackKey] !== chain) {
        emit("device_chain_changed", "Signal Chain Changed",
            "The device chain on the selected track changed.",
            { track_name: trackName, device_chain: chain },
            { track_name: trackName, device_chain: chain });
    }

    lastDeviceChainByTrack[trackKey] = chain;

    if (hadClipBaseline) {
        var oldClips = focusClipCacheByTrack[trackKey];

        for (var newSlot in newClips) {
            if (!newClips.hasOwnProperty(newSlot)) {
                continue;
            }
            // New clip in a slot, or a different clip replacing the old one.
            if (!oldClips.hasOwnProperty(newSlot) || oldClips[newSlot].id !== newClips[newSlot].id) {
                emit_clip_created(trackName, newClips[newSlot]);
            }
        }

        for (var oldSlot in oldClips) {
            if (!oldClips.hasOwnProperty(oldSlot)) {
                continue;
            }
            if (!newClips.hasOwnProperty(oldSlot)) {
                emit("clip_deleted", "Clip Deleted", "A clip was deleted on the selected track.",
                    { track_name: trackName, clip_name: oldClips[oldSlot].name },
                    { track_name: trackName, clip_name: oldClips[oldSlot].name });
            }
        }
    }

    focusDeviceCacheByTrack[trackKey] = newDevices;
    focusClipCacheByTrack[trackKey] = newClips;

    // NOTE: automation detection (detect_automation_created) is intentionally NOT
    // called here. It reads device parameters, which is the expensive/crash-prone
    // path, so it must stay confined to the selected track. The caller
    // (send_selected_track_focus_if_changed) invokes it directly. The optional
    // structure scan calls detect_focus_changes WITHOUT automation.
}

// Cache of paramId -> had_automation per track.
var automationCacheByTrack = {};

// Detect automation being WRITTEN on a parameter (the automation lane appearing),
// confined to the selected track. Live knob/fader MOVES are no longer detected
// here — the dedicated focused-device parameter poller owns parameter_changed, so
// this function reads only automation_state and stays cheap.
function detect_automation_created(snapshot, trackKey, trackName) {
    if (!snapshot || !snapshot.available || snapshot.index === null || snapshot.index === undefined) {
        return;
    }

    var trackIndex = snapshot.index;
    var deviceCount = Math.min(snapshot.device_count || 0, MAX_FOCUS_DEVICES);
    var oldCache = automationCacheByTrack[trackKey] || {};
    var newCache = {};
    var isFirstScan = !automationCacheByTrack.hasOwnProperty(trackKey);

    for (var d = 0; d < deviceCount; d++) {
        var device = safe_path("live_set tracks " + trackIndex + " devices " + d);
        if (!device) { continue; }

        var deviceName = value_to_string(get_prop(device, "name", null)) || ("Device " + d);
        var paramCount = Math.min(get_count(device, "parameters", 0), MAX_FOCUS_PARAMETERS_PER_DEVICE);

        for (var p = 0; p < paramCount; p++) {
            var param = safe_path("live_set tracks " + trackIndex + " devices " + d + " parameters " + p);
            if (!param) { continue; }

            var paramId = value_to_string(normalize_id(param.id)) || (d + "_" + p);
            // automation_state: 0=none, 1=playing, 2=overridden, 3=recording.
            // Any non-zero state means automation has been written on this param.
            var automationState = value_to_number(get_prop(param, "automation_state", 0), 0);
            var hasWrittenAutomation = automationState > 0;

            newCache[paramId] = hasWrittenAutomation;

            // Only emit on the transition from no automation → has automation.
            // Skip the first scan (seeding baseline) so pre-existing automation
            // doesn't fire as "created" the moment you select the track.
            if (!isFirstScan && hasWrittenAutomation && !oldCache[paramId]) {
                var paramName = value_to_string(get_prop(param, "name", null)) || ("Param " + p);

                // Get current bar position for context.
                var liveSet = safe_path("live_set");
                var songTime = liveSet ? value_to_number(get_prop(liveSet, "current_song_time", 0), 0) : 0;
                var sigNum = liveSet ? value_to_number(get_prop(liveSet, "signature_numerator", 4), 4) : 4;
                var bar = Math.floor(songTime / sigNum) + 1;
                var beat = Math.floor(songTime % sigNum) + 1;
                var position = "Bar " + bar + " Beat " + beat;

                emit(
                    "automation_created",
                    "Automation Created",
                    "Automation written on " + paramName + " (" + deviceName + ") at " + position + ".",
                    {
                        track_name: trackName,
                        device_name: deviceName,
                        parameter_name: paramName,
                        song_time: songTime,
                        position: position
                    },
                    {
                        track_name: trackName,
                        device_name: deviceName,
                        parameter_name: paramName
                    }
                );
            }
        }
    }

    automationCacheByTrack[trackKey] = newCache;
}

// ------------------------------------------------------------
// Focused-device parameter poller
// ------------------------------------------------------------
//
// Captures live knob/fader moves on the device the producer currently has open.
// Why a dedicated poller instead of the 4s focus scan: heavy plugins like Serum 2
// expose 1000+ parameters, far past the focus scan's 128 cap, and the focus scan
// throttles to every 12s while playing — so most tweaks made during sound design
// were silently missed. By scoping to the single SELECTED device we can poll fast,
// sweep the whole parameter set (round-robin), and never miss a tweak, while
// keeping per-tick cost bounded regardless of plugin size.
//
// State keyed by device id so it survives chain reorders and track switches.
var paramGestureByDevice = {};      // deviceKey -> { paramId: gesture }
var paramPollContextByKey = {};     // deviceKey -> { devicePath, deviceName, trackName }
var paramPollCursorByKey = {};      // deviceKey -> round-robin cursor
var lastPolledDeviceKey = null;

// ── Poller LiveAPI cache ─────────────────────────────────────────────────────
// Constructing a LiveAPI object resolves a path through Live's object model and
// is BY FAR the dominant cost of the poller — it used to rebuild every object on
// every tick (hundreds of native constructions per second, sustained). These
// caches persist across ticks and are torn down when focus moves to a different
// device, the chain shape changes, or an object goes zombie (id 0). Only the
// CURRENTLY focused device's parameters are cached, so the native object count
// stays bounded by one device.
var paramLiveSetViewApi = null;   // "live_set view" — stable for the whole session
var paramFocusCache = null;       // { selectedTrackId, selectedDeviceId, loc }
var paramApiByIndex = [];         // param index -> LiveAPI (lazily built, focused device only)
var paramApiCachedCount = -1;     // paramCount the cache was built for (shape-change detector)
var paramVisitedCount = 0;        // distinct param indices visited since the cache reset
// Param indices with an OPEN gesture. Sampled every tick ahead of the
// round-robin, so an active ride keeps full sample resolution no matter how
// many dormant parameters the plugin has.
var paramHotIndices = {};         // index -> true
// Poll HOT until this wall-clock time; bumped by any observed change, a focus
// move, or an unfinished first sweep of a new device.
var paramPollHotUntil = 0;
var paramContextRefreshAt = 0;
var paramDeviceRecency = [];

// Focus-change debounce state (see FOCUS_DEBOUNCE_MS). committedFocusIdentity is
// the "trackId:deviceId" the poller is actually seeding/sampling. A probe result
// that differs from it must hold steady for FOCUS_DEBOUNCE_MS before we commit —
// so a click-through never triggers the rebuild/reseed below.
var committedFocusIdentity = null;
var paramPendingKey = null;
var paramPendingSince = 0;
var paramSelectedTrackViewApi = null;

function reset_param_api_cache(paramCount) {
    paramApiByIndex = [];
    paramHotIndices = {};
    paramVisitedCount = 0;
    paramApiCachedCount = paramCount;
}

function touch_param_device_cache(deviceKey) {
    var next = [];
    for (var i = 0; i < paramDeviceRecency.length; i++) {
        if (paramDeviceRecency[i] !== deviceKey) {
            next.push(paramDeviceRecency[i]);
        }
    }
    next.push(deviceKey);
    paramDeviceRecency = next;

    while (paramDeviceRecency.length > PARAMETER_DEVICE_CACHE_LIMIT) {
        var evictedKey = paramDeviceRecency.shift();
        if (!evictedKey || evictedKey === deviceKey) {
            continue;
        }
        delete paramGestureByDevice[evictedKey];
        delete paramPollContextByKey[evictedKey];
        delete paramPollCursorByKey[evictedKey];
    }
}

function parameter_tick() {
    if (!bridgeRunning) {
        return;
    }
    if (!scheduler_tick_ready("parameter", parameterTask)) {
        return;
    }

    if (captureParameterMoves) {
        try {
            poll_focused_device_parameters();
        } catch (error) {
            debug("parameter poll failed: " + error);
        }
    }

    // Adaptive cadence: HOT while hands are (recently) on, IDLE once everything
    // is still. The gesture state machine is identical either way — only the
    // sample rate changes, so the emitted events stay one-settled-move-per-ride.
    var now = (new Date()).getTime();
    parameterTask.schedule(now < paramPollHotUntil ? PARAMETER_POLL_HOT_MS : PARAMETER_POLL_IDLE_MS);
}

// The cached "live_set view" object — rebuilt only if it goes zombie.
function param_live_set_view() {
    if (paramLiveSetViewApi && Number(paramLiveSetViewApi.id) !== 0) {
        return paramLiveSetViewApi;
    }
    paramLiveSetViewApi = safe_path("live_set view");
    return paramLiveSetViewApi;
}

// Resolve the device the producer currently has open, reusing the cached
// resolution while selection is unchanged. Steady-state cost (focus not moving,
// which is nearly every tick): a handful of cheap .get calls on cached objects
// and ZERO LiveAPI constructions. The full path walk — including the device-id
// → chain-index lookup loop — only runs when focus actually moves or a cached
// object dies.
function resolve_focused_device_location(focusProbe) {
    var view = param_live_set_view();
    if (!view) {
        paramFocusCache = null;
        paramContextRefreshAt = 0;
        return null;
    }

    var selectedTrackId = focusProbe
        ? focusProbe.trackId
        : normalize_id(get_prop(view, "selected_track", null));
    if (!selectedTrackId) {
        paramFocusCache = null;
        paramContextRefreshAt = 0;
        return null;
    }

    var cache = paramFocusCache;
    if (cache && cache.selectedTrackId === selectedTrackId && cache.loc) {
        var loc = cache.loc;
        var trackView = loc.trackViewApi;
        var deviceApi = loc.deviceApi;
        if (
            trackView && Number(trackView.id) !== 0 &&
            deviceApi && Number(deviceApi.id) !== 0
        ) {
            var selectedDeviceId = focusProbe
                ? focusProbe.deviceId
                : normalize_id(get_prop(trackView, "selected_device", null));
            if (selectedDeviceId === cache.selectedDeviceId) {
                // Focus unchanged and the device is alive. Count/names change
                // rarely, so refresh them on a slow clock instead of adding three
                // LiveAPI reads to every hot parameter tick.
                var now = (new Date()).getTime();
                if (now >= paramContextRefreshAt) {
                    loc.paramCount = get_count(deviceApi, "parameters", loc.paramCount);
                    loc.trackName = value_to_string(get_prop(loc.trackApi, "name", null)) || loc.trackName;
                    loc.deviceName = value_to_string(get_prop(deviceApi, "name", null)) || loc.deviceName;
                    paramContextRefreshAt = now + PARAMETER_CONTEXT_REFRESH_MS;
                }
                return loc;
            }
        }
    }

    var built = build_focused_device_location(
        selectedTrackId,
        focusProbe ? focusProbe.deviceId : undefined
    );
    paramFocusCache = built
        ? { selectedTrackId: selectedTrackId, selectedDeviceId: built.selectedDeviceId, loc: built }
        : null;
    paramContextRefreshAt = built
        ? (new Date()).getTime() + PARAMETER_CONTEXT_REFRESH_MS
        : 0;
    return built;
}

// Full (construction-heavy) resolution of the focused device: the selected
// track's view.selected_device, falling back to the first device so an open
// instrument is still tracked even when no device is explicitly appointed.
// Only called on focus change — the result (with its live objects) is cached.
function build_focused_device_location(selectedTrackId, selectedDeviceIdHint) {
    var trackIndex = find_track_index_by_id(selectedTrackId);
    if (trackIndex < 0) {
        return null;
    }

    var trackPath = "live_set tracks " + trackIndex;
    var track = safe_path(trackPath);
    if (!track) {
        return null;
    }

    var deviceCount = get_count(track, "devices", 0);
    if (deviceCount <= 0) {
        return null;
    }

    var view = safe_path(trackPath + " view");
    var selectedDeviceId = selectedDeviceIdHint;
    if (selectedDeviceId === undefined) {
        selectedDeviceId = view ? normalize_id(get_prop(view, "selected_device", null)) : null;
    }

    var deviceIndex = -1;
    if (selectedDeviceId) {
        var lookupLimit = Math.min(deviceCount, MAX_DEVICE_LOOKUP);
        for (var i = 0; i < lookupLimit; i++) {
            var candidate = safe_path(trackPath + " devices " + i);
            if (candidate && normalize_id(candidate.id) === selectedDeviceId) {
                deviceIndex = i;
                break;
            }
        }
    }

    if (deviceIndex < 0) {
        deviceIndex = 0;
    }

    var devicePath = trackPath + " devices " + deviceIndex;
    var device = safe_path(devicePath);
    if (!device) {
        return null;
    }

    var deviceId = normalize_id(device.id);

    return {
        trackIndex: trackIndex,
        trackName: value_to_string(get_prop(track, "name", null)),
        deviceIndex: deviceIndex,
        deviceName: value_to_string(get_prop(device, "name", null)) || ("Device " + deviceIndex),
        devicePath: devicePath,
        deviceKey: value_to_string(deviceId) || (trackIndex + ":" + deviceIndex),
        paramCount: get_count(device, "parameters", 0),
        selectedDeviceId: selectedDeviceId,
        trackApi: track,
        trackViewApi: view,
        deviceApi: device
    };
}

// The cached LiveAPI object for one of the focused device's parameters, built
// lazily the first time the sweep touches that index and reused every tick
// after. A dead object (id 0 — param vanished under us) is rebuilt once.
function focused_param_api(loc, index) {
    var api = paramApiByIndex[index];
    if (api && Number(api.id) !== 0) {
        return api;
    }
    if (paramApiByIndex[index] === undefined) {
        paramVisitedCount++;
    }
    api = safe_path(loc.devicePath + " parameters " + index);
    paramApiByIndex[index] = api || null;
    return api;
}

// One parameter through the gesture state machine: seed silently on first
// sighting; open a gesture (and mark the index hot) when the value starts
// moving; emit ONE settled parameter_changed for the whole ride once it has
// been still for PARAMETER_SETTLE_MS. Expensive reads (name/min/max/display)
// happen only at that settle point, inside emit_parameter_move.
function sample_focused_param(loc, gestures, index, now) {
    var param = focused_param_api(loc, index);
    if (!param) {
        return;
    }

    var value = value_to_number(get_prop(param, "value", null), null);
    if (value === null) {
        return;
    }

    var paramId = value_to_string(normalize_id(param.id)) || ("i" + index);
    var gesture = gestures[paramId];

    if (gesture === undefined) {
        // First sighting: seed silently so a pre-existing value never fires.
        gestures[paramId] = {
            index: index,
            last: value,
            baseline: value,
            sweptMin: value,
            sweptMax: value,
            active: false,
            lastChange: now
        };
        return;
    }

    // Track the chain index live — it can shift if the device chain reorders.
    gesture.index = index;

    if (Math.abs(value - gesture.last) > PARAMETER_VALUE_EPSILON) {
        if (!gesture.active) {
            gesture.active = true;
            gesture.baseline = gesture.last;
            gesture.sweptMin = gesture.last;
            gesture.sweptMax = gesture.last;
            // A ride is in progress: sample this param every tick from now on.
            paramHotIndices[index] = true;
        }
        if (value < gesture.sweptMin) { gesture.sweptMin = value; }
        if (value > gesture.sweptMax) { gesture.sweptMax = value; }
        gesture.last = value;
        gesture.lastChange = now;
        // Something is moving — stay at the hot cadence.
        paramPollHotUntil = now + PARAMETER_HOT_HOLD_MS;
    } else if (gesture.active && (now - gesture.lastChange) >= PARAMETER_SETTLE_MS) {
        emit_parameter_move(
            paramPollContextByKey[loc.deviceKey],
            gesture.index,
            gesture.baseline,
            gesture.last,
            gesture.sweptMin,
            gesture.sweptMax
        );
        gesture.active = false;
        gesture.baseline = gesture.last;
        delete paramHotIndices[index];
    }
}

// Cheap identity of what's focused — the selected track's id plus its selected
// device's id — read through canonical dynamic paths ("live_set view
// selected_track view"), so it costs a couple of reads and at most one cached
// LiveAPI. It deliberately does NOT pay the track-index / device-lookup loops the
// full rebuild pays. The resolved ids are passed into the full resolver too, so
// steady-state polling does not read selected_track/selected_device a second time.
function probe_focused_identity() {
    var view = param_live_set_view();
    if (!view) {
        return null;
    }
    var trackId = normalize_id(get_prop(view, "selected_track", null));
    if (!trackId) {
        return null;
    }
    var deviceId = null;
    var cache = paramFocusCache;
    if (
        cache && cache.selectedTrackId === trackId && cache.loc &&
        cache.loc.trackViewApi && Number(cache.loc.trackViewApi.id) !== 0
    ) {
        // Still on the committed device's track: read selected_device off that
        // already-validated track view — no path resolution, and reliable.
        deviceId = normalize_id(get_prop(cache.loc.trackViewApi, "selected_device", null));
    } else {
        // Different track (or no cache yet): the dynamic path follows the
        // selection, so this handle auto-tracks whichever track is selected.
        var tv = paramSelectedTrackViewApi;
        if (!(tv && Number(tv.id) !== 0)) {
            tv = safe_path("live_set view selected_track view");
            paramSelectedTrackViewApi = tv;
        }
        deviceId = tv ? normalize_id(get_prop(tv, "selected_device", null)) : null;
    }
    return {
        key: trackId + ":" + (deviceId === null ? "-" : deviceId),
        trackId: trackId,
        deviceId: deviceId
    };
}

// Sample the focused device's parameter values. Active rides are sampled every
// tick (full resolution no matter the plugin size); the rest of the device is
// swept round-robin, bounded by BOTH a count chunk and a wall-clock budget so a
// plugin with slow parameter reads can never spike the scheduler tick.
function poll_focused_device_parameters() {
    // Debounce focus changes before doing any expensive work. While the selection
    // is still moving (a click-through), do nothing but re-check soon — never
    // rebuild or reseed. Only once the same track:device has held still for
    // FOCUS_DEBOUNCE_MS do we commit and fall through to the (single) rebuild.
    var nowProbe = (new Date()).getTime();
    var focusProbe = probe_focused_identity();
    var identity = focusProbe ? focusProbe.key : null;
    if (identity !== committedFocusIdentity) {
        if (identity !== paramPendingKey) {
            paramPendingKey = identity;
            paramPendingSince = nowProbe;
        }
        if (nowProbe - paramPendingSince < FOCUS_DEBOUNCE_MS) {
            // Keep the cadence responsive so landing on a device feels instant once
            // clicking stops — these settle ticks do no LiveAPI-heavy work.
            if (paramPollHotUntil < nowProbe + PARAMETER_POLL_HOT_MS) {
                paramPollHotUntil = nowProbe + PARAMETER_POLL_HOT_MS;
            }
            return;
        }
        committedFocusIdentity = identity;
    }
    paramPendingKey = null;

    var loc = resolve_focused_device_location(focusProbe);

    if (!loc) {
        // Nothing focused (or the track/device vanished): flush any open gesture
        // from the device we were last on so it isn't left hanging, and drop the
        // dead device's cached objects.
        if (lastPolledDeviceKey) {
            flush_pending_param_gestures(lastPolledDeviceKey);
            lastPolledDeviceKey = null;
            reset_param_api_cache(-1);
        }
        return;
    }

    var deviceKey = loc.deviceKey;
    var now = (new Date()).getTime();

    if (lastPolledDeviceKey !== deviceKey) {
        // Focus moved to a different device: settle the outgoing device's open
        // gestures, drop its cached param objects, and go hot so the new device
        // seeds in a burst instead of trickling at the idle cadence.
        if (lastPolledDeviceKey) {
            flush_pending_param_gestures(lastPolledDeviceKey);
        }
        reset_param_api_cache(loc.paramCount);
        touch_param_device_cache(deviceKey);
        paramPollHotUntil = now + PARAMETER_HOT_HOLD_MS;
    } else if (paramApiCachedCount !== loc.paramCount) {
        // Same device but the chain shape changed underneath us (e.g. a VST
        // "Configure" exposed more params): indices are no longer trustworthy.
        reset_param_api_cache(loc.paramCount);
    }
    lastPolledDeviceKey = deviceKey;

    var pollContext = paramPollContextByKey[deviceKey];
    if (
        !pollContext ||
        pollContext.devicePath !== loc.devicePath ||
        pollContext.deviceName !== loc.deviceName ||
        pollContext.trackName !== loc.trackName
    ) {
        paramPollContextByKey[deviceKey] = {
            devicePath: loc.devicePath,
            deviceName: loc.deviceName,
            trackName: loc.trackName
        };
    }

    var gestures = paramGestureByDevice[deviceKey];
    if (gestures === undefined) {
        gestures = {};
        paramGestureByDevice[deviceKey] = gestures;
    }

    var total = Math.min(loc.paramCount, MAX_POLL_PARAMETERS_PER_DEVICE);
    if (total <= 0) {
        return;
    }

    var started = now;
    var scanned = 0;

    // 1) Rides in progress first, every tick, regardless of budget — there are
    // at most a handful and they are the whole point of the poller.
    for (var hotKey in paramHotIndices) {
        if (!paramHotIndices.hasOwnProperty(hotKey)) {
            continue;
        }
        var hotIndex = Number(hotKey);
        if (hotIndex >= total) {
            delete paramHotIndices[hotKey];
            continue;
        }
        sample_focused_param(loc, gestures, hotIndex, now);
        scanned++;
    }

    // 2) Round-robin the dormant remainder within the count AND time budget.
    var cursor = paramPollCursorByKey[deviceKey] || 0;
    while (scanned < PARAMETER_POLL_CHUNK && scanned < total) {
        if ((new Date()).getTime() - started >= PARAMETER_POLL_BUDGET_MS) {
            break;
        }
        if (cursor >= total) {
            cursor = 0;
        }

        var p = cursor;
        cursor++;
        scanned++;

        if (paramHotIndices[p]) {
            continue; // already sampled at full rate above
        }

        sample_focused_param(loc, gestures, p, now);
    }
    paramPollCursorByKey[deviceKey] = cursor;

    // Until the first full sweep of a freshly-focused device has visited every
    // parameter, keep the cadence hot so seeding takes ~a second, not minutes.
    if (paramVisitedCount < total && paramPollHotUntil < now + PARAMETER_POLL_HOT_MS * 2) {
        paramPollHotUntil = now + PARAMETER_POLL_HOT_MS * 2;
    }
}

// Emit one settled knob/fader move. Mirrors the canonical parameter_changed shape
// the Rust normalizer + timeline already consume (see docs/recall-protocol-v2.md):
// `parameter_value`/`previous_parameter_value` are after/before; the *_percent
// pair is positioned within the param's full range; parameter_value_min/max carry
// the swept extent of the ride; the *_display pair is Live's own formatted string.
function emit_parameter_move(ctx, paramIndex, baseline, settled, sweptMin, sweptMax) {
    if (!ctx) {
        return;
    }

    var param = safe_path(ctx.devicePath + " parameters " + paramIndex);
    if (!param) {
        return;
    }

    var paramName = value_to_string(get_prop(param, "name", null)) || ("Param " + paramIndex);
    var minValue = value_to_number(get_prop(param, "min", null), null);
    var maxValue = value_to_number(get_prop(param, "max", null), null);
    var isQuantized = value_to_bool(get_prop(param, "is_quantized", 0));

    var afterPercent = parameter_value_percent(settled, minValue, maxValue);
    var beforePercent = parameter_value_percent(baseline, minValue, maxValue);
    var afterDisplay = parameter_display(param, settled, isQuantized);
    var beforeDisplay = parameter_display(param, baseline, isQuantized);

    // For a quantized (mode-selector) param the display LABEL is the meaningful
    // value. If the raw value crossed the epsilon but still maps to the same label
    // (e.g. "No Warp Type" -> "No Warp Type"), nothing the producer cares about
    // changed — suppress it so the timeline isn't cluttered with phantom mode flips.
    if (isQuantized && afterDisplay !== null && afterDisplay === beforeDisplay) {
        return;
    }

    emit(
        "parameter_changed",
        "Parameter Changed",
        paramName + " moved on " + ctx.deviceName + ".",
        {
            track_name: ctx.trackName,
            device_name: ctx.deviceName,
            parameter_name: paramName,
            parameter_value: settled,
            previous_parameter_value: baseline,
            previous_value: baseline,
            parameter_value_percent: afterPercent,
            previous_parameter_value_percent: beforePercent,
            parameter_value_min: sweptMin,
            parameter_value_max: sweptMax,
            parameter_display_value: afterDisplay,
            previous_parameter_display_value: beforeDisplay,
            parameter_is_quantized: isQuantized
        },
        {
            track_name: ctx.trackName,
            device_name: ctx.deviceName,
            parameter_name: paramName,
            parameter_value: settled,
            previous_parameter_value: baseline,
            parameter_value_percent: afterPercent,
            previous_parameter_value_percent: beforePercent,
            parameter_value_min: sweptMin,
            parameter_value_max: sweptMax,
            parameter_display_value: afterDisplay,
            previous_parameter_display_value: beforeDisplay,
            parameter_is_quantized: isQuantized
        }
    );
}

// Emit any open (un-settled) gesture on a device immediately. Used when focus
// leaves a device or the bridge stops, so a tweak made right before the switch
// isn't lost waiting for its settle window.
function flush_pending_param_gestures(deviceKey) {
    if (!deviceKey) {
        return;
    }

    var gestures = paramGestureByDevice[deviceKey];
    var ctx = paramPollContextByKey[deviceKey];
    if (!gestures || !ctx) {
        return;
    }

    for (var paramId in gestures) {
        if (!gestures.hasOwnProperty(paramId)) {
            continue;
        }

        var gesture = gestures[paramId];
        if (gesture && gesture.active) {
            try {
                emit_parameter_move(
                    ctx,
                    gesture.index,
                    gesture.baseline,
                    gesture.last,
                    gesture.sweptMin,
                    gesture.sweptMax
                );
            } catch (error) {
                debug("param flush emit failed: " + error);
            }
            gesture.active = false;
            gesture.baseline = gesture.last;
        }
    }
}

function flush_all_param_gestures() {
    for (var deviceKey in paramGestureByDevice) {
        if (paramGestureByDevice.hasOwnProperty(deviceKey)) {
            flush_pending_param_gestures(deviceKey);
        }
    }
}

function build_id_name_map(items, idKey, nameKey) {
    var map = {};

    if (items instanceof Array) {
        for (var i = 0; i < items.length; i++) {
            var item = items[i];
            if (item && item[idKey] !== null && item[idKey] !== undefined) {
                map[String(item[idKey])] = item[nameKey];
            }
        }
    }

    return map;
}

function build_clip_slot_map(clips) {
    var map = {};

    if (clips instanceof Array) {
        for (var i = 0; i < clips.length; i++) {
            var clip = clips[i];
            if (clip && clip.slot_index !== null && clip.slot_index !== undefined) {
                map[String(clip.slot_index)] = {
                    id: clip.clip_id,
                    name: clip.name,
                    is_audio_clip: clip.is_audio_clip,
                    is_midi_clip: clip.is_midi_clip,
                    file_path: clip.file_path,
                    sample_name: basename(clip.file_path)
                };
            }
        }
    }

    return map;
}

// Emit the right high-level event for a newly-appeared clip. One drag of a
// Splice sample becomes ONE sample_added event (with the real file name), not a
// pile of generic clip-mutation logs. Branching:
//   audio clip + file_path -> sample_added (imported/dragged sample)
//   audio clip, no path    -> audio_clip_added (recorded/resampled audio)
//   midi clip              -> midi_clip_created
//   anything else          -> clip_created (safe fallback)
function emit_clip_created(trackName, clip) {
    if (!clip) {
        return;
    }

    var clipName = clip.name || null;
    var sampleName = clip.sample_name || null;
    var filePath = clip.file_path || null;

    if (clip.is_audio_clip && sampleName) {
        emit("sample_added", "Sample Added",
            "Sample \"" + sampleName + "\" was added to \"" + trackName + "\".",
            { track_name: trackName, sample_name: sampleName, file_path: filePath, clip_name: clipName },
            { track_name: trackName, sample_name: sampleName, file_path: filePath, clip_name: clipName });
        return;
    }

    if (clip.is_audio_clip) {
        emit("audio_clip_added", "Audio Clip Added",
            "An audio clip was added to \"" + trackName + "\".",
            { track_name: trackName, clip_name: clipName },
            { track_name: trackName, clip_name: clipName });
        return;
    }

    if (clip.is_midi_clip) {
        emit("midi_clip_created", "MIDI Clip Created",
            "A MIDI clip was created on \"" + trackName + "\".",
            { track_name: trackName, clip_name: clipName },
            { track_name: trackName, clip_name: clipName });
        return;
    }

    emit("clip_created", "Clip Created", "A clip was created on the selected track.",
        { track_name: trackName, clip_name: clipName },
        { track_name: trackName, clip_name: clipName });
}

function collect_focus_devices_for_track(trackIndex, limit) {
    return collect_focus_devices_for_path("live_set tracks " + trackIndex, limit);
}

// Path-based device collector so it works for ANY track object: regular tracks
// ("live_set tracks N"), the master track ("live_set master_track"), and return
// tracks ("live_set return_tracks N").
function collect_focus_devices_for_path(trackPath, limit) {
    var devices = [];

    for (var i = 0; i < limit; i++) {
        var device = safe_path(trackPath + " devices " + i);

        if (!device) {
            continue;
        }

        // Parameter values are deliberately NOT collected here. The periodic
        // focus scan runs while the producer plays and edits, and pulling every
        // device's parameters (up to MAX_FOCUS_DEVICES * MAX_FOCUS_PARAMETERS_PER_DEVICE
        // LiveAPI reads per tick) on Max's main thread is the dominant source of
        // the audio/UI lag — and nothing downstream consumes the values. Worse,
        // parameter values change continuously during playback, so including them
        // busted the snapshot dedup and forced a full re-emit every tick. We keep
        // only the cheap structural fields the timeline actually uses (name drives
        // the device chain). Deep parameter capture still exists on demand via
        // the manual deep_session_snapshot path.
        devices.push({
            index: i,
            id: normalize_id(device.id),
            name: value_to_string(get_prop(device, "name", null)),
            class_name: value_to_string(get_prop(device, "class_name", null)),
            type: get_prop(device, "type", null),
            role: device_role(device),
            is_active: value_to_bool(get_prop(device, "is_active", 0)),
            parameter_count: get_count(device, "parameters", 0)
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
            is_midi_clip: clip ? value_to_bool(get_prop(clip, "is_midi_clip", 0)) : null,
            // file_path is only meaningful for audio clips — it's the on-disk
            // sample backing the clip (e.g. a Splice drag-in). We read it so the
            // timeline can name the actual sample, not just "a clip appeared".
            file_path: (clip && value_to_bool(get_prop(clip, "is_audio_clip", 0)))
                ? value_to_string(get_prop(clip, "file_path", null))
                : null
        });
    }

    return clips;
}

// Extract just the file name (with extension) from a full path. Handles both
// Windows backslashes and POSIX slashes since Live reports native paths.
function basename(path) {
    if (!path) {
        return null;
    }

    var normalized = String(path).replace(/\\/g, "/");
    var parts = normalized.split("/");
    var last = parts[parts.length - 1];

    return last && last.length > 0 ? last : null;
}

function project_name_from_path(path) {
    var file = basename(path);

    if (!file) {
        return null;
    }

    return String(file).replace(/\.als$/i, "");
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
    var returnTrackCount = get_count(liveSet, "return_tracks", 0);

    return {
        available: true,
        transport: collect_transport_snapshot(),
        counts: {
            tracks: trackCount,
            return_tracks: returnTrackCount,
            scenes: sceneCount
        },
        selected_track: collect_selected_track_focus_snapshot(),
        tracks: collect_deep_tracks_snapshot(Math.min(trackCount, MAX_DEEP_TRACKS)),
        return_tracks: collect_deep_return_tracks_snapshot(Math.min(returnTrackCount, MAX_DEEP_TRACKS)),
        scenes: collect_scene_summaries(Math.min(sceneCount, MAX_DEEP_SCENES))
    };
}

// Return tracks live in a separate Live collection, so they need their own pass.
// We capture name + effect chain (via the shared path-based device collector) but
// skip per-parameter reads — a return's identity is its name + audio-effect chain,
// and the heavy parameter scan isn't worth it here. The app types these as Return.
function collect_deep_return_tracks_snapshot(limit) {
    var tracks = [];

    for (var i = 0; i < limit; i++) {
        var path = "live_set return_tracks " + i;
        var track = safe_path(path);

        if (!track) {
            continue;
        }

        var deviceCount = get_count(track, "devices", 0);

        tracks.push({
            index: i,
            id: normalize_id(track.id),
            name: value_to_string(get_prop(track, "name", null)),
            color: get_prop(track, "color", null),
            device_count: deviceCount,
            devices: collect_focus_devices_for_path(
                path,
                Math.min(deviceCount, MAX_DEEP_DEVICES_PER_TRACK)
            )
        });
    }

    return tracks;
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
            // has_midi_input cleanly separates MIDI tracks from audio tracks; the
            // app reads it to type the track. group_track_id is the parent group
            // track (null when ungrouped), which rebuilds the Group -> Track nesting.
            has_midi_input: value_to_bool(get_prop(track, "has_midi_input", 0)),
            group_track_id: normalize_id(get_prop(track, "group_track", null)),
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
            role: device_role(device),
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
    captureParameterMoves = false;
    captureBuses = false;
    captureStructure = false;
    captureLiveSet = false;
    structureTask.cancel();
    debug("SAFE MODE: all LiveAPI scans disabled (heartbeat only)");
}

function full_capture() {
    captureTransport = true;
    captureFocus = true;
    captureParameterMoves = true;
    captureBuses = true;
    captureStructure = true;
    captureLiveSet = true;
    schedule_structure_scan(STRUCTURE_INTERVAL_MS + 2000);
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

// Manual "recapture full set": force a fresh whole-set baseline now, ignoring
// the change-guards, so a [recapture_set] message (e.g. a button on the device)
// re-imports everything currently in the set.
function recapture_set() {
    lastLiveSetFingerprint = "";
    lastBaselinedFingerprint = null;
    baselineTask.cancel();
    baselineTask.schedule(200);
}

function capture_buses(value) {
    captureBuses = Number(value) === 1;
    debug("capture_buses = " + captureBuses);
}

function capture_structure(value) {
    captureStructure = Number(value) === 1;
    structureTicksSkippedWhilePlaying = 0;
    schedule_structure_scan(STRUCTURE_INTERVAL_MS);
    debug("capture_structure = " + captureStructure);
}

function capture_parameter_moves(value) {
    captureParameterMoves = Number(value) === 1;
    debug("capture_parameter_moves = " + captureParameterMoves);
}

// Live-tune the focused-device poll rate (ms) without redeploying. Floored so a
// fat-fingered tiny value can't spin the scheduler. Takes effect on the next tick.
function parameter_poll_interval(value) {
    var ms = Number(value);
    if (!isNaN(ms) && ms >= 50) {
        PARAMETER_POLL_HOT_MS = ms;
        PARAMETER_POLL_IDLE_MS = Math.max(ms, ms * 4);
    }
    debug(
        "parameter_poll_interval hot=" + PARAMETER_POLL_HOT_MS +
        "ms idle=" + PARAMETER_POLL_IDLE_MS + "ms"
    );
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
