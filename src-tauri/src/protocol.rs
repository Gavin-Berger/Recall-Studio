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
}
