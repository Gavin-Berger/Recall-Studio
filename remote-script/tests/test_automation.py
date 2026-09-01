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
