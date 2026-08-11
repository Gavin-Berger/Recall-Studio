mod event_catalog;
mod install;
mod metrics;
mod organizer;
mod planner;
mod protocol;
mod schema_projection;
mod session;
mod storage;
mod udp_listener;

use metrics::{BridgeMetrics, BridgeMetricsSnapshot};
use planner::PlannerTask;
use protocol::RecallEvent;
use schema_projection::{
    CreativeMoment, CreativeMomentTarget, NoteEdit, ParameterChange, ProjectSchema,
};
use session::{
    ProjectFolderMetadata, SavedProject, SavedSession, SavedSessionMetadata, SessionState,
    SessionStatus,
};
use std::io::{Read, Seek, Write};
use std::sync::{Arc, Mutex};
use storage::{initialize_database, SessionCuration, StorageState, StorageStatus};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager, State,
};
use udp_listener::{get_status, start_udp_listener, ConnectionState, ConnectionStatus};

struct AppState {
    connection: Arc<Mutex<ConnectionState>>,
    recent_events: Arc<Mutex<Vec<RecallEvent>>>,
    session: Arc<Mutex<SessionState>>,
    storage: Arc<Mutex<StorageState>>,
    metrics: Arc<BridgeMetrics>,
}

struct PlannerTaskFields {
    title: String,
    due_date: String,
    due_time: Option<String>,
    task_type: String,
    project_id: Option<String>,
    notes: Option<String>,
}

// Showing the window belongs in one small helper because both a tray click and
// the "Open Recall" menu item should bring back the exact same app window.
fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        let _ = window.emit("recall://window-visibility", true);
    }
}

fn optional_trimmed(value: Option<String>, limit: usize, label: &str) -> Result<Option<String>, String> {
    let Some(value) = value else {
        return Ok(None);
    };
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    if trimmed.len() > limit {
        return Err(format!("{label} is too long."));
    }
    Ok(Some(trimmed.to_string()))
}

fn valid_planner_date(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' {
        return false;
    }
    let year = std::str::from_utf8(&bytes[0..4]).ok().and_then(|part| part.parse::<u32>().ok());
    let month = std::str::from_utf8(&bytes[5..7]).ok().and_then(|part| part.parse::<u32>().ok());
    let day = std::str::from_utf8(&bytes[8..10]).ok().and_then(|part| part.parse::<u32>().ok());
    let (Some(year), Some(month), Some(day)) = (year, month, day) else {
        return false;
    };
    if year == 0 || !(1..=12).contains(&month) {
        return false;
    }
    let days_in_month = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if year % 400 == 0 || (year % 4 == 0 && year % 100 != 0) => 29,
        2 => 28,
        _ => return false,
    };
    (1..=days_in_month).contains(&day)
}

fn normalize_planner_task(
    title: String,
    due_date: String,
    due_time: Option<String>,
    task_type: String,
    project_id: Option<String>,
    notes: Option<String>,
) -> Result<PlannerTaskFields, String> {
    let title = title.trim();
    if title.is_empty() {
        return Err("Give the task a name.".into());
    }
    if title.len() > 160 {
        return Err("Task names must be 160 characters or fewer.".into());
    }
    if !valid_planner_date(&due_date) {
        return Err("Choose a valid due date.".into());
    }
    let due_time = optional_trimmed(due_time, 5, "Task time")?;
    if let Some(time) = &due_time {
        let bytes = time.as_bytes();
        let valid = bytes.len() == 5
            && bytes[2] == b':'
            && std::str::from_utf8(&bytes[0..2])
                .ok()
                .and_then(|part| part.parse::<u32>().ok())
                .is_some_and(|hour| hour <= 23)
            && std::str::from_utf8(&bytes[3..5])
                .ok()
                .and_then(|part| part.parse::<u32>().ok())
                .is_some_and(|minute| minute <= 59);
        if !valid {
            return Err("Choose a valid task time.".into());
        }
    }
    let task_type = task_type.trim().to_ascii_lowercase();
    if !matches!(task_type.as_str(), "artist" | "mix" | "master" | "admin") {
        return Err("Choose an artist, mix, master, or admin task type.".into());
    }
    Ok(PlannerTaskFields {
        title: title.to_string(),
        due_date,
        due_time,
        task_type,
        project_id: optional_trimmed(project_id, 128, "Project reference")?,
        notes: optional_trimmed(notes, 4000, "Task notes")?,
    })
}

/// Write a UTF-8 text document to disk. Used by the timeline's share/export so a
/// session recap can be saved as a Markdown file the producer can send anywhere.
/// The path comes from the native save dialog, so it's a location the user chose.
#[tauri::command]
fn write_text_file(path: String, contents: String) -> Result<(), String> {
    std::fs::write(&path, contents).map_err(|error| format!("Failed to write file: {}", error))
}

/// Return a producer-selected audio export as a raw IPC response. The organizer
/// persists the path and reloads bytes only when that track's player is opened.
#[tauri::command]
fn read_organizer_audio(path: String) -> Result<tauri::ipc::Response, String> {
    let source = std::path::Path::new(&path);
    let extension = source
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    const AUDIO_EXTENSIONS: &[&str] = &[
        "wav", "wave", "aif", "aiff", "flac", "mp3", "m4a", "aac", "ogg",
    ];
    if !AUDIO_EXTENSIONS.contains(&extension.as_str()) {
        return Err("That file is not a supported audio export.".into());
    }
    let bytes =
        std::fs::read(source).map_err(|error| format!("Failed to read audio export: {}", error))?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[derive(serde::Deserialize)]
struct OrganizerPreviewFile {
    #[serde(rename = "sourcePath")]
    source_path: String,
    #[serde(rename = "outputName")]
    output_name: String,
}

#[derive(serde::Deserialize)]
struct OrganizerPreviewAsset {
    #[serde(rename = "fileName")]
    file_name: String,
    bytes: Vec<u8>,
}

fn safe_preview_leaf(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 120
        && !value.contains("..")
        && !value.contains('/')
        && !value.contains('\\')
        && std::path::Path::new(value)
            .file_name()
            .map(|name| name == value)
            .unwrap_or(false)
}

enum PreviewZipSource {
    Bytes(Vec<u8>),
    File(std::path::PathBuf),
}

struct PreviewZipEntry {
    name: String,
    source: PreviewZipSource,
}

fn preview_zip_metadata(source: &PreviewZipSource) -> Result<(u32, u32), String> {
    let mut hasher = crc32fast::Hasher::new();
    let size = match source {
        PreviewZipSource::Bytes(bytes) => {
            hasher.update(bytes);
            bytes.len() as u64
        }
        PreviewZipSource::File(path) => {
            let mut file = std::fs::File::open(path)
                .map_err(|error| format!("Failed to open {}: {error}", path.display()))?;
            let mut buffer = [0_u8; 64 * 1024];
            let mut total = 0_u64;
            loop {
                let read = file
                    .read(&mut buffer)
                    .map_err(|error| format!("Failed to read {}: {error}", path.display()))?;
                if read == 0 {
                    break;
                }
                hasher.update(&buffer[..read]);
                total += read as u64;
            }
            total
        }
    };
    let size = u32::try_from(size)
        .map_err(|_| "A release asset exceeds the 4 GB portable ZIP limit.".to_string())?;
    Ok((hasher.finalize(), size))
}

fn write_preview_zip(path: &std::path::Path, entries: Vec<PreviewZipEntry>) -> Result<(), String> {
    struct CentralEntry {
        name: Vec<u8>,
        crc: u32,
        size: u32,
        offset: u32,
    }

    if entries.len() > u16::MAX as usize {
        return Err("The release contains too many files for a portable ZIP.".into());
    }
    let mut output = std::fs::File::create(path)
        .map_err(|error| format!("Failed to create release package: {error}"))?;
    let mut central = Vec::with_capacity(entries.len());

    for entry in entries {
        let name = entry.name.into_bytes();
        let name_len = u16::try_from(name.len())
            .map_err(|_| "A packaged filename is too long.".to_string())?;
        let offset = u32::try_from(
            output
                .stream_position()
                .map_err(|error| format!("Failed to build release package: {error}"))?,
        )
        .map_err(|_| "The release package exceeds the portable ZIP limit.".to_string())?;
        let (crc, size) = preview_zip_metadata(&entry.source)?;

        output
            .write_all(&0x04034b50_u32.to_le_bytes())
            .map_err(|e| e.to_string())?;
        output
            .write_all(&20_u16.to_le_bytes())
            .map_err(|e| e.to_string())?;
        output
            .write_all(&0x0800_u16.to_le_bytes())
            .map_err(|e| e.to_string())?;
        output
            .write_all(&0_u16.to_le_bytes())
            .map_err(|e| e.to_string())?;
        output
            .write_all(&0_u16.to_le_bytes())
            .map_err(|e| e.to_string())?;
        output
            .write_all(&33_u16.to_le_bytes())
            .map_err(|e| e.to_string())?;
        output
            .write_all(&crc.to_le_bytes())
            .map_err(|e| e.to_string())?;
        output
            .write_all(&size.to_le_bytes())
            .map_err(|e| e.to_string())?;
        output
            .write_all(&size.to_le_bytes())
            .map_err(|e| e.to_string())?;
        output
            .write_all(&name_len.to_le_bytes())
            .map_err(|e| e.to_string())?;
        output
            .write_all(&0_u16.to_le_bytes())
            .map_err(|e| e.to_string())?;
        output.write_all(&name).map_err(|e| e.to_string())?;
        match entry.source {
            PreviewZipSource::Bytes(bytes) => {
                output.write_all(&bytes).map_err(|e| e.to_string())?;
            }
            PreviewZipSource::File(source) => {
                let mut input = std::fs::File::open(&source)
                    .map_err(|error| format!("Failed to reopen {}: {error}", source.display()))?;
                std::io::copy(&mut input, &mut output)
                    .map_err(|error| format!("Failed to package {}: {error}", source.display()))?;
            }
        }
        central.push(CentralEntry {
            name,
            crc,
            size,
            offset,
        });
    }

    let central_offset = u32::try_from(
        output
            .stream_position()
            .map_err(|error| format!("Failed to build release package: {error}"))?,
    )
    .map_err(|_| "The release package exceeds the portable ZIP limit.".to_string())?;
    for entry in &central {
        let name_len = entry.name.len() as u16;
        output
            .write_all(&0x02014b50_u32.to_le_bytes())
            .map_err(|e| e.to_string())?;
        output
            .write_all(&20_u16.to_le_bytes())
            .map_err(|e| e.to_string())?;
        output
            .write_all(&20_u16.to_le_bytes())
            .map_err(|e| e.to_string())?;
        output
            .write_all(&0x0800_u16.to_le_bytes())
            .map_err(|e| e.to_string())?;
        output
            .write_all(&0_u16.to_le_bytes())
            .map_err(|e| e.to_string())?;
        output
            .write_all(&0_u16.to_le_bytes())
            .map_err(|e| e.to_string())?;
        output
            .write_all(&33_u16.to_le_bytes())
            .map_err(|e| e.to_string())?;
        output
            .write_all(&entry.crc.to_le_bytes())
            .map_err(|e| e.to_string())?;
        output
            .write_all(&entry.size.to_le_bytes())
            .map_err(|e| e.to_string())?;
        output
            .write_all(&entry.size.to_le_bytes())
            .map_err(|e| e.to_string())?;
        output
            .write_all(&name_len.to_le_bytes())
            .map_err(|e| e.to_string())?;
        output
            .write_all(&0_u16.to_le_bytes())
            .map_err(|e| e.to_string())?;
        output
            .write_all(&0_u16.to_le_bytes())
            .map_err(|e| e.to_string())?;
        output
            .write_all(&0_u16.to_le_bytes())
            .map_err(|e| e.to_string())?;
        output
            .write_all(&0_u16.to_le_bytes())
            .map_err(|e| e.to_string())?;
        output
            .write_all(&0_u32.to_le_bytes())
            .map_err(|e| e.to_string())?;
        output
            .write_all(&entry.offset.to_le_bytes())
            .map_err(|e| e.to_string())?;
        output.write_all(&entry.name).map_err(|e| e.to_string())?;
    }
    let central_end = u32::try_from(
        output
            .stream_position()
            .map_err(|error| format!("Failed to build release package: {error}"))?,
    )
    .map_err(|_| "The release package exceeds the portable ZIP limit.".to_string())?;
    let count = central.len() as u16;
    output
        .write_all(&0x06054b50_u32.to_le_bytes())
        .map_err(|e| e.to_string())?;
    output
        .write_all(&0_u16.to_le_bytes())
        .map_err(|e| e.to_string())?;
    output
        .write_all(&0_u16.to_le_bytes())
        .map_err(|e| e.to_string())?;
    output
        .write_all(&count.to_le_bytes())
        .map_err(|e| e.to_string())?;
    output
        .write_all(&count.to_le_bytes())
        .map_err(|e| e.to_string())?;
    output
        .write_all(&(central_end - central_offset).to_le_bytes())
        .map_err(|e| e.to_string())?;
    output
        .write_all(&central_offset.to_le_bytes())
        .map_err(|e| e.to_string())?;
    output
        .write_all(&0_u16.to_le_bytes())
        .map_err(|e| e.to_string())?;
    output
        .sync_all()
        .map_err(|e| format!("Failed to finish release package: {e}"))
}

/// Export one portable ZIP containing the listener page, comments, cover, and
/// selected final audio. The output path comes from the native save dialog.
#[tauri::command]
fn export_organizer_preview(
    output_path: String,
    html: String,
    comments: String,
    cover: Option<OrganizerPreviewAsset>,
    files: Vec<OrganizerPreviewFile>,
) -> Result<String, String> {
    let output_path = std::path::PathBuf::from(output_path);
    if !output_path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.eq_ignore_ascii_case("zip"))
        .unwrap_or(false)
    {
        return Err("The release package must be saved as a .zip file.".into());
    }
    if comments.len() > 1_000_000 {
        return Err("The comments document is unexpectedly large.".into());
    }
    let mut entries = vec![
        PreviewZipEntry {
            name: "index.html".to_string(),
            source: PreviewZipSource::Bytes(html.into_bytes()),
        },
        PreviewZipEntry {
            name: "comments.txt".to_string(),
            source: PreviewZipSource::Bytes(comments.into_bytes()),
        },
    ];

    if let Some(cover) = cover {
        if !safe_preview_leaf(&cover.file_name)
            || !matches!(
                std::path::Path::new(&cover.file_name)
                    .extension()
                    .and_then(|value| value.to_str())
                    .map(str::to_ascii_lowercase)
                    .as_deref(),
                Some("webp" | "png" | "jpg" | "jpeg")
            )
        {
            return Err("The cover filename is not safe or supported.".into());
        }
        if cover.bytes.len() > 10_000_000 {
            return Err("The cover image is unexpectedly large.".into());
        }
        entries.push(PreviewZipEntry {
            name: cover.file_name,
            source: PreviewZipSource::Bytes(cover.bytes),
        });
    }

    const AUDIO_EXTENSIONS: &[&str] = &[
        "wav", "wave", "aif", "aiff", "flac", "mp3", "m4a", "aac", "ogg",
    ];
    for file in files {
        if !safe_preview_leaf(&file.output_name) {
            return Err(format!(
                "Unsafe preview audio filename: {}",
                file.output_name
            ));
        }
        let source = std::path::Path::new(&file.source_path);
        let extension = source
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        if !source.is_file() || !AUDIO_EXTENSIONS.contains(&extension.as_str()) {
            return Err(format!(
                "Audio source is missing or unsupported: {}",
                file.source_path
            ));
        }
        entries.push(PreviewZipEntry {
            name: format!("audio/{}", file.output_name),
            source: PreviewZipSource::File(source.to_path_buf()),
        });
    }

    let parent = output_path
        .parent()
        .filter(|path| path.is_dir())
        .ok_or_else(|| "Choose an existing location for the release package.".to_string())?;
    let temp_path = parent.join(format!(
        ".{}.tmp",
        output_path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("recall-preview.zip")
    ));
    write_preview_zip(&temp_path, entries)?;
    if output_path.exists() {
        std::fs::remove_file(&output_path)
            .map_err(|error| format!("Failed to replace the existing package: {error}"))?;
    }
    std::fs::rename(&temp_path, &output_path)
        .map_err(|error| format!("Failed to finish release package: {error}"))?;
    Ok(output_path.to_string_lossy().to_string())
}

#[cfg(test)]
mod organizer_preview_tests {
    use super::*;

    fn temp_dir(label: &str) -> std::path::PathBuf {
        // Counter, not a timestamp — see organizer.rs::temp_assets. Windows' ~15ms
        // clock granularity hands two tests in the same tick an identical path.
        use std::sync::atomic::{AtomicUsize, Ordering};
        static COUNTER: AtomicUsize = AtomicUsize::new(0);

        let path = std::env::temp_dir().join(format!(
            "recall-{label}-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn preview_leaf_validation_rejects_path_escape() {
        assert!(safe_preview_leaf("01-opening.wav"));
        assert!(!safe_preview_leaf("../opening.wav"));
        assert!(!safe_preview_leaf("audio/opening.wav"));
        assert!(!safe_preview_leaf(""));
    }

    #[test]
    fn exports_page_and_copies_audio_without_modifying_source() {
        let destination = temp_dir("preview-export");
        let source_dir = temp_dir("preview-source");
        let source = source_dir.join("master.wav");
        std::fs::write(&source, b"source-audio").unwrap();
        let output = destination.join("perseus-preview.zip");

        let exported = export_organizer_preview(
            output.to_string_lossy().to_string(),
            "<!doctype html><title>Perseus</title>".to_string(),
            "Perseus\r\n\r\n01 - Opening\r\n".to_string(),
            Some(OrganizerPreviewAsset {
                file_name: "cover.webp".to_string(),
                bytes: b"cover-art".to_vec(),
            }),
            vec![OrganizerPreviewFile {
                source_path: source.to_string_lossy().to_string(),
                output_name: "01-opening.wav".to_string(),
            }],
        )
        .unwrap();

        let exported = std::path::PathBuf::from(exported);
        assert!(exported.is_file());
        let archive = std::fs::read(&exported).unwrap();
        assert!(archive.starts_with(&0x04034b50_u32.to_le_bytes()));
        assert!(archive
            .windows(b"index.html".len())
            .any(|part| part == b"index.html"));
        assert!(archive
            .windows(b"comments.txt".len())
            .any(|part| part == b"comments.txt"));
        assert!(archive
            .windows(b"cover.webp".len())
            .any(|part| part == b"cover.webp"));
        assert!(archive
            .windows(b"audio/01-opening.wav".len())
            .any(|part| part == b"audio/01-opening.wav"));
        assert_eq!(std::fs::read(&source).unwrap(), b"source-audio");

        export_organizer_preview(
            output.to_string_lossy().to_string(),
            "<!doctype html><title>Updated</title>".to_string(),
            "Updated comments".to_string(),
            None,
            vec![OrganizerPreviewFile {
                source_path: source.to_string_lossy().to_string(),
                output_name: "01-opening.wav".to_string(),
            }],
        )
        .unwrap();
        let updated = std::fs::read(&exported).unwrap();
        assert!(updated
            .windows(b"Updated".len())
            .any(|part| part == b"Updated"));

        std::fs::remove_dir_all(destination).ok();
        std::fs::remove_dir_all(source_dir).ok();
    }
}

/// Load every organizer project (release) from native storage, with cover art
/// and waveform envelopes hydrated from their cache files.
#[tauri::command]
fn list_organizer_projects(
    state: State<'_, AppState>,
) -> Result<Vec<organizer::OrganizerProject>, String> {
    let storage = state.storage.lock().expect("Storage state lock failed");
    storage.list_organizer_projects()
}

/// Save one whole organizer project atomically: cover + waveform assets to
/// files, structured rows in a single transaction.
#[tauri::command]
fn save_organizer_project(
    state: State<'_, AppState>,
    project: organizer::OrganizerProject,
) -> Result<(), String> {
    let storage = state.storage.lock().expect("Storage state lock failed");
    storage.save_organizer_project(&project)
}

#[tauri::command]
fn delete_organizer_project(state: State<'_, AppState>, project_id: String) -> Result<(), String> {
    let storage = state.storage.lock().expect("Storage state lock failed");
    storage.delete_organizer_project(&project_id)
}

#[tauri::command]
fn list_planner_tasks(state: State<'_, AppState>) -> Result<Vec<PlannerTask>, String> {
    let storage = state.storage.lock().expect("Storage state lock failed");
    storage.list_planner_tasks()
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn create_planner_task(
    state: State<'_, AppState>,
    id: String,
    title: String,
    due_date: String,
    due_time: Option<String>,
    task_type: String,
    project_id: Option<String>,
    notes: Option<String>,
) -> Result<PlannerTask, String> {
    let id = id.trim();
    if id.is_empty() || id.len() > 128 {
        return Err("Could not create this task. Please try again.".into());
    }
    let fields = normalize_planner_task(title, due_date, due_time, task_type, project_id, notes)?;
    let storage = state.storage.lock().expect("Storage state lock failed");
    storage.create_planner_task(
        id,
        &fields.title,
        &fields.due_date,
        fields.due_time.as_deref(),
        &fields.task_type,
        fields.project_id.as_deref(),
        fields.notes.as_deref(),
    )
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn update_planner_task(
    state: State<'_, AppState>,
    id: String,
    title: String,
    due_date: String,
    due_time: Option<String>,
    task_type: String,
    project_id: Option<String>,
    notes: Option<String>,
    completed: bool,
) -> Result<PlannerTask, String> {
    let id = id.trim();
    if id.is_empty() || id.len() > 128 {
        return Err("Could not update this task. Please try again.".into());
    }
    let fields = normalize_planner_task(title, due_date, due_time, task_type, project_id, notes)?;
    let storage = state.storage.lock().expect("Storage state lock failed");
    storage.update_planner_task(
        id,
        &fields.title,
        &fields.due_date,
        fields.due_time.as_deref(),
        &fields.task_type,
        fields.project_id.as_deref(),
        fields.notes.as_deref(),
        completed,
    )
}

#[tauri::command]
fn delete_planner_task(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let storage = state.storage.lock().expect("Storage state lock failed");
    storage.delete_planner_task(id.trim())
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

const AUDIO_FILE_EXTENSIONS: &[&str] = &[
    "wav", "wave", "aif", "aiff", "flac", "mp3", "m4a", "aac", "ogg",
];

fn time_as_ms(time: std::io::Result<std::time::SystemTime>) -> Option<u64> {
    time.ok()
        .and_then(|value| value.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|value| value.as_millis() as u64)
}

/// Read the practical facts Windows Explorer gives a producer about a project
/// folder. We deliberately do this only on an explicit refresh: traversing a
/// project with large sample libraries on every UI poll would make the library
/// feel slow. Symlinks/junctions are not followed so a linked sample drive cannot
/// make the scan unexpectedly leave the project folder or loop back into it.
fn scan_project_folder_metadata(dir: &std::path::Path) -> Result<ProjectFolderMetadata, String> {
    let root = std::fs::metadata(dir)
        .map_err(|error| format!("Failed to inspect project folder: {}", error))?;
    if !root.is_dir() {
        return Err("That project source is not a folder.".to_string());
    }

    let mut file_count = 0usize;
    let mut total_size_bytes = 0u64;
    let mut als_file_count = 0usize;
    let mut audio_file_count = 0usize;
    let mut latest_file_modified_at_ms: Option<u64> = None;
    let mut pending = vec![dir.to_path_buf()];

    while let Some(current) = pending.pop() {
        let entries = match std::fs::read_dir(&current) {
            Ok(entries) => entries,
            // A sample folder can be unavailable while a network drive sleeps or
            // a plugin owns a file. Keep the rest of the project useful instead
            // of failing an entire library refresh.
            Err(_) => continue,
        };

        for entry in entries.flatten() {
            let file_type = match entry.file_type() {
                Ok(file_type) => file_type,
                Err(_) => continue,
            };
            if file_type.is_symlink() {
                continue;
            }

            let path = entry.path();
            if file_type.is_dir() {
                pending.push(path);
                continue;
            }
            if !file_type.is_file() {
                continue;
            }

            let metadata = match entry.metadata() {
                Ok(metadata) => metadata,
                Err(_) => continue,
            };
            file_count += 1;
            total_size_bytes = total_size_bytes.saturating_add(metadata.len());
            if let Some(modified_at_ms) = time_as_ms(metadata.modified()) {
                latest_file_modified_at_ms = Some(
                    latest_file_modified_at_ms
                        .map(|current| current.max(modified_at_ms))
                        .unwrap_or(modified_at_ms),
                );
            }

            let extension = path
                .extension()
                .and_then(|value| value.to_str())
                .unwrap_or_default();
            if extension.eq_ignore_ascii_case("als") {
                als_file_count += 1;
            }
            if AUDIO_FILE_EXTENSIONS
                .iter()
                .any(|candidate| extension.eq_ignore_ascii_case(candidate))
            {
                audio_file_count += 1;
            }
        }
    }

    Ok(ProjectFolderMetadata {
        created_at_ms: time_as_ms(root.created()),
        modified_at_ms: time_as_ms(root.modified()),
        latest_file_modified_at_ms,
        file_count,
        total_size_bytes,
        als_file_count,
        audio_file_count,
        scanned_at_ms: time_as_ms(Ok(std::time::SystemTime::now())).unwrap_or(0),
    })
}

#[cfg(test)]
mod project_folder_metadata_tests {
    use super::*;

    fn temp_dir() -> std::path::PathBuf {
        // Counter, not a timestamp — see organizer.rs::temp_assets.
        use std::sync::atomic::{AtomicUsize, Ordering};
        static COUNTER: AtomicUsize = AtomicUsize::new(0);

        let path = std::env::temp_dir().join(format!(
            "recall-folder-metadata-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn scans_project_files_without_counting_directories() {
        let root = temp_dir();
        let nested = root.join("Samples");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::write(root.join("song.als"), b"als").unwrap();
        std::fs::write(nested.join("kick.wav"), b"audio").unwrap();
        std::fs::write(nested.join("notes.txt"), b"text").unwrap();

        let metadata = scan_project_folder_metadata(&root).unwrap();

        assert_eq!(metadata.file_count, 3);
        assert_eq!(metadata.total_size_bytes, 12);
        assert_eq!(metadata.als_file_count, 1);
        assert_eq!(metadata.audio_file_count, 1);
        assert!(metadata.latest_file_modified_at_ms.is_some());
        assert!(metadata.scanned_at_ms > 0);

        std::fs::remove_dir_all(root).ok();
    }
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
    let entries = std::fs::read_dir(root_path)
        .map_err(|error| format!("Failed to read folder: {}", error))?;
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
    let discovered_folders: std::collections::HashSet<&str> = discovered
        .iter()
        .map(|(_, folder)| folder.as_str())
        .collect();
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
    let added = storage.rescan_project_takes(project_id, &files)?;
    let folder_metadata = scan_project_folder_metadata(std::path::Path::new(&folder))?;
    storage.save_project_folder_metadata(project_id, &folder_metadata)?;
    Ok(added)
}

/// Re-scan a project's folder for new `.als` versions. The "Rescan" button.
#[tauri::command]
fn rescan_project_folder(state: State<'_, AppState>, project_id: String) -> Result<usize, String> {
    let storage = state.storage.lock().expect("Storage state lock failed");
    rescan_project(&storage, &project_id)
}

#[derive(serde::Serialize)]
struct FolderMetadataRefresh {
    refreshed: usize,
    unavailable: usize,
}

/// Refresh cached Windows Explorer facts for one project or every connected
/// project. The scan is deliberately user-triggered, so normal library polling
/// never walks a producer's sample-heavy folders.
#[tauri::command]
fn refresh_project_folder_metadata(
    state: State<'_, AppState>,
    project_id: Option<String>,
) -> Result<FolderMetadataRefresh, String> {
    let projects = {
        let storage = state.storage.lock().expect("Storage state lock failed");
        storage.list_projects(false)?
    };
    let requested_id = project_id.as_deref();
    if let Some(id) = requested_id {
        if !projects.iter().any(|project| project.id == id) {
            return Err(format!("Project not found: {}", id));
        }
    }

    let mut refreshed = 0usize;
    let mut unavailable = 0usize;
    for project in projects {
        if requested_id.is_some_and(|id| id != project.id) {
            continue;
        }
        let Some(folder) = project.ableton_path else {
            unavailable += 1;
            continue;
        };
        match scan_project_folder_metadata(std::path::Path::new(&folder)) {
            Ok(metadata) => {
                let storage = state.storage.lock().expect("Storage state lock failed");
                storage.save_project_folder_metadata(&project.id, &metadata)?;
                refreshed += 1;
            }
            Err(_) => unavailable += 1,
        }
    }

    Ok(FolderMetadataRefresh {
        refreshed,
        unavailable,
    })
}

/// A `.als` version in a project folder, for the relink picker.
#[derive(serde::Serialize)]
struct AlsFileInfo {
    name: String,
    path: String,
}

/// List the `.als` versions in a project's connected folder, for choosing a relink
/// target. Empty if the project has no folder.
#[tauri::command]
fn list_project_als_files(
    state: State<'_, AppState>,
    project_id: String,
) -> Result<Vec<AlsFileInfo>, String> {
    let storage = state.storage.lock().expect("Storage state lock failed");
    let Some(folder) = storage.project_ableton_path(&project_id)? else {
        return Ok(Vec::new());
    };
    Ok(list_als_files(std::path::Path::new(&folder))
        .into_iter()
        .map(|file| AlsFileInfo {
            name: file.name,
            path: file.path,
        })
        .collect())
}

/// Move a take's history onto a different `.als` version (e.g. after a rename).
#[tauri::command]
fn relink_take(
    state: State<'_, AppState>,
    session_id: String,
    als_path: String,
) -> Result<(), String> {
    let storage = state.storage.lock().expect("Storage state lock failed");
    storage.relink_take(&session_id, &als_path)
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

/// Open a project for work: resume the take for the `.als` Ableton currently has
/// open (so today's moves append to that version's memory), falling back to the
/// most-recent take when Ableton isn't live. This is what double-clicking a project
/// calls — the "take me to v8" behavior.
#[tauri::command]
fn open_take_for_open_file(
    state: State<'_, AppState>,
    project_id: Option<String>,
) -> Result<SessionStatus, String> {
    ensure_project_exists(&state, project_id.as_deref())?;

    let open_als = {
        let connection = state
            .connection
            .lock()
            .expect("Connection state lock failed");
        connection.open_als_path.clone()
    };

    // Stop whatever take was active so events stop tagging to it, then persist it.
    let previous_status = {
        let mut session = state.session.lock().expect("Session state lock failed");
        session.stop()
    };

    let status = {
        let storage = state.storage.lock().expect("Storage state lock failed");
        if previous_status.session_id.is_some() {
            storage.save_session_stopped(&previous_status)?;
        }
        storage.activate_take_for_open_file(project_id.as_deref(), open_als.as_deref())?
    };

    // Fresh live buffer so the previous take's events don't bleed into this one.
    {
        let mut recent_events = state
            .recent_events
            .lock()
            .expect("Recent events lock failed");
        recent_events.clear();
    }

    // Mirror into the in-memory session so incoming events tag to this take.
    if let (Some(session_id), Some(started_at_ms)) =
        (status.session_id.clone(), status.started_at_ms)
    {
        let mut session = state.session.lock().expect("Session state lock failed");
        // Brand-new take: its only known activity so far is being created.
        session.restore_active(session_id, started_at_ms, started_at_ms);
    }

    println!(
        "COMMAND open_take_for_open_file -> take {:?} (project {:?}, open_als {:?})",
        status.session_id, project_id, open_als
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
fn get_note_edits(state: State<'_, AppState>, session_id: String) -> Result<Vec<NoteEdit>, String> {
    let storage = state.storage.lock().expect("Storage state lock failed");
    storage.get_note_edits(&session_id)
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
        open_als_path: None,
        session_als_path: None,
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
        .plugin(tauri_plugin_notification::init())
        // Closing Recall keeps its one existing process alive in the system
        // tray. That lets the daily agenda fire while the studio is tucked
        // away; choosing Quit from the tray remains an explicit full exit.
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.emit("recall://window-visibility", false);
                let _ = window.hide();
            }
        })
        .setup(move |app| {
            let open_item = MenuItem::with_id(app, "open", "Open Recall", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit Recall", true, None::<&str>)?;
            let tray_menu = Menu::with_items(app, &[&open_item, &quit_item])?;
            let tray_icon = app
                .default_window_icon()
                .cloned()
                .expect("Recall Studio requires a default window icon for the system tray");

            TrayIconBuilder::with_id("recall-studio")
                .icon(tray_icon)
                .tooltip("Recall Studio")
                .menu(&tray_menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => show_main_window(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main_window(tray.app_handle());
                    }
                })
                .build(app)?;

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

            // Keep the installed control surface in step with the one this build
            // ships. Installing a new Recall replaces the bundled resource but
            // never the copy in the producer's Ableton User Library, so without
            // this an updated app quietly keeps talking to last month's script.
            //
            // Deliberately best-effort and never fatal: a missing library (external
            // drive unplugged) or a failed write must not stop the app starting.
            // The producer falls back to the setup screen, which can explain
            // itself, rather than meeting an error on launch.
            let repair = install::auto_repair_installed_script(app.handle());
            match (&repair.error, repair.repaired, repair.attempted) {
                (Some(error), _, _) => {
                    eprintln!("Recall Studio: control surface auto-repair skipped: {error}")
                }
                (None, true, _) => println!(
                    "Recall Studio: control surface updated to {} at {:?} — Ableton must restart to load it",
                    repair.script_version.as_deref().unwrap_or("unknown"),
                    repair.install_dir.as_deref().unwrap_or("?")
                ),
                (None, false, true) => println!("Recall Studio: control surface already current"),
                (None, false, false) => {
                    println!("Recall Studio: no control surface installed yet — setup will ask")
                }
            }

            let (active_status, last_activity_ms) = {
                let storage = storage_state_for_setup
                    .lock()
                    .expect("Storage state lock failed");

                let active_status = storage
                    .resume_or_create_active_session()
                    .expect("Failed to resume or create active Recall Studio session");

                // Seed SessionState's idle clock from the take's real activity
                // (or its own start time, for a brand-new one) rather than
                // leaving it unset — see SessionState::restore_active for why
                // an inaccurate seed would let a genuinely stale take dodge
                // rotate_session_if_stale on this run.
                let last_activity_ms = active_status
                    .session_id
                    .as_deref()
                    .and_then(|id| storage.session_last_activity_ms(id).ok().flatten())
                    .or(active_status.started_at_ms);

                (active_status, last_activity_ms)
            };

            if let (Some(session_id), Some(started_at_ms), Some(last_activity_ms)) = (
                active_status.session_id.clone(),
                active_status.started_at_ms,
                last_activity_ms,
            ) {
                let mut session = session_state_for_setup
                    .lock()
                    .expect("Session state lock failed");

                session.restore_active(session_id, started_at_ms, last_activity_ms);
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
            read_organizer_audio,
            export_organizer_preview,
            list_organizer_projects,
            save_organizer_project,
            delete_organizer_project,
            list_planner_tasks,
            create_planner_task,
            update_planner_task,
            delete_planner_task,
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
            refresh_project_folder_metadata,
            list_project_als_files,
            relink_take,
            rename_project,
            archive_project,
            assign_session_to_project,
            rename_capture,
            start_capture_for_project,
            open_take_for_open_file,
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
            get_note_edits,
            list_creative_moments,
            create_creative_moment,
            update_creative_moment,
            set_creative_moment_targets,
            delete_creative_moment,
            install::detect_bridge_install_targets,
            install::is_remote_script_installed,
            install::install_bridge
        ])
        .run(tauri::generate_context!())
        .expect("error while running Recall Studio");
}
