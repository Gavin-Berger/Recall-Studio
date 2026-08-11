"""Tests for the open-.als discovery helpers (issues #10, #11, #6).

Live exposes no documented property for the path of the set the producer
currently has open, so the script searches for one at load instead of guessing a
name. These cover the two pure pieces of that search: which attribute names are
worth reading and in what order, and what counts as a real answer.

The search itself runs against live LOM objects and can't be exercised here —
see conftest.py for why.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from Recall import (  # noqa: E402
    SET_PATH_ATTRIBUTE_HINTS,
    _find_set_path_attribute,
    _looks_like_set_path,
)


def test_an_als_path_is_a_real_answer():
    assert _looks_like_set_path("C:/Music/Night EP/Night EP.als")


def test_matching_is_case_insensitive():
    # Windows paths routinely arrive with a capitalised extension.
    assert _looks_like_set_path("C:/Music/Song.ALS")


def test_surrounding_whitespace_does_not_disqualify_a_path():
    assert _looks_like_set_path("  C:/Music/Song.als  ")


def test_a_bare_set_name_is_not_a_path():
    # Several LOM properties return a display name rather than a path. The app
    # rejects anything without .als, so accepting these would mean sending a
    # field the backend discards while the log claimed discovery succeeded.
    assert not _looks_like_set_path("Night EP")


def test_a_project_folder_is_not_a_path_to_the_set():
    assert not _looks_like_set_path("C:/Music/Night EP Project")


def test_non_strings_are_rejected_rather_than_coerced():
    # Live returns 0 for absent text properties (see _safe_name) — a value that
    # would happily str() into something truthy.
    for value in (None, 0, 1, [], {}, object()):
        assert not _looks_like_set_path(value)


def test_empty_and_whitespace_are_rejected():
    assert not _looks_like_set_path("")
    assert not _looks_like_set_path("   ")


def test_exact_hint_matches_come_before_substring_matches():
    # A property literally called file_path is a better bet than one merely
    # containing the word, so it must be read first.
    order = _find_set_path_attribute(["get_document_file_path", "file_path", "tempo"])
    assert order[0] == "file_path"
    assert "get_document_file_path" in order


def test_hint_priority_is_respected_across_different_names():
    # file_path outranks path in SET_PATH_ATTRIBUTE_HINTS, so even though both
    # match exactly, file_path is tried first.
    order = _find_set_path_attribute(["path", "file_path"])
    assert order.index("file_path") < order.index("path")


def test_unrelated_attributes_are_not_offered():
    assert _find_set_path_attribute(["tempo", "tracks", "is_playing"]) == []


def test_private_attributes_are_skipped_in_substring_matching():
    # Reading dunders and privates off a live audio application is a good way to
    # trip something that raises for no benefit.
    order = _find_set_path_attribute(["_file_path_cache", "__file_path__"])
    assert order == []


def test_no_name_is_offered_twice():
    # An exact match must not also be appended by the substring pass — reading
    # the same property twice is wasted work against a live object.
    order = _find_set_path_attribute(["file_path", "document_path"])
    assert len(order) == len(set(order))


def test_the_result_is_deterministic():
    # Discovery runs once and its answer is cached for the session, so an
    # ordering that varied between runs would make the bug unreproducible.
    names = ["path", "document_path", "file_path", "tempo", "get_file_path"]
    assert _find_set_path_attribute(names) == _find_set_path_attribute(names)


def test_every_hint_is_lowercase():
    # Matching lowercases the candidate name, so an uppercase hint could never
    # match anything.
    for hint in SET_PATH_ATTRIBUTE_HINTS:
        assert hint == hint.lower()
