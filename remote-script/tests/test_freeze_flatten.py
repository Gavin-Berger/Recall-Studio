"""Freezing, unfreezing and flattening are three different decisions.

Only freezing was ever reported. Unfreezing was silent, so the record could show
a producer freezing a track and never show them undoing it, and `track_flattened`
sat in the app's event catalog with nothing emitting it.

Flatten is the one that matters most: it is where an instrument stops being an
instrument and becomes a waveform. It cannot be undone, and it is exactly the
decision a producer goes looking for months later.

Both unfreeze and flatten arrive from Live as the same transition — `is_frozen`
goes True -> False — and nothing in the LOM says which happened. These tests pin
the only thing that separates them: what the track is made of afterwards.
"""

import time

from Recall import THAW_SETTLE_SEC, Recall


class Clip:
    def __init__(self, is_midi):
        self.is_midi_clip = is_midi


class Slot:
    def __init__(self, clip=None):
        self.clip = clip
        self.has_clip = clip is not None


class Track:
    def __init__(self, name="Bass", devices=(), clips=()):
        self.name = name
        self.devices = list(devices)
        self.clip_slots = [Slot(clip) for clip in clips]
        self.arrangement_clips = []
        self.is_frozen = False


class Harness(Recall):
    """A Recall with the Live plumbing removed and emissions captured."""

    def __init__(self):  # noqa: D107 - deliberately skips Recall.__init__
        self.emitted = []
        self._track_state_values = {}
        self._frozen_shapes = {}
        self._pending_thaws = {}
        self.snapshots = 0

    def _emit(self, event_type, payload):
        self.emitted.append((event_type, payload))

    def _send_snapshot(self):
        self.snapshots += 1

    def _safe_name(self, obj):
        return getattr(obj, "name", None)

    def _safe_id(self, obj):
        return str(id(obj))

    def _safe_list(self, obj, attribute):
        return list(getattr(obj, attribute, []) or [])

    def _track_listener_key(self, track):
        return id(track)

    def types(self):
        return [event_type for event_type, _ in self.emitted]


def freeze(harness, track):
    listener = harness._make_track_state_listener(track, harness._track_listener_key(track))
    track.is_frozen = True
    listener()
    return listener


def thaw(harness, track, listener):
    track.is_frozen = False
    listener()
    # The verdict is deliberately deferred a tick, so nothing has been said yet.
    harness._pending_thaws[harness._track_listener_key(track)]["at"] -= THAW_SETTLE_SEC + 0.1
    harness._flush_settled_thaws()


def test_freezing_is_reported_with_the_track():
    harness = Harness()
    track = Track(devices=["Serum"], clips=[Clip(is_midi=True)])

    freeze(harness, track)

    assert harness.types() == ["track_frozen"]
    assert harness.emitted[0][1]["track_name"] == "Bass"


def test_unfreezing_is_no_longer_silent():
    # A producer who freezes and then unfreezes made two decisions. Reporting
    # only the first leaves the record claiming the track is still frozen.
    harness = Harness()
    track = Track(devices=["Serum"], clips=[Clip(is_midi=True)])
    listener = freeze(harness, track)

    thaw(harness, track, listener)

    assert harness.types() == ["track_frozen", "track_unfrozen"]
    assert harness.emitted[1][1]["thaw_evidence"] == "chain_restored"


def test_flattening_is_told_apart_by_what_is_left_behind():
    # Unfreeze restores what freezing hid. Flatten keeps neither the instrument
    # nor the MIDI — that absence is the whole signal.
    harness = Harness()
    track = Track(devices=["Serum"], clips=[Clip(is_midi=True)])
    listener = freeze(harness, track)

    track.devices = []
    track.clip_slots = [Slot(Clip(is_midi=False))]

    thaw(harness, track, listener)

    assert harness.types() == ["track_frozen", "track_flattened"]
    payload = harness.emitted[1][1]
    assert payload["thaw_evidence"] == "devices_and_midi_gone"
    assert payload["devices_before"] == 1
    assert payload["devices_after"] == 0
    assert payload["audio_clips_after"] == 1


def test_a_thaw_with_no_baseline_claims_only_that_it_thawed():
    # The track was already frozen when Recall attached, so there is nothing to
    # compare against. Guessing "flattened" here would be a confident invention.
    harness = Harness()
    track = Track(devices=[], clips=[Clip(is_midi=False)])
    key = harness._track_listener_key(track)
    harness._track_state_values[key] = True
    listener = harness._make_track_state_listener(track, key)

    thaw(harness, track, listener)

    assert harness.types() == ["track_unfrozen"]
    assert harness.emitted[0][1]["thaw_evidence"] == "no_frozen_baseline"


def test_the_verdict_waits_for_live_to_finish_rebuilding_the_track():
    # Reading the chain inside the callback reports whatever half-state the
    # operation is passing through, which is how an unfreeze gets mistaken for a
    # flatten. Nothing may be emitted until the track has settled.
    harness = Harness()
    track = Track(devices=["Serum"], clips=[Clip(is_midi=True)])
    listener = freeze(harness, track)

    track.is_frozen = False
    listener()
    harness._flush_settled_thaws()

    assert harness.types() == ["track_frozen"], "the thaw must not be judged immediately"

    harness._pending_thaws[harness._track_listener_key(track)]["at"] -= THAW_SETTLE_SEC + 0.1
    harness._flush_settled_thaws()

    assert harness.types() == ["track_frozen", "track_unfrozen"]


def test_freezing_twice_reports_once():
    # Live can fire the listener again without the state changing.
    harness = Harness()
    track = Track(devices=["Serum"], clips=[Clip(is_midi=True)])
    listener = freeze(harness, track)

    listener()

    assert harness.types() == ["track_frozen"]


def test_a_deleted_track_does_not_take_the_tick_down():
    # _flush_settled_thaws runs on Live's own thread every ~100ms. An unhandled
    # exception in a per-tick callback is the failure class behind the 0.20.1
    # rollback, so a vanished track has to be survivable.
    harness = Harness()
    track = Track(devices=["Serum"], clips=[Clip(is_midi=True)])
    listener = freeze(harness, track)

    track.is_frozen = False
    listener()

    class Gone:
        @property
        def devices(self):
            raise RuntimeError("track was deleted")

    key = harness._track_listener_key(track)
    harness._pending_thaws[key]["track"] = Gone()
    harness._pending_thaws[key]["at"] = time.time() - THAW_SETTLE_SEC - 0.1

    harness._flush_settled_thaws()

    assert harness.types() == ["track_frozen"]
    assert harness._pending_thaws == {}
