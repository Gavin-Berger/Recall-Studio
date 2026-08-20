"""Read-only Live Object Model explorer for Ableton Live 12.

Select ``RecallExplorer`` as a Control Surface in Live to write a bounded,
newline-delimited JSON graph of the current Live Object Model (LOM) to Live's
``Log.txt``.  This package deliberately has no socket, no Recall event protocol,
and no listeners: it is a diagnostic tool, not part of Recall's capture path.

The LOM is a graph, not a tree.  For example, ``canonical_parent`` points back
up the hierarchy.  Each object is therefore emitted once as a ``node`` record;
attributes point to those nodes by ID.  The scan is incremental so a large Set
does not monopolise Live's main thread in one update callback.
"""

from __future__ import annotations

from collections import deque
import json
import logging
import math
import os
import time

from ableton.v2.control_surface import ControlSurface


logger = logging.getLogger(__name__)

SCRIPT_VERSION = "0.1.0"
LOG_PREFIX = "RecallExplorer JSON "

# Conservative defaults for running inside Live's audio application.  Raise a
# limit only for a one-off research pass, then restart Live to load the change.
MAX_DEPTH = 6
MAX_OBJECTS = 2500
MAX_ATTRIBUTES_PER_OBJECT = 256
MAX_COLLECTION_ITEMS = 128
# A single LOM object can expose hundreds of properties.  Two objects keeps a
# display-tick bounded even before the per-object attribute cap has a chance to
# help; this is a research tool, so several seconds of scan time is acceptable.
NODES_PER_UPDATE = 2
MAX_TEXT_LENGTH = 512
FILE_FLUSH_INTERVAL = 64

# A project with many tracks can expose thousands of routing choice wrappers
# and clips. They are useful API types, but after a representative sample they
# stop contributing new interface information and can crowd actual devices and
# parameters out of the global node budget. Parameter objects are intentionally
# uncapped: their parent/device/name combinations are the primary research goal.
MAX_NODES_PER_TYPE = {
    "Track.RoutingType": 32,
    "Track.RoutingChannel": 32,
    "Clip.Clip": 32,
    "ClipSlot.ClipSlot": 96,
}

# Breadth-first discovery follows public member names alphabetically by default.
# Without this list, a Track's many available routing choices are enqueued before
# its devices because ``available_*`` sorts first. Keep the structural path to
# parameters ahead of low-signal and potentially huge clip/routing collections.
PRIORITY_RELATIONSHIPS = frozenset(
    (
        "tracks",
        "return_tracks",
        "master_track",
        "devices",
        "parameters",
        "mixer_device",
        "chains",
        "drum_pads",
        "sends",
    )
)


def _type_name(value):
    """A stable, JSON-safe description without invoking an object's repr."""
    value_type = type(value)
    module = getattr(value_type, "__module__", "")
    name = getattr(value_type, "__name__", "object")
    return "{}.{}".format(module, name) if module else name


def _scan_output_path(run_id, appdata=None):
    """A fresh raw JSONL file per scan, outside Live's shared diagnostic log."""
    if appdata is None:
        appdata = os.environ.get("APPDATA")
    if appdata:
        directory = os.path.join(appdata, "com.gberg.recall-studio", "lom-explorer")
    else:
        # The normal branch above is used by Live on Windows. This fallback keeps
        # manual testing on another platform out of the installed Remote Script.
        directory = os.path.join(os.path.expanduser("~"), "RecallExplorer", "logs")
    return os.path.join(directory, "scan-{}.jsonl".format(run_id))


def _short_text(value, limit=MAX_TEXT_LENGTH):
    """Keep log records bounded even when Live returns unusually long text."""
    text = str(value)
    return text if len(text) <= limit else "{}... <truncated>".format(text[:limit])


def _error_details(error):
    """Represent a failed getter without letting its message break the scan."""
    try:
        message = _short_text(error)
    except Exception:  # noqa: BLE001 - an exception's __str__ can itself fail
        message = "<unprintable error>"
    return {"type": _type_name(error), "message": message}


def _json_scalar(value):
    """Return a JSON scalar, normalising values JSON cannot represent."""
    if value is None or isinstance(value, (bool, int, str)):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else str(value)
    return None


def _is_lom_collection(value):
    """Whether a value is one of Live's read-only vector collection objects.

    Live 12 exposes most LOM collections as ``Base.Vector`` (and specialised
    variants such as ``Track.RoutingChannelVector``), not Python tuples.  They
    deliberately look like ordinary objects in ``dir()``, so recognizing their
    type is what lets the walker reach actual tracks, devices, and parameters.
    Restricting iteration to the known Vector convention avoids probing arbitrary
    LOM objects merely because they happen to implement ``__iter__``.
    """
    return isinstance(value, (tuple, list)) or _type_name(value).endswith("Vector")


def _is_priority_relationship(name):
    """Whether traversing this child is on the route to device parameters."""
    return name in PRIORITY_RELATIONSHIPS


def _object_identity(value):
    """Use Live's stable LOM identity when wrappers refer to the same object.

    A traversal can reach one Track through ``song.tracks``, ``visible_tracks``,
    ``canonical_parent`` and a ClipSlot. Live creates a fresh Python proxy for
    several of those paths, so ``id(value)`` treats the same Track as multiple
    objects. ``_live_ptr`` is the stable identity Recall already uses for LOM
    snapshots; ordinary Python objects still fall back to their process ID for
    unit tests and any object where Live does not expose the pointer.
    """
    try:
        return ("live_ptr", str(value._live_ptr))
    except Exception:  # noqa: BLE001 - not a Live object or no stable pointer
        return ("python_id", id(value))


def _public_attribute_names(value):
    """Return deterministic public names, even for partial/invalid LOM objects."""
    try:
        return sorted(name for name in dir(value) if not name.startswith("_")), None
    except Exception as error:  # noqa: BLE001 - a stale LOM object can reject dir()
        return [], _error_details(error)


class _LomGraphWalker:
    """Incrementally discover a bounded, cycle-safe graph rooted at one object."""

    def __init__(
        self,
        root,
        max_depth=MAX_DEPTH,
        max_objects=MAX_OBJECTS,
        max_attributes=MAX_ATTRIBUTES_PER_OBJECT,
        max_collection_items=MAX_COLLECTION_ITEMS,
        type_limits=MAX_NODES_PER_TYPE,
    ):
        self._max_depth = max_depth
        self._max_objects = max_objects
        self._max_attributes = max_attributes
        self._max_collection_items = max_collection_items
        self._priority_pending = deque()
        self._pending = deque()
        self._nodes_by_identity = {}
        self._objects_by_type = {}
        self._type_limits = dict(type_limits)
        self._objects_seen = 0
        self._truncations = {}
        self._register_object(root, "song", 0, priority=True)

    def _add_truncation(self, reason, count=1):
        self._truncations[reason] = self._truncations.get(reason, 0) + count

    def _register_object(self, value, path, depth, priority=False):
        """Assign a node ID once; later edges refer to that same node."""
        identity = _object_identity(value)
        known = self._nodes_by_identity.get(identity)
        if known is not None:
            return {"kind": "reference", "node": known, "type": _type_name(value)}

        node_type = _type_name(value)
        type_limit = self._type_limits.get(node_type)
        seen_for_type = self._objects_by_type.get(node_type, 0)
        if type_limit is not None and seen_for_type >= type_limit:
            self._add_truncation("type_limit:{}".format(node_type))
            return {
                "kind": "object",
                "type": node_type,
                "status": "omitted",
                "reason": "type_limit",
            }

        if self._objects_seen >= self._max_objects:
            self._add_truncation("max_objects")
            return {"kind": "object", "type": node_type, "status": "omitted"}

        self._objects_seen += 1
        self._objects_by_type[node_type] = seen_for_type + 1
        node_id = "node-{:05d}".format(self._objects_seen)
        self._nodes_by_identity[identity] = node_id
        target_queue = self._priority_pending if priority else self._pending
        target_queue.append((node_id, value, path, depth))
        return {"kind": "object", "node": node_id, "type": node_type}

    def _describe_value(self, value, path, depth, priority=False):
        scalar = _json_scalar(value)
        if scalar is not None or value is None:
            return {"kind": "value", "value": scalar, "type": _type_name(value)}

        if _is_lom_collection(value):
            return self._describe_collection(value, path, depth, priority)

        if isinstance(value, dict):
            return self._describe_mapping(value, path, depth, priority)

        return self._register_object(value, path, depth, priority)

    def _describe_collection(self, values, path, depth, priority=False):
        try:
            size = len(values)
        except Exception:  # noqa: BLE001 - some Live vectors omit __len__
            size = None

        try:
            iterator = iter(values)
        except Exception as error:  # noqa: BLE001 - retain unsupported vectors as evidence
            return {
                "kind": "collection",
                "type": _type_name(values),
                "size": size,
                "error": _error_details(error),
            }

        item_records = []
        for index in range(self._max_collection_items):
            try:
                value = next(iterator)
            except StopIteration:
                break
            except Exception as error:  # noqa: BLE001 - a stale vector can fail mid-read
                return {
                    "kind": "collection",
                    "type": _type_name(values),
                    "size": size,
                    "items": item_records,
                    "error": _error_details(error),
                }
            item_records.append(
                self._describe_value(
                    value, "{}[{}]".format(path, index), depth, priority
                )
            )

        omitted = max(0, size - len(item_records)) if size is not None else 0
        has_unknown_remainder = False
        if size is None and len(item_records) == self._max_collection_items:
            try:
                next(iterator)
                has_unknown_remainder = True
            except StopIteration:
                pass
            except Exception:  # noqa: BLE001 - a missing remainder is not a scan failure
                has_unknown_remainder = True

        if omitted:
            self._add_truncation("collection_items", omitted)
        elif has_unknown_remainder:
            self._add_truncation("collection_items")
        record = {
            "kind": "collection",
            "type": _type_name(values),
            "size": size,
            "items": item_records,
        }
        if omitted:
            record["omitted"] = omitted
        elif has_unknown_remainder:
            record["omitted"] = "unknown"
        return record

    def _describe_mapping(self, values, path, depth, priority=False):
        """Mappings are uncommon in the LOM but can appear in newer Live APIs."""
        try:
            items = sorted(values.items(), key=lambda item: str(item[0]))
        except Exception as error:  # noqa: BLE001 - preserve a troublesome value as data
            return {"kind": "mapping", "type": _type_name(values), "error": _error_details(error)}

        entries = []
        for index, (key, value) in enumerate(items[: self._max_collection_items]):
            key_text = _short_text(key)
            entries.append(
                {
                    "key": key_text,
                    "value": self._describe_value(
                        value, "{}[{}]".format(path, index), depth, priority
                    ),
                }
            )
        omitted = max(0, len(items) - len(entries))
        if omitted:
            self._add_truncation("mapping_items", omitted)
        record = {
            "kind": "mapping",
            "type": _type_name(values),
            "size": len(items),
            "entries": entries,
        }
        if omitted:
            record["omitted"] = omitted
        return record

    def next_record(self):
        """Return one node record, or ``None`` after the graph is exhausted."""
        if not self._priority_pending and not self._pending:
            return None

        queue = self._priority_pending if self._priority_pending else self._pending
        node_id, value, path, depth = queue.popleft()
        record = {
            "record": "node",
            "node": node_id,
            "path": path,
            "type": _type_name(value),
            "depth": depth,
            "attributes": [],
        }

        if depth >= self._max_depth:
            self._add_truncation("max_depth")
            record["truncated"] = "max_depth"
            return record

        names, names_error = _public_attribute_names(value)
        if names_error is not None:
            record["attribute_enumeration_error"] = names_error
            return record

        if len(names) > self._max_attributes:
            self._add_truncation("attributes", len(names) - self._max_attributes)
            record["attributes_omitted"] = len(names) - self._max_attributes
            names = names[: self._max_attributes]

        for name in names:
            try:
                attribute = getattr(value, name)
            except Exception as error:  # noqa: BLE001 - unsupported getters are evidence
                record["attributes"].append(
                    {"name": name, "kind": "error", "error": _error_details(error)}
                )
                continue

            if callable(attribute):
                # Methods are discovered but never invoked.  Calling a seemingly
                # harmless LOM method can add a listener, edit a Set, or perform
                # an unbounded note read.
                record["attributes"].append({"name": name, "kind": "method"})
                continue

            record["attributes"].append(
                {
                    "name": name,
                    "value": self._describe_value(
                        attribute,
                        "{}.{}".format(path, name),
                        depth + 1,
                        _is_priority_relationship(name),
                    ),
                }
            )
        return record

    def summary(self):
        return {
            "objects": self._objects_seen,
            "truncations": dict(sorted(self._truncations.items())),
        }


class RecallExplorer(ControlSurface):
    """Control Surface shell that runs the graph walk without touching Recall."""

    def __init__(self, c_instance):
        super().__init__(c_instance)
        self._run_id = "lom-{}".format(int(time.time() * 1000))
        self._walker = None
        self._started = False
        self._completed = False
        self._output_file = None
        self._output_path = None
        self._records_since_flush = 0
        self._file_logging_failed = False
        logger.info(
            "RecallExplorer: loaded; select this surface to begin a read-only LOM scan."
        )

    def _open_output_file(self):
        """Open the run-local JSONL output; Live's Log.txt stays a fallback."""
        try:
            path = _scan_output_path(self._run_id)
            os.makedirs(os.path.dirname(path), exist_ok=True)
            self._output_file = open(path, "w", encoding="utf-8")
            self._output_path = path
        except Exception as error:  # noqa: BLE001 - a log file must never affect Live
            self._output_file = None
            self._output_path = None
            logger.info("RecallExplorer: could not open dedicated scan log: %s", _error_details(error))

    def _close_output_file(self):
        if self._output_file is None:
            return
        try:
            self._output_file.flush()
            self._output_file.close()
        except Exception:  # noqa: BLE001 - shutdown must not affect Live
            pass
        finally:
            self._output_file = None

    def _write_output_file(self, encoded, record_type):
        if self._output_file is None:
            return
        try:
            self._output_file.write("{}\n".format(encoded))
            self._records_since_flush += 1
            if (
                self._records_since_flush >= FILE_FLUSH_INTERVAL
                or record_type in ("run_completed", "run_failed", "run_interrupted")
            ):
                self._output_file.flush()
                self._records_since_flush = 0
        except Exception as error:  # noqa: BLE001 - keep the Live log fallback alive
            if not self._file_logging_failed:
                self._file_logging_failed = True
                logger.info("RecallExplorer: dedicated scan log failed: %s", _error_details(error))
            self._close_output_file()

    def _write_record(self, record):
        """Mirror each record to Live's log and the run-local raw JSONL file."""
        payload = dict(record)
        payload["run_id"] = self._run_id
        payload["script_version"] = SCRIPT_VERSION
        try:
            encoded = json.dumps(payload, sort_keys=True, allow_nan=False)
        except Exception as error:  # noqa: BLE001 - logging must never threaten Live
            logger.info("RecallExplorer: could not encode log record: %s", _error_details(error))
            return
        logger.info("%s%s", LOG_PREFIX, encoded)
        self._write_output_file(encoded, payload.get("record"))

    def _start(self):
        self._started = True
        try:
            self._walker = _LomGraphWalker(self.song)
            self._open_output_file()
            started_record = {
                "record": "run_started",
                "root": "song",
                "limits": {
                    "max_depth": MAX_DEPTH,
                    "max_objects": MAX_OBJECTS,
                    "max_attributes_per_object": MAX_ATTRIBUTES_PER_OBJECT,
                    "max_collection_items": MAX_COLLECTION_ITEMS,
                    "max_nodes_per_type": MAX_NODES_PER_TYPE,
                    "nodes_per_update": NODES_PER_UPDATE,
                },
            }
            if self._output_path is not None:
                started_record["output_file"] = self._output_path
            self._write_record(started_record)
        except Exception as error:  # noqa: BLE001 - Live can be changing Sets at load
            self._completed = True
            self._write_record({"record": "run_failed", "error": _error_details(error)})

    def update_display(self):
        """Scan a few nodes each Live display tick instead of blocking on load."""
        super().update_display()
        if self._completed:
            return
        if not self._started:
            self._start()
        if self._completed or self._walker is None:
            return

        try:
            for _ in range(NODES_PER_UPDATE):
                record = self._walker.next_record()
                if record is None:
                    self._write_record({"record": "run_completed", **self._walker.summary()})
                    self._completed = True
                    self._close_output_file()
                    return
                self._write_record(record)
        except Exception as error:  # noqa: BLE001 - never take Live down for research
            self._completed = True
            self._write_record({"record": "run_failed", "error": _error_details(error)})
            self._close_output_file()

    def disconnect(self):
        """Close a partial run cleanly when the user deselects this surface."""
        try:
            if self._started and not self._completed:
                self._write_record({"record": "run_interrupted"})
        finally:
            self._close_output_file()
        super().disconnect()


def create_instance(c_instance):
    """Entry point called by Ableton when this separate surface is selected."""
    return RecallExplorer(c_instance)
