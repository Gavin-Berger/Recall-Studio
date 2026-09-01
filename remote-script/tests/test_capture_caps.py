"""The ceilings, and what each one is actually protecting.

Three caps got conflated for a long time, and the conflation cost real capture:

  MAX_PARAMS_PER_DEVICE bounds LISTENER COUNT. It was 128, and Serum publishes
  well past that, so knobs past the cutoff were never observed at all.

  MAX_NOTES_READ bounds work on LIVE'S THREAD. It is the only number here that
  can make Live stutter, and it is deliberately left alone until measured.

  MAX_MIDI_NOTES_CAPTURED bounds the PAYLOAD. It sat at half the read, so the
  script paid Live's thread to read 4096 notes and then discarded 2048 of them.

These tests pin the relationships rather than the exact numbers, so the caps can
be tuned without rewriting the suite — except where the number itself is the
finding.
"""

import time

from Recall import (
    MAX_MIDI_NOTES_CAPTURED,
    MAX_NOTES_READ,
    MAX_PARAMS_PER_DEVICE,
    NOTE_READ_SLOW_MS,
    Recall,
)


class Harness(Recall):
    def __init__(self):  # noqa: D107 - deliberately skips Recall.__init__
        self._slowest_note_read_ms = 0.0
        self._slowest_note_read_count = 0


def test_nothing_that_survives_the_read_is_thrown_away():
    # Capturing less than we read means paying Live's thread for notes and then
    # discarding them, which made a dense clip's piano roll lie by omission
    # about notes that were already in hand for free.
    assert MAX_MIDI_NOTES_CAPTURED >= MAX_NOTES_READ


def test_the_parameter_cap_clears_a_large_soft_synth():
    # 128 was silently dropping moves on Serum 2 in a real library. The cap is
    # about listener count, and a listener only costs anything when the
    # parameter moves.
    assert MAX_PARAMS_PER_DEVICE >= 1024


def test_a_slow_note_read_is_remembered_with_its_size():
    # The point of the measurement is to size MAX_NOTES_READ from evidence, so
    # the worst read has to survive, together with how many notes caused it.
    harness = Harness()

    harness._record_note_read(time.time() - 0.08, 3000)

    assert harness._slowest_note_read_ms >= 75.0
    assert harness._slowest_note_read_count == 3000


def test_only_the_worst_read_is_kept():
    harness = Harness()

    harness._record_note_read(time.time() - 0.08, 3000)
    harness._record_note_read(time.time() - 0.001, 4)

    assert harness._slowest_note_read_ms >= 75.0
    assert harness._slowest_note_read_count == 3000, "a fast read must not erase the worst one"


def test_a_fast_read_is_still_recorded_when_it_is_the_first():
    harness = Harness()

    harness._record_note_read(time.time() - 0.002, 12)

    assert harness._slowest_note_read_ms > 0.0
    assert harness._slowest_note_read_count == 12


def test_measuring_can_never_take_live_down():
    # _record_note_read is reached from a path that runs on Live's thread. An
    # unhandled exception in one of those is the failure class behind the 0.20.1
    # rollback (commit 886856c), so instrumentation must fail silently.
    harness = Harness()
    harness._slowest_note_read_ms = "not a number"

    harness._record_note_read(time.time(), 10)  # must not raise


def test_the_slow_threshold_is_a_fraction_of_a_display_tick():
    # Live drives update_display about every 100ms. A warning threshold at or
    # above a full tick would only fire once the damage was already audible.
    assert 0 < NOTE_READ_SLOW_MS < 100.0
