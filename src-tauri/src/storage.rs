use crate::protocol::RecallEvent;
use crate::session::SessionStatus;
use rusqlite::{params, Connection};
use serde::Serialize;
use std::{
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

#[derive(Debug, Clone, Serialize)]
pub struct StorageStatus {
    pub initialized: bool,
    pub db_path: Option<String>,
}

#[derive(Debug, Clone)]
pub struct StorageState {
    db_path: Option<PathBuf>,
    initialized: bool,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("System time error")
        .as_millis() as u64
}

impl StorageState {
    pub fn new() -> Self {
        Self {
            db_path: None,
            initialized: false,
        }
    }

    pub fn configure(&mut self, db_path: PathBuf) {
        self.db_path = Some(db_path);
        self.initialized = true;
    }

    pub fn status(&self) -> StorageStatus {
        StorageStatus {
            initialized: self.initialized,
            db_path: self
                .db_path
                .as_ref()
                .map(|path| path.to_string_lossy().to_string()),
        }
    }

    fn database_path(&self) -> Result<&Path, String> {
        self.db_path
            .as_deref()
            .ok_or_else(|| "Database path has not been configured".to_string())
    }

    fn open_connection(&self) -> Result<Connection, String> {
        let connection = Connection::open(self.database_path()?)
            .map_err(|error| format!("Failed to open SQLite database: {}", error))?;

        connection
            .execute_batch("PRAGMA foreign_keys = ON;")
            .map_err(|error| format!("Failed to enable SQLite foreign keys: {}", error))?;

        Ok(connection)
    }

    pub fn save_session_started(&self, status: &SessionStatus) -> Result<(), String> {
        let Some(session_id) = status.session_id.as_deref() else {
            return Ok(());
        };

        let Some(started_at_ms) = status.started_at_ms else {
            return Ok(());
        };

        let connection = self.open_connection()?;

        connection
            .execute(
                "
                INSERT OR IGNORE INTO sessions (
                    id,
                    started_at_ms,
                    ended_at_ms,
                    created_at_ms
                )
                VALUES (?1, ?2, NULL, ?3)
                ",
                params![session_id, started_at_ms as i64, now_ms() as i64],
            )
            .map_err(|error| format!("Failed to save session start: {}", error))?;

        Ok(())
    }

    pub fn save_session_stopped(&self, status: &SessionStatus) -> Result<(), String> {
        let Some(session_id) = status.session_id.as_deref() else {
            return Ok(());
        };

        let Some(ended_at_ms) = status.ended_at_ms else {
            return Ok(());
        };

        let connection = self.open_connection()?;

        connection
            .execute(
                "
                UPDATE sessions
                SET ended_at_ms = ?1
                WHERE id = ?2
                ",
                params![ended_at_ms as i64, session_id],
            )
            .map_err(|error| format!("Failed to save session stop: {}", error))?;

        Ok(())
    }

    pub fn save_event(&self, event: &RecallEvent) -> Result<(), String> {
        if event.session_id.is_none() {
            return Ok(());
        }

        let connection = self.open_connection()?;

        connection
            .execute(
                "
                INSERT INTO events (
                    session_id,
                    protocol,
                    source,
                    event_type,
                    timestamp_ms,
                    title,
                    description,
                    payload,
                    created_at_ms
                )
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
                ",
                params![
                    event.session_id.as_deref(),
                    event.protocol.as_str(),
                    event.source.as_str(),
                    event.event_type.as_str(),
                    event.timestamp_ms as i64,
                    event.title.as_str(),
                    event.description.as_str(),
                    event.payload.as_deref(),
                    now_ms() as i64,
                ],
            )
            .map_err(|error| format!("Failed to save event: {}", error))?;

        Ok(())
    }
}

pub fn initialize_database(db_path: &Path) -> rusqlite::Result<()> {
    let connection = Connection::open(db_path)?;

    connection.execute_batch(
        "
        PRAGMA foreign_keys = ON;

        CREATE TABLE IF NOT EXISTS sessions (
            id TEXT PRIMARY KEY,
            started_at_ms INTEGER NOT NULL,
            ended_at_ms INTEGER,
            created_at_ms INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT,
            protocol TEXT NOT NULL,
            source TEXT NOT NULL,
            event_type TEXT NOT NULL,
            timestamp_ms INTEGER NOT NULL,
            title TEXT NOT NULL,
            description TEXT NOT NULL,
            payload TEXT,
            created_at_ms INTEGER NOT NULL,
            FOREIGN KEY(session_id) REFERENCES sessions(id)
        );

        CREATE INDEX IF NOT EXISTS idx_events_session_id
        ON events(session_id);

        CREATE INDEX IF NOT EXISTS idx_events_timestamp_ms
        ON events(timestamp_ms);
        ",
    )?;

    Ok(())
}
