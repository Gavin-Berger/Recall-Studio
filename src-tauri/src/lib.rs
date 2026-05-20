mod protocol;
mod session;
mod udp_listener;

use protocol::RecallEvent;
use session::{SessionState, SessionStatus};
use std::sync::{Arc, Mutex};
use tauri::State;
use udp_listener::{get_status, start_udp_listener, ConnectionState, ConnectionStatus};

struct AppState {
    connection: Arc<Mutex<ConnectionState>>,
    recent_events: Arc<Mutex<Vec<RecallEvent>>>,
    session: Arc<Mutex<SessionState>>,
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
    let mut session = state.session.lock().expect("Session state lock failed");
    let status = session.start();

    if status.active {
        let mut recent_events = state
            .recent_events
            .lock()
            .expect("Recent events lock failed");

        recent_events.clear();

        println!("EVENT QUEUE CLEARED -> new session started");
    }

    println!(
        "COMMAND start_session called -> active: {}, session_id: {:?}",
        status.active, status.session_id
    );

    status
}

#[tauri::command]
fn stop_session(state: State<'_, AppState>) -> SessionStatus {
    let mut session = state.session.lock().expect("Session state lock failed");
    let status = session.stop();

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let connection_state = Arc::new(Mutex::new(ConnectionState {
        last_heartbeat_ms: None,
        last_message: None,
    }));

    let recent_events = Arc::new(Mutex::new(Vec::<RecallEvent>::new()));

    let session_state = Arc::new(Mutex::new(SessionState::new()));

    println!("Starting Recall Studio backend...");
    println!("Starting UDP listener...");

    start_udp_listener(
        connection_state.clone(),
        recent_events.clone(),
        session_state.clone(),
    );

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(AppState {
            connection: connection_state,
            recent_events,
            session: session_state,
        })
        .invoke_handler(tauri::generate_handler![
            get_connection_status,
            get_recent_events,
            start_session,
            stop_session,
            get_session_status
        ])
        .run(tauri::generate_context!())
        .expect("error while running Recall Studio");
}
