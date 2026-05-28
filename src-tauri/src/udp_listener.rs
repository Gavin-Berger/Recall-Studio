use crate::protocol::RecallEvent;
use crate::session::SessionState;
use crate::storage::StorageState;
use serde::Serialize;
use serde_json::{json, Map, Value};
use std::{
    net::UdpSocket,
    sync::{Arc, Mutex},
    thread,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter};

const VERBOSE_UDP_LOGGING: bool = false;

#[derive(Debug, Clone)]
pub struct ConnectionState {
    pub last_heartbeat_ms: Option<u64>,
    pub last_message: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct ConnectionStatus {
    pub connected: bool,
    pub last_heartbeat_ms: Option<u64>,
    pub last_message: Option<String>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("System time error")
        .as_millis() as u64
}

fn extract_json_object(bytes: &[u8]) -> Result<String, String> {
    let raw = String::from_utf8_lossy(bytes).to_string();

    let start = raw
        .find('{')
        .ok_or_else(|| format!("No JSON object start found in UDP message: {:?}", raw))?;

    let end = raw
        .rfind('}')
        .ok_or_else(|| format!("No JSON object end found in UDP message: {:?}", raw))?;

    if end < start {
        return Err(format!(
            "Invalid JSON object bounds in UDP message: {:?}",
            raw
        ));
    }

    Ok(raw[start..=end].to_string())
}

fn protocol_is_supported(protocol: &str) -> bool {
    matches!(protocol, "recall.v1" | "recall.v2" | "recall.protocol.v1")
}

fn title_for_event_type(event_type: &str) -> String {
    match event_type {
        "heartbeat" => "Heartbeat Received".to_string(),
        "bridge_started" => "Ableton Bridge Started".to_string(),
        "bridge_stopped" => "Ableton Bridge Stopped".to_string(),

        "tempo_changed" => "Tempo Changed".to_string(),
        "transport_play" => "Playback Started".to_string(),
        "transport_stop" => "Playback Stopped".to_string(),
        "playback_state_changed" => "Playback State Changed".to_string(),
        "beat_time_changed" => "Beat Time Changed".to_string(),
        "transport_changed" => "Transport Changed".to_string(),
        "recording_state_changed" => "Recording State Changed".to_string(),

        "track_name_changed" => "Track Name Changed".to_string(),
        "track_selected" => "Track Selected".to_string(),
        "track_created" => "Track Created".to_string(),
        "track_deleted" => "Track Deleted".to_string(),
        "track_event" => "Track Event".to_string(),

        "clip_event" => "Clip Event".to_string(),
        "clip_created" => "Clip Created".to_string(),
        "clip_launched" => "Clip Launched".to_string(),
        "clip_stopped" => "Clip Stopped".to_string(),
        "clip_deleted" => "Clip Deleted".to_string(),
        "clip_recording_started" => "Clip Recording Started".to_string(),
        "clip_recording_stopped" => "Clip Recording Stopped".to_string(),

        "scene_changed" => "Scene Changed".to_string(),
        "scene_launched" => "Scene Launched".to_string(),

        "device_added" => "Device Added".to_string(),
        "device_removed" => "Device Removed".to_string(),
        "device_event" => "Device Event".to_string(),
        "device_selected" => "Device Selected".to_string(),
        "device_parameter_changed" | "parameter_changed" => "Parameter Changed".to_string(),

        "group_focused" => "Group Focused".to_string(),
        "live_set_snapshot" => "Live Set Snapshot".to_string(),
        "project_file_changed" => "Project File Changed".to_string(),
        "session_snapshot" => "Session Snapshot".to_string(),
        "creative_decision" => "Creative Decision".to_string(),

        "raw_max_message" => "Raw Max Message".to_string(),

        _ => format!("Recall Event: {}", event_type),
    }
}

fn description_for_event_type(event_type: &str) -> String {
    match event_type {
        "heartbeat" => "Heartbeat received from the Max for Live bridge.".to_string(),
        "bridge_started" => "The Max for Live bridge started sending events.".to_string(),
        "bridge_stopped" => "The Max for Live bridge stopped sending events.".to_string(),

        "tempo_changed" => "Ableton tempo changed.".to_string(),
        "transport_play" => "Ableton playback started.".to_string(),
        "transport_stop" => "Ableton playback stopped.".to_string(),
        "playback_state_changed" => "Ableton playback state changed.".to_string(),
        "beat_time_changed" => "Ableton beat position changed.".to_string(),
        "transport_changed" => "Ableton transport state changed.".to_string(),
        "recording_state_changed" => "Ableton recording state changed.".to_string(),

        "track_name_changed" => "Ableton track name changed.".to_string(),
        "track_selected" => "Ableton selected track changed.".to_string(),
        "track_created" => "A track was created in Ableton.".to_string(),
        "track_deleted" => "A track was deleted in Ableton.".to_string(),
        "track_event" => "Ableton track event received.".to_string(),

        "clip_event" => "Ableton clip event received.".to_string(),
        "clip_created" => "A clip was created in Ableton.".to_string(),
        "clip_launched" => "An Ableton clip was launched.".to_string(),
        "clip_stopped" => "An Ableton clip was stopped.".to_string(),
        "clip_deleted" => "An Ableton clip was deleted.".to_string(),
        "clip_recording_started" => "Ableton clip recording started.".to_string(),
        "clip_recording_stopped" => "Ableton clip recording stopped.".to_string(),

        "scene_changed" => "Ableton scene selection changed.".to_string(),
        "scene_launched" => "An Ableton scene was launched.".to_string(),

        "device_added" => "A device was added to the chain.".to_string(),
        "device_removed" => "A device was removed from the chain.".to_string(),
        "device_event" => "Ableton device event received.".to_string(),
        "device_selected" => "Ableton selected device changed.".to_string(),
        "device_parameter_changed" | "parameter_changed" => {
            "A device parameter was adjusted.".to_string()
        }

        "group_focused" => "A group track was focused.".to_string(),
        "live_set_snapshot" => "Ableton live set snapshot received.".to_string(),
        "project_file_changed" => "Ableton project file activity was detected.".to_string(),
        "session_snapshot" => "Ableton session snapshot received.".to_string(),
        "creative_decision" => "Creative decision marker received.".to_string(),

        "raw_max_message" => "Raw Max message received for debugging.".to_string(),

        _ => format!("Recall event received: {}", event_type),
    }
}

fn payload_to_string(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(payload)) => payload.clone(),
        Some(payload_value) => payload_value.to_string(),
        None => "{}".to_string(),
    }
}

// ── Structured field extraction ───────────────────────────────────────────────
// These helpers look in the top-level object first, then inside the parsed
// payload JSON. They try the canonical v2 name first, then common v1 synonyms.
// This consolidates all field resolution in Rust so the frontend gets clean data.

fn find_string(
    top: &Map<String, Value>,
    payload: Option<&Map<String, Value>>,
    keys: &[&str],
) -> Option<String> {
    for &key in keys {
        if let Some(val) = top.get(key).and_then(|v| v.as_str()) {
            if !val.is_empty() {
                return Some(val.to_string());
            }
        }
    }
    if let Some(p) = payload {
        for &key in keys {
            if let Some(val) = p.get(key).and_then(|v| v.as_str()) {
                if !val.is_empty() {
                    return Some(val.to_string());
                }
            }
        }
    }
    None
}

fn find_f64(
    top: &Map<String, Value>,
    payload: Option<&Map<String, Value>>,
    keys: &[&str],
) -> Option<f64> {
    for &key in keys {
        if let Some(val) = top.get(key).and_then(|v| v.as_f64()) {
            return Some(val);
        }
    }
    if let Some(p) = payload {
        for &key in keys {
            if let Some(val) = p.get(key).and_then(|v| v.as_f64()) {
                return Some(val);
            }
        }
    }
    None
}

fn find_bool(
    top: &Map<String, Value>,
    payload: Option<&Map<String, Value>>,
    keys: &[&str],
) -> Option<bool> {
    for &key in keys {
        if let Some(val) = top.get(key) {
            if let Some(b) = val.as_bool() {
                return Some(b);
            }
            // Treat 1/0 as true/false.
            if let Some(n) = val.as_i64() {
                return Some(n == 1);
            }
        }
    }
    if let Some(p) = payload {
        for &key in keys {
            if let Some(val) = p.get(key) {
                if let Some(b) = val.as_bool() {
                    return Some(b);
                }
                if let Some(n) = val.as_i64() {
                    return Some(n == 1);
                }
            }
        }
    }
    None
}

fn normalize_udp_json(mut value: Value) -> Result<Value, String> {
    let object = value
        .as_object_mut()
        .ok_or_else(|| "UDP JSON was not an object".to_string())?;

    let protocol = object
        .get("protocol")
        .and_then(Value::as_str)
        .unwrap_or("recall.protocol.v1")
        .to_string();

    if !protocol_is_supported(&protocol) {
        return Err(format!("Unsupported protocol: {}", protocol));
    }

    let event_type = object
        .get("event_type")
        .and_then(Value::as_str)
        .unwrap_or("unknown")
        .to_string();

    object.insert("protocol".to_string(), Value::String(protocol));
    object
        .entry("source".to_string())
        .or_insert(Value::String("max_for_live".to_string()));
    object
        .entry("timestamp_ms".to_string())
        .or_insert(json!(now_ms()));
    object.insert("event_type".to_string(), Value::String(event_type.clone()));
    object
        .entry("title".to_string())
        .or_insert(Value::String(title_for_event_type(&event_type)));
    object
        .entry("description".to_string())
        .or_insert(Value::String(description_for_event_type(&event_type)));
    object
        .entry("session_id".to_string())
        .or_insert(Value::Null);

    let payload_string = payload_to_string(object.get("payload"));
    object.insert("payload".to_string(), Value::String(payload_string));

    // ── Extract structured fields ─────────────────────────────────────────────
    // Parse the payload JSON to look for fields that may be nested inside it.
    let payload_parsed: Option<Value> = object
        .get("payload")
        .and_then(|v| v.as_str())
        .and_then(|s| serde_json::from_str(s).ok());
    let payload_obj = payload_parsed.as_ref().and_then(|v| v.as_object());

    // Canonical v2 name first, then common v1 synonyms.
    let track_name = find_string(
        object,
        payload_obj,
        &[
            "track_name",
            "track",
            "selected_track",
            "selectedTrack",
            "selected_track_name",
        ],
    );
    let device_name = find_string(
        object,
        payload_obj,
        &["device_name", "device", "plugin_name", "plugin"],
    );
    let parameter_name = find_string(
        object,
        payload_obj,
        &["parameter_name", "parameter", "param_name", "param"],
    );
    let clip_name = find_string(object, payload_obj, &["clip_name", "clip"]);
    let bpm = find_f64(object, payload_obj, &["bpm", "tempo"]);
    let playing = find_bool(object, payload_obj, &["playing", "is_playing"]);
    let parameter_value = find_f64(
        object,
        payload_obj,
        &["parameter_value", "value", "param_value"],
    );

    // Write resolved fields back to the top-level object.
    // These override any null placeholders and become top-level struct fields
    // in RecallEvent, so the frontend accesses them with zero guessing.
    match track_name {
        Some(v) => object.insert("track_name".to_string(), Value::String(v)),
        None => object.insert("track_name".to_string(), Value::Null),
    };
    match device_name {
        Some(v) => object.insert("device_name".to_string(), Value::String(v)),
        None => object.insert("device_name".to_string(), Value::Null),
    };
    match parameter_name {
        Some(v) => object.insert("parameter_name".to_string(), Value::String(v)),
        None => object.insert("parameter_name".to_string(), Value::Null),
    };
    match clip_name {
        Some(v) => object.insert("clip_name".to_string(), Value::String(v)),
        None => object.insert("clip_name".to_string(), Value::Null),
    };
    match bpm {
        Some(v) => object.insert("bpm".to_string(), json!(v)),
        None => object.insert("bpm".to_string(), Value::Null),
    };
    match playing {
        Some(v) => object.insert("playing".to_string(), json!(v)),
        None => object.insert("playing".to_string(), Value::Null),
    };
    match parameter_value {
        Some(v) => object.insert("parameter_value".to_string(), json!(v)),
        None => object.insert("parameter_value".to_string(), Value::Null),
    };

    Ok(value)
}

fn update_connection_if_heartbeat(normalized_json: &Value, state: &Arc<Mutex<ConnectionState>>) {
    let event_type = normalized_json
        .get("event_type")
        .and_then(Value::as_str)
        .unwrap_or("");

    if event_type != "heartbeat" {
        return;
    }

    let title = normalized_json
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or("Heartbeat Received")
        .to_string();

    let mut connection = state.lock().expect("Connection state lock failed");
    connection.last_heartbeat_ms = Some(now_ms());
    connection.last_message = Some(title);

    if VERBOSE_UDP_LOGGING {
        println!(
            "HEARTBEAT UPDATED -> last_heartbeat_ms: {:?}",
            connection.last_heartbeat_ms
        );
    }
}

fn push_event(events: &Arc<Mutex<Vec<RecallEvent>>>, event: RecallEvent) {
    let mut recent_events = events.lock().expect("Recent events lock failed");

    recent_events.push(event);

    // No cap — the buffer holds all events for the current live session.
    // Cleared when a new session starts. Sessions are hours long at most,
    // so memory cost is negligible (each event is ~200 bytes on average).

    if VERBOSE_UDP_LOGGING {
        println!("EVENT QUEUE UPDATED -> {} events", recent_events.len());
    }
}

fn assign_session_if_active(event: &mut RecallEvent, session: &Arc<Mutex<SessionState>>) {
    let session_state = session.lock().expect("Session state lock failed");
    event.session_id = session_state.active_session_id();

    if let Some(session_id) = &event.session_id {
        if VERBOSE_UDP_LOGGING {
            println!(
                "EVENT ASSIGNED TO SESSION -> event_type: {}, session_id: {}",
                event.event_type, session_id
            );
        }
    }
}

fn persist_event_if_session_owned(event: &RecallEvent, storage: &Arc<Mutex<StorageState>>) {
    // Heartbeats are connection-health signals — never persisted.
    // They generate ~3600 useless rows per hour and contain no creative information.
    if event.event_type == "heartbeat" {
        return;
    }

    if event.session_id.is_none() {
        return;
    }

    let storage_state = storage.lock().expect("Storage state lock failed");

    match storage_state.save_event(event) {
        Ok(_) => {
            if VERBOSE_UDP_LOGGING {
                println!(
                    "EVENT PERSISTED -> event_type: {}, session_id: {:?}",
                    event.event_type, event.session_id
                );
            }
        }
        Err(error) => {
            eprintln!("FAILED TO PERSIST EVENT -> {}", error);
        }
    }
}

pub fn start_udp_listener(
    state: Arc<Mutex<ConnectionState>>,
    events: Arc<Mutex<Vec<RecallEvent>>>,
    session: Arc<Mutex<SessionState>>,
    storage: Arc<Mutex<StorageState>>,
    app_handle: AppHandle,
) {
    thread::spawn(move || {
        let socket = UdpSocket::bind("127.0.0.1:9000")
            .expect("Failed to bind UDP listener on 127.0.0.1:9000");

        println!("Recall Studio UDP listener running on 127.0.0.1:9000");

        let mut buffer = [0u8; 4096];

        loop {
            match socket.recv_from(&mut buffer) {
                Ok((size, addr)) => {
                    let bytes = &buffer[..size];

                    if VERBOSE_UDP_LOGGING {
                        println!("================ UDP PACKET RECEIVED ================");
                        println!("UDP from: {}", addr);
                        println!("UDP bytes length: {}", size);
                    }

                    let message = match extract_json_object(bytes) {
                        Ok(message) => message,
                        Err(error) => {
                            eprintln!("FAILED TO EXTRACT JSON FROM UDP MESSAGE -> {}", error);
                            continue;
                        }
                    };

                    let raw_json = match serde_json::from_str::<Value>(&message) {
                        Ok(value) => value,
                        Err(error) => {
                            eprintln!("FAILED TO PARSE UDP MESSAGE AS JSON -> {}", error);
                            eprintln!("BAD MESSAGE WAS -> {}", message);
                            continue;
                        }
                    };

                    let normalized_json = match normalize_udp_json(raw_json) {
                        Ok(value) => value,
                        Err(error) => {
                            eprintln!("FAILED TO NORMALIZE UDP JSON -> {}", error);
                            continue;
                        }
                    };

                    update_connection_if_heartbeat(&normalized_json, &state);

                    let parsed_event = serde_json::from_value::<RecallEvent>(normalized_json);

                    match parsed_event {
                        Ok(mut event) => {
                            if VERBOSE_UDP_LOGGING {
                                println!(
                                    "PARSED RecallEvent -> type: {}, track: {:?}, device: {:?}",
                                    event.event_type, event.track_name, event.device_name
                                );
                            }

                            assign_session_if_active(&mut event, &session);
                            persist_event_if_session_owned(&event, &storage);
                            push_event(&events, event.clone());

                            // Push to frontend in real-time.
                            // Heartbeats are excluded — they update connection state only.
                            if event.event_type != "heartbeat" {
                                if let Err(e) = app_handle.emit("recall-event", &event) {
                                    eprintln!("Failed to emit recall-event: {}", e);
                                }
                            }
                        }
                        Err(error) => {
                            eprintln!(
                                "FAILED TO PARSE NORMALIZED JSON AS RecallEvent -> {}",
                                error
                            );
                        }
                    }
                }
                Err(error) => {
                    eprintln!("UDP listener error: {}", error);
                }
            }
        }
    });
}

pub fn get_status(state: Arc<Mutex<ConnectionState>>) -> ConnectionStatus {
    let connection = state.lock().expect("Connection state lock failed");
    let current_time = now_ms();

    let connected = match connection.last_heartbeat_ms {
        Some(last_seen) => current_time.saturating_sub(last_seen) < 5_000,
        None => false,
    };

    ConnectionStatus {
        connected,
        last_heartbeat_ms: connection.last_heartbeat_ms,
        last_message: connection.last_message.clone(),
    }
}
