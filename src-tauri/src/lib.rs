mod udp_listener;

use std::sync::{Arc, Mutex};
use tauri::State;
use udp_listener::{get_status, start_udp_listener, ConnectionState, ConnectionStatus};

struct AppState {
    connection: Arc<Mutex<ConnectionState>>,
}

#[tauri::command]
fn get_connection_status(state: State<AppState>) -> ConnectionStatus {
    get_status(state.connection.clone())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let connection_state = Arc::new(Mutex::new(ConnectionState {
        last_heartbeat_ms: None,
        last_message: None,
    }));

    start_udp_listener(connection_state.clone());

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(AppState {
            connection: connection_state,
        })
        .invoke_handler(tauri::generate_handler![get_connection_status])
        .run(tauri::generate_context!())
        .expect("error while running Recall Studio");
}