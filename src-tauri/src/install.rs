use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

// The device files Recall Studio ships and drops into Ableton. Both must land in
// the same folder: the .amxd references the .js by filename and Max resolves it
// from alongside the device.
const DEVICE_FILE: &str = "recall-studio.amxd";
const BRIDGE_SCRIPT_FILE: &str = "recall_m4l_bridge.js";

// Where inside the User Library a Max MIDI Effect must live to show up in Live's
// browser. NOTE: this is the MIDI-Effect location. If the device is ever rebuilt
// as a Max Audio Effect (so it can sit on the master/audio tracks), change this
// to "Presets/Audio Effects/Max Audio Effect".
const DEVICE_SUBFOLDER: &[&str] = &["Presets", "MIDI Effects", "Max MIDI Effect"];

#[derive(Serialize)]
pub struct InstallTarget {
    pub path: String,
    pub exists: bool,
}

#[derive(Serialize)]
pub struct InstallDetection {
    pub candidates: Vec<InstallTarget>,
    // The path the UI should pre-fill: the first candidate that exists, else the
    // platform default so the user can install (and create) it in one click.
    pub recommended: Option<String>,
    // Version of the bridge script the app ships, so the setup screen can show
    // what would be installed before the user clicks. None if running unbundled.
    pub bridge_version: Option<String>,
}

#[derive(Serialize)]
pub struct InstallResult {
    pub installed_dir: String,
    pub files: Vec<String>,
    pub bridge_version: Option<String>,
}

// Candidate Ableton "User Library" roots by platform default. The real location
// is user-configurable in Live's preferences and has no API, so these are best
// guesses; the UI lets the user correct the path before installing.
fn user_library_candidates(app: &AppHandle) -> Vec<PathBuf> {
    let mut out = Vec::new();

    if let Ok(home) = app.path().home_dir() {
        // Windows default.
        out.push(
            home.join("Documents")
                .join("Ableton")
                .join("User Library"),
        );
        // macOS default.
        out.push(home.join("Music").join("Ableton").join("User Library"));
    }

    out
}

fn platform_default_index() -> usize {
    if cfg!(target_os = "macos") {
        1
    } else {
        0
    }
}

// Resolve the bundled device files shipped as Tauri resources.
fn bundled_device_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("Could not resolve app resource directory: {e}"))?;

    let bridge_dir = resource_dir.join("bridge");

    if bridge_dir.join(DEVICE_FILE).exists() {
        return Ok(bridge_dir);
    }

    Err(format!(
        "Bundled bridge device not found at {:?}. The app may be running unbundled (dev) without resources copied.",
        bridge_dir
    ))
}

fn parse_bridge_version(script_path: &Path) -> Option<String> {
    let contents = std::fs::read_to_string(script_path).ok()?;
    // Match: var BRIDGE_VERSION = "x.y.z";
    let needle = "BRIDGE_VERSION";
    let line = contents.lines().find(|l| l.contains(needle))?;
    let start = line.find('"')? + 1;
    let end = line[start..].find('"')? + start;
    Some(line[start..end].to_string())
}

#[tauri::command]
pub fn detect_bridge_install_targets(app: AppHandle) -> InstallDetection {
    let candidates_paths = user_library_candidates(&app);

    let candidates: Vec<InstallTarget> = candidates_paths
        .iter()
        .map(|p| InstallTarget {
            path: p.to_string_lossy().to_string(),
            exists: p.exists(),
        })
        .collect();

    let recommended = candidates
        .iter()
        .find(|c| c.exists)
        .map(|c| c.path.clone())
        .or_else(|| {
            candidates
                .get(platform_default_index())
                .map(|c| c.path.clone())
        });

    let bridge_version = bundled_device_dir(&app)
        .ok()
        .and_then(|dir| parse_bridge_version(&dir.join(BRIDGE_SCRIPT_FILE)));

    InstallDetection {
        candidates,
        recommended,
        bridge_version,
    }
}

#[tauri::command]
pub fn install_bridge(app: AppHandle, target_root: String) -> Result<InstallResult, String> {
    let target_root = target_root.trim();
    if target_root.is_empty() {
        return Err("No install location given.".to_string());
    }

    let source_dir = bundled_device_dir(&app)?;
    let source_device = source_dir.join(DEVICE_FILE);
    let source_script = source_dir.join(BRIDGE_SCRIPT_FILE);

    if !source_device.exists() || !source_script.exists() {
        return Err(format!(
            "Bundled bridge files are missing ({DEVICE_FILE} / {BRIDGE_SCRIPT_FILE})."
        ));
    }

    let mut install_dir = PathBuf::from(target_root);
    for part in DEVICE_SUBFOLDER {
        install_dir.push(part);
    }

    std::fs::create_dir_all(&install_dir).map_err(|e| {
        format!(
            "Could not create install folder {:?}: {e}",
            install_dir
        )
    })?;

    let dest_device = install_dir.join(DEVICE_FILE);
    let dest_script = install_dir.join(BRIDGE_SCRIPT_FILE);

    std::fs::copy(&source_device, &dest_device)
        .map_err(|e| format!("Failed to copy {DEVICE_FILE}: {e}"))?;
    std::fs::copy(&source_script, &dest_script)
        .map_err(|e| format!("Failed to copy {BRIDGE_SCRIPT_FILE}: {e}"))?;

    Ok(InstallResult {
        installed_dir: install_dir.to_string_lossy().to_string(),
        files: vec![DEVICE_FILE.to_string(), BRIDGE_SCRIPT_FILE.to_string()],
        bridge_version: parse_bridge_version(&source_script),
    })
}
