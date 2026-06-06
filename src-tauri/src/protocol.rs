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
    #[serde(default)]
    pub device_name: Option<String>,
    #[serde(default)]
    pub parameter_name: Option<String>,
    #[serde(default)]
    pub parameter_value: Option<f64>,
    #[serde(default)]
    pub clip_name: Option<String>,
    // Sample/file backing an audio clip (e.g. a Splice drag-in). sample_name is
    // the bare file name for display; file_path is the full on-disk source.
    #[serde(default)]
    pub sample_name: Option<String>,
    #[serde(default)]
    pub file_path: Option<String>,
    // Ordered, colon-separated device chain for the selected track, e.g.
    // "Serum 2 : Saturator : Vocoder". Read straight from Ableton via the bridge.
    #[serde(default)]
    pub device_chain: Option<String>,
    #[serde(default)]
    pub bpm: Option<f64>,
    #[serde(default)]
    pub playing: Option<bool>,
}
