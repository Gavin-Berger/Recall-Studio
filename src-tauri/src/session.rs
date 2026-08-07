use crate::protocol::RecallEvent;
use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Serialize)]
pub struct SessionStatus {
    pub active: bool,
    pub session_id: Option<String>,
    pub started_at_ms: Option<u64>,
    pub ended_at_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SavedSessionMetadata {
    pub id: String,
    pub name: String,
    pub project_id: Option<String>,
    pub capture_name: Option<String>,
    pub capture_status: String,
    pub project_name: Option<String>,
    pub project_path: Option<String>,
    // The specific `.als` file this take is anchored to (its durable identity for
    // resume/relink), and whether the take was `recorded` (has live telemetry) or
    // `scanned` (a version found on disk by a folder scan, no events yet).
    pub als_path: Option<String>,
    pub take_origin: String,
    pub display_name: Option<String>,
    pub started_at_ms: u64,
    pub ended_at_ms: Option<u64>,
    pub last_updated_at_ms: u64,
    pub event_count: usize,
    pub creative_event_count: usize,
    pub heartbeat_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SavedSession {
    pub id: String,
    pub name: String,
    pub project_id: Option<String>,
    pub capture_name: Option<String>,
    pub capture_status: String,
    pub project_name: Option<String>,
    pub project_path: Option<String>,
    pub als_path: Option<String>,
    pub take_origin: String,
    pub display_name: Option<String>,
    pub started_at_ms: u64,
    pub ended_at_ms: Option<u64>,
    pub last_updated_at_ms: u64,
    pub event_count: usize,
    pub creative_event_count: usize,
    pub heartbeat_count: usize,
    pub events: Vec<SavedSessionEvent>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectFolderMetadata {
    pub created_at_ms: Option<u64>,
    pub modified_at_ms: Option<u64>,
    pub latest_file_modified_at_ms: Option<u64>,
    pub file_count: usize,
    pub total_size_bytes: u64,
    pub als_file_count: usize,
    pub audio_file_count: usize,
    pub scanned_at_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SavedProject {
    pub id: String,
    pub display_name: String,
    pub ableton_name: Option<String>,
    pub ableton_path: Option<String>,
    pub archived_at_ms: Option<u64>,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
    pub last_updated_at_ms: u64,
    pub capture_count: usize,
    pub active_capture_count: usize,
    pub captures: Vec<SavedSessionMetadata>,
    /// A cached snapshot of the connected Windows folder. This is refreshed by
    /// an explicit scan rather than every library poll, because traversing a
    /// sample-heavy Ableton project can be expensive.
    pub folder_metadata: Option<ProjectFolderMetadata>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SavedSessionEvent {
    pub id: String,
    #[serde(rename = "type")]
    pub event_type: String,
    pub timestamp_ms: u64,
    pub summary: Option<String>,
    pub title: String,
    pub description: String,
    pub source: String,
    pub payload: Option<String>,
    pub session_id: Option<String>,
    // Canonical structured fields, mirrored from the `events` table columns. These
    // are populated first-class on load (with a payload fallback for legacy rows)
    // so a reloaded session is as rich as it was live — no payload digging needed.
    // `track`/`device`/`parameter` keep their short names for frontend back-compat;
    // they hold the track_name / device_name / parameter_name values.
    pub track: Option<String>,
    pub track_type: Option<String>,
    pub device: Option<String>,
    pub device_chain: Option<String>,
    pub parameter: Option<String>,
    pub parameter_value: Option<f64>,
    pub previous_parameter_value: Option<f64>,
    pub parameter_value_percent: Option<f64>,
    pub previous_parameter_value_percent: Option<f64>,
    // Live-formatted display: mode name for quantized params ("Sinefold"), or the
    // unit-bearing value for continuous ones ("440 Hz"). parameter_is_quantized
    // distinguishes the two so the UI can render a mode label vs a numeric value.
    pub parameter_display_value: Option<String>,
    pub previous_parameter_display_value: Option<String>,
    pub parameter_is_quantized: Option<bool>,
    pub clip_name: Option<String>,
    pub sample_name: Option<String>,
    pub file_path: Option<String>,
    pub bpm: Option<f64>,
    pub playing: Option<bool>,
    pub is_heartbeat: bool,
}

impl From<RecallEvent> for SavedSessionEvent {
    fn from(event: RecallEvent) -> Self {
        let is_heartbeat = event.event_type == "heartbeat";

        Self {
            id: format!(
                "{}-{}-{}",
                event.session_id.as_deref().unwrap_or("unsaved-session"),
                event.event_type,
                event.timestamp_ms
            ),
            event_type: event.event_type,
            timestamp_ms: event.timestamp_ms,
            summary: Some(event.title.clone()),
            title: event.title,
            description: event.description,
            source: event.source,
            payload: event.payload,
            session_id: event.session_id,
            // Carry the structured fields through instead of dropping them.
            track: event.track_name,
            track_type: event.track_type,
            device: event.device_name,
            device_chain: event.device_chain,
            parameter: event.parameter_name,
            parameter_value: event.parameter_value,
            previous_parameter_value: event.previous_parameter_value,
            parameter_value_percent: event.parameter_value_percent,
            previous_parameter_value_percent: event.previous_parameter_value_percent,
            parameter_display_value: event.parameter_display_value,
            previous_parameter_display_value: event.previous_parameter_display_value,
            parameter_is_quantized: event.parameter_is_quantized,
            clip_name: event.clip_name,
            sample_name: event.sample_name,
            file_path: event.file_path,
            bpm: event.bpm,
            playing: event.playing,
            is_heartbeat,
        }
    }
}

#[derive(Debug, Clone)]
pub struct SessionState {
    active: bool,
    session_id: Option<String>,
    started_at_ms: Option<u64>,
    ended_at_ms: Option<u64>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("System time error")
        .as_millis() as u64
}

impl SessionState {
    pub fn new() -> Self {
        Self {
            active: false,
            session_id: None,
            started_at_ms: None,
            ended_at_ms: None,
        }
    }

    pub fn start(&mut self) -> SessionStatus {
        if self.active {
            return self.status();
        }

        let started_at_ms = now_ms();

        self.active = true;
        self.session_id = Some(format!("session-{}", started_at_ms));
        self.started_at_ms = Some(started_at_ms);
        self.ended_at_ms = None;

        self.status()
    }

    pub fn restore_active(&mut self, session_id: String, started_at_ms: u64) -> SessionStatus {
        self.active = true;
        self.session_id = Some(session_id);
        self.started_at_ms = Some(started_at_ms);
        self.ended_at_ms = None;

        self.status()
    }

    pub fn stop(&mut self) -> SessionStatus {
        if !self.active {
            return self.status();
        }

        self.active = false;
        self.ended_at_ms = Some(now_ms());

        self.status()
    }

    pub fn status(&self) -> SessionStatus {
        SessionStatus {
            active: self.active,
            session_id: self.session_id.clone(),
            started_at_ms: self.started_at_ms,
            ended_at_ms: self.ended_at_ms,
        }
    }

    pub fn active_session_id(&self) -> Option<String> {
        if self.active {
            return self.session_id.clone();
        }

        None
    }
}
