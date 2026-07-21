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
import socket
import time

from ableton.v2.control_surface import ControlSurface

# ableton.v2 has no self.log_message (that was _Framework). Standard logging
# lands in Live's Log.txt, which carries full tracebacks with file and line.
logger = logging.getLogger(__name__)

# Must match the Rust listener in src-tauri/src/udp_listener.rs, which binds
# 127.0.0.1:9000 and accepts "recall.v2".
RECALL_HOST = "127.0.0.1"
RECALL_PORT = 9000
PROTOCOL = "recall.v2"

# Distinct from the bridge's "max_for_live" so events from the two capture tiers
# are told apart in the database. The listener defaults source to max_for_live
# when absent, so this must always be sent explicitly.
SOURCE = "control_surface"
SCRIPT_VERSION = "0.1.0-spike"


class Recall(ControlSurface):
    """Minimal control surface that reports what it can see to Recall Studio."""

    def __init__(self, c_instance):
        super().__init__(c_instance)
        self._socket = None
        self._parameter_listeners = []
        self._observed_device = None
        self._observed_track = None
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
                SCRIPT_VERSION, self._socket is not None
            )
        )

    # ── transport ──────────────────────────────────────────────────────────

    def _open_socket(self):
        # Fire-and-forget UDP, same posture as the M4L bridge: capture must never
        # block Live's thread waiting on a reader that may not exist.
        try:
            self._socket = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            self._socket.setblocking(False)
        except Exception as error:  # noqa: BLE001 - any failure here kills the spike
            self._socket = None
            logger.info("Recall Studio: socket creation FAILED: {}".format(error))

    def _emit(self, event_type, payload=None):
        if self._socket is None:
            return

        event = {
            "protocol": PROTOCOL,
            "source": SOURCE,
            "event_type": event_type,
            "timestamp_ms": int(time.time() * 1000),
            "payload": payload or {},
        }

        try:
            self._socket.sendto(
                json.dumps(event).encode("utf-8"), (RECALL_HOST, RECALL_PORT)
            )
        except Exception as error:  # noqa: BLE001
            # Never let a send failure surface into Live.
            logger.info("Recall Studio: send failed ({}): {}".format(event_type, error))

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

    def _serialize_track(self, track, index):
        return {
            "id": str(track._live_ptr),
            "name": track.name,
            "index": index,
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

        device = track.devices[0]
        self._observed_device = device

        for parameter in device.parameters:
            listener = self._make_parameter_listener(device, parameter)
            parameter.add_value_listener(listener)
            self._parameter_listeners.append((parameter, listener))

        self._emit(
            "focus_changed",
            {
                "track_name": track.name,
                "device_name": device.name,
                "parameter_count": len(device.parameters),
            },
        )

    def _make_parameter_listener(self, device, parameter):
        # Closure per parameter: Live's listener callbacks take no arguments, so
        # identity has to be captured here rather than looked up on fire.
        def _on_value():
            self._moves_seen += 1
            self._emit(
                "parameter_changed",
                {
                    "device_name": device.name,
                    "parameter_name": parameter.name,
                    "parameter_value": parameter.value,
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
        self._parameter_listeners = []
        self._observed_device = None

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

        if self._socket is not None:
            try:
                self._socket.close()
            except Exception:  # noqa: BLE001
                pass
            self._socket = None

        super().disconnect()


def create_instance(c_instance):
    """Entry point Live calls to instantiate the control surface."""
    return Recall(c_instance)
