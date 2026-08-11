# Recall Studio - LOM probe. NOT a capture script.
#
# This exists to answer two questions that block four open issues and cannot be
# answered from outside Live, because the interesting parts of Ableton's Python
# API are undocumented and differ between versions:
#
#   Q1 (#10, #11, #6) - can a control surface learn the path of the .als that is
#       currently open? Recall's whole project-attribution model depends on it.
#       `update_open_file` reads `project_path` off incoming events; the control
#       surface never sends one, so `open_als_path` is permanently None, so
#       `rotate_session_if_project_changed` returns immediately and every song
#       records into whichever take happened to be active. There is no
#       documented Song property for this. Either it is reachable under some
#       name, or the attribution mechanism needs a different trigger entirely.
#
#   Q2 (#9) - does `DeviceParameter.automation_state` distinguish "automation is
#       driving this parameter" from "the producer just grabbed it"? Value
#       listeners fire identically for both, so automation playback currently
#       re-records itself as fabricated moves, once per pass over the automated
#       region.
#
# HOW IT ANSWERS THEM: by reflection, not by assuming. It dumps what the objects
# actually expose on THIS build of Live rather than trusting documentation that
# may not match. That is the only honest way to probe an undocumented API.
#
# ── INSTALL ──────────────────────────────────────────────────────────────────
#   1. Copy this folder to <User Library>/Remote Scripts/RecallProbe/
#   2. Restart Live.
#   3. Preferences -> Link/Tempo/MIDI -> a SECOND Control Surface slot -> RecallProbe
#      (leave Recall itself in its own slot; the two do not interfere)
#   4. Open a SAVED set, then look for the report path printed in Live's Log.txt,
#      or read it directly at <Desktop>/recall-lom-probe.txt
#
# For Q2, before reading the report: draw or record some automation on any
# parameter, then hit play so the automation is actually driving it.
#
# Remove the folder and restart when done. This writes one text file and
# captures nothing.

from __future__ import annotations

import logging
import os
import traceback

from ableton.v2.control_surface import ControlSurface

logger = logging.getLogger(__name__)

REPORT_NAME = "recall-lom-probe.txt"

# Attribute names worth reporting when found on any probed object. The point is
# to catch a path-like property under a name nobody guessed, so this is
# deliberately broad and matched as a substring.
PATH_HINTS = ("path", "file", "document", "name", "dir", "folder", "project")

# How many characters of any single value to record. Some LOM properties return
# very large structures and this file is meant to be readable and emailable.
MAX_VALUE_CHARS = 240


def safe_repr(value, limit=MAX_VALUE_CHARS):
    """Describe a value without ever raising.

    Reflection over a live audio application's object graph WILL hit properties
    that throw, that block, or that return objects whose __repr__ throws. A
    probe that dies partway through is worse than useless: it reports a partial
    answer that looks complete.
    """
    try:
        text = repr(value)
    except Exception as error:  # noqa: BLE001
        return "<repr failed: {}>".format(type(error).__name__)

    if len(text) > limit:
        return text[:limit] + "...<truncated>"
    return text


def interesting_attributes(names, hints=PATH_HINTS):
    """Attribute names that might carry a file path, lowercased-substring match.

    Separate from the reflection itself so the filter is testable without Live.
    """
    out = []
    for name in names:
        lowered = name.lower()
        if any(hint in lowered for hint in hints):
            out.append(name)
    return sorted(out)


def describe_object(label, obj):
    """Every readable attribute of `obj`, with the path-like ones called out."""
    lines = ["", "=" * 70, label, "=" * 70]

    try:
        names = dir(obj)
    except Exception as error:  # noqa: BLE001
        lines.append("  dir() failed: {}".format(error))
        return lines

    hits = interesting_attributes(names)
    lines.append("")
    lines.append("-- path-like attributes ({} found) --".format(len(hits)))
    if not hits:
        lines.append("  (none)")
    for name in hits:
        lines.append("  {} = {}".format(name, safe_repr(_read(obj, name))))

    lines.append("")
    lines.append("-- every public attribute --")
    for name in sorted(n for n in names if not n.startswith("_")):
        lines.append("  {} = {}".format(name, safe_repr(_read(obj, name), 120)))

    return lines


def _read(obj, name):
    """getattr that reports its own failure instead of raising."""
    try:
        return getattr(obj, name)
    except Exception as error:  # noqa: BLE001
        return "<getattr failed: {}>".format(type(error).__name__)


def report_path():
    """Somewhere the producer can actually find it."""
    desktop = os.path.join(os.path.expanduser("~"), "Desktop")
    if os.path.isdir(desktop):
        return os.path.join(desktop, REPORT_NAME)
    return os.path.join(os.path.expanduser("~"), REPORT_NAME)


class RecallProbe(ControlSurface):
    def __init__(self, c_instance):
        super().__init__(c_instance)
        try:
            with self.component_guard():
                self._write_report()
        except Exception:  # noqa: BLE001
            # Never take Live down. A probe that crashes the host is a probe
            # nobody runs twice.
            logger.error("Recall probe failed:\n%s", traceback.format_exc())

    # ── Q1: can we find the open .als? ──────────────────────────────────────

    def _probe_open_set(self):
        lines = ["", "#" * 70, "Q1 - IS THE OPEN .als REACHABLE?  (issues #10, #11, #6)", "#" * 70]

        song = self.song
        lines.extend(describe_object("Song", song))

        try:
            import Live

            app = Live.Application.get_application()
            lines.extend(describe_object("Live.Application", app))

            # get_document() is the documented way to reach the Song; probing it
            # separately in case it exposes anything the Song object does not.
            try:
                document = app.get_document()
                lines.extend(describe_object("Live.Application.get_document()", document))
            except Exception as error:  # noqa: BLE001
                lines.append("  get_document() failed: {}".format(error))

            lines.append("")
            lines.append("Live version: {}.{}.{}".format(
                _read(app, "get_major_version")() if callable(_read(app, "get_major_version")) else "?",
                _read(app, "get_minor_version")() if callable(_read(app, "get_minor_version")) else "?",
                _read(app, "get_bugfix_version")() if callable(_read(app, "get_bugfix_version")) else "?",
            ))
        except Exception:  # noqa: BLE001
            lines.append("Live module probe failed:\n{}".format(traceback.format_exc()))

        return lines

    # ── Q2: can we tell automation from a human hand? ───────────────────────

    def _probe_automation(self):
        lines = ["", "#" * 70, "Q2 - CAN AUTOMATION BE TOLD FROM A PRODUCER MOVE?  (issue #9)", "#" * 70]

        try:
            import Live

            enum = _read(Live.DeviceParameter, "AutomationState")
            lines.append("")
            lines.append("Live.DeviceParameter.AutomationState = {}".format(safe_repr(enum)))
            if enum != "<getattr failed: AttributeError>":
                for name in sorted(n for n in dir(enum) if not n.startswith("_")):
                    lines.append("  {} = {}".format(name, safe_repr(_read(enum, name))))
        except Exception as error:  # noqa: BLE001
            lines.append("AutomationState lookup failed: {}".format(error))

        lines.append("")
        lines.append("-- every parameter carrying automation, across all tracks --")
        lines.append("   (state 1 normally means 'automation is playing', 2 'producer overrode it')")
        lines.append("   Transport playing: {}".format(safe_repr(_read(self.song, "is_playing"))))

        found = 0
        try:
            for track in self.song.tracks:
                for device in track.devices:
                    for parameter in device.parameters:
                        state = _read(parameter, "automation_state")
                        if state in (0, "<getattr failed: AttributeError>"):
                            continue
                        found += 1
                        lines.append(
                            "  {} / {} / {}: automation_state={} value={} has_listener_api={}".format(
                                _read(track, "name"),
                                _read(device, "name"),
                                _read(parameter, "name"),
                                safe_repr(state, 40),
                                safe_repr(_read(parameter, "value"), 40),
                                hasattr(parameter, "add_automation_state_listener"),
                            )
                        )
                        if found >= 40:
                            lines.append("  ...(stopping at 40)")
                            return lines
        except Exception:  # noqa: BLE001
            lines.append("parameter walk failed:\n{}".format(traceback.format_exc()))

        if found == 0:
            lines.append("  (none found - draw or record some automation, hit play, then reload this script)")

        return lines

    def _write_report(self):
        lines = [
            "Recall Studio - Ableton LOM probe",
            "Generated on load. Read-only: this captures nothing and stores nothing.",
        ]
        lines.extend(self._probe_open_set())
        lines.extend(self._probe_automation())
        lines.append("")

        body = "\n".join(str(line) for line in lines)
        path = report_path()

        try:
            with open(path, "w", encoding="utf-8") as handle:
                handle.write(body)
            logger.info("Recall probe: wrote %s", path)
            # Log.txt too, so the answer survives even if the file write is
            # blocked by permissions on someone else's machine.
            logger.info("Recall probe report follows:\n%s", body)
        except Exception:  # noqa: BLE001
            logger.error("Recall probe: could not write %s\n%s", path, traceback.format_exc())
            logger.info("Recall probe report follows:\n%s", body)
