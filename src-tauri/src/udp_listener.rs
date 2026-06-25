use crate::event_catalog::{
    classify_priority, description_for_event_type, title_for_event_type, EventPriority,
};
use crate::metrics::BridgeMetrics;
use crate::protocol::RecallEvent;
use crate::session::SessionState;
use crate::storage::StorageState;
use serde::Serialize;
use serde_json::{json, Map, Value};
use std::{
    net::UdpSocket,
    sync::{
        mpsc::{sync_channel, SyncSender, TrySendError},
        Arc, Mutex,
    },
    thread,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter};

const VERBOSE_UDP_LOGGING: bool = false;

// Receive buffer must exceed the bridge's MAX_EVENT_BYTES (8192) so a large but
// legal snapshot is never truncated mid-JSON into an unparseable packet.
const RECV_BUFFER_BYTES: usize = 16_384;

// Bounded queue between the receive loop and the persistence worker. Sized to
// absorb multi-hundred-event bursts while the worker drains. When full, the
// enqueue policy (see classify/enqueue) protects critical creative events and
// sheds only coalescible noise.
const EVENT_QUEUE_CAPACITY: usize = 4_096;

// Max events drained and persisted in one transaction by the worker.
const PERSIST_BATCH_MAX: usize = 256;

// Hard ceiling on the in-memory live buffer so a marathon session can't grow
// memory without bound. The DB is authoritative; the frontend reloads saved
// sessions from SQLite, so trimming the oldest live events is safe.
const LIVE_BUFFER_MAX: usize = 50_000;

// Event priority (overload shedding) now lives in `event_catalog.rs` alongside
// the rest of each event's static metadata. `classify_priority` and
// `EventPriority` are imported at the top of this file.

#[derive(Debug, Clone)]
pub struct ConnectionState {
    pub last_heartbeat_ms: Option<u64>,
    pub last_message: Option<String>,
    // Version string reported by the live Max bridge in each heartbeat. Lets the
    // app show which bridge build is actually connected, so a producer can verify
    // they loaded the newest device instead of squinting at the Max Console.
    pub bridge_version: Option<String>,
    // The `.als` Ableton currently has open, learned from the project_path that
    // rides on incoming events. This is how "open a project" knows which version's
    // take to resume — see open_take_for_open_file.
    pub open_als_path: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct ConnectionStatus {
    pub connected: bool,
    pub last_heartbeat_ms: Option<u64>,
    pub last_message: Option<String>,
    pub bridge_version: Option<String>,
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

// Per-event fallback titles and descriptions now live in `event_catalog.rs`.
// `title_for_event_type` and `description_for_event_type` are imported at the top
// of this file and used by `normalize_udp_json` when the bridge omits its own.

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
    // Reject anything that isn't a JSON object — we can't normalize a bare array or scalar.
    let object = value
        .as_object_mut()
        .ok_or_else(|| "UDP JSON was not an object".to_string())?;

    // Reject packets from protocol versions we don't understand.
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

    // Fill in required envelope fields that older/minimal senders may have omitted.
    // or_insert leaves existing values untouched; insert overwrites (protocol, event_type
    // are always normalised to the resolved string so type coercions don't leak through).
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

    // Flatten the nested payload object to a JSON string so RecallEvent can store it
    // as a plain String field rather than a recursive serde_json::Value.
    let payload_string = payload_to_string(object.get("payload"));
    object.insert("payload".to_string(), Value::String(payload_string));

    // ── Extract structured fields ─────────────────────────────────────────────
    // Parse the payload string back out so we can look for canonical fields that
    // the bridge may have placed inside it rather than at the top level.
    let payload_parsed: Option<Value> = object
        .get("payload")
        .and_then(|v| v.as_str())
        .and_then(|s| serde_json::from_str(s).ok());
    let payload_obj = payload_parsed.as_ref().and_then(|v| v.as_object());

    // Each find_* call checks the top-level object first, then the payload, trying
    // the canonical v2 name first and then common v1 synonyms in order.
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
    let track_type = find_string(object, payload_obj, &["track_type", "trackType"]);
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
    let sample_name = find_string(
        object,
        payload_obj,
        &["sample_name", "sample", "file_name", "fileName"],
    );
    let file_path = find_string(
        object,
        payload_obj,
        &["file_path", "filePath", "path", "sample_path"],
    );
    let project_name = find_string(
        object,
        payload_obj,
        &["project_name", "projectName", "live_set_name", "set_name"],
    );
    let project_path = find_string(
        object,
        payload_obj,
        &["project_path", "projectPath", "live_set_path", "set_path"],
    );
    let device_chain = find_string(object, payload_obj, &["device_chain", "chain"]);
    let bpm = find_f64(object, payload_obj, &["bpm", "tempo"]);
    let playing = find_bool(object, payload_obj, &["playing", "is_playing"]);
    let parameter_value = find_f64(
        object,
        payload_obj,
        &["parameter_value", "value", "param_value"],
    );
    let previous_parameter_value = find_f64(
        object,
        payload_obj,
        &["previous_parameter_value", "previous_value", "before_value"],
    );
    let parameter_value_percent = find_f64(
        object,
        payload_obj,
        &[
            "parameter_value_percent",
            "value_percent",
            "parameter_percent",
            "normalized_percent",
        ],
    );
    let previous_parameter_value_percent = find_f64(
        object,
        payload_obj,
        &[
            "previous_parameter_value_percent",
            "previous_value_percent",
            "before_value_percent",
        ],
    );
    let parameter_display_value = find_string(
        object,
        payload_obj,
        &["parameter_display_value", "display_value"],
    );
    let previous_parameter_display_value = find_string(
        object,
        payload_obj,
        &["previous_parameter_display_value", "previous_display_value"],
    );
    let parameter_is_quantized =
        find_bool(object, payload_obj, &["parameter_is_quantized", "is_quantized"]);

    // Write every canonical field back to the top level — present value or explicit null.
    // This guarantees the frontend always sees a flat, predictable shape with no
    // payload digging, regardless of which protocol version sent the event.
    match track_name {
        Some(v) => object.insert("track_name".to_string(), Value::String(v)),
        None => object.insert("track_name".to_string(), Value::Null),
    };
    match track_type {
        Some(v) => object.insert("track_type".to_string(), Value::String(v)),
        None => object.insert("track_type".to_string(), Value::Null),
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
    match sample_name {
        Some(v) => object.insert("sample_name".to_string(), Value::String(v)),
        None => object.insert("sample_name".to_string(), Value::Null),
    };
    match file_path {
        Some(v) => object.insert("file_path".to_string(), Value::String(v)),
        None => object.insert("file_path".to_string(), Value::Null),
    };
    match project_name {
        Some(v) => object.insert("project_name".to_string(), Value::String(v)),
        None => object.insert("project_name".to_string(), Value::Null),
    };
    match project_path {
        Some(v) => object.insert("project_path".to_string(), Value::String(v)),
        None => object.insert("project_path".to_string(), Value::Null),
    };
    match device_chain {
        Some(v) => object.insert("device_chain".to_string(), Value::String(v)),
        None => object.insert("device_chain".to_string(), Value::Null),
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
    match previous_parameter_value {
        Some(v) => object.insert("previous_parameter_value".to_string(), json!(v)),
        None => object.insert("previous_parameter_value".to_string(), Value::Null),
    };
    match parameter_value_percent {
        Some(v) => object.insert("parameter_value_percent".to_string(), json!(v)),
        None => object.insert("parameter_value_percent".to_string(), Value::Null),
    };
    match previous_parameter_value_percent {
        Some(v) => object.insert("previous_parameter_value_percent".to_string(), json!(v)),
        None => object.insert(
            "previous_parameter_value_percent".to_string(),
            Value::Null,
        ),
    };
    match parameter_display_value {
        Some(v) => object.insert("parameter_display_value".to_string(), Value::String(v)),
        None => object.insert("parameter_display_value".to_string(), Value::Null),
    };
    match previous_parameter_display_value {
        Some(v) => object.insert(
            "previous_parameter_display_value".to_string(),
            Value::String(v),
        ),
        None => object.insert("previous_parameter_display_value".to_string(), Value::Null),
    };
    match parameter_is_quantized {
        Some(v) => object.insert("parameter_is_quantized".to_string(), json!(v)),
        None => object.insert("parameter_is_quantized".to_string(), Value::Null),
    };

    Ok(value)
}

// Event types traced to the console as "XXX:EVENT LOGGED". Edit this list to add or
// remove the events you want to watch — it's the easy knob for targeted debugging.
// To firehose EVERY incoming event instead, flip VERBOSE_UDP_LOGGING (top of file)
// to true; the list is then ignored.
const LOGGED_EVENT_TYPES: &[&str] = &[
    // Track lifecycle
    "track_created",
    "track_deleted",
    "track_name_changed",
    // Devices
    "device_added",
    "device_removed",
    "device_chain_changed",
    // Parameters & automation
    "parameter_changed",
    "automation_created",
    // Clips & samples
    "sample_added",
    "audio_clip_added",
    "midi_clip_created",
    "clip_created",
    // Deep snapshots that feed the schema projection
    "live_set_snapshot",
    "session_snapshot",
    // Tempo
    "tempo_changed",
];

// Console tracing for incoming events. Prints anything in LOGGED_EVENT_TYPES (or
// everything when VERBOSE_UDP_LOGGING is on), tagged with its event_type so it's
// easy to grep in the Tauri console.
fn log_events(normalized_json: &Value) {
    let event_type = normalized_json
        .get("event_type")
        .and_then(Value::as_str)
        .unwrap_or("");

    if !VERBOSE_UDP_LOGGING && !LOGGED_EVENT_TYPES.contains(&event_type) {
        return;
    }

    println!("XXX:EVENT LOGGED [{}] -> {}", event_type, normalized_json);
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

    // bridge_version lives in the heartbeat payload JSON string.
    let bridge_version = normalized_json
        .get("payload")
        .and_then(Value::as_str)
        .and_then(|s| serde_json::from_str::<Value>(s).ok())
        .and_then(|p| {
            p.get("bridge_version")
                .and_then(Value::as_str)
                .map(|s| s.to_string())
        });

    let mut connection = state.lock().expect("Connection state lock failed");
    connection.last_heartbeat_ms = Some(now_ms());
    connection.last_message = Some(title);
    if bridge_version.is_some() {
        connection.bridge_version = bridge_version;
    }

    if VERBOSE_UDP_LOGGING {
        println!(
            "HEARTBEAT UPDATED -> last_heartbeat_ms: {:?}",
            connection.last_heartbeat_ms
        );
    }
}

// Remember which `.als` Ableton has open, read from the project_path that rides on
// a normalized event. Only `.als` paths count (the bridge also reports folder paths
// for un-saved sets). Lets "open a project" resume the take for the live version.
fn update_open_file(normalized_json: &Value, state: &Arc<Mutex<ConnectionState>>) {
    let path = normalized_json
        .get("project_path")
        .and_then(Value::as_str)
        .map(str::to_string);
    let Some(path) = path else {
        return;
    };
    if !path.to_lowercase().ends_with(".als") {
        return;
    }

    let mut connection = state.lock().expect("Connection state lock failed");
    if connection.open_als_path.as_deref() != Some(path.as_str()) {
        connection.open_als_path = Some(path);
    }
}

fn push_event(events: &Arc<Mutex<Vec<RecallEvent>>>, event: RecallEvent) {
    let mut recent_events = events.lock().expect("Recent events lock failed");

    recent_events.push(event);

    // Bound the live buffer. The DB is authoritative and the frontend reloads
    // saved sessions from SQLite, so trimming the oldest live events caps memory
    // without losing durable data.
    if recent_events.len() > LIVE_BUFFER_MAX {
        let overflow = recent_events.len() - LIVE_BUFFER_MAX;
        recent_events.drain(0..overflow);
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

// Drains the queue, persists in batches on a single connection, stamps stable
// ids, then pushes to the live buffer and emits to the frontend. Runs on its own
// thread so no SQLite work or emit ever blocks the UDP receive loop.
fn run_persistence_worker(
    receiver: std::sync::mpsc::Receiver<RecallEvent>,
    events: Arc<Mutex<Vec<RecallEvent>>>,
    storage: Arc<Mutex<StorageState>>,
    app_handle: AppHandle,
    metrics: Arc<BridgeMetrics>,
) {
    // Block for the next event, then opportunistically drain whatever else is
    // already queued so a burst becomes a single transaction.
    while let Ok(first) = receiver.recv() {
        metrics.on_dequeue();

        let mut batch: Vec<RecallEvent> = Vec::with_capacity(PERSIST_BATCH_MAX);
        batch.push(first);

        while batch.len() < PERSIST_BATCH_MAX {
            match receiver.try_recv() {
                Ok(event) => {
                    metrics.on_dequeue();
                    batch.push(event);
                }
                Err(_) => break,
            }
        }

        // Persist the session-owned events as one transaction and stamp rowids
        // back onto the matching events so the live event shares its saved id.
        {
            let storage_state = storage.lock().expect("Storage state lock failed");

            match storage_state.save_events_batch(&batch) {
                Ok(rowids) => {
                    for (event, rowid) in batch.iter_mut().zip(rowids) {
                        if let Some(id) = rowid {
                            event.id = Some(id);
                            metrics.incr_persisted();
                        }
                    }

                    for event in &batch {
                        if let Some(session_id) = event.session_id.as_deref() {
                            if event.project_name.is_some() || event.project_path.is_some() {
                                if let Err(error) = storage_state.remember_ableton_project(
                                    session_id,
                                    event.project_name.as_deref(),
                                    event.project_path.as_deref(),
                                ) {
                                    eprintln!("FAILED TO REMEMBER ABLETON PROJECT -> {}", error);
                                    metrics.set_last_error(error);
                                }
                            }
                        }
                    }
                }
                Err(error) => {
                    eprintln!("FAILED TO PERSIST EVENT BATCH -> {}", error);
                    metrics.set_last_error(error);
                }
            }
        }

        for event in batch {
            push_event(&events, event.clone());

            if let Err(e) = app_handle.emit("recall-event", &event) {
                eprintln!("Failed to emit recall-event: {}", e);
                metrics.set_last_error(format!("emit failed: {}", e));
            } else {
                metrics.incr_emitted();
            }
        }
    }

    eprintln!("Recall Studio persistence worker stopped (channel closed)");
}

// Enqueue policy implementing graceful overload. Critical/important events block
// briefly until the worker makes room (rare; guarantees no creative data loss),
// while coalescible high-frequency telemetry is dropped when the queue is full.
fn enqueue_event(
    sender: &SyncSender<RecallEvent>,
    event: RecallEvent,
    metrics: &Arc<BridgeMetrics>,
) {
    let priority = classify_priority(&event.event_type);

    match sender.try_send(event) {
        Ok(()) => metrics.on_enqueue(),
        Err(TrySendError::Full(event)) => {
            if priority == EventPriority::Coalescible {
                metrics.incr_dropped();
                if VERBOSE_UDP_LOGGING {
                    println!("QUEUE FULL -> dropped coalescible {}", event.event_type);
                }
            } else {
                // Block until the worker drains room. Critical creative actions
                // are rare, so the brief backpressure here cannot cause a storm.
                if sender.send(event).is_ok() {
                    metrics.on_enqueue();
                } else {
                    metrics.incr_dropped();
                }
            }
        }
        Err(TrySendError::Disconnected(_)) => {
            metrics.incr_dropped();
            metrics.set_last_error("persistence worker channel disconnected");
        }
    }
}

pub fn start_udp_listener(
    state: Arc<Mutex<ConnectionState>>,
    events: Arc<Mutex<Vec<RecallEvent>>>,
    session: Arc<Mutex<SessionState>>,
    storage: Arc<Mutex<StorageState>>,
    app_handle: AppHandle,
    metrics: Arc<BridgeMetrics>,
) {
    let (sender, receiver) = sync_channel::<RecallEvent>(EVENT_QUEUE_CAPACITY);

    // Persistence/emit worker.
    {
        let events = events.clone();
        let storage = storage.clone();
        let app_handle = app_handle.clone();
        let metrics = metrics.clone();
        thread::spawn(move || {
            run_persistence_worker(receiver, events, storage, app_handle, metrics);
        });
    }

    // UDP receive loop — parse, normalize, classify, enqueue. No SQLite, no emit.
    thread::spawn(move || {
        let socket = UdpSocket::bind("127.0.0.1:9000")
            .expect("Failed to bind UDP listener on 127.0.0.1:9000");

        println!("Recall Studio UDP listener running on 127.0.0.1:9000");

        let mut buffer = [0u8; RECV_BUFFER_BYTES];

        loop {
            match socket.recv_from(&mut buffer) {
                Ok((size, addr)) => {
                    metrics.incr_packets_received();
                    let bytes = &buffer[..size];

                    if VERBOSE_UDP_LOGGING {
                        println!("================ UDP PACKET RECEIVED ================");
                        println!("UDP from: {}", addr);
                        println!("UDP bytes length: {}", size);
                    }

                    let message = match extract_json_object(bytes) {
                        Ok(message) => message,
                        Err(error) => {
                            metrics.incr_malformed();
                            metrics.set_last_error(error.clone());
                            eprintln!("FAILED TO EXTRACT JSON FROM UDP MESSAGE -> {}", error);
                            continue;
                        }
                    };

                    let raw_json = match serde_json::from_str::<Value>(&message) {
                        Ok(value) => value,
                        Err(error) => {
                            metrics.incr_malformed();
                            metrics.set_last_error(format!("json parse: {}", error));
                            eprintln!("FAILED TO PARSE UDP MESSAGE AS JSON -> {}", error);
                            continue;
                        }
                    };

                    let normalized_json = match normalize_udp_json(raw_json) {
                        Ok(value) => value,
                        Err(error) => {
                            metrics.incr_malformed();
                            metrics.set_last_error(error.clone());
                            eprintln!("FAILED TO NORMALIZE UDP JSON -> {}", error);
                            continue;
                        }
                    };
                    log_events(&normalized_json);
                    // Heartbeats are health-only: update connection state and
                    // stop here. They are never queued, persisted, or emitted.
                    update_connection_if_heartbeat(&normalized_json, &state);
                    // Track the open `.als` so opening a project can resume the take
                    // for the live version. The bridge stamps project_path on every
                    // heartbeat, so do this before heartbeats are dropped below.
                    update_open_file(&normalized_json, &state);
                    let is_heartbeat = normalized_json.get("event_type").and_then(Value::as_str)
                        == Some("heartbeat");
                    if is_heartbeat {
                        continue;
                    }

                    match serde_json::from_value::<RecallEvent>(normalized_json) {
                        Ok(mut event) => {
                            assign_session_if_active(&mut event, &session);
                            enqueue_event(&sender, event, &metrics);
                        }
                        Err(error) => {
                            metrics.incr_malformed();
                            eprintln!(
                                "FAILED TO PARSE NORMALIZED JSON AS RecallEvent -> {}",
                                error
                            );
                        }
                    }
                }
                Err(error) => {
                    metrics.set_last_error(format!("recv: {}", error));
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
        bridge_version: connection.bridge_version.clone(),
    }
}

#[cfg(test)]
mod tests {
    //! Tests for the pure ingestion logic — the part of the UDP path that has no
    //! sockets or threads and can be exercised directly: pulling JSON out of a raw
    //! datagram, gating the protocol version, and normalizing a packet into the
    //! flat, fully-populated shape the rest of the app relies on.
    use super::*;
    use serde_json::json;

    /// Normalize a packet and return its object map, panicking on rejection.
    /// Keeps each test focused on assertions rather than unwrapping boilerplate.
    fn normalized(value: Value) -> Map<String, Value> {
        normalize_udp_json(value)
            .expect("packet should normalize")
            .as_object()
            .expect("normalized packet is always an object")
            .clone()
    }

    #[test]
    fn extract_json_object_pulls_object_from_noisy_bytes() {
        // Max's [udpsend] can wrap the JSON in stray bytes; we slice from the first
        // '{' to the last '}'.
        let extracted = extract_json_object(b"garbage{\"a\":1}trailing").unwrap();
        assert_eq!(extracted, "{\"a\":1}");
    }

    #[test]
    fn extract_json_object_errors_without_braces() {
        assert!(extract_json_object(b"no json here").is_err());
    }

    #[test]
    fn protocol_gate_accepts_known_versions_only() {
        assert!(protocol_is_supported("recall.v2"));
        assert!(protocol_is_supported("recall.v1"));
        assert!(protocol_is_supported("recall.protocol.v1"));
        assert!(!protocol_is_supported("recall.v9"));
        assert!(!protocol_is_supported("nonsense"));
    }

    #[test]
    fn normalize_rejects_unsupported_protocol() {
        let result = normalize_udp_json(json!({ "protocol": "recall.v9", "event_type": "x" }));
        assert!(result.is_err());
    }

    #[test]
    fn normalize_fills_missing_envelope_defaults() {
        // A minimal packet (just an event_type) must come out fully addressed:
        // source defaulted, timestamp stamped, title/description from the catalog,
        // and session_id present (null) for the backend to fill later.
        let obj = normalized(json!({ "event_type": "track_created" }));
        assert_eq!(obj["source"], json!("max_for_live"));
        assert!(obj["timestamp_ms"].as_u64().unwrap() > 0);
        assert_eq!(obj["title"], json!("Track Created"));
        assert_eq!(obj["description"], json!("A track was created in Ableton."));
        assert!(obj.contains_key("session_id"));
    }

    #[test]
    fn normalize_keeps_a_title_the_bridge_supplied() {
        // The producer-facing title from the bridge must win over the catalog
        // fallback.
        let obj = normalized(json!({
            "event_type": "sample_added",
            "title": "Dropped in vocal.wav"
        }));
        assert_eq!(obj["title"], json!("Dropped in vocal.wav"));
    }

    #[test]
    fn normalize_passes_top_level_canonical_fields_through() {
        // The v2 happy path: the bridge already lifted fields to the top level.
        let obj = normalized(json!({
            "protocol": "recall.v2",
            "event_type": "sample_added",
            "track_name": "Vocals",
            "track_type": "audio",
            "sample_name": "Deep_House_Vocal_120bpm.wav",
            "file_path": "C:/Splice/Deep_House_Vocal_120bpm.wav"
        }));
        assert_eq!(obj["track_name"], json!("Vocals"));
        assert_eq!(obj["track_type"], json!("audio"));
        assert_eq!(obj["sample_name"], json!("Deep_House_Vocal_120bpm.wav"));
        assert_eq!(
            obj["file_path"],
            json!("C:/Splice/Deep_House_Vocal_120bpm.wav")
        );
    }

    #[test]
    fn normalize_recovers_canonical_fields_from_payload() {
        // A minimal sender that only nested the data inside `payload` still works:
        // the backend digs it out and promotes it to the top level.
        let obj = normalized(json!({
            "event_type": "sample_added",
            "payload": { "sample_name": "kick.wav", "track_type": "audio" }
        }));
        assert_eq!(obj["sample_name"], json!("kick.wav"));
        assert_eq!(obj["track_type"], json!("audio"));
    }

    #[test]
    fn normalize_sets_absent_canonical_fields_to_null() {
        // The frontend relies on a flat, predictable shape — every canonical field
        // is always present, even when null, so it never has to dig through payload.
        let obj = normalized(json!({ "event_type": "tempo_changed", "bpm": 124.0 }));
        assert_eq!(obj["bpm"], json!(124.0));
        assert!(obj["track_name"].is_null());
        assert!(obj["track_type"].is_null());
        assert!(obj["sample_name"].is_null());
        assert!(obj["device_name"].is_null());
    }

    #[test]
    fn normalized_packet_round_trips_into_recall_event() {
        // The normalized object must deserialize into the typed RecallEvent the
        // persistence worker and frontend consume — including the new fields.
        let value = normalize_udp_json(json!({
            "protocol": "recall.v2",
            "event_type": "sample_added",
            "track_name": "Vocals",
            "track_type": "audio",
            "sample_name": "vox.wav"
        }))
        .unwrap();

        let event: RecallEvent = serde_json::from_value(value).unwrap();
        assert_eq!(event.event_type, "sample_added");
        assert_eq!(event.track_type.as_deref(), Some("audio"));
        assert_eq!(event.sample_name.as_deref(), Some("vox.wav"));
    }
}
