from Recall import Recall


class Parameter:
    _live_ptr = 101
    name = "Arp"
    value = 1.0
    min = 0.0
    max = 1.0
    is_quantized = True
    value_items = ("Off", "On")
    is_enabled = True
    automation_state = 1
    state = 0

    def str_for_value(self, value):
        return self.value_items[int(value)]


class ContinuousParameter:
    _live_ptr = 102
    name = "Cutoff"
    value = 0.75
    min = 0.0
    max = 1.0
    is_quantized = False
    is_enabled = True
    automation_state = 0
    state = 0
    default_value = 0.5

    def str_for_value(self, value):
        return "8.4 kHz"


class Device:
    _live_ptr = 55
    name = "Serum 2"
    is_active = True
    type = 1
    class_name = "PluginDevice"
    class_display_name = "Serum 2 VST3"
    preset_name = "Glass Lead"
    parameters = (Parameter(), ContinuousParameter())


def test_device_checkpoint_captures_readable_host_visible_state():
    recall = object.__new__(Recall)
    checkpoint = recall._serialize_device(Device())

    assert checkpoint["host_parameter_count"] == 2
    assert checkpoint["class_display_name"] == "Serum 2 VST3"
    assert checkpoint["preset_name"] == "Glass Lead"

    arp, cutoff = checkpoint["parameters"]
    assert arp["display_value"] == "On"
    assert arp["value_items"] == ["Off", "On"]
    assert arp["automation_state"] == 1
    assert "default_value" not in arp

    assert cutoff["display_value"] == "8.4 kHz"
    assert cutoff["default_value"] == 0.5
    assert "value_items" not in cutoff


def test_parameter_roster_detects_a_newly_host_visible_control():
    recall = object.__new__(Recall)

    class Track:
        devices = (Device(),)

    track = Track()
    before = recall._parameter_roster(track)
    track.devices[0].parameters = track.devices[0].parameters + (Parameter(),)
    track.devices[0].parameters[-1]._live_ptr = 103
    track.devices[0].parameters[-1].name = "Rate"
    after = recall._parameter_roster(track)

    assert len(before) == 2
    assert len(after) == 3
    assert before != after
