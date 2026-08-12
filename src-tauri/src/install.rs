//! Installing the Recall control surface into Ableton's User Library.
//!
//! Live discovers control surfaces by scanning `<User Library>/Remote Scripts/`
//! **at startup only**, then offers each folder it found by name in
//! Preferences -> Link/Tempo/MIDI -> Control Surface. So there are exactly two
//! things this module cannot do, and both must be asked of the producer:
//! choosing `Recall` in that dropdown, and restarting Live.
//!
//! ```text
//!   app bundle                          Ableton User Library
//!   ──────────                          ────────────────────
//!   resources/remote-script/Recall/     <root>/Remote Scripts/Recall/
//!     __init__.py            ──copy──►    __init__.py
//!                                         __pycache__/   ← Live writes this; we prune it
//!
//!   then, and only the producer can do these:
//!     restart Live  ──►  Live rescans Remote Scripts/
//!     Preferences -> Link/Tempo/MIDI -> Control Surface -> Recall
//! ```
//!
//! This replaced a Max for Live installer. That one wrote `RECALL.amxd` into
//! `Presets/Audio Effects/Max Audio Effect/`, which is why several names here
//! still read "bridge" on the wire (`ConnectionStatus.bridge_version` is the
//! heartbeat field name and is deliberately left alone).

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

/// Where the remembered install target lives, next to the event database in the
/// app data directory.
///
/// WHY REMEMBER IT AT ALL: the launch-time repair below has to know where to
/// write without asking, and re-running `user_library_candidates` to find out
/// would mean 52 filesystem probes on every app start — including, on Windows,
/// blocking probes against disconnected network drives.
const INSTALL_PREFS_FILE: &str = "install-target.json";

/// The package folder name. This is not cosmetic: Live lists the *directory*
/// name in its Control Surface dropdown, so renaming it renames what the
/// producer must click, and every setup instruction in the app would go stale.
const SCRIPT_PACKAGE: &str = "Recall";

/// Where inside a User Library root Live scans for control surfaces.
const REMOTE_SCRIPTS_DIR: &str = "Remote Scripts";

/// Presence of this file is what "installed" means. It is the Python package
/// entry point, so if it is missing the folder cannot load whatever else is there.
const SCRIPT_ENTRY_FILE: &str = "__init__.py";

/// Python's bytecode cache. Live writes it into the install folder on first
/// import; it is ours to remove on reinstall and never ours to keep.
const PYCACHE_DIR: &str = "__pycache__";

/// Folders a real Ableton User Library contains. Used to reject a target before
/// writing to it — see `looks_like_user_library`.
const USER_LIBRARY_MARKERS: &[&str] = &[
    "Presets",
    "Templates",
    "Samples",
    "Clips",
    "Defaults",
    "Grooves",
    REMOTE_SCRIPTS_DIR,
];

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
    // Version of the control surface this build ships, so the setup screen can
    // show what would be installed before the user clicks, and compare it against
    // the version reported over the heartbeat. None if running unbundled.
    pub script_version: Option<String>,
}

#[derive(Serialize)]
pub struct InstallResult {
    pub installed_dir: String,
    pub files: Vec<String>,
    pub removed: Vec<String>,
    pub script_version: Option<String>,
}

/// Whether the control surface is present at a given User Library root, and
/// which version is on disk.
#[derive(Serialize)]
pub struct InstallStatus {
    pub installed: bool,
    pub install_dir: String,
    pub script_version: Option<String>,
}

/// The User Library the producer installed into, remembered across launches.
#[derive(Serialize, Deserialize, Default)]
struct InstallPrefs {
    library_root: Option<String>,
}

/// What the launch-time repair did, for the console and for the setup screen.
///
/// Deliberately a report rather than a `Result`: a failed repair must never stop
/// the app from starting. The producer falls back to the ordinary setup screen,
/// which can say something useful, instead of meeting a modal on launch.
#[derive(Serialize, Default)]
pub struct AutoRepairReport {
    /// False when there is no remembered library yet — a first run, not a failure.
    pub attempted: bool,
    /// True when files were actually written.
    pub repaired: bool,
    pub install_dir: Option<String>,
    /// Version now on disk. Ableton keeps running the old one until it restarts.
    pub script_version: Option<String>,
    pub error: Option<String>,
}

// Candidate Ableton "User Library" roots. The real location is user-configurable
// in Live's preferences and has no API, so these are best guesses; the UI lets
// the user correct the path before installing.
fn user_library_candidates(app: &AppHandle) -> Vec<PathBuf> {
    let mut out = Vec::new();

    if let Ok(home) = app.path().home_dir() {
        // Windows default.
        out.push(home.join("Documents").join("Ableton").join("User Library"));
        // macOS default.
        out.push(home.join("Music").join("Ableton").join("User Library"));
    }

    // Producers often move the library off the system drive ("M:\Ableton
    // Library\User Library"). Probe every drive root for the common layouts so
    // detection finds a relocated library instead of guessing Documents.
    //
    // COST WARNING: this is 52 filesystem probes, and on Windows a probe against
    // a disconnected mapped network drive blocks on an SMB timeout. Never call
    // this on a poll — it belongs behind explicit user action only. Cheap
    // "is it still installed?" checks go through `is_remote_script_installed`,
    // which stats one known path.
    #[cfg(target_os = "windows")]
    for letter in b'A'..=b'Z' {
        let root = PathBuf::from(format!("{}:\\", letter as char));
        for layout in ["Ableton Library", "Ableton"] {
            let candidate = root.join(layout).join("User Library");
            if candidate.exists() {
                out.push(candidate);
            }
        }
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

// Resolve the bundled control surface shipped as a Tauri resource.
fn bundled_script_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("Could not resolve app resource directory: {e}"))?;

    let script_dir = resource_dir.join("remote-script").join(SCRIPT_PACKAGE);

    if script_dir.join(SCRIPT_ENTRY_FILE).exists() {
        return Ok(script_dir);
    }

    Err(format!(
        "Bundled control surface not found at {:?}. The app may be running unbundled (dev) without resources copied.",
        script_dir
    ))
}

/// Pull `SCRIPT_VERSION = "x.y.z"` out of the Python source.
///
/// Reading the constant rather than duplicating it in Rust keeps one source of
/// truth: the script declares its own version, and both the shipped copy and the
/// installed copy are measured the same way.
fn parse_script_version(script_path: &Path) -> Option<String> {
    let contents = std::fs::read_to_string(script_path).ok()?;
    let line = contents
        .lines()
        // Skip comments so a line *mentioning* SCRIPT_VERSION can't be mistaken
        // for the assignment. The real one is `SCRIPT_VERSION = "..."`.
        .find(|l| !l.trim_start().starts_with('#') && l.contains("SCRIPT_VERSION"))?;
    let start = line.find('"')? + 1;
    let end = line[start..].find('"')? + start;
    let version = &line[start..end];
    if version.is_empty() {
        return None;
    }
    Some(version.to_string())
}

/// The control surface's home inside a User Library root.
fn script_install_dir(library_root: &Path) -> PathBuf {
    library_root.join(REMOTE_SCRIPTS_DIR).join(SCRIPT_PACKAGE)
}

/// Does this look like a real Ableton User Library?
///
/// The install path comes from an editable text box, and the pre-filled default
/// is a *guess* that may point somewhere Ableton has never heard of. Without
/// this check a wrong path installs "successfully" into a folder Live will never
/// scan, and the producer is left with a screen that says it worked and a bridge
/// that never connects — having done everything they were told.
fn looks_like_user_library(root: &Path) -> bool {
    if !root.is_dir() {
        return false;
    }
    USER_LIBRARY_MARKERS
        .iter()
        .any(|marker| root.join(marker).is_dir())
}

/// Refuse to treat anything as our install directory unless it is exactly
/// `<something>/Remote Scripts/Recall`.
///
/// This is the guard on the only code in the product that DELETES files inside a
/// user's Ableton library. The path is derived from user input, so a bug plus a
/// typo could otherwise point the prune at something real. Symlinks are rejected
/// rather than followed, so the folder cannot be aimed elsewhere after the fact.
fn is_guarded_script_dir(dir: &Path) -> bool {
    if dir
        .symlink_metadata()
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(false)
    {
        return false;
    }

    let is_package = dir.file_name().and_then(|n| n.to_str()) == Some(SCRIPT_PACKAGE);
    let in_remote_scripts = dir
        .parent()
        .and_then(|p| p.file_name())
        .and_then(|n| n.to_str())
        == Some(REMOTE_SCRIPTS_DIR);

    is_package && in_remote_scripts
}

/// Every `.py` file the bundle ships, by file name.
fn shipped_script_files(source_dir: &Path) -> Result<Vec<String>, String> {
    let entries = std::fs::read_dir(source_dir)
        .map_err(|e| format!("Could not read bundled control surface {:?}: {e}", source_dir))?;

    let mut names: Vec<String> = Vec::new();
    for entry in entries.flatten() {
        if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if name.ends_with(".py") {
            names.push(name);
        }
    }

    if names.is_empty() {
        return Err(format!("No .py files in {:?}.", source_dir));
    }

    names.sort();
    Ok(names)
}

/// Remove anything in the install directory the current build does not ship.
///
/// WHY THIS EXISTS: copying over an existing install leaves orphans behind. Today
/// the package is a single file so nothing can be orphaned, but the moment it
/// splits into modules and one is later deleted upstream, the stale module stays
/// in the producer's Ableton folder and Live keeps importing it — you would be
/// debugging behaviour from code that no longer exists in the repo, on a machine
/// you cannot see. `__pycache__` goes too: it is Live's bytecode of the file we
/// just replaced.
///
/// Scoped deliberately: only regular files directly in the directory, plus the
/// one known cache folder. No recursive delete, no globbing.
fn prune_stale_files(install_dir: &Path, shipped: &[String]) -> Result<Vec<String>, String> {
    let mut removed = Vec::new();

    let pycache = install_dir.join(PYCACHE_DIR);
    if pycache.is_dir() {
        std::fs::remove_dir_all(&pycache)
            .map_err(|e| format!("Could not remove {:?}: {e}", pycache))?;
        removed.push(PYCACHE_DIR.to_string());
    }

    let entries = match std::fs::read_dir(install_dir) {
        Ok(entries) => entries,
        // A fresh install has nothing to prune.
        Err(_) => return Ok(removed),
    };

    for entry in entries.flatten() {
        if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if shipped.contains(&name) {
            continue;
        }
        std::fs::remove_file(entry.path())
            .map_err(|e| format!("Could not remove stale file {:?}: {e}", entry.path()))?;
        removed.push(name);
    }

    removed.sort();
    Ok(removed)
}

/// Create, guard, copy, prune. The one place files are written into a User
/// Library, shared by the explicit install and the launch-time repair so the two
/// paths cannot drift apart — a repair that pruned differently from an install
/// would be a bug nobody would find until an upgrade.
fn write_script_into(
    install_dir: &Path,
    source_dir: &Path,
    shipped: &[String],
) -> Result<Vec<String>, String> {
    std::fs::create_dir_all(install_dir)
        .map_err(|e| format!("Could not create install folder {:?}: {e}", install_dir))?;

    // Checked AFTER create_dir_all so the symlink test sees the real directory,
    // and before anything is written or deleted.
    if !is_guarded_script_dir(install_dir) {
        return Err(format!(
            "Refusing to write to {:?}: the install folder must be a real directory named \
             \"{SCRIPT_PACKAGE}\" inside \"{REMOTE_SCRIPTS_DIR}\".",
            install_dir
        ));
    }

    for name in shipped {
        let from = source_dir.join(name);
        let to = install_dir.join(name);
        std::fs::copy(&from, &to).map_err(|e| format!("Failed to copy {name}: {e}"))?;
    }

    // Prune after copying, not before: if the copy fails the producer keeps a
    // working previous install rather than an empty folder and a dead bridge.
    prune_stale_files(install_dir, shipped)
}

fn prefs_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Could not resolve app data directory: {e}"))?;
    Ok(dir.join(INSTALL_PREFS_FILE))
}

fn load_library_root(app: &AppHandle) -> Option<PathBuf> {
    let raw = std::fs::read_to_string(prefs_path(app).ok()?).ok()?;
    let prefs: InstallPrefs = serde_json::from_str(&raw).ok()?;
    prefs.library_root.map(PathBuf::from)
}

fn remember_library_root(app: &AppHandle, root: &Path) -> Result<(), String> {
    let path = prefs_path(app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Could not create {:?}: {e}", parent))?;
    }
    let prefs = InstallPrefs {
        library_root: Some(root.to_string_lossy().to_string()),
    };
    let body = serde_json::to_string_pretty(&prefs)
        .map_err(|e| format!("Could not serialize install prefs: {e}"))?;
    std::fs::write(&path, body).map_err(|e| format!("Could not write {:?}: {e}", path))
}

/// Should the launch-time repair rewrite the installed files?
///
/// Pure so it can be tested without an AppHandle, and deliberately conservative
/// about *not* rewriting: an unnecessary copy bumps the file's mtime, which
/// invalidates the bytecode cache Live built and makes it recompile on next
/// start for no reason.
///
/// Rewrites when the versions differ in ANY direction (the installed copy is not
/// what this build ships, so it is wrong regardless of which is newer), when a
/// shipped file is missing, or when either version is unreadable — an unparseable
/// installed file is exactly the case a repair should fix rather than trust.
fn needs_repair(
    installed_version: Option<&str>,
    shipped_version: Option<&str>,
    any_shipped_file_missing: bool,
) -> bool {
    if any_shipped_file_missing {
        return true;
    }
    match (installed_version, shipped_version) {
        (Some(installed), Some(shipped)) => installed != shipped,
        _ => true,
    }
}

/// Bring the installed control surface back in line with what this build ships.
///
/// Runs at startup, silently. Reinstalling the app replaces the bundled resource
/// but never touches the copy in the producer's User Library, so without this a
/// user updates Recall and Ableton keeps loading last month's script forever —
/// and the failure is invisible, because an older script still works, it just
/// captures less than the new app expects.
///
/// The one thing this cannot do is make Live pick the new file up: Live reads
/// `Remote Scripts/` only at startup. That restart is the single step left for a
/// human, and the app is responsible for asking for it (see `setupState.ts`).
pub fn auto_repair_installed_script(app: &AppHandle) -> AutoRepairReport {
    let Some(root) = load_library_root(app) else {
        // No remembered library: a first run, not a failure. Setup will ask.
        return AutoRepairReport::default();
    };

    let mut report = AutoRepairReport {
        attempted: true,
        ..Default::default()
    };

    // The library can vanish between launches — an external drive left unplugged,
    // a folder moved. Never write into a path that no longer looks like a library;
    // creating a fresh tree there would be worse than doing nothing.
    if !looks_like_user_library(&root) {
        report.error = Some(format!(
            "Remembered Ableton User Library is missing or moved: {:?}",
            root
        ));
        return report;
    }

    let install_dir = script_install_dir(&root);
    report.install_dir = Some(install_dir.to_string_lossy().to_string());

    let source_dir = match bundled_script_dir(app) {
        Ok(dir) => dir,
        Err(error) => {
            report.error = Some(error);
            return report;
        }
    };

    let shipped = match shipped_script_files(&source_dir) {
        Ok(names) => names,
        Err(error) => {
            report.error = Some(error);
            return report;
        }
    };

    let shipped_version = parse_script_version(&source_dir.join(SCRIPT_ENTRY_FILE));
    let installed_version = parse_script_version(&install_dir.join(SCRIPT_ENTRY_FILE));
    let any_missing = shipped.iter().any(|n| !install_dir.join(n).is_file());

    if !needs_repair(
        installed_version.as_deref(),
        shipped_version.as_deref(),
        any_missing,
    ) {
        report.script_version = installed_version;
        return report;
    }

    match write_script_into(&install_dir, &source_dir, &shipped) {
        Ok(_) => {
            report.repaired = true;
            report.script_version = parse_script_version(&install_dir.join(SCRIPT_ENTRY_FILE));
        }
        Err(error) => report.error = Some(error),
    }

    report
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

    // Prefer the library that already holds the control surface (the upgrade case
    // — a producer with a relocated library should update in place, not get a
    // second copy under Documents), then any library that exists, then the
    // platform default so first-time install can create it.
    let recommended = candidates_paths
        .iter()
        .find(|p| script_install_dir(p).join(SCRIPT_ENTRY_FILE).exists())
        .map(|p| p.to_string_lossy().to_string())
        .or_else(|| {
            candidates
                .iter()
                .find(|c| c.exists)
                .map(|c| c.path.clone())
        })
        .or_else(|| {
            candidates
                .get(platform_default_index())
                .map(|c| c.path.clone())
        });

    let script_version = bundled_script_dir(&app)
        .ok()
        .and_then(|dir| parse_script_version(&dir.join(SCRIPT_ENTRY_FILE)));

    InstallDetection {
        candidates,
        recommended,
        script_version,
    }
}

/// Is the control surface installed under this User Library root?
///
/// Cheap on purpose: one stat against one known path, so the app can ask on a
/// poll without re-running the drive scan in `user_library_candidates`.
#[tauri::command]
pub fn is_remote_script_installed(target_root: String) -> InstallStatus {
    let install_dir = script_install_dir(Path::new(target_root.trim()));
    let entry = install_dir.join(SCRIPT_ENTRY_FILE);

    InstallStatus {
        installed: entry.is_file(),
        install_dir: install_dir.to_string_lossy().to_string(),
        script_version: parse_script_version(&entry),
    }
}

#[tauri::command]
pub fn install_bridge(app: AppHandle, target_root: String) -> Result<InstallResult, String> {
    let target_root = target_root.trim();
    if target_root.is_empty() {
        return Err("No install location given.".to_string());
    }

    let root = Path::new(target_root);
    if !looks_like_user_library(root) {
        return Err(format!(
            "That folder does not look like an Ableton User Library — it has none of {}. \
             Pick the folder that contains them (it is usually named \"User Library\").",
            USER_LIBRARY_MARKERS.join(", ")
        ));
    }

    let source_dir = bundled_script_dir(&app)?;
    let shipped = shipped_script_files(&source_dir)?;

    let install_dir = script_install_dir(root);
    let removed = write_script_into(&install_dir, &source_dir, &shipped)?;

    // Remember where this landed so the launch-time repair can keep it current
    // without re-running the drive scan. A failure here is not worth failing the
    // install over — the producer's script is already in place; the only cost is
    // that the next app update will need them to press Install again.
    if let Err(error) = remember_library_root(&app, root) {
        log::warn!("Recall Studio: could not remember install location: {error}");
    }

    Ok(InstallResult {
        installed_dir: install_dir.to_string_lossy().to_string(),
        files: shipped,
        removed,
        script_version: parse_script_version(&install_dir.join(SCRIPT_ENTRY_FILE)),
    })
}

#[cfg(test)]
mod tests {
    //! Tests for the pure path and filesystem logic — everything that does not
    //! need an AppHandle. The two Tauri commands that take one (`detect_*`,
    //! `install_bridge`) are covered indirectly through the helpers they compose.
    //!
    //! `install.rs` had no tests at all before this. It is now the only code in
    //! the product that deletes files inside a user's Ableton library, so the
    //! guard below is the most important assertion in this file.

    use super::*;

    /// A directory no other test can be handed.
    ///
    /// The counter is not belt-and-braces. Windows' system clock granularity is
    /// ~15ms, so a timestamp alone gives two tests starting in the same tick the
    /// SAME path — both create it happily, and then one test's prune deletes the
    /// other's fixture. That surfaced here as a single intermittent failure with
    /// the tests otherwise green. `storage.rs` already uses this pattern.
    fn temp_dir(label: &str) -> PathBuf {
        use std::sync::atomic::{AtomicUsize, Ordering};
        static COUNTER: AtomicUsize = AtomicUsize::new(0);

        let path = std::env::temp_dir().join(format!(
            "recall-install-{label}-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        // Start from a known-empty directory even if a previous run left one.
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    /// A User Library root with the control surface already installed.
    fn library_with_install(label: &str) -> (PathBuf, PathBuf) {
        let root = temp_dir(label);
        std::fs::create_dir_all(root.join("Presets")).unwrap();
        let install = script_install_dir(&root);
        std::fs::create_dir_all(&install).unwrap();
        (root, install)
    }

    #[test]
    fn install_dir_is_remote_scripts_slash_package() {
        let dir = script_install_dir(Path::new("/lib"));
        assert!(dir.ends_with(Path::new("Remote Scripts").join("Recall")));
    }

    #[test]
    fn a_folder_with_a_known_marker_looks_like_a_user_library() {
        let root = temp_dir("marker");
        std::fs::create_dir_all(root.join("Presets")).unwrap();
        assert!(looks_like_user_library(&root));
    }

    #[test]
    fn an_empty_folder_does_not_look_like_a_user_library() {
        // The exact case that made a wrong install silently "succeed": the
        // pre-filled default path points at a folder Ableton has never used.
        let root = temp_dir("empty");
        assert!(!looks_like_user_library(&root));
    }

    #[test]
    fn a_missing_folder_does_not_look_like_a_user_library() {
        assert!(!looks_like_user_library(Path::new("/definitely/not/here/at/all")));
    }

    #[test]
    fn the_guard_accepts_our_own_install_directory() {
        let (_root, install) = library_with_install("guard-ok");
        assert!(is_guarded_script_dir(&install));
    }

    #[test]
    fn the_guard_refuses_a_directory_not_named_recall() {
        // A typo'd package name must never become a delete target.
        let root = temp_dir("guard-name");
        let wrong = root.join(REMOTE_SCRIPTS_DIR).join("NotRecall");
        std::fs::create_dir_all(&wrong).unwrap();
        assert!(!is_guarded_script_dir(&wrong));
    }

    #[test]
    fn the_guard_refuses_a_recall_folder_outside_remote_scripts() {
        // e.g. "<library>/Presets/Recall" — right name, wrong place. Pruning here
        // would delete a producer's own files.
        let root = temp_dir("guard-parent");
        let wrong = root.join("Presets").join(SCRIPT_PACKAGE);
        std::fs::create_dir_all(&wrong).unwrap();
        assert!(!is_guarded_script_dir(&wrong));
    }

    #[test]
    fn pruning_removes_an_orphaned_module_but_keeps_shipped_files() {
        // The upgrade landmine: v0.2 shipped net.py, v0.3 does not. Without this,
        // net.py lives forever in the producer's Ableton folder and Live keeps
        // importing it.
        let (_root, install) = library_with_install("prune-orphan");
        std::fs::write(install.join(SCRIPT_ENTRY_FILE), "SCRIPT_VERSION = \"0.3.0\"").unwrap();
        std::fs::write(install.join("net.py"), "# removed upstream").unwrap();

        let removed = prune_stale_files(&install, &[SCRIPT_ENTRY_FILE.to_string()]).unwrap();

        assert_eq!(removed, vec!["net.py".to_string()]);
        assert!(install.join(SCRIPT_ENTRY_FILE).exists());
        assert!(!install.join("net.py").exists());
    }

    #[test]
    fn pruning_removes_the_bytecode_cache() {
        // Live writes __pycache__ next to the script. Leaving it beside a swapped
        // source file is the classic stale-bytecode upgrade footgun.
        let (_root, install) = library_with_install("prune-pycache");
        let pycache = install.join(PYCACHE_DIR);
        std::fs::create_dir_all(&pycache).unwrap();
        std::fs::write(pycache.join("__init__.cpython-311.pyc"), "stale").unwrap();

        let removed = prune_stale_files(&install, &[SCRIPT_ENTRY_FILE.to_string()]).unwrap();

        assert!(removed.contains(&PYCACHE_DIR.to_string()));
        assert!(!pycache.exists());
    }

    #[test]
    fn pruning_a_fresh_install_removes_nothing_and_does_not_error() {
        let (_root, install) = library_with_install("prune-fresh");
        let removed = prune_stale_files(&install, &[SCRIPT_ENTRY_FILE.to_string()]).unwrap();
        assert!(removed.is_empty());
    }

    #[test]
    fn pruning_is_idempotent() {
        let (_root, install) = library_with_install("prune-twice");
        std::fs::write(install.join(SCRIPT_ENTRY_FILE), "x").unwrap();
        std::fs::write(install.join("orphan.py"), "x").unwrap();

        let shipped = vec![SCRIPT_ENTRY_FILE.to_string()];
        assert_eq!(prune_stale_files(&install, &shipped).unwrap().len(), 1);
        assert!(prune_stale_files(&install, &shipped).unwrap().is_empty());
    }

    #[test]
    fn the_installed_check_reports_present_and_reads_its_version() {
        let (root, install) = library_with_install("status-present");
        std::fs::write(
            install.join(SCRIPT_ENTRY_FILE),
            "SCRIPT_VERSION = \"0.3.0\"\n",
        )
        .unwrap();

        let status = is_remote_script_installed(root.to_string_lossy().to_string());

        assert!(status.installed);
        assert_eq!(status.script_version.as_deref(), Some("0.3.0"));
    }

    #[test]
    fn the_installed_check_reports_absent_when_the_folder_was_wiped() {
        // Reinstalling Live wipes Remote Scripts. This is what returns the app to
        // its first-run state instead of stranding the producer with a dead bridge.
        let root = temp_dir("status-absent");
        let status = is_remote_script_installed(root.to_string_lossy().to_string());

        assert!(!status.installed);
        assert_eq!(status.script_version, None);
    }

    #[test]
    fn the_version_is_read_from_the_python_constant() {
        let dir = temp_dir("version-ok");
        let path = dir.join(SCRIPT_ENTRY_FILE);
        std::fs::write(&path, "import json\nSCRIPT_VERSION = \"0.3.0\"\n").unwrap();
        assert_eq!(parse_script_version(&path).as_deref(), Some("0.3.0"));
    }

    #[test]
    fn a_comment_mentioning_the_constant_is_not_mistaken_for_it() {
        // The real file carries a comment block above the assignment explaining
        // why the number matters. Matching the first line containing the name
        // would read the comment instead.
        let dir = temp_dir("version-comment");
        let path = dir.join(SCRIPT_ENTRY_FILE);
        std::fs::write(
            &path,
            "# SCRIPT_VERSION is how you tell a deployed script from a stale one.\nSCRIPT_VERSION = \"0.3.0\"\n",
        )
        .unwrap();
        assert_eq!(parse_script_version(&path).as_deref(), Some("0.3.0"));
    }

    #[test]
    fn a_missing_or_malformed_version_is_none_rather_than_a_guess() {
        let dir = temp_dir("version-bad");

        let missing = dir.join("missing.py");
        std::fs::write(&missing, "x = 1\n").unwrap();
        assert_eq!(parse_script_version(&missing), None);

        let unquoted = dir.join("unquoted.py");
        std::fs::write(&unquoted, "SCRIPT_VERSION = 3\n").unwrap();
        assert_eq!(parse_script_version(&unquoted), None);

        let empty = dir.join("empty.py");
        std::fs::write(&empty, "SCRIPT_VERSION = \"\"\n").unwrap();
        assert_eq!(parse_script_version(&empty), None);

        assert_eq!(parse_script_version(&dir.join("nope.py")), None);
    }

    #[test]
    fn repair_is_needed_when_the_installed_version_differs() {
        // The whole point of the launch-time repair: the app updated, the script
        // on disk did not.
        assert!(needs_repair(Some("0.2.0"), Some("0.3.0"), false));
    }

    #[test]
    fn repair_is_needed_in_either_direction() {
        // A downgrade is just as wrong as an upgrade — the installed copy is not
        // what this build ships, and which is "newer" tells us nothing useful.
        assert!(needs_repair(Some("0.4.0"), Some("0.3.0"), false));
    }

    #[test]
    fn repair_is_skipped_when_the_versions_already_match() {
        // Rewriting unnecessarily bumps the mtime, which throws away the bytecode
        // cache Live built and makes it recompile on next start for nothing.
        assert!(!needs_repair(Some("0.3.0"), Some("0.3.0"), false));
    }

    #[test]
    fn repair_is_needed_when_a_shipped_file_is_missing() {
        // Matching versions are not proof of a complete install — a half-copied
        // package can still report the right version from __init__.py.
        assert!(needs_repair(Some("0.3.0"), Some("0.3.0"), true));
    }

    #[test]
    fn repair_is_needed_when_either_version_is_unreadable() {
        // An unparseable installed file is precisely what a repair should replace
        // rather than trust.
        assert!(needs_repair(None, Some("0.3.0"), false));
        assert!(needs_repair(Some("0.3.0"), None, false));
        assert!(needs_repair(None, None, false));
    }

    #[test]
    fn writing_the_script_copies_shipped_files_and_prunes_orphans_in_one_pass() {
        // The shared path used by BOTH the explicit install and the launch-time
        // repair. If these ever diverge, an upgrade would prune differently from
        // an install and nobody would notice until it mattered.
        let source = temp_dir("write-source");
        std::fs::write(source.join(SCRIPT_ENTRY_FILE), "SCRIPT_VERSION = \"0.3.0\"").unwrap();

        let (_root, install) = library_with_install("write-dest");
        std::fs::write(install.join("orphan.py"), "left over from 0.2").unwrap();

        let removed =
            write_script_into(&install, &source, &[SCRIPT_ENTRY_FILE.to_string()]).unwrap();

        assert_eq!(removed, vec!["orphan.py".to_string()]);
        assert_eq!(
            parse_script_version(&install.join(SCRIPT_ENTRY_FILE)).as_deref(),
            Some("0.3.0")
        );
    }

    #[test]
    fn writing_the_script_refuses_an_unguarded_destination() {
        // The destructive guard has to hold on the shared write path, not just at
        // the command boundary — the launch-time repair reaches it without going
        // through install_bridge's validation.
        let source = temp_dir("write-guard-source");
        std::fs::write(source.join(SCRIPT_ENTRY_FILE), "x").unwrap();

        let root = temp_dir("write-guard-dest");
        let wrong = root.join("Presets").join(SCRIPT_PACKAGE);

        let error = write_script_into(&wrong, &source, &[SCRIPT_ENTRY_FILE.to_string()])
            .expect_err("a Recall folder outside Remote Scripts must be refused");
        assert!(error.contains("Refusing to write"));
    }

    #[test]
    fn shipped_files_lists_only_python_and_rejects_an_empty_package() {
        let dir = temp_dir("shipped");
        std::fs::write(dir.join(SCRIPT_ENTRY_FILE), "x").unwrap();
        std::fs::write(dir.join("helper.py"), "x").unwrap();
        std::fs::write(dir.join("README.md"), "x").unwrap();

        let names = shipped_script_files(&dir).unwrap();
        assert_eq!(names, vec!["__init__.py".to_string(), "helper.py".to_string()]);

        assert!(shipped_script_files(&temp_dir("shipped-empty")).is_err());
    }
}
