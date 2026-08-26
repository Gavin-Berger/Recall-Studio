use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecallEvent {
    // SQLite rowid, stamped in once the event is persisted. Carried into the
    // live-emitted event so a live event shares the same identity it will have
    // when the session is later loaded from the database. None until persisted.
    #[serde(default)]
    pub id: Option<i64>,
    pub protocol: String,
    pub source: String,
    pub event_type: String,
    pub timestamp_ms: u64,
    pub title: String,
    pub description: String,
    pub payload: Option<String>,

    // Assigned by Recall Studio when a producer session is active.
    // Why: Max for Live should not decide app session ownership.
    pub session_id: Option<String>,

    // Structured fields extracted from the event payload at ingestion time.
    // These are canonical — the frontend reads these directly without fallback guessing.
    // Fields are optional because older v1 events may not include them.
    #[serde(default)]
    pub track_name: Option<String>,
    // Live's stable per-track pointer (bridge sends `str(track._live_ptr)`), the
    // same identifier space as `TrackObj.ableton_id` in the schema snapshot. Two
    // tracks can share a `track_name` (Ableton auto-names a track after the first
    // device dropped on it, e.g. "Serum 2") but never share this. Absent on older
    // bridge builds that predate it — callers must fall back to track_name.
    #[serde(default)]
    pub track_id: Option<String>,
    // Live's stable per-device pointer (bridge sends `str(device._live_ptr)`).
    // Device display names are not unique: a track can contain two EQ Eights.
    #[serde(default)]
    pub device_id: Option<String>,
    // The kind of track the event is about: "audio", "midi", "return", "group",
    // or "master". Lets the timeline say *what* a producer was working on, not
    // just its name — audio vs MIDI vs a bus are different creative contexts.
    #[serde(default)]
    pub track_type: Option<String>,
    #[serde(default)]
    pub device_name: Option<String>,
    #[serde(default)]
    pub parameter_name: Option<String>,
    #[serde(default)]
    pub parameter_value: Option<f64>,
    #[serde(default)]
    pub previous_parameter_value: Option<f64>,
    #[serde(default)]
    pub parameter_value_percent: Option<f64>,
    #[serde(default)]
    pub previous_parameter_value_percent: Option<f64>,
    // Live-formatted display strings: the mode name for quantized params
    // ("Sinefold", "Analog Clip") or the unit-bearing value for continuous ones
    // ("440 Hz", "-12.0 dB"). parameter_is_quantized tells the frontend which
    // kind it is, so categorical modes and numeric values can render differently.
    #[serde(default)]
    pub parameter_display_value: Option<String>,
    #[serde(default)]
    pub previous_parameter_display_value: Option<String>,
    #[serde(default)]
    pub parameter_is_quantized: Option<bool>,
    #[serde(default)]
    pub clip_name: Option<String>,
    // Sample/file backing an audio clip (e.g. a Splice drag-in). sample_name is
    // the bare file name for display; file_path is the full on-disk source.
    #[serde(default)]
    pub sample_name: Option<String>,
    #[serde(default)]
    pub file_path: Option<String>,
    // Live Set identity. project_name is what Ableton calls the set; project_path
    // lets Recall group different captures of the same .als when Live exposes it.
    #[serde(default)]
    pub project_name: Option<String>,
    #[serde(default)]
    pub project_path: Option<String>,
    // Ordered, colon-separated device chain for the selected track, e.g.
    // "Serum 2 : Saturator : Vocoder". Read straight from Ableton via the bridge.
    #[serde(default)]
    pub device_chain: Option<String>,
    #[serde(default)]
    pub bpm: Option<f64>,
    #[serde(default)]
    pub playing: Option<bool>,
    // Universal musical-location context stamped at the bridge's common emit
    // boundary. This is where Live's playhead was when the event was observed;
    // it is deliberately separate from an object's own Arrangement range.
    #[serde(default)]
    pub observed_arrangement_position: Option<String>,
    #[serde(default)]
    pub observed_arrangement_beats: Option<f64>,
    // Exact global beat range for an Arrangement object such as a clip. Session
    // clips leave these empty because their start_time is playback state, not a
    // durable place in the song.
    #[serde(default)]
    pub arrangement_start_beats: Option<f64>,
    #[serde(default)]
    pub arrangement_end_beats: Option<f64>,
}
