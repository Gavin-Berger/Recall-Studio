"""Tests for the LOM probe's pure helpers.

The probe's job is reflection inside Live, which cannot run here — but the parts
that decide WHAT gets reported, and that keep it from dying partway through, are
plain functions and are exactly the parts worth pinning.

Why the resilience matters more than usual: reflecting over a live audio
application's object graph hits properties that raise, that block, and that
return objects whose __repr__ raises. A probe that dies halfway produces a
partial answer that reads like a complete one, and the whole point is to settle
questions nobody can currently answer.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from RecallProbe import (  # noqa: E402
    MAX_VALUE_CHARS,
    interesting_attributes,
    safe_repr,
)


class Exploding:
    """Stands in for the LOM properties that raise when you look at them."""

    def __repr__(self):
        raise RuntimeError("boom")


def test_path_like_attributes_are_picked_out():
    names = ["tempo", "file_path", "tracks", "document_name", "is_playing"]
    assert interesting_attributes(names) == ["document_name", "file_path"]


def test_matching_is_case_insensitive_and_substring():
    # The whole point is catching a property under a name nobody guessed, so
    # "ProjectFolder" and "getFilePath" both have to register.
    assert interesting_attributes(["ProjectFolder"]) == ["ProjectFolder"]
    assert interesting_attributes(["getFilePath"]) == ["getFilePath"]


def test_unrelated_names_are_left_out():
    assert interesting_attributes(["tempo", "tracks", "is_playing", "volume"]) == []


def test_results_are_sorted_so_two_runs_can_be_diffed():
    # Reports from different machines or Live versions get compared by eye;
    # dir() order is not guaranteed stable.
    assert interesting_attributes(["z_path", "a_file"]) == ["a_file", "z_path"]


def test_an_exploding_repr_is_reported_not_raised():
    # A probe that dies on one bad property answers nothing about the rest.
    assert safe_repr(Exploding()) == "<repr failed: RuntimeError>"


def test_long_values_are_truncated():
    result = safe_repr("x" * (MAX_VALUE_CHARS * 2))
    assert result.endswith("...<truncated>")
    assert len(result) < MAX_VALUE_CHARS * 2


def test_short_values_are_left_alone():
    assert safe_repr("C:/Music/Night EP.als") == "'C:/Music/Night EP.als'"


def test_none_is_reported_rather_than_skipped():
    # "the property exists and is None" and "the property does not exist" are
    # different answers to Q1, and the report has to keep them apart.
    assert safe_repr(None) == "None"
