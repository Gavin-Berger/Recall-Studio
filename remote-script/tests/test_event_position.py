import json
import queue

from Recall import Recall


class BeatsSongTime:
    bars = 41
    beats = 3


class Song:
    current_song_time = 162.0

    @staticmethod
    def get_current_beats_song_time():
        return BeatsSongTime()


def test_common_emit_stamps_musical_position_on_every_event():
    recall = object.__new__(Recall)
    recall.song = Song()
    recall._queue = queue.Queue()

    recall._emit("volume_changed", {"track_name": "Bass"})

    packet = json.loads(recall._queue.get_nowait().decode("utf-8"))
    assert packet["payload"]["observed_arrangement_position"] == "Bar 41 · Beat 3"
    assert packet["payload"]["observed_arrangement_beats"] == 162.0


def test_explicit_object_location_is_not_overwritten_by_playhead_context():
    recall = object.__new__(Recall)
    recall.song = Song()
    recall._queue = queue.Queue()

    recall._emit(
        "sample_added",
        {"arrangement_start_beats": 64.0, "arrangement_end_beats": 72.0},
    )

    payload = json.loads(recall._queue.get_nowait().decode("utf-8"))["payload"]
    assert payload["observed_arrangement_beats"] == 162.0
    assert payload["arrangement_start_beats"] == 64.0
    assert payload["arrangement_end_beats"] == 72.0
