mod protocol;
mod session;
mod storage;
mod udp_listener;

use protocol::RecallEvent;
use session::{SessionState, SessionStatus};
use std::sync::{Arc, Mutex};
use storage::{initialize_database, StorageState, StorageStatus};
use tauri::{Manager, State};
use udp_listener::{get_status, start_udp_listener, ConnectionState, ConnectionStatus};

struct AppState {
    connection: Arc<Mutex<ConnectionState>>,
    recent_events: Arc<Mutex<Vec<RecallEvent>>>,
    session: Arc<Mutex<SessionState>>,
    storage: Arc<Mutex<StorageState>>,
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
fn get_storage_status(state: State<'_, AppState>) -> StorageStatus {
    let storage = state.storage.lock().expect("Storage state lock failed");
    let status = storage.status();

    println!(
        "COMMAND get_storage_status called -> initialized: {}, db_path: {:?}",
        status.initialized, status.db_path
    );

    status
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let connection_state = Arc::new(Mutex::new(ConnectionState {
        last_heartbeat_ms: None,
        last_message: None,
    }));

    let recent_events = Arc::new(Mutex::new(Vec::<RecallEvent>::new()));

    let session_state = Arc::new(Mutex::new(SessionState::new()));

    let storage_state = Arc::new(Mutex::new(StorageState::new()));

    let connection_state_for_setup = connection_state.clone();
    let recent_events_for_setup = recent_events.clone();
    let session_state_for_setup = session_state.clone();
    let storage_state_for_setup = storage_state.clone();

    println!("Starting Recall Studio backend...");

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
            println!("Starting UDP listener...");

            start_udp_listener(
                connection_state_for_setup.clone(),
                recent_events_for_setup.clone(),
                session_state_for_setup.clone(),
                storage_state_for_setup.clone(),
            );

            Ok(())
        })
        .manage(AppState {
            connection: connection_state,
            recent_events,
            session: session_state,
            storage: storage_state,
        })
        .invoke_handler(tauri::generate_handler![
            get_connection_status,
            get_recent_events,
            start_session,
            stop_session,
            get_session_status,
            get_storage_status
        ])
        .run(tauri::generate_context!())
        .expect("error while running Recall Studio");
}
