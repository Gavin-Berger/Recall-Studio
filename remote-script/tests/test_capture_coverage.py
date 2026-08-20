"""Coverage reporting: what the bridge watched vs. what the track published.

MAX_PARAMS_PER_DEVICE silently decides which controls can ever be captured. A
synth that publishes more parameters than the cap has knobs whose moves are
never observed at all -- not dropped, not counted, simply invisible. Reporting
only the watched count made a partially watched device look identical to a fully
watched one, so the app had no way to distinguish "you did nothing there" from
"we could not see there".
"""

from Recall import MAX_PARAMS_PER_DEVICE, Recall


class Parameter:
    min = 0.0
    max = 1.0
    is_quantized = False
    is_enabled = True
    automation_state = 0
    state = 0

    def __init__(self, live_ptr, name):
        self._live_ptr = live_ptr
        self.name = name
        self.value = 0.5

    def str_for_value(self, value):
        return "{:.2f}".format(value)

    def add_value_listener(self, listener):
        pass

    def add_automation_state_listener(self, listener):
        pass


class Device:
    is_active = True
    type = 1
    class_name = "PluginDevice"

    def __init__(self, live_ptr, name, parameter_count):
        self._live_ptr = live_ptr
        self.name = name
        self.parameters = tuple(
            Parameter(live_ptr * 10_000 + index, "P{}".format(index))
            for index in range(parameter_count)
        )

    def add_is_active_listener(self, listener):
        pass


class Track:
    _live_ptr = 7
    name = "Lead"

    def __init__(self, devices):
        self.devices = tuple(devices)


def _focus_payload(devices):
    """Attach to a track and return the focus_changed payload the bridge sent."""
    recall = object.__new__(Recall)
    recall._parameter_listeners = []
    recall._automation_parameter_listeners = []
    recall._device_listeners = []
    recall._last_values = {}
    recall._watched_clips = (0, 0)
    recall._focused_parameter_roster = ()
    sent = []
    recall._emit = lambda event_type, payload: sent.append((event_type, payload))
    recall._watch_automation_state = lambda *args, **kwargs: None
    recall._watch_device_property = lambda *args, **kwargs: None
    recall._make_parameter_listener = lambda *args: (lambda: None)
    recall._make_device_toggle_listener = lambda *args: (lambda: None)

    recall._attach_to_focused_device(Track(devices))

    assert sent, "attaching must always emit focus_changed"
    event_type, payload = sent[0]
    assert event_type == "focus_changed"
    return payload


def test_a_fully_watched_track_reports_no_truncation():
    payload = _focus_payload([Device(1, "Saturator", 12)])

    assert payload["parameter_count"] == 12
    assert payload["parameter_count_total"] == 12
    assert payload["parameters_truncated"] is False
    assert payload["truncated_devices"] == []


def test_a_device_past_the_cap_reports_what_was_not_watched():
    published = MAX_PARAMS_PER_DEVICE + 300
    payload = _focus_payload([Device(2, "Serum 2", published)])

    # The watched count alone would read as full coverage of a 428-knob synth.
    assert payload["parameter_count"] == MAX_PARAMS_PER_DEVICE
    assert payload["parameter_count_total"] == published
    assert payload["parameters_truncated"] is True
    assert payload["truncated_devices"] == [
        {
            "device_name": "Serum 2",
            "watched": MAX_PARAMS_PER_DEVICE,
            "available": published,
        }
    ]


def test_coverage_is_reported_per_device_across_a_chain():
    published = MAX_PARAMS_PER_DEVICE + 40
    payload = _focus_payload(
        [
            Device(3, "Serum 2", published),
            Device(4, "EQ Eight", 30),
            Device(5, "Massive", published),
        ]
    )

    assert payload["parameter_count"] == MAX_PARAMS_PER_DEVICE * 2 + 30
    assert payload["parameter_count_total"] == published * 2 + 30
    assert [entry["device_name"] for entry in payload["truncated_devices"]] == [
        "Serum 2",
        "Massive",
    ]


def test_a_device_that_will_not_report_its_parameters_does_not_stop_capture():
    class HostileDevice(Device):
        @property
        def parameters(self):
            raise RuntimeError("device is going away")

        @parameters.setter
        def parameters(self, value):
            pass

    recall = object.__new__(Recall)
    assert recall._parameter_count(HostileDevice(6, "Ghost", 0)) == 0


def test_an_empty_track_still_reports_coverage_fields():
    recall = object.__new__(Recall)
    recall._focused_parameter_roster = ()
    recall._watched_clips = (0, 0)
    sent = []
    recall._emit = lambda event_type, payload: sent.append((event_type, payload))

    recall._attach_to_focused_device(Track([]))

    assert sent[0][0] == "focus_changed"
    payload = sent[0][1]
    # Never conditionally absent: a consumer must not have to read a missing
    # field as "coverage unknown".
    assert payload["parameter_count"] == 0
    assert payload["parameter_count_total"] == 0
    assert payload["parameters_truncated"] is False
    assert payload["truncated_devices"] == []
