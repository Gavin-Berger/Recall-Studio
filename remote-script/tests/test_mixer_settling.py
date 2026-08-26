"""The channel strip arriving from a set load is not the producer playing it.

Live drives every track's volume, pan and routing to the loaded set's values
AFTER the listeners attach, so those callbacks are genuine Live callbacks — they
are just not authorship. Measured on a real library: 103 mixer events inside one
second at session start, 58 more in a single second at +7s and again at +44s
when tracks changed, and nothing but heartbeats in between.

These tests pin the suppression AND its limits: device parameters must keep
firing through a mixer rebuild, seeds must stay current so the first real move
reports a true "before", and everything must resume once the strip has settled.
"""

import time

from Recall import CASCADE_THRESHOLD, MIXER_SETTLE_SEC, Recall


class Parameter:
    min = 0.0
    max = 1.0

    def __init__(self, value):
        self.value = value

    def str_for_value(self, value):
        return "{:.2f}".format(value)


class Track:
    def __init__(self, name="Drums"):
        self.name = name


class Harness(Recall):
    """A Recall with the Live plumbing removed and emissions captured."""

    def __init__(self):  # noqa: D107 - deliberately skips Recall.__init__
        self.emitted = []
        self._last_values = {}
        self._gestures = {}
        self._mixer_property_values = {}
        self._routing_values = {}
        self._automation_recently_changed = {}
        self._automation_playing_state = None
        self._moves_seen = 0
        self._mixer_settling_until = 0.0
        self._cascade_runs = {}

    def _emit(self, event_type, payload):
        self.emitted.append((event_type, payload))

    def _safe_name(self, obj):
        return getattr(obj, "name", None)

    def _safe_id(self, obj):
        return None

    def _is_automation_being_written(self, parameter):
        return False

    def _is_automation_playback(self, parameter):
        return False

    def _record_automation_value(self, *args, **kwargs):
        return None

    def _watch_automation_state(self, *args, **kwargs):
        return None


def settling_harness():
    harness = Harness()
    harness._mixer_settling_until = time.time() + MIXER_SETTLE_SEC
    return harness


def test_settling_window_is_armed_and_expires():
    harness = Harness()
    assert not harness._is_mixer_settling()
    harness._mixer_settling_until = time.time() + MIXER_SETTLE_SEC
    assert harness._is_mixer_settling()
    harness._mixer_settling_until = time.time() - 0.01
    assert not harness._is_mixer_settling()


def test_mixer_property_is_silent_while_the_strip_arrives():
    harness = settling_harness()
    track = Track()
    mixer = object()
    key = (id(mixer), "output_routing")

    listener = harness._make_mixer_property_listener(
        track, _Holder("output_routing", "Master"), "output_routing",
        "track_routing_changed", key,
    )
    harness._mixer_property_values[key] = "Ext. Out"
    listener()

    assert harness.emitted == []
    # The seed still moved, or the first real change would report a stale
    # "before" taken from before the set loaded.
    assert harness._mixer_property_values[key] == "Master"


def test_mixer_property_emits_once_settled():
    harness = Harness()
    track = Track()
    key = (id(object()), "output_routing")

    listener = harness._make_mixer_property_listener(
        track, _Holder("output_routing", "Master"), "output_routing",
        "track_routing_changed", key,
    )
    harness._mixer_property_values[key] = "Ext. Out"
    listener()

    assert [event for event, _ in harness.emitted] == ["track_routing_changed"]


def test_volume_is_silent_while_the_strip_arrives():
    harness = settling_harness()
    parameter = Parameter(0.5)

    listener = harness._make_value_listener(
        Track(), parameter, "volume_changed", "Mixer", None, "Volume",
        settles_with_mixer=True,
    )
    harness._last_values[id(parameter)] = 0.2
    parameter.value = 0.85
    listener()

    assert harness.emitted == []
    # Seed follows the arriving value.
    assert harness._last_values[id(parameter)] == 0.85
    # And it does not count as a move the producer made.
    assert harness._moves_seen == 0


def test_a_device_parameter_still_fires_during_a_mixer_rebuild():
    # A mixer rebuild must never silence a plugin the producer is turning.
    # This is the whole reason the flag travels into the closure instead of
    # being read off the settling window alone.
    harness = settling_harness()
    parameter = Parameter(0.5)

    listener = harness._make_value_listener(
        Track(), parameter, "parameter_changed", "Serum", "d1", "Cutoff",
        settles_with_mixer=False,
    )
    harness._last_values[id(parameter)] = 0.2
    parameter.value = 0.85
    listener()

    assert harness._moves_seen == 1


def test_routing_listener_records_but_stays_quiet_while_settling():
    harness = settling_harness()
    track = Track()
    key = "track-1"

    harness._routing_snapshot = lambda _track: {"output_routing": "Master"}
    harness._track_listener_key = lambda _track: key
    harness._routing_values[key] = {"output_routing": "Ext. Out"}

    listener = harness._make_routing_listener(track, key)
    listener()

    assert harness.emitted == []
    assert harness._routing_values[key] == {"output_routing": "Master"}


def test_routing_listener_emits_once_settled():
    harness = Harness()
    track = Track()
    key = "track-1"

    harness._routing_snapshot = lambda _track: {"output_routing": "Master"}
    harness._routing_values[key] = {"output_routing": "Ext. Out"}

    listener = harness._make_routing_listener(track, key)
    listener()

    assert [event for event, _ in harness.emitted] == ["track_routing_changed"]


def test_an_unchanged_value_never_emits_settling_or_not():
    harness = Harness()
    key = (id(object()), "output_routing")
    listener = harness._make_mixer_property_listener(
        Track(), _Holder("output_routing", "Master"), "output_routing",
        "track_routing_changed", key,
    )
    harness._mixer_property_values[key] = "Master"
    listener()
    assert harness.emitted == []


class _Holder:
    """Stands in for a mixer device exposing one property."""

    def __init__(self, name, value):
        setattr(self, name, value)


def test_a_cascade_across_every_track_is_suppressed_after_the_threshold():
    # The real case: 58 track_routing_changed inside ten milliseconds, with no
    # listener rebuild in front of them. One Live operation, not 58 decisions.
    harness = Harness()
    harness._routing_snapshot = lambda _track: {"output_routing": "Master"}

    for index in range(20):
        key = "track-{}".format(index)
        harness._routing_values[key] = {"output_routing": "Ext. Out"}
        harness._make_routing_listener(Track(), key)()

    emitted = [event for event, _ in harness.emitted]
    assert len(emitted) == CASCADE_THRESHOLD
    assert set(emitted) == {"track_routing_changed"}


def test_a_quiet_gap_resets_the_run_so_ordinary_work_is_never_starved():
    harness = Harness()
    harness._routing_snapshot = lambda _track: {"output_routing": "Master"}

    for index in range(CASCADE_THRESHOLD + 4):
        key = "track-{}".format(index)
        harness._routing_values[key] = {"output_routing": "Ext. Out"}
        harness._make_routing_listener(Track(), key)()
    suppressed = len(harness.emitted)

    # A quarter-second of quiet, then the producer does something real.
    harness._cascade_runs.clear()
    harness._routing_values["later"] = {"output_routing": "Ext. Out"}
    harness._make_routing_listener(Track(), "later")()

    assert len(harness.emitted) == suppressed + 1


def test_the_cascade_run_is_per_family():
    # A routing fan-out must not silence a volume move that happens alongside.
    harness = Harness()
    for _ in range(CASCADE_THRESHOLD + 3):
        assert harness._is_cascade("track_routing_changed") in (True, False)
    assert harness._is_cascade("track_routing_changed") is True
    assert harness._is_cascade("volume_changed") is False
