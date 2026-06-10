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
use session::{SavedSession, SavedSessionMetadata, SessionState, SessionStatus};
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

    println!("Starting Recall Studio backend... (PID {})", std::process::id());

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
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
