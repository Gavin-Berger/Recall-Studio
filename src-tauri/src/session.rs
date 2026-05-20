use serde::Serialize;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Serialize)]
pub struct SessionStatus {
    pub active: bool,
    pub session_id: Option<String>,
    pub started_at_ms: Option<u64>,
    pub ended_at_ms: Option<u64>,
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
}
