from Recall import Recall


class Clip:
    def __init__(self, pointer, name, file_path, start_time, end_time=None):
        self._live_ptr = pointer
        self.name = name
        self.file_path = file_path
        self.start_time = start_time
        self.end_time = end_time if end_time is not None else start_time + 4.0
        self.is_session_clip = False
        self.is_midi_clip = False


class Track:
    _live_ptr = 41
    name = "Freeze 113 Serum"

    def __init__(self, clips):
        self.arrangement_clips = clips


class View:
    def __init__(self, track):
        self.selected_track = track


class Song:
    def __init__(self, track):
        self.view = View(track)


def test_arrangement_roster_emits_only_a_new_named_sample():
    existing = Clip(1, "old loop", r"C:\Samples\old_loop.wav", 0.0)
    inserted = Clip(2, "drums_14_kick", r"D:\Drums\drums_14_kick.wav", 128.0)
    track = Track([existing])
    emitted = []

    recall = object.__new__(Recall)
    recall.song = Song(track)
    recall._arrangement_clip_roster = recall._arrangement_clip_snapshot(track)
    recall._last_arrangement_roster_check_at = 0.0
    recall._watched_clip_ids = set()
    recall._clip_listeners = []
    recall._clip_prints = {}
    recall._emit = lambda event_type, payload: emitted.append((event_type, payload))

    # The baseline represents clips already in the Set and must stay silent.
    recall._refresh_arrangement_clips_if_due()
    assert emitted == []

    track.arrangement_clips.append(inserted)
    recall._last_arrangement_roster_check_at = 0.0
    recall._refresh_arrangement_clips_if_due()

    assert len(emitted) == 1
    event_type, payload = emitted[0]
    assert event_type == "sample_added"
    assert payload["track_name"] == "Freeze 113 Serum"
    assert payload["sample_name"] == "drums_14_kick.wav"
    assert payload["clip_name"] == "drums_14_kick"
    assert payload["file_path"] == r"D:\Drums\drums_14_kick.wav"
    assert payload["arrangement_start_beats"] == 128.0
    assert payload["arrangement_end_beats"] == 132.0


def test_exact_clip_range_is_only_claimed_for_arrangement_clips():
    arrangement = Clip(1, "kick", r"D:\Drums\kick.wav", 64.0, 72.0)
    session = Clip(2, "loop", r"D:\Drums\loop.wav", 0.0, 8.0)
    session.is_session_clip = True

    assert Recall._clip_arrangement_range(arrangement) == {
        "arrangement_start_beats": 64.0,
        "arrangement_end_beats": 72.0,
    }
    assert Recall._clip_arrangement_range(session) == {}
