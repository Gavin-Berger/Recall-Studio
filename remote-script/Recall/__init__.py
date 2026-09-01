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
# knob ride becomes one settled move; a written phrase becomes one settled note
# edit with a bounded before/after pattern snapshot. The authoritative content
# still lives in the .als; the snapshot lets Recall show the musical decision
# instead of reducing a chord or rhythm to only its lowest and highest pitch.
#
# Runtime: Python 3.11 (Live 12's embedded interpreter).

from __future__ import annotations

import json
import logging
import os
import queue
import re
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
#
# THIS CAP HIDES REAL WORK. Serum and comparable synths publish well past 128
# automatable parameters, so a knob past the cutoff has no listener and its
# moves are never captured at all — not counted, not dropped, simply unobserved.
# Every other ceiling in this file ships a truncation flag alongside its data;
# this one used to report only the truncated count, which made a partially
# watched device indistinguishable from a fully watched one. `focus_changed` now
# carries `parameter_count_total` and `parameters_truncated` so the app can say
# what it is and is not watching instead of implying full coverage.
#
# RAISED 128 -> 1024. The old value was costing real capture in real libraries:
# Serum 2 is all over this one, and every knob past the 128th was unobserved.
#
# What it costs to raise is listener COUNT, not listener firing — registering a
# value listener is cheap and a parameter is only work when it moves. The
# scenario the low cap defended against was hundreds of parameters moving at
# once, and the one thing that did that was automation playback, which is now
# filtered before it reaches a gesture (issue #9). 1024 covers Serum and the
# large VSTs while still bounding a pathological device, and the truncation
# flag still tells the app when it was hit.
MAX_PARAMS_PER_DEVICE = 1024
PARAMETER_ROSTER_CHECK_SEC = 1.0
ARRANGEMENT_ROSTER_CHECK_SEC = 1.0

# Mixer controls are a compact, high-value exception to the focused-device
# listener rule below. A large set can have hundreds of plugin parameters per
# track, but every mixer channel has just volume, pan, and at most one send per
# Return track. Cap sends defensively anyway: losing a 17th send is preferable
# to an unusual Live build registering an unbounded listener collection.
MAX_MIXER_SENDS_PER_TRACK = 16
MAX_SCENES = 128
MAX_RACK_CHAINS = 32
MAX_CHAIN_DEVICES = 32
MAX_DRUM_PADS = 128

# Ceiling on clips watched per track, and on notes read out of any one clip.
#
# Notes are the one thing in this script that can be genuinely large: a bounced
# MIDI performance or a densely programmed hat pattern runs to thousands of
# events, and the read happens on Live's thread. Both caps are about that read,
# not about listener count — registering a notes listener is free, reading the
# roll is not.
#
# THE TWO CAPS ARE NOT THE SAME KIND OF LIMIT, and conflating them cost data.
# MAX_NOTES_READ bounds work on LIVE'S THREAD and is the only one here that can
# make Live stutter. MAX_MIDI_NOTES_CAPTURED bounds the PAYLOAD, and was set to
# half the read: the script paid Live's thread to read 4096 notes and then threw
# 2048 of them away, so a dense clip's piano roll lied by omission about notes
# already in hand for free.
#
# The payload cap was sized when MAX_TCP_LINE_BYTES was 32 KB. That ceiling is
# now 4 MB (issue #15), and measured across this library every clip_notes_changed
# payload TOGETHER comes to about 3 MB — 142 MB of the 181 MB database is
# live_set_snapshot, not notes. So the payload cap now matches the read, and
# nothing that survives the read is discarded.
#
# MAX_NOTES_READ is deliberately NOT raised here. It is the one number that can
# hurt Live, and it should be set from a measurement rather than a guess —
# _read_notes now logs how long the read actually took (NOTE_READ_SLOW_MS) so
# there is data to set it from.
MAX_CLIPS_PER_TRACK = 64
MAX_ARRANGEMENT_CLIP_IDENTITIES = 512
MAX_NOTES_READ = 4096
MAX_MIDI_NOTES_CAPTURED = 4096
MAX_AUTOMATION_POINTS = 512
MAX_WARP_MARKERS = 512


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
#   3 = recording    the producer is writing automation now
AUTOMATION_STATE_NONE = 0
AUTOMATION_STATE_PLAYING = 1
AUTOMATION_STATE_OVERRIDDEN = 2
AUTOMATION_STATE_RECORDING = 3


def _automation_event_type(previous_state, current_state):
    """The durable automation decision represented by a state transition.

    The value listener cannot tell a hand move from automation playback. The
    state transition can: an automation lane first appearing is a creation;
    entering write mode on an existing lane is an edit. Every other transition
    is playback or cleanup and must stay quiet.
    """
    if previous_state is None or current_state is None:
        return None
    if previous_state == AUTOMATION_STATE_NONE and current_state != AUTOMATION_STATE_NONE:
        return "automation_created"
    if current_state == AUTOMATION_STATE_RECORDING and previous_state != AUTOMATION_STATE_RECORDING:
        return "automation_edited"
    return None


def _automation_position_label(beats_song_time):
    """Render Live's own bar/beat position without deriving it from seconds.

    Song.get_current_beats_song_time() returns the musical Arrangement position.
    Its values are already bar-aware (including meter changes), so we must not
    calculate a bar number from current_song_time ourselves.
    """
    if beats_song_time is None:
        return None

    bars = getattr(beats_song_time, "bars", None)
    beats = getattr(beats_song_time, "beats", None)
    if bars is None or beats is None:
        return None

    # A control-surface callback can be only a few milliseconds apart while a
    # producer drags across a long envelope. Sixteenth-level callback timing is
    # not an envelope endpoint, so it would falsely turn two callbacks into a
    # tiny automation segment. Keep this to the musical point Live can prove.
    return "Bar {} · Beat {}".format(bars, beats)


_NUMBERED_TRACK_NAME = re.compile(r"^\s*(\d+)([\s._-]+)(.+?)\s*$")


def _is_automatic_track_number_adjustment(
    previous_name,
    current_name,
    previous_index=None,
    current_index=None,
):
    """Whether Live only refreshed a track's position prefix.

    Producers often keep Live's numbered channel names (for example
    ``10-Serum 2``). Inserting or moving a channel makes Live rewrite that
    ordinal even though the producer did not rename the sound. Treat it as a
    silent lane-label update when both numbers agree with the track's old and
    new one-based positions and the meaningful part of the name is unchanged.
    """
    before = _NUMBERED_TRACK_NAME.match(str(previous_name or ""))
    after = _NUMBERED_TRACK_NAME.match(str(current_name or ""))
    if before is None or after is None:
        return False
    if before.group(2) != after.group(2):
        return False
    if before.group(3).strip().casefold() != after.group(3).strip().casefold():
        return False

    previous_number = int(before.group(1))
    current_number = int(after.group(1))
    if previous_number == current_number:
        return False
    if previous_index is None or current_index is None:
        return False
    return (
        previous_number == int(previous_index) + 1
        and current_number == int(current_index) + 1
    )


def _track_structure_events(previous, current):
    """The concrete track edits between two lightweight song snapshots.

    `Song.tracks` tells us that structure changed but not what changed. Comparing
    ids, names, and group ownership turns that coarse callback into useful
    producer-facing events without polling Live or traversing device chains.
    """
    events = []

    for key, track in sorted(current.items(), key=lambda item: item[1]["index"]):
        if key not in previous:
            event_type = "return_track_added" if track["track_type"] == "return" else "track_created"
            events.append((event_type, dict(track)))

    for key, track in sorted(previous.items(), key=lambda item: item[1]["index"]):
        if key not in current and track["track_type"] != "master":
            events.append(("track_deleted", dict(track)))

    for key in sorted(set(previous).intersection(current)):
        before = previous[key]
        after = current[key]
        if (
            before["track_name"] != after["track_name"]
            and not _is_automatic_track_number_adjustment(
                before["track_name"],
                after["track_name"],
                before.get("track_index"),
                after.get("track_index"),
            )
        ):
            payload = dict(after)
            payload["previous_track_name"] = before["track_name"]
            events.append(("track_name_changed", payload))
        if before["group_track_id"] != after["group_track_id"]:
            payload = dict(after)
            payload["previous_group_track_id"] = before["group_track_id"]
            payload["previous_group_track_name"] = before["group_track_name"]
            events.append(
                ("tracks_grouped" if after["group_track_id"] else "track_ungrouped", payload)
            )

    return events


def _became_active(previous, current):
    """Whether a trigger/playback state crossed from idle to active."""
    return not bool(previous) and bool(current)


def _note_value(note, name, index, default=None):
    """Read one note field across Live's object, dict, and legacy tuple APIs."""
    if isinstance(note, dict):
        return note.get(name, default)
    try:
        return getattr(note, name)
    except Exception:  # noqa: BLE001 - not every Live note exposes every field
        pass
    try:
        return note[index]
    except Exception:  # noqa: BLE001 - legacy tuple is shorter than Live 11+
        return default


def _normalize_midi_note(note):
    """A JSON-safe note with the timing needed to recreate the phrase."""
    pitch = _note_value(note, "pitch", 0)
    start = _note_value(note, "start_time", 1)
    duration = _note_value(note, "duration", 2)
    if pitch is None or start is None or duration is None:
        return None

    normalized = {
        "pitch": int(pitch),
        "start_time": round(float(start), 6),
        "duration": round(float(duration), 6),
        "velocity": round(float(_note_value(note, "velocity", 3, 100.0)), 3),
        "mute": bool(_note_value(note, "mute", 4, False)),
    }
    for name, index in (
        ("note_id", 5),
        ("probability", 6),
        ("velocity_deviation", 7),
        ("release_velocity", 8),
    ):
        value = _note_value(note, name, index)
        if value is not None:
            normalized[name] = int(value) if name == "note_id" else round(float(value), 3)
    return normalized


def _normalize_warp_markers(value, limit=MAX_WARP_MARKERS):
    """Normalize the shapes returned by different Live Python API builds."""
    if value is None:
        return []
    if isinstance(value, dict):
        if "warp_markers" in value:
            value = value["warp_markers"]
        elif "markers" in value:
            value = value["markers"]
        elif "sample_time" in value and "beat_time" in value:
            value = [value]
        else:
            value = list(value.values())
    try:
        values = list(value)
    except Exception:  # noqa: BLE001
        return []

    markers = []
    for marker in values[:limit]:
        sample_time = _note_value(marker, "sample_time", 0)
        beat_time = _note_value(marker, "beat_time", 1)
        if sample_time is None or beat_time is None:
            continue
        markers.append(
            {
                "sample_time": round(float(sample_time), 6),
                "beat_time": round(float(beat_time), 6),
            }
        )
    return sorted(markers, key=lambda marker: marker["beat_time"])


def _cue_point_events(previous, current):
    """Concrete locator edits from two tiny cue-point rosters."""
    events = []
    for key, cue in sorted(current.items(), key=lambda item: item[1]["cue_time"]):
        if key not in previous:
            events.append(("cue_point_added", dict(cue)))
            continue
        before = previous[key]
        if before["cue_name"] != cue["cue_name"]:
            payload = dict(cue)
            payload["previous_cue_name"] = before["cue_name"]
            events.append(("cue_point_renamed", payload))
        if before["cue_time"] != cue["cue_time"]:
            payload = dict(cue)
            payload["previous_cue_time"] = before["cue_time"]
            events.append(("cue_point_moved", payload))
    for key, cue in previous.items():
        if key not in current:
            events.append(("cue_point_deleted", dict(cue)))
    return events


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
# How long to wait after a track thaws before deciding what kind of thaw it was.
# Live rebuilds the track's chain asynchronously, so reading it in the callback
# reports a half-state; one tick of Live's ~100ms display loop is enough for the
# devices and clips to settle into their final form.
THAW_SETTLE_SEC = 0.5

# How long after a mixer-listener rebuild the channel strip is still ARRIVING
# rather than being played.
#
# Live drives every track's volume, pan and routing to the loaded set's values
# AFTER the listeners are attached, so those callbacks are genuine — they are
# just not the producer. Measured on a real library: 103 mixer events inside a
# single second at session start, then 58 more in one second at +7s and again
# at +44s when tracks changed, with nothing but heartbeats in between. Nobody
# moves 103 faders in a second.
#
# Suppressed rather than reclassified because volume and pan ARE creative when
# a human does them; the problem is only ever the arrival burst. Seeds are still
# updated while settling, so the first real move afterwards reports a true
# "before" instead of a pre-load reading.
MIXER_SETTLE_SEC = 2.5

# One Live operation touching every channel at once is not seven decisions.
#
# The settle window above only covers bursts that follow a listener rebuild.
# The real library also produced 58 `track_routing_changed` inside TEN
# MILLISECONDS at +44.7s of a session, with no rebuild in front of it — Live
# cascading one change across every track. A producer cannot generate that.
#
# Emissions are already coalesced per settled gesture, so a fader sweep is ONE
# emission, not many: rapid consecutive emissions of the same mixer family
# therefore mean a cascade rather than fast hands. The run resets whenever a
# quarter-second of quiet passes, so ordinary quick work never accumulates
# toward the threshold.
CASCADE_WINDOW_SEC = 0.25
CASCADE_THRESHOLD = 6

# The same idea for note edits, but slower. A notes listener fires on every
# single change — each drawn note, each nudge, and continuously through a record
# pass — so a four-bar take would otherwise emit a hundred rows describing one
# act. 1.2s waits out the gaps inside a phrase without making the edit feel like
# it went missing.
NOTE_SETTLE_SEC = 1.2
# A note read slower than this gets logged with its size, so MAX_NOTES_READ
# can be raised against evidence. Live's display loop runs about every 100ms,
# so 25ms is a quarter of a tick — worth knowing about long before it hurts.
NOTE_READ_SLOW_MS = 25.0

# Distinct from the bridge's "max_for_live" so events from the two capture tiers
# are told apart in the database. The listener defaults source to max_for_live
# when absent, so this must always be sent explicitly.
SOURCE = "control_surface"

# Pitch class names for rendering a note range the way a producer reads it
# ("C1–G2" rather than "36–67"). Live numbers middle C as C3 = MIDI 60, so the
# octave is (pitch // 12) - 2 — matching Live's own display, not the C4 = 60
# convention other DAWs use.
NOTE_NAMES = ("C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B")
WARP_MODE_NAMES = {
    0: "Beats",
    1: "Tones",
    2: "Texture",
    3: "Re-Pitch",
    4: "Complex",
    5: "REX",
    6: "Complex Pro",
}
AUDIO_CLIP_PROPERTIES = (
    "warp_markers",
    "warp_mode",
    "warping",
    "gain",
    "pitch_coarse",
    "pitch_fine",
    "looping",
    "loop_start",
    "loop_end",
    "start_marker",
    "end_marker",
)
ROUTING_PROPERTIES = (
    "input_routing_type",
    "input_routing_channel",
    "output_routing_type",
    "output_routing_channel",
)

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
# 0.5.3 adds automation-state capture: lane creation and writes to an existing
# lane, while playback remains deliberately silent.
# 0.5.4 expands the coarse track-list callback into safe create/delete/rename
# and grouping events from a tiny track-only snapshot.
# 0.5.5 adds bounded Session View performance capture: every scene trigger and
# clip launches on the selected track, without a full-set clip listener sweep.
# 0.5.6 records the actual musical start/end of an automation write using
# Live's bars/beats clock, so the timeline can answer what changed and where.
# 0.5.7 treats a short control callback burst as an automation point, not an
# invented tiny segment between two sixteenth notes.
# 0.5.8 turns the deep snapshot into a device-state checkpoint and reconciles
# anything that moved while listeners attached.
# 0.5.9 treats a newly inserted Arrangement audio clip as a named production
# move instead of silently noticing it only after it already exists.
# 0.6.0 makes musical location part of every event envelope: observed playhead
# bars/beats plus exact Arrangement clip ranges when Live publishes them.
# 0.7.0 preserves bounded recreation evidence: real automation-write samples,
# MIDI note onsets, selected audio-clip warp state, song context, and locators.
# 0.7.1 keeps Live's automatic numbered-track adjustments out of producer
# memory while still refreshing the current lane labels through the snapshot.
# 0.7.2 ignores transient Python identities for routing-channel objects. A
# listener refresh must not turn an unchanged set-wide routing snapshot into
# dozens of claimed producer actions.
# 0.10.0 finishes the freeze story (unfreeze and flatten were silent, and a
# thaw's verdict now settles a tick later so Live's half-rebuilt chain is not
# mistaken for a flatten), lifts the parameter cap 128 -> 1024 because Serum's
# knobs past the 128th were never observed, stops discarding half of every note
# read, and reports the slowest note read on the heartbeat so MAX_NOTES_READ can
# be sized from evidence.
SCRIPT_VERSION = "0.10.0"


class Recall(ControlSurface):
    """Minimal control surface that reports what it can see to Recall Studio."""

    def __init__(self, c_instance):
        super().__init__(c_instance)
        self._queue = None
        self._thread = None
        self._stop = None
        self._parameter_listeners = []
        self._device_listeners = []
        self._device_property_listeners = []
        self._device_property_values = {}
        self._track_structure_listeners = []
        self._routing_listeners = []
        self._routing_values = {}
        self._track_state_listeners = []
        self._track_state_values = {}
        # What a track looked like while frozen, so a thaw can be read as an
        # unfreeze or a flatten rather than guessed at.
        self._frozen_shapes = {}
        self._pending_thaws = {}
        self._track_structure = {}
        self._return_tracks_listener_attached = False
        # Parameter automation-state listeners mirror the value listener scope.
        # They are separate because a lane's existence is a decision of its own.
        self._automation_parameter_listeners = []
        self._mixer_automation_listeners = []
        self._automation_states = {}
        self._automation_writes = {}
        self._automation_recently_changed = {}
        # Mixer listeners survive selected-track changes: selection scopes
        # plugin parameters, but mixing is project-wide.
        self._mixer_parameter_listeners = []
        self._mixer_property_listeners = []
        self._mixer_property_values = {}
        self._arm_listeners = []
        self._armed_track_ids = set()
        self._observed_device = None
        self._observed_track = None
        self._device_roster = {}
        # paramId -> last value seen, so each move can report what it moved FROM.
        # Live's listener callback carries no value and no previous value, so the
        # before-side has to be remembered here.
        self._last_values = {}
        # paramId -> in-flight gesture (start value, swept min/max, last sample
        # and when it arrived). Settled by update_display, not by the callback.
        self._gestures = {}
        self._moves_seen = 0
        self._automation_edits_seen = 0
        # Clip-note capture. _clip_listeners and _slot_listeners are unregistered
        # on teardown; _clip_prints holds the last settled fingerprint per clip so
        # an edit can report what it changed FROM, the same way _last_values does
        # for parameters; _dirty_clips holds edits waiting to settle.
        self._clip_listeners = []
        self._slot_listeners = []
        self._slot_playback_listeners = []
        self._slot_playing_status = {}
        self._scene_listeners = []
        self._scene_name_listeners = []
        self._scene_triggered = {}
        self._scene_roster = {}
        self._scenes_listener_attached = False
        self._cue_point_listeners = []
        self._cue_point_roster = {}
        self._cue_points_listener_attached = False
        self._song_context_listeners = []
        self._song_context = {}
        self._recording_active = False
        self._clip_prints = {}
        # clipId -> bounded note snapshot matching _clip_prints. Scoped to the
        # clips currently watched and discarded with their listeners.
        self._clip_note_snapshots = {}
        self._dirty_clips = {}
        self._audio_clip_listeners = []
        self._audio_clip_prints = {}
        self._dirty_audio_clips = {}
        # Clips already carrying a notes listener, so the slot path and the
        # piano-roll path can't both register on one clip.
        self._watched_clip_ids = set()
        # slotId -> the name of the clip it last held, so a deletion can still
        # say WHICH clip went away after Live has discarded the object.
        self._slot_names = {}
        # Worst note read observed this session. Reported, never acted on: it
        # exists so MAX_NOTES_READ can be raised against evidence instead of a
        # guess. See _record_note_read.
        self._slowest_note_read_ms = 0.0
        self._slowest_note_read_count = 0
        self._watched_clips = (0, 0)
        # selected-track Arrangement clip identity -> captured metadata. The
        # initial roster is a baseline; only identities appearing afterward are
        # emitted, so opening an existing song never fabricates sample drops.
        self._arrangement_clip_roster = {}
        self._last_arrangement_roster_check_at = 0.0
        self._note_edits_seen = 0
        # _send_snapshot's dedup cache. refresh_state() fires on more than just
        # "the open set changed" (see its docstring), so without this an
        # unchanged set re-sends its whole snapshot on every one of those calls.
        self._last_snapshot_fingerprint = None
        # Baseline is read before listeners attach; the first display tick runs
        # the same sweep again and fingerprinting emits only a real difference.
        self._reconcile_snapshot_pending = False
        self._focused_parameter_roster = ()
        self._last_parameter_roster_check_at = 0.0
        # 0.0 rather than time.time() so the first update_display tick sends a
        # heartbeat immediately: the app cannot show "connected" (or which build
        # is running) until one arrives, and the producer is watching for exactly
        # that the moment they select Recall in Live's preferences.
        self._last_heartbeat_at = 0.0
        self._project_file_path = None
        self._project_file_stamp = None
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
            # Persist the first-observed device state before callbacks can move
            # it. The first display tick reconciles this after attachment.
            self._send_snapshot()
            self._reconcile_snapshot_pending = True
            self._listen_to_selection()
            self._attach_track_structure_listeners()
            self._track_structure = self._track_structure_snapshot()
            self._attach_scene_listeners()
            self._attach_cue_point_listeners()
            self._attach_song_context_listeners()
            self._attach_mixer_listeners()

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

    def _musical_position_context(self):
        """Read Live's playhead as both producer-facing bars and raw beats."""
        context = {}
        try:
            beats = float(self.song.current_song_time)
        except Exception:  # noqa: BLE001 - unavailable during teardown/startup
            beats = None
        try:
            position = _automation_position_label(
                self.song.get_current_beats_song_time()
            )
        except Exception:  # noqa: BLE001 - older Live API / closing set
            position = None
        if beats is not None:
            context["observed_arrangement_beats"] = round(beats, 4)
        if position is not None:
            context["observed_arrangement_position"] = position
        return context

    def _emit(self, event_type, payload=None):
        if self._queue is None:
            return

        # Musical location is event context, not an automation-only detail.
        # Stamp it once at the common emission boundary so new event types cannot
        # accidentally ship without "where was the playhead?" evidence. A
        # settled gesture can supply the position captured by its last real Live
        # callback; setdefault preserves that earlier, more precise observation.
        # Keep object location (for example a clip's arrangement_start_beats) as
        # a separate fact: editing a clip while the playhead is elsewhere must
        # never make reconstruction claim that the clip lives at the playhead.
        payload = dict(payload or {})
        for key, value in self._musical_position_context().items():
            payload.setdefault(key, value)

        event = {
            "protocol": PROTOCOL,
            "source": SOURCE,
            "event_type": event_type,
            "timestamp_ms": int(time.time() * 1000),
            "payload": payload,
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
        try:
            self.song.add_return_tracks_listener(self._on_tracks_changed)
            self._return_tracks_listener_attached = True
        except Exception as error:  # noqa: BLE001 - not exposed on older Live
            logger.info("Recall Studio: no return-tracks listener: {}".format(error))
        try:
            self.song.add_scenes_listener(self._on_scenes_changed)
            self._scenes_listener_attached = True
        except Exception as error:  # noqa: BLE001 - not exposed on older Live
            logger.info("Recall Studio: no scenes listener: {}".format(error))

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
        # State only, no listeners. This becomes the durable first-observed
        # checkpoint that later gestures can be compared against.
        parameters = []
        for parameter in device.parameters:
            try:
                value = parameter.value
                is_quantized = bool(getattr(parameter, "is_quantized", False))
                try:
                    automation_state = int(parameter.automation_state)
                except Exception:  # noqa: BLE001
                    automation_state = None
                try:
                    parameter_state = int(parameter.state)
                except Exception:  # noqa: BLE001
                    parameter_state = None
                state = {
                    "id": str(parameter._live_ptr),
                    "name": parameter.name,
                    "value": value,
                    "display_value": self._display(parameter, value),
                    "min": parameter.min,
                    "max": parameter.max,
                    "is_quantized": is_quantized,
                    "is_enabled": bool(getattr(parameter, "is_enabled", True)),
                    "automation_state": automation_state,
                    "state": parameter_state,
                }
                try:
                    state["original_name"] = parameter.original_name
                except Exception:  # noqa: BLE001 - older Live parameter API
                    pass
                if is_quantized:
                    try:
                        state["value_items"] = [str(item) for item in parameter.value_items]
                    except Exception:  # noqa: BLE001 - host may omit enum labels
                        state["value_items"] = []
                else:
                    state["default_value"] = getattr(parameter, "default_value", None)
                parameters.append(state)
            except Exception as error:  # noqa: BLE001 - isolate a bad plug-in parameter
                logger.info("Recall Studio: parameter checkpoint skipped: {}".format(error))

        payload = {
            "id": str(device._live_ptr),
            "name": device.name,
            "is_active": bool(device.is_active),
            # Live's device type enum (1 instrument, 2 audio effect, 4 midi
            # effect). The projection derives a device's chain ROLE from this,
            # and without it every device — including instruments — was being
            # classified as an audio effect.
            "type": getattr(device, "type", None),
            "host_parameter_count": len(parameters),
            "parameters": parameters,
        }
        # Preset/program identity is not consistently published by plug-ins.
        # Keep it when Live exposes it; absence remains explicitly unknown.
        for source_name, output_name in (
            ("class_name", "class_name"),
            ("class_display_name", "class_display_name"),
            ("preset_name", "preset_name"),
        ):
            try:
                value = getattr(device, source_name)
            except Exception:  # noqa: BLE001
                value = None
            if value not in (None, ""):
                payload[output_name] = str(value)
        for name in (
            "has_macro_mappings",
            "macros_mapped",
            "variation_count",
            "selected_variation_index",
        ):
            try:
                payload[name] = getattr(device, name)
            except Exception:  # noqa: BLE001 - only rack devices expose these
                pass

        chains = self._safe_list(device, "chains")[:MAX_RACK_CHAINS]
        if chains:
            payload["chains"] = []
            for index, chain in enumerate(chains):
                chain_payload = {
                    "id": self._safe_id(chain),
                    "name": self._safe_name(chain),
                    "index": index,
                    "devices": [],
                }
                for name in ("color", "mute", "solo"):
                    try:
                        chain_payload[name] = getattr(chain, name)
                    except Exception:  # noqa: BLE001
                        pass
                for child in self._safe_list(chain, "devices")[:MAX_CHAIN_DEVICES]:
                    child_payload = {
                        "id": self._safe_id(child),
                        "name": self._safe_name(child),
                    }
                    for name in ("class_name", "type"):
                        try:
                            child_payload[name] = getattr(child, name)
                        except Exception:  # noqa: BLE001 - isolate one child device
                            pass
                    chain_payload["devices"].append(child_payload)
                payload["chains"].append(chain_payload)

        pads = self._safe_list(device, "visible_drum_pads")[:MAX_DRUM_PADS]
        if pads:
            payload["drum_pads"] = []
            for pad in pads:
                pad_payload = {
                    "id": self._safe_id(pad),
                    "name": self._safe_name(pad),
                }
                for name in ("note", "mute", "solo"):
                    try:
                        pad_payload[name] = getattr(pad, name)
                    except Exception:  # noqa: BLE001
                        pass
                payload["drum_pads"].append(pad_payload)
        return payload

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
        for name in (
            "mute",
            "solo",
            "arm",
            "is_frozen",
            "can_be_frozen",
            "fold_state",
            "is_visible",
            "current_monitoring_state",
            "implicit_arm",
        ):
            try:
                payload[name] = getattr(track, name)
            except Exception:  # noqa: BLE001 - special tracks expose a subset
                pass
        for name in ROUTING_PROPERTIES:
            try:
                payload[name] = self._routing_value(getattr(track, name))
            except Exception:  # noqa: BLE001
                pass

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
            "snapshot_schema_version": 2,
            "tempo": song.tempo,
            "project_name": self._safe_name(song),
            "project_path": self._open_set_path(),
            "track_count": len(song.tracks),
            "tracks": [
                self._serialize_track(track, i) for i, track in enumerate(song.tracks)
            ],
            "return_tracks": [
                self._serialize_track(track, i)
                for i, track in enumerate(song.return_tracks)
            ],
            "master_track": self._serialize_track(song.master_track, 0),
            "scenes": [
                self._scene_payload(scene, index)
                for index, scene in enumerate(self._safe_list(song, "scenes")[:MAX_SCENES])
            ],
            "cue_points": list(self._cue_point_roster_snapshot().values()),
        }
        for name in (
            "signature_numerator",
            "signature_denominator",
            "root_note",
            "scale_name",
            "swing_amount",
            "groove_amount",
        ):
            try:
                payload[name] = getattr(song, name)
            except Exception:  # noqa: BLE001 - optional per Live version
                pass
        try:
            payload["scale_intervals"] = [int(value) for value in song.scale_intervals]
        except Exception:  # noqa: BLE001 - Live 12 only
            pass

        fingerprint = _snapshot_fingerprint(payload)
        if fingerprint == self._last_snapshot_fingerprint:
            return
        self._last_snapshot_fingerprint = fingerprint

        self._emit("live_set_snapshot", payload)

    def _on_tempo_changed(self):
        self._emit("tempo_changed", {"bpm": self.song.tempo})

    def _song_context_snapshot(self):
        """Small musical/recording state used to name meaningful transitions."""
        context = {}
        for name in (
            "signature_numerator",
            "signature_denominator",
            "root_note",
            "scale_name",
            "swing_amount",
            "groove_amount",
            "record_mode",
            "session_record",
            "is_playing",
        ):
            try:
                context[name] = getattr(self.song, name)
            except Exception:  # noqa: BLE001 - property varies by Live version
                pass
        try:
            context["scale_intervals"] = [int(value) for value in self.song.scale_intervals]
        except Exception:  # noqa: BLE001 - Live 12 only
            pass
        context["recording_active"] = bool(context.get("is_playing")) and bool(
            context.get("record_mode") or context.get("session_record")
        )
        return context

    def _attach_song_context_listeners(self):
        self._song_context = self._song_context_snapshot()
        self._recording_active = bool(self._song_context.get("recording_active"))
        for name in (
            "signature_numerator",
            "signature_denominator",
            "root_note",
            "scale_name",
            "swing_amount",
            "groove_amount",
            "record_mode",
            "session_record",
            "is_playing",
        ):
            try:
                listener = self._on_song_context_changed
                getattr(self.song, "add_{}_listener".format(name))(listener)
                self._song_context_listeners.append((name, listener))
            except Exception:  # noqa: BLE001 - optional LOM surface
                continue

    def _clear_song_context_listeners(self):
        for name, listener in self._song_context_listeners:
            try:
                has = getattr(self.song, "{}_has_listener".format(name))
                remove = getattr(self.song, "remove_{}_listener".format(name))
                if has(listener):
                    remove(listener)
            except Exception:  # noqa: BLE001 - song may be closing
                pass
        self._song_context_listeners = []
        self._song_context = {}

    def _on_song_context_changed(self):
        previous = self._song_context
        current = self._song_context_snapshot()
        self._song_context = current

        previous_meter = (
            previous.get("signature_numerator"),
            previous.get("signature_denominator"),
        )
        current_meter = (
            current.get("signature_numerator"),
            current.get("signature_denominator"),
        )
        if previous_meter != current_meter and None not in current_meter:
            self._emit(
                "signature_changed",
                {
                    "signature_numerator": current_meter[0],
                    "signature_denominator": current_meter[1],
                    "previous_signature_numerator": previous_meter[0],
                    "previous_signature_denominator": previous_meter[1],
                },
            )

        previous_scale = (previous.get("root_note"), previous.get("scale_name"))
        current_scale = (current.get("root_note"), current.get("scale_name"))
        if previous_scale != current_scale and any(value is not None for value in current_scale):
            self._emit(
                "scale_changed",
                {
                    "root_note": current_scale[0],
                    "scale_name": current_scale[1],
                    "scale_intervals": current.get("scale_intervals"),
                    "previous_root_note": previous_scale[0],
                    "previous_scale_name": previous_scale[1],
                },
            )

        for name, event_type in (
            ("swing_amount", "swing_changed"),
            ("groove_amount", "groove_changed"),
        ):
            if name in current and previous.get(name) != current.get(name):
                self._emit(
                    event_type,
                    {name: current.get(name), "previous_{}".format(name): previous.get(name)},
                )

        recording_active = bool(current.get("recording_active"))
        if recording_active != self._recording_active:
            self._recording_active = recording_active
            self._emit(
                "recording_started" if recording_active else "recording_stopped",
                {
                    "record_mode": bool(current.get("record_mode")),
                    "session_record": bool(current.get("session_record")),
                    "bpm": getattr(self.song, "tempo", None),
                },
            )

    def _cue_point_roster_snapshot(self):
        roster = {}
        for index, cue in enumerate(self._safe_list(self.song, "cue_points")):
            key = self._safe_id(cue) or "object-{}".format(id(cue))
            try:
                cue_time = round(float(cue.time), 4)
            except Exception:  # noqa: BLE001
                cue_time = 0.0
            roster[key] = {
                "cue_id": self._safe_id(cue),
                "cue_name": self._safe_name(cue),
                "cue_time": cue_time,
                "cue_index": index,
                "arrangement_beats": cue_time,
            }
        return roster

    def _attach_cue_point_listeners(self, establish_baseline=True):
        if establish_baseline:
            self._cue_point_roster = self._cue_point_roster_snapshot()
        for cue in self._safe_list(self.song, "cue_points"):
            for name in ("name", "time"):
                try:
                    listener = self._make_cue_point_listener()
                    getattr(cue, "add_{}_listener".format(name))(listener)
                    self._cue_point_listeners.append((cue, name, listener))
                except Exception:  # noqa: BLE001 - optional per Live build
                    continue
        if establish_baseline:
            try:
                self.song.add_cue_points_listener(self._on_cue_points_changed)
                self._cue_points_listener_attached = True
            except Exception:  # noqa: BLE001
                self._cue_points_listener_attached = False

    def _make_cue_point_listener(self):
        def _on_cue():
            self._on_cue_points_changed()

        return _on_cue

    def _clear_cue_point_listeners(self, remove_song_listener=True):
        for cue, name, listener in self._cue_point_listeners:
            try:
                has = getattr(cue, "{}_has_listener".format(name))
                remove = getattr(cue, "remove_{}_listener".format(name))
                if has(listener):
                    remove(listener)
            except Exception:  # noqa: BLE001 - locator may already be deleted
                pass
        self._cue_point_listeners = []
        if remove_song_listener and self._cue_points_listener_attached:
            try:
                if self.song.cue_points_has_listener(self._on_cue_points_changed):
                    self.song.remove_cue_points_listener(self._on_cue_points_changed)
            except Exception:  # noqa: BLE001
                pass
            self._cue_points_listener_attached = False

    def _on_cue_points_changed(self):
        current = self._cue_point_roster_snapshot()
        for event_type, payload in _cue_point_events(self._cue_point_roster, current):
            self._emit(event_type, payload)
        self._cue_point_roster = current
        self._clear_cue_point_listeners(remove_song_listener=False)
        self._attach_cue_point_listeners(establish_baseline=False)

    # ── precise track structure ────────────────────────────────────────────

    def _track_structure_snapshot(self):
        """Small track-only snapshot used to explain `Song.tracks` changes."""
        snapshot = {}
        entries = []
        for index, track in enumerate(self.song.tracks):
            try:
                track_type = "midi" if track.has_midi_input else "audio"
            except Exception:  # noqa: BLE001 - incomplete track during mutation
                track_type = "audio"
            entries.append((track, index, track_type))
        entries.extend(
            (track, index, "return")
            for index, track in enumerate(self.song.return_tracks)
        )
        if self.song.master_track is not None:
            entries.append((self.song.master_track, 0, "master"))

        for track, index, track_type in entries:
            track_id = self._safe_id(track)
            key = track_id or "object-{}".format(id(track))
            try:
                group_track = track.group_track
            except Exception:  # noqa: BLE001 - returns/Main can reject this read
                group_track = None
            try:
                is_group = bool(track.is_foldable)
            except Exception:  # noqa: BLE001 - special tracks can reject it
                is_group = False
            snapshot[key] = {
                "track_id": track_id,
                "track_name": self._safe_name(track),
                "track_type": track_type,
                "track_index": index,
                # `_track_structure_events` uses this short key for stable sort.
                "index": index,
                "group_track_id": self._safe_id(group_track) if group_track else None,
                "group_track_name": self._safe_name(group_track) if group_track else None,
                "is_group": is_group,
            }
        return snapshot

    def _attach_track_structure_listeners(self):
        # One name listener per channel is bounded, unlike a device/parameter
        # walk, and name changes do not trigger Song.tracks on every Live build.
        for track in self._mixer_tracks():
            try:
                listener = self._make_track_name_listener(track)
                track.add_name_listener(listener)
                self._track_structure_listeners.append((track, listener))
            except Exception as error:  # noqa: BLE001 - special track API gap
                logger.info(
                    "Recall Studio: could not watch track name on {}: {}".format(
                        self._safe_name(track), error
                    )
                )
            self._attach_routing_listeners(track)
            self._attach_track_state_listeners(track)

    @staticmethod
    def _routing_value(value):
        if value is None:
            return None
        for name in ("display_name", "name"):
            try:
                result = getattr(value, name)
                if result not in (None, "", 0):
                    return str(result)
            except Exception:  # noqa: BLE001
                pass
        try:
            rendered = str(value).strip()
            # Some Live builds expose RoutingChannel objects without a readable
            # display_name. Their default string includes a Python memory
            # address, which changes across refreshes even when the route does
            # not. Treat it as unknown rather than inventing a routing change.
            if rendered.startswith("<") and " object at 0x" in rendered:
                return None
            return rendered if rendered and rendered != "0" else None
        except Exception:  # noqa: BLE001
            return None

    def _routing_snapshot(self, track):
        snapshot = {}
        for name in ROUTING_PROPERTIES:
            try:
                snapshot[name] = self._routing_value(getattr(track, name))
            except Exception:  # noqa: BLE001 - Main/Return may reject input route
                continue
        return snapshot

    def _attach_routing_listeners(self, track):
        key = self._track_listener_key(track)
        self._routing_values[key] = self._routing_snapshot(track)
        for name in ROUTING_PROPERTIES:
            try:
                listener = self._make_routing_listener(track, key)
                getattr(track, "add_{}_listener".format(name))(listener)
                self._routing_listeners.append((track, name, listener))
            except Exception:  # noqa: BLE001 - optional per track/build
                continue

    def _make_routing_listener(self, track, key):
        def _on_routing():
            previous = self._routing_values.get(key, {})
            current = self._routing_snapshot(track)
            if previous == current:
                return
            self._routing_values[key] = current
            if self._is_mixer_settling() or self._is_cascade("track_routing_changed"):
                return
            changed = [name for name in ROUTING_PROPERTIES if previous.get(name) != current.get(name)]
            payload = {
                "track_name": self._safe_name(track),
                "track_id": self._safe_id(track),
                "changed_fields": changed,
            }
            payload.update(current)
            for name in changed:
                payload["previous_{}".format(name)] = previous.get(name)
            self._emit("track_routing_changed", payload)

        return _on_routing

    def _track_shape(self, track):
        """What a track is made of, coarsely: how many devices, and are its
        clips MIDI.

        Used only to tell UNFREEZE from FLATTEN. Both are the same LOM
        transition -- `is_frozen` goes True -> False -- and nothing in Live says
        which one happened. What separates them is what is LEFT afterwards:
        unfreezing restores the instrument and the MIDI, flattening throws both
        away and leaves audio.
        """
        devices = len(self._safe_list(track, "devices"))
        midi_clips = 0
        audio_clips = 0
        for slot in self._safe_list(track, "clip_slots")[:MAX_CLIPS_PER_TRACK]:
            try:
                if not slot.has_clip:
                    continue
                if getattr(slot.clip, "is_midi_clip", False):
                    midi_clips += 1
                else:
                    audio_clips += 1
            except Exception:  # noqa: BLE001 - slot vanished mid-read
                continue
        for clip in self._safe_list(track, "arrangement_clips")[:MAX_CLIPS_PER_TRACK]:
            try:
                if getattr(clip, "is_midi_clip", False):
                    midi_clips += 1
                else:
                    audio_clips += 1
            except Exception:  # noqa: BLE001
                continue
        return {"devices": devices, "midi_clips": midi_clips, "audio_clips": audio_clips}

    def _attach_track_state_listeners(self, track):
        key = self._track_listener_key(track)
        try:
            self._track_state_values[key] = bool(track.is_frozen)
            listener = self._make_track_state_listener(track, key)
            track.add_is_frozen_listener(listener)
            self._track_state_listeners.append((track, listener))
        except Exception:  # noqa: BLE001 - groups/returns/Main may omit it
            self._track_state_values.pop(key, None)

    def _make_track_state_listener(self, track, key):
        """Freezing, unfreezing and flattening, from one `is_frozen` listener.

        Only freezing was reported before. Unfreezing was silent, so the record
        could show a producer freezing a track and never show them undoing it --
        and `track_flattened` sat in the app's event catalog with nothing on this
        side emitting it, which is the shape of gap the catalog header warns
        about.

        Flatten matters most of the three. It is where an instrument stops being
        an instrument and becomes a waveform: irreversible, and exactly the
        decision a producer goes looking for months later.

        WHY THE VERDICT IS DEFERRED. Both unfreeze and flatten arrive as
        `is_frozen` True -> False, and at the instant this callback runs Live has
        not finished rebuilding the track -- reading the device chain here
        reports whatever half-state the operation is passing through. So the
        transition is recorded and resolved on the next `update_display` tick,
        once the chain has settled. Same reason gestures settle there rather
        than in the value callback.
        """
        def _on_frozen():
            try:
                frozen = bool(track.is_frozen)
            except Exception:  # noqa: BLE001
                return
            previous = self._track_state_values.get(key)
            self._track_state_values[key] = frozen

            if frozen and previous is not True:
                # The shape while frozen is the baseline the thaw is judged
                # against. Captured now because after a flatten it is gone.
                self._frozen_shapes[key] = self._track_shape(track)
                self._emit(
                    "track_frozen",
                    {
                        "track_name": self._safe_name(track),
                        "track_id": self._safe_id(track),
                    },
                )
                self._send_snapshot()
                return

            if not frozen and previous is True:
                self._pending_thaws[key] = {
                    "track": track,
                    "before": self._frozen_shapes.pop(key, None),
                    "at": time.time(),
                }

        return _on_frozen

    def _flush_settled_thaws(self):
        """Decide, one tick later, whether a thaw was an unfreeze or a flatten.

        Unfreeze restores what freezing hid: the instrument comes back and the
        MIDI clips are MIDI again. Flatten keeps neither -- the devices are gone
        and the clips are audio. Comparing against the shape captured at freeze
        is what separates them; with no baseline (the track was already frozen
        when Recall attached) the honest answer is that the track thawed, not a
        guess at which one it was.
        """
        if not self._pending_thaws:
            return

        now = time.time()
        for key in list(self._pending_thaws.keys()):
            pending = self._pending_thaws[key]
            if (now - pending["at"]) < THAW_SETTLE_SEC:
                continue
            del self._pending_thaws[key]

            track = pending["track"]
            try:
                after = self._track_shape(track)
            except Exception:  # noqa: BLE001 - the track was deleted
                continue

            before = pending["before"]
            payload = {
                "track_name": self._safe_name(track),
                "track_id": self._safe_id(track),
                "devices_after": after["devices"],
                "midi_clips_after": after["midi_clips"],
                "audio_clips_after": after["audio_clips"],
            }
            if before is not None:
                payload["devices_before"] = before["devices"]
                payload["midi_clips_before"] = before["midi_clips"]

            if before is None:
                # No baseline: say what is observable and claim nothing more.
                event_type = "track_unfrozen"
                payload["thaw_evidence"] = "no_frozen_baseline"
            elif after["devices"] < before["devices"] and after["midi_clips"] < before["midi_clips"]:
                event_type = "track_flattened"
                payload["thaw_evidence"] = "devices_and_midi_gone"
            else:
                event_type = "track_unfrozen"
                payload["thaw_evidence"] = "chain_restored"

            self._emit(event_type, payload)
            self._send_snapshot()

    def _clear_track_structure_listeners(self):
        for track, listener in self._track_structure_listeners:
            try:
                if track.name_has_listener(listener):
                    track.remove_name_listener(listener)
            except Exception:  # noqa: BLE001 - deleted tracks are already gone
                pass
        self._track_structure_listeners = []
        for track, name, listener in self._routing_listeners:
            try:
                has = getattr(track, "{}_has_listener".format(name))
                remove = getattr(track, "remove_{}_listener".format(name))
                if has(listener):
                    remove(listener)
            except Exception:  # noqa: BLE001 - deleted track is already gone
                pass
        self._routing_listeners = []
        self._routing_values = {}
        for track, listener in self._track_state_listeners:
            try:
                if track.is_frozen_has_listener(listener):
                    track.remove_is_frozen_listener(listener)
            except Exception:  # noqa: BLE001
                pass
        self._track_state_listeners = []
        self._track_state_values = {}
        # What a track looked like while frozen, so a thaw can be read as an
        # unfreeze or a flatten rather than guessed at.
        self._frozen_shapes = {}
        self._pending_thaws = {}

    def _make_track_name_listener(self, track):
        key = self._track_listener_key(track)

        def _on_name():
            previous = self._track_structure.get(key)
            current_name = self._safe_name(track)
            if previous is None or previous["track_name"] == current_name:
                return
            previous_name = previous["track_name"]
            previous_index = previous["track_index"]
            current_index = previous_index
            candidates = (
                self.song.return_tracks
                if previous["track_type"] == "return"
                else self.song.tracks
            )
            if previous["track_type"] != "master":
                for index, candidate in enumerate(candidates):
                    if candidate is track or self._safe_id(candidate) == previous["track_id"]:
                        current_index = index
                        break
            previous["track_name"] = current_name
            previous["track_index"] = current_index
            previous["index"] = current_index
            if _is_automatic_track_number_adjustment(
                previous_name,
                current_name,
                previous_index,
                current_index,
            ):
                # A tracks callback accompanies an insertion/move and sends one
                # fresh snapshot for the whole set. Avoid one event and one
                # snapshot per automatically re-numbered lane.
                return
            self._emit(
                "track_name_changed",
                {
                    "track_id": previous["track_id"],
                    "track_name": current_name,
                    "previous_track_name": previous_name,
                    "track_type": previous["track_type"],
                    "track_index": previous["track_index"],
                },
            )
            # The derived tree is the source of truth for current names, so a
            # one-off snapshot keeps the lane label in step with the event.
            self._send_snapshot()

        return _on_name

    # ── Session View performance ───────────────────────────────────────────

    def _scene_payload(self, scene, index):
        payload = {
            "scene_id": self._safe_id(scene),
            "scene_name": self._safe_name(scene),
            "scene_index": index,
        }
        for name in (
            "tempo",
            "tempo_enabled",
            "time_signature_numerator",
            "time_signature_denominator",
        ):
            try:
                payload[name] = getattr(scene, name)
            except Exception:  # noqa: BLE001 - older Live scene API
                pass
        return payload

    def _scene_roster_snapshot(self):
        roster = {}
        for index, scene in enumerate(self._safe_list(self.song, "scenes")[:MAX_SCENES]):
            key = self._safe_id(scene) or "object-{}".format(id(scene))
            roster[key] = self._scene_payload(scene, index)
        return roster

    def _attach_scene_listeners(self):
        # Scenes are shallow objects; observing their trigger state is bounded
        # and does not touch any clip/note/device data.
        for index, scene in enumerate(self._safe_list(self.song, "scenes")[:MAX_SCENES]):
            key = self._safe_id(scene) or "object-{}".format(id(scene))
            try:
                self._scene_triggered[key] = bool(scene.is_triggered)
                listener = self._make_scene_listener(scene, index, key)
                scene.add_is_triggered_listener(listener)
                self._scene_listeners.append((scene, listener))
            except Exception as error:  # noqa: BLE001 - API missing per Live build
                self._scene_triggered.pop(key, None)
                logger.info(
                    "Recall Studio: could not watch scene {}: {}".format(index + 1, error)
                )
            try:
                name_listener = self._make_scene_name_listener(scene, index, key)
                scene.add_name_listener(name_listener)
                self._scene_name_listeners.append((scene, name_listener))
            except Exception:  # noqa: BLE001 - optional per build
                pass
        self._scene_roster = self._scene_roster_snapshot()

    def _clear_scene_listeners(self):
        for scene, listener in self._scene_listeners:
            try:
                if scene.is_triggered_has_listener(listener):
                    scene.remove_is_triggered_listener(listener)
            except Exception:  # noqa: BLE001 - deleted scene may be invalid
                pass
        for scene, listener in self._scene_name_listeners:
            try:
                if scene.name_has_listener(listener):
                    scene.remove_name_listener(listener)
            except Exception:  # noqa: BLE001 - deleted scene may be invalid
                pass
        self._scene_listeners = []
        self._scene_name_listeners = []
        self._scene_triggered = {}

    def _make_scene_name_listener(self, scene, index, key):
        def _on_name():
            previous = self._scene_roster.get(key, {})
            current = self._scene_payload(scene, index)
            if previous.get("scene_name") == current.get("scene_name"):
                return
            current["previous_scene_name"] = previous.get("scene_name")
            self._scene_roster[key] = dict(current)
            self._emit("scene_renamed", current)

        return _on_name

    def _make_scene_listener(self, scene, index, key):
        def _on_triggered():
            try:
                triggered = bool(scene.is_triggered)
            except Exception:  # noqa: BLE001 - scene was deleted
                return
            previous = self._scene_triggered.get(key, False)
            self._scene_triggered[key] = triggered
            if not _became_active(previous, triggered):
                return
            self._emit("scene_launched", self._scene_payload(scene, index))

        return _on_triggered

    def _on_scenes_changed(self):
        current = self._scene_roster_snapshot()
        for key, scene in current.items():
            if key not in self._scene_roster:
                self._emit("scene_created", scene)
        for key, scene in self._scene_roster.items():
            if key not in current:
                self._emit("scene_deleted", scene)
        self._clear_scene_listeners()
        self._attach_scene_listeners()


    def _on_tracks_changed(self):
        current_structure = self._track_structure_snapshot()
        for event_type, payload in _track_structure_events(
            self._track_structure, current_structure
        ):
            payload.pop("index", None)
            self._emit(event_type, payload)
        self._track_structure = current_structure
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
        self._clear_track_structure_listeners()
        self._attach_track_structure_listeners()
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

        # Everything Live sends in the next couple of seconds is the set
        # arriving, not the producer playing the channel strip.
        self._mixer_settling_until = time.time() + MIXER_SETTLE_SEC

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
            self._watch_mixer_parameter(
                track, mixer, "left_split_stereo", "pan_changed", "Left split pan"
            )
            self._watch_mixer_parameter(
                track, mixer, "right_split_stereo", "pan_changed", "Right split pan"
            )
            self._watch_mixer_property(
                track, mixer, "crossfade_assign", "crossfade_assignment_changed"
            )

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
                    None,
                    "Send → {}".format(destination),
                )

            self._watch_track_arm(track)

    def _watch_mixer_parameter(self, track, mixer, attribute, event_type, label):
        try:
            parameter = getattr(mixer, attribute)
        except Exception:  # noqa: BLE001 - e.g. a special track without pan
            return
        self._watch_value_parameter(track, parameter, event_type, "Mixer", None, label)

    def _is_mixer_settling(self):
        """True while the channel strip is still arriving from a set load."""
        return time.time() < getattr(self, "_mixer_settling_until", 0.0)

    def _is_cascade(self, kind):
        """True once one Live operation is clearly fanning out across tracks.

        Counts consecutive emissions of one family with less than
        CASCADE_WINDOW_SEC between them. A quiet gap resets the run, so this
        only ever fires on a genuine fan-out and never accumulates across
        ordinary work.
        """
        now = time.time()
        runs = getattr(self, "_cascade_runs", None)
        if runs is None:
            runs = {}
            self._cascade_runs = runs
        run = runs.get(kind)
        if run is None or now - run[0] > CASCADE_WINDOW_SEC:
            runs[kind] = [now, 1]
            return False
        run[0] = now
        run[1] += 1
        return run[1] > CASCADE_THRESHOLD

    def _watch_mixer_property(self, track, mixer, name, event_type):
        key = (id(mixer), name)
        try:
            self._mixer_property_values[key] = getattr(mixer, name)
            listener = self._make_mixer_property_listener(track, mixer, name, event_type, key)
            getattr(mixer, "add_{}_listener".format(name))(listener)
            self._mixer_property_listeners.append((mixer, name, listener))
        except Exception:  # noqa: BLE001 - Main and older builds may omit it
            self._mixer_property_values.pop(key, None)

    def _make_mixer_property_listener(self, track, mixer, name, event_type, key):
        def _on_property():
            try:
                current = getattr(mixer, name)
            except Exception:  # noqa: BLE001
                return
            previous = self._mixer_property_values.get(key)
            self._mixer_property_values[key] = current
            if previous == current:
                return
            if self._is_mixer_settling() or self._is_cascade(event_type):
                return
            self._emit(
                event_type,
                {
                    "track_name": self._safe_name(track),
                    "track_id": self._safe_id(track),
                    name: current,
                    "previous_{}".format(name): previous,
                },
            )

        return _on_property

    def _watch_value_parameter(
        self, track, parameter, event_type, device_name, device_id, parameter_name
    ):
        if parameter is None:
            return
        key = id(parameter)
        try:
            self._last_values[key] = parameter.value
            listener = self._make_value_listener(
                track,
                parameter,
                event_type,
                device_name,
                device_id,
                parameter_name,
                # Volume, pan and sends ride the same settle path as device
                # parameters, so the mixer-ness has to travel into the closure:
                # a mixer rebuild must never silence a plugin the producer is
                # actually turning.
                settles_with_mixer=True,
            )
            parameter.add_value_listener(listener)
            self._mixer_parameter_listeners.append((parameter, listener))
            self._watch_automation_state(
                track,
                parameter,
                device_name,
                device_id,
                parameter_name,
                self._mixer_automation_listeners,
            )
        except Exception as error:  # noqa: BLE001 - individual control only
            # Do not retain a seed for a listener that never attached: Live can
            # reuse object ids after a channel disappears.
            self._last_values.pop(key, None)
            logger.info(
                "Recall Studio: could not watch {} on {}: {}".format(
                    parameter_name, self._safe_name(track), error
                )
            )

    def _read_automation_state(self, parameter):
        try:
            state = getattr(parameter, "automation_state", None)
            return int(state) if state is not None else None
        except Exception:  # noqa: BLE001 - parameter was removed
            return None

    def _watch_automation_state(
        self, track, parameter, device_name, device_id, parameter_name, listener_store
    ):
        """Watch automation state without widening parameter traversal scope."""
        # A build that cannot identify the playing enum cannot safely distinguish
        # automation playback from manual input, so it must not claim it sees
        # drawn lanes either.
        if self._automation_playing_state is None:
            return
        if not parameter_name:
            return

        state = self._read_automation_state(parameter)
        if state is None:
            return

        key = id(parameter)
        try:
            listener = self._make_automation_listener(
                track, parameter, device_name, device_id, parameter_name
            )
            parameter.add_automation_state_listener(listener)
            listener_store.append((parameter, listener))
            # Baseline only. Existing automation must never appear as newly
            # drawn just because the producer selected that track.
            self._automation_states[key] = state
        except Exception as error:  # noqa: BLE001 - API unavailable per device
            logger.info(
                "Recall Studio: could not watch automation on {}: {}".format(
                    parameter_name, error
                )
            )

    def _automation_position(self):
        """The exact Arrangement position Live reports for the current write."""
        try:
            return _automation_position_label(self.song.get_current_beats_song_time())
        except Exception:  # noqa: BLE001 - older Live builds may omit this API
            return None

    def _automation_recording_enabled(self):
        """Whether Live is actually armed to write automation now.

        `automation_state == none` or `overridden` tells us the parameter is not
        being driven by playback. Pair that with Live's record state and a
        running transport before calling the movement a recorded automation
        action.
        """
        try:
            return bool(self.song.is_playing) and (
                bool(self.song.record_mode)
                or bool(self.song.session_automation_record)
            )
        except Exception:  # noqa: BLE001 - a partial/older LOM object
            return False

    def _start_automation_write(
        self, track, parameter, device_name, device_id, parameter_name, previous_state
    ):
        """Open a write action; it remains silent until a value actually moves."""
        try:
            current = parameter.value
        except Exception:  # noqa: BLE001 - parameter died with its device
            return

        key = id(parameter)
        self._automation_writes[key] = {
            "track": track,
            "parameter": parameter,
            "device_name": device_name,
            "device_id": device_id,
            "parameter_name": parameter_name,
            # Live reports no automation before a new lane, otherwise this is
            # an edit to an existing lane. This is the only classification here.
            "event_type": _automation_event_type(previous_state, AUTOMATION_STATE_RECORDING)
            or "automation_edited",
            "start_value": self._last_values.get(key, current),
            "start_display_value": self._display(
                parameter, self._last_values.get(key, current)
            ),
            "start_percent": self._percent(
                parameter, self._last_values.get(key, current)
            ),
            "start_ms": int(time.time() * 1000),
            "start_position": self._automation_position(),
            "points": [],
            "last_value_at": None,
        }

    def _record_automation_value(
        self, track, parameter, device_name, device_id, parameter_name
    ):
        """Sample a real automation-write value and its exact Live ruler point."""
        key = id(parameter)
        try:
            current = parameter.value
        except Exception:  # noqa: BLE001 - parameter died with its device
            return

        write = self._automation_writes.get(key)
        if write is None:
            # Most Live versions represent a written, pre-existing lane as
            # "overridden", not a separate recording enum. This branch is only
            # reached after _automation_recording_enabled proved the transport
            # and automation record state, and after a value callback arrived.
            self._start_automation_write(
                track,
                parameter,
                device_name,
                device_id,
                parameter_name,
                self._automation_states.get(key),
            )
            write = self._automation_writes.get(key)
        if write is None:
            return

        write["last_value"] = current
        write["last_display_value"] = self._display(parameter, current)
        write["last_percent"] = self._percent(parameter, current)
        write["last_position"] = self._automation_position()
        write["observed_position"] = self._musical_position_context()
        write["last_value_at"] = time.time()
        try:
            beat = round(float(self.song.current_song_time), 6)
        except Exception:  # noqa: BLE001
            beat = None
        if beat is not None and len(write["points"]) < MAX_AUTOMATION_POINTS:
            point = {
                "beat": beat,
                "value": current,
                "display_value": write["last_display_value"],
                "percent": write["last_percent"],
            }
            previous_point = write["points"][-1] if write["points"] else None
            if previous_point is None or (
                previous_point["beat"] != point["beat"]
                or previous_point["value"] != point["value"]
            ):
                write["points"].append(point)
        self._last_values[key] = current

    def _finish_automation_write(self, parameter, current_state):
        """Emit one recorded write action after its final observed value.

        Start/end positions are transport observations during the control action.
        They locate the producer's write; they are not envelope breakpoints and
        must never be presented as a saved automation segment.
        """
        key = id(parameter)
        write = self._automation_writes.pop(key, None)
        if write is None or write["last_value_at"] is None:
            return

        landed = write["last_value"]
        self._last_values[key] = landed
        # A near-simultaneous value callback belongs to this completed write,
        # not to a second generic parameter move.
        self._automation_recently_changed[key] = time.time()
        self._automation_edits_seen += 1

        payload = {
            "track_name": self._safe_name(write["track"]),
            "track_id": self._safe_id(write["track"]),
            "device_name": write["device_name"],
            "device_id": write["device_id"],
            "parameter_name": write["parameter_name"],
            "parameter_value": landed,
            "previous_parameter_value": write["start_value"],
            "parameter_value_percent": write["last_percent"],
            "previous_parameter_value_percent": write["start_percent"],
            "parameter_display_value": write["last_display_value"],
            "previous_parameter_display_value": write["start_display_value"],
            "automation_state": current_state,
            "automation_start_ms": write["start_ms"],
            "automation_start_position": write["start_position"],
            "automation_end_position": write["last_position"],
            # These are real value callbacks observed while Live was writing,
            # not invented envelope endpoints. A future API can replace the
            # capture method with exact envelope breakpoints without changing
            # the frontend contract.
            "automation_points": write["points"],
            "automation_points_truncated": len(write["points"]) >= MAX_AUTOMATION_POINTS,
            "automation_capture_method": "write_callbacks",
        }
        payload.update(write.get("observed_position", {}))
        self._emit(write["event_type"], payload)

    def _make_automation_listener(
        self, track, parameter, device_name, device_id, parameter_name
    ):
        def _on_automation_state():
            key = id(parameter)
            current_state = self._read_automation_state(parameter)
            previous_state = self._automation_states.get(key)
            if current_state is None:
                return
            self._automation_states[key] = current_state

            if (
                current_state == AUTOMATION_STATE_RECORDING
                and previous_state != AUTOMATION_STATE_RECORDING
            ):
                self._start_automation_write(
                    track,
                    parameter,
                    device_name,
                    device_id,
                    parameter_name,
                    previous_state,
                )
            elif (
                previous_state == AUTOMATION_STATE_RECORDING
                and current_state != AUTOMATION_STATE_RECORDING
            ):
                self._finish_automation_write(parameter, current_state)

        return _on_automation_state

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

        for parameter, listener in self._mixer_automation_listeners:
            try:
                if parameter.automation_state_has_listener(listener):
                    parameter.remove_automation_state_listener(listener)
            except Exception:  # noqa: BLE001 - channel may already be gone
                pass
            self._automation_states.pop(id(parameter), None)
            self._automation_writes.pop(id(parameter), None)
            self._automation_recently_changed.pop(id(parameter), None)

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

        for mixer, name, listener in self._mixer_property_listeners:
            try:
                has = getattr(mixer, "{}_has_listener".format(name))
                remove = getattr(mixer, "remove_{}_listener".format(name))
                if has(listener):
                    remove(listener)
            except Exception:  # noqa: BLE001 - channel may already be gone
                pass

        self._mixer_parameter_listeners = []
        self._mixer_property_listeners = []
        self._mixer_property_values = {}
        self._mixer_automation_listeners = []
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
            self._device_roster = self._device_roster_snapshot(track)

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
        track = self.song.view.selected_track
        current = self._device_roster_snapshot(track)
        for key, device in current.items():
            if key not in self._device_roster:
                self._emit("device_added", device)
        for key, device in self._device_roster.items():
            if key not in current:
                self._emit("device_removed", device)
        previous_order = [
            key for key, _ in sorted(self._device_roster.items(), key=lambda item: item[1]["device_index"])
        ]
        current_order = [
            key for key, _ in sorted(current.items(), key=lambda item: item[1]["device_index"])
        ]
        if set(previous_order) == set(current_order) and previous_order != current_order:
            self._emit(
                "device_chain_changed",
                {
                    "track_name": self._safe_name(track),
                    "track_id": self._safe_id(track),
                    "previous_device_chain": [self._device_roster[key]["device_name"] for key in previous_order],
                    "device_chain": [current[key]["device_name"] for key in current_order],
                },
            )
        self._device_roster = current
        self._clear_parameter_listeners()
        self._attach_to_focused_device(track)
        # Live may replace its provisional "14-MIDI" label with the instrument
        # name when a device is dropped. Refresh the structural snapshot here so
        # the timeline keeps the track's current Ableton label and device chain.
        self._send_snapshot()

    def _clear_devices_listener(self):
        track = self._observed_track
        self._observed_track = None
        self._device_roster = {}

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

            # Session View launch is valuable performance context. This stays
            # on the selected track with the existing clip-note scope; watching
            # every slot in a large set would be a very different safety cost.
            try:
                self._slot_playing_status[id(slot)] = int(slot.playing_status)
                playback_listener = self._make_slot_playback_listener(track, slot, index)
                slot.add_playing_status_listener(playback_listener)
                self._slot_playback_listeners.append((slot, playback_listener))
            except Exception as error:  # noqa: BLE001 - API varies across Live builds
                logger.info(
                    "Recall Studio: could not watch clip launch on slot {}: {}".format(
                        index + 1, error
                    )
                )

            if slot.has_clip:
                watched += self._watch_clip(track, slot.clip, index)

        # Arrangement clips are not reachable through clip_slots — a producer
        # working in Arrangement view has no clip slots in play at all, and
        # without this branch their entire session would capture no note edits.
        # _safe_list because group/return/main tracks RAISE on this property.
        arrangement_clips = self._safe_list(track, "arrangement_clips")[:MAX_ARRANGEMENT_CLIP_IDENTITIES]
        for clip in arrangement_clips[:MAX_CLIPS_PER_TRACK]:
            watched += self._watch_clip(track, clip, None)
        self._arrangement_clip_roster = self._arrangement_clip_snapshot(
            track, arrangement_clips
        )

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

    def _arrangement_clip_snapshot(self, track, clips=None):
        """Small identity roster for the selected track's Arrangement clips.

        This deliberately reads no audio and no MIDI notes. The only extra
        values are the evidence needed for a useful row: Live's clip name,
        backing file path when published, and Arrangement start/end in beats.
        """
        roster = {}
        source = clips if clips is not None else self._safe_list(track, "arrangement_clips")
        for index, clip in enumerate(source[:MAX_ARRANGEMENT_CLIP_IDENTITIES]):
            clip_id = self._safe_id(clip)
            key = clip_id or "object-{}".format(id(clip))
            try:
                file_path = getattr(clip, "file_path", None)
            except Exception:  # noqa: BLE001 - audio property varies by Live build
                file_path = None
            file_path = str(file_path).strip() if file_path not in (None, "") else None
            clip_name = self._safe_name(clip)
            sample_name = os.path.basename(file_path) if file_path else clip_name
            try:
                start_beats = round(float(clip.start_time), 4)
            except Exception:  # noqa: BLE001
                start_beats = None
            try:
                end_beats = round(float(clip.end_time), 4)
            except Exception:  # noqa: BLE001
                end_beats = None
            try:
                is_recording = bool(clip.is_recording)
            except Exception:  # noqa: BLE001
                is_recording = False
            roster[key] = {
                "clip": clip,
                "clip_id": clip_id,
                "clip_name": clip_name,
                "sample_name": sample_name,
                "file_path": file_path,
                "start_beats": start_beats,
                "end_beats": end_beats,
                "is_midi": bool(getattr(clip, "is_midi_clip", False)),
                "is_recording": is_recording,
                "track_name": self._safe_name(track),
                "track_id": self._safe_id(track),
                "arrangement_index": index,
            }
        return roster

    def _refresh_arrangement_clips_if_due(self):
        """Detect newly inserted clips without polling the whole Live Set."""
        now = time.time()
        if (now - self._last_arrangement_roster_check_at) < ARRANGEMENT_ROSTER_CHECK_SEC:
            return
        self._last_arrangement_roster_check_at = now
        track = self.song.view.selected_track
        if track is None:
            self._arrangement_clip_roster = {}
            return

        current = self._arrangement_clip_snapshot(track)
        previous = self._arrangement_clip_roster
        for key, item in current.items():
            if key in previous:
                continue
            self._watch_clip(track, item["clip"], None)
            payload = {
                "track_name": item["track_name"],
                "track_id": item["track_id"],
                "clip_name": item["clip_name"],
                "clip_id": item["clip_id"],
                "arrangement_index": item["arrangement_index"],
                "arrangement_start_beats": item["start_beats"],
                "arrangement_end_beats": item["end_beats"],
            }
            recorded = self._track_listener_key(track) in getattr(self, "_armed_track_ids", set()) and (
                item["is_recording"] or getattr(self, "_recording_active", False)
            )
            if item["is_midi"]:
                self._emit("midi_clip_recorded" if recorded else "midi_clip_created", payload)
            else:
                payload["sample_name"] = item["sample_name"]
                payload["file_path"] = item["file_path"]
                self._emit("audio_clip_recorded" if recorded else "sample_added", payload)
        for key, item in previous.items():
            if key in current:
                continue
            self._emit(
                "clip_deleted",
                {
                    "track_name": item["track_name"],
                    "track_id": item["track_id"],
                    "clip_name": item["clip_name"],
                    "clip_id": item["clip_id"],
                    "arrangement_start_beats": item["start_beats"],
                    "arrangement_end_beats": item["end_beats"],
                },
            )
        for key in set(previous).intersection(current):
            before = previous[key]
            after = current[key]
            if before["clip_name"] != after["clip_name"]:
                self._emit(
                    "clip_renamed",
                    {
                        "track_name": after["track_name"],
                        "track_id": after["track_id"],
                        "clip_name": after["clip_name"],
                        "previous_clip_name": before["clip_name"],
                        "clip_id": after["clip_id"],
                        "arrangement_start_beats": after["start_beats"],
                        "arrangement_end_beats": after["end_beats"],
                    },
                )
            if (
                before["start_beats"] != after["start_beats"]
                or before["end_beats"] != after["end_beats"]
            ):
                self._emit(
                    "clip_moved",
                    {
                        "track_name": after["track_name"],
                        "track_id": after["track_id"],
                        "clip_name": after["clip_name"],
                        "clip_id": after["clip_id"],
                        "arrangement_start_beats": after["start_beats"],
                        "arrangement_end_beats": after["end_beats"],
                        "previous_arrangement_start_beats": before["start_beats"],
                        "previous_arrangement_end_beats": before["end_beats"],
                    },
                )
        self._arrangement_clip_roster = current

    def _watch_clip(self, track, clip, slot_index, watch_audio=False):
        """Register bounded content listeners. Returns 1 when attached."""
        if clip is None:
            return 0
        if not getattr(clip, "is_midi_clip", False):
            return self._watch_audio_clip(track, clip, slot_index) if watch_audio else 0

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
        notes = self._read_notes(clip)
        self._clip_prints[id(clip)] = None if notes is None else self._fingerprint(clip, notes)
        self._clip_note_snapshots[id(clip)] = None if notes is None else {
            "notes": notes[:MAX_MIDI_NOTES_CAPTURED],
            "truncated": len(notes) > MAX_MIDI_NOTES_CAPTURED,
        }
        return 1

    @staticmethod
    def _clip_arrangement_range(clip):
        """Exact global beat range for an Arrangement clip, when published.

        Session clips also expose start_time/end_time, but those describe the
        launched clip's playback state rather than a durable place in the song.
        Never attach those values as arrangement evidence.
        """
        try:
            if bool(getattr(clip, "is_session_clip", True)):
                return {}
            return {
                "arrangement_start_beats": round(float(clip.start_time), 4),
                "arrangement_end_beats": round(float(clip.end_time), 4),
            }
        except Exception:  # noqa: BLE001 - clip disappeared during callback
            return {}

    def _audio_clip_evidence(self, clip):
        """The selected audio clip's reconstructable state, never audio data."""
        evidence = {
            "clip_name": self._safe_name(clip),
            "clip_id": self._safe_id(clip),
        }
        for name in (
            "file_path",
            "gain",
            "gain_display_string",
            "pitch_coarse",
            "pitch_fine",
            "sample_length",
            "sample_rate",
            "warp_mode",
            "warping",
            "looping",
            "loop_start",
            "loop_end",
            "start_marker",
            "end_marker",
        ):
            try:
                value = getattr(clip, name)
            except Exception:  # noqa: BLE001 - property is audio/build-specific
                continue
            if isinstance(value, float):
                value = round(value, 6)
            evidence[name] = value
        warp_mode = evidence.get("warp_mode")
        if warp_mode is not None:
            evidence["warp_mode_name"] = WARP_MODE_NAMES.get(warp_mode, str(warp_mode))
        try:
            markers = _normalize_warp_markers(clip.warp_markers)
            evidence["warp_markers"] = markers
            evidence["warp_markers_truncated"] = len(markers) >= MAX_WARP_MARKERS
        except Exception:  # noqa: BLE001 - unwarped/older Live clip
            pass
        evidence.update(self._clip_arrangement_range(clip))
        return evidence

    def _watch_audio_clip(self, track, clip, slot_index):
        """Watch only the open audio clip; this never sweeps the whole set."""
        key = id(clip)
        if key in self._watched_clip_ids:
            return 0
        attached = 0
        for name in AUDIO_CLIP_PROPERTIES:
            try:
                listener = self._make_audio_clip_listener(track, clip, slot_index)
                getattr(clip, "add_{}_listener".format(name))(listener)
                self._audio_clip_listeners.append((clip, name, listener))
                attached += 1
            except Exception:  # noqa: BLE001 - property/listener differs by build
                continue
        if attached == 0:
            return 0
        self._watched_clip_ids.add(key)
        self._audio_clip_prints[key] = self._audio_clip_evidence(clip)
        return 1

    def _make_audio_clip_listener(self, track, clip, slot_index):
        def _on_audio_clip():
            key = id(clip)
            edit = self._dirty_audio_clips.get(key)
            if edit is None:
                edit = {
                    "track": track,
                    "clip": clip,
                    "slot_index": slot_index,
                    "before": self._audio_clip_prints.get(key),
                }
                self._dirty_audio_clips[key] = edit
            edit["at"] = time.time()
            edit["observed_position"] = self._musical_position_context()

        return _on_audio_clip

    def _flush_settled_audio_clip_edits(self, force=False):
        if not self._dirty_audio_clips:
            return
        now = time.time()
        for key in list(self._dirty_audio_clips.keys()):
            edit = self._dirty_audio_clips[key]
            if not force and (now - edit["at"]) < NOTE_SETTLE_SEC:
                continue
            del self._dirty_audio_clips[key]
            self._emit_audio_clip_edit(key, edit)

    def _emit_audio_clip_edit(self, key, edit):
        after = self._audio_clip_evidence(edit["clip"])
        before = edit.get("before") or {}
        self._audio_clip_prints[key] = after
        changed = sorted(
            name
            for name in set(before).union(after)
            if before.get(name) != after.get(name)
            and name not in ("clip_name", "clip_id", "warp_markers_truncated")
        )
        if not changed:
            return

        changed_set = set(changed)
        if "warp_markers" in changed_set:
            event_type = "warp_markers_changed"
        elif changed_set.intersection(("warp_mode", "warp_mode_name", "warping")):
            event_type = "warp_mode_changed"
        elif "gain" in changed_set or "gain_display_string" in changed_set:
            event_type = "clip_gain_changed"
        elif changed_set.intersection(("pitch_coarse", "pitch_fine")):
            event_type = "clip_pitch_changed"
        elif changed_set.intersection(("looping", "loop_start", "loop_end")):
            event_type = "clip_loop_changed"
        elif changed_set.intersection(("start_marker", "end_marker")):
            event_type = "clip_markers_changed"
        else:
            event_type = "audio_clip_changed"

        payload = dict(after)
        payload.update(
            {
                "track_name": self._safe_name(edit["track"]),
                "track_id": self._safe_id(edit["track"]),
                "clip_slot_index": edit["slot_index"],
                "changed_fields": changed,
                "previous_clip_state": before,
            }
        )
        for name in changed:
            payload["previous_{}".format(name)] = before.get(name)
        payload.update(edit.get("observed_position", {}))
        self._emit(event_type, payload)

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

    def _make_slot_playback_listener(self, track, slot, index):
        def _on_playing_status():
            key = id(slot)
            try:
                status = int(slot.playing_status)
            except Exception:  # noqa: BLE001 - slot disappeared
                return
            previous = self._slot_playing_status.get(key, 0)
            self._slot_playing_status[key] = status
            # Live reports stopped=0, triggered=1, playing=2. One event at the
            # stopped → triggered/playing edge avoids two rows for one launch.
            if not _became_active(previous, status):
                return

            try:
                clip = slot.clip if slot.has_clip else None
            except Exception:  # noqa: BLE001
                clip = None
            self._emit(
                "clip_launched",
                {
                    "track_name": self._safe_name(track),
                    "track_id": self._safe_id(track),
                    "clip_slot_index": index,
                    "clip_name": self._safe_name(clip) if clip else None,
                    "clip_id": self._safe_id(clip) if clip else None,
                },
            )

        return _on_playing_status

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
                    "before_notes": self._clip_note_snapshots.get(key),
                }
                self._dirty_clips[key] = edit

            edit["at"] = time.time()
            # Note edits settle later; preserve the musical location of the
            # actual Live callback instead of reading a potentially moved
            # playhead when the debounce window closes.
            edit["observed_position"] = self._musical_position_context()

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
        watched = self._watch_clip(owner, clip, None, watch_audio=True)
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

    def _is_automation_being_written(self, parameter):
        """True while a parameter is being written into an automation lane.

        Live exposes a dedicated recording state in some versions. Other
        versions report the producer's write as `overridden`, so we require the
        running transport and Live's automation-record state before treating it
        as a write. Playback remains state `playing` and never enters here.
        """
        state = self._read_automation_state(parameter)
        return state == AUTOMATION_STATE_RECORDING or (
            state in (AUTOMATION_STATE_NONE, AUTOMATION_STATE_OVERRIDDEN)
            and self._automation_recording_enabled()
        )

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
        """Every readable note as a JSON-safe recreation record.

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

        # Timed because this is the one read in the script that runs on Live's
        # thread and scales with the producer's work. MAX_NOTES_READ should be
        # set from what this reports on a real dense clip, not from a guess —
        # see the note on the constants above.
        started_at = time.time()

        for read in (
            lambda: clip.get_all_notes_extended(),
            lambda: clip.get_notes_extended(0, 128, 0.0, span),
        ):
            try:
                raw = read()
                if isinstance(raw, dict):
                    raw = raw.get("notes", [])
                notes = []
                for note in list(raw)[:MAX_NOTES_READ]:
                    normalized = _normalize_midi_note(note)
                    if normalized is not None:
                        notes.append(normalized)
                self._record_note_read(started_at, len(notes))
                return notes
            except Exception:  # noqa: BLE001 - try the next API generation
                pass

        try:
            # (from_time, from_pitch, time_span, pitch_span) — different order.
            notes = []
            for note in list(clip.get_notes(0.0, 0, span, 128))[:MAX_NOTES_READ]:
                normalized = _normalize_midi_note(note)
                if normalized is not None:
                    notes.append(normalized)
            self._record_note_read(started_at, len(notes))
            return notes
        except Exception:  # noqa: BLE001
            return None

    def _record_note_read(self, started_at, note_count):
        """Keep the worst note read seen, and say so when one is slow.

        Reported rather than acted on. The point is to replace a guessed
        MAX_NOTES_READ with a measured one, and a ceiling that quietly drops a
        producer's notes is worse than one read that took 40ms.

        Guarded like every other per-tick path: measuring must never be able to
        take Live down (see the 0.20.1 rollback, commit 886856c).
        """
        try:
            elapsed_ms = (time.time() - started_at) * 1000.0
            if elapsed_ms > self._slowest_note_read_ms:
                self._slowest_note_read_ms = elapsed_ms
                self._slowest_note_read_count = note_count
            if elapsed_ms >= NOTE_READ_SLOW_MS:
                logger.info(
                    "Recall Studio: note read took {:.1f}ms for {} notes "
                    "(cap {}) — slowest so far {:.1f}ms".format(
                        elapsed_ms, note_count, MAX_NOTES_READ, self._slowest_note_read_ms
                    )
                )
        except Exception:  # noqa: BLE001
            pass

    def _fingerprint(self, clip, notes=None):
        """A comparison summary; bounded note snapshots travel separately.

        The digest decides whether a settled edit really changed anything. The
        note arrays stay out of this object so equality checks remain cheap.
        """
        if notes is None:
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

        pitches = [note["pitch"] for note in notes]
        velocities = [note["velocity"] for note in notes]
        starts = [note["start_time"] for note in notes]
        ends = [note["start_time"] + note["duration"] for note in notes]

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
            "digest": hash(
                _snapshot_fingerprint(
                    sorted(
                        notes,
                        key=lambda note: (
                            note["start_time"],
                            note["pitch"],
                            note["duration"],
                            note.get("note_id", -1),
                        ),
                    )
                )
            ),
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
        notes = self._read_notes(clip)
        after = None if notes is None else self._fingerprint(clip, notes)

        if after is None:
            # Clip deleted mid-edit; the slot listener reports that instead.
            self._clip_prints.pop(key, None)
            self._clip_note_snapshots.pop(key, None)
            return

        self._clip_prints[key] = after
        after_notes = {
            "notes": notes[:MAX_MIDI_NOTES_CAPTURED],
            "truncated": len(notes) > MAX_MIDI_NOTES_CAPTURED,
        }
        self._clip_note_snapshots[key] = after_notes

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

        payload = {
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
            # The raw before-range too, not only its label: the timeline draws
            # where the part USED to sit behind where it sits now, and a string
            # like "C1-G2" cannot be measured or positioned.
            "previous_pitch_min": (before or {}).get("pitch_min"),
            "previous_pitch_max": (before or {}).get("pitch_max"),
            "pitch_range": self._pitch_range(after),
            "previous_pitch_range": self._pitch_range(before),
            "velocity_mean": after["velocity_mean"],
            "span_beats": after["span_beats"],
            "length_beats": round(getattr(clip, "length", 0.0) or 0.0, 4),
            # One bounded phrase snapshot per settled edit. The frontend keeps
            # this inside progressive recreation detail, never one row per note.
            "midi_notes": after_notes["notes"],
            "midi_notes_truncated": after_notes["truncated"],
            "note_snapshot_version": 2,
            # Pre-rendered because the app should not have to know Live's C3 =
            # 60 octave convention to describe what happened.
            "summary": self._note_summary(kind, before_count, after, before),
        }
        before_notes = edit.get("before_notes")
        if before_notes is not None:
            payload["previous_midi_notes"] = before_notes["notes"]
            payload["previous_midi_notes_truncated"] = before_notes["truncated"]
        payload.update(edit.get("observed_position", {}))
        payload.update(self._clip_arrangement_range(clip))
        self._emit("clip_notes_changed", payload)

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
        self._flush_settled_audio_clip_edits(force=True)

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

        for slot, listener in self._slot_playback_listeners:
            try:
                if slot.playing_status_has_listener(listener):
                    slot.remove_playing_status_listener(listener)
            except Exception:  # noqa: BLE001
                pass

        for clip, name, listener in self._audio_clip_listeners:
            try:
                has = getattr(clip, "{}_has_listener".format(name))
                remove = getattr(clip, "remove_{}_listener".format(name))
                if has(listener):
                    remove(listener)
            except Exception:  # noqa: BLE001 - clip already gone
                pass

        self._clip_listeners = []
        self._slot_listeners = []
        self._slot_playback_listeners = []
        self._slot_playing_status = {}
        self._audio_clip_listeners = []
        self._audio_clip_prints = {}
        self._dirty_audio_clips = {}
        self._watched_clip_ids = set()
        # Dropped with the listeners so a stale fingerprint cannot attach to a
        # different clip that reuses the same object id.
        self._clip_prints = {}
        self._clip_note_snapshots = {}
        self._slot_names = {}
        self._arrangement_clip_roster = {}

    def _attach_to_focused_device(self, track):

        # Emit even when there is nothing to observe. A silent return here is
        # indistinguishable from a listener that never fired — which is exactly
        # the ambiguity that cost us a restart cycle a moment ago.
        if track is None or not track.devices:
            self._focused_parameter_roster = ()
            self._emit(
                "focus_changed",
                {
                    "track_name": track.name if track else None,
                    "device_name": None,
                    "parameter_count": 0,
                    # Reported on this path too, so a consumer never has to treat
                    # a missing field as "coverage unknown". A track with no
                    # devices is trivially fully covered.
                    "parameter_count_total": 0,
                    "parameters_truncated": False,
                    "truncated_devices": [],
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
        # Coverage bookkeeping. `parameter_count` is what we watch;
        # `parameter_count_total` is what the track actually publishes. When they
        # differ, the producer has controls whose moves this capture cannot see,
        # and they are entitled to know which devices those are.
        parameter_count_total = 0
        truncated_devices = []

        for device in track.devices:
            # Skip parameter-less devices and guard racks, whose parameter lists
            # can be enormous; MAX_PARAMS_PER_DEVICE keeps one Serum from
            # registering thousands of listeners in a single pass.
            available = self._parameter_count(device)
            parameter_count_total += available
            if available > MAX_PARAMS_PER_DEVICE:
                truncated_devices.append(
                    {
                        "device_name": self._safe_name(device),
                        "watched": MAX_PARAMS_PER_DEVICE,
                        "available": available,
                    }
                )
            for parameter in device.parameters[:MAX_PARAMS_PER_DEVICE]:
                # Seed the last-known value so the FIRST move reports a real
                # before-value instead of inventing one. Without this the opening
                # move of every gesture reads as "changed from nothing".
                self._last_values[id(parameter)] = parameter.value
                listener = self._make_parameter_listener(track, device, parameter)
                parameter.add_value_listener(listener)
                self._parameter_listeners.append((parameter, listener))
                self._watch_automation_state(
                    track,
                    parameter,
                    self._safe_name(device),
                    self._safe_id(device),
                    self._safe_name(parameter),
                    self._automation_parameter_listeners,
                )
                parameter_count += 1

            # Device on/off. Bypassing a plugin is a real production decision and
            # was previously invisible.
            toggle = self._make_device_toggle_listener(track, device)
            device.add_is_active_listener(toggle)
            self._device_listeners.append((device, toggle))
            self._watch_device_property(track, device, "selected_variation_index")
            self._watch_device_property(track, device, "variation_count")

        self._observed_device = track.devices[0]
        self._focused_parameter_roster = self._parameter_roster(track)

        self._emit(
            "focus_changed",
            {
                "track_name": track.name,
                "device_name": track.devices[0].name,
                "device_count": len(track.devices),
                "device_chain": [d.name for d in track.devices],
                "parameter_count": parameter_count,
                "parameter_count_total": parameter_count_total,
                "parameters_truncated": bool(truncated_devices),
                "truncated_devices": truncated_devices,
                "clip_slot_count": self._watched_clips[0],
                "midi_clips_watched": self._watched_clips[1],
            },
        )

    @staticmethod
    def _parameter_count(device):
        """How many parameters a device publishes, before any cap is applied."""
        try:
            return len(device.parameters)
        except Exception:  # noqa: BLE001 - device may be disappearing
            return 0

    def _parameter_roster(self, track):
        """Stable, bounded identities for parameters Live currently exposes."""
        if track is None:
            return ()
        roster = []
        try:
            devices = track.devices
        except Exception:  # noqa: BLE001 - track may be disappearing
            return ()
        for device in devices:
            device_id = self._safe_id(device) or self._safe_name(device) or "device"
            try:
                parameters = device.parameters[:MAX_PARAMS_PER_DEVICE]
            except Exception:  # noqa: BLE001
                parameters = []
            for index, parameter in enumerate(parameters):
                parameter_id = self._safe_id(parameter) or self._safe_name(parameter) or str(index)
                roster.append("{}:{}".format(device_id, parameter_id))
        return tuple(roster)

    def _refresh_parameter_roster_if_due(self):
        """Discover controls a plug-in publishes after the first checkpoint."""
        now = time.time()
        if (now - self._last_parameter_roster_check_at) < PARAMETER_ROSTER_CHECK_SEC:
            return
        self._last_parameter_roster_check_at = now
        track = self.song.view.selected_track
        roster = self._parameter_roster(track)
        if roster == self._focused_parameter_roster:
            return
        self._clear_parameter_listeners()
        self._attach_to_focused_device(track)
        # A newly visible control starts where Live first allowed us to see it.
        self._send_snapshot()

    def _device_roster_snapshot(self, track):
        roster = {}
        if track is None:
            return roster
        for index, device in enumerate(self._safe_list(track, "devices")):
            key = self._safe_id(device) or "object-{}".format(id(device))
            item = {
                "track_name": self._safe_name(track),
                "track_id": self._safe_id(track),
                "device_id": self._safe_id(device),
                "device_name": self._safe_name(device),
                "device_index": index,
            }
            for name in ("class_name", "class_display_name", "type"):
                try:
                    item[name] = getattr(device, name)
                except Exception:  # noqa: BLE001
                    pass
            roster[key] = item
        return roster

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
            # The event explains when; the checkpoint preserves the resulting
            # device state for rebuilds and for tracks with no parameter moves.
            self._send_snapshot()

        return _on_toggle

    def _watch_device_property(self, track, device, name):
        key = (id(device), name)
        try:
            self._device_property_values[key] = getattr(device, name)
            listener = self._make_device_property_listener(track, device, name, key)
            getattr(device, "add_{}_listener".format(name))(listener)
            self._device_property_listeners.append((device, name, listener))
        except Exception:  # noqa: BLE001 - only racks expose variation state
            self._device_property_values.pop(key, None)

    def _make_device_property_listener(self, track, device, name, key):
        def _on_property():
            try:
                current = getattr(device, name)
            except Exception:  # noqa: BLE001
                return
            previous = self._device_property_values.get(key)
            self._device_property_values[key] = current
            if previous == current:
                return
            if name == "selected_variation_index":
                event_type = "rack_variation_recalled"
            else:
                try:
                    grew = previous is not None and int(current) > int(previous)
                except Exception:  # noqa: BLE001 - unexpected host value shape
                    grew = False
                event_type = "rack_variation_stored" if grew else "rack_variation_deleted"
            self._emit(
                event_type,
                {
                    "track_name": self._safe_name(track),
                    "track_id": self._safe_id(track),
                    "device_name": self._safe_name(device),
                    name: current,
                    "previous_{}".format(name): previous,
                },
            )
            self._send_snapshot()

        return _on_property

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
            self._safe_id(device),
            self._safe_name(parameter),
        )

    def _make_value_listener(
        self,
        track,
        parameter,
        event_type,
        device_name,
        device_id,
        parameter_name,
        settles_with_mixer=False,
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
            key = id(parameter)

            # The channel strip arriving from a set load. Keep the seed current
            # so the producer's first real move reports a true "before", and
            # emit nothing. Checked before _moves_seen so the counter stays a
            # count of real moves.
            if settles_with_mixer and self._is_mixer_settling():
                try:
                    self._last_values[key] = parameter.value
                except Exception:  # noqa: BLE001 - channel gone mid-load
                    pass
                return

            just_changed_automation = (
                time.time() - self._automation_recently_changed.get(key, 0.0)
            ) < GESTURE_SETTLE_SEC
            if self._is_automation_being_written(parameter):
                self._record_automation_value(
                    track, parameter, device_name, device_id, parameter_name
                )
                return

            if self._is_automation_playback(parameter) or just_changed_automation:
                # Still track where automation left the value. Skipping this
                # would leave _last_values holding a pre-playback reading, so
                # the next time the producer grabs the control the move would
                # report a "before" from before the automation ran — e.g.
                # "0.2 -> 0.5" for a knob automation had already carried to 0.8.
                try:
                    self._last_values[key] = parameter.value
                except Exception:  # noqa: BLE001 - device gone mid-playback
                    pass
                return

            self._moves_seen += 1

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
                    "device_id": device_id,
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
            # The event is emitted only after the gesture settles. Preserve the
            # position of its final real movement, not the later debounce tick.
            gesture["observed_position"] = self._musical_position_context()

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
        try:
            self._refresh_parameter_roster_if_due()
        except Exception as error:  # noqa: BLE001 - discovery must not stop Live
            logger.info("Recall Studio: parameter roster refresh failed: {}".format(error))
        try:
            self._refresh_arrangement_clips_if_due()
        except Exception as error:  # noqa: BLE001 - discovery must not stop Live
            logger.info("Recall Studio: arrangement roster refresh failed: {}".format(error))
        if self._reconcile_snapshot_pending:
            self._reconcile_snapshot_pending = False
            try:
                self._send_snapshot()
            except Exception as error:  # noqa: BLE001 - checkpoint must not stop Live
                logger.info("Recall Studio: checkpoint reconciliation failed: {}".format(error))
        self._flush_settled_gestures()
        self._flush_settled_note_edits()
        self._flush_settled_audio_clip_edits()
        self._flush_settled_thaws()
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
        self._observe_project_file_save()
        # project_path rides the heartbeat because the app reads it in
        # update_open_file, which runs BEFORE heartbeats are dropped from the
        # pipeline — and because a heartbeat fires every 2s regardless of what
        # the producer is doing. That makes opening a different set get noticed
        # within seconds, rather than whenever the next real event happens to
        # arrive (which, on a set the producer is only listening to, is never).
        self._emit(
            "heartbeat",
            {
                "bridge_version": SCRIPT_VERSION,
                "project_path": self._open_set_path(),
                # Rides the heartbeat so the measurement reaches the app rather
                # than living only in Live's log file. It is what MAX_NOTES_READ
                # should be sized from, and a number nobody can read is a number
                # nobody will use.
                "slowest_note_read_ms": round(self._slowest_note_read_ms, 1),
                "slowest_note_read_count": self._slowest_note_read_count,
            },
        )

    def _observe_project_file_save(self):
        """Emit a factual save signal when the open .als file changes on disk.

        Live exposes no save callback. The file's modification stamp is the
        durable evidence available to the control surface; opening a different
        path only establishes a new baseline and never masquerades as a save.
        """
        path = self._open_set_path()
        if not path:
            self._project_file_path = None
            self._project_file_stamp = None
            return
        try:
            stat = os.stat(path)
            stamp = (getattr(stat, "st_mtime_ns", int(stat.st_mtime * 1000000000)), stat.st_size)
        except Exception:  # noqa: BLE001 - path may be transient during Save As
            return

        if path != self._project_file_path:
            self._project_file_path = path
            self._project_file_stamp = stamp
            return
        previous = self._project_file_stamp
        self._project_file_stamp = stamp
        if previous is None or previous == stamp:
            return
        self._emit(
            "project_saved",
            {
                "project_path": path,
                "project_name": self._safe_name(self.song),
                "set_name": self._safe_name(self.song),
                "file_modified_ns": stamp[0],
                "file_size": stamp[1],
                "save_detection": "als_file_modified",
            },
        )

    def _flush_settled_gestures(self, force=False):
        self._flush_settled_automation_writes(force)
        if not self._gestures:
            return

        now = time.time()

        for key in list(self._gestures.keys()):
            gesture = self._gestures[key]

            if not force and (now - gesture["at"]) < GESTURE_SETTLE_SEC:
                continue

            del self._gestures[key]
            self._emit_settled(key, gesture)

    def _flush_settled_automation_writes(self, force=False):
        if not self._automation_writes:
            return

        now = time.time()
        for key in list(self._automation_writes.keys()):
            write = self._automation_writes[key]
            last_value_at = write["last_value_at"]
            if last_value_at is None:
                if force:
                    self._automation_writes.pop(key, None)
                continue
            if not force and (now - last_value_at) < GESTURE_SETTLE_SEC:
                continue
            self._finish_automation_write(
                write["parameter"],
                self._read_automation_state(write["parameter"]),
            )

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

        payload = {
            # Track identity, without which the app cannot attribute a move to
            # a lane — the timeline read "37 moves, 0 tracks touched" while
            # every lane sat empty.
            "track_name": track_name,
            "track_id": track_id,
            "device_name": device_name,
            "device_id": gesture["device_id"],
            "parameter_name": parameter_name,
            "parameter_value": landed,
            "previous_parameter_value": start,
            "parameter_value_percent": self._percent(parameter, landed),
            "previous_parameter_value_percent": self._percent(parameter, start),
            # Human-readable, unit-bearing values as the device displays them.
            "parameter_display_value": self._display(parameter, landed),
            "previous_parameter_display_value": self._display(parameter, start),
            "parameter_is_quantized": bool(getattr(parameter, "is_quantized", False)),
            # How far the knob travelled on the way, which is not recoverable
            # from before/after alone: sweeping to the top and settling back
            # near the start is a different act from nudging it slightly.
            "parameter_value_min": gesture["min"],
            "parameter_value_max": gesture["max"],
        }
        payload.update(gesture.get("observed_position", {}))
        self._emit(gesture["event_type"], payload)

    def _clear_parameter_listeners(self):
        # Close any in-flight gesture BEFORE dropping its listeners. Switching
        # tracks mid-ride would otherwise discard the move entirely — and the
        # tweak you make right before clicking away is exactly the one worth
        # remembering.
        self._flush_settled_gestures(force=True)

        for parameter, listener in self._automation_parameter_listeners:
            try:
                if parameter.automation_state_has_listener(listener):
                    parameter.remove_automation_state_listener(listener)
            except Exception:  # noqa: BLE001 - device may already be gone
                pass
            self._automation_states.pop(id(parameter), None)
            self._automation_writes.pop(id(parameter), None)
            self._automation_recently_changed.pop(id(parameter), None)

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
        for device, name, listener in self._device_property_listeners:
            try:
                has = getattr(device, "{}_has_listener".format(name))
                remove = getattr(device, "remove_{}_listener".format(name))
                if has(listener):
                    remove(listener)
            except Exception:  # noqa: BLE001 - rack may already be gone
                pass

        self._parameter_listeners = []
        self._device_listeners = []
        self._device_property_listeners = []
        self._device_property_values = {}
        self._automation_parameter_listeners = []
        self._observed_device = None
        self._focused_parameter_roster = ()

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
            self._clear_track_structure_listeners()
            self._track_structure = {}
            self._clear_scene_listeners()
            self._clear_cue_point_listeners()
            self._clear_song_context_listeners()
            self._clear_mixer_listeners()
            self._clear_parameter_listeners()
            self._clear_devices_listener()
            self._clear_clip_listeners()
            self._send_snapshot()
            self._reconcile_snapshot_pending = True
            self._on_selection_changed()
            self._attach_track_structure_listeners()
            self._track_structure = self._track_structure_snapshot()
            self._attach_scene_listeners()
            self._attach_cue_point_listeners()
            self._attach_song_context_listeners()
            self._attach_mixer_listeners()

    # ── teardown ───────────────────────────────────────────────────────────

    def disconnect(self):
        # Live calls this on script unload and on quit. Leaking listeners here is
        # how a remote script starts crashing Live on set changes, so it has to
        # be exhaustive even in a spike.
        self._clear_track_structure_listeners()
        self._clear_scene_listeners()
        self._clear_cue_point_listeners()
        self._clear_song_context_listeners()
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
            if (
                self._scenes_listener_attached
                and self.song.scenes_has_listener(self._on_scenes_changed)
            ):
                self.song.remove_scenes_listener(self._on_scenes_changed)
            if (
                self._return_tracks_listener_attached
                and self.song.return_tracks_has_listener(self._on_tracks_changed)
            ):
                self.song.remove_return_tracks_listener(self._on_tracks_changed)
            if self.song.view.detail_clip_has_listener(self._on_detail_clip_changed):
                self.song.view.remove_detail_clip_listener(self._on_detail_clip_changed)
        except Exception:  # noqa: BLE001
            pass

        # Flush before the final event, so a move made seconds before quitting
        # still lands.
        self._flush_settled_gestures(force=True)
        self._emit(
            "bridge_stopped",
            {
                "moves_seen": self._moves_seen,
                "note_edits_seen": self._note_edits_seen,
                "automation_edits_seen": self._automation_edits_seen,
            },
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
