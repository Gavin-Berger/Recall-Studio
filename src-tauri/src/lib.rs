mod event_catalog;
mod install;
mod metrics;
mod protocol;
mod schema_projection;
mod session;
mod storage;
mod udp_listener;

use metrics::{BridgeMetrics, BridgeMetricsSnapshot};
use protocol::RecallEvent;
use schema_projection::{CreativeMoment, CreativeMomentTarget, ParameterChange, ProjectSchema};
use session::{SavedProject, SavedSession, SavedSessionMetadata, SessionState, SessionStatus};
use std::sync::{Arc, Mutex};
use storage::{initialize_database, SessionCuration, StorageState, StorageStatus};
use tauri::{Manager, State};
use udp_listener::{get_status, start_udp_listener, ConnectionState, ConnectionStatus};

struct AppState {
    connection: Arc<Mutex<ConnectionState>>,
    recent_events: Arc<Mutex<Vec<RecallEvent>>>,
    session: Arc<Mutex<SessionState>>,
    storage: Arc<Mutex<StorageState>>,
    metrics: Arc<BridgeMetrics>,
}

/// Write a UTF-8 text document to disk. Used by the timeline's share/export so a
/// session recap can be saved as a Markdown file the producer can send anywhere.
/// The path comes from the native save dialog, so it's a location the user chose.
#[tauri::command]
fn write_text_file(path: String, contents: String) -> Result<(), String> {
    std::fs::write(&path, contents).map_err(|error| format!("Failed to write file: {}", error))
}

#[tauri::command]
fn get_connection_status(state: State<'_, AppState>) -> ConnectionStatus {
    let status = get_status(state.connection.clone());

    println!(
        "COMMAND get_connection_status called -> connected: {}, last_heartbeat_ms: {:?}, last_message: {:?}",
        status.connected,
        status.last_heartbeat_ms,
        status.last_message
    );

    status
}

#[tauri::command]
fn get_recent_events(state: State<'_, AppState>) -> Vec<RecallEvent> {
    let recent_events = state
        .recent_events
        .lock()
        .expect("Recent events lock failed")
        .clone();

    println!(
        "COMMAND get_recent_events called -> {} events",
        recent_events.len()
    );

    recent_events
}

#[tauri::command]
fn start_session(state: State<'_, AppState>) -> SessionStatus {
    let (status, should_persist) = {
        let mut session = state.session.lock().expect("Session state lock failed");
        let was_active = session.status().active;
        let status = session.start();

        (status, !was_active)
    };

    if should_persist && status.active {
        let mut recent_events = state
            .recent_events
            .lock()
            .expect("Recent events lock failed");

        recent_events.clear();

        println!("EVENT QUEUE CLEARED -> new session started");

        let storage = state.storage.lock().expect("Storage state lock failed");

        match storage.save_session_started(&status) {
            Ok(_) => println!("SESSION PERSISTED -> session_id: {:?}", status.session_id),
            Err(error) => eprintln!("FAILED TO PERSIST SESSION START -> {}", error),
        }
    }

    println!(
        "COMMAND start_session called -> active: {}, session_id: {:?}",
        status.active, status.session_id
    );

    status
}

#[tauri::command]
fn stop_session(state: State<'_, AppState>) -> SessionStatus {
    let (status, should_persist) = {
        let mut session = state.session.lock().expect("Session state lock failed");
        let was_active = session.status().active;
        let status = session.stop();

        (status, was_active)
    };

    if should_persist {
        let storage = state.storage.lock().expect("Storage state lock failed");

        match storage.save_session_stopped(&status) {
            Ok(_) => println!(
                "SESSION STOP PERSISTED -> session_id: {:?}",
                status.session_id
            ),
            Err(error) => eprintln!("FAILED TO PERSIST SESSION STOP -> {}", error),
        }
    }

    println!(
        "COMMAND stop_session called -> active: {}, session_id: {:?}",
        status.active, status.session_id
    );

    status
}

#[tauri::command]
fn get_session_status(state: State<'_, AppState>) -> SessionStatus {
    let session = state.session.lock().expect("Session state lock failed");
    let status = session.status();

    println!(
        "COMMAND get_session_status called -> active: {}, session_id: {:?}",
        status.active, status.session_id
    );

    status
}

#[tauri::command]
fn get_bridge_metrics(state: State<'_, AppState>) -> BridgeMetricsSnapshot {
    state.metrics.snapshot()
}

#[tauri::command]
fn get_storage_status(state: State<'_, AppState>) -> StorageStatus {
    let storage = state.storage.lock().expect("Storage state lock failed");
    let status = storage.status();

    println!(
        "COMMAND get_storage_status called -> initialized: {}, db_path: {:?}",
        status.initialized, status.db_path
    );

    status
}

#[tauri::command]
fn list_saved_sessions(state: State<'_, AppState>) -> Result<Vec<SavedSessionMetadata>, String> {
    let storage = state.storage.lock().expect("Storage state lock failed");
    let sessions = storage.list_saved_sessions()?;

    println!(
        "COMMAND list_saved_sessions called -> {} sessions",
        sessions.len()
    );

    Ok(sessions)
}

#[tauri::command]
fn load_session_events(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<SavedSession, String> {
    let storage = state.storage.lock().expect("Storage state lock failed");
    let session = storage.load_session(&session_id)?;

    println!(
        "COMMAND load_session_events called -> session_id: {}, {} events",
        session_id,
        session.events.len()
    );

    Ok(session)
}

#[tauri::command]
fn start_new_session(state: State<'_, AppState>) -> Result<SessionStatus, String> {
    let previous_status = {
        let mut session = state.session.lock().expect("Session state lock failed");
        session.stop()
    };

    {
        let storage = state.storage.lock().expect("Storage state lock failed");

        if previous_status.session_id.is_some() {
            storage.save_session_stopped(&previous_status)?;
        }
    }

    let status = {
        let mut session = state.session.lock().expect("Session state lock failed");
        session.start()
    };

    {
        let mut recent_events = state
            .recent_events
            .lock()
            .expect("Recent events lock failed");

        recent_events.clear();
    }

    {
        let storage = state.storage.lock().expect("Storage state lock failed");
        storage.save_session_started(&status)?;
    }

    println!(
        "COMMAND start_new_session called -> active: {}, session_id: {:?}",
        status.active, status.session_id
    );

    Ok(status)
}

#[tauri::command]
fn delete_saved_session(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<SessionStatus, String> {
    let current_status = {
        let session = state.session.lock().expect("Session state lock failed");
        session.status()
    };

    let deleted_active_session = current_status.session_id.as_deref() == Some(session_id.as_str());

    {
        let storage = state.storage.lock().expect("Storage state lock failed");
        storage.delete_session(&session_id)?;
    }

    if !deleted_active_session {
        println!(
            "COMMAND delete_saved_session called -> deleted archived session_id: {}",
            session_id
        );

        return Ok(current_status);
    }

    let next_status = {
        let mut session = state.session.lock().expect("Session state lock failed");
        session.stop();
        session.start()
    };

    {
        let mut recent_events = state
            .recent_events
            .lock()
            .expect("Recent events lock failed");

        recent_events.clear();
    }

    {
        let storage = state.storage.lock().expect("Storage state lock failed");
        storage.save_session_started(&next_status)?;
    }

    println!(
        "COMMAND delete_saved_session called -> deleted active session_id: {}, new session_id: {:?}",
        session_id, next_status.session_id
    );

    Ok(next_status)
}

#[tauri::command]
fn list_projects(
    state: State<'_, AppState>,
    include_archived: Option<bool>,
) -> Result<Vec<SavedProject>, String> {
    let storage = state.storage.lock().expect("Storage state lock failed");
    storage.list_projects(include_archived.unwrap_or(false))
}

#[tauri::command]
fn create_project(state: State<'_, AppState>, display_name: String) -> Result<String, String> {
    let storage = state.storage.lock().expect("Storage state lock failed");
    storage.create_project(&display_name, None, None)
}

#[tauri::command]
fn rename_project(
    state: State<'_, AppState>,
    project_id: String,
    display_name: String,
) -> Result<(), String> {
    let storage = state.storage.lock().expect("Storage state lock failed");
    storage.rename_project(&project_id, &display_name)
}

#[tauri::command]
fn archive_project(state: State<'_, AppState>, project_id: String) -> Result<(), String> {
    let storage = state.storage.lock().expect("Storage state lock failed");
    storage.archive_project(&project_id)
}

/// Derive a project display name from a chosen folder or .als path.
/// "Beautiful creation fminor Project" -> "Beautiful creation fminor"; "song.als" -> "song".
fn display_name_from_path(path: &str) -> String {
    let raw = std::path::Path::new(path)
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .trim();
    let name = raw.strip_suffix(" Project").unwrap_or(raw).trim();
    if name.is_empty() {
        "Connected Project".to_string()
    } else {
        name.to_string()
    }
}

fn folder_contains_als(dir: &std::path::Path) -> bool {
    std::fs::read_dir(dir)
        .map(|entries| {
            entries.flatten().any(|entry| {
                entry
                    .path()
                    .extension()
                    .and_then(|ext| ext.to_str())
                    .map(|ext| ext.eq_ignore_ascii_case("als"))
                    .unwrap_or(false)
            })
        })
        .unwrap_or(false)
}

/// An `.als` file found inside a project folder: its display name (file stem), its
/// full path, and its last-modified time in ms (0 if unreadable). The modified time
/// orders scanned takes so versions line up chronologically.
struct AlsFile {
    name: String,
    path: String,
    modified_ms: u64,
}

/// List the `.als` files directly inside a folder, sorted by name. Top-level only —
/// Ableton's `Backup/` auto-saves are skipped so a scan surfaces the versions the
/// producer named, not the editor's churn.
fn list_als_files(dir: &std::path::Path) -> Vec<AlsFile> {
    let mut files = Vec::new();
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            let is_als = path
                .extension()
                .and_then(|ext| ext.to_str())
                .map(|ext| ext.eq_ignore_ascii_case("als"))
                .unwrap_or(false);
            if !path.is_file() || !is_als {
                continue;
            }
            let name = path
                .file_stem()
                .and_then(|value| value.to_str())
                .unwrap_or("")
                .trim()
                .to_string();
            let modified_ms = std::fs::metadata(&path)
                .and_then(|meta| meta.modified())
                .ok()
                .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|delta| delta.as_millis() as u64)
                .unwrap_or(0);
            files.push(AlsFile {
                name,
                path: path.to_string_lossy().to_string(),
                modified_ms,
            });
        }
    }
    files.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    files
}

/// Discover Ableton projects to import. If the chosen folder is itself a project
/// (holds a `.als`), that's the single result; otherwise each immediate subfolder
/// holding a `.als` becomes a project. Returns (display name, folder path).
fn discover_ableton_projects(root: &str) -> Result<Vec<(String, String)>, String> {
    let root_path = std::path::Path::new(root);
    if !root_path.is_dir() {
        return Err("That path is not a folder.".to_string());
    }

    // Prefer immediate subfolders that are Ableton projects — the common case is a
    // parent folder that holds many "<Song> Project" folders.
    let mut found = Vec::new();
    let entries =
        std::fs::read_dir(root_path).map_err(|error| format!("Failed to read folder: {}", error))?;
    for entry in entries {
        let entry = entry.map_err(|error| format!("Failed to read folder entry: {}", error))?;
        let path = entry.path();
        if path.is_dir() && folder_contains_als(&path) {
            let path_str = path.to_string_lossy().to_string();
            let name = display_name_from_path(&path_str);
            found.push((name, path_str));
        }
    }

    // Only if no child projects were found, treat the chosen folder itself as one
    // (the user picked a single "<Song> Project" folder directly).
    if found.is_empty() && folder_contains_als(root_path) {
        found.push((display_name_from_path(root), root.to_string()));
    }

    found.sort_by(|a, b| a.0.to_lowercase().cmp(&b.0.to_lowercase()));
    Ok(found)
}

/// Connect existing Ableton work. With `project_id`, links one project to the
/// chosen folder. Without it, scans the folder and imports every Ableton project
/// inside it (skipping ones already in the library); returns how many were added.
#[tauri::command]
fn connect_project_folder(
    state: State<'_, AppState>,
    path: String,
    project_id: Option<String>,
) -> Result<usize, String> {
    let clean_path = path.trim();
    if clean_path.is_empty() {
        return Err("No folder selected.".to_string());
    }

    if let Some(id) = project_id {
        let name = display_name_from_path(clean_path);
        let storage = state.storage.lock().expect("Storage state lock failed");
        storage.set_project_source(&id, &name, clean_path)?;
        // Surface the folder's `.als` versions as takes right away.
        rescan_project(&storage, &id)?;
        return Ok(1);
    }

    let discovered = discover_ableton_projects(clean_path)?;
    if discovered.is_empty() {
        return Err("No Ableton projects (.als) found in that folder.".to_string());
    }
    let storage = state.storage.lock().expect("Storage state lock failed");
    let added = storage.import_projects(&discovered)?;

    // Scan every project that maps to a discovered folder so its versions appear as
    // takes immediately — covers both freshly-imported and already-known projects.
    let discovered_folders: std::collections::HashSet<&str> =
        discovered.iter().map(|(_, folder)| folder.as_str()).collect();
    for project in storage.list_projects(false)? {
        if project
            .ableton_path
            .as_deref()
            .map(|folder| discovered_folders.contains(folder))
            .unwrap_or(false)
        {
            rescan_project(&storage, &project.id)?;
        }
    }

    Ok(added)
}

/// Scan a project's connected folder and add a take for any `.als` version it
/// doesn't already have. No-op if the project has no folder. Returns takes added.
fn rescan_project(storage: &StorageState, project_id: &str) -> Result<usize, String> {
    let Some(folder) = storage.project_ableton_path(project_id)? else {
        return Ok(0);
    };
    let files: Vec<(String, String, u64)> = list_als_files(std::path::Path::new(&folder))
        .into_iter()
        .map(|file| (file.name, file.path, file.modified_ms))
        .collect();
    storage.rescan_project_takes(project_id, &files)
}

/// Re-scan a project's folder for new `.als` versions. The "Rescan" button.
#[tauri::command]
fn rescan_project_folder(state: State<'_, AppState>, project_id: String) -> Result<usize, String> {
    let storage = state.storage.lock().expect("Storage state lock failed");
    rescan_project(&storage, &project_id)
}

#[tauri::command]
fn assign_session_to_project(
    state: State<'_, AppState>,
    session_id: String,
    project_id: Option<String>,
) -> Result<(), String> {
    let storage = state.storage.lock().expect("Storage state lock failed");
    storage.assign_session_to_project(&session_id, project_id.as_deref())
}

#[tauri::command]
fn rename_capture(
    state: State<'_, AppState>,
    session_id: String,
    capture_name: String,
) -> Result<(), String> {
    let storage = state.storage.lock().expect("Storage state lock failed");
    storage.rename_capture(&session_id, &capture_name)
}

fn ensure_project_exists(
    state: &State<'_, AppState>,
    project_id: Option<&str>,
) -> Result<(), String> {
    if let Some(project_id) = project_id {
        let storage = state.storage.lock().expect("Storage state lock failed");
        let exists = storage
            .list_projects(false)?
            .iter()
            .any(|project| project.id == project_id);
        if !exists {
            return Err(format!("Project not found or archived: {}", project_id));
        }
    }
    Ok(())
}

/// Stop the current take (if any) and start a fresh one, optionally assigned to a
/// project. Shared by start_capture_for_project (create path) and new_take_for_project.
fn create_capture_for_project(
    state: &State<'_, AppState>,
    project_id: Option<&str>,
) -> Result<SessionStatus, String> {
    let previous_status = {
        let mut session = state.session.lock().expect("Session state lock failed");
        session.stop()
    };

    {
        let storage = state.storage.lock().expect("Storage state lock failed");
        if previous_status.session_id.is_some() {
            storage.save_session_stopped(&previous_status)?;
        }
    }

    let status = {
        let mut session = state.session.lock().expect("Session state lock failed");
        session.start()
    };

    {
        let mut recent_events = state
            .recent_events
            .lock()
            .expect("Recent events lock failed");
        recent_events.clear();
    }

    {
        let storage = state.storage.lock().expect("Storage state lock failed");
        storage.save_session_started(&status)?;
        if let (Some(session_id), Some(project_id)) = (status.session_id.as_deref(), project_id) {
            storage.assign_session_to_project(session_id, Some(project_id))?;
        }
    }

    Ok(status)
}

/// Open a project's recording: if it already has an active take, return that one
/// (no duplicate); otherwise start a fresh take. This is what the project's main
/// Record / Open Recording button calls.
#[tauri::command]
fn start_capture_for_project(
    state: State<'_, AppState>,
    project_id: Option<String>,
) -> Result<SessionStatus, String> {
    ensure_project_exists(&state, project_id.as_deref())?;

    // Reuse an existing active take instead of creating another one.
    {
        let storage = state.storage.lock().expect("Storage state lock failed");
        if let Some(active) = storage.active_session_for_project(project_id.as_deref())? {
            println!(
                "COMMAND start_capture_for_project -> reused active take {:?} (project {:?})",
                active.session_id, project_id
            );
            return Ok(active);
        }
    }

    let status = create_capture_for_project(&state, project_id.as_deref())?;
    println!(
        "COMMAND start_capture_for_project -> new take {:?} (project {:?})",
        status.session_id, project_id
    );
    Ok(status)
}

/// Intentionally start a fresh take, even if the project already has an active one.
#[tauri::command]
fn new_take_for_project(
    state: State<'_, AppState>,
    project_id: Option<String>,
) -> Result<SessionStatus, String> {
    ensure_project_exists(&state, project_id.as_deref())?;
    let status = create_capture_for_project(&state, project_id.as_deref())?;
    println!(
        "COMMAND new_take_for_project -> new take {:?} (project {:?})",
        status.session_id, project_id
    );
    Ok(status)
}

#[tauri::command]
fn update_session_project_name(
    state: State<'_, AppState>,
    session_id: String,
    name: String,
) -> Result<(), String> {
    let storage = state.storage.lock().expect("Storage state lock failed");
    storage.update_session_display_name(&session_id, &name)
}

#[tauri::command]
fn set_event_curation(
    state: State<'_, AppState>,
    session_id: String,
    event_id: String,
    hidden: bool,
    title_override: Option<String>,
    description_override: Option<String>,
) -> Result<(), String> {
    let storage = state.storage.lock().expect("Storage state lock failed");
    storage.set_event_curation(
        &session_id,
        &event_id,
        hidden,
        title_override.as_deref(),
        description_override.as_deref(),
    )
}

#[tauri::command]
fn list_session_curation(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<SessionCuration, String> {
    let storage = state.storage.lock().expect("Storage state lock failed");
    storage.list_session_curation(&session_id)
}

#[tauri::command]
fn add_session_note(
    state: State<'_, AppState>,
    session_id: String,
    note_id: String,
    linked_event_id: Option<String>,
    text: String,
    session_timecode: String,
    created_at_ms: u64,
) -> Result<(), String> {
    let storage = state.storage.lock().expect("Storage state lock failed");
    storage.add_session_note(
        &session_id,
        &note_id,
        linked_event_id.as_deref(),
        &text,
        &session_timecode,
        created_at_ms,
    )
}

#[tauri::command]
fn update_session_note(
    state: State<'_, AppState>,
    note_id: String,
    text: String,
) -> Result<(), String> {
    let storage = state.storage.lock().expect("Storage state lock failed");
    storage.update_session_note(&note_id, &text)
}

#[tauri::command]
fn delete_session_note(state: State<'_, AppState>, note_id: String) -> Result<(), String> {
    let storage = state.storage.lock().expect("Storage state lock failed");
    storage.delete_session_note(&note_id)
}

// ── Normalized schema + creative memory ──────────────────────────────────────

#[tauri::command]
fn materialize_session_schema(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<(), String> {
    let storage = state.storage.lock().expect("Storage state lock failed");
    storage.materialize_session_schema(&session_id)
}

#[tauri::command]
fn get_project_schema(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<ProjectSchema, String> {
    let storage = state.storage.lock().expect("Storage state lock failed");
    storage.get_project_schema(&session_id)
}

#[tauri::command]
fn get_parameter_changes(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<Vec<ParameterChange>, String> {
    let storage = state.storage.lock().expect("Storage state lock failed");
    storage.get_parameter_changes(&session_id)
}

#[tauri::command]
fn list_creative_moments(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<Vec<CreativeMoment>, String> {
    let storage = state.storage.lock().expect("Storage state lock failed");
    storage.list_creative_moments(&session_id)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn create_creative_moment(
    state: State<'_, AppState>,
    id: String,
    session_id: String,
    title: String,
    moment_type: String,
    timeline_start_ms: Option<u64>,
    timeline_end_ms: Option<u64>,
    note: Option<String>,
    tags: Vec<String>,
    confidence: String,
    targets: Vec<CreativeMomentTarget>,
) -> Result<(), String> {
    let storage = state.storage.lock().expect("Storage state lock failed");
    storage.create_creative_moment(
        &id,
        &session_id,
        &title,
        &moment_type,
        timeline_start_ms,
        timeline_end_ms,
        note.as_deref(),
        &tags,
        &confidence,
        &targets,
    )
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn update_creative_moment(
    state: State<'_, AppState>,
    id: String,
    title: String,
    moment_type: String,
    timeline_start_ms: Option<u64>,
    timeline_end_ms: Option<u64>,
    note: Option<String>,
    tags: Vec<String>,
    confidence: String,
) -> Result<(), String> {
    let storage = state.storage.lock().expect("Storage state lock failed");
    storage.update_creative_moment(
        &id,
        &title,
        &moment_type,
        timeline_start_ms,
        timeline_end_ms,
        note.as_deref(),
        &tags,
        &confidence,
    )
}

#[tauri::command]
fn set_creative_moment_targets(
    state: State<'_, AppState>,
    moment_id: String,
    targets: Vec<CreativeMomentTarget>,
) -> Result<(), String> {
    let storage = state.storage.lock().expect("Storage state lock failed");
    storage.set_creative_moment_targets(&moment_id, &targets)
}

#[tauri::command]
fn delete_creative_moment(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let storage = state.storage.lock().expect("Storage state lock failed");
    storage.delete_creative_moment(&id)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let connection_state = Arc::new(Mutex::new(ConnectionState {
        last_heartbeat_ms: None,
        last_message: None,
        bridge_version: None,
    }));

    let recent_events = Arc::new(Mutex::new(Vec::<RecallEvent>::new()));

    let session_state = Arc::new(Mutex::new(SessionState::new()));

    let storage_state = Arc::new(Mutex::new(StorageState::new()));

    let bridge_metrics = BridgeMetrics::new();

    let connection_state_for_setup = connection_state.clone();
    let recent_events_for_setup = recent_events.clone();
    let session_state_for_setup = session_state.clone();
    let storage_state_for_setup = storage_state.clone();
    let bridge_metrics_for_setup = bridge_metrics.clone();

    println!(
        "Starting Recall Studio backend... (PID {})",
        std::process::id()
    );

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(move |app| {
            let app_data_dir = app
                .path()
                .app_data_dir()
                .expect("Failed to resolve app data directory");

            std::fs::create_dir_all(&app_data_dir).expect("Failed to create app data directory");

            let db_path = app_data_dir.join("recall-studio.sqlite");

            initialize_database(&db_path).expect("Failed to initialize Recall Studio database");

            {
                let mut storage = storage_state_for_setup
                    .lock()
                    .expect("Storage state lock failed");

                storage.configure(db_path.clone());
            }

            println!("SQLite database initialized at {:?}", db_path);

            let active_status = {
                let storage = storage_state_for_setup
                    .lock()
                    .expect("Storage state lock failed");

                storage
                    .resume_or_create_active_session()
                    .expect("Failed to resume or create active Recall Studio session")
            };

            if let (Some(session_id), Some(started_at_ms)) = (
                active_status.session_id.clone(),
                active_status.started_at_ms,
            ) {
                let mut session = session_state_for_setup
                    .lock()
                    .expect("Session state lock failed");

                session.restore_active(session_id, started_at_ms);
            }

            println!(
                "Active session ready -> session_id: {:?}",
                active_status.session_id
            );
            println!("Starting UDP listener...");

            start_udp_listener(
                connection_state_for_setup.clone(),
                recent_events_for_setup.clone(),
                session_state_for_setup.clone(),
                storage_state_for_setup.clone(),
                app.handle().clone(),
                bridge_metrics_for_setup.clone(),
            );

            Ok(())
        })
        .manage(AppState {
            connection: connection_state,
            recent_events,
            session: session_state,
            storage: storage_state,
            metrics: bridge_metrics,
        })
        .invoke_handler(tauri::generate_handler![
            write_text_file,
            get_connection_status,
            get_recent_events,
            start_session,
            stop_session,
            get_session_status,
            get_bridge_metrics,
            get_storage_status,
            list_saved_sessions,
            load_session_events,
            start_new_session,
            delete_saved_session,
            list_projects,
            create_project,
            connect_project_folder,
            rescan_project_folder,
            rename_project,
            archive_project,
            assign_session_to_project,
            rename_capture,
            start_capture_for_project,
            new_take_for_project,
            update_session_project_name,
            set_event_curation,
            list_session_curation,
            add_session_note,
            update_session_note,
            delete_session_note,
            materialize_session_schema,
            get_project_schema,
            get_parameter_changes,
            list_creative_moments,
            create_creative_moment,
            update_creative_moment,
            set_creative_moment_targets,
            delete_creative_moment,
            install::detect_bridge_install_targets,
            install::install_bridge
        ])
        .run(tauri::generate_context!())
        .expect("error while running Recall Studio");
}
