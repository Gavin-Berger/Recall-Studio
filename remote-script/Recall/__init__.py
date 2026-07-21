# Recall Studio - Ableton control surface (MIDI Remote Script)
#
# PHASE 0 SPIKE. This deliberately does almost nothing. Its whole job is to
# answer the two questions that decide whether the control surface can replace
# the Max for Live bridge:
#
#   1. Can a remote script load in Live 12 and open a UDP socket at all?
#      (Live's embedded Python ships socket.pyc, so the module exists — but
#      shipping and being permitted to bind are different claims.)
#   2. Do LOM parameter listeners fire cleanly on a knob ride, and what do
#      they cost? That is the real question. Structure capture was never in
#      doubt; parameters are half the beta scope, and if listeners cannot
#      carry them then M4L stays, and with it the Live Suite requirement.
#
# What this is NOT: a capture implementation. No gesture thinning, no schema,
# no reconnect logic. Those come after the answers.
#
# Runtime: Python 3.11 (Live 12's embedded interpreter).

from __future__ import annotations

import json
import logging
import queue
import socket
import threading
import time

from ableton.v2.control_surface import ControlSurface

# ableton.v2 has no self.log_message (that was _Framework). Standard logging
# lands in Live's Log.txt, which carries full tracebacks with file and line.
logger = logging.getLogger(__name__)

# Must match the Rust listener in src-tauri/src/udp_listener.rs, which binds
# 127.0.0.1:9000 and accepts "recall.v2".
RECALL_HOST = "127.0.0.1"
# TCP, not the bridge's UDP 9000. A whole-set snapshot of a large project exceeds
# UDP's 65,507-byte datagram ceiling and is dropped entire, with no error the
# producer can see. TCP has no size limit and confirms delivery.
RECALL_PORT = 9001
PROTOCOL = "recall.v2"

# Bound on the outbound queue. If the app is not running, events pile up here and
# nowhere else; past this they are dropped OLDEST-first, so a long session with no
# listener cannot grow memory without limit. Sized for a dense knob ride
# (~350 events/sec) to survive several seconds of backlog.
SEND_QUEUE_MAX = 2048
RECONNECT_DELAY_SEC = 2.0

# Ceiling on listeners registered per device. A wavetable synth can expose
# thousands of parameters; registering all of them on every selection change is
# the one place this design could get expensive. The parameters a producer
# actually rides live near the top of the list.
MAX_PARAMS_PER_DEVICE = 128

# Distinct from the bridge's "max_for_live" so events from the two capture tiers
# are told apart in the database. The listener defaults source to max_for_live
# when absent, so this must always be sent explicitly.
SOURCE = "control_surface"
SCRIPT_VERSION = "0.1.0-spike"


class Recall(ControlSurface):
    """Minimal control surface that reports what it can see to Recall Studio."""

    def __init__(self, c_instance):
        super().__init__(c_instance)
        self._queue = None
        self._thread = None
        self._stop = None
        self._parameter_listeners = []
        self._device_listeners = []
        self._observed_device = None
        self._observed_track = None
        # paramId -> last value seen, so each move can report what it moved FROM.
        # Live's listener callback carries no value and no previous value, so the
        # before-side has to be remembered here.
        self._last_values = {}
        self._moves_seen = 0

        with self.component_guard():
            self._open_socket()
            self._emit(
                "bridge_started",
                {
                    "script_version": SCRIPT_VERSION,
                    "python_ok": True,
                    # Proves the LOM is reachable from here, not just that the
                    # script loaded — a script that loads but cannot read the
                    # song is a different (worse) failure.
                    "track_count": len(self.song.tracks),
                    "return_count": len(self.song.return_tracks),
                    "has_master": self.song.master_track is not None,
                },
            )
            self._listen_to_selection()
            self._send_snapshot()

        logger.info(
            "Recall Studio control surface {} loaded (socket={})".format(
                SCRIPT_VERSION, self._queue is not None
            )
        )

    # ── transport ──────────────────────────────────────────────────────────

    def _open_socket(self):
        """Start the background sender.

        WHY A THREAD AND A QUEUE, when UDP needed neither: UDP was
        fire-and-forget — a sendto that could not complete simply failed and we
        moved on. TCP connects, blocks, retries and can stall on a slow reader,
        and ALL of that would happen on Live's thread, which is the thread that
        must never wait. So _emit only ever puts a string on a queue, and a
        daemon thread owns the socket, the connecting, and the reconnecting.
        """
        self._queue = queue.Queue(maxsize=SEND_QUEUE_MAX)
        self._stop = threading.Event()
        self._thread = threading.Thread(
            target=self._sender_loop, name="RecallSender", daemon=True
        )
        self._thread.start()

    def _sender_loop(self):
        sock = None

        while not self._stop.is_set():
            try:
                if sock is None:
                    sock = socket.create_connection(
                        (RECALL_HOST, RECALL_PORT), timeout=2.0
                    )
                    logger.info("Recall Studio: connected to app")

                try:
                    line = self._queue.get(timeout=0.5)
                except queue.Empty:
                    continue

                sock.sendall(line)

            except Exception:  # noqa: BLE001
                # App closed, not started yet, or the connection dropped. None of
                # these are errors from Live's point of view — the producer may
                # simply not have opened Recall. Close, wait, and retry forever.
                if sock is not None:
                    try:
                        sock.close()
                    except Exception:  # noqa: BLE001
                        pass
                    sock = None

                self._stop.wait(RECONNECT_DELAY_SEC)

        # Flush whatever is still queued before closing. disconnect() emits
        # bridge_stopped and then immediately signals stop, so without this drain
        # the last event of every session would be the one guaranteed to be lost.
        if sock is not None:
            try:
                while True:
                    sock.sendall(self._queue.get_nowait())
            except Exception:  # noqa: BLE001 - empty queue or dead socket, both fine
                pass

            try:
                sock.close()
            except Exception:  # noqa: BLE001
                pass

    def _emit(self, event_type, payload=None):
        if self._queue is None:
            return

        event = {
            "protocol": PROTOCOL,
            "source": SOURCE,
            "event_type": event_type,
            "timestamp_ms": int(time.time() * 1000),
            "payload": payload or {},
        }

        try:
            # Newline-delimited JSON: TCP is a stream with no message boundaries,
            # so the receiver splits on newlines. Safe because json.dumps escapes
            # any newline inside a string value.
            line = (json.dumps(event) + "\n").encode("utf-8")
        except Exception as error:  # noqa: BLE001
            logger.info("Recall Studio: serialize failed ({}): {}".format(event_type, error))
            return

        try:
            self._queue.put_nowait(line)
        except queue.Full:
            # Drop the OLDEST event, not this one. A full queue means nothing is
            # reading, and in that state the most recent state of the set is far
            # more useful than the start of a backlog nobody consumed.
            try:
                self._queue.get_nowait()
                self._queue.put_nowait(line)
            except Exception:  # noqa: BLE001
                pass

    # ── the actual experiment ──────────────────────────────────────────────

    def _listen_to_selection(self):
        """Re-point parameter listeners whenever the focused device changes.

        Scoped to ONE device on purpose. The M4L bridge crashed Live by walking
        every track; the equivalent mistake here would be listening to every
        parameter in the set. Bounded to the focused device, this is the same
        scope the bridge settled on, reached by a cheaper mechanism.
        """
        self.song.view.add_selected_track_listener(self._on_selection_changed)

        # Tempo and track-list listeners. Three lines each, and they test the
        # thing that actually broke last night: a track added mid-session never
        # reached the app, and the fix I tried (re-walking the whole set on every
        # structural change) crashed Live. If add_tracks_listener fires here,
        # the same outcome costs one callback and no traversal at all.
        self.song.add_tempo_listener(self._on_tempo_changed)
        self.song.add_tracks_listener(self._on_tracks_changed)

        self._on_selection_changed()

    # ── whole-set snapshot ─────────────────────────────────────────────────

    def _serialize_device(self, device):
        # Parameter VALUES only, no listeners. This is a structural description,
        # and it is what the Rust projection reads to build the track tree.
        parameters = []
        for parameter in device.parameters:
            parameters.append(
                {
                    "id": str(parameter._live_ptr),
                    "name": parameter.name,
                    "value": parameter.value,
                    "min": parameter.min,
                    "max": parameter.max,
                }
            )

        return {
            "id": str(device._live_ptr),
            "name": device.name,
            "is_active": True,
            "parameters": parameters,
        }

    @staticmethod
    def _track_type(track):
        # Send the type explicitly rather than letting the projection infer it
        # from the device list. Inference gets an audio track with no devices
        # wrong, and "is this MIDI or audio" is something Live knows for certain.
        try:
            if track.is_foldable:
                return "group"
            return "midi" if track.has_midi_input else "audio"
        except Exception:  # noqa: BLE001 - return/master tracks lack these
            return "audio"

    def _serialize_track(self, track, index):
        return {
            "id": str(track._live_ptr),
            "name": track.name,
            "index": index,
            "track_type": self._track_type(track),
            "devices": [self._serialize_device(d) for d in track.devices],
        }

    def _send_snapshot(self):
        """Emit the whole-set snapshot the app projects its schema from.

        Unlike the M4L bridge this is NOT a periodic scan — it is sent once on
        load and then only when the track list actually changes. Reading the LOM
        from here is cheap (no LiveAPI object construction per property), which
        is what made the equivalent walk dangerous in Max.
        """
        song = self.song

        payload = {
            "tempo": song.tempo,
            "track_count": len(song.tracks),
            "tracks": [
                self._serialize_track(track, i) for i, track in enumerate(song.tracks)
            ],
            "return_tracks": [
                self._serialize_track(track, i)
                for i, track in enumerate(song.return_tracks)
            ],
            "master_track": self._serialize_track(song.master_track, 0),
        }

        self._emit("live_set_snapshot", payload)

    def _on_tempo_changed(self):
        self._emit("tempo_changed", {"bpm": self.song.tempo})


    def _on_tracks_changed(self):
        self._emit(
            "track_list_changed",
            {
                "track_count": len(self.song.tracks),
                "track_names": [track.name for track in self.song.tracks],
            },
        )
        # Re-snapshot so a track added mid-session reaches the app. This is the
        # bug that crashed Live last night when the M4L bridge tried it: there,
        # every structural change meant a full LiveAPI traversal. Here it is a
        # plain read of objects Live already holds, triggered by a callback
        # rather than by polling.
        self._send_snapshot()

    def _on_selection_changed(self):
        """Selection changed: re-point the devices listener, then re-attach params."""
        self._clear_parameter_listeners()
        self._clear_devices_listener()

        track = self.song.view.selected_track

        # Watch the selected track's DEVICE LIST, not just its current devices.
        # Without this, selecting an empty track and then dropping a plugin on it
        # attaches nothing: the parameters we want did not exist at selection
        # time and nothing tells us they appeared. That is exactly what happened
        # on the last run — three focus_changed events, all with zero devices,
        # because the Saturator arrived after the selection did.
        if track is not None:
            track.add_devices_listener(self._on_devices_changed)
            self._observed_track = track

        self._attach_to_focused_device(track)

    def _on_devices_changed(self):
        # A device was added, removed, or reordered on the track we are watching.
        self._clear_parameter_listeners()
        self._attach_to_focused_device(self.song.view.selected_track)

    def _clear_devices_listener(self):
        track = self._observed_track
        self._observed_track = None

        if track is None:
            return

        try:
            if track.devices_has_listener(self._on_devices_changed):
                track.remove_devices_listener(self._on_devices_changed)
        except Exception:  # noqa: BLE001 - track may already be deleted
            pass

    def _attach_to_focused_device(self, track):

        # Emit even when there is nothing to observe. A silent return here is
        # indistinguishable from a listener that never fired — which is exactly
        # the ambiguity that cost us a restart cycle a moment ago.
        if track is None or not track.devices:
            self._emit(
                "focus_changed",
                {
                    "track_name": track.name if track else None,
                    "device_name": None,
                    "parameter_count": 0,
                },
            )
            return

        # EVERY device on the track, not just devices[0].
        #
        # Watching only the first device meant a tweak to the second plugin in a
        # chain vanished — and producers work down a chain, not on slot one. The
        # scope that matters for safety is the TRACK (never the whole set), so
        # widening within the selected track costs listener registrations and no
        # traversal.
        parameter_count = 0

        for device in track.devices:
            # Skip parameter-less devices and guard racks, whose parameter lists
            # can be enormous; MAX_PARAMS_PER_DEVICE keeps one Serum from
            # registering thousands of listeners in a single pass.
            for parameter in device.parameters[:MAX_PARAMS_PER_DEVICE]:
                # Seed the last-known value so the FIRST move reports a real
                # before-value instead of inventing one. Without this the opening
                # move of every gesture reads as "changed from nothing".
                self._last_values[id(parameter)] = parameter.value
                listener = self._make_parameter_listener(track, device, parameter)
                parameter.add_value_listener(listener)
                self._parameter_listeners.append((parameter, listener))
                parameter_count += 1

            # Device on/off. Bypassing a plugin is a real production decision and
            # was previously invisible.
            toggle = self._make_device_toggle_listener(track, device)
            device.add_is_active_listener(toggle)
            self._device_listeners.append((device, toggle))

        self._observed_device = track.devices[0]

        self._emit(
            "focus_changed",
            {
                "track_name": track.name,
                "device_name": track.devices[0].name,
                "device_count": len(track.devices),
                "device_chain": [d.name for d in track.devices],
                "parameter_count": parameter_count,
            },
        )

    def _make_device_toggle_listener(self, track, device):
        def _on_toggle():
            self._emit(
                "device_toggled",
                {
                    "track_name": track.name,
                    "track_id": str(track._live_ptr),
                    "device_name": device.name,
                    "is_active": bool(device.is_active),
                },
            )

        return _on_toggle

    @staticmethod
    def _percent(parameter, value):
        """Position within the parameter's range, 0-100.

        The app displays moves as "before → after" percentages, so a raw value
        alone is not enough: 0.66 means nothing without knowing the range it
        sits in. Guards a zero-width range, which shows up on switches and
        single-option choosers.
        """
        span = parameter.max - parameter.min
        if span <= 0:
            return None
        return round(((value - parameter.min) / span) * 100.0, 2)

    def _make_parameter_listener(self, track, device, parameter):
        # Closure per parameter: Live's listener callbacks take no arguments, so
        # identity has to be captured here rather than looked up on fire.
        def _on_value():
            self._moves_seen += 1

            key = id(parameter)
            current = parameter.value
            previous = self._last_values.get(key, current)
            self._last_values[key] = current

            self._emit(
                "parameter_changed",
                {
                    # Track identity, without which the app cannot attribute a
                    # move to a lane — the timeline read "37 moves, 0 tracks
                    # touched" while every lane sat empty.
                    "track_name": track.name,
                    "track_id": str(track._live_ptr),
                    "device_name": device.name,
                    "parameter_name": parameter.name,
                    "parameter_value": current,
                    "previous_parameter_value": previous,
                    "parameter_value_percent": self._percent(parameter, current),
                    "previous_parameter_value_percent": self._percent(parameter, previous),
                    # Raw and unthinned ON PURPOSE for the spike: the point is to
                    # measure how dense a knob ride really is before deciding how
                    # to thin it. The M4L gesture state machine ports here once
                    # that number is known.
                    "moves_seen": self._moves_seen,
                },
            )

        return _on_value

    def _clear_parameter_listeners(self):
        for parameter, listener in self._parameter_listeners:
            try:
                if parameter.value_has_listener(listener):
                    parameter.remove_value_listener(listener)
            except Exception:  # noqa: BLE001 - device may already be gone
                pass
        for device, listener in self._device_listeners:
            try:
                if device.is_active_has_listener(listener):
                    device.remove_is_active_listener(listener)
            except Exception:  # noqa: BLE001 - device may already be gone
                pass

        self._parameter_listeners = []
        self._device_listeners = []
        self._observed_device = None
        # Drop remembered values with the listeners. Keeping them would let a
        # stale before-value attach to a different device that happens to reuse
        # the same object id.
        self._last_values = {}

    def refresh_state(self):
        """Live calls this when the open SET changes, among other times.

        Without it, opening an existing project after Live is already running
        captures nothing: the script snapshots on load, so a set opened later
        never gets described, and its pre-existing tracks and devices stay
        invisible. The listeners are re-pointed too, since the previous song's
        objects are gone and the old registrations are dead.
        """
        super().refresh_state()

        with self.component_guard():
            self._clear_parameter_listeners()
            self._clear_devices_listener()
            self._on_selection_changed()
            self._send_snapshot()

    # ── teardown ───────────────────────────────────────────────────────────

    def disconnect(self):
        # Live calls this on script unload and on quit. Leaking listeners here is
        # how a remote script starts crashing Live on set changes, so it has to
        # be exhaustive even in a spike.
        self._clear_parameter_listeners()
        self._clear_devices_listener()

        try:
            if self.song.view.selected_track_has_listener(self._on_selection_changed):
                self.song.view.remove_selected_track_listener(
                    self._on_selection_changed
                )
            if self.song.tempo_has_listener(self._on_tempo_changed):
                self.song.remove_tempo_listener(self._on_tempo_changed)
            if self.song.tracks_has_listener(self._on_tracks_changed):
                self.song.remove_tracks_listener(self._on_tracks_changed)
        except Exception:  # noqa: BLE001
            pass

        self._emit("bridge_stopped", {"moves_seen": self._moves_seen})

        # Give the sender a moment to flush bridge_stopped before tearing it
        # down, but never block Live's quit on it — a daemon thread dies with the
        # process regardless, so the join is a courtesy with a hard ceiling.
        if self._stop is not None:
            self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=1.0)

        self._queue = None
        self._thread = None

        super().disconnect()


def create_instance(c_instance):
    """Entry point Live calls to instantiate the control surface."""
    return Recall(c_instance)
