from Recall import (
    AUTOMATION_STATE_NONE,
    AUTOMATION_STATE_PLAYING,
    AUTOMATION_STATE_RECORDING,
    Recall,
    _automation_event_type,
    _automation_position_label,
    _became_active,
    _is_automatic_track_number_adjustment,
    _track_structure_events,
)


class Parameter:
    min = 0.0
    max = 1.0

    def __init__(self, value):
        self.value = value

    def str_for_value(self, value):
        return "{:.2f}".format(value)


def test_first_automation_lane_is_created():
    assert (
        _automation_event_type(AUTOMATION_STATE_NONE, AUTOMATION_STATE_PLAYING)
        == "automation_created"
    )


def test_writing_an_existing_lane_is_an_edit():
    assert (
        _automation_event_type(AUTOMATION_STATE_PLAYING, AUTOMATION_STATE_RECORDING)
        == "automation_edited"
    )


def test_playback_and_cleanup_are_not_timeline_events():
    assert _automation_event_type(AUTOMATION_STATE_PLAYING, AUTOMATION_STATE_PLAYING) is None
    assert _automation_event_type(AUTOMATION_STATE_PLAYING, AUTOMATION_STATE_NONE) is None


def test_automation_position_uses_lives_bars_and_beats_without_math():
    class BeatsSongTime:
        bars = 41
        beats = 1
        sub_division = 1

    assert _automation_position_label(BeatsSongTime()) == "Bar 41 · Beat 1"


def track(track_id, name, *, index=0, group_id=None, group_name=None, track_type="audio"):
    return {
        "track_id": track_id,
        "track_name": name,
        "track_type": track_type,
        "track_index": index,
        "index": index,
        "group_track_id": group_id,
        "group_track_name": group_name,
        "is_group": False,
    }


def test_track_structure_delta_names_create_rename_and_grouping():
    old = {"1": track("1", "Lead"), "2": track("2", "Bass", index=1)}
    new = {
        "1": track("1", "Lead Vox", group_id="3", group_name="Vocals"),
        "3": track("3", "Vocals", index=1),
    }

    events = _track_structure_events(old, new)
    by_type = {event_type: payload for event_type, payload in events}

    assert by_type["track_created"]["track_name"] == "Vocals"
    assert by_type["track_deleted"]["track_name"] == "Bass"
    assert by_type["track_name_changed"]["previous_track_name"] == "Lead"
    assert by_type["tracks_grouped"]["group_track_name"] == "Vocals"


def test_track_number_adjustments_following_a_structure_shift_are_silent():
    old = {"1": track("1", "10-Serum 2", index=9)}
    new = {"1": track("1", "11-Serum 2", index=10)}

    assert _is_automatic_track_number_adjustment(
        "10-Serum 2", "11-Serum 2", 9, 10
    )
    assert _track_structure_events(old, new) == []


def test_real_track_renames_and_numbered_sound_names_remain_visible():
    assert not _is_automatic_track_number_adjustment(
        "10-Serum 2", "11-Bass Hook", 9, 10
    )
    assert not _is_automatic_track_number_adjustment(
        "808 Bass", "909 Bass", 4, 4
    )


def test_session_performance_only_fires_at_the_idle_to_active_edge():
    assert _became_active(0, 1)
    assert _became_active(False, True)
    assert not _became_active(1, 2)
    assert not _became_active(2, 0)


def test_automation_write_keeps_real_callback_points_for_recreation():
    recall = Recall.__new__(Recall)
    parameter = Parameter(0.25)
    track_obj = type("Track", (), {"name": "Bass", "_live_ptr": 12})()
    recall.song = type("Song", (), {"current_song_time": 160.0})()
    recall._last_values = {id(parameter): 0.1}
    recall._automation_states = {id(parameter): AUTOMATION_STATE_PLAYING}
    recall._automation_writes = {}
    recall._automation_recently_changed = {}
    recall._automation_edits_seen = 0
    recall._musical_position_context = lambda: {
        "observed_arrangement_beats": recall.song.current_song_time
    }
    recall._automation_position = lambda: "Bar 41 Â· Beat 1"
    emitted = []
    recall._emit = lambda event_type, payload: emitted.append((event_type, payload))

    # The device pointer rides with every write. Two Auto Filters on one track
    # are a routine chain, and without the id their lanes merge into one.
    recall._start_automation_write(
        track_obj, parameter, "Auto Filter", "dev-7", "Frequency", AUTOMATION_STATE_PLAYING
    )
    recall._record_automation_value(track_obj, parameter, "Auto Filter", "dev-7", "Frequency")
    recall.song.current_song_time = 164.0
    parameter.value = 0.8
    recall._record_automation_value(track_obj, parameter, "Auto Filter", "dev-7", "Frequency")
    recall._finish_automation_write(parameter, AUTOMATION_STATE_PLAYING)

    event_type, payload = emitted[0]
    assert event_type == "automation_edited"
    assert [point["beat"] for point in payload["automation_points"]] == [160.0, 164.0]
    assert [point["value"] for point in payload["automation_points"]] == [0.25, 0.8]
    assert payload["automation_capture_method"] == "write_callbacks"
    assert payload["device_id"] == "dev-7"


def test_a_renumber_survives_the_index_lookup_failing():
    """318 of 386 captured renames in the live library changed only the leading
    number — "14-MIDI" to "3-MIDI" — and were emitted as producer renames.

    The caller leaves `current_index` at its old value whenever it cannot
    re-find the track, which is exactly the moment Live renumbers: a lane above
    was removed or moved. Requiring both indices to line up meant the guard was
    off precisely when it was needed.
    """
    assert _is_automatic_track_number_adjustment("14-MIDI", "3-MIDI", 13, 13)


def test_a_number_that_is_part_of_the_sound_is_not_a_position():
    """"808 Bass" sitting fifth is a sound with a number in its name, not Live's
    numbering. Renaming it to "909 Bass" is a producer decision.

    This is why the OLD position is the evidence: if the old prefix did not match
    the old position, the prefix was never positional.
    """
    assert not _is_automatic_track_number_adjustment("808 Bass", "909 Bass", 4, 4)


def test_the_lane_key_is_stable_across_listener_rebuilds():
    """Keyed on `id(parameter)` this was silently wrong: id() is unique only
    among LIVE objects, and parameters are released whenever listeners are
    rebuilt on a track change. A recycled address made a genuine first lane on a
    different control read as an edit, losing the creation permanently.

    The key is the same (track, device, parameter) identity the projection uses.
    """
    recall = Recall.__new__(Recall)
    recall._automation_lanes_created = set()

    bass_cutoff = ("track-bass", "dev-serum", "Cutoff")
    lead_cutoff = ("track-lead", "dev-serum", "Cutoff")

    assert recall._automation_event_type_for(bass_cutoff, "automation_created") == "automation_created"
    # A different track's identically named control is a different lane.
    assert recall._automation_event_type_for(lead_cutoff, "automation_created") == "automation_created"
    # And the first one still cannot be created twice.
    assert recall._automation_event_type_for(bass_cutoff, "automation_created") == "automation_edited"


def test_a_lane_is_only_created_once():
    """One control in the live library reported "created" 51 times. A lane
    cannot be created 51 times.

    Live's `automation_state` is not reliable on every parameter — plugin
    parameters can keep reading NONE between writes — and when it does, every
    write reads as a brand-new lane. The state proposes; this disposes.
    """
    recall = Recall.__new__(Recall)
    recall._automation_lanes_created = set()

    key = 1234
    assert recall._automation_event_type_for(key, "automation_created") == "automation_created"
    assert recall._automation_event_type_for(key, "automation_created") == "automation_edited"
    assert recall._automation_event_type_for(key, "automation_created") == "automation_edited"


def test_two_different_controls_each_get_their_own_creation():
    recall = Recall.__new__(Recall)
    recall._automation_lanes_created = set()

    assert recall._automation_event_type_for(1, "automation_created") == "automation_created"
    assert recall._automation_event_type_for(2, "automation_created") == "automation_created"


def test_an_edit_is_never_promoted_to_a_creation():
    recall = Recall.__new__(Recall)
    recall._automation_lanes_created = set()

    assert recall._automation_event_type_for(9, "automation_edited") == "automation_edited"
    # And an edit must not consume the control's one creation.
    assert recall._automation_event_type_for(9, "automation_created") == "automation_created"


def test_an_automation_write_says_whether_the_control_is_a_mode():
    """Settled gestures always carried `parameter_is_quantized`; automation
    writes never did — and automation is the majority of captured control
    changes in a real library.

    Without it the app cannot tell a mode switch from a value move, and it draws
    a range bar for one and two names for the other. A bar on a mode states a
    distance that does not exist.
    """
    recall = Recall.__new__(Recall)
    recall._automation_writes = {}
    recall._last_values = {}
    recall._automation_recently_changed = {}
    recall._automation_edits_seen = 0
    recall._musical_position_context = lambda: {}
    emitted = []
    recall._emit = lambda event_type, payload: emitted.append((event_type, payload))
    recall._safe_name = lambda obj: getattr(obj, "name", None)
    recall._safe_id = lambda obj: "t1"

    quantized = Parameter(0.5)
    quantized.is_quantized = True
    recall._automation_writes[id(quantized)] = {
        "track": type("Track", (), {"name": "Bass"})(),
        "parameter": quantized,
        "device_name": "Serum",
        "device_id": "d1",
        "parameter_name": "Filter Type",
        "event_type": "automation_edited",
        # Captured at the start of the write, while the parameter was live.
        "is_quantized": True,
        "start_value": 0.2,
        "start_display_value": "Sinefold",
        "start_percent": 20,
        "start_ms": 0,
        "start_position": None,
        "points": [],
        "last_value": 0.6,
        "last_display_value": "Ripple",
        "last_percent": 60,
        "last_position": None,
        "last_value_at": 1.0,
        "observed_position": {},
    }

    recall._finish_automation_write(quantized, AUTOMATION_STATE_PLAYING)

    assert emitted, "the write must still be reported"
    assert emitted[0][1]["parameter_is_quantized"] is True


def test_finishing_a_write_survives_the_device_being_deleted():
    """`getattr`'s default only swallows AttributeError; Live's LOM raises
    RuntimeError on an object whose device has been deleted, which a producer
    can do while a write is open. That raise would escape into
    `_on_automation_state` — a listener registered with no guard, and the
    failure class behind the 0.20.1 rollback.
    """
    recall = Recall.__new__(Recall)
    recall._automation_writes = {}
    recall._last_values = {}
    recall._automation_recently_changed = {}
    recall._automation_edits_seen = 0
    recall._musical_position_context = lambda: {}
    emitted = []
    recall._emit = lambda event_type, payload: emitted.append((event_type, payload))
    recall._safe_name = lambda obj: getattr(obj, "name", None)
    recall._safe_id = lambda obj: "t1"

    class DeadParameter:
        @property
        def is_quantized(self):
            raise RuntimeError("the device was deleted")

    dead = DeadParameter()
    recall._automation_writes[id(dead)] = {
        "track": type("Track", (), {"name": "Bass"})(),
        "parameter": dead,
        "device_name": "Serum",
        "device_id": "d1",
        "parameter_name": "Cutoff",
        "event_type": "automation_edited",
        "is_quantized": False,
        "start_value": 0.2,
        "start_display_value": "10%",
        "start_percent": 20,
        "start_ms": 0,
        "start_position": None,
        "points": [],
        "last_value": 0.6,
        "last_display_value": "60%",
        "last_percent": 60,
        "last_position": None,
        "last_value_at": 1.0,
        "observed_position": {},
    }

    recall._finish_automation_write(dead, AUTOMATION_STATE_PLAYING)  # must not raise

    assert emitted, "the write is still reported after its device went away"
