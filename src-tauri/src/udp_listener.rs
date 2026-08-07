use crate::event_catalog::{
    classify_priority, description_for_event_type, title_for_event_type, EventPriority,
};
use crate::metrics::BridgeMetrics;
use crate::protocol::RecallEvent;
use crate::session::SessionState;
use crate::storage::StorageState;
use serde::Serialize;
use serde_json::{json, Map, Value};
use socket2::{Domain, Protocol, Socket, Type};
use std::{
    collections::HashMap,
    io::{BufRead, BufReader},
    net::{SocketAddr, TcpListener, UdpSocket},
    panic::{catch_unwind, AssertUnwindSafe},
    sync::{
        mpsc::{sync_channel, SyncSender, TrySendError},
        Arc, Mutex,
    },
    thread,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter};

const VERBOSE_UDP_LOGGING: bool = false;

// Separate port from the UDP listener's 9000, so both transports can run at
// once and a client picks its transport by which port it connects to.
const TCP_LISTEN_ADDR: &str = "127.0.0.1:9001";

// Receive buffer must exceed the bridge's MAX_EVENT_BYTES (8192) so a large but
// legal snapshot is never truncated mid-JSON into an unparseable packet.
const RECV_BUFFER_BYTES: usize = 16_384;

// Ceiling on a single TCP line (one event). 4x the bridge's own MAX_EVENT_BYTES
// (8192) cap, so a legal event never comes close. BufReader::lines() has no such
// cap — a client that never sends a newline would grow its buffer without bound.
const MAX_TCP_LINE_BYTES: usize = 32_768;

// Bounded queue between the receive loop and the persistence worker. Sized to
// absorb multi-hundred-event bursts while the worker drains. When full, the
// enqueue policy (see classify/enqueue) protects critical creative events and
// sheds only coalescible noise.
const EVENT_QUEUE_CAPACITY: usize = 4_096;

// Kernel socket receive buffer. This is the single highest-value constant in the
// file, because it is where packets actually died.
//
// MEASURED 2026-07-15: with the OS default, loss begins at exactly the buffer
// boundary. 2,000 Critical events, OS-confirmed 2,000/2,000 sends — burst at
// ~80k/s persisted 407 (80% lost); paced at ~500/s persisted 2,000 (0% lost).
// The gap ranges start at sequence 239, not 1: sequences 1-238 survive
// contiguously (78,302 bytes at 329 bytes average) against Windows' 65,536-byte
// default, then loss runs in dense blocks. The queue (4,096) was never the
// binding constraint — only 2,000 were in flight, so it could not fill.
//
// Sized for the deep snapshot on project load (SPEC §F1), which is the only
// burst Ableton actually produces: ~8MB absorbs roughly 24,000 events at 350
// bytes each. Windows silently clamps large values, so the bind path reads the
// applied size back with getsockopt rather than trusting the request.
const RECV_SOCKET_BUFFER_BYTES: usize = 8 * 1024 * 1024;

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
    // The `.als` the CURRENTLY ACTIVE session is anchored to. Compared against
    // open_als_path on every event to detect that the producer switched projects
    // in Ableton — the trigger for auto-rotating the session so one project's
    // capture never lands in, or overwrites, another's. None until the first
    // saved set is seen.
    pub session_als_path: Option<String>,
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
    // Live's stable per-track pointer, same identifier space as the schema
    // snapshot's `ableton_id`. See protocol.rs::RecallEvent::track_id.
    let track_id = find_string(object, payload_obj, &["track_id", "trackId"]);
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
    match track_id {
        Some(v) => object.insert("track_id".to_string(), Value::String(v)),
        None => object.insert("track_id".to_string(), Value::Null),
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
    "clip_notes_changed",
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

// Auto-rotate the active session when Ableton switches to a different project.
//
// THE BUG THIS FIXES: one session was created at app start and stayed active
// forever, so opening a second project streamed its snapshot into the FIRST
// project's session — overwriting its tracks. Capture from two songs collided in
// one take and the earlier one was lost.
//
// This reuses the exact rotation the manual "open take" command already performs
// (stop + persist the old take, resume-or-create the take anchored to the open
// file, clear the live buffer). The only new thing is the trigger: comparing the
// open `.als` against what the active session is anchored to, on the receive
// thread, BEFORE the event is assigned to a session — so the event lands on the
// correct take, not the one that was active a moment ago.
//
// Because materialize_session_schema is scoped by session_id, separated sessions
// mean nothing is overwritten: the previous project's take keeps everything, and
// reopening it later resumes it intact.
//
// LOCK DISCIPLINE: every lock here is acquired and released before the next is
// taken — never nested — matching open_take_for_open_file. Nesting storage
// inside session (or the reverse) is the one way this could deadlock against the
// persistence worker, so it is deliberately avoided.
//
// Unsaved sets have no `.als` path and do not rotate: they stay on the current
// session. Anchoring an unsaved set is a separate, unsolved problem (a set with
// no file has nothing stable to key on).
fn rotate_session_if_project_changed(
    state: &Arc<Mutex<ConnectionState>>,
    session: &Arc<Mutex<SessionState>>,
    storage: &Arc<Mutex<StorageState>>,
    events: &Arc<Mutex<Vec<RecallEvent>>>,
    metrics: &Arc<BridgeMetrics>,
) {
    // Cheap guard on the hot path: only proceed when the open file differs from
    // what the active session covers. One short connection lock, string compare.
    let open_als = {
        let connection = state.lock().expect("Connection state lock failed");
        match &connection.open_als_path {
            Some(open) if connection.session_als_path.as_deref() != Some(open.as_str()) => {
                open.clone()
            }
            _ => return,
        }
    };

    // Stop + persist whatever take was active, so its data is preserved rather
    // than bled into the next one.
    let previous_status = {
        let mut session = session.lock().expect("Session state lock failed");
        session.stop()
    };

    // Storage work in its own scope, released before the session lock below.
    let activated = {
        let storage = storage.lock().expect("Storage state lock failed");
        if let Some(previous_session_id) = previous_status.session_id.as_deref() {
            // The startup fallback creates a session before any event has said
            // which project it belongs to. If nothing was ever captured into
            // it and it was never anchored to a set, this rotation is the
            // first proof that it will never be used — delete it rather than
            // leaving an empty, stopped, unanchored session behind on every
            // launch that reaches this point. Real takes (events or anchor)
            // are always preserved via the normal stop-and-persist path.
            let empty_and_unanchored = storage
                .is_session_empty_and_unanchored(previous_session_id)
                .unwrap_or(false);

            if empty_and_unanchored {
                if let Err(error) = storage.delete_session(previous_session_id) {
                    eprintln!("AUTO-ROTATE: failed to delete empty startup session -> {}", error);
                    metrics.set_last_error(error);
                }
            } else if let Err(error) = storage.save_session_stopped(&previous_status) {
                eprintln!("AUTO-ROTATE: failed to persist previous take -> {}", error);
                metrics.set_last_error(error);
            }
        }
        // project_id is None: an auto-captured take is not yet filed under a
        // user-created project. The producer can assign it later in the UI.
        storage.activate_take_for_open_file(None, Some(&open_als))
    };

    let status = match activated {
        Ok(status) => status,
        Err(error) => {
            eprintln!("AUTO-ROTATE: failed to activate take for open file -> {}", error);
            metrics.set_last_error(error);
            return;
        }
    };

    // Fresh live buffer so the previous take's events don't bleed into this one.
    {
        let mut recent_events = events.lock().expect("Recent events lock failed");
        recent_events.clear();
    }

    // Point the in-memory session at the new take so subsequent events tag to it,
    // and record what it is anchored to so this does not re-fire every event.
    if let (Some(session_id), Some(started_at_ms)) =
        (status.session_id.clone(), status.started_at_ms)
    {
        {
            let mut session = session.lock().expect("Session state lock failed");
            session.restore_active(session_id.clone(), started_at_ms);
        }
        {
            let mut connection = state.lock().expect("Connection state lock failed");
            connection.session_als_path = Some(open_als.clone());
        }
        println!(
            "AUTO-ROTATE: switched capture to take {} for {}",
            session_id, open_als
        );
    }
}

// Append a whole batch under ONE lock.
//
// This used to be called per event, so a 20,000-event burst meant 20,000 lock
// acquisitions and 20,000 clones in the drain loop — the same per-event cost
// `save_events_batch` exists to avoid, ten lines after it.
fn push_events(events: &Arc<Mutex<Vec<RecallEvent>>>, batch: &[RecallEvent]) {
    let mut recent_events = events.lock().expect("Recent events lock failed");

    recent_events.extend_from_slice(batch);

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

// Stamp the active session onto an event, and count it when there isn't one.
//
// Returns false when no session is active, which means this event will be
// discarded downstream (`save_events_batch` skips rows with no session_id).
//
// WHY THE COUNT MATTERS
// That discard used to be completely silent: the event was not persisted, not
// counted as dropped, and not counted as persisted (`incr_persisted` only fires
// for a Some(rowid)). Anything arriving before session start, after session end,
// or during a session-state gap vanished with zero telemetry. That is bad on its
// own, and worse next to sequence-gap detection: a gap detector would see the
// hole and blame the transport for something the session lifecycle did.
fn assign_session_if_active(
    event: &mut RecallEvent,
    session: &Arc<Mutex<SessionState>>,
    metrics: &Arc<BridgeMetrics>,
) -> bool {
    let session_state = session.lock().expect("Session state lock failed");
    event.session_id = session_state.active_session_id();

    match &event.session_id {
        Some(session_id) => {
            if VERBOSE_UDP_LOGGING {
                println!(
                    "EVENT ASSIGNED TO SESSION -> event_type: {}, session_id: {}",
                    event.event_type, session_id
                );
            }
            true
        }
        None => {
            metrics.incr_session_discarded();
            if VERBOSE_UDP_LOGGING {
                println!(
                    "EVENT DISCARDED (no active session) -> event_type: {}",
                    event.event_type
                );
            }
            false
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

        // One lock and one IPC hop for the whole batch, not one per event.
        //
        // This loop used to clone, lock, JSON-serialize and emit PER EVENT,
        // immediately after save_events_batch had carefully done the opposite for
        // the database. A 20,000-event burst meant 20,000 crossings into the
        // webview. The frontend only debounces and reloads from SQLite anyway —
        // it needs to know THAT something happened, not receive each event — so
        // an array costs it nothing.
        push_events(&events, &batch);

        if let Err(e) = app_handle.emit("recall-events", &batch) {
            eprintln!("Failed to emit recall-events: {}", e);
            metrics.set_last_error(format!("emit failed: {}", e));
        } else {
            for _ in &batch {
                metrics.incr_emitted();
            }
        }
    }

    eprintln!("Recall Studio persistence worker stopped (channel closed)");
}

// Per-device sequence tracking — the only way to see loss upstream of us.
//
// Every counter in metrics.rs describes packets we RECEIVED. If the kernel
// discards a datagram because the socket buffer overflowed, or the sender never
// got it out, nothing here fires: the event dies before `packets_received`
// increments. That is the blind spot that let the diagnostics panel report
// "0 dropped" during a measured 80% loss. The bridge already stamps a monotonic
// `sequence` per `device_id` on every event (recall_m4l_bridge.js `emit`) and the
// app has always thrown it away. Gaps in that sequence ARE the loss, exactly.
//
// Per device_id, not global: the bridge's counter restarts at 1 whenever the M4L
// device is reloaded, and two devices would interleave. A global counter would
// read a device reload as catastrophic loss.
//
// Lives on the receive thread and nowhere else, so it needs no lock.
#[derive(Default)]
struct SequenceTracker {
    last_seen: HashMap<String, u64>,
}

impl SequenceTracker {
    // Call for EVERY packet carrying a sequence, including heartbeats. The bridge
    // stamps heartbeats through the same `emit` path, so skipping them would read
    // each one as a hole.
    fn observe(&mut self, json: &Value, metrics: &Arc<BridgeMetrics>) {
        let bridge = match json.get("payload").and_then(|p| p.get("_bridge")) {
            Some(bridge) => bridge,
            None => return,
        };
        let device_id = match bridge.get("device_id").and_then(Value::as_str) {
            Some(id) => id,
            None => return,
        };
        let sequence = match bridge.get("sequence").and_then(Value::as_u64) {
            Some(seq) => seq,
            None => return,
        };

        if let Some(&last) = self.last_seen.get(device_id) {
            if sequence > last + 1 {
                let missing = sequence - last - 1;
                metrics.add_sequence_gaps(missing);
                eprintln!(
                    "Recall Studio: {} event(s) never arrived from bridge {} (sequence {} -> {})",
                    missing, device_id, last, sequence
                );
            }
            // sequence <= last means the device reloaded (its counter restarts at
            // 1) or, in theory, a duplicate. Not a gap either way. Loopback UDP
            // does not reorder in practice — there is no wire to reorder on — so
            // we follow the counter down rather than treating a reload as loss.
        }

        self.last_seen.insert(device_id.to_string(), sequence);
    }
}

// Bind the listener with a receive buffer sized for the snapshot burst.
//
// Two things std::net::UdpSocket cannot do, both of which cost us packets:
//   1. Set SO_RCVBUF at all — there is no setter, so we were silently running on
//      the OS default (~64KB on Windows), which is where the measured 80% burst
//      loss happened.
//   2. Report what the OS actually applied. Windows clamps large requests
//      without telling you, so we read it back with getsockopt and log both
//      numbers rather than assuming the request was honoured.
//
// Failures degrade rather than panic: if the buffer cannot be sized we still
// bind and capture, just with less headroom, and the reason is recorded in
// metrics. Only a bind failure is fatal to this thread, and the caller reports
// it instead of dying.
fn bind_listener_socket(metrics: &Arc<BridgeMetrics>) -> Result<UdpSocket, String> {
    let addr: SocketAddr = "127.0.0.1:9000"
        .parse()
        .map_err(|error| format!("Invalid listener address: {}", error))?;

    let socket = Socket::new(Domain::IPV4, Type::DGRAM, Some(Protocol::UDP))
        .map_err(|error| format!("Failed to create UDP socket: {}", error))?;

    // Best-effort: a smaller buffer still captures, it just has less burst
    // headroom. Not worth refusing to start over.
    if let Err(error) = socket.set_recv_buffer_size(RECV_SOCKET_BUFFER_BYTES) {
        let message = format!(
            "Could not set receive buffer to {} bytes ({}); running on the OS default. \
             Burst capture (project-load snapshots) may lose events.",
            RECV_SOCKET_BUFFER_BYTES, error
        );
        eprintln!("Recall Studio: {}", message);
        metrics.set_last_error(message);
    }

    socket
        .bind(&addr.into())
        .map_err(|error| format!("Failed to bind 127.0.0.1:9000 ({}). Another Recall Studio instance may already be running.", error))?;

    // Read back what the OS actually gave us. Linux reports double the requested
    // value (it counts bookkeeping overhead); Windows clamps silently. Either
    // way, log the applied size so a field report says what the buffer really
    // was rather than what we asked for.
    match socket.recv_buffer_size() {
        Ok(applied) => {
            println!(
                "Recall Studio UDP listener running on 127.0.0.1:9000 (recv buffer: requested {} bytes, applied {} bytes)",
                RECV_SOCKET_BUFFER_BYTES, applied
            );
            if applied < RECV_SOCKET_BUFFER_BYTES {
                let message = format!(
                    "OS clamped the receive buffer to {} bytes (requested {}). Burst headroom is lower than intended.",
                    applied, RECV_SOCKET_BUFFER_BYTES
                );
                eprintln!("Recall Studio: {}", message);
                metrics.set_last_error(message);
            }
        }
        Err(error) => {
            println!("Recall Studio UDP listener running on 127.0.0.1:9000 (recv buffer size unreadable: {})", error);
        }
    }

    Ok(socket.into())
}

// Enqueue policy implementing graceful overload. NEVER blocks: this runs on the
// only thread reading the socket, so blocking here stops the kernel buffer being
// drained and destroys packets we have not even looked at yet.
//
// WHY THIS NO LONGER BLOCKS (measured 2026-07-15)
// The previous version blocked on `sender.send` for Critical/Important events,
// commented "guarantees no creative data loss". It guaranteed the opposite. The
// call site is the receive loop, so blocking to protect ONE event stops draining
// the socket, the kernel buffer fills, and the OS then discards whatever arrives
// next — indiscriminately, FIFO, priority-blind, and uncounted, because those
// packets die before `classify_priority` ever sees them. It traded a counted
// drop of one low-priority event for an uncounted drop of arbitrary ones.
//
// Proof, at burst 100,000 with the 8MB buffer from E2: loss did not begin at the
// buffer boundary (~28,000). It began at 7,904 — roughly the 4,096 queue filling
// plus what the worker had drained — and then ran in ONE unbroken block to the
// end. That is the signature of a stalled reader, not an overflowing buffer. The
// blocking branch had never executed under test before (the documented burst of
// 500 cannot fill a 4,096 queue), so this pathology shipped unmeasured.
//
// Dropping and counting is strictly better: the loss is bounded, visible in
// metrics, and the priority scheme still decides WHICH event is sacrificed —
// which is only possible while we are still reading the socket.
fn enqueue_event(
    sender: &SyncSender<RecallEvent>,
    event: RecallEvent,
    metrics: &Arc<BridgeMetrics>,
) {
    let priority = classify_priority(&event.event_type);

    match sender.try_send(event) {
        Ok(()) => metrics.on_enqueue(),
        Err(TrySendError::Full(event)) => {
            // Queue full. Drop and count — never block the receive loop.
            metrics.incr_dropped();
            if priority == EventPriority::Coalescible {
                if VERBOSE_UDP_LOGGING {
                    println!("QUEUE FULL -> dropped coalescible {}", event.event_type);
                }
            } else {
                // A protected event was lost. This is the bar PRD §8 cares about,
                // so make it loud rather than silent: if this fires in the field,
                // the worker cannot keep up and the queue or the drain needs work.
                metrics.incr_protected_dropped();
                metrics.set_last_error(format!(
                    "queue full — dropped protected event {} ({:?}). The persistence worker is not draining fast enough.",
                    event.event_type, priority
                ));
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

    // TCP receive loop, running ALONGSIDE the UDP one below.
    //
    // WHY BOTH: UDP caps a datagram at 65,507 bytes, and a whole-set snapshot of
    // a large project — several plugins, hundreds of parameters each — exceeds
    // that and is dropped whole with no error the producer can see. TCP has no
    // size limit and guarantees delivery. The Max for Live bridge still speaks
    // UDP, so removing it would break the working capture path; the two
    // transports feed the SAME process_packet, so nothing downstream knows or
    // cares which one an event arrived on.
    {
        let state = state.clone();
        let session = session.clone();
        let storage = storage.clone();
        let events = events.clone();
        let sender = sender.clone();
        let metrics = metrics.clone();

        thread::spawn(move || {
            run_tcp_listener(state, session, storage, events, sender, metrics);
        });
    }

    // UDP receive loop — parse, normalize, classify, enqueue. No SQLite, no emit.
    thread::spawn(move || {
        let socket = match bind_listener_socket(&metrics) {
            Ok(socket) => socket,
            Err(error) => {
                // Never panic here. This thread dying takes capture with it and
                // leaves the app looking perfectly healthy while recording
                // nothing — the producer would finish a session and find it
                // empty, with no error anywhere. Report it and stop.
                eprintln!("Recall Studio UDP listener FAILED TO START -> {}", error);
                metrics.set_last_error(error);
                return;
            }
        };

        let mut buffer = [0u8; RECV_BUFFER_BYTES];
        let mut sequence_tracker = SequenceTracker::default();

        loop {
            match socket.recv_from(&mut buffer) {
                Ok((size, addr)) => {
                    metrics.incr_packets_received();

                    // Isolate every packet. A panic in here — a poisoned lock, a
                    // shape we never anticipated from some plugin — would
                    // otherwise kill this thread, and a dead receive thread is
                    // the worst failure this app has: the window stays open, the
                    // UI stays responsive, and capture is silently over until
                    // restart. The producer finishes a four-hour session and
                    // finds nothing recorded, with no error anywhere.
                    //
                    // AssertUnwindSafe is honest here rather than a workaround:
                    // the shared state behind these Arcs is either atomic
                    // (metrics) or Mutex-guarded, and a panic mid-packet can at
                    // worst poison a lock — which is the thing we are catching.
                    // Losing one packet's worth of work beats losing the session.
                    let outcome = catch_unwind(AssertUnwindSafe(|| {
                        process_packet(
                            &buffer[..size],
                            addr,
                            &mut sequence_tracker,
                            &state,
                            &session,
                            &storage,
                            &events,
                            &sender,
                            &metrics,
                        )
                    }));

                    if outcome.is_err() {
                        metrics.incr_panics_recovered();
                        metrics.set_last_error(
                            "panicked while processing a packet — skipped it and kept capturing",
                        );
                        eprintln!(
                            "Recall Studio: PANIC while processing a UDP packet. Skipped it; \
                             capture continues. This should never happen — please report it."
                        );
                    }
                }
                Err(error) => {
                    // WSAEMSGSIZE (Windows 10040) / EMSGSIZE: the datagram was
                    // bigger than RECV_BUFFER_BYTES.
                    //
                    // Windows does NOT truncate — it rejects the whole datagram
                    // and returns an error, so this lands here rather than in the
                    // Ok branch. That matters, because until now this branch
                    // counted NOTHING: incr_packets_received lives in the Ok arm,
                    // incr_malformed never fired, and set_last_error is a single
                    // overwritten slot. An oversized packet vanished from every
                    // counter in the app.
                    //
                    // In practice the bridge caps events at MAX_EVENT_BYTES
                    // (8192) and drops anything larger itself, so a legal packet
                    // never reaches this path. It is here for the day that cap
                    // fails — and on that day the loss should be visible, not
                    // silent.
                    let oversized = error.raw_os_error() == Some(10040) // WSAEMSGSIZE
                        || error.kind() == std::io::ErrorKind::InvalidInput;

                    if oversized {
                        metrics.incr_oversized();
                        metrics.set_last_error(format!(
                            "a packet exceeded the {}-byte receive buffer and was rejected whole by the OS ({}). The bridge should have capped it at 8192 bytes.",
                            RECV_BUFFER_BYTES, error
                        ));
                        eprintln!(
                            "Recall Studio: OVERSIZED packet rejected (> {} bytes) -> {}",
                            RECV_BUFFER_BYTES, error
                        );
                    } else {
                        metrics.set_last_error(format!("recv: {}", error));
                        eprintln!("UDP listener error: {}", error);
                    }
                }
            }
        }
    });
}

/// Outcome of reading one newline-delimited line with a size ceiling.
enum BoundedLine {
    /// A complete line within the ceiling, newline stripped.
    Line(Vec<u8>),
    /// A line exceeded `max_bytes` before a newline was found. The bytes seen
    /// so far — up to and including the eventual newline — have already been
    /// discarded; the stream is resynchronized and ready for the next line.
    Oversized,
    /// The connection closed with no more data.
    Eof,
}

/// Read one line up to `max_bytes`, without `BufReader::lines()`'s unbounded
/// growth: a client that never sends a newline would otherwise grow that
/// buffer without limit. Reads via `fill_buf`/`consume` so the ceiling is
/// enforced across the read incrementally, not only after a whole line (however
/// large) has already been buffered.
fn read_bounded_line<R: BufRead>(reader: &mut R, max_bytes: usize) -> std::io::Result<BoundedLine> {
    let mut buf: Vec<u8> = Vec::new();
    let mut oversized = false;

    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            // EOF: whatever is buffered (if anything) is an incomplete final
            // line with no terminating newline — not a real event, drop it.
            return Ok(BoundedLine::Eof);
        }

        if let Some(pos) = available.iter().position(|&b| b == b'\n') {
            if !oversized && buf.len() + pos <= max_bytes {
                buf.extend_from_slice(&available[..pos]);
            } else {
                oversized = true;
            }
            reader.consume(pos + 1);
            return Ok(if oversized {
                BoundedLine::Oversized
            } else {
                BoundedLine::Line(buf)
            });
        }

        // No newline in this chunk yet. Keep consuming to make progress and
        // find the eventual newline, but stop copying into `buf` once the
        // ceiling is crossed so memory use stays bounded regardless of how
        // long the oversized line turns out to be.
        if !oversized {
            if buf.len() + available.len() > max_bytes {
                oversized = true;
            } else {
                buf.extend_from_slice(available);
            }
        }
        let consumed = available.len();
        reader.consume(consumed);
    }
}

// Everything done with one datagram. Split out of the receive loop so it can be
// wrapped in catch_unwind — a panic here costs one packet, not the session.
// Accept control-surface connections and read newline-delimited JSON.
//
// FRAMING: one JSON event per line. TCP is a stream with no message boundaries,
// so something has to mark where an event ends. Newlines are the cheapest option
// that both sides can implement without a length-prefix protocol, and they are
// safe here because serialized JSON never contains a raw newline — serde and
// Python's json module both escape them inside strings.
//
// Connections are handled one at a time on purpose: there is exactly one capture
// client, and accepting concurrently would add threads for a case that does not
// exist. A dropped connection simply loops back to accept, so restarting Live
// reconnects without restarting the app.
fn run_tcp_listener(
    state: Arc<Mutex<ConnectionState>>,
    session: Arc<Mutex<SessionState>>,
    storage: Arc<Mutex<StorageState>>,
    events: Arc<Mutex<Vec<RecallEvent>>>,
    sender: SyncSender<RecallEvent>,
    metrics: Arc<BridgeMetrics>,
) {
    let listener = match TcpListener::bind(TCP_LISTEN_ADDR) {
        Ok(listener) => listener,
        Err(error) => {
            // Same reasoning as the UDP bind failure: never panic. A dead
            // capture thread with a healthy-looking window is this app's worst
            // failure — the producer records nothing and finds out hours later.
            eprintln!(
                "Recall Studio TCP listener FAILED TO START on {} -> {}",
                TCP_LISTEN_ADDR, error
            );
            metrics.set_last_error(format!("TCP listener failed to bind: {}", error));
            return;
        }
    };

    println!("Recall Studio TCP listener running on {}", TCP_LISTEN_ADDR);

    for incoming in listener.incoming() {
        let stream = match incoming {
            Ok(stream) => stream,
            Err(error) => {
                metrics.set_last_error(format!("TCP accept failed: {}", error));
                continue;
            }
        };

        let addr = stream
            .peer_addr()
            .unwrap_or_else(|_| SocketAddr::from(([127, 0, 0, 1], 0)));

        println!("Recall Studio: capture client connected from {}", addr);

        let mut reader = BufReader::new(stream);
        let mut sequence_tracker = SequenceTracker::default();

        loop {
            let line = match read_bounded_line(&mut reader, MAX_TCP_LINE_BYTES) {
                Ok(BoundedLine::Eof) => break,
                Ok(BoundedLine::Oversized) => {
                    metrics.incr_oversized();
                    metrics.set_last_error(format!(
                        "Dropped a TCP line over {} bytes with no newline in range — capture kept running",
                        MAX_TCP_LINE_BYTES
                    ));
                    continue;
                }
                Ok(BoundedLine::Line(bytes)) => bytes,
                Err(error) => {
                    // Client vanished mid-stream (Live quit, script reloaded).
                    // Expected, not exceptional — go back to accepting.
                    println!("Recall Studio: capture client read ended ({})", error);
                    break;
                }
            };

            if line.iter().all(|b| b.is_ascii_whitespace()) {
                continue;
            }

            metrics.incr_packets_received();

            // Per-event panic isolation, for the same reason the UDP loop has it:
            // one unanticipated payload shape must not end capture for the
            // session.
            let outcome = catch_unwind(AssertUnwindSafe(|| {
                process_packet(
                    &line,
                    addr,
                    &mut sequence_tracker,
                    &state,
                    &session,
                    &storage,
                    &events,
                    &sender,
                    &metrics,
                )
            }));

            if outcome.is_err() {
                metrics.incr_panics_recovered();
                metrics.set_last_error(
                    "panicked while processing a TCP event — skipped it and kept capturing",
                );
            }
        }

        println!("Recall Studio: capture client disconnected ({})", addr);
    }
}

fn process_packet(
    bytes: &[u8],
    addr: SocketAddr,
    sequence_tracker: &mut SequenceTracker,
    state: &Arc<Mutex<ConnectionState>>,
    session: &Arc<Mutex<SessionState>>,
    storage: &Arc<Mutex<StorageState>>,
    events: &Arc<Mutex<Vec<RecallEvent>>>,
    sender: &SyncSender<RecallEvent>,
    metrics: &Arc<BridgeMetrics>,
) {
    if VERBOSE_UDP_LOGGING {
        println!("================ UDP PACKET RECEIVED ================");
        println!("UDP from: {}", addr);
        println!("UDP bytes length: {}", bytes.len());
    }

    let message = match extract_json_object(bytes) {
        Ok(message) => message,
        Err(error) => {
            metrics.incr_malformed();
            metrics.set_last_error(error.clone());
            eprintln!("FAILED TO EXTRACT JSON FROM UDP MESSAGE -> {}", error);
            return;
        }
    };

    let raw_json = match serde_json::from_str::<Value>(&message) {
        Ok(value) => value,
        Err(error) => {
            metrics.incr_malformed();
            metrics.set_last_error(format!("json parse: {}", error));
            eprintln!("FAILED TO PARSE UDP MESSAGE AS JSON -> {}", error);
            return;
        }
    };

    // Sequence-gap check runs on the RAW json, before normalize_udp_json flattens
    // `payload` into a JSON string — after that, payload._bridge is unreachable
    // without re-parsing. Runs on every packet that carries a sequence,
    // heartbeats included (the bridge stamps them through the same emit path),
    // and before any early return below.
    sequence_tracker.observe(&raw_json, metrics);

    let normalized_json = match normalize_udp_json(raw_json) {
        Ok(value) => value,
        Err(error) => {
            metrics.incr_malformed();
            metrics.set_last_error(error.clone());
            eprintln!("FAILED TO NORMALIZE UDP JSON -> {}", error);
            return;
        }
    };
    log_events(&normalized_json);
    // Heartbeats are health-only: update connection state and stop here. They are
    // never queued, persisted, or emitted.
    update_connection_if_heartbeat(&normalized_json, state);
    // Track the open `.als` so opening a project can resume the take for the live
    // version. The bridge stamps project_path on every heartbeat, so do this
    // before heartbeats are dropped below.
    update_open_file(&normalized_json, state);
    // Switch takes if Ableton has moved to a different project. Runs BEFORE
    // assignment so this event lands on the take for the file that is open now.
    rotate_session_if_project_changed(state, session, storage, events, metrics);
    let is_heartbeat =
        normalized_json.get("event_type").and_then(Value::as_str) == Some("heartbeat");
    if is_heartbeat {
        return;
    }

    match serde_json::from_value::<RecallEvent>(normalized_json) {
        Ok(mut event) => {
            // No active session means storage will discard this row anyway —
            // counted inside, so don't spend queue slots and a batch insert on an
            // event that cannot land. storage.rs keeps its own guard as a backstop.
            if assign_session_if_active(&mut event, session, metrics) {
                enqueue_event(sender, event, metrics);
            }
        }
        Err(error) => {
            metrics.incr_malformed();
            eprintln!("FAILED TO PARSE NORMALIZED JSON AS RecallEvent -> {}", error);
        }
    }
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
    use std::io::Cursor;

    /// A raw bridge packet, shaped as it arrives on the wire: `payload` is still
    /// a nested object here, which is the whole point of the sequence tests.
    fn raw_packet(device_id: &str, sequence: u64) -> Value {
        json!({
            "protocol": "recall.v2",
            "event_type": "device_added",
            "payload": {
                "_bridge": { "device_id": device_id, "bridge_version": "0.17.0", "sequence": sequence }
            }
        })
    }

    #[test]
    fn contiguous_sequences_report_no_gaps() {
        let metrics = BridgeMetrics::new();
        let mut tracker = SequenceTracker::default();
        for seq in 1..=100 {
            tracker.observe(&raw_packet("dev-a", seq), &metrics);
        }
        assert_eq!(metrics.snapshot().sequence_gaps, 0);
    }

    #[test]
    fn a_hole_in_the_sequence_is_counted_exactly() {
        let metrics = BridgeMetrics::new();
        let mut tracker = SequenceTracker::default();
        tracker.observe(&raw_packet("dev-a", 1), &metrics);
        // 2..=10 never arrive — nine events lost.
        tracker.observe(&raw_packet("dev-a", 11), &metrics);
        assert_eq!(metrics.snapshot().sequence_gaps, 9);
    }

    #[test]
    fn sequences_are_tracked_per_device_not_globally() {
        // Two bridges interleaving must not read as loss. A global counter would
        // see 1,1,2,2 as chaos; per-device it is two clean streams.
        let metrics = BridgeMetrics::new();
        let mut tracker = SequenceTracker::default();
        tracker.observe(&raw_packet("dev-a", 1), &metrics);
        tracker.observe(&raw_packet("dev-b", 1), &metrics);
        tracker.observe(&raw_packet("dev-a", 2), &metrics);
        tracker.observe(&raw_packet("dev-b", 2), &metrics);
        assert_eq!(metrics.snapshot().sequence_gaps, 0);
    }

    #[test]
    fn a_device_reload_resets_the_counter_and_is_not_loss() {
        // The bridge's sequence restarts at 1 when the M4L device is reloaded.
        // A naive detector reads that as ~1000 events lost.
        let metrics = BridgeMetrics::new();
        let mut tracker = SequenceTracker::default();
        tracker.observe(&raw_packet("dev-a", 1000), &metrics);
        tracker.observe(&raw_packet("dev-a", 1), &metrics);
        tracker.observe(&raw_packet("dev-a", 2), &metrics);
        assert_eq!(metrics.snapshot().sequence_gaps, 0);
    }

    #[test]
    fn packets_without_a_bridge_stamp_are_ignored() {
        let metrics = BridgeMetrics::new();
        let mut tracker = SequenceTracker::default();
        tracker.observe(&json!({ "event_type": "device_added" }), &metrics);
        tracker.observe(&json!({ "payload": { "other": 1 } }), &metrics);
        assert_eq!(metrics.snapshot().sequence_gaps, 0);
    }

    #[test]
    fn tracker_reads_the_raw_packet_not_the_normalized_one() {
        // REGRESSION: normalize_udp_json flattens `payload` into a JSON *string*,
        // so payload._bridge is unreachable afterwards and every lookup silently
        // returns None. The first version of this tracker ran post-normalize and
        // reported zero gaps while 71,358 packets were provably lost. Observe the
        // raw packet, or don't observe at all.
        let metrics = BridgeMetrics::new();
        let mut tracker = SequenceTracker::default();

        let normalized = Value::Object(normalized(raw_packet("dev-a", 1)));
        assert!(
            normalized.get("payload").unwrap().is_string(),
            "normalize_udp_json must still flatten payload — if this fails, the \
             tracker's placement in the recv loop should be re-examined"
        );

        // Post-normalize: invisible. Pre-normalize: counted.
        tracker.observe(&normalized, &metrics);
        tracker.observe(&Value::Object(normalized_map_for(("dev-a", 50))), &metrics);
        assert_eq!(
            metrics.snapshot().sequence_gaps,
            0,
            "a flattened payload carries no observable sequence, so nothing is counted"
        );

        let mut raw_tracker = SequenceTracker::default();
        let raw_metrics = BridgeMetrics::new();
        raw_tracker.observe(&raw_packet("dev-a", 1), &raw_metrics);
        raw_tracker.observe(&raw_packet("dev-a", 50), &raw_metrics);
        assert_eq!(raw_metrics.snapshot().sequence_gaps, 48);
    }

    fn normalized_map_for(spec: (&str, u64)) -> Map<String, Value> {
        normalized(raw_packet(spec.0, spec.1))
    }

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
    fn normalize_passes_track_id_through() {
        // track_id is Live's stable per-track pointer — distinct from track_name,
        // which two different tracks can share (e.g. both auto-named "Serum 2").
        let obj = normalized(json!({
            "event_type": "parameter_changed",
            "track_name": "Serum 2",
            "track_id": "140312043829216"
        }));
        assert_eq!(obj["track_name"], json!("Serum 2"));
        assert_eq!(obj["track_id"], json!("140312043829216"));
    }

    #[test]
    fn normalize_sets_absent_canonical_fields_to_null() {
        // The frontend relies on a flat, predictable shape — every canonical field
        // is always present, even when null, so it never has to dig through payload.
        let obj = normalized(json!({ "event_type": "tempo_changed", "bpm": 124.0 }));
        assert_eq!(obj["bpm"], json!(124.0));
        assert!(obj["track_name"].is_null());
        assert!(obj["track_id"].is_null());
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

    // ── read_bounded_line ────────────────────────────────────────────────────

    #[test]
    fn bounded_line_reads_a_normal_line() {
        let mut reader = BufReader::new(Cursor::new(b"hello world\n".as_slice()));
        match read_bounded_line(&mut reader, 32_768).unwrap() {
            BoundedLine::Line(bytes) => assert_eq!(bytes, b"hello world"),
            _ => panic!("expected a normal Line"),
        }
    }

    #[test]
    fn bounded_line_reports_eof_on_a_closed_stream() {
        let mut reader = BufReader::new(Cursor::new(b"".as_slice()));
        assert!(matches!(
            read_bounded_line(&mut reader, 32_768).unwrap(),
            BoundedLine::Eof
        ));
    }

    #[test]
    fn bounded_line_drops_a_line_past_the_ceiling_without_unbounded_growth() {
        // A client that never sends a newline (or sends one far past the
        // ceiling) must not grow the buffer without limit — this is the exact
        // failure BufReader::lines() has. 10x the ceiling, no newline at all.
        let oversized = vec![b'x'; 10_000];
        let mut reader = BufReader::new(Cursor::new(oversized.as_slice()));
        // No newline present, so this hits EOF after discarding everything —
        // proving the read completed (didn't hang or allocate 10,000 bytes
        // into the returned line) rather than that it returns Oversized here.
        let outcome = read_bounded_line(&mut reader, 100).unwrap();
        assert!(matches!(outcome, BoundedLine::Eof));
    }

    #[test]
    fn bounded_line_flags_oversized_and_resyncs_to_the_next_line() {
        // One line over the ceiling, immediately followed by a normal one.
        // The oversized line's bytes must be fully discarded (not returned,
        // not leaked into the next line) and the stream must resync cleanly.
        let mut input = vec![b'x'; 200];
        input.push(b'\n');
        input.extend_from_slice(b"ok\n");
        let mut reader = BufReader::new(Cursor::new(input.as_slice()));

        assert!(matches!(
            read_bounded_line(&mut reader, 100).unwrap(),
            BoundedLine::Oversized
        ));

        match read_bounded_line(&mut reader, 100).unwrap() {
            BoundedLine::Line(bytes) => assert_eq!(bytes, b"ok"),
            _ => panic!("expected the next line to resync cleanly after the oversized one"),
        }
    }

    #[test]
    fn bounded_line_boundary_case_exactly_at_the_ceiling_is_not_oversized() {
        let mut input = vec![b'x'; 100];
        input.push(b'\n');
        let mut reader = BufReader::new(Cursor::new(input.as_slice()));
        match read_bounded_line(&mut reader, 100).unwrap() {
            BoundedLine::Line(bytes) => assert_eq!(bytes.len(), 100),
            _ => panic!("a line exactly at the ceiling must not be flagged oversized"),
        }
    }

    // ── Connection liveness ────────────────────────────────────────────────
    //
    // REGRESSION GUARD. The Python control surface shipped without ever emitting
    // a `heartbeat`, while this file has always derived `connected` from nothing
    // else — so `connected` was permanently false and the version chip never
    // rendered, for every user, for the whole life of the TCP capture path.
    // Nothing caught it because no test crossed the language boundary: the Rust
    // side was correct in isolation and the Python side was correct in
    // isolation, and the CONTRACT between them was what broke.
    //
    // These tests pin that contract using the exact wire shape
    // remote-script/Recall/__init__.py::_send_heartbeat_if_due now sends. If the
    // script's payload shape or event name drifts again, these fail.

    fn fresh_connection_state() -> Arc<Mutex<ConnectionState>> {
        Arc::new(Mutex::new(ConnectionState {
            last_heartbeat_ms: None,
            last_message: None,
            bridge_version: None,
            open_als_path: None,
            session_als_path: None,
        }))
    }

    /// Exactly what the control surface puts on the wire: `payload` is a nested
    /// OBJECT (not a pre-stringified one), which normalize flattens on the way in.
    fn control_surface_heartbeat() -> Value {
        json!({
            "protocol": "recall.v2",
            "source": "control_surface",
            "event_type": "heartbeat",
            "timestamp_ms": 1_700_000_000_000u64,
            "payload": { "bridge_version": "0.2.0" }
        })
    }

    #[test]
    fn a_control_surface_heartbeat_marks_the_bridge_connected() {
        let state = fresh_connection_state();
        let packet = Value::Object(normalized(control_surface_heartbeat()));

        update_connection_if_heartbeat(&packet, &state);

        let status = get_status(Arc::clone(&state));
        assert!(
            status.connected,
            "a heartbeat that just arrived must read as connected"
        );
        assert!(status.last_heartbeat_ms.is_some());
    }

    #[test]
    fn the_bridge_version_is_read_out_of_the_heartbeat_payload() {
        // The script sends `payload` as an object; normalize stringifies it, and
        // update_connection_if_heartbeat parses it back. This asserts that whole
        // round trip, which is where the version chip was being lost.
        let state = fresh_connection_state();
        let packet = Value::Object(normalized(control_surface_heartbeat()));

        update_connection_if_heartbeat(&packet, &state);

        assert_eq!(
            get_status(state).bridge_version.as_deref(),
            Some("0.2.0"),
            "bridge_version must survive the object -> string -> object round trip"
        );
    }

    #[test]
    fn a_non_heartbeat_event_does_not_mark_the_bridge_connected() {
        // The bug in reverse: the control surface emits plenty of other events,
        // and none of them may stand in for a heartbeat. If this ever passes by
        // accident, liveness has silently become "did anything happen recently",
        // which reads as disconnected whenever Live sits idle — the exact moment
        // the setup screen needs the truth.
        let state = fresh_connection_state();
        let packet = Value::Object(normalized(json!({
            "protocol": "recall.v2",
            "source": "control_surface",
            "event_type": "tempo_changed",
            "payload": { "bpm": 128.0 }
        })));

        update_connection_if_heartbeat(&packet, &state);

        let status = get_status(state);
        assert!(!status.connected);
        assert!(status.last_heartbeat_ms.is_none());
    }

    #[test]
    fn a_stale_heartbeat_reads_as_disconnected() {
        // 5s window in get_status. A bridge that stopped talking must stop
        // claiming to be connected, or the setup screen would confirm success
        // for a script Live has already unloaded.
        let state = fresh_connection_state();
        {
            let mut connection = state.lock().unwrap();
            connection.last_heartbeat_ms = Some(now_ms().saturating_sub(6_000));
        }

        assert!(!get_status(state).connected);
    }

    #[test]
    fn a_heartbeat_without_a_version_still_marks_connected() {
        // Liveness and version are independent: an older script that heartbeats
        // without a version must still register as connected rather than being
        // treated as absent.
        let state = fresh_connection_state();
        let packet = Value::Object(normalized(json!({
            "protocol": "recall.v2",
            "source": "control_surface",
            "event_type": "heartbeat",
            "payload": {}
        })));

        update_connection_if_heartbeat(&packet, &state);

        let status = get_status(state);
        assert!(status.connected);
        assert_eq!(status.bridge_version, None);
    }
}
