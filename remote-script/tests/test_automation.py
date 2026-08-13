from Recall import (
    AUTOMATION_STATE_NONE,
    AUTOMATION_STATE_PLAYING,
    AUTOMATION_STATE_RECORDING,
    _automation_event_type,
    _automation_position_label,
    _became_active,
    _track_structure_events,
)


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


def test_session_performance_only_fires_at_the_idle_to_active_edge():
    assert _became_active(0, 1)
    assert _became_active(False, True)
    assert not _became_active(1, 2)
    assert not _became_active(2, 0)
