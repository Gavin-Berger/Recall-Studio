"""Tests for the heartbeat throttle.

Context: the app decides `connected` from ONE fact -- a `heartbeat` event seen
inside a 5-second window (src-tauri/src/udp_listener.rs::get_status). This script
never sent one, so `connected` was permanently false and the version chip never
rendered. The heartbeat closes that gap.

Only the pure throttle decision is testable here -- see conftest.py for why
_send_heartbeat_if_due itself (a ControlSurface method that emits over a socket)
isn't.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from Recall import HEARTBEAT_INTERVAL_SEC, _heartbeat_due  # noqa: E402


def test_first_tick_after_load_is_due():
    # _last_heartbeat_at starts at 0.0 so the app learns the bridge is alive (and
    # which build is running) on the very first update_display tick, rather than
    # after an interval of apparent disconnection.
    assert _heartbeat_due(now=1_700_000_000.0, last_sent_at=0.0) is True


def test_not_due_immediately_after_sending():
    now = 1_700_000_000.0
    assert _heartbeat_due(now=now + 0.1, last_sent_at=now) is False


def test_not_due_just_before_the_interval():
    now = 1_700_000_000.0
    assert _heartbeat_due(now=now + HEARTBEAT_INTERVAL_SEC - 0.01, last_sent_at=now) is False


def test_due_exactly_on_the_interval():
    now = 1_700_000_000.0
    assert _heartbeat_due(now=now + HEARTBEAT_INTERVAL_SEC, last_sent_at=now) is True


def test_due_after_the_interval():
    now = 1_700_000_000.0
    assert _heartbeat_due(now=now + HEARTBEAT_INTERVAL_SEC + 5.0, last_sent_at=now) is True


def test_interval_stays_inside_the_apps_five_second_window():
    # If this ever grows past 5s the app flips to "disconnected" between healthy
    # heartbeats. The margin also has to survive a single missed tick.
    assert HEARTBEAT_INTERVAL_SEC * 2 < 5.0


def test_a_backwards_clock_does_not_stop_heartbeats_forever():
    # time.time() follows the system clock. An NTP correction or a manual change
    # can move `now` behind `last_sent_at`, making elapsed negative -- which
    # without the guard never reaches the interval, so heartbeats stop for good
    # and a healthy bridge reads as disconnected until Live restarts.
    now = 1_700_000_000.0
    assert _heartbeat_due(now=now - 3600.0, last_sent_at=now) is True


def test_a_custom_interval_is_respected():
    now = 1_700_000_000.0
    assert _heartbeat_due(now=now + 0.5, last_sent_at=now, interval=0.25) is True
    assert _heartbeat_due(now=now + 0.5, last_sent_at=now, interval=10.0) is False
