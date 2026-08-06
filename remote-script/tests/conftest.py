# Minimal stand-in for Ableton's `ableton.v2.control_surface` module so
# `Recall/__init__.py` can be imported outside Live for testing pure logic.
# Live's actual `ableton` package only exists inside the embedded Python
# interpreter Live launches remote scripts under; it is not installable here.
#
# This stub exists to make module-level pure functions (see
# `_snapshot_fingerprint`) importable and testable in isolation. It is
# deliberately NOT a faithful mock of ControlSurface — anything that needs
# real Live API behavior (self.song, component_guard, listener registration)
# is out of scope for a plain pytest run and stays untested here.
import sys
import types


def _install_ableton_stub():
    if "ableton.v2.control_surface" in sys.modules:
        return

    ableton = types.ModuleType("ableton")
    ableton_v2 = types.ModuleType("ableton.v2")
    control_surface = types.ModuleType("ableton.v2.control_surface")

    class ControlSurface:
        def __init__(self, c_instance):
            pass

    control_surface.ControlSurface = ControlSurface

    ableton.v2 = ableton_v2
    ableton_v2.control_surface = control_surface

    sys.modules["ableton"] = ableton
    sys.modules["ableton.v2"] = ableton_v2
    sys.modules["ableton.v2.control_surface"] = control_surface


_install_ableton_stub()
