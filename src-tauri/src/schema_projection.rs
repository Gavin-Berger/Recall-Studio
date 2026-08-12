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
    Master,
}

impl TrackType {
    pub fn as_str(self) -> &'static str {
        match self {
            TrackType::Midi => "midi",
            TrackType::Audio => "audio",
            TrackType::Return => "return",
            TrackType::Group => "group",
            TrackType::Master => "master",
        }
    }

    pub fn from_str(value: &str) -> TrackType {
        match value {
            "midi" => TrackType::Midi,
            "return" => TrackType::Return,
            "group" => TrackType::Group,
            "master" => TrackType::Master,
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
    // Live's stable per-track pointer. Two changes can share track_name (Ableton
    // auto-names a track after its first device, e.g. "Serum 2") but never this —
    // it's what the before/after grouping and the frontend's track credit
    // actually key on when present. None for events captured before the bridge
    // sent it; those fall back to track_name.
    pub track_id: Option<String>,
    pub device_name: Option<String>,
    pub parameter_name: Option<String>,
    pub before_value: Option<f64>,
    pub after_value: Option<f64>,
    pub before_value_percent: Option<f64>,
    pub after_value_percent: Option<f64>,
    pub unit: Option<String>,
    // Live-formatted display strings: the mode name for quantized params
    // ("Sinefold") or the unit-bearing value for continuous ones ("440 Hz").
    // is_quantized lets the timeline render a mode label vs a numeric value.
    pub before_display_value: Option<String>,
    pub after_display_value: Option<String>,
    pub is_quantized: Option<bool>,
    pub reason: Option<String>,
    pub changed_at_ms: u64,
}

/// One settled note edit in a MIDI clip, as the timeline renders it.
///
/// Unlike [`ParameterChange`] this is NOT materialized into its own table. The
/// control surface already coalesces note edits at source (one row per settled
/// edit, not per keystroke), so there is nothing left to derive — the event row
/// *is* the record, and a projection table would only duplicate it. Read
/// straight from `events` by [`parse_note_edit`].
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NoteEdit {
    pub id: String,
    pub track_name: Option<String>,
    /// Live's stable pointer for the track. Display names can change between
    /// an edit and a later schema snapshot, so timeline joins must prefer this.
    pub track_id: Option<String>,
    pub clip_name: Option<String>,
    /// Live's pointer for the clip. The only reliable way to tell two clips
    /// apart — names are frequently blank, so grouping on name alone merges
    /// edits from different clips into one run.
    pub clip_id: Option<String>,
    /// `notes_added` | `notes_removed` | `notes_edited` | `cleared` | `edited`.
    pub change_kind: Option<String>,
    pub note_count: Option<i64>,
    pub previous_note_count: Option<i64>,
    pub distinct_pitches: Option<i64>,
    /// Raw MIDI numbers as well as the rendered range: the timeline draws a
    /// pitch bar from these, and a string like "C1-G2" cannot be measured.
    pub pitch_min: Option<i64>,
    pub pitch_max: Option<i64>,
    pub previous_pitch_min: Option<i64>,
    pub previous_pitch_max: Option<i64>,
    /// Pitch range in Live's own naming ("C1-G2"), pre-rendered by the bridge so
    /// the app needs no opinion about C3 = 60.
    pub pitch_range: Option<String>,
    pub previous_pitch_range: Option<String>,
    pub velocity_mean: Option<f64>,
    pub length_beats: Option<f64>,
    /// Ready-to-show phrase: "16 notes (+4), C1-G1 -> C1-G2".
    pub summary: Option<String>,
    pub changed_at_ms: u64,
}

/// A discrete clip or sample addition that belongs in the arrangement activity
/// density even though it is not a parameter move or a MIDI-note edit.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TimelineClipEvent {
    pub id: String,
    pub event_type: String,
    pub track_name: Option<String>,
    pub track_id: Option<String>,
    pub clip_name: Option<String>,
    pub sample_name: Option<String>,
    pub changed_at_ms: u64,
}

/// Build a [`NoteEdit`] from one `clip_notes_changed` event row.
///
/// `payload` is the raw JSON *string* stored in `events.payload`. Anything
/// unparseable yields None rather than a half-filled row: a note edit the app
/// cannot describe is worse than one it doesn't show, because it would occupy a
/// line of the story saying nothing.
pub fn parse_note_edit(
    event_id: i64,
    timestamp_ms: u64,
    column_track_name: Option<String>,
    column_track_id: Option<String>,
    payload: Option<&str>,
) -> Option<NoteEdit> {
    let parsed: Value = serde_json::from_str(payload?).ok()?;

    let text = |key: &str| {
        parsed
            .get(key)
            .and_then(Value::as_str)
            .map(|value| value.to_string())
    };
    let int = |key: &str| parsed.get(key).and_then(Value::as_i64);

    Some(NoteEdit {
        id: format!("note-edit-{}", event_id),
        // The first-class column wins when present — it is what every other
        // read path joins tracks on — with the payload as the fallback.
        track_name: column_track_name.or_else(|| text("track_name")),
        track_id: column_track_id.or_else(|| text("track_id")),
        clip_name: text("clip_name"),
        clip_id: text("clip_id"),
        change_kind: text("change_kind"),
        note_count: int("note_count"),
        previous_note_count: int("previous_note_count"),
        distinct_pitches: int("distinct_pitches"),
        pitch_min: int("pitch_min"),
        pitch_max: int("pitch_max"),
        previous_pitch_min: int("previous_pitch_min"),
        previous_pitch_max: int("previous_pitch_max"),
        pitch_range: text("pitch_range"),
        previous_pitch_range: text("previous_pitch_range"),
        velocity_mean: parsed.get("velocity_mean").and_then(Value::as_f64),
        length_beats: parsed.get("length_beats").and_then(Value::as_f64),
        summary: text("summary"),
        changed_at_ms: timestamp_ms,
    })
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

    // The Main/Master bus lives outside both collections. Parse it like a track
    // but force the Master type (and a "Main" fallback name) so its mastering
    // chain shows up as its own lane.
    if let Some(master) = payload.get("master_track") {
        if master.is_object() && master.get("id").is_some() {
            let mut parsed = parse_track(master, false);
            parsed.track_type = TrackType::Master;
            if parsed.name.is_none() {
                parsed.name = Some("Main".to_string());
            }
            tracks.push(parsed);
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
    pub track_id: Option<String>,
    pub device_name: Option<String>,
    pub parameter_name: Option<String>,
    pub value: Option<f64>,
    pub previous_value: Option<f64>,
    pub value_percent: Option<f64>,
    pub previous_value_percent: Option<f64>,
    pub display_value: Option<String>,
    pub previous_display_value: Option<String>,
    pub is_quantized: Option<bool>,
}

/// The string a change's track is grouped by: Live's stable track_id when the
/// event carries one, else the free-text track_name. Two different tracks can
/// share a name (Ableton auto-names a track after its first device, e.g. two
/// separate "Serum 2" tracks) but never a track_id, so preferring it here is
/// what keeps their before/after chains from being spliced together. Events
/// captured before the bridge sent track_id (or with no track at all) fall
/// back to the name, matching the pre-existing behavior for legacy sessions.
/// `storage.rs` uses this same resolution when building `parameter_lookup` so
/// the two keyings agree.
pub fn track_identity_key(track_id: Option<&str>, track_name: Option<&str>) -> String {
    track_id
        .filter(|id| !id.is_empty())
        .or(track_name)
        .unwrap_or_default()
        .to_string()
}

/// Compute before/after values for a session's parameter changes.
///
/// Events are grouped by (track, device, parameter) and walked in time order:
/// `after` is the event's value and `before` is the previous value in that group.
/// The first change in a group has `before = None` (the pre-session value is
/// unknown — the snapshot reflects the *final* state, so it can't stand in for the
/// initial one without lying). `parameter_id` is linked when the named parameter
/// exists in the materialized tree. The grouping key's track component is
/// `track_identity_key`, not the raw name — see its doc comment.
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
    let mut previous_percent: HashMap<(String, String, String), f64> = HashMap::new();
    let mut previous_display: HashMap<(String, String, String), String> = HashMap::new();
    let mut rows = Vec::new();

    for change in changes {
        let Some(parameter_name) = change.parameter_name.clone() else {
            continue; // not a parameter change without a parameter name
        };

        let key = (
            track_identity_key(change.track_id.as_deref(), change.track_name.as_deref()),
            change.device_name.clone().unwrap_or_default(),
            parameter_name.clone(),
        );

        let before_value = change
            .previous_value
            .or_else(|| previous.get(&key).copied());
        let after_value = change.value;
        let before_value_percent = change
            .previous_value_percent
            .or_else(|| previous_percent.get(&key).copied());
        let after_value_percent = change.value_percent;
        let before_display_value = change
            .previous_display_value
            .clone()
            .or_else(|| previous_display.get(&key).cloned());
        let after_display_value = change.display_value.clone();

        rows.push(ParameterChange {
            id: format!("pc::{}", change.event_id),
            parameter_id: parameter_lookup.get(&key).cloned(),
            track_name: change.track_name.clone(),
            track_id: change.track_id.clone(),
            device_name: change.device_name.clone(),
            parameter_name: Some(parameter_name),
            before_value,
            after_value,
            before_value_percent,
            after_value_percent,
            unit: None,
            before_display_value,
            after_display_value: after_display_value.clone(),
            is_quantized: change.is_quantized,
            reason: None,
            changed_at_ms: change.timestamp_ms,
        });

        if let Some(value) = after_value {
            previous.insert(key.clone(), value);
        }

        if let Some(value) = after_value_percent {
            previous_percent.insert(key.clone(), value);
        }

        if let Some(display) = after_display_value {
            previous_display.insert(key, display);
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

    // The exact payload shape _serialize_track now sends: a group parent, and a
    // child carrying group_track_id pointing at the parent's id. Before the
    // script sent that key this field was always None, so group nesting could not
    // be rebuilt even though every layer below the script already supported it.
    // The child's group_ableton_id must land in the SAME id space as the parent's
    // ableton_id, or parent and child can never be matched up.
    #[test]
    fn a_child_track_records_the_group_it_belongs_to() {
        let payload = json!({
            "tracks": [
                { "index": 0, "id": "g1", "name": "Drums", "is_foldable": true, "devices": [] },
                { "index": 1, "id": "t2", "name": "Kick", "group_track_id": "g1", "devices": [] }
            ]
        });

        let tracks = parse_session_tree(&payload);
        let parent = &tracks[0];
        let child = &tracks[1];

        assert_eq!(parent.track_type, TrackType::Group);
        assert_eq!(parent.group_ableton_id, None, "a top-level group has no parent");
        assert_eq!(child.group_ableton_id.as_deref(), Some("g1"));
        assert_eq!(
            child.group_ableton_id.as_deref(),
            parent.ableton_id.as_deref(),
            "the child's group pointer must be in the same id space as the parent's id"
        );
    }

    // Older bridge builds send neither key; absent must stay absent rather than
    // becoming a track that claims to belong to a group called "".
    #[test]
    fn a_track_without_a_group_pointer_has_no_group() {
        let payload = json!({
            "tracks": [{ "index": 0, "id": "t1", "name": "Kick", "devices": [] }]
        });
        assert_eq!(parse_session_tree(&payload)[0].group_ableton_id, None);
    }

    // Live hands back an int for track colour; the script forwards it raw.
    #[test]
    fn track_colour_survives_as_the_raw_value_live_sent() {
        let payload = json!({
            "tracks": [{ "index": 0, "id": "t1", "name": "Kick", "color": 16711680, "devices": [] }]
        });
        assert_eq!(
            parse_session_tree(&payload)[0].color.as_deref(),
            Some("16711680")
        );
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
                track_id: None,
                device_name: Some("Synth".into()),
                parameter_name: Some("Cutoff".into()),
                value: Some(0.20),
                previous_value: None,
                value_percent: None,
                previous_value_percent: None,
                display_value: None,
                previous_display_value: None,
                is_quantized: None,
            },
            ChangeEvent {
                event_id: 2,
                timestamp_ms: 200,
                track_name: Some("Bass 1".into()),
                track_id: None,
                device_name: Some("Synth".into()),
                parameter_name: Some("Cutoff".into()),
                value: Some(0.55),
                previous_value: None,
                value_percent: None,
                previous_value_percent: None,
                display_value: None,
                previous_display_value: None,
                is_quantized: None,
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
                track_id: None,
                device_name: Some("D".into()),
                parameter_name: Some("A".into()),
                value: Some(1.0),
                previous_value: None,
                value_percent: None,
                previous_value_percent: None,
                display_value: None,
                previous_display_value: None,
                is_quantized: None,
            },
            ChangeEvent {
                event_id: 2,
                timestamp_ms: 150,
                track_name: Some("T".into()),
                track_id: None,
                device_name: Some("D".into()),
                parameter_name: Some("B".into()),
                value: Some(9.0),
                previous_value: None,
                value_percent: None,
                previous_value_percent: None,
                display_value: None,
                previous_display_value: None,
                is_quantized: None,
            },
        ];
        let rows = build_parameter_changes(changes, &HashMap::new());
        // Each first-in-group change has no before value.
        assert!(rows.iter().all(|r| r.before_value.is_none()));
        assert!(rows.iter().all(|r| r.parameter_id.is_none()));
    }

    #[test]
    fn explicit_previous_values_and_percents_win_on_first_change() {
        let changes = vec![ChangeEvent {
            event_id: 1,
            timestamp_ms: 100,
            track_name: Some("Bass 1".into()),
            track_id: None,
            device_name: Some("Synth".into()),
            parameter_name: Some("Cutoff".into()),
            value: Some(0.8),
            previous_value: Some(0.2),
            value_percent: Some(80.0),
            previous_value_percent: Some(20.0),
            display_value: None,
            previous_display_value: None,
            is_quantized: None,
        }];

        let rows = build_parameter_changes(changes, &HashMap::new());

        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].before_value, Some(0.2));
        assert_eq!(rows[0].after_value, Some(0.8));
        assert_eq!(rows[0].before_value_percent, Some(20.0));
        assert_eq!(rows[0].after_value_percent, Some(80.0));
    }

    #[test]
    fn same_track_name_different_track_id_do_not_share_history() {
        // Two distinct Ableton tracks that happen to share a name (Ableton
        // auto-names a track after its first device, so it's easy to end up
        // with two separate "Serum 2" tracks) must not be treated as the same
        // track just because the name collides.
        let changes = vec![
            ChangeEvent {
                event_id: 1,
                timestamp_ms: 100,
                track_name: Some("Serum 2".into()),
                track_id: Some("111".into()),
                device_name: Some("Serum 2".into()),
                parameter_name: Some("Cutoff".into()),
                value: Some(0.20),
                previous_value: None,
                value_percent: None,
                previous_value_percent: None,
                display_value: None,
                previous_display_value: None,
                is_quantized: None,
            },
            ChangeEvent {
                event_id: 2,
                timestamp_ms: 200,
                track_name: Some("Serum 2".into()),
                track_id: Some("222".into()),
                device_name: Some("Serum 2".into()),
                parameter_name: Some("Cutoff".into()),
                value: Some(0.90),
                previous_value: None,
                value_percent: None,
                previous_value_percent: None,
                display_value: None,
                previous_display_value: None,
                is_quantized: None,
            },
        ];

        let rows = build_parameter_changes(changes, &HashMap::new());
        assert_eq!(rows.len(), 2);
        // Both are the first change in their own group: neither inherits the
        // other's "before" value, because they're different tracks despite
        // sharing a name.
        assert!(rows.iter().all(|r| r.before_value.is_none()));
        assert_eq!(rows[0].track_id.as_deref(), Some("111"));
        assert_eq!(rows[1].track_id.as_deref(), Some("222"));
    }

    #[test]
    fn track_identity_key_prefers_id_falls_back_to_name() {
        assert_eq!(track_identity_key(Some("42"), Some("Serum 2")), "42");
        assert_eq!(track_identity_key(None, Some("Serum 2")), "Serum 2");
        assert_eq!(track_identity_key(None, None), "");
    }

    // The reason this function exists at all (see its doc comment): Ableton
    // auto-names a track after its first device, so two unrelated tracks are
    // routinely both called "Serum 2". Keying on the name would splice their
    // before/after parameter chains into one, inventing transitions that never
    // happened. Distinct ids must stay distinct even when the names are identical.
    #[test]
    fn track_identity_key_separates_two_tracks_that_share_a_name() {
        let left = track_identity_key(Some("42"), Some("Serum 2"));
        let right = track_identity_key(Some("77"), Some("Serum 2"));
        assert_ne!(left, right);
    }

    // An id present but blank is the same thing as no id — it must fall through
    // to the name rather than keying every such track to one shared "" bucket,
    // which would splice all of them together.
    #[test]
    fn track_identity_key_treats_a_blank_id_as_absent() {
        assert_eq!(track_identity_key(Some(""), Some("Serum 2")), "Serum 2");
    }

    // The documented limit of the legacy fallback, pinned honestly: events captured
    // before the bridge sent track_id have only a name to go on, so two same-named
    // tracks DO collide there. This is accepted behavior for old sessions, not a
    // bug to fix silently — if it ever changes, it should change deliberately.
    #[test]
    fn track_identity_key_still_collides_for_legacy_events_with_no_id() {
        assert_eq!(
            track_identity_key(None, Some("Serum 2")),
            track_identity_key(None, Some("Serum 2")),
        );
    }

    #[test]
    fn note_edit_reads_the_bridge_payload() {
        let payload = json!({
            "track_name": "Bass",
            "clip_name": "Verse",
            "change_kind": "notes_added",
            "note_count": 16,
            "previous_note_count": 12,
            "distinct_pitches": 5,
            "pitch_range": "C1-G2",
            "previous_pitch_range": "C1-G1",
            "velocity_mean": 96.7,
            "length_beats": 8.0,
            "summary": "16 notes (+4), C1-G1 -> C1-G2"
        })
        .to_string();

        let edit = parse_note_edit(42, 1_700_000_000_000, None, None, Some(&payload)).expect("parsed");

        assert_eq!(edit.id, "note-edit-42");
        assert_eq!(edit.track_name.as_deref(), Some("Bass"));
        assert_eq!(edit.clip_name.as_deref(), Some("Verse"));
        assert_eq!(edit.change_kind.as_deref(), Some("notes_added"));
        assert_eq!(edit.note_count, Some(16));
        assert_eq!(edit.previous_note_count, Some(12));
        assert_eq!(edit.summary.as_deref(), Some("16 notes (+4), C1-G1 -> C1-G2"));
        assert_eq!(edit.changed_at_ms, 1_700_000_000_000);
    }

    #[test]
    fn note_edit_prefers_the_first_class_track_column() {
        // The column is what every other read path joins on; a stale payload
        // name must not win over it.
        let payload = json!({ "track_name": "payload name", "note_count": 4 }).to_string();
        let edit = parse_note_edit(1, 0, Some("column name".into()), Some("stable-id".into()), Some(&payload)).unwrap();
        assert_eq!(edit.track_name.as_deref(), Some("column name"));
        assert_eq!(edit.track_id.as_deref(), Some("stable-id"));
    }

    #[test]
    fn note_edit_rejects_unusable_rows() {
        // No payload, or one that isn't JSON, yields nothing rather than a row
        // that would occupy a line of the story saying nothing.
        assert!(parse_note_edit(1, 0, None, None, None).is_none());
        assert!(parse_note_edit(1, 0, None, None, Some("not json")).is_none());
    }

    #[test]
    fn note_edit_survives_a_sparse_payload() {
        // An older bridge sending only the essentials still renders.
        let payload = json!({ "note_count": 3 }).to_string();
        let edit = parse_note_edit(7, 5, None, None, Some(&payload)).expect("parsed");
        assert_eq!(edit.note_count, Some(3));
        assert!(edit.summary.is_none());
        assert!(edit.pitch_range.is_none());
    }
}
