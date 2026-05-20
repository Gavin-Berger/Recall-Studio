use rusqlite::Connection;
use serde::Serialize;
use std::path::{Path, PathBuf};

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
