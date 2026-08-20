"""Pure tests for the standalone, read-only LOM graph walker."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from RecallExplorer import _LomGraphWalker, _json_scalar, _scan_output_path  # noqa: E402


class _Node:
    pass


class _Vector:
    """A minimal stand-in for Live's Base.Vector collection types."""

    def __init__(self, *items):
        self._items = items

    def __iter__(self):
        return iter(self._items)

    def __len__(self):
        return len(self._items)


class _LiveProxy(_Node):
    def __init__(self, live_ptr):
        self._live_ptr = live_ptr


class _Clip:
    pass


def _records(walker):
    records = []
    while True:
        record = walker.next_record()
        if record is None:
            return records
        records.append(record)


def _attribute(record, name):
    return next(attribute for attribute in record["attributes"] if attribute["name"] == name)


def test_walker_emits_each_object_once_when_the_graph_contains_a_cycle():
    song = _Node()
    track = _Node()
    song.tracks = (track,)
    track.canonical_parent = song

    records = _records(_LomGraphWalker(song, max_depth=4))

    assert [record["path"] for record in records] == ["song", "song.tracks[0]"]
    parent = _attribute(records[1], "canonical_parent")["value"]
    assert parent == {"kind": "reference", "node": "node-00001", "type": parent["type"]}


def test_walker_keeps_methods_as_names_and_never_calls_them():
    song = _Node()
    called = []

    def destructive_method():
        called.append(True)

    song.destructive_method = destructive_method

    record = _records(_LomGraphWalker(song))[0]

    assert _attribute(record, "destructive_method") == {
        "name": "destructive_method",
        "kind": "method",
    }
    assert called == []


def test_walker_reports_collection_and_depth_limits_explicitly():
    song = _Node()
    first = _Node()
    second = _Node()
    song.children = (first, second)
    first.child = _Node()

    walker = _LomGraphWalker(
        song, max_depth=1, max_collection_items=1, max_objects=10
    )
    records = _records(walker)

    children = _attribute(records[0], "children")["value"]
    assert children["kind"] == "collection"
    assert children["omitted"] == 1
    assert records[1]["truncated"] == "max_depth"
    assert walker.summary()["truncations"] == {"collection_items": 1, "max_depth": 1}


def test_walker_descends_into_live_style_vector_collections():
    song = _Node()
    track = _Node()
    track.name = "Bass"
    song.tracks = _Vector(track)

    records = _records(_LomGraphWalker(song, max_depth=2))

    assert [record["path"] for record in records] == ["song", "song.tracks[0]"]
    assert _attribute(records[0], "tracks")["value"]["kind"] == "collection"
    assert _attribute(records[1], "name")["value"]["value"] == "Bass"


def test_walker_deduplicates_multiple_python_wrappers_for_one_live_object():
    song = _Node()
    first_wrapper = _LiveProxy(99)
    second_wrapper = _LiveProxy(99)
    first_wrapper.name = "Bass"
    second_wrapper.name = "Bass"
    song.tracks = _Vector(first_wrapper, second_wrapper)

    records = _records(_LomGraphWalker(song, max_depth=2))

    assert [record["path"] for record in records] == ["song", "song.tracks[0]"]
    track_items = _attribute(records[0], "tracks")["value"]["items"]
    assert track_items[1]["kind"] == "reference"
    assert track_items[1]["node"] == track_items[0]["node"]


def test_walker_prioritizes_devices_over_alphabetically_earlier_routing_data():
    song = _Node()
    routing = _Node()
    device = _Node()
    song.available_input_routing_types = _Vector(routing)
    song.devices = _Vector(device)

    records = _records(_LomGraphWalker(song, max_depth=2))

    assert [record["path"] for record in records[:3]] == [
        "song",
        "song.devices[0]",
        "song.available_input_routing_types[0]",
    ]


def test_walker_caps_only_configured_repetitive_object_types():
    song = _Node()
    first = _Clip()
    second = _Clip()
    song.clips = _Vector(first, second)

    walker = _LomGraphWalker(
        song, max_depth=2, type_limits={"test_lom_explorer._Clip": 1}
    )
    records = _records(walker)

    assert [record["path"] for record in records] == ["song", "song.clips[0]"]
    second_item = _attribute(records[0], "clips")["value"]["items"][1]
    assert second_item["reason"] == "type_limit"
    assert walker.summary()["truncations"] == {"type_limit:test_lom_explorer._Clip": 1}


def test_non_finite_numbers_are_json_safe_strings():
    assert _json_scalar(float("inf")) == "inf"
    assert _json_scalar(float("nan")) == "nan"


def test_each_scan_gets_a_dedicated_raw_jsonl_log():
    path = _scan_output_path("lom-123", r"C:\\Users\\gberg\\AppData\\Roaming")

    assert Path(path).parts[-3:] == (
        "com.gberg.recall-studio",
        "lom-explorer",
        "scan-lom-123.jsonl",
    )
