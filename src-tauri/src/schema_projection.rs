//! Normalized schema projection.
//!
//! The `events` table is the immutable system of record. This module turns the
//! latest deep `live_set_snapshot` payload + the parameter-change event stream
//! into the normalized Project → Track → Device → Parameter tree and a list of
//! ParameterChange rows (with derived before/after values).
//!
//! Everything here that parses JSON is a PURE function (no DB, no I/O) so it can
//! be unit-tested directly. The SQL that persists and reads these rows lives in
//! `storage.rs`, which calls into the parsers below.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;

// ── Enums ───────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TrackType {
    Midi,
    Audio,
    Return,
    Group,
}

impl TrackType {
    pub fn as_str(self) -> &'static str {
        match self {
            TrackType::Midi => "midi",
            TrackType::Audio => "audio",
            TrackType::Return => "return",
            TrackType::Group => "group",
        }
    }

    pub fn from_str(value: &str) -> TrackType {
        match value {
            "midi" => TrackType::Midi,
            "return" => TrackType::Return,
            "group" => TrackType::Group,
            _ => TrackType::Audio,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DeviceRole {
    Instrument,
    MidiEffect,
    AudioEffect,
}

impl DeviceRole {
    pub fn as_str(self) -> &'static str {
        match self {
            DeviceRole::Instrument => "instrument",
            DeviceRole::MidiEffect => "midi_effect",
            DeviceRole::AudioEffect => "audio_effect",
        }
    }

    pub fn from_str(value: &str) -> DeviceRole {
        match value {
            "instrument" => DeviceRole::Instrument,
            "midi_effect" => DeviceRole::MidiEffect,
            _ => DeviceRole::AudioEffect,
        }
    }
}

// ── Parsed tree (intermediate, no stable ids yet) ────────────────────────────

#[derive(Debug, Clone, PartialEq)]
pub struct ParsedParam {
    pub ableton_id: Option<String>,
    pub name: Option<String>,
    pub value: Option<f64>,
    pub min: Option<f64>,
    pub max: Option<f64>,
    pub normalized_value: Option<f64>,
    pub children: Vec<ParsedParam>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ParsedDevice {
    pub ableton_id: Option<String>,
    pub name: Option<String>,
    pub role: DeviceRole,
    pub enabled: bool,
    pub params: Vec<ParsedParam>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ParsedTrack {
    pub ableton_id: Option<String>,
    pub name: Option<String>,
    pub number: i64,
    pub track_type: TrackType,
    pub color: Option<String>,
    pub group_ableton_id: Option<String>,
    pub devices: Vec<ParsedDevice>,
}

// ── Output schema (serialized to the frontend by the getters) ────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ParameterObj {
    pub id: String,
    pub device_id: String,
    pub parent_parameter_id: Option<String>,
    pub name: Option<String>,
    pub value: Option<f64>,
    pub unit: Option<String>,
    pub min: Option<f64>,
    pub max: Option<f64>,
    pub normalized_value: Option<f64>,
    pub children: Vec<ParameterObj>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceObj {
    pub id: String,
    pub track_id: String,
    pub ableton_id: Option<String>,
    pub name: Option<String>,
    pub role: DeviceRole,
    pub chain_index: i64,
    pub enabled: bool,
    pub parameters: Vec<ParameterObj>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrackObj {
    pub id: String,
    pub ableton_id: Option<String>,
    pub name: Option<String>,
    pub number: i64,
    #[serde(rename = "type")]
    pub track_type: TrackType,
    pub color: Option<String>,
    pub group_id: Option<String>,
    pub chain_index: i64,
    pub devices: Vec<DeviceObj>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectSchema {
    pub session_id: String,
    pub name: String,
    pub has_snapshot: bool,
    pub tracks: Vec<TrackObj>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ParameterChange {
    pub id: String,
    pub parameter_id: Option<String>,
    pub track_name: Option<String>,
    pub device_name: Option<String>,
    pub parameter_name: Option<String>,
    pub before_value: Option<f64>,
    pub after_value: Option<f64>,
    pub unit: Option<String>,
    pub reason: Option<String>,
    pub changed_at_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreativeMomentTarget {
    pub target_type: String,
    pub target_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreativeMoment {
    pub id: String,
    pub session_id: String,
    pub title: String,
    #[serde(rename = "type")]
    pub moment_type: String,
    pub timeline_start_ms: Option<u64>,
    pub timeline_end_ms: Option<u64>,
    pub note: Option<String>,
    pub tags: Vec<String>,
    pub confidence: String,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
    pub targets: Vec<CreativeMomentTarget>,
}

// ── Snapshot tree parsing (pure) ─────────────────────────────────────────────

/// Parse the normalized track tree out of a deep `live_set_snapshot` payload.
///
/// Handles both regular `tracks` and (when the bridge provides them) `return_tracks`.
/// Tolerant of missing fields — older snapshots simply yield less detail.
pub fn parse_session_tree(payload: &Value) -> Vec<ParsedTrack> {
    let mut tracks = Vec::new();

    if let Some(array) = payload.get("tracks").and_then(Value::as_array) {
        for track in array {
            tracks.push(parse_track(track, false));
        }
    }

    // Return tracks live in a separate Live collection; the bridge may emit them
    // under `return_tracks`. They are always typed as Return regardless of flags.
    if let Some(array) = payload.get("return_tracks").and_then(Value::as_array) {
        for track in array {
            tracks.push(parse_track(track, true));
        }
    }

    tracks
}

fn parse_track(track: &Value, is_return: bool) -> ParsedTrack {
    let devices: Vec<ParsedDevice> = track
        .get("devices")
        .and_then(Value::as_array)
        .map(|array| array.iter().map(parse_device).collect())
        .unwrap_or_default();

    let track_type = derive_track_type(track, is_return, &devices);

    ParsedTrack {
        ableton_id: read_id(track.get("id")),
        name: read_string(track.get("name")),
        number: track.get("index").and_then(Value::as_i64).unwrap_or(0) + 1,
        track_type,
        color: read_color(track.get("color")),
        group_ableton_id: read_id(track.get("group_track_id"))
            .or_else(|| read_id(track.get("group_track"))),
        devices,
    }
}

fn parse_device(device: &Value) -> ParsedDevice {
    let params = device
        .get("parameters")
        .and_then(Value::as_array)
        .map(|array| array.iter().map(parse_param).collect())
        .unwrap_or_default();

    ParsedDevice {
        ableton_id: read_id(device.get("id")),
        name: read_string(device.get("name")),
        role: derive_device_role(device),
        // Default ON: a device absent `is_active` is assumed enabled.
        enabled: device
            .get("is_active")
            .and_then(as_loose_bool)
            .unwrap_or(true),
        params,
    }
}

fn parse_param(param: &Value) -> ParsedParam {
    let children = param
        .get("children")
        .and_then(Value::as_array)
        .map(|array| array.iter().map(parse_param).collect())
        .unwrap_or_default();

    ParsedParam {
        ableton_id: read_id(param.get("id")),
        name: read_string(param.get("name")),
        value: param.get("value").and_then(Value::as_f64),
        min: param.get("min").and_then(Value::as_f64),
        max: param.get("max").and_then(Value::as_f64),
        normalized_value: param.get("normalized_value").and_then(Value::as_f64),
        children,
    }
}

/// Map a device to its chain role. Trusts a bridge-provided `role` string first
/// (the bridge reads it from the Live API, where the semantics are unambiguous),
/// and falls back to the raw `type` integer for older snapshots.
fn derive_device_role(device: &Value) -> DeviceRole {
    if let Some(role) = read_string(device.get("role")) {
        return DeviceRole::from_str(&role);
    }

    // Live API Device.type fallback. Exact integers vary by Live version, so the
    // bridge-provided `role` above is the primary signal; this is best-effort for
    // snapshots captured before the bridge emitted a role.
    match device.get("type").and_then(Value::as_i64) {
        Some(1) => DeviceRole::Instrument,
        Some(4) => DeviceRole::MidiEffect,
        _ => DeviceRole::AudioEffect,
    }
}

/// Decide a track's type from the richest signal available.
fn derive_track_type(track: &Value, is_return: bool, devices: &[ParsedDevice]) -> TrackType {
    if is_return {
        return TrackType::Return;
    }
    if track
        .get("is_foldable")
        .and_then(as_loose_bool)
        .unwrap_or(false)
    {
        return TrackType::Group;
    }
    // Cleanest signal when the bridge provides it.
    if let Some(has_midi) = track.get("has_midi_input").and_then(as_loose_bool) {
        return if has_midi {
            TrackType::Midi
        } else {
            TrackType::Audio
        };
    }
    // Fallbacks for older snapshots: an instrument in the chain means MIDI; a MIDI
    // clip in any slot means MIDI; otherwise default to audio.
    if devices.iter().any(|d| d.role == DeviceRole::Instrument) {
        return TrackType::Midi;
    }
    if let Some(slots) = track.get("clip_slots").and_then(Value::as_array) {
        let has_midi_clip = slots.iter().any(|slot| {
            slot.get("is_midi_clip")
                .or_else(|| slot.get("clip").and_then(|c| c.get("is_midi_clip")))
                .and_then(as_loose_bool)
                .unwrap_or(false)
        });
        if has_midi_clip {
            return TrackType::Midi;
        }
    }
    TrackType::Audio
}

// ── Parameter-change derivation (pure) ───────────────────────────────────────

/// A raw parameter-change event pulled from the events table.
#[derive(Debug, Clone)]
pub struct ChangeEvent {
    pub event_id: i64,
    pub timestamp_ms: u64,
    pub track_name: Option<String>,
    pub device_name: Option<String>,
    pub parameter_name: Option<String>,
    pub value: Option<f64>,
}

/// Compute before/after values for a session's parameter changes.
///
/// Events are grouped by (track, device, parameter) and walked in time order:
/// `after` is the event's value and `before` is the previous value in that group.
/// The first change in a group has `before = None` (the pre-session value is
/// unknown — the snapshot reflects the *final* state, so it can't stand in for the
/// initial one without lying). `parameter_id` is linked when the named parameter
/// exists in the materialized tree.
pub fn build_parameter_changes(
    mut changes: Vec<ChangeEvent>,
    parameter_lookup: &HashMap<(String, String, String), String>,
) -> Vec<ParameterChange> {
    // Deterministic order so re-materialization is stable: time, then event id.
    changes.sort_by(|a, b| {
        a.timestamp_ms
            .cmp(&b.timestamp_ms)
            .then(a.event_id.cmp(&b.event_id))
    });

    let mut previous: HashMap<(String, String, String), f64> = HashMap::new();
    let mut rows = Vec::new();

    for change in changes {
        let Some(parameter_name) = change.parameter_name.clone() else {
            continue; // not a parameter change without a parameter name
        };

        let key = (
            change.track_name.clone().unwrap_or_default(),
            change.device_name.clone().unwrap_or_default(),
            parameter_name.clone(),
        );

        let before_value = previous.get(&key).copied();
        let after_value = change.value;

        rows.push(ParameterChange {
            id: format!("pc::{}", change.event_id),
            parameter_id: parameter_lookup.get(&key).cloned(),
            track_name: change.track_name.clone(),
            device_name: change.device_name.clone(),
            parameter_name: Some(parameter_name),
            before_value,
            after_value,
            unit: None,
            reason: None,
            changed_at_ms: change.timestamp_ms,
        });

        if let Some(value) = after_value {
            previous.insert(key, value);
        }
    }

    rows
}

// ── small JSON helpers ───────────────────────────────────────────────────────

fn read_string(value: Option<&Value>) -> Option<String> {
    match value {
        Some(Value::String(text)) if !text.trim().is_empty() => Some(text.clone()),
        _ => None,
    }
}

/// Live ids arrive as numbers or strings depending on the path; normalize to a
/// string id and drop empties.
fn read_id(value: Option<&Value>) -> Option<String> {
    match value {
        Some(Value::String(text)) if !text.trim().is_empty() => Some(text.clone()),
        Some(Value::Number(number)) => Some(number.to_string()),
        _ => None,
    }
}

/// Track color arrives as an int (Live color) or string; keep a stringy form.
fn read_color(value: Option<&Value>) -> Option<String> {
    match value {
        Some(Value::String(text)) if !text.trim().is_empty() => Some(text.clone()),
        Some(Value::Number(number)) => Some(number.to_string()),
        _ => None,
    }
}

/// Accept real bools and the 1/0 some senders use.
fn as_loose_bool(value: &Value) -> Option<bool> {
    match value {
        Value::Bool(b) => Some(*b),
        Value::Number(n) => n.as_i64().map(|i| i != 0),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn midi_track_splits_instrument_and_effects() {
        let payload = json!({
            "tracks": [{
                "index": 0,
                "id": "t1",
                "name": "Bass 1",
                "has_midi_input": true,
                "devices": [
                    { "id": "d1", "name": "Arp", "role": "midi_effect" },
                    { "id": "d2", "name": "Some Synth", "role": "instrument" },
                    { "id": "d3", "name": "Some Saturator", "role": "audio_effect" }
                ]
            }]
        });

        let tracks = parse_session_tree(&payload);
        assert_eq!(tracks.len(), 1);
        let track = &tracks[0];
        assert_eq!(track.track_type, TrackType::Midi);
        assert_eq!(track.number, 1);
        assert_eq!(track.devices.len(), 3);
        assert_eq!(track.devices[0].role, DeviceRole::MidiEffect);
        assert_eq!(track.devices[1].role, DeviceRole::Instrument);
        assert_eq!(track.devices[2].role, DeviceRole::AudioEffect);
    }

    #[test]
    fn audio_track_has_no_instrument() {
        let payload = json!({
            "tracks": [{
                "index": 2,
                "id": "t3",
                "name": "Vocals",
                "has_midi_input": false,
                "devices": [{ "id": "d9", "name": "Some EQ", "role": "audio_effect" }]
            }]
        });

        let track = &parse_session_tree(&payload)[0];
        assert_eq!(track.track_type, TrackType::Audio);
        assert_eq!(track.number, 3);
        assert!(track
            .devices
            .iter()
            .all(|d| d.role == DeviceRole::AudioEffect));
    }

    #[test]
    fn group_track_detected_from_foldable() {
        let payload = json!({
            "tracks": [{ "index": 0, "id": "g1", "name": "Bass", "is_foldable": true, "devices": [] }]
        });
        assert_eq!(parse_session_tree(&payload)[0].track_type, TrackType::Group);
    }

    #[test]
    fn return_tracks_typed_as_return() {
        let payload = json!({
            "tracks": [],
            "return_tracks": [{ "index": 0, "id": "r1", "name": "Reverb", "devices": [] }]
        });
        let tracks = parse_session_tree(&payload);
        assert_eq!(tracks.len(), 1);
        assert_eq!(tracks[0].track_type, TrackType::Return);
    }

    #[test]
    fn track_type_falls_back_to_instrument_presence() {
        // No has_midi_input flag (older snapshot), but an instrument is present.
        let payload = json!({
            "tracks": [{
                "index": 0, "id": "t1", "name": "Keys",
                "devices": [{ "id": "d1", "name": "Synth", "type": 1 }]
            }]
        });
        let track = &parse_session_tree(&payload)[0];
        assert_eq!(track.track_type, TrackType::Midi);
        assert_eq!(track.devices[0].role, DeviceRole::Instrument);
    }

    #[test]
    fn before_after_chains_within_a_parameter() {
        let changes = vec![
            ChangeEvent {
                event_id: 1,
                timestamp_ms: 100,
                track_name: Some("Bass 1".into()),
                device_name: Some("Synth".into()),
                parameter_name: Some("Cutoff".into()),
                value: Some(0.20),
            },
            ChangeEvent {
                event_id: 2,
                timestamp_ms: 200,
                track_name: Some("Bass 1".into()),
                device_name: Some("Synth".into()),
                parameter_name: Some("Cutoff".into()),
                value: Some(0.55),
            },
        ];

        let mut lookup = HashMap::new();
        lookup.insert(
            ("Bass 1".into(), "Synth".into(), "Cutoff".into()),
            "param-id-1".to_string(),
        );

        let rows = build_parameter_changes(changes, &lookup);
        assert_eq!(rows.len(), 2);

        // First change: before unknown, after 0.20, linked to the tree param.
        assert_eq!(rows[0].before_value, None);
        assert_eq!(rows[0].after_value, Some(0.20));
        assert_eq!(rows[0].parameter_id.as_deref(), Some("param-id-1"));

        // Second change: before is the previous after.
        assert_eq!(rows[1].before_value, Some(0.20));
        assert_eq!(rows[1].after_value, Some(0.55));
    }

    #[test]
    fn separate_parameters_do_not_share_history() {
        let changes = vec![
            ChangeEvent {
                event_id: 1,
                timestamp_ms: 100,
                track_name: Some("T".into()),
                device_name: Some("D".into()),
                parameter_name: Some("A".into()),
                value: Some(1.0),
            },
            ChangeEvent {
                event_id: 2,
                timestamp_ms: 150,
                track_name: Some("T".into()),
                device_name: Some("D".into()),
                parameter_name: Some("B".into()),
                value: Some(9.0),
            },
        ];
        let rows = build_parameter_changes(changes, &HashMap::new());
        // Each first-in-group change has no before value.
        assert!(rows.iter().all(|r| r.before_value.is_none()));
        assert!(rows.iter().all(|r| r.parameter_id.is_none()));
    }
}
