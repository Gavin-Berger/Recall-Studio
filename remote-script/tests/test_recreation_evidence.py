import os
from types import SimpleNamespace

from Recall import Recall, _cue_point_events, _normalize_midi_note, _normalize_warp_markers


def test_extended_midi_note_keeps_recreation_fields():
    note = SimpleNamespace(
        note_id=17,
        pitch=64,
        start_time=12.25,
        duration=0.75,
        velocity=101,
        mute=False,
        probability=0.65,
        velocity_deviation=-8,
        release_velocity=72,
    )

    assert _normalize_midi_note(note) == {
        "note_id": 17,
        "pitch": 64,
        "start_time": 12.25,
        "duration": 0.75,
        "velocity": 101.0,
        "mute": False,
        "probability": 0.65,
        "velocity_deviation": -8.0,
        "release_velocity": 72.0,
    }


def test_legacy_note_tuple_remains_supported():
    assert _normalize_midi_note((36, 0.5, 0.25, 118, True)) == {
        "pitch": 36,
        "start_time": 0.5,
        "duration": 0.25,
        "velocity": 118.0,
        "mute": True,
    }


def test_warp_markers_are_normalized_and_sorted_by_beat():
    markers = _normalize_warp_markers(
        {
            "warp_markers": [
                {"sample_time": 2.5, "beat_time": 8.0},
                {"sample_time": 0.0, "beat_time": 0.0},
            ]
        }
    )

    assert markers == [
        {"sample_time": 0.0, "beat_time": 0.0},
        {"sample_time": 2.5, "beat_time": 8.0},
    ]


def test_cue_point_delta_names_add_move_rename_and_delete():
    previous = {
        "1": {"cue_name": "Verse", "cue_time": 32.0},
        "2": {"cue_name": "Old", "cue_time": 64.0},
        "4": {"cue_name": "Drop", "cue_time": 96.0},
    }
    current = {
        "1": {"cue_name": "Verse A", "cue_time": 32.0},
        "2": {"cue_name": "Old", "cue_time": 68.0},
        "3": {"cue_name": "Bridge", "cue_time": 80.0},
    }

    events = _cue_point_events(previous, current)
    by_type = {event_type: payload for event_type, payload in events}

    assert by_type["cue_point_added"]["cue_name"] == "Bridge"
    assert by_type["cue_point_renamed"]["previous_cue_name"] == "Verse"
    assert by_type["cue_point_moved"]["previous_cue_time"] == 64.0
    assert by_type["cue_point_deleted"]["cue_name"] == "Drop"


def test_project_save_requires_the_same_als_file_to_change(tmp_path):
    path = tmp_path / "Hit.als"
    path.write_bytes(b"first")
    recall = Recall.__new__(Recall)
    recall._project_file_path = None
    recall._project_file_stamp = None
    recall._open_set_path = lambda: str(path)
    recall.song = SimpleNamespace(name="Hit")
    emitted = []
    recall._emit = lambda event_type, payload: emitted.append((event_type, payload))

    recall._observe_project_file_save()
    assert emitted == []

    first = path.stat().st_mtime_ns
    path.write_bytes(b"second version")
    os.utime(path, ns=(first + 1_000_000, first + 1_000_000))
    recall._observe_project_file_save()

    assert emitted[0][0] == "project_saved"
    assert emitted[0][1]["project_path"].endswith("Hit.als")
    assert emitted[0][1]["save_detection"] == "als_file_modified"
