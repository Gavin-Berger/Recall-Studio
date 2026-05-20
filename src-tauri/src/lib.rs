mod protocol;
mod udp_listener;

use protocol::RecallEvent;
use std::sync::{Arc, Mutex};
use tauri::State;
use udp_listener::{get_status, start_udp_listener, ConnectionState, ConnectionStatus};

struct AppState {
    connection: Arc<Mutex<ConnectionState>>,
    recent_events: Arc<Mutex<Vec<RecallEvent>>>,
}

#[tauri::command]
fn get_connection_status(state: State<AppState>) -> ConnectionStatus {
    get_status(state.connection.clone())
}

#[tauri::command]
fn get_recent_events(state: State<AppState>) -> Vec<RecallEvent> {
    state
        .recent_events
        .lock()
        .expect("Recent events lock failed")
        .clone()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let connection_state = Arc::new(Mutex::new(ConnectionState {
        last_heartbeat_ms: None,
        last_message: None,
    }));

    let recent_events = Arc::new(Mutex::new(Vec::<RecallEvent>::new()));

    start_udp_listener(connection_state.clone(), recent_events.clone());

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(AppState {
            connection: connection_state,
            recent_events,
        })
        .invoke_handler(tauri::generate_handler![
            get_connection_status,
            get_recent_events
        ])
        .run(tauri::generate_context!())
        .expect("error while running Recall Studio");
}