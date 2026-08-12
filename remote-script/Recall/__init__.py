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
# Both answers came back yes, so this is no longer only a spike: it now carries
# gesture thinning, reconnect logic, the whole-set snapshot the schema projects
# from, and clip-note capture.
#
# WHAT IS CAPTURED, and the rule behind it: this reports DECISIONS, not data. A
# knob ride becomes one settled move; a written phrase becomes one note edit
# describing what changed about the part. The authoritative content — every note
# of every clip — lives in the .als for the take and is read from there. Sending
# it through this socket would cost a note scan on Live's thread and bury the
# timeline in rows nobody reads.
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

# How often the bridge tells the app it is still alive.
#
# The app decides "connected" from ONE fact: a `heartbeat` event seen inside a
# 5-second window (src-tauri/src/udp_listener.rs::get_status). Every other event
# this script sends is a consequence of the producer doing something, so without
# a heartbeat a set sitting open and untouched reads as disconnected -- which is
# exactly the state a user is in the moment they finish setup and look at the app
# to see whether it worked.
#
# 2s sits well inside the 5s window: a single missed tick still leaves two more
# before the indicator could flip.
HEARTBEAT_INTERVAL_SEC = 2.0

# Ceiling on listeners registered per device. A wavetable synth can expose
# thousands of parameters; registering all of them on every selection change is
# the one place this design could get expensive. The parameters a producer
# actually rides live near the top of the list.
MAX_PARAMS_PER_DEVICE = 128

# Mixer controls are a compact, high-value exception to the focused-device
# listener rule below. A large set can have hundreds of plugin parameters per
# track, but every mixer channel has just volume, pan, and at most one send per
# Return track. Cap sends defensively anyway: losing a 17th send is preferable
# to an unusual Live build registering an unbounded listener collection.
MAX_MIXER_SENDS_PER_TRACK = 16

# Ceiling on clips watched per track, and on notes read out of any one clip.
#
# Notes are the one thing in this script that can be genuinely large: a bounced
# MIDI performance or a densely programmed hat pattern runs to thousands of
# events, and the read happens on Live's thread. Both caps are about that read,
# not about listener count — registering a notes listener is free, reading the
# roll is not.
MAX_CLIPS_PER_TRACK = 64
MAX_NOTES_READ = 4096


def _snapshot_fingerprint(payload):
    """Deterministic fingerprint of a snapshot payload, for change detection.

    sort_keys makes two dicts with the same content fingerprint identically
    regardless of key insertion order -- the payload is rebuilt fresh on every
    call, so relying on dict ordering being stable would be fragile. Module-level
    (not a method) so it is exercised directly by tests without constructing a
    Recall/ControlSurface instance, which has side effects (opens a socket,
    starts a thread) inappropriate for a unit test.
    """
    return json.dumps(payload, sort_keys=True)


# Attribute names worth trying when hunting for the open .als path.
#
# WHY THIS IS A SEARCH AND NOT A CONSTANT: Live's Python API has no documented
# property for "the file the producer currently has open," and it is not in the
# LOM reference at all. It may exist under a name nobody has published, it may
# differ between Live versions, or it may genuinely not be reachable. Rather than
# guess one name and silently capture nothing when the guess is wrong, discover
# it once at load by looking at what the objects actually expose, then reuse
# whatever answered.
#
# Ordered most-to-least likely so the first hit is also the most plausible.
SET_PATH_ATTRIBUTE_HINTS = (
    "file_path",
    "document_path",
    "project_path",
    "set_path",
    "path",
    "file_name",
    "document_name",
)

# Live's DeviceParameter.automation_state values. Resolved from the real enum at
# load where possible (_resolve_automation_playing_state); this is the fallback
# if that lookup fails, and matches the documented meanings:
#   0 = none        no automation on this parameter
#   1 = playing     automation exists and is DRIVING the value right now
#   2 = overridden  automation exists but the producer grabbed the control
AUTOMATION_STATE_PLAYING = 1


def _looks_like_set_path(value):
    """Whether a value is plausibly the path of the open Live set.

    Deliberately strict about the `.als` suffix. Several LOM properties return a
    display NAME rather than a path, and the app's `update_open_file` already
    rejects anything not ending in `.als` — so accepting a bare name here would
    just mean sending a field the backend throws away, while looking in the logs
    like discovery succeeded.
    """
    if not isinstance(value, str):
        return False
    return value.strip().lower().endswith(".als")


def _find_set_path_attribute(names, hints=SET_PATH_ATTRIBUTE_HINTS):
    """Attribute names worth reading, ordered by how likely they are to be it.

    Exact hint matches come first (a property literally called `file_path` beats
    one merely containing the word), then substring matches for the case where
    the real name is something like `get_document_file_path`. Pure so the
    ordering rule is testable without a running Live.
    """
    available = set(names)
    ordered = []

    for hint in hints:
        if hint in available:
            ordered.append(hint)

    for hint in hints:
        for name in sorted(available):
            if name.startswith("_") or name in ordered:
                continue
            if hint in name.lower():
                ordered.append(name)

    return ordered


def _heartbeat_due(now, last_sent_at, interval=None):
    """Whether enough time has passed to send another heartbeat.

    Module-level for the same reason as _snapshot_fingerprint: the decision is
    pure, and testing it does not require a Recall instance (which opens a socket
    and starts a thread on construction).

    The backwards-clock guard is not hypothetical. time.time() follows the system
    clock, so an NTP correction or a manual change can move `now` behind
    `last_sent_at`. Without the guard the elapsed time reads negative, never
    reaches the interval, and heartbeats stop FOREVER -- the app would show
    "disconnected" for a perfectly healthy bridge until Live restarted. Treat a
    backwards jump as due and resync from there.
    """
    if interval is None:
        interval = HEARTBEAT_INTERVAL_SEC

    elapsed = now - last_sent_at
    if elapsed < 0:
        return True
    return elapsed >= interval


# How long a parameter must sit still before its gesture counts as finished.
# Listeners fire ~every 3ms during a ride, so emitting each one buries the
# timeline in near-identical rows. 350ms is long enough to bridge the pauses
# inside one continuous move, short enough that a move appears while the
# producer still remembers making it.
GESTURE_SETTLE_SEC = 0.35

# The same idea for note edits, but slower. A notes listener fires on every
# single change — each drawn note, each nudge, and continuously through a record
# pass — so a four-bar take would otherwise emit a hundred rows describing one
# act. 1.2s waits out the gaps inside a phrase without making the edit feel like
# it went missing.
NOTE_SETTLE_SEC = 1.2

# Distinct from the bridge's "max_for_live" so events from the two capture tiers
# are told apart in the database. The listener defaults source to max_for_live
# when absent, so this must always be sent explicitly.
SOURCE = "control_surface"

# Pitch class names for rendering a note range the way a producer reads it
# ("C1–G2" rather than "36–67"). Live numbers middle C as C3 = MIDI 60, so the
# octave is (pitch // 12) - 2 — matching Live's own display, not the C4 = 60
# convention other DAWs use.
NOTE_NAMES = ("C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B")

# 0.3.0 adds the heartbeat. Bumped deliberately: the version chip is how you tell
# a deployed script from a stale one, and it can only do that if the number moves
# when the behaviour does. The installed copy sat at 0.2.0 for weeks while the repo
# changed underneath it, and nothing on screen could have said so.
#
# 0.4.0 sends project_path (issue #10, unblocking #11 and #6) and stops reporting
# automation playback as producer moves (issue #9).
#
# 0.5.0 sends group_track_id and color on every track. Both were already read by
# schema_projection.rs and had simply never been sent, so group nesting could not
# be rebuilt at all. Bumped for the reason 0.3.0 documents above, and for a second
# one specific to this pipeline: install.rs::needs_repair compares the INSTALLED
# version string against the SHIPPED one to decide whether to reinstall. Content
# is never compared. Leaving the number alone would mean a rebuilt app silently
# declining to deploy its own new script — the exact stale-copy failure the
# version chip exists to prevent.
# 0.5.1 stamps a note edit with the clip's OWN track instead of whatever track
# happened to be selected. detail_clip and selected_track are independent in Live,
# so editing a clip while a different track was selected filed the edit under the
# wrong track — 237 note edits from a melody clip landed on a Serum track that
# never held it.
# 0.5.2 adds settled all-channel volume, pan, and send gestures. It keeps arm
# private until a new Session clip proves that the armed channel was recorded.
SCRIPT_VERSION = "0.5.2"


class Recall(ControlSurface):
    """Minimal control surface that reports what it can see to Recall Studio."""

    def __init__(self, c_instance):
        super().__init__(c_instance)
        self._queue = None
        self._thread = None
        self._stop = None
        self._parameter_listeners = []
        self._device_listeners = []
        # Mixer listeners survive selected-track changes: selection scopes
        # plugin parameters, but mixing is project-wide.
        self._mixer_parameter_listeners = []
        self._arm_listeners = []
        self._armed_track_ids = set()
        self._observed_device = None
        self._observed_track = None
        # paramId -> last value seen, so each move can report what it moved FROM.
        # Live's listener callback carries no value and no previous value, so the
        # before-side has to be remembered here.
        self._last_values = {}
        # paramId -> in-flight gesture (start value, swept min/max, last sample
        # and when it arrived). Settled by update_display, not by the callback.
        self._gestures = {}
        self._moves_seen = 0
        # Clip-note capture. _clip_listeners and _slot_listeners are unregistered
        # on teardown; _clip_prints holds the last settled fingerprint per clip so
        # an edit can report what it changed FROM, the same way _last_values does
        # for parameters; _dirty_clips holds edits waiting to settle.
        self._clip_listeners = []
        self._slot_listeners = []
        self._clip_prints = {}
        self._dirty_clips = {}
        # Clips already carrying a notes listener, so the slot path and the
        # piano-roll path can't both register on one clip.
        self._watched_clip_ids = set()
        # slotId -> the name of the clip it last held, so a deletion can still
        # say WHICH clip went away after Live has discarded the object.
        self._slot_names = {}
        self._watched_clips = (0, 0)
        self._note_edits_seen = 0
        # _send_snapshot's dedup cache. refresh_state() fires on more than just
        # "the open set changed" (see its docstring), so without this an
        # unchanged set re-sends its whole snapshot on every one of those calls.
        self._last_snapshot_fingerprint = None
        # 0.0 rather than time.time() so the first update_display tick sends a
        # heartbeat immediately: the app cannot show "connected" (or which build
        # is running) until one arrives, and the producer is watching for exactly
        # that the moment they select Recall in Live's preferences.
        self._last_heartbeat_at = 0.0
        # Both discovered once, at load, rather than probed per event — see
        # _discover_set_path_reader and _resolve_automation_playing_state. Set
        # before the socket opens so bridge_started can report what was found.
        #
        # Guarded as a pair because neither is worth failing the load over: a
        # control surface that refuses to start captures nothing at all, which
        # is strictly worse than one that captures without these two features.
        # This is the same lesson `arrangement_clips` taught (see _safe_list).
        self._set_path_reader = None
        self._automation_playing_state = None
        try:
            self._set_path_reader = self._discover_set_path_reader()
            self._automation_playing_state = self._resolve_automation_playing_state()
        except Exception as error:  # noqa: BLE001
            logger.info("Recall Studio: capability discovery failed: {}".format(error))

        with self.component_guard():
            self._open_socket()
            self._emit(
                "bridge_started",
                {
                    "script_version": SCRIPT_VERSION,
                    "python_ok": True,
                    # Reported so the answer reaches the app's database instead
                    # of living only in Live's Log.txt — this is the evidence
                    # for whether #10 is fixable on this build.
                    "project_path": self._open_set_path(),
                    "set_path_available": self._set_path_reader is not None,
                    "automation_state_available": self._automation_playing_state is not None,
                    # Proves the LOM is reachable from here, not just that the
                    # script loaded — a script that loads but cannot read the
                    # song is a different (worse) failure.
                    "track_count": len(self.song.tracks),
                    "return_count": len(self.song.return_tracks),
                    "has_master": self.song.master_track is not None,
                },
            )
            self._listen_to_selection()
            self._attach_mixer_listeners()
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

        # Opening a different clip in the piano roll is how note editing starts,
        # in both views. Guarded because a failure here must not stop the surface
        # loading — the lesson from arrangement_clips.
        try:
            self.song.view.add_detail_clip_listener(self._on_detail_clip_changed)
        except Exception as error:  # noqa: BLE001
            logger.info("Recall Studio: no detail clip listener: {}".format(error))

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
            "is_active": bool(device.is_active),
            # Live's device type enum (1 instrument, 2 audio effect, 4 midi
            # effect). The projection derives a device's chain ROLE from this,
            # and without it every device — including instruments — was being
            # classified as an audio effect.
            "type": getattr(device, "type", None),
            "parameters": parameters,
        }

    def _serialize_clip_slot(self, slot, index):
        if not slot.has_clip:
            return {"index": index, "has_clip": False}

        clip = slot.clip
        return {
            "index": index,
            "has_clip": True,
            "id": self._safe_id(clip),
            "name": self._safe_name(clip),
            # derive_track_type in schema_projection.rs reads this flag to type a
            # track that has no instrument in its chain yet.
            "is_midi_clip": bool(getattr(clip, "is_midi_clip", False)),
            "length_beats": round(getattr(clip, "length", 0.0) or 0.0, 4),
        }

    def _serialize_track(self, track, index):
        # Send the RAW Live flags the projection actually reads (is_foldable,
        # has_midi_input) rather than a pre-computed type string.
        #
        # A pre-computed "track_type" was sent before and silently ignored:
        # derive_track_type in schema_projection.rs consumes these two flags and
        # has no branch for a type string. The result was every MIDI track
        # holding an instrument being labelled Audio. Return and master tracks
        # genuinely lack these attributes, so they are omitted rather than
        # guessed — the projection types those from their position anyway.
        payload = {
            "id": str(track._live_ptr),
            "name": track.name,
            "index": index,
            "devices": [self._serialize_device(d) for d in track.devices],
        }

        # Clip slots, structurally only — name, type, length. No note reads here:
        # the snapshot walks every track in the set, and fingerprinting every
        # clip in a full project would put a note scan for the whole song on
        # Live's thread at load. Note CONTENT is reported by clip_notes_changed
        # for the track in focus, and read from the .als for the take.
        slots = self._safe_list(track, "clip_slots")
        if slots:
            payload["clip_slots"] = [
                self._serialize_clip_slot(slot, i)
                for i, slot in enumerate(slots[:MAX_CLIPS_PER_TRACK])
            ]

        if hasattr(track, "is_foldable"):
            payload["is_foldable"] = bool(track.is_foldable)
        if hasattr(track, "has_midi_input"):
            payload["has_midi_input"] = bool(track.has_midi_input)

        # Which group this track sits INSIDE. is_foldable above says "this track
        # IS a group"; without this the app could see that a group exists but
        # never which tracks belong to it, so group nesting could not be rebuilt.
        # The projection already reads it (schema_projection.rs reads
        # "group_track_id", falling back to "group_track") and stores it as
        # group_ableton_id — this line is the only reason that field was ever
        # empty.
        #
        # try/except, not hasattr: the attribute EXISTS on every Track, but
        # reading it on a return or main track can raise rather than return None
        # — the same trap _safe_list documents. _safe_id guards the _live_ptr
        # read too, and must be the same id space as "id" above for the
        # projection to match parent to child.
        try:
            group_track = track.group_track
        except Exception:  # noqa: BLE001 - the property refused, same as _safe_list
            group_track = None
        if group_track is not None:
            group_id = self._safe_id(group_track)
            if group_id:
                payload["group_track_id"] = group_id

        # Live's per-track colour. Producer-authored organisation (colouring by
        # section or instrument), not styling — read_color in the projection
        # already accepts the raw int Live hands back and was receiving nothing.
        try:
            color = track.color
        except Exception:  # noqa: BLE001
            color = None
        if color is not None:
            payload["color"] = int(color)

        return payload

    def _send_snapshot(self):
        """Emit the whole-set snapshot the app projects its schema from.

        Unlike the M4L bridge this is NOT a periodic scan — it is sent once on
        load and then only when the track list actually changes. Reading the LOM
        from here is cheap (no LiveAPI object construction per property), which
        is what made the equivalent walk dangerous in Max.

        Deduped against the last snapshot sent, the same way the M4L bridge
        deduped with lastLiveSetFingerprint: refresh_state() is called by Live
        for more than the "set changed" case its docstring names, so without
        this an unchanged set re-sends its full snapshot -- tracks, devices,
        parameters, all of it -- on every one of those extra calls.
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

        fingerprint = _snapshot_fingerprint(payload)
        if fingerprint == self._last_snapshot_fingerprint:
            return
        self._last_snapshot_fingerprint = fingerprint

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
        # The set of mixer channels (and sends) changed. Rebuild only this small
        # listener family; plugin listeners remain scoped to the focused track.
        self._clear_mixer_listeners()
        self._attach_mixer_listeners()
        # Re-snapshot so a track added mid-session reaches the app. This is the
        # bug that crashed Live last night when the M4L bridge tried it: there,
        # every structural change meant a full LiveAPI traversal. Here it is a
        # plain read of objects Live already holds, triggered by a callback
        # rather than by polling.
        self._send_snapshot()

    # ── mixer decisions ────────────────────────────────────────────────────

    def _mixer_tracks(self):
        """Every track that owns a mixer channel, once and in Live's order."""
        tracks = []
        seen = set()
        candidates = list(self.song.tracks) + list(self.song.return_tracks)
        if self.song.master_track is not None:
            candidates.append(self.song.master_track)

        for track in candidates:
            key = self._safe_id(track)
            # A pointer is the normal identity. The object id fallback keeps a
            # weird/partially-created track from being registered twice.
            key = key or "object-{}".format(id(track))
            if key in seen:
                continue
            seen.add(key)
            tracks.append(track)
        return tracks

    def _attach_mixer_listeners(self):
        """Observe settled volume, pan, and send gestures on every channel.

        This is intentionally NOT a device walk. The mixer has a fixed tiny
        surface per track, so an all-channel mix listener is both what a
        producer expects and substantially safer than observing every device.
        Mute/solo are deliberately absent: they are listening/navigation state,
        not a durable creative decision in the song's record.
        """
        return_names = [
            self._safe_name(track) or "Return {}".format(index + 1)
            for index, track in enumerate(self.song.return_tracks)
        ]

        for track in self._mixer_tracks():
            try:
                mixer = track.mixer_device
            except Exception as error:  # noqa: BLE001 - track disappeared mid-scan
                logger.info("Recall Studio: mixer unavailable on {}: {}".format(
                    self._safe_name(track), error
                ))
                continue

            self._watch_mixer_parameter(track, mixer, "volume", "volume_changed", "Volume")
            self._watch_mixer_parameter(track, mixer, "panning", "pan_changed", "Pan")

            for index, parameter in enumerate(
                self._safe_list(mixer, "sends")[:MAX_MIXER_SENDS_PER_TRACK]
            ):
                destination = (
                    return_names[index]
                    if index < len(return_names)
                    else "Return {}".format(index + 1)
                )
                self._watch_value_parameter(
                    track,
                    parameter,
                    "send_changed",
                    "Mixer",
                    "Send → {}".format(destination),
                )

            self._watch_track_arm(track)

    def _watch_mixer_parameter(self, track, mixer, attribute, event_type, label):
        try:
            parameter = getattr(mixer, attribute)
        except Exception:  # noqa: BLE001 - e.g. a special track without pan
            return
        self._watch_value_parameter(track, parameter, event_type, "Mixer", label)

    def _watch_value_parameter(self, track, parameter, event_type, device_name, parameter_name):
        if parameter is None:
            return
        try:
            self._last_values[id(parameter)] = parameter.value
            listener = self._make_value_listener(
                track, parameter, event_type, device_name, parameter_name
            )
            parameter.add_value_listener(listener)
            self._mixer_parameter_listeners.append((parameter, listener))
        except Exception as error:  # noqa: BLE001 - individual control only
            logger.info(
                "Recall Studio: could not watch {} on {}: {}".format(
                    parameter_name, self._safe_name(track), error
                )
            )

    def _track_listener_key(self, track):
        return self._safe_id(track) or "object-{}".format(id(track))

    def _watch_track_arm(self, track):
        """Keep arm as private context; it earns a visible note only on record."""
        key = self._track_listener_key(track)
        try:
            if bool(track.arm):
                self._armed_track_ids.add(key)
            listener = self._make_arm_listener(track)
            track.add_arm_listener(listener)
            self._arm_listeners.append((track, listener))
        except Exception:
            # Returns and Main cannot be armed. That is expected, and it should
            # not make their volume/pan listeners any less useful.
            self._armed_track_ids.discard(key)

    def _make_arm_listener(self, track):
        def _on_arm():
            key = self._track_listener_key(track)
            try:
                armed = bool(track.arm)
            except Exception:  # noqa: BLE001 - track was deleted
                self._armed_track_ids.discard(key)
                return
            if armed:
                self._armed_track_ids.add(key)
            else:
                self._armed_track_ids.discard(key)

        return _on_arm

    def _is_armed_session_recording(self, track):
        """True only for a new Session clip created while its track is armed.

        An arm button by itself says intent, not that audio/MIDI was captured.
        `session_record` is the additional proof Live offers for the slot path;
        this deliberately does not guess about dragged-in clips or Arrangement
        recording that this listener cannot verify.
        """
        if self._track_listener_key(track) not in self._armed_track_ids:
            return False
        try:
            return bool(self.song.session_record)
        except Exception:  # noqa: BLE001 - older Live build lacks the property
            return False

    def _clear_mixer_listeners(self):
        # Finish a fader gesture before removing its listener. The producer's
        # last move must not disappear just because a track was created or Live
        # refreshed the set state.
        self._flush_settled_gestures(force=True)

        for parameter, listener in self._mixer_parameter_listeners:
            try:
                if parameter.value_has_listener(listener):
                    parameter.remove_value_listener(listener)
            except Exception:  # noqa: BLE001 - channel may already be gone
                pass
            self._last_values.pop(id(parameter), None)

        for track, listener in self._arm_listeners:
            try:
                if track.arm_has_listener(listener):
                    track.remove_arm_listener(listener)
            except Exception:  # noqa: BLE001 - returns/Main have no arm API
                pass

        self._mixer_parameter_listeners = []
        self._arm_listeners = []
        self._armed_track_ids = set()

    def _on_selection_changed(self):
        """Selection changed: re-point the devices listener, then re-attach params."""
        self._clear_parameter_listeners()
        self._clear_devices_listener()
        self._clear_clip_listeners()

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

        # Clips first, so focus_changed can report what note capture attached to
        # in the same event that reports the device chain. A separate event would
        # mean two rows describing one selection.
        #
        # CONTAINED on purpose. This method runs from __init__, so anything that
        # escapes it stops the control surface from loading AT ALL — no snapshot,
        # no session, no parameter capture, and no clue in the app as to why.
        # That is precisely what a raising `arrangement_clips` did. Note capture
        # is the newest and least-proven thing here; it must be able to fail
        # without taking the proven parts down with it.
        try:
            self._watched_clips = self._attach_to_clips(track)
            # Re-attach the open clip too: _clear_clip_listeners just dropped it,
            # and the detail-clip listener won't fire again because the clip
            # itself didn't change — only the selection did.
            self._on_detail_clip_changed()
        except Exception as error:  # noqa: BLE001
            self._watched_clips = (0, 0)
            logger.info("Recall Studio: clip capture failed to attach: {}".format(error))
        self._attach_to_focused_device(track)

    def _on_devices_changed(self):
        # A device was added, removed, or reordered on the track we are watching.
        self._clear_parameter_listeners()
        self._attach_to_focused_device(self.song.view.selected_track)
        # Live may replace its provisional "14-MIDI" label with the instrument
        # name when a device is dropped. Refresh the structural snapshot here so
        # the timeline keeps the track's current Ableton label and device chain.
        self._send_snapshot()

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

    # ── clip notes ─────────────────────────────────────────────────────────
    #
    # The parallel to the parameter listeners above, for the other half of what a
    # producer actually does: writing and editing parts. Same three rules, for
    # the same reasons —
    #
    #   SCOPE:   the selected track only, never the whole set.
    #   SETTLE:  the callback records that something changed; update_display
    #            decides when the change is finished and worth reporting.
    #   DIFF:    Live's notes listener carries no payload at all, so the
    #            before-side has to be remembered here (_clip_prints), exactly as
    #            _last_values remembers parameter values.
    #
    # The one thing that is genuinely different: reading notes is expensive, so
    # the callback deliberately does NOT read them. During a record pass it fires
    # continuously, and reading the roll on every fire would put a full note scan
    # on Live's thread dozens of times per second.

    def _attach_to_clips(self, track):
        """Watch the selected track's clips for note edits.

        Returns (clips watched, MIDI clips watched) so focus_changed can report
        them. Slot listeners are registered on EVERY slot, not just filled ones:
        an empty slot is where the next clip gets recorded, and that arrival is
        the event most worth having.
        """
        if track is None:
            return (0, 0)

        slots = self._safe_list(track, "clip_slots")
        watched = 0

        for index, slot in enumerate(slots[:MAX_CLIPS_PER_TRACK]):
            listener = self._make_slot_listener(track, slot, index)
            try:
                slot.add_has_clip_listener(listener)
            except Exception:  # noqa: BLE001
                continue
            self._slot_listeners.append((slot, listener))

            if slot.has_clip:
                watched += self._watch_clip(track, slot.clip, index)

        # Arrangement clips are not reachable through clip_slots — a producer
        # working in Arrangement view has no clip slots in play at all, and
        # without this branch their entire session would capture no note edits.
        # _safe_list because group/return/main tracks RAISE on this property.
        for clip in self._safe_list(track, "arrangement_clips")[:MAX_CLIPS_PER_TRACK]:
            watched += self._watch_clip(track, clip, None)

        # Logged as well as emitted: focus_changed reaches the app only if the
        # socket is up, and this is exactly the diagnostic you want when it
        # isn't. "3 slots, 0 watched" says the listeners are the problem;
        # "0 slots" says the track selection is.
        logger.info(
            "Recall Studio: {} clip slots, {} MIDI clips watched on {}".format(
                len(slots), watched, self._safe_name(track)
            )
        )

        return (len(slots), watched)

    def _watch_clip(self, track, clip, slot_index):
        """Register a notes listener on one MIDI clip. Returns 1 if attached."""
        if clip is None or not getattr(clip, "is_midi_clip", False):
            return 0

        # The same clip can arrive from both paths — its slot and the piano roll.
        # Registering twice would report every edit twice.
        if id(clip) in self._watched_clip_ids:
            return 0
        self._watched_clip_ids.add(id(clip))

        listener = self._make_notes_listener(track, clip, slot_index)
        try:
            clip.add_notes_listener(listener)
        except Exception as error:  # noqa: BLE001 - clip gone, or API not present
            # LOUD on purpose. A silently swallowed registration failure is
            # indistinguishable from "the producer edited nothing", and that
            # ambiguity costs a full Live restart to diagnose. If
            # add_notes_listener is missing on this build, this line is the only
            # thing that will say so.
            logger.info(
                "Recall Studio: could not watch clip notes ({}): {}".format(
                    self._safe_name(clip), error
                )
            )
            return 0

        self._clip_listeners.append((clip, listener))
        # Seed the before-side now, so the first edit reports a real starting
        # state instead of "changed from nothing" — the same seeding _last_values
        # does for parameters.
        self._clip_prints[id(clip)] = self._fingerprint(clip)
        return 1

    def _make_slot_listener(self, track, slot, index):
        # A clip appearing in or vanishing from a slot: recorded, drawn,
        # duplicated, dragged in, or deleted. Previously all of this was silent.
        def _on_has_clip():
            try:
                has_clip = bool(slot.has_clip)
            except Exception:  # noqa: BLE001 - slot's track was deleted
                return

            if not has_clip:
                self._emit(
                    "clip_deleted",
                    {
                        "track_name": self._safe_name(track),
                        "track_id": self._safe_id(track),
                        "clip_slot_index": index,
                        "clip_name": self._slot_names.pop(id(slot), None),
                    },
                )
                return

            clip = slot.clip
            is_midi = bool(getattr(clip, "is_midi_clip", False))
            self._watch_clip(track, clip, index)

            name = self._safe_name(clip)
            # Remembered so the deletion event above can still name the clip
            # after Live has thrown the object away.
            self._slot_names[id(slot)] = name

            print_ = self._clip_prints.get(id(clip))
            # Arm is context, not an event on its own. A new slot clip while
            # Session Record is on is the concrete evidence that the producer
            # actually recorded into this armed channel.
            recorded = self._is_armed_session_recording(track)
            event_type = (
                "midi_clip_recorded" if is_midi else "audio_clip_recorded"
            ) if recorded else ("midi_clip_created" if is_midi else "audio_clip_added")
            self._emit(
                event_type,
                {
                    "track_name": self._safe_name(track),
                    "track_id": self._safe_id(track),
                    "clip_slot_index": index,
                    "clip_name": name,
                    "clip_id": self._safe_id(clip),
                    "length_beats": round(getattr(clip, "length", 0.0) or 0.0, 4),
                    "note_count": (print_ or {}).get("count"),
                },
            )

        return _on_has_clip

    def _make_notes_listener(self, track, clip, slot_index):
        def _on_notes():
            self._note_edits_seen += 1

            key = id(clip)
            edit = self._dirty_clips.get(key)

            if edit is None:
                edit = {
                    "track": track,
                    "clip": clip,
                    "slot_index": slot_index,
                    # The last SETTLED state, not the current one: mid-pass
                    # samples would make a whole recorded phrase read as a
                    # one-note change.
                    "before": self._clip_prints.get(key),
                }
                self._dirty_clips[key] = edit

            edit["at"] = time.time()

        return _on_notes

    def _on_detail_clip_changed(self):
        """Watch whatever clip is open in the piano roll.

        THE path for an Arrangement-view producer, and the reason the first
        working build captured nothing: clip_slots only covers Session view, and
        a producer working in Arrangement has eight EMPTY slots per track. The
        detail clip is the clip they are literally looking at and editing, in
        either view, which makes it a better signal than either clip list.
        """
        clip = None
        try:
            clip = self.song.view.detail_clip
        except Exception as error:  # noqa: BLE001
            logger.info("Recall Studio: no detail clip readable: {}".format(error))
            return

        if clip is None:
            return

        # The clip's OWN track, not the selected one. `detail_clip` and
        # `selected_track` are independent in Live: the piano roll can show a clip
        # from one track while the mixer selection sits on another. Binding the
        # selection here stamped every note edit with whatever track happened to be
        # selected, which is how a melody clip's 237 note edits piled onto a Serum
        # track that never held it. Falls back to the selection when the parent
        # cannot be resolved, so this is never worse than the behaviour it replaces.
        owner = self._clip_track(clip) or self.song.view.selected_track
        watched = self._watch_clip(owner, clip, None)
        logger.info(
            "Recall Studio: detail clip '{}' midi={} watched={}".format(
                self._safe_name(clip), getattr(clip, "is_midi_clip", None), watched
            )
        )

    def _clip_track(self, clip):
        """The track a clip actually belongs to, or None if it can't be resolved.

        Live nests a clip differently depending on the view it lives in:
          - Session:     Clip -> ClipSlot -> Track
          - Arrangement: Clip -> Track
        So walking `canonical_parent` a couple of levels covers both without
        needing to know which view the producer is working in.

        Identity is checked by `_live_ptr` against the real track list rather than
        by duck-typing the parent. A ClipSlot and a Track both answer plenty of
        attributes, and guessing wrong here re-introduces exactly the
        misattribution this exists to stop. Matching the pointer against
        `song.tracks` can only ever return a genuine track.

        Everything is wrapped: this runs on Live's thread during a notes callback,
        and an exception escaping here would take note capture down with it.
        """
        try:
            track_ids = {}
            for track in self.song.tracks:
                track_id = self._safe_id(track)
                if track_id:
                    track_ids[track_id] = track

            node = getattr(clip, "canonical_parent", None)
            # Two hops covers Session (slot -> track); one covers Arrangement. The
            # third is slack, not expectation — the loop stops at the first match.
            for _ in range(3):
                if node is None:
                    return None
                match = track_ids.get(self._safe_id(node))
                if match is not None:
                    return match
                node = getattr(node, "canonical_parent", None)
        except Exception as error:  # noqa: BLE001 - LOM parent chain refused
            logger.info("Recall Studio: could not resolve clip's track: {}".format(error))

        return None

    def _safe_list(self, obj, name):
        """Read a list-valued LOM property that may REFUSE to be read.

        getattr(obj, name, None) is not enough and this cost a Live restart to
        learn: `arrangement_clips` exists on every Track, but reading it on a
        group, return or main track raises RuntimeError rather than returning
        empty. A default only covers a MISSING attribute, not a raising one — so
        the exception escaped __init__ and the whole control surface failed to
        load. Anything that can't be read is treated as empty.
        """
        try:
            value = getattr(obj, name, None)
            return list(value) if value else []
        except Exception as error:  # noqa: BLE001 - the property refused
            # Logged, not silent. A swallowed read here reads downstream as
            # "this track has no clips", which is indistinguishable from the
            # truth and sent me hunting the wrong thing once already.
            logger.info(
                "Recall Studio: {} unreadable on {}: {}".format(
                    name, self._safe_name(obj), error
                )
            )
            return []

    # ── the open .als (issue #10) ──────────────────────────────────────────
    #
    # The app tracks which set is open by reading `project_path` off incoming
    # events (udp_listener.rs::update_open_file). This script never sent it, so
    # `open_als_path` stayed None forever, so `rotate_session_if_project_changed`
    # returned on its first line and takes never split by project — every song
    # recorded into whichever take happened to be active (#11, #6).
    #
    # The obstacle is that Live exposes no documented property for the open set's
    # path. So: look for one at load, and if something answers, use it. If
    # nothing does, say so plainly in the log and carry on capturing exactly as
    # before — a failed search must cost nothing but a log line.

    def _discover_set_path_reader(self):
        """Find where the open .als path lives. Returns (label, attribute) or None.

        Tries the Song first (most likely to carry document state), then the
        Application and its document. Reads each candidate attribute and keeps
        the first that yields a real `.als` path — proving the property both
        exists AND holds what we need, rather than trusting a promising name.

        Callables are invoked too: if the answer turns out to be a getter like
        `get_file_path()`, a name-only search would have found it and then
        stored a bound method as if it were a path.

        Returns a NAME, never a bound object. Opening a different set can hand
        back a fresh Song, and a reader holding the old one would keep reporting
        the previous project's path — which is the exact bug this is meant to
        fix, only harder to spot.
        """
        for label in ("song", "application", "document"):
            source = self._resolve_set_path_source(label)
            if source is None:
                continue
            try:
                names = dir(source)
            except Exception:  # noqa: BLE001
                continue

            for attribute in _find_set_path_attribute(names):
                value = self._read_set_path_candidate(source, attribute)
                if _looks_like_set_path(value):
                    logger.info(
                        "Recall Studio: open set path found at {}.{}".format(label, attribute)
                    )
                    return (label, attribute)

        # Not a crash and not a bug on this side — Live may simply not expose it.
        # Logged loudly because it is the difference between takes splitting by
        # project and not, and the app has no other way to find out.
        logger.info(
            "Recall Studio: no open-set path property found; takes cannot split by project"
        )
        return None

    def _resolve_set_path_source(self, label):
        """The object named by `label`, resolved FRESH on every call.

        Deliberately re-resolved rather than cached: this is what makes the path
        follow the producer when they open a different set.
        """
        try:
            if label == "song":
                return self.song

            import Live

            application = Live.Application.get_application()
            if label == "application":
                return application
            if label == "document":
                return application.get_document()
        except Exception:  # noqa: BLE001 - Live tearing down, or no such source
            return None

        return None

    @staticmethod
    def _read_set_path_candidate(source, attribute):
        """Read one candidate, calling it if it is a zero-argument getter.

        Never raises: reflecting over a live audio application reaches
        properties that throw, and one bad candidate must not abort the search
        before it reaches a good one.
        """
        try:
            value = getattr(source, attribute, None)
        except Exception:  # noqa: BLE001
            return None

        if callable(value):
            try:
                value = value()
            except Exception:  # noqa: BLE001
                return None

        return value

    def _open_set_path(self):
        """The open .als path, or None. Cheap enough for the 2s heartbeat.

        Re-reads through the discovered name every call rather than caching a
        value: the whole point is to notice when the producer opens a different
        set, which a cached path could never do.
        """
        if self._set_path_reader is None:
            return None

        label, attribute = self._set_path_reader
        source = self._resolve_set_path_source(label)
        if source is None:
            return None

        value = self._read_set_path_candidate(source, attribute)
        return value if _looks_like_set_path(value) else None

    # ── automation vs a producer's hand (issue #9) ─────────────────────────

    def _is_automation_playback(self, parameter):
        """True when this change is automation driving the value, not a person.

        A value listener fires identically for both, so without this an
        automated section re-records itself on every pass — the timeline showed
        a filter ridden forty times when it was drawn once.

        Two conditions, both required. The transport must be rolling, because
        automation only drives a parameter during playback. And the parameter's
        automation_state must be PLAYING: the moment the producer grabs a control
        that has automation on it, Live moves that state to `overridden`, which
        is a real decision and must still be captured.
        """
        if self._automation_playing_state is None:
            return False

        try:
            if not self.song.is_playing:
                return False
            state = getattr(parameter, "automation_state", None)
        except Exception:  # noqa: BLE001
            return False

        return state == self._automation_playing_state

    @staticmethod
    def _resolve_automation_playing_state():
        """The enum value meaning "automation is driving this", or None.

        Read from Live's own enum rather than hardcoding 1, so a build that
        numbers them differently doesn't cause every automated move to be
        discarded — or worse, every manual one. None disables the filter
        entirely: if this build has no automation_state at all, capturing a few
        phantom moves is a far better failure than silently dropping the
        producer's real ones.
        """
        try:
            import Live

            state = Live.DeviceParameter.AutomationState.playing
            return int(state) if not isinstance(state, int) else state
        except Exception:  # noqa: BLE001
            pass

        try:
            import Live

            if hasattr(Live.DeviceParameter, "AutomationState"):
                return AUTOMATION_STATE_PLAYING
        except Exception:  # noqa: BLE001
            pass

        logger.info(
            "Recall Studio: automation_state unavailable; automation playback "
            "will still be captured as producer moves"
        )
        return None

    @staticmethod
    def _safe_name(obj):
        """An object's name, or None when Live has no real name for it.

        Two ways Live says "no name", both of which reach the app as a name if
        passed through raw:
          - an empty string (an unnamed arrangement clip),
          - the number 0, which Live returns for absent TEXT properties and
            which stringifies to a truthy "0".
        A blank clip name is what made a captured note edit render as "· notes"
        with nothing in front of it.
        """
        try:
            name = obj.name
        except Exception:  # noqa: BLE001
            return None

        if name is None or name == 0:
            return None

        name = str(name).strip()
        return name or None

    @staticmethod
    def _safe_id(obj):
        try:
            return str(obj._live_ptr)
        except Exception:  # noqa: BLE001
            return None

    @staticmethod
    def _pitch_name(pitch):
        if pitch is None:
            return None
        return "{}{}".format(NOTE_NAMES[int(pitch) % 12], (int(pitch) // 12) - 2)

    @staticmethod
    def _read_notes(clip):
        """Every note in a clip as plain tuples, or None if unreadable.

        Two API generations: get_notes_extended is the Live 11+ call and the only
        one that returns note ids; get_notes is the legacy tuple form, kept as a
        fallback because failing closed here would mean silently capturing no
        note edits at all on an older build.

        The read starts at beat 0 and spans the clip's length, so notes sitting
        before the start marker (an anacrusis dragged left) are outside it. That
        is a known, bounded blind spot — preferable to an unbounded scan.
        """
        try:
            span = float(getattr(clip, "length", 0.0) or 0.0)
        except Exception:  # noqa: BLE001
            return None

        if span <= 0.0:
            return []

        try:
            # (from_pitch, pitch_span, from_time, time_span)
            notes = clip.get_notes_extended(0, 128, 0.0, span)
            return [
                (n.pitch, n.start_time, n.duration, n.velocity, bool(n.mute))
                for n in notes
            ][:MAX_NOTES_READ]
        except Exception:  # noqa: BLE001
            pass

        try:
            # (from_time, from_pitch, time_span, pitch_span) — different order.
            return [tuple(n) for n in clip.get_notes(0.0, 0, span, 128)][:MAX_NOTES_READ]
        except Exception:  # noqa: BLE001
            return None

    def _fingerprint(self, clip):
        """A small summary of a clip's notes — never the notes themselves.

        Recall records decisions, not data. The authoritative note content is in
        the .als for the take; what the timeline needs is what CHANGED, which is
        this. Shipping the roll through the event stream would bury a session in
        rows nobody reads and bloat every session's storage for no added recall.
        """
        notes = self._read_notes(clip)
        if notes is None:
            return None

        if not notes:
            return {
                "count": 0,
                "pitch_min": None,
                "pitch_max": None,
                "distinct_pitches": 0,
                "velocity_mean": None,
                "span_beats": 0.0,
                "digest": 0,
            }

        pitches = [n[0] for n in notes]
        velocities = [n[3] for n in notes]
        starts = [n[1] for n in notes]
        ends = [n[1] + n[2] for n in notes]

        return {
            "count": len(notes),
            "pitch_min": min(pitches),
            "pitch_max": max(pitches),
            "distinct_pitches": len(set(pitches)),
            "velocity_mean": round(sum(velocities) / len(velocities), 1),
            "span_beats": round(max(ends) - min(starts), 4),
            # Sorted because Live gives no ordering guarantee, so an unsorted
            # digest would report a change every time the same notes came back
            # in a different order. Compared only within this process, which is
            # all Python's hash guarantees for.
            "digest": hash(tuple(sorted(notes))),
        }

    def _flush_settled_note_edits(self, force=False):
        if not self._dirty_clips:
            return

        now = time.time()

        for key in list(self._dirty_clips.keys()):
            edit = self._dirty_clips[key]

            if not force and (now - edit["at"]) < NOTE_SETTLE_SEC:
                continue

            del self._dirty_clips[key]
            self._emit_note_edit(key, edit)

    def _emit_note_edit(self, key, edit):
        clip = edit["clip"]
        before = edit["before"]
        after = self._fingerprint(clip)

        if after is None:
            # Clip deleted mid-edit; the slot listener reports that instead.
            self._clip_prints.pop(key, None)
            return

        self._clip_prints[key] = after

        # Nothing actually changed. Selecting notes, or drawing one and undoing
        # it, both fire the listener and both leave the part exactly as it was —
        # the note-edit equivalent of a knob ridden back to where it started.
        if before is not None and before.get("digest") == after.get("digest"):
            return

        before_count = (before or {}).get("count")
        after_count = after["count"]

        if before_count is None:
            kind = "edited"
        elif after_count == 0 and before_count > 0:
            kind = "cleared"
        elif after_count > before_count:
            kind = "notes_added"
        elif after_count < before_count:
            kind = "notes_removed"
        else:
            kind = "notes_edited"

        self._emit(
            "clip_notes_changed",
            {
                "track_name": self._safe_name(edit["track"]),
                "track_id": self._safe_id(edit["track"]),
                "clip_name": self._safe_name(clip),
                "clip_id": self._safe_id(clip),
                "clip_slot_index": edit["slot_index"],
                "change_kind": kind,
                "note_count": after_count,
                "previous_note_count": before_count,
                "distinct_pitches": after["distinct_pitches"],
                "pitch_min": after["pitch_min"],
                "pitch_max": after["pitch_max"],
                # The raw before-range too, not only its label: the timeline
                # draws where the part USED to sit behind where it sits now, and
                # a string like "C1-G2" cannot be measured or positioned.
                "previous_pitch_min": (before or {}).get("pitch_min"),
                "previous_pitch_max": (before or {}).get("pitch_max"),
                "pitch_range": self._pitch_range(after),
                "previous_pitch_range": self._pitch_range(before),
                "velocity_mean": after["velocity_mean"],
                "span_beats": after["span_beats"],
                "length_beats": round(getattr(clip, "length", 0.0) or 0.0, 4),
                # Pre-rendered because the app should not have to know Live's
                # C3 = 60 octave convention to describe what happened.
                "summary": self._note_summary(kind, before_count, after, before),
            },
        )

    @classmethod
    def _pitch_range(cls, print_):
        if not print_ or print_.get("pitch_min") is None:
            return None
        low = cls._pitch_name(print_["pitch_min"])
        high = cls._pitch_name(print_["pitch_max"])
        return low if low == high else "{}-{}".format(low, high)

    @staticmethod
    def _notes_label(count):
        # "1 notes" reads like a bug in a surface whose whole job is to be
        # trusted about what happened.
        return "1 note" if count == 1 else "{} notes".format(count)

    @classmethod
    def _note_summary(cls, kind, before_count, after, before):
        if kind == "cleared":
            return "Cleared {}".format(cls._notes_label(before_count))

        parts = [cls._notes_label(after["count"])]

        if before_count is not None and after["count"] != before_count:
            parts[0] += " ({:+d})".format(after["count"] - before_count)

        span = cls._pitch_range(after)
        if span:
            previous_span = cls._pitch_range(before)
            if previous_span and previous_span != span:
                parts.append("{} -> {}".format(previous_span, span))
            else:
                parts.append(span)

        return ", ".join(parts)

    def _clear_clip_listeners(self):
        # Settle in-flight edits BEFORE dropping listeners, for the same reason
        # the parameter path does: the part you were writing right before
        # clicking to another track is exactly the one worth remembering.
        self._flush_settled_note_edits(force=True)

        for clip, listener in self._clip_listeners:
            try:
                if clip.notes_has_listener(listener):
                    clip.remove_notes_listener(listener)
            except Exception:  # noqa: BLE001 - clip already deleted
                pass

        for slot, listener in self._slot_listeners:
            try:
                if slot.has_clip_has_listener(listener):
                    slot.remove_has_clip_listener(listener)
            except Exception:  # noqa: BLE001
                pass

        self._clip_listeners = []
        self._slot_listeners = []
        self._watched_clip_ids = set()
        # Dropped with the listeners so a stale fingerprint cannot attach to a
        # different clip that reuses the same object id.
        self._clip_prints = {}
        self._slot_names = {}

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
                    "clip_slot_count": self._watched_clips[0],
                    "midi_clips_watched": self._watched_clips[1],
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
                "clip_slot_count": self._watched_clips[0],
                "midi_clips_watched": self._watched_clips[1],
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
    def _display(parameter, value):
        """The value as Ableton shows it — "500 Hz", "-6.0 dB", "Sinefold".

        Without this the app can only show a percentage, so a filter cutoff reads
        "37.7% -> 50.1%" instead of "500 Hz -> 2 kHz". str_for_value is the LOM
        method that formats a raw value the way the device's UI does, units and
        all. Guarded because a few parameters raise or lack it.
        """
        try:
            return parameter.str_for_value(value)
        except Exception:  # noqa: BLE001
            return None

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
        return self._make_value_listener(
            track,
            parameter,
            "parameter_changed",
            self._safe_name(device),
            self._safe_name(parameter),
        )

    def _make_value_listener(
        self, track, parameter, event_type, device_name, parameter_name
    ):
        # Closure per parameter: Live's listener callbacks take no arguments, so
        # identity has to be captured here rather than looked up on fire. Mixer
        # and device controls share the same settle path, but carry different
        # event names so the app can preserve the producer's intent.
        def _on_value():
            # Automation driving the value is not a decision the producer made
            # now — it is one they made earlier, already captured when they drew
            # it. Checked before _moves_seen so the counter reported in
            # bridge_stopped stays a count of real moves.
            if self._is_automation_playback(parameter):
                # Still track where automation left the value. Skipping this
                # would leave _last_values holding a pre-playback reading, so
                # the next time the producer grabs the control the move would
                # report a "before" from before the automation ran — e.g.
                # "0.2 -> 0.5" for a knob automation had already carried to 0.8.
                try:
                    self._last_values[id(parameter)] = parameter.value
                except Exception:  # noqa: BLE001 - device gone mid-playback
                    pass
                return

            self._moves_seen += 1

            key = id(parameter)
            current = parameter.value
            now = time.time()

            gesture = self._gestures.get(key)

            if gesture is None:
                # New gesture. Its "from" value is the last settled value we
                # know, not the current one — otherwise the opening sample of a
                # sweep becomes the start and the move reads as smaller than it
                # was.
                gesture = {
                    "track": track,
                    "parameter": parameter,
                    "event_type": event_type,
                    "device_name": device_name,
                    "parameter_name": parameter_name,
                    "start": self._last_values.get(key, current),
                    "min": current,
                    "max": current,
                }
                self._gestures[key] = gesture

            gesture["last"] = current
            gesture["at"] = now
            gesture["min"] = min(gesture["min"], current)
            gesture["max"] = max(gesture["max"], current)

        return _on_value

    def update_display(self):
        """Live calls this about every 100ms — used here to settle gestures.

        A gesture cannot be closed from inside the value callback: the last
        sample of a sweep looks exactly like every other one, and the fact that
        matters (where the knob LANDED) is only knowable once nothing has moved
        for a while. Live already drives this method on the main thread, so it
        settles gestures without a timer or a second thread.
        """
        super().update_display()
        self._flush_settled_gestures()
        self._flush_settled_note_edits()
        # Guarded because this runs on Live's thread on every tick. An unhandled
        # exception in a per-tick callback is the failure class behind the 0.20.1
        # bridge rollback (commit 886856c) -- a heartbeat is health reporting and
        # must never be able to take Live down with it.
        try:
            self._send_heartbeat_if_due()
        except Exception as error:  # noqa: BLE001
            logger.info("Recall Studio: heartbeat failed: {}".format(error))

    def _send_heartbeat_if_due(self):
        """Tell the app the bridge is alive, even when nothing is happening.

        WHY THIS EXISTS AT ALL: the app derives `connected` solely from having
        seen a `heartbeat` inside the last 5 seconds. That contract came from the
        M4L bridge and this script never adopted it, so `connected` was
        permanently false and the version chip never rendered -- see
        udp_listener.rs:522 (early-returns on anything that is not a heartbeat)
        and :1433 (connected reads only last_heartbeat_ms).

        The payload rides as an object; the listener stringifies it during
        normalize (udp_listener.rs:271) before reading bridge_version back out
        of it (:533), so no special casing is needed on this side.
        """
        now = time.time()
        if not _heartbeat_due(now, self._last_heartbeat_at):
            return

        self._last_heartbeat_at = now
        # project_path rides the heartbeat because the app reads it in
        # update_open_file, which runs BEFORE heartbeats are dropped from the
        # pipeline — and because a heartbeat fires every 2s regardless of what
        # the producer is doing. That makes opening a different set get noticed
        # within seconds, rather than whenever the next real event happens to
        # arrive (which, on a set the producer is only listening to, is never).
        self._emit(
            "heartbeat",
            {"bridge_version": SCRIPT_VERSION, "project_path": self._open_set_path()},
        )

    def _flush_settled_gestures(self, force=False):
        if not self._gestures:
            return

        now = time.time()

        for key in list(self._gestures.keys()):
            gesture = self._gestures[key]

            if not force and (now - gesture["at"]) < GESTURE_SETTLE_SEC:
                continue

            del self._gestures[key]
            self._emit_settled(key, gesture)

    def _emit_settled(self, key, gesture):
        parameter = gesture["parameter"]
        track = gesture["track"]
        start = gesture["start"]
        landed = gesture["last"]

        self._last_values[key] = landed

        # A gesture that returns to where it started is not a change. Riding a
        # filter up and back down leaves the set exactly as it was, and logging
        # it as a move would fill the timeline with decisions nobody made.
        if start == landed:
            return

        track_name = self._safe_name(track)
        track_id = self._safe_id(track)
        device_name = gesture["device_name"]
        parameter_name = gesture["parameter_name"]
        if not (track_name or track_id) or not parameter_name:
            return

        self._emit(
            gesture["event_type"],
            {
                # Track identity, without which the app cannot attribute a move
                # to a lane — the timeline read "37 moves, 0 tracks touched"
                # while every lane sat empty.
                "track_name": track_name,
                "track_id": track_id,
                "device_name": device_name,
                "parameter_name": parameter_name,
                "parameter_value": landed,
                "previous_parameter_value": start,
                "parameter_value_percent": self._percent(parameter, landed),
                "previous_parameter_value_percent": self._percent(parameter, start),
                # Human-readable, unit-bearing values as the device displays them.
                "parameter_display_value": self._display(parameter, landed),
                "previous_parameter_display_value": self._display(parameter, start),
                # How far the knob travelled on the way, which is not recoverable
                # from before/after alone: sweeping to the top and settling back
                # near the start is a different act from nudging it slightly.
                "parameter_value_min": gesture["min"],
                "parameter_value_max": gesture["max"],
            },
        )

    def _clear_parameter_listeners(self):
        # Close any in-flight gesture BEFORE dropping its listeners. Switching
        # tracks mid-ride would otherwise discard the move entirely — and the
        # tweak you make right before clicking away is exactly the one worth
        # remembering.
        self._flush_settled_gestures(force=True)

        for parameter, listener in self._parameter_listeners:
            try:
                if parameter.value_has_listener(listener):
                    parameter.remove_value_listener(listener)
            except Exception:  # noqa: BLE001 - device may already be gone
                pass
            self._last_values.pop(id(parameter), None)
        for device, listener in self._device_listeners:
            try:
                if device.is_active_has_listener(listener):
                    device.remove_is_active_listener(listener)
            except Exception:  # noqa: BLE001 - device may already be gone
                pass

        self._parameter_listeners = []
        self._device_listeners = []
        self._observed_device = None

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
            self._clear_mixer_listeners()
            self._clear_parameter_listeners()
            self._clear_devices_listener()
            self._clear_clip_listeners()
            self._on_selection_changed()
            self._attach_mixer_listeners()
            self._send_snapshot()

    # ── teardown ───────────────────────────────────────────────────────────

    def disconnect(self):
        # Live calls this on script unload and on quit. Leaking listeners here is
        # how a remote script starts crashing Live on set changes, so it has to
        # be exhaustive even in a spike.
        self._clear_mixer_listeners()
        self._clear_parameter_listeners()
        self._clear_devices_listener()
        self._clear_clip_listeners()

        try:
            if self.song.view.selected_track_has_listener(self._on_selection_changed):
                self.song.view.remove_selected_track_listener(
                    self._on_selection_changed
                )
            if self.song.tempo_has_listener(self._on_tempo_changed):
                self.song.remove_tempo_listener(self._on_tempo_changed)
            if self.song.tracks_has_listener(self._on_tracks_changed):
                self.song.remove_tracks_listener(self._on_tracks_changed)
            if self.song.view.detail_clip_has_listener(self._on_detail_clip_changed):
                self.song.view.remove_detail_clip_listener(self._on_detail_clip_changed)
        except Exception:  # noqa: BLE001
            pass

        # Flush before the final event, so a move made seconds before quitting
        # still lands.
        self._flush_settled_gestures(force=True)
        self._emit(
            "bridge_stopped",
            {"moves_seen": self._moves_seen, "note_edits_seen": self._note_edits_seen},
        )

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
