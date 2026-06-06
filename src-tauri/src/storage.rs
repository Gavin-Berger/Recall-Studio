use crate::protocol::RecallEvent;
use crate::session::{SavedSession, SavedSessionEvent, SavedSessionMetadata, SessionStatus};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use serde_json::Value;
use std::{
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

#[derive(Debug, Clone, Serialize)]
pub struct StorageStatus {
    pub initialized: bool,
    pub db_path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct EventCuration {
    pub event_id: String,
    pub hidden: bool,
    pub title_override: Option<String>,
    pub description_override: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct StoredSessionNote {
    pub id: String,
    pub linked_event_id: Option<String>,
    pub text: String,
    pub session_timecode: String,
    pub created_at_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct SessionCuration {
    pub curations: Vec<EventCuration>,
    pub notes: Vec<StoredSessionNote>,
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

    pub fn resume_or_create_active_session(&self) -> Result<SessionStatus, String> {
        let connection = self.open_connection()?;

        let active_session = connection
            .query_row(
                "
                SELECT id, started_at_ms
                FROM sessions
                WHERE ended_at_ms IS NULL
                ORDER BY started_at_ms DESC
                LIMIT 1
                ",
                [],
                |row| {
                    Ok(SessionStatus {
                        active: true,
                        session_id: Some(row.get::<_, String>(0)?),
                        started_at_ms: Some(row.get::<_, i64>(1)? as u64),
                        ended_at_ms: None,
                    })
                },
            )
            .optional()
            .map_err(|error| format!("Failed to query active session: {}", error))?;

        if let Some(status) = active_session {
            return Ok(status);
        }

        let started_at_ms = now_ms();
        let status = SessionStatus {
            active: true,
            session_id: Some(format!("session-{}", started_at_ms)),
            started_at_ms: Some(started_at_ms),
            ended_at_ms: None,
        };

        self.save_session_started(&status)?;

        Ok(status)
    }

    pub fn list_saved_sessions(&self) -> Result<Vec<SavedSessionMetadata>, String> {
        let connection = self.open_connection()?;

        let mut statement = connection
            .prepare(
                "
                SELECT
                    sessions.id,
                    sessions.started_at_ms,
                    sessions.ended_at_ms,
                    COALESCE(MAX(events.created_at_ms), sessions.created_at_ms) AS last_updated_at_ms,
                    COUNT(events.id) AS event_count,
                    SUM(CASE WHEN events.id IS NOT NULL AND events.event_type != 'heartbeat' THEN 1 ELSE 0 END) AS creative_event_count,
                    SUM(CASE WHEN events.id IS NOT NULL AND events.event_type = 'heartbeat' THEN 1 ELSE 0 END) AS heartbeat_count
                FROM sessions
                LEFT JOIN events ON events.session_id = sessions.id
                GROUP BY sessions.id, sessions.started_at_ms, sessions.ended_at_ms, sessions.created_at_ms
                ORDER BY last_updated_at_ms DESC
                ",
            )
            .map_err(|error| format!("Failed to prepare saved sessions query: {}", error))?;

        let rows = statement
            .query_map([], |row| {
                let id: String = row.get(0)?;
                let started_at_ms = row.get::<_, i64>(1)? as u64;
                let ended_at_ms = row.get::<_, Option<i64>>(2)?.map(|value| value as u64);
                let last_updated_at_ms = row.get::<_, i64>(3)? as u64;
                let event_count = row.get::<_, i64>(4)? as usize;
                let creative_event_count = row.get::<_, Option<i64>>(5)?.unwrap_or(0) as usize;
                let heartbeat_count = row.get::<_, Option<i64>>(6)?.unwrap_or(0) as usize;

                Ok(SavedSessionMetadata {
                    name: session_name(&id, started_at_ms),
                    id,
                    started_at_ms,
                    ended_at_ms,
                    last_updated_at_ms,
                    event_count,
                    creative_event_count,
                    heartbeat_count,
                })
            })
            .map_err(|error| format!("Failed to read saved sessions: {}", error))?;

        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("Failed to collect saved sessions: {}", error))
    }

    pub fn load_session(&self, session_id: &str) -> Result<SavedSession, String> {
        let metadata = self
            .list_saved_sessions()?
            .into_iter()
            .find(|session| session.id == session_id)
            .ok_or_else(|| format!("Saved session not found: {}", session_id))?;

        let connection = self.open_connection()?;

        let mut statement = connection
            .prepare(
                "
                SELECT
                    id,
                    source,
                    event_type,
                    timestamp_ms,
                    title,
                    description,
                    payload,
                    session_id,
                    track_name,
                    track_type,
                    device_name,
                    device_chain,
                    parameter_name,
                    parameter_value,
                    clip_name,
                    sample_name,
                    file_path,
                    bpm,
                    playing
                FROM events
                WHERE session_id = ?1
                ORDER BY timestamp_ms ASC, id ASC
                ",
            )
            .map_err(|error| format!("Failed to prepare session events query: {}", error))?;

        let rows = statement
            .query_map(params![session_id], |row| {
                let id = row.get::<_, i64>(0)?.to_string();
                let source: String = row.get(1)?;
                let event_type: String = row.get(2)?;
                let timestamp_ms = row.get::<_, i64>(3)? as u64;
                let title: String = row.get(4)?;
                let description: String = row.get(5)?;
                let payload: Option<String> = row.get(6)?;
                let session_id: Option<String> = row.get(7)?;

                // Canonical columns. NULL for rows written before the columns
                // existed; those fall back to the payload JSON below.
                let track_name: Option<String> = row.get(8)?;
                let track_type: Option<String> = row.get(9)?;
                let device_name: Option<String> = row.get(10)?;
                let device_chain: Option<String> = row.get(11)?;
                let parameter_name: Option<String> = row.get(12)?;
                let parameter_value: Option<f64> = row.get(13)?;
                let clip_name: Option<String> = row.get(14)?;
                let sample_name: Option<String> = row.get(15)?;
                let file_path: Option<String> = row.get(16)?;
                let bpm: Option<f64> = row.get(17)?;
                let playing: Option<i64> = row.get(18)?;

                let payload_json = payload
                    .as_deref()
                    .and_then(|payload| serde_json::from_str::<Value>(payload).ok());
                let pj = payload_json.as_ref();

                // For each field: prefer the first-class column, else recover it
                // from the payload JSON (legacy rows). This keeps old sessions just
                // as rich as new ones with no data migration of existing rows.
                Ok(SavedSessionEvent {
                    id,
                    event_type: event_type.clone(),
                    timestamp_ms,
                    summary: Some(title.clone()),
                    title,
                    description,
                    source,
                    track: track_name.or_else(|| read_payload_string(pj, &["track", "track_name"])),
                    track_type: track_type.or_else(|| read_payload_string(pj, &["track_type"])),
                    device: device_name
                        .or_else(|| read_payload_string(pj, &["device", "device_name"])),
                    device_chain: device_chain
                        .or_else(|| read_payload_string(pj, &["device_chain", "chain"])),
                    parameter: parameter_name
                        .or_else(|| read_payload_string(pj, &["parameter", "parameter_name"])),
                    parameter_value: parameter_value
                        .or_else(|| read_payload_f64(pj, &["parameter_value", "value"])),
                    clip_name: clip_name.or_else(|| read_payload_string(pj, &["clip_name", "clip"])),
                    sample_name: sample_name
                        .or_else(|| read_payload_string(pj, &["sample_name", "sample"])),
                    file_path: file_path
                        .or_else(|| read_payload_string(pj, &["file_path", "path"])),
                    bpm: bpm.or_else(|| read_payload_f64(pj, &["bpm", "tempo"])),
                    playing: playing
                        .map(|value| value != 0)
                        .or_else(|| read_payload_bool(pj, &["playing", "is_playing"])),
                    payload,
                    session_id,
                    is_heartbeat: event_type == "heartbeat",
                })
            })
            .map_err(|error| format!("Failed to read saved session events: {}", error))?;

        let events = rows
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("Failed to collect saved session events: {}", error))?;

        Ok(SavedSession {
            id: metadata.id,
            name: metadata.name,
            started_at_ms: metadata.started_at_ms,
            ended_at_ms: metadata.ended_at_ms,
            last_updated_at_ms: metadata.last_updated_at_ms,
            event_count: metadata.event_count,
            creative_event_count: metadata.creative_event_count,
            heartbeat_count: metadata.heartbeat_count,
            events,
        })
    }

    pub fn delete_session(&self, session_id: &str) -> Result<(), String> {
        let mut connection = self.open_connection()?;
        let transaction = connection
            .transaction()
            .map_err(|error| format!("Failed to start session delete transaction: {}", error))?;

        transaction
            .execute(
                "DELETE FROM events WHERE session_id = ?1",
                params![session_id],
            )
            .map_err(|error| format!("Failed to delete session events: {}", error))?;

        transaction
            .execute(
                "DELETE FROM event_curation WHERE session_id = ?1",
                params![session_id],
            )
            .map_err(|error| format!("Failed to delete session curation: {}", error))?;

        transaction
            .execute(
                "DELETE FROM session_notes WHERE session_id = ?1",
                params![session_id],
            )
            .map_err(|error| format!("Failed to delete session notes: {}", error))?;

        let deleted_sessions = transaction
            .execute("DELETE FROM sessions WHERE id = ?1", params![session_id])
            .map_err(|error| format!("Failed to delete session: {}", error))?;

        if deleted_sessions == 0 {
            return Err(format!("Saved session not found: {}", session_id));
        }

        transaction
            .commit()
            .map_err(|error| format!("Failed to commit session delete: {}", error))?;

        Ok(())
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

    // Persist a batch of session-owned events in a single transaction on one
    // connection, returning the assigned rowid for each input event (None for
    // events that were not session-owned and therefore not written). Why batch:
    // the per-event path opens a fresh SQLite connection and commits on its own,
    // which is far too slow to run inline under burst. The worker drains the
    // queue and writes many events per transaction, keeping the receive loop
    // free and bounding disk pressure.
    pub fn save_events_batch(&self, events: &[RecallEvent]) -> Result<Vec<Option<i64>>, String> {
        let mut connection = self.open_connection()?;
        let transaction = connection
            .transaction()
            .map_err(|error| format!("Failed to start event batch transaction: {}", error))?;

        let mut rowids = Vec::with_capacity(events.len());

        {
            let mut statement = transaction
                .prepare_cached(
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
                        track_name,
                        track_type,
                        device_name,
                        device_chain,
                        parameter_name,
                        parameter_value,
                        clip_name,
                        sample_name,
                        file_path,
                        bpm,
                        playing,
                        created_at_ms
                    )
                    VALUES (
                        ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10,
                        ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20
                    )
                    ",
                )
                .map_err(|error| format!("Failed to prepare batch insert: {}", error))?;

            for event in events {
                if event.session_id.is_none() {
                    rowids.push(None);
                    continue;
                }

                statement
                    .execute(params![
                        event.session_id.as_deref(),
                        event.protocol.as_str(),
                        event.source.as_str(),
                        event.event_type.as_str(),
                        event.timestamp_ms as i64,
                        event.title.as_str(),
                        event.description.as_str(),
                        event.payload.as_deref(),
                        event.track_name.as_deref(),
                        event.track_type.as_deref(),
                        event.device_name.as_deref(),
                        event.device_chain.as_deref(),
                        event.parameter_name.as_deref(),
                        event.parameter_value,
                        event.clip_name.as_deref(),
                        event.sample_name.as_deref(),
                        event.file_path.as_deref(),
                        event.bpm,
                        // SQLite has no boolean type; store playing as 0/1, NULL if absent.
                        event.playing.map(|playing| playing as i64),
                        now_ms() as i64,
                    ])
                    .map_err(|error| format!("Failed to save event in batch: {}", error))?;

                rowids.push(Some(transaction.last_insert_rowid()));
            }
        }

        transaction
            .commit()
            .map_err(|error| format!("Failed to commit event batch: {}", error))?;

        Ok(rowids)
    }

    pub fn set_event_curation(
        &self,
        session_id: &str,
        event_id: &str,
        hidden: bool,
        title_override: Option<&str>,
        description_override: Option<&str>,
    ) -> Result<(), String> {
        let connection = self.open_connection()?;

        // No curation left on this event — drop the row to keep the table sparse.
        if !hidden && title_override.is_none() && description_override.is_none() {
            connection
                .execute(
                    "DELETE FROM event_curation WHERE session_id = ?1 AND event_id = ?2",
                    params![session_id, event_id],
                )
                .map_err(|error| format!("Failed to clear event curation: {}", error))?;

            return Ok(());
        }

        connection
            .execute(
                "
                INSERT INTO event_curation (
                    session_id,
                    event_id,
                    hidden,
                    title_override,
                    description_override,
                    updated_at_ms
                )
                VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                ON CONFLICT(session_id, event_id) DO UPDATE SET
                    hidden = excluded.hidden,
                    title_override = excluded.title_override,
                    description_override = excluded.description_override,
                    updated_at_ms = excluded.updated_at_ms
                ",
                params![
                    session_id,
                    event_id,
                    hidden as i64,
                    title_override,
                    description_override,
                    now_ms() as i64,
                ],
            )
            .map_err(|error| format!("Failed to save event curation: {}", error))?;

        Ok(())
    }

    pub fn list_session_curation(&self, session_id: &str) -> Result<SessionCuration, String> {
        let connection = self.open_connection()?;

        let mut curation_statement = connection
            .prepare(
                "
                SELECT event_id, hidden, title_override, description_override
                FROM event_curation
                WHERE session_id = ?1
                ",
            )
            .map_err(|error| format!("Failed to prepare curation query: {}", error))?;

        let curations = curation_statement
            .query_map(params![session_id], |row| {
                Ok(EventCuration {
                    event_id: row.get(0)?,
                    hidden: row.get::<_, i64>(1)? != 0,
                    title_override: row.get(2)?,
                    description_override: row.get(3)?,
                })
            })
            .map_err(|error| format!("Failed to read curation: {}", error))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("Failed to collect curation: {}", error))?;

        let mut note_statement = connection
            .prepare(
                "
                SELECT id, linked_event_id, text, session_timecode, created_at_ms
                FROM session_notes
                WHERE session_id = ?1
                ORDER BY created_at_ms ASC
                ",
            )
            .map_err(|error| format!("Failed to prepare notes query: {}", error))?;

        let notes = note_statement
            .query_map(params![session_id], |row| {
                Ok(StoredSessionNote {
                    id: row.get(0)?,
                    linked_event_id: row.get(1)?,
                    text: row.get(2)?,
                    session_timecode: row.get(3)?,
                    created_at_ms: row.get::<_, i64>(4)? as u64,
                })
            })
            .map_err(|error| format!("Failed to read notes: {}", error))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("Failed to collect notes: {}", error))?;

        Ok(SessionCuration { curations, notes })
    }

    pub fn add_session_note(
        &self,
        session_id: &str,
        note_id: &str,
        linked_event_id: Option<&str>,
        text: &str,
        session_timecode: &str,
        created_at_ms: u64,
    ) -> Result<(), String> {
        let connection = self.open_connection()?;

        connection
            .execute(
                "
                INSERT INTO session_notes (
                    id,
                    session_id,
                    linked_event_id,
                    text,
                    session_timecode,
                    created_at_ms
                )
                VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                ",
                params![
                    note_id,
                    session_id,
                    linked_event_id,
                    text,
                    session_timecode,
                    created_at_ms as i64,
                ],
            )
            .map_err(|error| format!("Failed to add session note: {}", error))?;

        Ok(())
    }

    pub fn update_session_note(&self, note_id: &str, text: &str) -> Result<(), String> {
        let connection = self.open_connection()?;

        connection
            .execute(
                "UPDATE session_notes SET text = ?1 WHERE id = ?2",
                params![text, note_id],
            )
            .map_err(|error| format!("Failed to update session note: {}", error))?;

        Ok(())
    }

    pub fn delete_session_note(&self, note_id: &str) -> Result<(), String> {
        let connection = self.open_connection()?;

        connection
            .execute(
                "DELETE FROM session_notes WHERE id = ?1",
                params![note_id],
            )
            .map_err(|error| format!("Failed to delete session note: {}", error))?;

        Ok(())
    }
}

fn session_name(id: &str, started_at_ms: u64) -> String {
    let suffix = id.strip_prefix("session-").unwrap_or(id);

    if suffix == started_at_ms.to_string() {
        return format!("Session {}", suffix);
    }

    suffix.to_string()
}

fn read_payload_string(payload: Option<&Value>, keys: &[&str]) -> Option<String> {
    let Some(Value::Object(object)) = payload else {
        return None;
    };

    for key in keys {
        if let Some(Value::String(value)) = object.get(*key) {
            if !value.trim().is_empty() {
                return Some(value.clone());
            }
        }
    }

    None
}

/// Payload fallback for a numeric field — used for legacy rows whose canonical
/// column is NULL because they were written before the column existed.
fn read_payload_f64(payload: Option<&Value>, keys: &[&str]) -> Option<f64> {
    let Some(Value::Object(object)) = payload else {
        return None;
    };

    for key in keys {
        if let Some(value) = object.get(*key).and_then(Value::as_f64) {
            return Some(value);
        }
    }

    None
}

/// Payload fallback for a boolean field. Accepts a real bool or the numeric 1/0
/// some v1 senders used.
fn read_payload_bool(payload: Option<&Value>, keys: &[&str]) -> Option<bool> {
    let Some(Value::Object(object)) = payload else {
        return None;
    };

    for key in keys {
        match object.get(*key) {
            Some(Value::Bool(value)) => return Some(*value),
            Some(Value::Number(number)) => {
                if let Some(integer) = number.as_i64() {
                    return Some(integer == 1);
                }
            }
            _ => {}
        }
    }

    None
}

pub fn initialize_database(db_path: &Path) -> rusqlite::Result<()> {
    let connection = Connection::open(db_path)?;

    connection.execute_batch(
        "
        PRAGMA foreign_keys = ON;
        -- WAL lets the worker's batched writes proceed without blocking reads
        -- (saved-session loads, curation queries) and improves write throughput
        -- under bursts of Ableton telemetry. NORMAL sync is the standard durable
        -- pairing with WAL for a local app.
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;

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
            -- Canonical structured fields, stored first-class (not just inside the
            -- payload JSON) so a reloaded session keeps full fidelity and these
            -- become directly queryable. See `migrate_event_columns` for the
            -- upgrade path that adds these to databases created before they existed.
            track_name TEXT,
            track_type TEXT,
            device_name TEXT,
            device_chain TEXT,
            parameter_name TEXT,
            parameter_value REAL,
            clip_name TEXT,
            sample_name TEXT,
            file_path TEXT,
            bpm REAL,
            playing INTEGER,
            created_at_ms INTEGER NOT NULL,
            FOREIGN KEY(session_id) REFERENCES sessions(id)
        );

        CREATE INDEX IF NOT EXISTS idx_events_session_id
        ON events(session_id);

        CREATE INDEX IF NOT EXISTS idx_events_timestamp_ms
        ON events(timestamp_ms);

        CREATE TABLE IF NOT EXISTS event_curation (
            session_id TEXT NOT NULL,
            event_id TEXT NOT NULL,
            hidden INTEGER NOT NULL DEFAULT 0,
            title_override TEXT,
            description_override TEXT,
            updated_at_ms INTEGER NOT NULL,
            PRIMARY KEY (session_id, event_id)
        );

        CREATE TABLE IF NOT EXISTS session_notes (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            linked_event_id TEXT,
            text TEXT NOT NULL,
            session_timecode TEXT NOT NULL,
            created_at_ms INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_session_notes_session
        ON session_notes(session_id);
        ",
    )?;

    // Bring older databases up to the current `events` schema.
    migrate_event_columns(&connection)?;

    Ok(())
}

/// Add any canonical `events` columns that a pre-existing database is missing.
///
/// A freshly created database already has these (they're in the CREATE TABLE
/// above), so this is a no-op for new installs. For a database created before the
/// columns existed, it adds them. SQLite's `ALTER TABLE … ADD COLUMN` is a fast,
/// metadata-only change and the new columns default to NULL on existing rows —
/// `load_session` falls back to the payload JSON for those legacy rows.
fn migrate_event_columns(connection: &Connection) -> rusqlite::Result<()> {
    // Column names currently on the table (column 1 of PRAGMA table_info).
    let existing: std::collections::HashSet<String> = {
        let mut statement = connection.prepare("PRAGMA table_info(events)")?;
        let names = statement.query_map([], |row| row.get::<_, String>(1))?;
        names.collect::<rusqlite::Result<_>>()?
    };

    // Every canonical column and its SQLite type. Names are fixed literals, so the
    // formatted ALTER statements carry no injection risk.
    const COLUMNS: &[(&str, &str)] = &[
        ("track_name", "TEXT"),
        ("track_type", "TEXT"),
        ("device_name", "TEXT"),
        ("device_chain", "TEXT"),
        ("parameter_name", "TEXT"),
        ("parameter_value", "REAL"),
        ("clip_name", "TEXT"),
        ("sample_name", "TEXT"),
        ("file_path", "TEXT"),
        ("bpm", "REAL"),
        ("playing", "INTEGER"),
    ];

    for (name, sql_type) in COLUMNS {
        if !existing.contains(*name) {
            connection.execute_batch(&format!("ALTER TABLE events ADD COLUMN {name} {sql_type};"))?;
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    //! Storage round-trip tests. Each uses a unique temp-file SQLite database
    //! (rusqlite can't share an in-memory DB across the separate connections this
    //! module opens), initialized through the real `initialize_database` so the
    //! schema and migration under test are exactly what ships.
    use super::*;
    use crate::protocol::RecallEvent;
    use std::sync::atomic::{AtomicU64, Ordering};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    /// An initialized StorageState backed by a fresh temp database file.
    fn temp_storage() -> (StorageState, PathBuf) {
        let name = format!(
            "recall-test-{}-{}.sqlite",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        );
        let path = std::env::temp_dir().join(name);
        let _ = std::fs::remove_file(&path);

        initialize_database(&path).expect("initialize test database");

        let mut storage = StorageState::new();
        storage.configure(path.clone());
        (storage, path)
    }

    /// Remove the database and its WAL/SHM sidecars after a test.
    fn cleanup(path: &Path) {
        let _ = std::fs::remove_file(path);
        let _ = std::fs::remove_file(path.with_extension("sqlite-wal"));
        let _ = std::fs::remove_file(path.with_extension("sqlite-shm"));
    }

    /// A minimal session-owned event; tests set the fields they care about.
    fn event(session_id: &str, event_type: &str) -> RecallEvent {
        RecallEvent {
            id: None,
            protocol: "recall.v2".into(),
            source: "max_for_live".into(),
            event_type: event_type.into(),
            timestamp_ms: 1_000,
            title: "Title".into(),
            description: "Description".into(),
            payload: None,
            session_id: Some(session_id.into()),
            track_name: None,
            track_type: None,
            device_name: None,
            parameter_name: None,
            parameter_value: None,
            clip_name: None,
            sample_name: None,
            file_path: None,
            device_chain: None,
            bpm: None,
            playing: None,
        }
    }

    #[test]
    fn canonical_fields_persist_as_columns_and_reload() {
        let (storage, path) = temp_storage();
        let session = storage.resume_or_create_active_session().unwrap();
        let session_id = session.session_id.clone().unwrap();

        let mut sample = event(&session_id, "sample_added");
        sample.track_name = Some("Vocals".into());
        sample.track_type = Some("audio".into());
        sample.sample_name = Some("Deep_House_Vocal_120bpm.wav".into());
        sample.file_path = Some("C:/Splice/Deep_House_Vocal_120bpm.wav".into());
        sample.device_chain = Some("Serum 2 : Saturator".into());
        sample.bpm = Some(124.0);
        sample.playing = Some(true);

        storage.save_events_batch(&[sample]).unwrap();

        let loaded = storage.load_session(&session_id).unwrap();
        let event = loaded
            .events
            .iter()
            .find(|e| e.event_type == "sample_added")
            .expect("saved sample_added event");

        // Every field came back from its first-class column, not payload digging.
        assert_eq!(event.track.as_deref(), Some("Vocals"));
        assert_eq!(event.track_type.as_deref(), Some("audio"));
        assert_eq!(event.sample_name.as_deref(), Some("Deep_House_Vocal_120bpm.wav"));
        assert_eq!(event.file_path.as_deref(), Some("C:/Splice/Deep_House_Vocal_120bpm.wav"));
        assert_eq!(event.device_chain.as_deref(), Some("Serum 2 : Saturator"));
        assert_eq!(event.bpm, Some(124.0));
        assert_eq!(event.playing, Some(true));

        cleanup(&path);
    }

    #[test]
    fn legacy_rows_recover_fields_from_payload() {
        let (storage, path) = temp_storage();
        let session = storage.resume_or_create_active_session().unwrap();
        let session_id = session.session_id.clone().unwrap();

        // Simulate a row written before the canonical columns existed: only the
        // original column set is populated, with the data living in the payload.
        let connection = Connection::open(&path).unwrap();
        connection
            .execute(
                "INSERT INTO events
                 (session_id, protocol, source, event_type, timestamp_ms, title, description, payload, created_at_ms)
                 VALUES (?1, 'recall.v1', 'max_for_live', 'sample_added', 1, 'T', 'D', ?2, 1)",
                params![
                    session_id,
                    r#"{"sample_name":"legacy.wav","track":"OldTrack","bpm":90}"#
                ],
            )
            .unwrap();
        drop(connection);

        let loaded = storage.load_session(&session_id).unwrap();
        let event = loaded
            .events
            .iter()
            .find(|e| e.event_type == "sample_added")
            .expect("legacy event");

        // Columns are NULL, so the loader recovered these from the payload JSON.
        assert_eq!(event.sample_name.as_deref(), Some("legacy.wav"));
        assert_eq!(event.track.as_deref(), Some("OldTrack"));
        assert_eq!(event.bpm, Some(90.0));

        cleanup(&path);
    }

    #[test]
    fn migration_adds_canonical_columns_to_old_schema() {
        // Build a database with the ORIGINAL events schema (no canonical columns),
        // then run the migration and confirm the columns now exist.
        let name = format!(
            "recall-test-migrate-{}-{}.sqlite",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        );
        let path = std::env::temp_dir().join(name);
        let _ = std::fs::remove_file(&path);

        let connection = Connection::open(&path).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    session_id TEXT,
                    protocol TEXT NOT NULL,
                    source TEXT NOT NULL,
                    event_type TEXT NOT NULL,
                    timestamp_ms INTEGER NOT NULL,
                    title TEXT NOT NULL,
                    description TEXT NOT NULL,
                    payload TEXT,
                    created_at_ms INTEGER NOT NULL
                );",
            )
            .unwrap();

        migrate_event_columns(&connection).unwrap();

        let columns: std::collections::HashSet<String> = {
            let mut statement = connection.prepare("PRAGMA table_info(events)").unwrap();
            statement
                .query_map([], |row| row.get::<_, String>(1))
                .unwrap()
                .collect::<rusqlite::Result<_>>()
                .unwrap()
        };

        for expected in ["track_name", "track_type", "device_chain", "sample_name", "file_path", "bpm", "playing"] {
            assert!(columns.contains(expected), "migration missing column: {expected}");
        }

        // Running it again must be a harmless no-op (idempotent).
        migrate_event_columns(&connection).unwrap();

        drop(connection);
        cleanup(&path);
    }
}
