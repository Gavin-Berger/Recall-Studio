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


def test_a_fan_out_after_the_settle_window_is_not_forty_decisions():
    """Measured on the live library: 39 volume moves and 9 pans inside a SINGLE
    millisecond, past the settle window, every one stamped with the same clock
    time in the Timeline. Nobody rides forty faders in one millisecond.

    The settle window only covers the set arriving right after a listener
    rebuild. `_is_cascade` is the guard for a fan-out that lands later, and it
    was wired to routing and to mixer properties but never to volume, pan or
    sends — which is the hole this closes.
    """
    harness = settling_harness()
    harness._mixer_settling_until = 0.0  # the window is long closed

    for index in range(12):
        parameter = Parameter(0.5)
        listener = harness._make_value_listener(
            Track("Track {}".format(index)),
            parameter,
            "volume_changed",
            "Mixer",
            "mixer-{}".format(index),
            "Volume",
            settles_with_mixer=True,
        )
        harness._last_values[id(parameter)] = 0.5
        parameter.value = 0.25
        listener()

    assert harness._moves_seen <= CASCADE_THRESHOLD + 1, (
        "a fan-out across every channel is one Live operation, not twelve "
        "producer decisions"
    )


def test_riding_one_fader_reports_where_it_landed():
    """THE REGRESSION THIS PINS. The fan-out guard first counted CALLBACKS, and
    a producer dragging one fader fires the value listener continuously — so it
    fell silent after six of them and emitted a value the fader never held.
    Measured before the fix: a ride from 0.0 to 0.95 emitted "0.0 -> 0.25".

    A fan-out is many DIFFERENT controls at once. One control moved two hundred
    times is a gesture, and the whole point of the gesture system is reporting
    where it landed.
    """
    import time as _time

    harness = settling_harness()
    harness._mixer_settling_until = 0.0
    harness._automation_writes = {}

    parameter = Parameter(0.0)
    listener = harness._make_value_listener(
        Track("Bass"), parameter, "volume_changed", "Mixer", "m1", "Volume",
        settles_with_mixer=True,
    )
    harness._last_values[id(parameter)] = 0.0

    for step in range(20):
        parameter.value = round(step * 0.05, 2)
        listener()
        _time.sleep(0.004)
    harness._flush_settled_gestures(force=True)

    landed = [
        payload.get("parameter_value")
        for event_type, payload in harness.emitted
        if event_type == "volume_changed"
    ]
    assert landed, "a continuous ride must not be silenced as a fan-out"
    assert landed[-1] == parameter.value, (
        "the emitted value must be where the fader landed, not where the guard "
        "stopped watching"
    )


def test_a_producer_riding_one_fader_is_still_a_real_move():
    """The guard must not silence real work. One channel moved is a gesture,
    not a fan-out: the cascade counter tracks a run of emissions across the
    family, and one move never reaches the threshold.
    """
    harness = settling_harness()
    harness._mixer_settling_until = 0.0

    parameter = Parameter(0.5)
    listener = harness._make_value_listener(
        Track("Bass"), parameter, "volume_changed", "Mixer", "mixer-bass", "Volume",
        settles_with_mixer=True,
    )
    harness._last_values[id(parameter)] = 0.2
    parameter.value = 0.7
    listener()

    assert harness._moves_seen == 1


def test_the_set_loading_is_not_a_groove_change():
    """Every one of the 29 `groove_changed` events in a real library is the
    identical 1.0 -> 0.0, none of them anything else, all within seconds of the
    bridge attaching. Live reports groove_amount as 1.0 when the context
    listeners attach and settles it to the set's real value a moment later.

    Same shape as the channel strip arriving on load, and song properties had no
    settle window at all.
    """
    recall = Recall.__new__(Recall)
    recall.emitted = []
    recall._emit = lambda event_type, payload: recall.emitted.append((event_type, payload))
    recall._recording_active = False
    recall._song_context = {"groove_amount": 1.0}
    recall._song_context_settling_until = time.time() + 5.0
    recall._song_context_snapshot = lambda: {"groove_amount": 0.0}

    recall._on_song_context_changed()

    assert recall.emitted == [], "the set arriving is not a producer decision"
    assert recall._song_context["groove_amount"] == 0.0, "the seed still tracks the real value"


def test_a_real_groove_change_after_the_set_settles_is_reported():
    """The guard must not silence real work — only the load."""
    recall = Recall.__new__(Recall)
    recall.emitted = []
    recall._emit = lambda event_type, payload: recall.emitted.append((event_type, payload))
    recall._recording_active = False
    recall._song_context = {"groove_amount": 0.0}
    recall._song_context_settling_until = 0.0  # long settled
    recall._song_context_snapshot = lambda: {"groove_amount": 0.5}

    recall._on_song_context_changed()

    assert [event_type for event_type, _ in recall.emitted] == ["groove_changed"]
    assert recall.emitted[0][1]["groove_amount"] == 0.5
    assert recall.emitted[0][1]["previous_groove_amount"] == 0.0
