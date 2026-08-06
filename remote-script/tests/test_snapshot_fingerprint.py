"""Tests for the snapshot dedup logic behind issue #3: refresh_state() can call
_send_snapshot() when the set hasn't actually changed, and without a fingerprint
check that resends the whole tracks/devices/parameters payload for nothing.

Only the pure fingerprint function is testable here -- see conftest.py for why
_send_snapshot itself (a ControlSurface method with real Live API calls) isn't.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from Recall import _snapshot_fingerprint  # noqa: E402


def _payload(track_count=2, tempo=120.0):
    return {
        "tempo": tempo,
        "track_count": track_count,
        "tracks": [{"name": f"Track {i}"} for i in range(track_count)],
        "return_tracks": [],
        "master_track": {"name": "Master"},
    }


def test_identical_payloads_fingerprint_the_same():
    assert _snapshot_fingerprint(_payload()) == _snapshot_fingerprint(_payload())


def test_a_changed_track_count_fingerprints_differently():
    assert _snapshot_fingerprint(_payload(track_count=2)) != _snapshot_fingerprint(
        _payload(track_count=3)
    )


def test_a_changed_tempo_fingerprints_differently():
    assert _snapshot_fingerprint(_payload(tempo=120.0)) != _snapshot_fingerprint(
        _payload(tempo=128.0)
    )


def test_key_insertion_order_does_not_affect_the_fingerprint():
    # The payload is rebuilt fresh each call; dict key order must not cause a
    # false "changed" reading between two calls that describe the same set.
    a = {"tempo": 120.0, "track_count": 1, "tracks": [{"name": "Bass"}]}
    b = {"track_count": 1, "tracks": [{"name": "Bass"}], "tempo": 120.0}
    assert _snapshot_fingerprint(a) == _snapshot_fingerprint(b)
