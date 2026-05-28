use crate::protocol::RecallEvent;
use crate::session::SessionState;
use crate::storage::StorageState;
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    net::UdpSocket,
    sync::{Arc, Mutex},
    thread,
    time::{SystemTime, UNIX_EPOCH},
};

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
    protocol == "recall.v1" || protocol == "recall.protocol.v1"
}

fn title_for_event_type(event_type: &str) -> String {
    match event_type {
        "heartbeat" => "Heartbeat Received".to_string(),
        "bridge_started" => "Ableton Bridge Started".to_string(),
        "bridge_stopped" => "Ableton Bridge Stopped".to_string(),

        "tempo_changed" => "Tempo Changed".to_string(),
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
        "clip_launched" => "Clip Launched".to_string(),
        "clip_stopped" => "Clip Stopped".to_string(),
        "clip_recording_started" => "Clip Recording Started".to_string(),
        "clip_recording_stopped" => "Clip Recording Stopped".to_string(),

        "scene_changed" => "Scene Changed".to_string(),
        "scene_launched" => "Scene Launched".to_string(),

        "device_event" => "Device Event".to_string(),
        "device_selected" => "Device Selected".to_string(),
        "device_parameter_changed" => "Device Parameter Changed".to_string(),

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
        "clip_launched" => "An Ableton clip was launched.".to_string(),
        "clip_stopped" => "An Ableton clip was stopped.".to_string(),
        "clip_recording_started" => "Ableton clip recording started.".to_string(),
        "clip_recording_stopped" => "Ableton clip recording stopped.".to_string(),

        "scene_changed" => "Ableton scene selection changed.".to_string(),
        "scene_launched" => "An Ableton scene was launched.".to_string(),

        "device_event" => "Ableton device event received.".to_string(),
        "device_selected" => "Ableton selected device changed.".to_string(),
        "device_parameter_changed" => "An Ableton device parameter changed.".to_string(),

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
        .entry("schema_version".to_string())
        .or_insert(json!(1));

    object
        .entry("source".to_string())
        .or_insert(Value::String("max_for_live".to_string()));

    object
        .entry("device_id".to_string())
        .or_insert(Value::String("unknown-device".to_string()));

    object.entry("sequence".to_string()).or_insert(json!(0));

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

    // Future-friendly protocol metadata.
    // These extra fields are ignored if RecallEvent does not define them.
    object
        .entry("category".to_string())
        .or_insert(Value::String("ableton_telemetry".to_string()));

    object
        .entry("severity".to_string())
        .or_insert(Value::String("info".to_string()));

    object
        .entry("origin".to_string())
        .or_insert(Value::String("max_for_live".to_string()));

    object
        .entry("namespace".to_string())
        .or_insert(Value::String("recall.ableton".to_string()));

    object
        .entry("project_id".to_string())
        .or_insert(Value::Null);

    object
        .entry("project_name".to_string())
        .or_insert(Value::Null);

    object.entry("track_id".to_string()).or_insert(Value::Null);

    object
        .entry("track_name".to_string())
        .or_insert(Value::Null);

    object.entry("clip_id".to_string()).or_insert(Value::Null);

    object.entry("clip_name".to_string()).or_insert(Value::Null);

    object.entry("scene_id".to_string()).or_insert(Value::Null);

    object
        .entry("scene_name".to_string())
        .or_insert(Value::Null);

    object
        .entry("device_name".to_string())
        .or_insert(Value::Null);

    object
        .entry("parameter_name".to_string())
        .or_insert(Value::Null);

    object.entry("tags".to_string()).or_insert(json!([]));

    object
        .entry("metadata".to_string())
        .or_insert(Value::String("{}".to_string()));

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

    if recent_events.len() > 100 {
        recent_events.remove(0);
    }

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
                        println!("UDP raw bytes: {:?}", bytes);
                    }

                    let message = match extract_json_object(bytes) {
                        Ok(message) => message,
                        Err(error) => {
                            eprintln!("FAILED TO EXTRACT JSON FROM UDP MESSAGE -> {}", error);
                            eprintln!("RAW BYTES WERE -> {:?}", bytes);
                            if VERBOSE_UDP_LOGGING {
                                println!("=====================================================");
                            }
                            continue;
                        }
                    };

                    if VERBOSE_UDP_LOGGING {
                        println!("UDP extracted JSON: {}", message);
                        println!("=====================================================");
                    }

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
                            eprintln!("BAD MESSAGE WAS -> {}", message);
                            continue;
                        }
                    };

                    update_connection_if_heartbeat(&normalized_json, &state);

                    let parsed_event = serde_json::from_value::<RecallEvent>(normalized_json);

                    match parsed_event {
                        Ok(mut event) => {
                            if VERBOSE_UDP_LOGGING {
                                println!(
                                    "PARSED RecallEvent -> type: {}, title: {}",
                                    event.event_type, event.title
                                );
                            }

                            assign_session_if_active(&mut event, &session);
                            persist_event_if_session_owned(&event, &storage);
                            push_event(&events, event);
                        }
                        Err(error) => {
                            eprintln!(
                                "FAILED TO PARSE NORMALIZED JSON AS RecallEvent -> {}",
                                error
                            );
                            eprintln!("ORIGINAL CLEANED MESSAGE WAS -> {}", message);
                            eprintln!(
                                "CONNECTION STATE MAY STILL BE UPDATED IF THIS WAS A HEARTBEAT"
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
