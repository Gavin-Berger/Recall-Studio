use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecallEvent {
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
    #[serde(default)]
    pub bpm: Option<f64>,
    #[serde(default)]
    pub playing: Option<bool>,
}
