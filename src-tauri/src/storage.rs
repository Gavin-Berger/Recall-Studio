use crate::planner::PlannerTask;
use crate::protocol::RecallEvent;
use crate::schema_projection::{
    build_parameter_changes, parse_note_edit, parse_session_tree, ChangeEvent, CreativeMoment,
    CreativeMomentTarget, DeviceObj, DeviceRole, NoteEdit, ParameterChange, ParameterObj,
    ParsedParam, ParsedTrack, ProjectSchema, TrackObj, TrackType,
};
use crate::session::{
    ProjectFolderMetadata, SavedProject, SavedSession, SavedSessionEvent, SavedSessionMetadata,
    SessionStatus,
};
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::Serialize;
use serde_json::Value;
use std::{
    collections::HashMap,
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

fn clean_optional(value: Option<&str>) -> Option<&str> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        // "0" is Ableton's absent-value sentinel, not a name. The LOM returns the
        // number 0 for the name and file_path of an unsaved set; anything that
        // stringifies that on the way here produces a truthy "0" that otherwise
        // flows all the way to the UI as the project's name. The bridge strips it
        // at the source (lom_text_or_null), but this is the last gate before the
        // value is persisted, and a stored "0" is very hard to notice and outlives
        // the session that wrote it.
        //
        // A set genuinely saved as "0.als" is the accepted cost: it would be
        // treated as unnamed. That trade is deliberate — the false negative is one
        // odd filename, the false positive is every unsaved set in the product.
        .filter(|value| *value != "0")
}

fn project_name_from_path(path: &str) -> Option<String> {
    Path::new(path)
        .file_stem()
        .and_then(|value| value.to_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

/// Reduce an Ableton path to a comparable project-folder key. A live capture
/// reports the `.als` file path, while a manually connected project may store the
/// containing folder. Both collapse to the same folder so they match regardless
/// of which form was recorded. Case- and separator-insensitive.
fn project_folder_key(path: &str) -> Option<String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return None;
    }
    let candidate = Path::new(trimmed);
    let folder = if candidate
        .extension()
        .and_then(|value| value.to_str())
        .map(|ext| ext.eq_ignore_ascii_case("als"))
        .unwrap_or(false)
    {
        candidate.parent().unwrap_or(candidate)
    } else {
        candidate
    };
    let key = folder
        .to_string_lossy()
        .replace('\\', "/")
        .trim_end_matches('/')
        .to_lowercase();
    if key.is_empty() {
        None
    } else {
        Some(key)
    }
}

fn fallback_project_display_name(project_name: Option<&str>, project_path: Option<&str>) -> String {
    clean_optional(project_name)
        .map(str::to_string)
        .or_else(|| clean_optional(project_path).and_then(project_name_from_path))
        .unwrap_or_else(|| "Untitled Ableton Set".to_string())
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

    // Open a connection with the pragmas that MUST be set per-connection.
    //
    // WHY synchronous AND busy_timeout LIVE HERE, NOT IN initialize_database
    // `journal_mode = WAL` is persistent — it lives in the database file, so
    // setting it once at init is correct and it survives every reopen.
    // `synchronous` and `busy_timeout` are NOT. They are per-connection settings
    // that reset to SQLite's defaults on every `Connection::open`.
    //
    // initialize_database sets `PRAGMA synchronous = NORMAL` on its own
    // throwaway connection, so it applied to exactly that connection and nothing
    // else. Every connection opened afterwards — including the one the
    // persistence worker opens per 256-event batch — silently ran at the default
    // `synchronous = FULL`, meaning a full fsync on every batch commit, on
    // Windows, in WAL mode. WAL was on and its durability partner quietly wasn't.
    //
    // NORMAL is the right setting for WAL: it fsyncs at checkpoints rather than
    // every commit. The documented risk is losing the tail of the last
    // transaction on an OS crash or power cut (not on an app crash), which is a
    // fair trade for a capture pipeline that must keep up with a burst.
    //
    // busy_timeout matters because readers exist: the stress harness attaches to
    // this file while the worker is committing, and without a timeout a busy
    // database is an instant error rather than a short wait.
    fn open_connection(&self) -> Result<Connection, String> {
        let connection = Connection::open(self.database_path()?)
            .map_err(|error| format!("Failed to open SQLite database: {}", error))?;

        connection
            .execute_batch(
                "PRAGMA foreign_keys = ON;
                 PRAGMA synchronous = NORMAL;
                 PRAGMA busy_timeout = 5000;",
            )
            .map_err(|error| format!("Failed to configure SQLite connection: {}", error))?;

        Ok(connection)
    }

    // Organizer asset files (waveform cache, cover art) live in a subdirectory
    // next to the database file, so they travel with the app-data directory.
    fn organizer_assets_dir(&self) -> Result<PathBuf, String> {
        let db = self.database_path()?;
        let parent = db
            .parent()
            .ok_or_else(|| "Database path has no parent directory".to_string())?;
        Ok(parent.join("organizer"))
    }

    pub fn list_organizer_projects(
        &self,
    ) -> Result<Vec<crate::organizer::OrganizerProject>, String> {
        let connection = self.open_connection()?;
        let assets = self.organizer_assets_dir()?;
        crate::organizer::list_projects(&connection, &assets)
    }

    pub fn save_organizer_project(
        &self,
        project: &crate::organizer::OrganizerProject,
    ) -> Result<(), String> {
        let mut connection = self.open_connection()?;
        let assets = self.organizer_assets_dir()?;
        crate::organizer::save_project(&mut connection, project, &assets)
    }

    pub fn delete_organizer_project(&self, project_id: &str) -> Result<(), String> {
        let mut connection = self.open_connection()?;
        let assets = self.organizer_assets_dir()?;
        crate::organizer::delete_project(&mut connection, project_id, &assets)
    }

    pub fn list_planner_tasks(&self) -> Result<Vec<PlannerTask>, String> {
        let connection = self.open_connection()?;
        let mut statement = connection
            .prepare(
                "SELECT id, title, due_date, due_time, task_type, project_id, notes, completed,
                        created_at_ms, updated_at_ms
                 FROM planner_tasks
                 ORDER BY completed ASC, due_date ASC, COALESCE(due_time, '99:99') ASC,
                          created_at_ms ASC",
            )
            .map_err(|error| format!("Failed to prepare planner task query: {error}"))?;
        let rows = statement
            .query_map([], |row| {
                Ok(PlannerTask {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    due_date: row.get(2)?,
                    due_time: row.get(3)?,
                    task_type: row.get(4)?,
                    project_id: row.get(5)?,
                    notes: row.get(6)?,
                    completed: row.get::<_, i64>(7)? != 0,
                    created_at_ms: row.get::<_, i64>(8)? as u64,
                    updated_at_ms: row.get::<_, i64>(9)? as u64,
                })
            })
            .map_err(|error| format!("Failed to read planner tasks: {error}"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("Failed to collect planner tasks: {error}"))
    }

    #[allow(clippy::too_many_arguments)]
    pub fn create_planner_task(
        &self,
        id: &str,
        title: &str,
        due_date: &str,
        due_time: Option<&str>,
        task_type: &str,
        project_id: Option<&str>,
        notes: Option<&str>,
    ) -> Result<PlannerTask, String> {
        let connection = self.open_connection()?;
        let now = now_ms();
        let task = PlannerTask {
            id: id.to_string(),
            title: title.to_string(),
            due_date: due_date.to_string(),
            due_time: due_time.map(str::to_string),
            task_type: task_type.to_string(),
            project_id: project_id.map(str::to_string),
            notes: notes.map(str::to_string),
            completed: false,
            created_at_ms: now,
            updated_at_ms: now,
        };
        connection
            .execute(
                "INSERT INTO planner_tasks
                 (id, title, due_date, due_time, task_type, project_id, notes, completed,
                  created_at_ms, updated_at_ms)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, ?8, ?8)",
                params![
                    task.id,
                    task.title,
                    task.due_date,
                    task.due_time,
                    task.task_type,
                    task.project_id,
                    task.notes,
                    now as i64,
                ],
            )
            .map_err(|error| format!("Failed to create planner task: {error}"))?;
        Ok(task)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn update_planner_task(
        &self,
        id: &str,
        title: &str,
        due_date: &str,
        due_time: Option<&str>,
        task_type: &str,
        project_id: Option<&str>,
        notes: Option<&str>,
        completed: bool,
    ) -> Result<PlannerTask, String> {
        let connection = self.open_connection()?;
        let now = now_ms();
        let updated = connection
            .execute(
                "UPDATE planner_tasks
                 SET title = ?2, due_date = ?3, due_time = ?4, task_type = ?5,
                     project_id = ?6, notes = ?7, completed = ?8, updated_at_ms = ?9
                 WHERE id = ?1",
                params![
                    id,
                    title,
                    due_date,
                    due_time,
                    task_type,
                    project_id,
                    notes,
                    completed as i64,
                    now as i64,
                ],
            )
            .map_err(|error| format!("Failed to update planner task: {error}"))?;
        if updated == 0 {
            return Err(format!("Planner task not found: {id}"));
        }
        let created_at_ms = connection
            .query_row(
                "SELECT created_at_ms FROM planner_tasks WHERE id = ?1",
                params![id],
                |row| row.get::<_, i64>(0),
            )
            .map_err(|error| format!("Failed to read updated planner task: {error}"))?
            as u64;
        Ok(PlannerTask {
            id: id.to_string(),
            title: title.to_string(),
            due_date: due_date.to_string(),
            due_time: due_time.map(str::to_string),
            task_type: task_type.to_string(),
            project_id: project_id.map(str::to_string),
            notes: notes.map(str::to_string),
            completed,
            created_at_ms,
            updated_at_ms: now,
        })
    }

    pub fn delete_planner_task(&self, id: &str) -> Result<(), String> {
        let connection = self.open_connection()?;
        let deleted = connection
            .execute("DELETE FROM planner_tasks WHERE id = ?1", params![id])
            .map_err(|error| format!("Failed to delete planner task: {error}"))?;
        if deleted == 0 {
            return Err(format!("Planner task not found: {id}"));
        }
        Ok(())
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
                    sessions.project_id,
                    sessions.capture_name,
                    COALESCE(
                        sessions.capture_status,
                        CASE WHEN sessions.ended_at_ms IS NULL THEN 'active' ELSE 'complete' END
                    ) AS capture_status,
                    COALESCE(sessions.project_name, projects.ableton_name) AS project_name,
                    COALESCE(sessions.project_path, projects.ableton_path) AS project_path,
                    sessions.als_path,
                    COALESCE(sessions.take_origin, 'recorded') AS take_origin,
                    sessions.display_name,
                    sessions.started_at_ms,
                    sessions.ended_at_ms,
                    -- \"Last updated\" must mean the take's real recency, not when the
                    -- row was inserted. A scanned version found on disk carries its
                    -- file's modified time in started/ended (see rescan_project_takes),
                    -- so a freshly connected folder shows Explorer's dates — not
                    -- \"everything updated today\" because the scan ran today.
                    COALESCE(
                        MAX(events.created_at_ms),
                        sessions.ended_at_ms,
                        sessions.started_at_ms,
                        sessions.created_at_ms
                    ) AS last_updated_at_ms,
                    COUNT(events.id) AS event_count,
                    SUM(CASE WHEN events.id IS NOT NULL AND events.event_type != 'heartbeat' THEN 1 ELSE 0 END) AS creative_event_count,
                    SUM(CASE WHEN events.id IS NOT NULL AND events.event_type = 'heartbeat' THEN 1 ELSE 0 END) AS heartbeat_count
                FROM sessions
                LEFT JOIN events ON events.session_id = sessions.id
                LEFT JOIN projects ON projects.id = sessions.project_id
                GROUP BY sessions.id, sessions.project_id, sessions.capture_name, sessions.capture_status,
                         sessions.project_name, sessions.project_path, sessions.als_path, sessions.take_origin,
                         projects.ableton_name, projects.ableton_path,
                         sessions.display_name,
                         sessions.started_at_ms, sessions.ended_at_ms, sessions.created_at_ms
                ORDER BY last_updated_at_ms DESC
                ",
            )
            .map_err(|error| format!("Failed to prepare saved sessions query: {}", error))?;

        let rows = statement
            .query_map([], |row| {
                let id: String = row.get(0)?;
                let project_id = row.get::<_, Option<String>>(1)?;
                let capture_name = row.get::<_, Option<String>>(2)?;
                let capture_status = row.get::<_, String>(3)?;
                let project_name = row.get::<_, Option<String>>(4)?;
                let project_path = row.get::<_, Option<String>>(5)?;
                let als_path = row.get::<_, Option<String>>(6)?;
                let take_origin = row.get::<_, String>(7)?;
                let display_name = row.get::<_, Option<String>>(8)?;
                let started_at_ms = row.get::<_, i64>(9)? as u64;
                let ended_at_ms = row.get::<_, Option<i64>>(10)?.map(|value| value as u64);
                let last_updated_at_ms = row.get::<_, i64>(11)? as u64;
                let event_count = row.get::<_, i64>(12)? as usize;
                let creative_event_count = row.get::<_, Option<i64>>(13)?.unwrap_or(0) as usize;
                let heartbeat_count = row.get::<_, Option<i64>>(14)?.unwrap_or(0) as usize;
                let name = capture_name
                    .as_deref()
                    .filter(|name| !name.trim().is_empty())
                    .map(str::to_string)
                    .unwrap_or_else(|| session_name(&id, started_at_ms));

                Ok(SavedSessionMetadata {
                    name,
                    project_id,
                    capture_name,
                    capture_status,
                    project_name,
                    project_path,
                    als_path,
                    take_origin,
                    display_name,
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
                    previous_parameter_value,
                    parameter_value_percent,
                    previous_parameter_value_percent,
                    clip_name,
                    sample_name,
                    file_path,
                    bpm,
                    playing,
                    parameter_display_value,
                    previous_parameter_display_value,
                    parameter_is_quantized
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
                let previous_parameter_value: Option<f64> = row.get(14)?;
                let parameter_value_percent: Option<f64> = row.get(15)?;
                let previous_parameter_value_percent: Option<f64> = row.get(16)?;
                let clip_name: Option<String> = row.get(17)?;
                let sample_name: Option<String> = row.get(18)?;
                let file_path: Option<String> = row.get(19)?;
                let bpm: Option<f64> = row.get(20)?;
                let playing: Option<i64> = row.get(21)?;
                let parameter_display_value: Option<String> = row.get(22)?;
                let previous_parameter_display_value: Option<String> = row.get(23)?;
                let parameter_is_quantized: Option<i64> = row.get(24)?;

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
                    previous_parameter_value: previous_parameter_value.or_else(|| {
                        read_payload_f64(
                            pj,
                            &["previous_parameter_value", "previous_value", "before_value"],
                        )
                    }),
                    parameter_value_percent: parameter_value_percent.or_else(|| {
                        read_payload_f64(
                            pj,
                            &[
                                "parameter_value_percent",
                                "value_percent",
                                "parameter_percent",
                                "normalized_percent",
                            ],
                        )
                    }),
                    previous_parameter_value_percent: previous_parameter_value_percent.or_else(
                        || {
                            read_payload_f64(
                                pj,
                                &[
                                    "previous_parameter_value_percent",
                                    "previous_value_percent",
                                    "before_value_percent",
                                ],
                            )
                        },
                    ),
                    parameter_display_value: parameter_display_value.or_else(|| {
                        read_payload_string(pj, &["parameter_display_value", "display_value"])
                    }),
                    previous_parameter_display_value: previous_parameter_display_value.or_else(
                        || {
                            read_payload_string(
                                pj,
                                &[
                                    "previous_parameter_display_value",
                                    "previous_display_value",
                                ],
                            )
                        },
                    ),
                    parameter_is_quantized: parameter_is_quantized
                        .map(|value| value != 0)
                        .or_else(|| {
                            read_payload_bool(pj, &["parameter_is_quantized", "is_quantized"])
                        }),
                    clip_name: clip_name
                        .or_else(|| read_payload_string(pj, &["clip_name", "clip"])),
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
            project_id: metadata.project_id,
            capture_name: metadata.capture_name,
            capture_status: metadata.capture_status,
            project_name: metadata.project_name,
            project_path: metadata.project_path,
            als_path: metadata.als_path,
            take_origin: metadata.take_origin,
            display_name: metadata.display_name,
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

        let dependent_deletes = [
            (
                "moment targets",
                "
                DELETE FROM creative_moment_targets
                WHERE moment_id IN (
                    SELECT id FROM creative_moments WHERE session_id = ?1
                )
                ",
            ),
            (
                "creative moments",
                "DELETE FROM creative_moments WHERE session_id = ?1",
            ),
            (
                "parameter changes",
                "DELETE FROM parameter_changes WHERE session_id = ?1",
            ),
            ("parameters", "DELETE FROM parameters WHERE session_id = ?1"),
            ("devices", "DELETE FROM devices WHERE session_id = ?1"),
            ("tracks", "DELETE FROM tracks WHERE session_id = ?1"),
            ("events", "DELETE FROM events WHERE session_id = ?1"),
            (
                "event curation",
                "DELETE FROM event_curation WHERE session_id = ?1",
            ),
            (
                "session notes",
                "DELETE FROM session_notes WHERE session_id = ?1",
            ),
        ];

        for (label, sql) in dependent_deletes {
            transaction
                .execute(sql, params![session_id])
                .map_err(|error| format!("Failed to delete session {label}: {error}"))?;
        }

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

    /// True when a session has zero captured events and was never anchored to
    /// an Ableton set (als_path IS NULL). This is exactly the shape of the
    /// throwaway session `resume_or_create_active_session` creates at startup
    /// when there is no unfinished take to resume: it exists only so the app
    /// has *a* session_id before the producer's first event tells it which
    /// project that is. If a real event arrives, auto-rotation immediately
    /// stops this one and activates the correctly-anchored take instead — the
    /// stopped placeholder never did anything and never will.
    pub fn is_session_empty_and_unanchored(&self, session_id: &str) -> Result<bool, String> {
        let connection = self.open_connection()?;

        let anchored: Option<bool> = connection
            .query_row(
                "SELECT als_path IS NOT NULL FROM sessions WHERE id = ?1",
                params![session_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| format!("Failed to check session anchor: {}", error))?;

        let Some(anchored) = anchored else {
            return Ok(false); // no such session; nothing to clean up
        };
        if anchored {
            return Ok(false);
        }

        let event_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM events WHERE session_id = ?1",
                params![session_id],
                |row| row.get(0),
            )
            .map_err(|error| format!("Failed to count session events: {}", error))?;

        Ok(event_count == 0)
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
                    capture_status,
                    started_at_ms,
                    ended_at_ms,
                    created_at_ms
                )
                VALUES (?1, 'active', ?2, NULL, ?3)
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
                SET ended_at_ms = ?1,
                    capture_status = 'complete'
                WHERE id = ?2
                ",
                params![ended_at_ms as i64, session_id],
            )
            .map_err(|error| format!("Failed to save session stop: {}", error))?;

        Ok(())
    }

    pub fn list_projects(&self, include_archived: bool) -> Result<Vec<SavedProject>, String> {
        let captures = self.list_saved_sessions()?;
        let mut captures_by_project: HashMap<String, Vec<SavedSessionMetadata>> = HashMap::new();
        for capture in captures {
            if let Some(project_id) = capture.project_id.clone() {
                captures_by_project
                    .entry(project_id)
                    .or_default()
                    .push(capture);
            }
        }

        let connection = self.open_connection()?;
        let mut statement = connection
            .prepare(
                "
                SELECT
                    projects.id, projects.display_name, projects.ableton_name, projects.ableton_path,
                    projects.archived_at_ms, projects.created_at_ms, projects.updated_at_ms,
                    project_folder_metadata.created_at_ms,
                    project_folder_metadata.modified_at_ms,
                    project_folder_metadata.latest_file_modified_at_ms,
                    project_folder_metadata.file_count,
                    project_folder_metadata.total_size_bytes,
                    project_folder_metadata.als_file_count,
                    project_folder_metadata.audio_file_count,
                    project_folder_metadata.scanned_at_ms
                FROM projects
                LEFT JOIN project_folder_metadata ON project_folder_metadata.project_id = projects.id
                WHERE (?1 = 1 OR projects.archived_at_ms IS NULL)
                ORDER BY projects.updated_at_ms DESC, projects.created_at_ms DESC
                ",
            )
            .map_err(|error| format!("Failed to prepare projects query: {}", error))?;

        let rows = statement
            .query_map(params![include_archived as i64], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, Option<i64>>(4)?.map(|value| value as u64),
                    row.get::<_, i64>(5)? as u64,
                    row.get::<_, i64>(6)? as u64,
                    row.get::<_, Option<i64>>(7)?.map(|value| value as u64),
                    row.get::<_, Option<i64>>(8)?.map(|value| value as u64),
                    row.get::<_, Option<i64>>(9)?.map(|value| value as u64),
                    row.get::<_, Option<i64>>(10)?.map(|value| value as usize),
                    row.get::<_, Option<i64>>(11)?.map(|value| value as u64),
                    row.get::<_, Option<i64>>(12)?.map(|value| value as usize),
                    row.get::<_, Option<i64>>(13)?.map(|value| value as usize),
                    row.get::<_, Option<i64>>(14)?.map(|value| value as u64),
                ))
            })
            .map_err(|error| format!("Failed to read projects: {}", error))?;

        let mut projects = Vec::new();
        for row in rows {
            let (
                id,
                display_name,
                ableton_name,
                ableton_path,
                archived_at_ms,
                created_at_ms,
                updated_at_ms,
                folder_created_at_ms,
                folder_modified_at_ms,
                latest_file_modified_at_ms,
                folder_file_count,
                folder_total_size_bytes,
                folder_als_file_count,
                folder_audio_file_count,
                folder_scanned_at_ms,
            ) = row.map_err(|error| format!("Failed to collect project row: {}", error))?;

            let mut project_captures = captures_by_project.remove(&id).unwrap_or_default();
            project_captures.sort_by(|a, b| b.started_at_ms.cmp(&a.started_at_ms));

            let capture_count = project_captures.len();
            let active_capture_count = project_captures
                .iter()
                .filter(|capture| capture.ended_at_ms.is_none())
                .count();
            let last_updated_at_ms = project_captures
                .iter()
                .map(|capture| capture.last_updated_at_ms)
                .max()
                .unwrap_or(updated_at_ms);
            let folder_metadata = folder_scanned_at_ms.map(|scanned_at_ms| ProjectFolderMetadata {
                created_at_ms: folder_created_at_ms,
                modified_at_ms: folder_modified_at_ms,
                latest_file_modified_at_ms,
                file_count: folder_file_count.unwrap_or(0),
                total_size_bytes: folder_total_size_bytes.unwrap_or(0),
                als_file_count: folder_als_file_count.unwrap_or(0),
                audio_file_count: folder_audio_file_count.unwrap_or(0),
                scanned_at_ms,
            });

            projects.push(SavedProject {
                id,
                display_name,
                ableton_name,
                ableton_path,
                archived_at_ms,
                created_at_ms,
                updated_at_ms,
                last_updated_at_ms,
                capture_count,
                active_capture_count,
                captures: project_captures,
                folder_metadata,
            });
        }

        projects.sort_by(|a, b| b.last_updated_at_ms.cmp(&a.last_updated_at_ms));
        Ok(projects)
    }

    pub fn active_session_for_project(
        &self,
        project_id: Option<&str>,
    ) -> Result<Option<SessionStatus>, String> {
        let connection = self.open_connection()?;

        // The IS NULL branch carries no bind parameter, so each branch passes its
        // own params; the SQL string must be passed to query_row (was missing).
        let row_to_status = |row: &rusqlite::Row<'_>| {
            Ok(SessionStatus {
                active: true,
                session_id: Some(row.get::<_, String>(0)?),
                started_at_ms: Some(row.get::<_, i64>(1)? as u64),
                ended_at_ms: None,
            })
        };

        let result = match project_id {
            Some(project_id) => connection.query_row(
                "
                SELECT id, started_at_ms
                FROM sessions
                WHERE project_id = ?1 AND ended_at_ms IS NULL
                ORDER BY started_at_ms DESC
                LIMIT 1
                ",
                params![project_id],
                row_to_status,
            ),
            None => connection.query_row(
                "
                SELECT id, started_at_ms
                FROM sessions
                WHERE project_id IS NULL AND ended_at_ms IS NULL
                ORDER BY started_at_ms DESC
                LIMIT 1
                ",
                [],
                row_to_status,
            ),
        };

        result
            .optional()
            .map_err(|error| format!("Failed to find active take: {}", error))
    }

    /// Resolve which take to make active when a producer opens a project, given the
    /// `.als` Ableton currently has open. Resumes the take anchored to that file
    /// (promoting a scanned version into a recorded take on first touch); a never-seen
    /// open file gets a fresh recorded take; with no open file it falls back to the
    /// project's active or most-recent take, creating one only if the project is empty.
    /// The returned take is marked active in the DB so reloads agree with memory.
    pub fn activate_take_for_open_file(
        &self,
        project_id: Option<&str>,
        open_als: Option<&str>,
    ) -> Result<SessionStatus, String> {
        let connection = self.open_connection()?;
        let now = now_ms();

        // Mark a take active and (on first recording of a scanned version) restart its
        // clock so the timeline measures from when recording actually began.
        let resume = |id: String, started_at_ms: i64, origin: String| -> Result<SessionStatus, String> {
            let started = if origin == "scanned" { now as i64 } else { started_at_ms };
            connection
                .execute(
                    "
                    UPDATE sessions
                    SET take_origin = 'recorded',
                        capture_status = 'active',
                        ended_at_ms = NULL,
                        started_at_ms = ?2
                    WHERE id = ?1
                    ",
                    params![id, started],
                )
                .map_err(|error| format!("Failed to resume take: {}", error))?;
            Ok(SessionStatus {
                active: true,
                session_id: Some(id),
                started_at_ms: Some(started as u64),
                ended_at_ms: None,
            })
        };

        // 1. A take already anchored to the open file → resume it.
        if let Some(als) = open_als {
            let existing: Option<(String, i64, String)> = connection
                .query_row(
                    "
                    SELECT id, started_at_ms, COALESCE(take_origin, 'recorded')
                    FROM sessions
                    WHERE als_path = ?1 AND project_id IS ?2
                    ORDER BY started_at_ms DESC
                    LIMIT 1
                    ",
                    params![als, project_id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .optional()
                .map_err(|error| format!("Failed to find take for open file: {}", error))?;

            if let Some((id, started, origin)) = existing {
                return resume(id, started, origin);
            }

            // 2. Open file we've never seen → a fresh recorded take anchored to it.
            let id = format!("session-{}", now);
            let name = std::path::Path::new(als)
                .file_stem()
                .and_then(|value| value.to_str())
                .unwrap_or("Take")
                .to_string();
            connection
                .execute(
                    "
                    INSERT INTO sessions (
                        id, project_id, capture_name, capture_status,
                        project_path, als_path, take_origin,
                        started_at_ms, ended_at_ms, created_at_ms
                    )
                    VALUES (?1, ?2, ?3, 'active', ?4, ?4, 'recorded', ?5, NULL, ?5)
                    ",
                    params![id, project_id, name, als, now as i64],
                )
                .map_err(|error| format!("Failed to create take for open file: {}", error))?;
            return Ok(SessionStatus {
                active: true,
                session_id: Some(id),
                started_at_ms: Some(now),
                ended_at_ms: None,
            });
        }

        // 3. No open file: resume the active take, else the most-recent take.
        if let Some(active) = self.active_session_for_project(project_id)? {
            return Ok(active);
        }
        let recent: Option<(String, i64, String)> = connection
            .query_row(
                "
                SELECT id, started_at_ms, COALESCE(take_origin, 'recorded')
                FROM sessions
                WHERE project_id IS ?1
                ORDER BY started_at_ms DESC
                LIMIT 1
                ",
                params![project_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()
            .map_err(|error| format!("Failed to find recent take: {}", error))?;
        if let Some((id, started, origin)) = recent {
            return resume(id, started, origin);
        }

        // 4. Empty project → a fresh, unanchored recorded take.
        let id = format!("session-{}", now);
        connection
            .execute(
                "
                INSERT INTO sessions (
                    id, project_id, capture_status, take_origin,
                    started_at_ms, ended_at_ms, created_at_ms
                )
                VALUES (?1, ?2, 'active', 'recorded', ?3, NULL, ?3)
                ",
                params![id, project_id, now as i64],
            )
            .map_err(|error| format!("Failed to create take: {}", error))?;
        Ok(SessionStatus {
            active: true,
            session_id: Some(id),
            started_at_ms: Some(now),
            ended_at_ms: None,
        })
    }

    /// Re-point a take's history to a different `.als` version. If a `scanned`
    /// placeholder take already sits on the target file it's absorbed (deleted), so
    /// the relinked take cleanly takes its place. If a *recorded* take already owns
    /// the target, the relink is refused — merging two histories is out of scope.
    /// This is how a producer moves their memory onto a renamed file.
    pub fn relink_take(&self, session_id: &str, als_path: &str) -> Result<(), String> {
        let clean = als_path.trim();
        if clean.is_empty() {
            return Err("No file chosen to relink to.".to_string());
        }

        let connection = self.open_connection()?;

        // Scope the conflict check to the take's own project.
        let take_project: Option<Option<String>> = connection
            .query_row(
                "SELECT project_id FROM sessions WHERE id = ?1",
                params![session_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()
            .map_err(|error| format!("Failed to read take: {}", error))?;
        let project_id = match take_project {
            Some(project_id) => project_id,
            None => return Err(format!("Take not found: {}", session_id)),
        };

        // Is another take already anchored to the target file?
        let conflict: Option<(String, String)> = connection
            .query_row(
                "
                SELECT id, COALESCE(take_origin, 'recorded')
                FROM sessions
                WHERE als_path = ?1 AND id != ?2 AND project_id IS ?3
                LIMIT 1
                ",
                params![clean, session_id, project_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(|error| format!("Failed to check relink target: {}", error))?;

        if let Some((other_id, origin)) = conflict {
            if origin == "scanned" {
                // A scanned placeholder has no events — absorb it.
                connection
                    .execute("DELETE FROM sessions WHERE id = ?1", params![other_id])
                    .map_err(|error| format!("Failed to absorb scanned take: {}", error))?;
            } else {
                return Err(
                    "That version already has a recorded take. Move or merge isn't supported yet."
                        .to_string(),
                );
            }
        }

        let updated = connection
            .execute(
                "UPDATE sessions SET als_path = ?1 WHERE id = ?2",
                params![clean, session_id],
            )
            .map_err(|error| format!("Failed to relink take: {}", error))?;
        if updated == 0 {
            return Err(format!("Take not found: {}", session_id));
        }

        Ok(())
    }

    /// The Ableton folder a project is connected to, if any.
    pub fn project_ableton_path(&self, project_id: &str) -> Result<Option<String>, String> {
        let connection = self.open_connection()?;
        connection
            .query_row(
                "SELECT ableton_path FROM projects WHERE id = ?1",
                params![project_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()
            .map_err(|error| format!("Failed to read project folder: {}", error))?
            .ok_or_else(|| format!("Project not found: {}", project_id))
    }

    /// Insert a `scanned` take for each `.als` (id, full path, modified_ms) that the
    /// project doesn't already have a take anchored to. Idempotent: files already
    /// represented by a take are skipped, so re-running only adds newly-saved
    /// versions. Returns how many takes were added.
    pub fn rescan_project_takes(
        &self,
        project_id: &str,
        files: &[(String, String, u64)],
    ) -> Result<usize, String> {
        let connection = self.open_connection()?;

        let mut existing: std::collections::HashSet<String> = std::collections::HashSet::new();
        {
            let mut statement = connection
                .prepare("SELECT als_path FROM sessions WHERE project_id = ?1 AND als_path IS NOT NULL")
                .map_err(|error| format!("Failed to prepare anchored-takes query: {}", error))?;
            let rows = statement
                .query_map(params![project_id], |row| row.get::<_, String>(0))
                .map_err(|error| format!("Failed to read anchored takes: {}", error))?;
            for path in rows {
                existing.insert(path.map_err(|error| format!("Failed to collect take path: {}", error))?);
            }
        }

        let now = now_ms();
        let mut added = 0usize;
        for (index, (name, path, modified_ms)) in files.iter().enumerate() {
            if existing.contains(path) {
                continue;
            }
            // A scanned take has no live telemetry, so it is born already "complete"
            // (ended_at_ms set) — it must never look like an active recording. Its
            // started time is the file's modified time so versions sort chronologically.
            let stamp = if *modified_ms > 0 { *modified_ms } else { now };
            let take_id = format!("take-{}-{}", now, index);
            connection
                .execute(
                    "
                    INSERT INTO sessions (
                        id, project_id, capture_name, capture_status,
                        als_path, take_origin, started_at_ms, ended_at_ms, created_at_ms
                    )
                    VALUES (?1, ?2, ?3, 'scanned', ?4, 'scanned', ?5, ?5, ?6)
                    ",
                    params![take_id, project_id, name, path, stamp as i64, now as i64],
                )
                .map_err(|error| format!("Failed to add scanned take: {}", error))?;
            existing.insert(path.clone());
            added += 1;
        }

        Ok(added)
    }

    pub fn create_project(
        &self,
        display_name: &str,
        ableton_name: Option<&str>,
        ableton_path: Option<&str>,
    ) -> Result<String, String> {
        let clean_display_name = display_name.trim();
        if clean_display_name.is_empty() {
            return Err("Project name cannot be empty.".to_string());
        }

        let project_id = format!("project-{}", now_ms());
        let now = now_ms() as i64;
        let connection = self.open_connection()?;

        connection
            .execute(
                "
                INSERT INTO projects (
                    id, display_name, ableton_name, ableton_path,
                    archived_at_ms, created_at_ms, updated_at_ms
                )
                VALUES (?1, ?2, ?3, ?4, NULL, ?5, ?6)
                ",
                params![
                    project_id,
                    clean_display_name,
                    clean_optional(ableton_name),
                    clean_optional(ableton_path),
                    now,
                    now,
                ],
            )
            .map_err(|error| format!("Failed to create project: {}", error))?;

        Ok(project_id)
    }

    pub fn set_project_source(
        &self,
        project_id: &str,
        ableton_name: &str,
        ableton_path: &str,
    ) -> Result<(), String> {
        let connection = self.open_connection()?;
        let updated = connection
            .execute(
                "
                UPDATE projects
                SET ableton_name = ?1, ableton_path = ?2, updated_at_ms = ?3
                WHERE id = ?4
                ",
                params![
                    clean_optional(Some(ableton_name)),
                    clean_optional(Some(ableton_path)),
                    now_ms() as i64,
                    project_id,
                ],
            )
            .map_err(|error| format!("Failed to set project source: {}", error))?;

        if updated == 0 {
            return Err(format!("Project not found: {}", project_id));
        }

        // A different source folder makes the previous Explorer snapshot
        // misleading. The caller will save a fresh one after the new folder is
        // scanned.
        connection
            .execute(
                "DELETE FROM project_folder_metadata WHERE project_id = ?1",
                params![project_id],
            )
            .map_err(|error| format!("Failed to clear project folder metadata: {}", error))?;

        Ok(())
    }

    /// Persist the last explicit Explorer-style scan for a connected project.
    pub fn save_project_folder_metadata(
        &self,
        project_id: &str,
        metadata: &ProjectFolderMetadata,
    ) -> Result<(), String> {
        let connection = self.open_connection()?;
        connection
            .execute(
                "
                INSERT INTO project_folder_metadata (
                    project_id, created_at_ms, modified_at_ms, latest_file_modified_at_ms,
                    file_count, total_size_bytes, als_file_count, audio_file_count, scanned_at_ms
                )
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
                ON CONFLICT(project_id) DO UPDATE SET
                    created_at_ms = excluded.created_at_ms,
                    modified_at_ms = excluded.modified_at_ms,
                    latest_file_modified_at_ms = excluded.latest_file_modified_at_ms,
                    file_count = excluded.file_count,
                    total_size_bytes = excluded.total_size_bytes,
                    als_file_count = excluded.als_file_count,
                    audio_file_count = excluded.audio_file_count,
                    scanned_at_ms = excluded.scanned_at_ms
                ",
                params![
                    project_id,
                    metadata.created_at_ms.map(|value| value as i64),
                    metadata.modified_at_ms.map(|value| value as i64),
                    metadata.latest_file_modified_at_ms.map(|value| value as i64),
                    metadata.file_count as i64,
                    metadata.total_size_bytes as i64,
                    metadata.als_file_count as i64,
                    metadata.audio_file_count as i64,
                    metadata.scanned_at_ms as i64,
                ],
            )
            .map_err(|error| format!("Failed to save project folder metadata: {}", error))?;
        Ok(())
    }

    /// Insert a project for each discovered Ableton folder that isn't already in
    /// the library (matched by project folder). Returns how many were added.
    pub fn import_projects(&self, discovered: &[(String, String)]) -> Result<usize, String> {
        let connection = self.open_connection()?;

        let mut existing_keys: Vec<String> = Vec::new();
        {
            let mut statement = connection
                .prepare(
                    "SELECT ableton_path FROM projects
                     WHERE ableton_path IS NOT NULL AND archived_at_ms IS NULL",
                )
                .map_err(|error| format!("Failed to query existing projects: {}", error))?;
            let rows = statement
                .query_map([], |row| row.get::<_, Option<String>>(0))
                .map_err(|error| format!("Failed to read existing projects: {}", error))?;
            for row in rows {
                if let Some(path) =
                    row.map_err(|error| format!("Failed to read project path: {}", error))?
                {
                    if let Some(key) = project_folder_key(&path) {
                        existing_keys.push(key);
                    }
                }
            }
        }

        let now = now_ms() as i64;
        let mut imported = 0usize;
        for (name, folder) in discovered {
            let key = match project_folder_key(folder) {
                Some(key) => key,
                None => continue,
            };
            if existing_keys.iter().any(|existing| existing == &key) {
                continue;
            }
            let project_id = format!("project-{}-{}", now_ms(), imported);
            connection
                .execute(
                    "
                    INSERT INTO projects (
                        id, display_name, ableton_name, ableton_path,
                        archived_at_ms, created_at_ms, updated_at_ms
                    )
                    VALUES (?1, ?2, ?3, ?4, NULL, ?5, ?6)
                    ",
                    params![project_id, name.trim(), name.trim(), folder, now, now],
                )
                .map_err(|error| format!("Failed to import project: {}", error))?;
            existing_keys.push(key);
            imported += 1;
        }

        Ok(imported)
    }

    pub fn rename_project(&self, project_id: &str, display_name: &str) -> Result<(), String> {
        let clean_display_name = display_name.trim();
        if clean_display_name.is_empty() {
            return Err("Project name cannot be empty.".to_string());
        }

        let connection = self.open_connection()?;
        let updated = connection
            .execute(
                "
                UPDATE projects
                SET display_name = ?1, updated_at_ms = ?2
                WHERE id = ?3
                ",
                params![clean_display_name, now_ms() as i64, project_id],
            )
            .map_err(|error| format!("Failed to rename project: {}", error))?;

        if updated == 0 {
            return Err(format!("Project not found: {}", project_id));
        }

        Ok(())
    }

    pub fn archive_project(&self, project_id: &str) -> Result<(), String> {
        let connection = self.open_connection()?;
        let active_captures = connection
            .query_row(
                "
                SELECT COUNT(*)
                FROM sessions
                WHERE project_id = ?1 AND ended_at_ms IS NULL
                ",
                params![project_id],
                |row| row.get::<_, i64>(0),
            )
            .map_err(|error| format!("Failed to check active captures: {}", error))?;

        if active_captures > 0 {
            return Err("Stop the active capture before archiving this project.".to_string());
        }

        let now = now_ms() as i64;
        let updated = connection
            .execute(
                "
                UPDATE projects
                SET archived_at_ms = ?1, updated_at_ms = ?2
                WHERE id = ?3
                ",
                params![now, now, project_id],
            )
            .map_err(|error| format!("Failed to archive project: {}", error))?;

        if updated == 0 {
            return Err(format!("Project not found: {}", project_id));
        }

        Ok(())
    }

    pub fn assign_session_to_project(
        &self,
        session_id: &str,
        project_id: Option<&str>,
    ) -> Result<(), String> {
        let connection = self.open_connection()?;
        if let Some(project_id) = project_id {
            let exists = connection
                .query_row(
                    "SELECT COUNT(*) FROM projects WHERE id = ?1 AND archived_at_ms IS NULL",
                    params![project_id],
                    |row| row.get::<_, i64>(0),
                )
                .map_err(|error| format!("Failed to check project: {}", error))?;
            if exists == 0 {
                return Err(format!("Project not found or archived: {}", project_id));
            }
        }

        let updated = connection
            .execute(
                "
                UPDATE sessions
                SET project_id = ?1
                WHERE id = ?2
                ",
                params![project_id, session_id],
            )
            .map_err(|error| format!("Failed to move capture: {}", error))?;

        if updated == 0 {
            return Err(format!("Saved session not found: {}", session_id));
        }

        Ok(())
    }

    pub fn rename_capture(&self, session_id: &str, capture_name: &str) -> Result<(), String> {
        let clean_capture_name = capture_name.trim();
        if clean_capture_name.is_empty() {
            return Err("Capture name cannot be empty.".to_string());
        }

        let connection = self.open_connection()?;
        let updated = connection
            .execute(
                "
                UPDATE sessions
                SET capture_name = ?1
                WHERE id = ?2
                ",
                params![clean_capture_name, session_id],
            )
            .map_err(|error| format!("Failed to rename capture: {}", error))?;

        if updated == 0 {
            return Err(format!("Saved session not found: {}", session_id));
        }

        Ok(())
    }

    pub fn update_session_display_name(&self, session_id: &str, name: &str) -> Result<(), String> {
        let trimmed = name.trim();
        if trimmed.is_empty() {
            return Err("Project name cannot be empty.".to_string());
        }

        let connection = self.open_connection()?;
        let updated = connection
            .execute(
                "
                UPDATE sessions
                SET display_name = ?1
                WHERE id = ?2
                ",
                params![trimmed, session_id],
            )
            .map_err(|error| format!("Failed to update project name: {}", error))?;

        if updated == 0 {
            return Err(format!("Saved session not found: {}", session_id));
        }

        Ok(())
    }

    pub fn remember_ableton_project(
        &self,
        session_id: &str,
        project_name: Option<&str>,
        project_path: Option<&str>,
    ) -> Result<(), String> {
        let clean_name = clean_optional(project_name);
        let clean_path = clean_optional(project_path);

        if clean_name.is_none() && clean_path.is_none() {
            return Ok(());
        }

        let connection = self.open_connection()?;
        let current_project_id = connection
            .query_row(
                "SELECT project_id FROM sessions WHERE id = ?1",
                params![session_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()
            .map_err(|error| format!("Failed to read session project: {}", error))?
            .flatten();

        connection
            .execute(
                "
                UPDATE sessions
                SET
                    project_name = COALESCE(?1, project_name),
                    project_path = COALESCE(?2, project_path)
                WHERE id = ?3
                ",
                params![clean_name, clean_path, session_id],
            )
            .map_err(|error| format!("Failed to remember Ableton project: {}", error))?;

        if let Some(project_id) = current_project_id {
            connection
                .execute(
                    "
                    UPDATE projects
                    SET
                        ableton_name = COALESCE(ableton_name, ?1),
                        ableton_path = COALESCE(ableton_path, ?2),
                        updated_at_ms = ?3
                    WHERE id = ?4
                    ",
                    params![clean_name, clean_path, now_ms() as i64, project_id],
                )
                .map_err(|error| format!("Failed to update project source: {}", error))?;

            return Ok(());
        }

        // Match the capture's set to a connected project by project folder, so a
        // folder linked manually still catches the live `.als` that lives inside it.
        let matched_project_id = if let Some(target) = clean_path.and_then(project_folder_key) {
            let mut statement = connection
                .prepare(
                    "
                    SELECT id, ableton_path FROM projects
                    WHERE ableton_path IS NOT NULL AND archived_at_ms IS NULL
                    ORDER BY updated_at_ms DESC
                    ",
                )
                .map_err(|error| format!("Failed to query projects: {}", error))?;
            let rows = statement
                .query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
                })
                .map_err(|error| format!("Failed to read projects: {}", error))?;

            let mut found = None;
            for row in rows {
                let (id, ableton_path) =
                    row.map_err(|error| format!("Failed to read project row: {}", error))?;
                if ableton_path
                    .as_deref()
                    .and_then(project_folder_key)
                    .map(|folder| folder == target)
                    .unwrap_or(false)
                {
                    found = Some(id);
                    break;
                }
            }
            found
        } else {
            None
        };

        let matched_project_id = if matched_project_id.is_some() {
            matched_project_id
        } else if let Some(name) = clean_name {
            connection
                .query_row(
                    "
                    SELECT id FROM projects
                    WHERE archived_at_ms IS NULL
                      AND (ableton_name = ?1 OR display_name = ?1)
                    ORDER BY updated_at_ms DESC
                    LIMIT 1
                    ",
                    params![name],
                    |row| row.get::<_, String>(0),
                )
                .optional()
                .map_err(|error| format!("Failed to match project name: {}", error))?
        } else {
            None
        };

        let project_id = if let Some(project_id) = matched_project_id {
            connection
                .execute(
                    "
                    UPDATE projects
                    SET
                        ableton_name = COALESCE(ableton_name, ?1),
                        ableton_path = COALESCE(ableton_path, ?2),
                        updated_at_ms = ?3
                    WHERE id = ?4
                    ",
                    params![clean_name, clean_path, now_ms() as i64, project_id],
                )
                .map_err(|error| format!("Failed to refresh matched project: {}", error))?;
            project_id
        } else {
            let project_id = format!("project-{}", now_ms());
            let now = now_ms() as i64;
            let display_name = fallback_project_display_name(clean_name, clean_path);
            connection
                .execute(
                    "
                    INSERT INTO projects (
                        id, display_name, ableton_name, ableton_path,
                        archived_at_ms, created_at_ms, updated_at_ms
                    )
                    VALUES (?1, ?2, ?3, ?4, NULL, ?5, ?6)
                    ",
                    params![project_id, display_name, clean_name, clean_path, now, now],
                )
                .map_err(|error| format!("Failed to create detected project: {}", error))?;
            project_id
        };

        connection
            .execute(
                "UPDATE sessions SET project_id = ?1 WHERE id = ?2 AND project_id IS NULL",
                params![project_id, session_id],
            )
            .map_err(|error| format!("Failed to attach capture to project: {}", error))?;

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
                        track_id,
                        track_type,
                        device_name,
                        device_chain,
                        parameter_name,
                        parameter_value,
                        previous_parameter_value,
                        parameter_value_percent,
                        previous_parameter_value_percent,
                        parameter_display_value,
                        previous_parameter_display_value,
                        parameter_is_quantized,
                        clip_name,
                        sample_name,
                        file_path,
                        bpm,
                        playing,
                        created_at_ms
                    )
                    VALUES (
                        ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10,
                        ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20,
                        ?21, ?22, ?23, ?24, ?25, ?26, ?27
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
                        event.track_id.as_deref(),
                        event.track_type.as_deref(),
                        event.device_name.as_deref(),
                        event.device_chain.as_deref(),
                        event.parameter_name.as_deref(),
                        event.parameter_value,
                        event.previous_parameter_value,
                        event.parameter_value_percent,
                        event.previous_parameter_value_percent,
                        event.parameter_display_value.as_deref(),
                        event.previous_parameter_display_value.as_deref(),
                        // SQLite has no boolean type; store is_quantized as 0/1, NULL if absent.
                        event.parameter_is_quantized.map(|quantized| quantized as i64),
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
            .execute("DELETE FROM session_notes WHERE id = ?1", params![note_id])
            .map_err(|error| format!("Failed to delete session note: {}", error))?;

        Ok(())
    }

    // ── Normalized schema projection ─────────────────────────────────────────

    /// Rebuild the normalized schema tables for one session from its event log.
    /// Idempotent: deletes and re-inserts tracks/devices/parameters/parameter_changes
    /// from the latest deep snapshot + the parameter-change event stream. Never
    /// touches creative_moments (those are user-authored and persist).
    pub fn materialize_session_schema(&self, session_id: &str) -> Result<(), String> {
        let mut connection = self.open_connection()?;

        // Read source data before opening the write transaction. Prefer a deep
        // snapshot (richest: devices + parameters); when none has been captured yet,
        // fall back to the incremental event stream so the tracks and devices the
        // bridge already reported show up without waiting for a full scan.
        let mut tree = latest_session_tree(&connection, session_id)?;
        if tree.is_empty() {
            tree = build_tree_from_events(&connection, session_id)?;
        }
        let change_events = collect_change_events(&connection, session_id)?;

        let transaction = connection
            .transaction()
            .map_err(|error| format!("Failed to start schema materialization: {}", error))?;

        for table in ["parameter_changes", "parameters", "devices", "tracks"] {
            transaction
                .execute(
                    &format!("DELETE FROM {table} WHERE session_id = ?1"),
                    params![session_id],
                )
                .map_err(|error| format!("Failed to clear {table}: {}", error))?;
        }

        // ableton track id -> stable track id, for resolving group parents.
        let mut track_id_by_ableton: HashMap<String, String> = HashMap::new();
        // (track, device, parameter) names -> parameter id, for change linking.
        let mut parameter_lookup: HashMap<(String, String, String), String> = HashMap::new();

        // Insert tracks (group_id resolved in a second pass once all ids exist).
        for (t_index, track) in tree.iter().enumerate() {
            let track_id = make_id(session_id, "t", track.ableton_id.as_deref(), t_index);
            if let Some(ableton) = &track.ableton_id {
                track_id_by_ableton.insert(ableton.clone(), track_id.clone());
            }

            transaction
                .execute(
                    "INSERT OR IGNORE INTO tracks
                     (id, session_id, ableton_id, name, number, type, color, group_id, chain_index)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL, ?8)",
                    params![
                        track_id,
                        session_id,
                        track.ableton_id,
                        track.name,
                        track.number,
                        track.track_type.as_str(),
                        track.color,
                        t_index as i64
                    ],
                )
                .map_err(|error| format!("Failed to insert track: {}", error))?;
        }

        for (t_index, track) in tree.iter().enumerate() {
            if let Some(group_ableton) = &track.group_ableton_id {
                if let Some(group_id) = track_id_by_ableton.get(group_ableton) {
                    let track_id = make_id(session_id, "t", track.ableton_id.as_deref(), t_index);
                    transaction
                        .execute(
                            "UPDATE tracks SET group_id = ?1 WHERE id = ?2",
                            params![group_id, track_id],
                        )
                        .map_err(|error| format!("Failed to set track group: {}", error))?;
                }
            }
        }

        // Insert devices + parameters (one level of nested children supported).
        for (t_index, track) in tree.iter().enumerate() {
            let track_id = make_id(session_id, "t", track.ableton_id.as_deref(), t_index);

            for (d_index, device) in track.devices.iter().enumerate() {
                let device_id =
                    make_child_id(&track_id, "d", device.ableton_id.as_deref(), d_index);

                transaction
                    .execute(
                        "INSERT OR IGNORE INTO devices
                         (id, session_id, track_id, ableton_id, name, role, vendor,
                          plugin_format, preset_name, chain_index, enabled)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, NULL, NULL, ?7, ?8)",
                        params![
                            device_id,
                            session_id,
                            track_id,
                            device.ableton_id,
                            device.name,
                            device.role.as_str(),
                            d_index as i64,
                            device.enabled as i64
                        ],
                    )
                    .map_err(|error| format!("Failed to insert device: {}", error))?;

                for (p_index, param) in device.params.iter().enumerate() {
                    let param_id =
                        make_child_id(&device_id, "p", param.ableton_id.as_deref(), p_index);
                    insert_parameter(
                        &transaction,
                        session_id,
                        &device_id,
                        None,
                        &param_id,
                        param,
                        p_index,
                    )?;

                    if let (Some(device_name), Some(param_name)) = (&device.name, &param.name) {
                        // Register under both keys a change event might arrive
                        // with: the ableton_id (what a change carrying track_id
                        // resolves to — disambiguates same-named tracks) and the
                        // bare name (what a change with no track_id, e.g. a
                        // pre-migration row, falls back to). When two tracks
                        // share a name, the name-keyed entry is necessarily
                        // ambiguous between them — same as before this fix —
                        // but the id-keyed entry, used whenever the event has
                        // one, is exact.
                        let mut keys: Vec<String> = Vec::with_capacity(2);
                        if let Some(ableton_id) = track.ableton_id.as_deref() {
                            if !ableton_id.is_empty() {
                                keys.push(ableton_id.to_string());
                            }
                        }
                        if let Some(name) = track.name.as_deref() {
                            if !name.is_empty() && !keys.contains(&name.to_string()) {
                                keys.push(name.to_string());
                            }
                        }
                        for track_key in keys {
                            parameter_lookup.insert(
                                (track_key, device_name.clone(), param_name.clone()),
                                param_id.clone(),
                            );
                        }
                    }

                    for (c_index, child) in param.children.iter().enumerate() {
                        let child_id = format!("{param_id}::c::{c_index}");
                        insert_parameter(
                            &transaction,
                            session_id,
                            &device_id,
                            Some(&param_id),
                            &child_id,
                            child,
                            c_index,
                        )?;
                    }
                }
            }
        }

        let changes = build_parameter_changes(change_events, &parameter_lookup);
        {
            let mut statement = transaction
                .prepare_cached(
                    "INSERT INTO parameter_changes
                     (id, session_id, parameter_id, track_name, track_id, device_name, parameter_name,
                      before_value, after_value, before_value_percent, after_value_percent,
                      unit, before_display_value, after_display_value, is_quantized,
                      reason, changed_at_ms, source_event_id)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15,
                             ?16, ?17, ?18)",
                )
                .map_err(|error| {
                    format!("Failed to prepare parameter_changes insert: {}", error)
                })?;

            for change in &changes {
                let source_event_id: Option<i64> = change
                    .id
                    .strip_prefix("pc::")
                    .and_then(|id| id.parse().ok());

                statement
                    .execute(params![
                        change.id,
                        session_id,
                        change.parameter_id,
                        change.track_name,
                        change.track_id,
                        change.device_name,
                        change.parameter_name,
                        change.before_value,
                        change.after_value,
                        change.before_value_percent,
                        change.after_value_percent,
                        change.unit,
                        change.before_display_value,
                        change.after_display_value,
                        change.is_quantized.map(|quantized| quantized as i64),
                        change.reason,
                        change.changed_at_ms as i64,
                        source_event_id
                    ])
                    .map_err(|error| format!("Failed to insert parameter change: {}", error))?;
            }
        }

        transaction
            .commit()
            .map_err(|error| format!("Failed to commit schema materialization: {}", error))?;

        Ok(())
    }

    /// Assemble the normalized Project → Track → Device → Parameter tree from the
    /// materialized tables. Call `materialize_session_schema` first.
    pub fn get_project_schema(&self, session_id: &str) -> Result<ProjectSchema, String> {
        let connection = self.open_connection()?;

        // Parameters, grouped by device (children resolved via parent id).
        let params_by_device = load_parameters_by_device(&connection, session_id)?;
        let devices_by_track = load_devices_by_track(&connection, session_id, &params_by_device)?;

        let mut track_statement = connection
            .prepare(
                "SELECT id, ableton_id, name, number, type, color, group_id, chain_index
                 FROM tracks WHERE session_id = ?1
                 ORDER BY chain_index ASC, number ASC",
            )
            .map_err(|error| format!("Failed to prepare tracks query: {}", error))?;

        let mut tracks = track_statement
            .query_map(params![session_id], |row| {
                let id: String = row.get(0)?;
                let track_type: String = row.get(4)?;
                Ok(TrackObj {
                    devices: devices_by_track.get(&id).cloned().unwrap_or_default(),
                    id,
                    ableton_id: row.get(1)?,
                    name: row.get(2)?,
                    number: row.get(3)?,
                    track_type: TrackType::from_str(&track_type),
                    color: row.get(5)?,
                    group_id: row.get(6)?,
                    chain_index: row.get::<_, Option<i64>>(7)?.unwrap_or(0),
                })
            })
            .map_err(|error| format!("Failed to read tracks: {}", error))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("Failed to collect tracks: {}", error))?;

        tracks.sort_by_key(|track| track.chain_index);

        let started_at = self
            .list_saved_sessions()?
            .into_iter()
            .find(|session| session.id == session_id)
            .map(|session| session.started_at_ms)
            .unwrap_or(0);

        Ok(ProjectSchema {
            has_snapshot: !tracks.is_empty(),
            name: session_name(session_id, started_at),
            session_id: session_id.to_string(),
            tracks,
        })
    }

    /// Parameter changes for a session, in chronological order, with before/after.
    pub fn get_parameter_changes(&self, session_id: &str) -> Result<Vec<ParameterChange>, String> {
        let connection = self.open_connection()?;

        let mut statement = connection
            .prepare(
                "SELECT id, parameter_id, track_name, track_id, device_name, parameter_name,
                        before_value, after_value, before_value_percent, after_value_percent,
                        unit, before_display_value, after_display_value, is_quantized,
                        reason, changed_at_ms
                 FROM parameter_changes WHERE session_id = ?1
                 ORDER BY changed_at_ms ASC, id ASC",
            )
            .map_err(|error| format!("Failed to prepare parameter_changes query: {}", error))?;

        let rows = statement
            .query_map(params![session_id], |row| {
                Ok(ParameterChange {
                    id: row.get(0)?,
                    parameter_id: row.get(1)?,
                    track_name: row.get(2)?,
                    track_id: row.get(3)?,
                    device_name: row.get(4)?,
                    parameter_name: row.get(5)?,
                    before_value: row.get(6)?,
                    after_value: row.get(7)?,
                    before_value_percent: row.get(8)?,
                    after_value_percent: row.get(9)?,
                    unit: row.get(10)?,
                    before_display_value: row.get(11)?,
                    after_display_value: row.get(12)?,
                    is_quantized: row.get::<_, Option<i64>>(13)?.map(|value| value != 0),
                    reason: row.get(14)?,
                    changed_at_ms: row.get::<_, i64>(15)? as u64,
                })
            })
            .map_err(|error| format!("Failed to read parameter_changes: {}", error))?;

        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("Failed to collect parameter_changes: {}", error))
    }

    /// Note edits for a session, read straight from the event log.
    ///
    /// No materialized table behind this: the control surface settles note edits
    /// before sending them, so one event row is already one edit. See
    /// [`schema_projection::NoteEdit`] for why that differs from parameters.
    pub fn get_note_edits(&self, session_id: &str) -> Result<Vec<NoteEdit>, String> {
        let connection = self.open_connection()?;

        let mut statement = connection
            .prepare(
                "SELECT id, timestamp_ms, track_name, payload
                 FROM events
                 WHERE session_id = ?1 AND event_type = 'clip_notes_changed'
                 ORDER BY timestamp_ms ASC, id ASC",
            )
            .map_err(|error| format!("Failed to prepare note edits query: {}", error))?;

        let rows = statement
            .query_map(params![session_id], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)? as u64,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                ))
            })
            .map_err(|error| format!("Failed to read note edits: {}", error))?;

        let mut edits = Vec::new();
        for row in rows {
            let (id, timestamp_ms, track_name, payload) =
                row.map_err(|error| format!("Failed to read note edit row: {}", error))?;
            // Unparseable rows are skipped, not fatal — one malformed payload
            // must not cost the producer the rest of the session's edits.
            if let Some(edit) = parse_note_edit(id, timestamp_ms, track_name, payload.as_deref()) {
                edits.push(edit);
            }
        }

        Ok(edits)
    }

    // ── Creative moments (user-authored) ─────────────────────────────────────

    pub fn list_creative_moments(&self, session_id: &str) -> Result<Vec<CreativeMoment>, String> {
        let connection = self.open_connection()?;

        let mut targets_by_moment: HashMap<String, Vec<CreativeMomentTarget>> = HashMap::new();
        {
            let mut statement = connection
                .prepare(
                    "SELECT target.moment_id, target.target_type, target.target_id
                     FROM creative_moment_targets target
                     JOIN creative_moments moment ON moment.id = target.moment_id
                     WHERE moment.session_id = ?1",
                )
                .map_err(|error| format!("Failed to prepare targets query: {}", error))?;

            let rows = statement
                .query_map(params![session_id], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        CreativeMomentTarget {
                            target_type: row.get(1)?,
                            target_id: row.get(2)?,
                        },
                    ))
                })
                .map_err(|error| format!("Failed to read moment targets: {}", error))?;

            for row in rows {
                let (moment_id, target) =
                    row.map_err(|error| format!("Failed to read moment target: {}", error))?;
                targets_by_moment.entry(moment_id).or_default().push(target);
            }
        }

        let mut statement = connection
            .prepare(
                "SELECT id, title, type, timeline_start_ms, timeline_end_ms, note, tags,
                        confidence, created_at_ms, updated_at_ms
                 FROM creative_moments WHERE session_id = ?1
                 ORDER BY COALESCE(timeline_start_ms, created_at_ms) ASC, created_at_ms ASC",
            )
            .map_err(|error| format!("Failed to prepare creative_moments query: {}", error))?;

        let rows = statement
            .query_map(params![session_id], |row| {
                let id: String = row.get(0)?;
                let tags_json: Option<String> = row.get(6)?;
                Ok(CreativeMoment {
                    targets: targets_by_moment.remove(&id).unwrap_or_default(),
                    id,
                    session_id: session_id.to_string(),
                    title: row.get(1)?,
                    moment_type: row.get(2)?,
                    timeline_start_ms: row.get::<_, Option<i64>>(3)?.map(|value| value as u64),
                    timeline_end_ms: row.get::<_, Option<i64>>(4)?.map(|value| value as u64),
                    note: row.get(5)?,
                    tags: tags_json
                        .as_deref()
                        .and_then(|json| serde_json::from_str::<Vec<String>>(json).ok())
                        .unwrap_or_default(),
                    confidence: row.get(7)?,
                    created_at_ms: row.get::<_, i64>(8)? as u64,
                    updated_at_ms: row.get::<_, i64>(9)? as u64,
                })
            })
            .map_err(|error| format!("Failed to read creative_moments: {}", error))?;

        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("Failed to collect creative_moments: {}", error))
    }

    #[allow(clippy::too_many_arguments)]
    pub fn create_creative_moment(
        &self,
        id: &str,
        session_id: &str,
        title: &str,
        moment_type: &str,
        timeline_start_ms: Option<u64>,
        timeline_end_ms: Option<u64>,
        note: Option<&str>,
        tags: &[String],
        confidence: &str,
        targets: &[CreativeMomentTarget],
    ) -> Result<(), String> {
        let mut connection = self.open_connection()?;
        let now = now_ms();
        let tags_json = serde_json::to_string(tags).unwrap_or_else(|_| "[]".to_string());

        let transaction = connection
            .transaction()
            .map_err(|error| format!("Failed to start creative moment insert: {}", error))?;

        transaction
            .execute(
                "INSERT INTO creative_moments
                 (id, session_id, title, type, timeline_start_ms, timeline_end_ms, note, tags,
                  confidence, created_at_ms, updated_at_ms)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
                params![
                    id,
                    session_id,
                    title,
                    moment_type,
                    timeline_start_ms.map(|value| value as i64),
                    timeline_end_ms.map(|value| value as i64),
                    note,
                    tags_json,
                    confidence,
                    now as i64,
                    now as i64
                ],
            )
            .map_err(|error| format!("Failed to insert creative moment: {}", error))?;

        write_moment_targets(&transaction, id, targets)?;

        transaction
            .commit()
            .map_err(|error| format!("Failed to commit creative moment: {}", error))?;

        Ok(())
    }

    pub fn update_creative_moment(
        &self,
        id: &str,
        title: &str,
        moment_type: &str,
        timeline_start_ms: Option<u64>,
        timeline_end_ms: Option<u64>,
        note: Option<&str>,
        tags: &[String],
        confidence: &str,
    ) -> Result<(), String> {
        let connection = self.open_connection()?;
        let tags_json = serde_json::to_string(tags).unwrap_or_else(|_| "[]".to_string());

        let updated = connection
            .execute(
                "UPDATE creative_moments
                 SET title = ?2, type = ?3, timeline_start_ms = ?4, timeline_end_ms = ?5,
                     note = ?6, tags = ?7, confidence = ?8, updated_at_ms = ?9
                 WHERE id = ?1",
                params![
                    id,
                    title,
                    moment_type,
                    timeline_start_ms.map(|value| value as i64),
                    timeline_end_ms.map(|value| value as i64),
                    note,
                    tags_json,
                    confidence,
                    now_ms() as i64
                ],
            )
            .map_err(|error| format!("Failed to update creative moment: {}", error))?;

        if updated == 0 {
            return Err(format!("Creative moment not found: {}", id));
        }

        Ok(())
    }

    pub fn set_creative_moment_targets(
        &self,
        moment_id: &str,
        targets: &[CreativeMomentTarget],
    ) -> Result<(), String> {
        let mut connection = self.open_connection()?;
        let transaction = connection
            .transaction()
            .map_err(|error| format!("Failed to start target update: {}", error))?;

        transaction
            .execute(
                "DELETE FROM creative_moment_targets WHERE moment_id = ?1",
                params![moment_id],
            )
            .map_err(|error| format!("Failed to clear moment targets: {}", error))?;

        write_moment_targets(&transaction, moment_id, targets)?;

        transaction
            .commit()
            .map_err(|error| format!("Failed to commit moment targets: {}", error))?;

        Ok(())
    }

    pub fn delete_creative_moment(&self, id: &str) -> Result<(), String> {
        let mut connection = self.open_connection()?;
        let transaction = connection
            .transaction()
            .map_err(|error| format!("Failed to start moment delete: {}", error))?;

        transaction
            .execute(
                "DELETE FROM creative_moment_targets WHERE moment_id = ?1",
                params![id],
            )
            .map_err(|error| format!("Failed to delete moment targets: {}", error))?;

        transaction
            .execute("DELETE FROM creative_moments WHERE id = ?1", params![id])
            .map_err(|error| format!("Failed to delete creative moment: {}", error))?;

        transaction
            .commit()
            .map_err(|error| format!("Failed to commit moment delete: {}", error))?;

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

// ── Schema-projection helpers (used by the StorageState methods above) ────────

/// Build a stable, deterministic id for a top-level entity. Re-materialization
/// produces the same id for the same Ableton object, so creative-moment targets
/// keep pointing at the right thing across rebuilds.
fn make_id(session_id: &str, kind: &str, ableton_id: Option<&str>, index: usize) -> String {
    match ableton_id {
        Some(id) if !id.trim().is_empty() => format!("{session_id}::{kind}::{id}"),
        _ => format!("{session_id}::{kind}::idx{index}"),
    }
}

fn make_child_id(parent_id: &str, kind: &str, ableton_id: Option<&str>, index: usize) -> String {
    match ableton_id {
        Some(id) if !id.trim().is_empty() => format!("{parent_id}::{kind}::{id}"),
        _ => format!("{parent_id}::{kind}::idx{index}"),
    }
}

fn insert_parameter(
    transaction: &Transaction,
    session_id: &str,
    device_id: &str,
    parent_id: Option<&str>,
    param_id: &str,
    param: &ParsedParam,
    index: usize,
) -> Result<(), String> {
    transaction
        .execute(
            "INSERT OR IGNORE INTO parameters
             (id, session_id, device_id, parent_parameter_id, name, value, unit, min, max,
              normalized_value, chain_index)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, ?7, ?8, ?9, ?10)",
            params![
                param_id,
                session_id,
                device_id,
                parent_id,
                param.name,
                param.value,
                param.min,
                param.max,
                param.normalized_value,
                index as i64
            ],
        )
        .map_err(|error| format!("Failed to insert parameter: {}", error))?;

    Ok(())
}

fn write_moment_targets(
    transaction: &Transaction,
    moment_id: &str,
    targets: &[CreativeMomentTarget],
) -> Result<(), String> {
    let mut statement = transaction
        .prepare_cached(
            "INSERT OR IGNORE INTO creative_moment_targets (moment_id, target_type, target_id)
             VALUES (?1, ?2, ?3)",
        )
        .map_err(|error| format!("Failed to prepare target insert: {}", error))?;

    for target in targets {
        statement
            .execute(params![moment_id, target.target_type, target.target_id])
            .map_err(|error| format!("Failed to insert moment target: {}", error))?;
    }

    Ok(())
}

/// The most recent snapshot for a session, preferring a deep capture (tracks with
/// devices) over a shallow one. Returns an empty tree if none exists.
fn latest_session_tree(
    connection: &Connection,
    session_id: &str,
) -> Result<Vec<ParsedTrack>, String> {
    let mut statement = connection
        .prepare(
            "SELECT payload FROM events
             WHERE session_id = ?1
               AND event_type IN ('live_set_snapshot', 'session_snapshot', 'set_snapshot')
             ORDER BY timestamp_ms DESC, id DESC",
        )
        .map_err(|error| format!("Failed to prepare snapshot query: {}", error))?;

    let payloads = statement
        .query_map(params![session_id], |row| row.get::<_, Option<String>>(0))
        .map_err(|error| format!("Failed to read snapshots: {}", error))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Failed to collect snapshots: {}", error))?;

    let mut fallback: Option<Vec<ParsedTrack>> = None;
    for payload in payloads.into_iter().flatten() {
        let Ok(value) = serde_json::from_str::<Value>(&payload) else {
            continue;
        };
        let tree = parse_session_tree(&value);
        if tree.is_empty() {
            continue;
        }
        if tree.iter().any(|track| !track.devices.is_empty()) {
            return Ok(tree);
        }
        if fallback.is_none() {
            fallback = Some(tree);
        }
    }

    Ok(fallback.unwrap_or_default())
}

/// Build a track/device tree from the incremental event stream, for when no deep
/// snapshot exists yet. Uses the latest `selected_track_focus_snapshot` per track
/// (rich: devices with roles + clips) and adds stubs for tracks that were created
/// but never selected. Reuses `parse_session_tree` for typing/role derivation.
fn build_tree_from_events(
    connection: &Connection,
    session_id: &str,
) -> Result<Vec<ParsedTrack>, String> {
    let mut statement = connection
        .prepare(
            "SELECT payload FROM events
             WHERE session_id = ?1
               AND event_type IN ('selected_track_focus_snapshot', 'selected_track_snapshot')
               AND payload IS NOT NULL
             ORDER BY timestamp_ms ASC, id ASC",
        )
        .map_err(|error| format!("Failed to prepare focus query: {}", error))?;

    let payloads = statement
        .query_map(params![session_id], |row| row.get::<_, String>(0))
        .map_err(|error| format!("Failed to read focus snapshots: {}", error))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Failed to collect focus snapshots: {}", error))?;

    // Key by the track's Live id so a RENAME (same id, new name) collapses to one
    // entry — keying by name would keep both names under the same id and then
    // collide on the tracks.id primary key. A second pass keeps only the latest id
    // holding each name, so delete/recreate and stale tracks don't show as dupes.
    let mut order: Vec<String> = Vec::new();
    let mut by_id: HashMap<String, Value> = HashMap::new();
    let mut latest_id_for_name: HashMap<String, String> = HashMap::new();

    for payload in payloads {
        let Ok(track) = serde_json::from_str::<Value>(&payload) else {
            continue;
        };
        if track.get("available").and_then(Value::as_bool) == Some(false) {
            continue;
        }
        let id_key = track
            .get("id")
            .filter(|value| !value.is_null())
            .map(|value| value.to_string())
            .or_else(|| {
                track
                    .get("name")
                    .and_then(Value::as_str)
                    .map(|name| name.to_string())
            });
        let Some(id_key) = id_key.filter(|value| !value.is_empty()) else {
            continue;
        };
        if !by_id.contains_key(&id_key) {
            order.push(id_key.clone());
        }
        by_id.insert(id_key.clone(), enrich_focus_track(&track));
        if let Some(name) = track
            .get("name")
            .and_then(Value::as_str)
            .filter(|n| !n.is_empty())
        {
            latest_id_for_name.insert(name.to_string(), id_key);
        }
    }

    let mut tracks: Vec<Value> = Vec::new();
    let mut seen_names: std::collections::HashSet<String> = std::collections::HashSet::new();
    for id_key in &order {
        let track = &by_id[id_key];
        if let Some(name) = track
            .get("name")
            .and_then(Value::as_str)
            .filter(|n| !n.is_empty())
        {
            // Skip this id if a more recently seen id now owns the same name.
            if latest_id_for_name.get(name).map(String::as_str) != Some(id_key.as_str()) {
                continue;
            }
            seen_names.insert(name.to_string());
        }
        tracks.push(track.clone());
    }

    // Tracks created but never selected won't have a focus snapshot — add stubs so
    // the track still appears, typed from the track_created event's track_type
    // (bridge >= 0.12.0; older events default to audio).
    let deleted = event_track_names(connection, session_id, "track_deleted")?;
    let mut created_statement = connection
        .prepare(
            "SELECT track_name, track_type FROM events
             WHERE session_id = ?1 AND event_type = 'track_created' AND track_name IS NOT NULL
             ORDER BY timestamp_ms ASC, id ASC",
        )
        .map_err(|error| format!("Failed to prepare created-track query: {}", error))?;
    let created = created_statement
        .query_map(params![session_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
        })
        .map_err(|error| format!("Failed to read created tracks: {}", error))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Failed to collect created tracks: {}", error))?;

    let mut stubbed: std::collections::HashSet<String> = std::collections::HashSet::new();
    for (name, track_type) in created {
        if deleted.contains(&name) || seen_names.contains(&name) || !stubbed.insert(name.clone()) {
            continue;
        }
        let mut stub = serde_json::json!({ "name": name, "devices": [] });
        match track_type.as_deref() {
            Some("midi") => stub["has_midi_input"] = Value::Bool(true),
            Some("group") => stub["is_foldable"] = Value::Bool(true),
            _ => {}
        }
        tracks.push(stub);
    }

    Ok(parse_session_tree(&serde_json::json!({ "tracks": tracks })))
}

/// Inject `has_midi_input` when a focus-snapshot track carries an instrument or a
/// MIDI clip, so `parse_session_tree` types it as MIDI (focus snapshots don't
/// include the raw flag the deep snapshot does).
fn enrich_focus_track(track: &Value) -> Value {
    let has_instrument = track
        .get("devices")
        .and_then(Value::as_array)
        .map(|devices| {
            devices
                .iter()
                .any(|device| device.get("role").and_then(Value::as_str) == Some("instrument"))
        })
        .unwrap_or(false);

    let has_midi_clip = track
        .get("clips")
        .and_then(Value::as_array)
        .map(|clips| {
            clips
                .iter()
                .any(|clip| json_truthy(clip.get("is_midi_clip")))
        })
        .unwrap_or(false);

    let mut enriched = track.clone();
    if (has_instrument || has_midi_clip) && enriched.get("has_midi_input").is_none() {
        if let Value::Object(map) = &mut enriched {
            map.insert("has_midi_input".to_string(), Value::Bool(true));
        }
    }
    enriched
}

fn json_truthy(value: Option<&Value>) -> bool {
    match value {
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => number.as_i64() == Some(1),
        _ => false,
    }
}

/// Distinct, non-empty `track_name` values for a given event type in a session.
fn event_track_names(
    connection: &Connection,
    session_id: &str,
    event_type: &str,
) -> Result<std::collections::HashSet<String>, String> {
    let mut statement = connection
        .prepare(
            "SELECT DISTINCT track_name FROM events
             WHERE session_id = ?1 AND event_type = ?2 AND track_name IS NOT NULL",
        )
        .map_err(|error| format!("Failed to prepare track-name query: {}", error))?;

    let names = statement
        .query_map(params![session_id, event_type], |row| {
            row.get::<_, String>(0)
        })
        .map_err(|error| format!("Failed to read track names: {}", error))?
        .collect::<Result<std::collections::HashSet<_>, _>>()
        .map_err(|error| format!("Failed to collect track names: {}", error))?;

    Ok(names)
}

fn collect_change_events(
    connection: &Connection,
    session_id: &str,
) -> Result<Vec<ChangeEvent>, String> {
    let mut statement = connection
        .prepare(
            "SELECT id, timestamp_ms, track_name, track_id, device_name, parameter_name,
                    parameter_value, previous_parameter_value, parameter_value_percent,
                    previous_parameter_value_percent, parameter_display_value,
                    previous_parameter_display_value, parameter_is_quantized
             FROM events
             WHERE session_id = ?1
               AND event_type IN ('parameter_changed', 'device_parameter_changed', 'automation_created')
             ORDER BY timestamp_ms ASC, id ASC",
        )
        .map_err(|error| format!("Failed to prepare change events query: {}", error))?;

    let rows = statement
        .query_map(params![session_id], |row| {
            Ok(ChangeEvent {
                event_id: row.get::<_, i64>(0)?,
                timestamp_ms: row.get::<_, i64>(1)? as u64,
                track_name: row.get(2)?,
                track_id: row.get(3)?,
                device_name: row.get(4)?,
                parameter_name: row.get(5)?,
                value: row.get(6)?,
                previous_value: row.get(7)?,
                value_percent: row.get(8)?,
                previous_value_percent: row.get(9)?,
                display_value: row.get(10)?,
                previous_display_value: row.get(11)?,
                is_quantized: row.get::<_, Option<i64>>(12)?.map(|value| value != 0),
            })
        })
        .map_err(|error| format!("Failed to read change events: {}", error))?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Failed to collect change events: {}", error))
}

/// A flat parameter row from the DB, assembled into a nested tree afterwards.
struct ParamRow {
    id: String,
    device_id: String,
    parent: Option<String>,
    name: Option<String>,
    value: Option<f64>,
    unit: Option<String>,
    min: Option<f64>,
    max: Option<f64>,
    normalized: Option<f64>,
}

fn load_parameters_by_device(
    connection: &Connection,
    session_id: &str,
) -> Result<HashMap<String, Vec<ParameterObj>>, String> {
    let mut statement = connection
        .prepare(
            "SELECT id, device_id, parent_parameter_id, name, value, unit, min, max, normalized_value
             FROM parameters WHERE session_id = ?1
             ORDER BY chain_index ASC, id ASC",
        )
        .map_err(|error| format!("Failed to prepare parameters query: {}", error))?;

    let rows = statement
        .query_map(params![session_id], |row| {
            Ok(ParamRow {
                id: row.get(0)?,
                device_id: row.get(1)?,
                parent: row.get(2)?,
                name: row.get(3)?,
                value: row.get(4)?,
                unit: row.get(5)?,
                min: row.get(6)?,
                max: row.get(7)?,
                normalized: row.get(8)?,
            })
        })
        .map_err(|error| format!("Failed to read parameters: {}", error))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Failed to collect parameters: {}", error))?;

    let mut by_device: HashMap<String, Vec<ParamRow>> = HashMap::new();
    for row in rows {
        by_device
            .entry(row.device_id.clone())
            .or_default()
            .push(row);
    }

    let mut result = HashMap::new();
    for (device_id, device_rows) in by_device {
        result.insert(device_id, build_param_objs(None, &device_rows));
    }

    Ok(result)
}

fn build_param_objs(parent: Option<&str>, rows: &[ParamRow]) -> Vec<ParameterObj> {
    rows.iter()
        .filter(|row| row.parent.as_deref() == parent)
        .map(|row| ParameterObj {
            id: row.id.clone(),
            device_id: row.device_id.clone(),
            parent_parameter_id: row.parent.clone(),
            name: row.name.clone(),
            value: row.value,
            unit: row.unit.clone(),
            min: row.min,
            max: row.max,
            normalized_value: row.normalized,
            children: build_param_objs(Some(&row.id), rows),
        })
        .collect()
}

fn load_devices_by_track(
    connection: &Connection,
    session_id: &str,
    params_by_device: &HashMap<String, Vec<ParameterObj>>,
) -> Result<HashMap<String, Vec<DeviceObj>>, String> {
    let mut statement = connection
        .prepare(
            "SELECT id, track_id, ableton_id, name, role, chain_index, enabled
             FROM devices WHERE session_id = ?1
             ORDER BY chain_index ASC, id ASC",
        )
        .map_err(|error| format!("Failed to prepare devices query: {}", error))?;

    let rows = statement
        .query_map(params![session_id], |row| {
            let id: String = row.get(0)?;
            let role: String = row.get(4)?;
            Ok(DeviceObj {
                parameters: params_by_device.get(&id).cloned().unwrap_or_default(),
                id,
                track_id: row.get(1)?,
                ableton_id: row.get(2)?,
                name: row.get(3)?,
                role: DeviceRole::from_str(&role),
                chain_index: row.get::<_, Option<i64>>(5)?.unwrap_or(0),
                enabled: row.get::<_, i64>(6)? != 0,
            })
        })
        .map_err(|error| format!("Failed to read devices: {}", error))?;

    let mut by_track: HashMap<String, Vec<DeviceObj>> = HashMap::new();
    for row in rows {
        let device = row.map_err(|error| format!("Failed to read device: {}", error))?;
        by_track
            .entry(device.track_id.clone())
            .or_default()
            .push(device);
    }

    Ok(by_track)
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

        CREATE TABLE IF NOT EXISTS projects (
            id TEXT PRIMARY KEY,
            display_name TEXT NOT NULL,
            ableton_name TEXT,
            ableton_path TEXT,
            archived_at_ms INTEGER,
            created_at_ms INTEGER NOT NULL,
            updated_at_ms INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_projects_archived
        ON projects(archived_at_ms);

        CREATE INDEX IF NOT EXISTS idx_projects_ableton_path
        ON projects(ableton_path);

        CREATE INDEX IF NOT EXISTS idx_projects_ableton_name
        ON projects(ableton_name);

        -- A small, local studio planner. Tasks deliberately link to projects by
        -- id without requiring one, because releases, admin, and practice work
        -- are all real work even when they do not belong to one Ableton set.
        CREATE TABLE IF NOT EXISTS planner_tasks (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            due_date TEXT NOT NULL,
            due_time TEXT,
            task_type TEXT NOT NULL,
            project_id TEXT,
            notes TEXT,
            completed INTEGER NOT NULL DEFAULT 0,
            created_at_ms INTEGER NOT NULL,
            updated_at_ms INTEGER NOT NULL,
            FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE SET NULL
        );

        CREATE INDEX IF NOT EXISTS idx_planner_tasks_due
        ON planner_tasks(completed, due_date, due_time);

        CREATE INDEX IF NOT EXISTS idx_planner_tasks_project
        ON planner_tasks(project_id);

        -- Explorer-style facts are an explicitly refreshed cache of each
        -- connected folder, not a second copy of the project itself.
        CREATE TABLE IF NOT EXISTS project_folder_metadata (
            project_id TEXT PRIMARY KEY,
            created_at_ms INTEGER,
            modified_at_ms INTEGER,
            latest_file_modified_at_ms INTEGER,
            file_count INTEGER NOT NULL,
            total_size_bytes INTEGER NOT NULL,
            als_file_count INTEGER NOT NULL,
            audio_file_count INTEGER NOT NULL,
            scanned_at_ms INTEGER NOT NULL,
            FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS sessions (
            id TEXT PRIMARY KEY,
            project_id TEXT,
            capture_name TEXT,
            capture_status TEXT,
            project_name TEXT,
            project_path TEXT,
            display_name TEXT,
            started_at_ms INTEGER NOT NULL,
            ended_at_ms INTEGER,
            created_at_ms INTEGER NOT NULL,
            FOREIGN KEY(project_id) REFERENCES projects(id)
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
            track_id TEXT,
            track_type TEXT,
            device_name TEXT,
            device_chain TEXT,
            parameter_name TEXT,
            parameter_value REAL,
            previous_parameter_value REAL,
            parameter_value_percent REAL,
            previous_parameter_value_percent REAL,
            parameter_display_value TEXT,
            previous_parameter_display_value TEXT,
            parameter_is_quantized INTEGER,
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

        -- ── Normalized schema (rebuildable projection of the events log) ──────────
        -- These tables are a derived view of the immutable `events` table. They are
        -- DELETEd + re-INSERTed per session by `materialize_session_schema`, so they
        -- can always be rebuilt from the raw events without data loss. The one
        -- exception is the creative-memory tables below, which are user-authored and
        -- never touched by materialization.
        CREATE TABLE IF NOT EXISTS tracks (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            ableton_id TEXT,
            name TEXT,
            number INTEGER,
            type TEXT NOT NULL,            -- midi | audio | return | group
            color TEXT,
            group_id TEXT,                 -- parent group track id (nullable)
            chain_index INTEGER,
            FOREIGN KEY(session_id) REFERENCES sessions(id)
        );

        CREATE INDEX IF NOT EXISTS idx_tracks_session ON tracks(session_id);

        CREATE TABLE IF NOT EXISTS devices (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            track_id TEXT NOT NULL,
            ableton_id TEXT,
            name TEXT,
            role TEXT NOT NULL,            -- instrument | midi_effect | audio_effect
            vendor TEXT,
            plugin_format TEXT,            -- native | vst | vst3 | au | aax | unknown
            preset_name TEXT,
            chain_index INTEGER NOT NULL,
            enabled INTEGER NOT NULL DEFAULT 1,
            FOREIGN KEY(session_id) REFERENCES sessions(id)
        );

        CREATE INDEX IF NOT EXISTS idx_devices_session ON devices(session_id);
        CREATE INDEX IF NOT EXISTS idx_devices_track ON devices(track_id);

        CREATE TABLE IF NOT EXISTS parameters (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            device_id TEXT NOT NULL,
            parent_parameter_id TEXT,      -- nested params (children[])
            name TEXT,
            value REAL,
            unit TEXT,
            min REAL,
            max REAL,
            normalized_value REAL,
            chain_index INTEGER,
            FOREIGN KEY(session_id) REFERENCES sessions(id)
        );

        CREATE INDEX IF NOT EXISTS idx_parameters_session ON parameters(session_id);
        CREATE INDEX IF NOT EXISTS idx_parameters_device ON parameters(device_id);

        CREATE TABLE IF NOT EXISTS parameter_changes (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            parameter_id TEXT,             -- null if no matching tree param (legacy)
            track_name TEXT,
            track_id TEXT,                 -- Live's stable track pointer; disambiguates same-named tracks
            device_name TEXT,
            parameter_name TEXT,
            before_value REAL,
            after_value REAL,
            before_value_percent REAL,
            after_value_percent REAL,
            unit TEXT,
            before_display_value TEXT,
            after_display_value TEXT,
            is_quantized INTEGER,
            reason TEXT,
            changed_at_ms INTEGER NOT NULL,
            source_event_id INTEGER,
            FOREIGN KEY(session_id) REFERENCES sessions(id)
        );

        CREATE INDEX IF NOT EXISTS idx_parameter_changes_session
        ON parameter_changes(session_id);
        CREATE INDEX IF NOT EXISTS idx_parameter_changes_changed_at
        ON parameter_changes(changed_at_ms);

        -- ── Creative memory (user-authored, persistent across re-materialization) ──
        CREATE TABLE IF NOT EXISTS creative_moments (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            title TEXT NOT NULL,
            type TEXT NOT NULL,            -- sound_design|arrangement|mix_move|automation|routing|happy_accident|idea_to_revisit
            timeline_start_ms INTEGER,
            timeline_end_ms INTEGER,
            note TEXT,
            tags TEXT,                     -- JSON array of strings
            confidence TEXT NOT NULL DEFAULT 'rough',  -- rough|working|keeper|final
            created_at_ms INTEGER NOT NULL,
            updated_at_ms INTEGER NOT NULL,
            FOREIGN KEY(session_id) REFERENCES sessions(id)
        );

        CREATE INDEX IF NOT EXISTS idx_creative_moments_session
        ON creative_moments(session_id);

        CREATE TABLE IF NOT EXISTS creative_moment_targets (
            moment_id TEXT NOT NULL,
            target_type TEXT NOT NULL,     -- track|device|parameter|parameter_change|clip
            target_id TEXT NOT NULL,
            PRIMARY KEY (moment_id, target_type, target_id),
            FOREIGN KEY(moment_id) REFERENCES creative_moments(id)
        );
        ",
    )?;

    // Bring older databases up to the current schema.
    migrate_session_columns(&connection)?;
    connection.execute_batch(
        "
        CREATE INDEX IF NOT EXISTS idx_sessions_project
        ON sessions(project_id);
        ",
    )?;
    migrate_event_columns(&connection)?;
    migrate_parameter_change_columns(&connection)?;
    backfill_projects(&connection)?;
    crate::organizer::initialize_schema(&connection)?;

    Ok(())
}

fn migrate_session_columns(connection: &Connection) -> rusqlite::Result<()> {
    let existing: std::collections::HashSet<String> = {
        let mut statement = connection.prepare("PRAGMA table_info(sessions)")?;
        let names = statement.query_map([], |row| row.get::<_, String>(1))?;
        names.collect::<rusqlite::Result<_>>()?
    };

    const COLUMNS: &[(&str, &str)] = &[
        ("project_id", "TEXT"),
        ("capture_name", "TEXT"),
        ("capture_status", "TEXT"),
        ("project_name", "TEXT"),
        ("project_path", "TEXT"),
        ("display_name", "TEXT"),
        // The `.als` file a take is anchored to, and how the take originated
        // (`recorded` = has live telemetry, `scanned` = found on disk by a scan).
        ("als_path", "TEXT"),
        ("take_origin", "TEXT NOT NULL DEFAULT 'recorded'"),
    ];

    for (name, sql_type) in COLUMNS {
        if !existing.contains(*name) {
            connection.execute_batch(&format!(
                "ALTER TABLE sessions ADD COLUMN {name} {sql_type};"
            ))?;
        }
    }

    // Backfill als_path for existing takes from the open set they saw, so takes
    // created before file-anchoring still resolve to a `.als`.
    if !existing.contains("als_path") {
        connection.execute_batch(
            "
            UPDATE sessions
            SET als_path = project_path
            WHERE als_path IS NULL
              AND project_path IS NOT NULL
              AND project_path LIKE '%.als';
            ",
        )?;
    }

    Ok(())
}

fn backfill_projects(connection: &Connection) -> rusqlite::Result<()> {
    let sessions = {
        let mut statement = connection.prepare(
            "
            SELECT id, project_name, project_path, display_name, started_at_ms, created_at_ms
            FROM sessions
            WHERE project_id IS NULL
              AND (
                (project_name IS NOT NULL AND TRIM(project_name) != '')
                OR (project_path IS NOT NULL AND TRIM(project_path) != '')
                OR (display_name IS NOT NULL AND TRIM(display_name) != '')
              )
            ORDER BY started_at_ms ASC
            ",
        )?;

        let rows = statement.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, i64>(5)?,
            ))
        })?;

        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };

    for (session_id, project_name, project_path, display_name, started_at_ms, created_at_ms) in
        sessions
    {
        let clean_project_name = clean_optional(project_name.as_deref());
        let clean_project_path = clean_optional(project_path.as_deref());
        let clean_display_name = clean_optional(display_name.as_deref());

        let matched_by_path = if let Some(path) = clean_project_path {
            connection
                .query_row(
                    "
                    SELECT id FROM projects
                    WHERE ableton_path = ?1 AND archived_at_ms IS NULL
                    ORDER BY updated_at_ms DESC
                    LIMIT 1
                    ",
                    params![path],
                    |row| row.get::<_, String>(0),
                )
                .optional()?
        } else {
            None
        };

        let match_name = clean_project_name.or(clean_display_name);
        let matched_project_id = if matched_by_path.is_some() {
            matched_by_path
        } else if let Some(name) = match_name {
            connection
                .query_row(
                    "
                    SELECT id FROM projects
                    WHERE archived_at_ms IS NULL
                      AND (ableton_name = ?1 OR display_name = ?1)
                    ORDER BY updated_at_ms DESC
                    LIMIT 1
                    ",
                    params![name],
                    |row| row.get::<_, String>(0),
                )
                .optional()?
        } else {
            None
        };

        let project_id = if let Some(project_id) = matched_project_id {
            connection.execute(
                "
                UPDATE projects
                SET
                    ableton_name = COALESCE(ableton_name, ?1),
                    ableton_path = COALESCE(ableton_path, ?2),
                    updated_at_ms = MAX(updated_at_ms, ?3)
                WHERE id = ?4
                ",
                params![
                    clean_project_name,
                    clean_project_path,
                    created_at_ms,
                    project_id
                ],
            )?;
            project_id
        } else {
            let project_id = format!("project-{}-{}", started_at_ms, session_id);
            let display = clean_display_name
                .or(clean_project_name)
                .map(str::to_string)
                .or_else(|| clean_project_path.and_then(project_name_from_path))
                .unwrap_or_else(|| "Untitled Ableton Set".to_string());
            let created = if created_at_ms > 0 {
                created_at_ms
            } else {
                now_ms() as i64
            };

            connection.execute(
                "
                INSERT OR IGNORE INTO projects (
                    id, display_name, ableton_name, ableton_path,
                    archived_at_ms, created_at_ms, updated_at_ms
                )
                VALUES (?1, ?2, ?3, ?4, NULL, ?5, ?6)
                ",
                params![
                    project_id,
                    display,
                    clean_project_name,
                    clean_project_path,
                    created,
                    created,
                ],
            )?;
            project_id
        };

        connection.execute(
            "UPDATE sessions SET project_id = ?1 WHERE id = ?2 AND project_id IS NULL",
            params![project_id, session_id],
        )?;
    }

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
        ("track_id", "TEXT"),
        ("track_type", "TEXT"),
        ("device_name", "TEXT"),
        ("device_chain", "TEXT"),
        ("parameter_name", "TEXT"),
        ("parameter_value", "REAL"),
        ("previous_parameter_value", "REAL"),
        ("parameter_value_percent", "REAL"),
        ("previous_parameter_value_percent", "REAL"),
        ("parameter_display_value", "TEXT"),
        ("previous_parameter_display_value", "TEXT"),
        ("parameter_is_quantized", "INTEGER"),
        ("clip_name", "TEXT"),
        ("sample_name", "TEXT"),
        ("file_path", "TEXT"),
        ("bpm", "REAL"),
        ("playing", "INTEGER"),
    ];

    for (name, sql_type) in COLUMNS {
        if !existing.contains(*name) {
            connection
                .execute_batch(&format!("ALTER TABLE events ADD COLUMN {name} {sql_type};"))?;
        }
    }

    Ok(())
}

fn migrate_parameter_change_columns(connection: &Connection) -> rusqlite::Result<()> {
    let existing: std::collections::HashSet<String> = {
        let mut statement = connection.prepare("PRAGMA table_info(parameter_changes)")?;
        let names = statement.query_map([], |row| row.get::<_, String>(1))?;
        names.collect::<rusqlite::Result<_>>()?
    };

    const COLUMNS: &[(&str, &str)] = &[
        ("before_value_percent", "REAL"),
        ("after_value_percent", "REAL"),
        ("before_display_value", "TEXT"),
        ("after_display_value", "TEXT"),
        ("is_quantized", "INTEGER"),
        ("track_id", "TEXT"),
    ];

    for (name, sql_type) in COLUMNS {
        if !existing.contains(*name) {
            connection.execute_batch(&format!(
                "ALTER TABLE parameter_changes ADD COLUMN {name} {sql_type};"
            ))?;
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
            track_id: None,
            track_type: None,
            device_name: None,
            parameter_name: None,
            parameter_value: None,
            previous_parameter_value: None,
            parameter_value_percent: None,
            previous_parameter_value_percent: None,
            parameter_display_value: None,
            previous_parameter_display_value: None,
            parameter_is_quantized: None,
            clip_name: None,
            sample_name: None,
            file_path: None,
            project_name: None,
            project_path: None,
            device_chain: None,
            bpm: None,
            playing: None,
        }
    }

    #[test]
    fn planner_tasks_round_trip_through_local_storage() {
        let (storage, path) = temp_storage();
        let created = storage
            .create_planner_task(
                "plan-1",
                "Print mix notes",
                "2026-08-09",
                Some("10:30"),
                "mix",
                None,
                Some("Listen on headphones and car speakers."),
            )
            .unwrap();
        assert!(!created.completed);
        assert_eq!(storage.list_planner_tasks().unwrap().len(), 1);

        let updated = storage
            .update_planner_task(
                "plan-1",
                "Print final mix notes",
                "2026-08-10",
                None,
                "master",
                None,
                None,
                true,
            )
            .unwrap();
        assert!(updated.completed);
        assert_eq!(updated.created_at_ms, created.created_at_ms);

        let listed = storage.list_planner_tasks().unwrap();
        assert_eq!(listed[0].title, "Print final mix notes");
        assert_eq!(listed[0].task_type, "master");
        assert_eq!(listed[0].due_date, "2026-08-10");
        assert!(listed[0].due_time.is_none());

        storage.delete_planner_task("plan-1").unwrap();
        assert!(storage.list_planner_tasks().unwrap().is_empty());
        cleanup(&path);
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
        assert_eq!(
            event.sample_name.as_deref(),
            Some("Deep_House_Vocal_120bpm.wav")
        );
        assert_eq!(
            event.file_path.as_deref(),
            Some("C:/Splice/Deep_House_Vocal_120bpm.wav")
        );
        assert_eq!(event.device_chain.as_deref(), Some("Serum 2 : Saturator"));
        assert_eq!(event.bpm, Some(124.0));
        assert_eq!(event.playing, Some(true));

        cleanup(&path);
    }

    #[test]
    fn ableton_project_creates_project_without_renaming_capture() {
        let (storage, path) = temp_storage();
        let session = storage.resume_or_create_active_session().unwrap();
        let session_id = session.session_id.clone().unwrap();

        storage
            .remember_ableton_project(
                &session_id,
                Some("Drum practice_128"),
                Some("C:/Ableton/Drum practice_128.als"),
            )
            .unwrap();

        let detected = storage
            .list_saved_sessions()
            .unwrap()
            .into_iter()
            .find(|session| session.id == session_id)
            .unwrap();
        assert!(detected.name.starts_with("Session "));
        assert!(detected.project_id.is_some());
        assert_eq!(detected.project_name.as_deref(), Some("Drum practice_128"));
        assert_eq!(
            detected.project_path.as_deref(),
            Some("C:/Ableton/Drum practice_128.als")
        );

        let projects = storage.list_projects(false).unwrap();
        assert_eq!(projects.len(), 1);
        assert_eq!(projects[0].display_name, "Drum practice_128");
        assert_eq!(
            projects[0].ableton_name.as_deref(),
            Some("Drum practice_128")
        );
        assert_eq!(projects[0].captures.len(), 1);
        assert_eq!(projects[0].captures[0].id, session_id);

        storage
            .rename_capture(&session_id, "Verse sound check")
            .unwrap();

        let renamed = storage
            .list_saved_sessions()
            .unwrap()
            .into_iter()
            .find(|session| session.id == session_id)
            .unwrap();
        assert_eq!(renamed.name, "Verse sound check");
        assert_eq!(renamed.capture_name.as_deref(), Some("Verse sound check"));

        storage
            .rename_project(
                detected.project_id.as_deref().unwrap(),
                "Drum Practice - Verse Ideas",
            )
            .unwrap();
        let renamed_project = storage.list_projects(false).unwrap().remove(0);
        assert_eq!(renamed_project.display_name, "Drum Practice - Verse Ideas");

        cleanup(&path);
    }

    #[test]
    fn rescan_adds_a_take_per_als_version_and_is_idempotent() {
        let (storage, path) = temp_storage();
        let project_id = storage
            .create_project("Idols Perseus", None, Some("/Projects/Idols Perseus Project"))
            .unwrap();

        let files = |names: &[&str]| -> Vec<(String, String, u64)> {
            names
                .iter()
                .enumerate()
                .map(|(i, name)| {
                    (
                        (*name).to_string(),
                        format!("/Projects/Idols Perseus Project/{name}.als"),
                        1_000 + i as u64,
                    )
                })
                .collect()
        };

        // First scan picks up all three versions as scanned takes.
        let added = storage
            .rescan_project_takes(&project_id, &files(&["v7", "v8", "v9"]))
            .unwrap();
        assert_eq!(added, 3);

        let project = storage.list_projects(false).unwrap().remove(0);
        assert_eq!(project.captures.len(), 3);
        for take in &project.captures {
            assert_eq!(take.take_origin, "scanned");
            assert!(take.als_path.is_some());
            // Scanned takes must never look like an active recording.
            assert!(take.ended_at_ms.is_some());
        }

        // Re-scanning the same files adds nothing.
        let again = storage
            .rescan_project_takes(&project_id, &files(&["v7", "v8", "v9"]))
            .unwrap();
        assert_eq!(again, 0);

        // A newly-saved version is the only thing a later scan adds.
        let after_save = storage
            .rescan_project_takes(&project_id, &files(&["v7", "v8", "v9", "v10"]))
            .unwrap();
        assert_eq!(after_save, 1);
        assert_eq!(storage.list_projects(false).unwrap().remove(0).captures.len(), 4);

        cleanup(&path);
    }

    #[test]
    fn scanned_takes_report_their_file_date_not_the_scan_date() {
        let (storage, path) = temp_storage();
        let project_id = storage
            .create_project("Idols Perseus", None, Some("/Projects/Idols Perseus Project"))
            .unwrap();

        // A version last saved long ago (mtime well in the past). Connecting a
        // folder today must surface it with the file's real date, exactly like
        // Explorer's "Date modified" — never "updated today" because the scan
        // ran today.
        let old_mtime = 1_700_000_000_000u64;
        storage
            .rescan_project_takes(
                &project_id,
                &[(
                    "v7".to_string(),
                    "/Projects/Idols Perseus Project/v7.als".to_string(),
                    old_mtime,
                )],
            )
            .unwrap();

        let project = storage.list_projects(false).unwrap().remove(0);
        let take = &project.captures[0];
        assert_eq!(take.started_at_ms, old_mtime);
        assert_eq!(take.last_updated_at_ms, old_mtime);
        // The project's own recency inherits the newest file's date too.
        assert_eq!(project.last_updated_at_ms, old_mtime);

        cleanup(&path);
    }

    #[test]
    fn opening_a_project_resumes_the_take_for_the_open_als() {
        let (storage, path) = temp_storage();
        let project_id = storage
            .create_project("Idols Perseus", None, Some("/Projects/Idols Perseus Project"))
            .unwrap();
        let als = |name: &str| format!("/Projects/Idols Perseus Project/{name}.als");

        storage
            .rescan_project_takes(
                &project_id,
                &[
                    ("v7".into(), als("v7"), 1_000),
                    ("v8".into(), als("v8"), 2_000),
                ],
            )
            .unwrap();

        let scanned_v8 = storage
            .list_projects(false)
            .unwrap()
            .remove(0)
            .captures
            .into_iter()
            .find(|take| take.als_path.as_deref() == Some(als("v8").as_str()))
            .unwrap();
        assert_eq!(scanned_v8.take_origin, "scanned");

        // Opening with v8 open resumes that exact take and promotes it to recorded.
        let opened = storage
            .activate_take_for_open_file(Some(&project_id), Some(&als("v8")))
            .unwrap();
        assert_eq!(opened.session_id.as_deref(), Some(scanned_v8.id.as_str()));
        assert!(opened.active);
        assert!(opened.ended_at_ms.is_none());

        let v8_after = storage
            .load_session(&scanned_v8.id)
            .unwrap();
        assert_eq!(v8_after.take_origin, "recorded");
        assert_eq!(v8_after.als_path.as_deref(), Some(als("v8").as_str()));

        // Re-opening the same file returns the same take (continue on, no duplicate).
        let reopened = storage
            .activate_take_for_open_file(Some(&project_id), Some(&als("v8")))
            .unwrap();
        assert_eq!(reopened.session_id.as_deref(), Some(scanned_v8.id.as_str()));

        // A never-seen open file gets a brand-new take anchored to it.
        let fresh = storage
            .activate_take_for_open_file(Some(&project_id), Some(&als("v9")))
            .unwrap();
        assert_ne!(fresh.session_id.as_deref(), Some(scanned_v8.id.as_str()));
        let fresh_take = storage.load_session(fresh.session_id.as_deref().unwrap()).unwrap();
        assert_eq!(fresh_take.als_path.as_deref(), Some(als("v9").as_str()));
        assert_eq!(fresh_take.take_origin, "recorded");

        cleanup(&path);
    }

    #[test]
    fn relinking_a_take_repoints_it_and_absorbs_the_scanned_placeholder() {
        let (storage, path) = temp_storage();
        let project_id = storage
            .create_project("Idols Perseus", None, Some("/Projects/Idols Perseus Project"))
            .unwrap();
        let als = |name: &str| format!("/Projects/Idols Perseus Project/{name}.als");

        storage
            .rescan_project_takes(
                &project_id,
                &[("v8".into(), als("v8"), 1_000), ("v8 final".into(), als("v8 final"), 2_000)],
            )
            .unwrap();

        // Record onto v8 (promotes it), simulating a real take with history.
        let recorded = storage
            .activate_take_for_open_file(Some(&project_id), Some(&als("v8")))
            .unwrap();
        let recorded_id = recorded.session_id.unwrap();

        // The producer renamed v8 -> "v8 final"; move the recorded history onto it.
        // The scanned placeholder for "v8 final" should be absorbed (no duplicate).
        storage.relink_take(&recorded_id, &als("v8 final")).unwrap();

        let captures = storage.list_projects(false).unwrap().remove(0).captures;
        let final_takes: Vec<_> = captures
            .iter()
            .filter(|take| take.als_path.as_deref() == Some(als("v8 final").as_str()))
            .collect();
        assert_eq!(final_takes.len(), 1, "placeholder should be absorbed, not duplicated");
        assert_eq!(final_takes[0].id, recorded_id);
        assert_eq!(final_takes[0].take_origin, "recorded");

        // Relinking onto a file a *recorded* take already owns is refused.
        storage
            .activate_take_for_open_file(Some(&project_id), Some(&als("v8")))
            .unwrap();
        let blocked = storage.relink_take(&recorded_id, &als("v8"));
        assert!(blocked.is_err());

        cleanup(&path);
    }

    #[test]
    fn delete_session_removes_timeline_schema_rows_first() {
        let (storage, path) = temp_storage();
        let session = storage.resume_or_create_active_session().unwrap();
        let session_id = session.session_id.clone().unwrap();

        let connection = Connection::open(&path).unwrap();
        connection
            .execute_batch("PRAGMA foreign_keys = ON;")
            .unwrap();
        connection
            .execute(
                "
                INSERT INTO tracks (
                    id, session_id, ableton_id, name, number, type, color, group_id, chain_index
                )
                VALUES ('track-1', ?1, 'ableton-track-1', 'Bass', 1, 'midi', NULL, NULL, 0)
                ",
                params![session_id],
            )
            .unwrap();
        connection
            .execute(
                "
                INSERT INTO devices (
                    id, session_id, track_id, ableton_id, name, role, vendor,
                    plugin_format, preset_name, chain_index, enabled
                )
                VALUES ('device-1', ?1, 'track-1', 'ableton-device-1', 'Serum', 'instrument',
                        NULL, 'vst3', NULL, 0, 1)
                ",
                params![session_id],
            )
            .unwrap();
        connection
            .execute(
                "
                INSERT INTO parameters (
                    id, session_id, device_id, parent_parameter_id, name, value, unit,
                    min, max, normalized_value, chain_index
                )
                VALUES ('parameter-1', ?1, 'device-1', NULL, 'Cutoff', 0.5, NULL,
                        0.0, 1.0, 0.5, 0)
                ",
                params![session_id],
            )
            .unwrap();
        connection
            .execute(
                "
                INSERT INTO parameter_changes (
                    id, session_id, parameter_id, track_name, device_name, parameter_name,
                    before_value, after_value, unit, reason, changed_at_ms, source_event_id
                )
                VALUES ('change-1', ?1, 'parameter-1', 'Bass', 'Serum', 'Cutoff',
                        0.2, 0.5, NULL, NULL, 1234, NULL)
                ",
                params![session_id],
            )
            .unwrap();
        connection
            .execute(
                "
                INSERT INTO creative_moments (
                    id, session_id, title, type, timeline_start_ms, timeline_end_ms,
                    note, tags, confidence, created_at_ms, updated_at_ms
                )
                VALUES ('moment-1', ?1, 'Nice bass', 'sound_design', NULL, NULL,
                        NULL, '[]', 'rough', 1234, 1234)
                ",
                params![session_id],
            )
            .unwrap();
        connection
            .execute(
                "
                INSERT INTO creative_moment_targets (moment_id, target_type, target_id)
                VALUES ('moment-1', 'parameter', 'parameter-1')
                ",
                [],
            )
            .unwrap();
        drop(connection);

        storage.delete_session(&session_id).unwrap();

        let connection = Connection::open(&path).unwrap();
        for table in [
            "sessions",
            "tracks",
            "devices",
            "parameters",
            "parameter_changes",
            "creative_moments",
            "creative_moment_targets",
        ] {
            let count: i64 = connection
                .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                    row.get(0)
                })
                .unwrap();
            assert_eq!(count, 0, "{table} rows should be deleted");
        }

        cleanup(&path);
    }

    #[test]
    fn fresh_startup_session_is_empty_and_unanchored() {
        // This is exactly the throwaway session resume_or_create_active_session
        // creates when there's no unfinished take to resume (#7): no events,
        // no als_path. Auto-rotation should be free to delete it.
        let (storage, path) = temp_storage();
        let session_id = storage
            .resume_or_create_active_session()
            .unwrap()
            .session_id
            .unwrap();

        assert!(storage.is_session_empty_and_unanchored(&session_id).unwrap());

        cleanup(&path);
    }

    #[test]
    fn session_with_events_is_not_empty() {
        let (storage, path) = temp_storage();
        let session_id = storage
            .resume_or_create_active_session()
            .unwrap()
            .session_id
            .unwrap();

        storage
            .save_events_batch(&[event(&session_id, "heartbeat")])
            .unwrap();

        assert!(!storage.is_session_empty_and_unanchored(&session_id).unwrap());

        cleanup(&path);
    }

    #[test]
    fn anchored_session_is_not_unanchored_even_with_no_events() {
        let (storage, path) = temp_storage();
        let session_id = storage
            .resume_or_create_active_session()
            .unwrap()
            .session_id
            .unwrap();

        let connection = Connection::open(&path).unwrap();
        connection
            .execute(
                "UPDATE sessions SET als_path = ?1 WHERE id = ?2",
                params!["C:/music/song.als", session_id],
            )
            .unwrap();
        drop(connection);

        assert!(!storage.is_session_empty_and_unanchored(&session_id).unwrap());

        cleanup(&path);
    }

    #[test]
    fn nonexistent_session_is_not_flagged_for_cleanup() {
        let (storage, path) = temp_storage();
        // No session ever created for this id.
        assert!(!storage
            .is_session_empty_and_unanchored("session-does-not-exist")
            .unwrap());
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

        for expected in [
            "track_name",
            "track_id",
            "track_type",
            "device_chain",
            "previous_parameter_value",
            "parameter_value_percent",
            "previous_parameter_value_percent",
            "sample_name",
            "file_path",
            "bpm",
            "playing",
        ] {
            assert!(
                columns.contains(expected),
                "migration missing column: {expected}"
            );
        }

        // Running it again must be a harmless no-op (idempotent).
        migrate_event_columns(&connection).unwrap();

        drop(connection);
        cleanup(&path);
    }

    #[test]
    fn migration_backfills_projects_from_legacy_session_names() {
        let name = format!(
            "recall-test-project-migrate-{}-{}.sqlite",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        );
        let path = std::env::temp_dir().join(name);
        let _ = std::fs::remove_file(&path);

        let connection = Connection::open(&path).unwrap();
        connection
            .execute_batch(
                "
                CREATE TABLE sessions (
                    id TEXT PRIMARY KEY,
                    project_name TEXT,
                    project_path TEXT,
                    display_name TEXT,
                    started_at_ms INTEGER NOT NULL,
                    ended_at_ms INTEGER,
                    created_at_ms INTEGER NOT NULL
                );

                CREATE TABLE events (
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
                );

                INSERT INTO sessions (
                    id, project_name, project_path, display_name,
                    started_at_ms, ended_at_ms, created_at_ms
                )
                VALUES (
                    'session-1000', 'Ableton Detected Name',
                    'C:/Ableton/Song Version.als', 'Producer Rename',
                    1000, 2000, 1000
                );
                ",
            )
            .unwrap();
        drop(connection);

        initialize_database(&path).unwrap();

        let mut storage = StorageState::new();
        storage.configure(path.clone());
        let projects = storage.list_projects(false).unwrap();

        assert_eq!(projects.len(), 1);
        assert_eq!(projects[0].display_name, "Producer Rename");
        assert_eq!(
            projects[0].ableton_name.as_deref(),
            Some("Ableton Detected Name")
        );
        assert_eq!(
            projects[0].ableton_path.as_deref(),
            Some("C:/Ableton/Song Version.als")
        );
        assert_eq!(projects[0].captures.len(), 1);
        assert_eq!(projects[0].captures[0].id, "session-1000");
        assert_eq!(
            projects[0].captures[0].project_id.as_deref(),
            Some(projects[0].id.as_str())
        );

        cleanup(&path);
    }

    /// A live_set_snapshot event carrying a deep payload, for materialization tests.
    fn snapshot_event(session_id: &str, payload: serde_json::Value) -> RecallEvent {
        let mut event = event(session_id, "live_set_snapshot");
        event.payload = Some(payload.to_string());
        event
    }

    /// A parameter_changed event with the canonical fields the materializer reads.
    fn param_change(
        session_id: &str,
        timestamp_ms: u64,
        track: &str,
        device: &str,
        parameter: &str,
        value: f64,
    ) -> RecallEvent {
        let mut event = event(session_id, "parameter_changed");
        event.timestamp_ms = timestamp_ms;
        event.track_name = Some(track.into());
        event.device_name = Some(device.into());
        event.parameter_name = Some(parameter.into());
        event.parameter_value = Some(value);
        event.parameter_value_percent = Some(value * 100.0);
        event
    }

    /// Same as `param_change`, but also carries the bridge's `track_id` — the
    /// value real captures send on every parameter change.
    fn param_change_with_id(
        session_id: &str,
        timestamp_ms: u64,
        track: &str,
        track_id: &str,
        device: &str,
        parameter: &str,
        value: f64,
    ) -> RecallEvent {
        let mut event = param_change(session_id, timestamp_ms, track, device, parameter, value);
        event.track_id = Some(track_id.into());
        event
    }

    #[test]
    fn materialize_keeps_same_named_tracks_separate_when_track_id_present() {
        // Ableton auto-names a track after its first device, so two different
        // tracks can both end up called "Serum 2". Their ableton track ids
        // ("100" and "101" below) are what tells them apart.
        let (storage, path) = temp_storage();
        let session_id = storage
            .resume_or_create_active_session()
            .unwrap()
            .session_id
            .unwrap();

        let snapshot = serde_json::json!({
            "tracks": [
                {
                    "index": 0, "id": "100", "name": "Serum 2", "has_midi_input": true,
                    "devices": [
                        { "id": "200", "name": "Serum 2", "role": "instrument", "is_active": true,
                          "parameters": [{ "id": "300", "name": "Cutoff", "value": 0.2, "min": 0.0, "max": 1.0 }] }
                    ]
                },
                {
                    "index": 1, "id": "101", "name": "Serum 2", "has_midi_input": true,
                    "devices": [
                        { "id": "210", "name": "Serum 2", "role": "instrument", "is_active": true,
                          "parameters": [{ "id": "310", "name": "Cutoff", "value": 0.4, "min": 0.0, "max": 1.0 }] }
                    ]
                }
            ]
        });

        storage
            .save_events_batch(&[
                snapshot_event(&session_id, snapshot),
                param_change_with_id(&session_id, 1_000, "Serum 2", "100", "Serum 2", "Cutoff", 0.2),
                param_change_with_id(&session_id, 2_000, "Serum 2", "101", "Serum 2", "Cutoff", 0.4),
            ])
            .unwrap();

        storage.materialize_session_schema(&session_id).unwrap();

        let changes = storage.get_parameter_changes(&session_id).unwrap();
        assert_eq!(changes.len(), 2);
        // Each is the first (and only) change for its own track: neither
        // inherits a "before" value from the other, because despite sharing a
        // name they are different tracks.
        assert!(
            changes.iter().all(|c| c.before_value.is_none()),
            "same-named tracks must not share a before/after chain: {:?}",
            changes,
        );
        assert_eq!(changes[0].track_id.as_deref(), Some("100"));
        assert_eq!(changes[1].track_id.as_deref(), Some("101"));
        // parameter_id links to each track's own Cutoff param, not either
        // other's.
        assert_ne!(changes[0].parameter_id, changes[1].parameter_id);
        assert!(changes[0].parameter_id.is_some());
        assert!(changes[1].parameter_id.is_some());

        cleanup(&path);
    }

    #[test]
    fn materialize_builds_typed_tree_and_parameter_changes() {
        let (storage, path) = temp_storage();
        let session_id = storage
            .resume_or_create_active_session()
            .unwrap()
            .session_id
            .unwrap();

        let snapshot = serde_json::json!({
            "tracks": [
                {
                    "index": 0, "id": "100", "name": "Bass 1", "has_midi_input": true,
                    "devices": [
                        { "id": "200", "name": "Synth", "role": "instrument", "is_active": true,
                          "parameters": [{ "id": "300", "name": "Cutoff", "value": 0.2, "min": 0.0, "max": 1.0 }] },
                        { "id": "201", "name": "Sat", "role": "audio_effect", "is_active": true, "parameters": [] }
                    ]
                },
                {
                    "index": 1, "id": "101", "name": "Vox", "has_midi_input": false,
                    "devices": [{ "id": "210", "name": "EQ", "role": "audio_effect", "is_active": true, "parameters": [] }]
                }
            ]
        });

        storage
            .save_events_batch(&[
                snapshot_event(&session_id, snapshot),
                param_change(&session_id, 1_000, "Bass 1", "Synth", "Cutoff", 0.2),
                param_change(&session_id, 2_000, "Bass 1", "Synth", "Cutoff", 0.5),
            ])
            .unwrap();

        storage.materialize_session_schema(&session_id).unwrap();

        let schema = storage.get_project_schema(&session_id).unwrap();
        assert!(schema.has_snapshot);
        assert_eq!(schema.tracks.len(), 2);

        let bass = schema
            .tracks
            .iter()
            .find(|t| t.name.as_deref() == Some("Bass 1"))
            .expect("bass track");
        assert_eq!(bass.track_type, TrackType::Midi);
        assert_eq!(bass.devices.len(), 2);
        assert_eq!(bass.devices[0].role, DeviceRole::Instrument);
        assert_eq!(bass.devices[0].parameters.len(), 1);
        assert_eq!(bass.devices[1].role, DeviceRole::AudioEffect);

        let vox = schema
            .tracks
            .iter()
            .find(|t| t.name.as_deref() == Some("Vox"))
            .expect("vox track");
        assert_eq!(vox.track_type, TrackType::Audio);

        let changes = storage.get_parameter_changes(&session_id).unwrap();
        assert_eq!(changes.len(), 2);
        assert_eq!(changes[0].before_value, None);
        assert_eq!(changes[0].after_value, Some(0.2));
        assert_eq!(changes[0].after_value_percent, Some(20.0));
        assert!(
            changes[0].parameter_id.is_some(),
            "change links to tree param"
        );
        assert_eq!(changes[1].before_value, Some(0.2));
        assert_eq!(changes[1].after_value, Some(0.5));
        assert_eq!(changes[1].before_value_percent, Some(20.0));
        assert_eq!(changes[1].after_value_percent, Some(50.0));

        cleanup(&path);
    }

    #[test]
    fn rematerialize_preserves_creative_moments() {
        let (storage, path) = temp_storage();
        let session_id = storage
            .resume_or_create_active_session()
            .unwrap()
            .session_id
            .unwrap();

        let snapshot = serde_json::json!({
            "tracks": [{ "index": 0, "id": "1", "name": "Drums", "is_foldable": true, "devices": [] }]
        });
        storage
            .save_events_batch(&[snapshot_event(&session_id, snapshot)])
            .unwrap();
        storage.materialize_session_schema(&session_id).unwrap();

        storage
            .create_creative_moment(
                "moment-1",
                &session_id,
                "Found the bass tone",
                "sound_design",
                Some(1_000),
                Some(2_000),
                Some("the saturation made it"),
                &["bass".to_string()],
                "keeper",
                &[CreativeMomentTarget {
                    target_type: "track".into(),
                    target_id: format!("{session_id}::t::1"),
                }],
            )
            .unwrap();

        // Re-materialization wipes the derived tables but must leave the moment alone.
        storage.materialize_session_schema(&session_id).unwrap();

        let moments = storage.list_creative_moments(&session_id).unwrap();
        assert_eq!(moments.len(), 1);
        assert_eq!(moments[0].confidence, "keeper");
        assert_eq!(moments[0].tags, vec!["bass".to_string()]);
        assert_eq!(moments[0].targets.len(), 1);

        cleanup(&path);
    }

    #[test]
    fn materialize_falls_back_to_event_stream_without_snapshot() {
        let (storage, path) = temp_storage();
        let session_id = storage
            .resume_or_create_active_session()
            .unwrap()
            .session_id
            .unwrap();

        // A focus snapshot for a MIDI track (instrument present) — and NO deep snapshot.
        let mut focus = event(&session_id, "selected_track_focus_snapshot");
        focus.payload = Some(
            serde_json::json!({
                "available": true, "id": 5, "index": 0, "name": "Bass 1",
                "devices": [
                    { "id": 50, "name": "Synth", "role": "instrument", "is_active": true },
                    { "id": 51, "name": "Sat", "role": "audio_effect", "is_active": true }
                ],
                "clips": []
            })
            .to_string(),
        );

        // A track created but never selected — should still appear as a stub, typed
        // from the event's track_type (bridge >= 0.12.0).
        let mut created = event(&session_id, "track_created");
        created.track_name = Some("Drums".into());
        created.track_type = Some("midi".into());

        storage.save_events_batch(&[focus, created]).unwrap();
        storage.materialize_session_schema(&session_id).unwrap();

        let schema = storage.get_project_schema(&session_id).unwrap();
        let names: Vec<String> = schema
            .tracks
            .iter()
            .filter_map(|t| t.name.clone())
            .collect();
        assert!(names.contains(&"Bass 1".to_string()), "focus track present");
        assert!(
            names.contains(&"Drums".to_string()),
            "created-only track present"
        );

        let drums = schema
            .tracks
            .iter()
            .find(|t| t.name.as_deref() == Some("Drums"))
            .unwrap();
        assert_eq!(
            drums.track_type,
            TrackType::Midi,
            "stub typed from event track_type"
        );

        let bass = schema
            .tracks
            .iter()
            .find(|t| t.name.as_deref() == Some("Bass 1"))
            .unwrap();
        assert_eq!(bass.track_type, TrackType::Midi);
        assert_eq!(bass.devices.len(), 2);
        assert_eq!(bass.devices[0].role, DeviceRole::Instrument);

        cleanup(&path);
    }

    #[test]
    fn event_tree_collapses_renamed_track_without_id_collision() {
        let (storage, path) = temp_storage();
        let session_id = storage
            .resume_or_create_active_session()
            .unwrap()
            .session_id
            .unwrap();

        // The same Live track (id 7) selected twice, renamed "MIDI" -> "Bass". Both
        // focus snapshots share an id, which previously collided on tracks.id.
        let mut first = event(&session_id, "selected_track_focus_snapshot");
        first.timestamp_ms = 1_000;
        first.payload = Some(
            serde_json::json!({ "available": true, "id": 7, "index": 0, "name": "MIDI", "devices": [], "clips": [] })
                .to_string(),
        );
        let mut second = event(&session_id, "selected_track_focus_snapshot");
        second.timestamp_ms = 2_000;
        second.payload = Some(
            serde_json::json!({ "available": true, "id": 7, "index": 0, "name": "Bass", "devices": [], "clips": [] })
                .to_string(),
        );

        storage.save_events_batch(&[first, second]).unwrap();
        // Must not error with a UNIQUE constraint failure.
        storage.materialize_session_schema(&session_id).unwrap();

        let schema = storage.get_project_schema(&session_id).unwrap();
        let matching: Vec<&str> = schema
            .tracks
            .iter()
            .filter_map(|t| t.name.as_deref())
            .filter(|n| *n == "MIDI" || *n == "Bass")
            .collect();
        assert_eq!(
            matching,
            vec!["Bass"],
            "renamed track collapses to its latest name"
        );

        cleanup(&path);
    }
}
