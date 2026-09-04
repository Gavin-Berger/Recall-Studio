//! Out-of-process Serum 2 preset-name observation.
//!
//! Ableton exposes Serum's automatable parameters but not its internal preset
//! browser selection: `PluginDevice.presets` is always `["Default"]`. Touching
//! the Remote Script to chase that dummy value previously destabilized normal
//! parameter capture, so this module deliberately has no Live/LOM dependency.
//!
//! While a Serum 2 editor is open, Windows can render its window into a bitmap.
//! We hash the tiny preset-label strip, OCR only after that strip changes and is
//! stable, and resolve the OCR text against the producer's preset filenames.
//! The resulting event enters Recall over the existing localhost ingestion path.

use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::net::UdpSocket;
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const POLL_WHILE_OPEN: Duration = Duration::from_millis(250);
const POLL_WHILE_CLOSED: Duration = Duration::from_secs(1);
const INDEX_REFRESH: Duration = Duration::from_secs(10 * 60);
const WINDOW_FORGET_AFTER: Duration = Duration::from_secs(3);

#[derive(Debug, Clone, Serialize)]
struct ObservedPreset {
    preset_name: String,
    preset_path: Option<String>,
    match_kind: &'static str,
    ocr_text: String,
}

#[derive(Debug, Clone)]
struct PresetCandidate {
    name: String,
    path: PathBuf,
    normalized: String,
}

#[derive(Debug, Default)]
struct PresetIndex {
    exact: HashMap<String, Vec<usize>>,
    candidates: Vec<PresetCandidate>,
}

impl PresetIndex {
    fn discover() -> Self {
        let mut roots = Vec::new();
        if let Some(profile) = std::env::var_os("USERPROFILE") {
            let profile = PathBuf::from(profile);
            roots.push(
                profile
                    .join("Documents")
                    .join("Xfer")
                    .join("Serum 2 Presets")
                    .join("Presets"),
            );
            roots.push(
                profile
                    .join("OneDrive")
                    .join("Documents")
                    .join("Xfer")
                    .join("Serum 2 Presets")
                    .join("Presets"),
            );
        }

        let mut index = Self::default();
        let mut seen_paths = HashSet::new();
        for root in roots {
            index.walk(&root, &mut seen_paths);
        }
        index
    }

    fn walk(&mut self, root: &Path, seen_paths: &mut HashSet<PathBuf>) {
        let Ok(entries) = fs::read_dir(root) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                self.walk(&path, seen_paths);
                continue;
            }
            if !is_serum_preset_file(&path) || !seen_paths.insert(path.clone()) {
                continue;
            }
            let Some(stem) = path.file_stem().and_then(|value| value.to_str()) else {
                continue;
            };
            let normalized = normalize_preset_name(stem);
            if normalized.len() < 2 {
                continue;
            }
            let position = self.candidates.len();
            self.candidates.push(PresetCandidate {
                name: stem.to_string(),
                path,
                normalized: normalized.clone(),
            });
            self.exact.entry(normalized).or_default().push(position);
        }
    }

    fn resolve(&self, ocr_text: &str) -> Option<ObservedPreset> {
        let normalized = normalize_preset_name(ocr_text);
        if normalized.len() < 2 {
            return None;
        }

        if let Some(indices) = self.exact.get(&normalized) {
            // The same preset can exist in multiple pack folders. Its display
            // name is still unambiguous even when its disk path is not.
            let candidate = &self.candidates[*indices.first()?];
            let one_path = (indices.len() == 1).then(|| candidate.path.display().to_string());
            return Some(ObservedPreset {
                preset_name: candidate.name.clone(),
                preset_path: one_path,
                match_kind: "filename_exact",
                ocr_text: ocr_text.trim().to_string(),
            });
        }

        let max_distance = (normalized.chars().count() / 8).clamp(1, 4);
        let mut best_distance = usize::MAX;
        let mut best_indices = Vec::new();
        for (index, candidate) in self.candidates.iter().enumerate() {
            let candidate_len = candidate.normalized.chars().count();
            let observed_len = normalized.chars().count();
            if candidate_len.abs_diff(observed_len) > max_distance {
                continue;
            }
            let distance = levenshtein(&normalized, &candidate.normalized);
            if distance < best_distance {
                best_distance = distance;
                best_indices.clear();
                best_indices.push(index);
            } else if distance == best_distance {
                best_indices.push(index);
            }
        }

        if best_distance > max_distance || best_indices.is_empty() {
            return None;
        }
        let distinct_names: HashSet<&str> = best_indices
            .iter()
            .map(|index| self.candidates[*index].name.as_str())
            .collect();
        if distinct_names.len() != 1 {
            return None;
        }

        let candidate = &self.candidates[best_indices[0]];
        let one_path = (best_indices.len() == 1).then(|| candidate.path.display().to_string());
        Some(ObservedPreset {
            preset_name: candidate.name.clone(),
            preset_path: one_path,
            match_kind: "filename_fuzzy",
            ocr_text: ocr_text.trim().to_string(),
        })
    }
}

fn is_serum_preset_file(path: &Path) -> bool {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    extension.eq_ignore_ascii_case("serumpreset") || extension.eq_ignore_ascii_case("fxp")
}

fn normalize_preset_name(value: &str) -> String {
    value
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

fn levenshtein(left: &str, right: &str) -> usize {
    let right: Vec<char> = right.chars().collect();
    let mut previous: Vec<usize> = (0..=right.len()).collect();
    let mut current = vec![0; right.len() + 1];

    for (left_index, left_char) in left.chars().enumerate() {
        current[0] = left_index + 1;
        for (right_index, right_char) in right.iter().enumerate() {
            let substitution = previous[right_index] + usize::from(left_char != *right_char);
            current[right_index + 1] = (current[right_index] + 1)
                .min(previous[right_index + 1] + 1)
                .min(substitution);
        }
        std::mem::swap(&mut previous, &mut current);
    }
    previous[right.len()]
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn track_name_from_window_title(title: &str) -> Option<String> {
    // Ableton titles VST3 editors like `Serum 2/12-Bass Lead`. The number is
    // Live's displayed track index, not a stable ID, so keep only the label.
    let after_slash = title.split_once('/')?.1;
    let after_number = after_slash.split_once('-')?.1.trim();
    (!after_number.is_empty()).then(|| after_number.to_string())
}

fn send_preset_event(
    socket: &UdpSocket,
    window_title: &str,
    capture_hash: u32,
    preset: &ObservedPreset,
) -> Result<(), String> {
    let track_name = track_name_from_window_title(window_title);
    let payload = serde_json::json!({
        "protocol": "recall.v2",
        "source": "serum_window_observer",
        "event_type": "device_preset_changed",
        "timestamp_ms": now_ms(),
        "title": format!("Serum 2 preset: {}", preset.preset_name),
        "description": format!("Loaded {} in Serum 2.", preset.preset_name),
        "payload": {
            "device_name": "Serum 2",
            "track_name": track_name,
            "preset_name": preset.preset_name,
            "preset_path": preset.preset_path,
            "observer": "serum_window_label",
            "match_kind": preset.match_kind,
            "ocr_text": preset.ocr_text,
            "window_title": window_title,
            "capture_hash": format!("{capture_hash:08x}"),
        }
    });
    let bytes = serde_json::to_vec(&payload).map_err(|error| error.to_string())?;
    socket
        .send_to(&bytes, "127.0.0.1:9000")
        .map_err(|error| format!("could not submit preset event: {error}"))?;
    Ok(())
}

#[cfg(windows)]
mod windows_observer {
    use super::*;
    use crc32fast::hash;
    use std::ffi::c_void;
    use windows::core::{Interface, BOOL};
    use windows::Graphics::Imaging::{BitmapPixelFormat, SoftwareBitmap};
    use windows::Media::Ocr::OcrEngine;
    use windows::Storage::Streams::Buffer;
    use windows::Win32::Foundation::{HWND, LPARAM, RECT};
    use windows::Win32::Graphics::Gdi::{
        CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, SelectObject, BITMAPINFO,
        BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HGDIOBJ,
    };
    use windows::Win32::Storage::Xps::{PrintWindow, PRINT_WINDOW_FLAGS};
    use windows::Win32::System::WinRT::{IBufferByteAccess, RoInitialize, RO_INIT_MULTITHREADED};
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetClassNameW, GetWindowRect, GetWindowTextLengthW, GetWindowTextW,
        IsWindowVisible, PW_RENDERFULLCONTENT,
    };

    #[derive(Debug, Clone)]
    struct Frame {
        width: usize,
        height: usize,
        bgra: Vec<u8>,
    }

    #[derive(Debug)]
    struct WindowSnapshot {
        hwnd: HWND,
        title: String,
    }

    #[derive(Debug)]
    struct WindowState {
        pending_hash: u32,
        confirmations: u8,
        processed_hash: Option<u32>,
        current_name: Option<String>,
        last_seen: Instant,
    }

    pub(super) fn start() {
        thread::Builder::new()
            .name("serum-preset-observer".to_string())
            .spawn(|| {
                if let Err(error) = run() {
                    log::warn!("Serum preset observer stopped: {error}");
                }
            })
            .expect("failed to start Serum preset observer thread");
    }

    fn run() -> Result<(), String> {
        // This is our own thread, so choosing MTA cannot conflict with Tauri's
        // UI apartment. S_FALSE (already initialized the same way) is success.
        unsafe { RoInitialize(RO_INIT_MULTITHREADED) }
            .map_err(|error| format!("Windows Runtime initialization failed: {error}"))?;
        let ocr = OcrEngine::TryCreateFromUserProfileLanguages()
            .map_err(|error| format!("Windows OCR is unavailable: {error}"))?;
        let socket = UdpSocket::bind("127.0.0.1:0")
            .map_err(|error| format!("could not create local event socket: {error}"))?;

        let mut index = PresetIndex::default();
        let mut index_built_at: Option<Instant> = None;
        let mut states: HashMap<usize, WindowState> = HashMap::new();

        loop {
            let windows = serum_windows();
            if windows.is_empty() {
                states.clear();
                thread::sleep(POLL_WHILE_CLOSED);
                continue;
            }

            if index_built_at
                .map(|built| built.elapsed() >= INDEX_REFRESH)
                .unwrap_or(true)
            {
                index = PresetIndex::discover();
                index_built_at = Some(Instant::now());
                log::info!(
                    "Serum preset observer indexed {} preset files",
                    index.candidates.len()
                );
            }

            let cycle_started = Instant::now();
            for window in windows {
                let key = window.hwnd.0 as usize;
                let Ok(full_frame) = capture_window(window.hwnd) else {
                    continue;
                };
                let Some(label_frame) = crop_preset_label(&full_frame) else {
                    continue;
                };
                let capture_hash = hash(&label_frame.bgra);

                let state = states.entry(key).or_insert_with(|| WindowState {
                    pending_hash: capture_hash,
                    confirmations: 0,
                    processed_hash: None,
                    current_name: None,
                    last_seen: cycle_started,
                });
                state.last_seen = cycle_started;
                if state.pending_hash != capture_hash {
                    state.pending_hash = capture_hash;
                    state.confirmations = 1;
                    continue;
                }
                state.confirmations = state.confirmations.saturating_add(1);
                if state.confirmations < 2 || state.processed_hash == Some(capture_hash) {
                    continue;
                }
                state.processed_hash = Some(capture_hash);

                let prepared = prepare_for_ocr(&label_frame, 4);
                let Ok(ocr_text) = recognize(&ocr, &prepared) else {
                    continue;
                };
                let Some(preset) = index.resolve(&ocr_text) else {
                    log::debug!(
                        "Serum preset observer could not resolve OCR {:?} ({})",
                        ocr_text,
                        window.title
                    );
                    continue;
                };

                // The first stable read is a baseline, not evidence that the
                // producer just loaded something. Every later A→B→A transition
                // is emitted, including the repeated A.
                match state.current_name.as_deref() {
                    None => state.current_name = Some(preset.preset_name),
                    Some(current) if current == preset.preset_name => {}
                    Some(_) => {
                        if let Err(error) =
                            send_preset_event(&socket, &window.title, capture_hash, &preset)
                        {
                            log::warn!("Serum preset observer: {error}");
                        } else {
                            log::info!(
                                "Serum preset observer: {} ({})",
                                preset.preset_name,
                                window.title
                            );
                        }
                        state.current_name = Some(preset.preset_name);
                    }
                }
            }

            states.retain(|_, state| state.last_seen.elapsed() < WINDOW_FORGET_AFTER);
            thread::sleep(POLL_WHILE_OPEN);
        }
    }

    fn serum_windows() -> Vec<WindowSnapshot> {
        unsafe extern "system" fn callback(hwnd: HWND, context: LPARAM) -> BOOL {
            let windows = &mut *(context.0 as *mut Vec<WindowSnapshot>);
            if IsWindowVisible(hwnd).as_bool() {
                let class_name = window_class(hwnd);
                let title = window_title(hwnd);
                if class_name == "Vst3PlugWindow"
                    && (title.starts_with("Serum 2/") || title.starts_with("Serum 2 FX/"))
                {
                    windows.push(WindowSnapshot { hwnd, title });
                }
            }
            BOOL(1)
        }

        let mut windows = Vec::new();
        // Enumeration can fail if the desktop is shutting down; an empty cycle
        // is harmless and retries one second later.
        let _ = unsafe {
            EnumWindows(
                Some(callback),
                LPARAM((&mut windows as *mut Vec<WindowSnapshot>) as isize),
            )
        };
        windows
    }

    fn window_class(hwnd: HWND) -> String {
        let mut buffer = [0u16; 256];
        let length = unsafe { GetClassNameW(hwnd, &mut buffer) }.max(0) as usize;
        String::from_utf16_lossy(&buffer[..length])
    }

    fn window_title(hwnd: HWND) -> String {
        let length = unsafe { GetWindowTextLengthW(hwnd) }.max(0) as usize;
        let mut buffer = vec![0u16; length.saturating_add(1)];
        let copied = unsafe { GetWindowTextW(hwnd, &mut buffer) }.max(0) as usize;
        String::from_utf16_lossy(&buffer[..copied])
    }

    fn capture_window(hwnd: HWND) -> Result<Frame, String> {
        let mut rect = RECT::default();
        unsafe { GetWindowRect(hwnd, &mut rect) }
            .map_err(|error| format!("could not measure Serum window: {error}"))?;
        let width = (rect.right - rect.left).max(0) as usize;
        let height = (rect.bottom - rect.top).max(0) as usize;
        if width < 400 || height < 250 || width > 8_000 || height > 8_000 {
            return Err(format!("unexpected Serum window size {width}x{height}"));
        }

        let dc = unsafe { CreateCompatibleDC(None) };
        if dc.0.is_null() {
            return Err("could not create capture DC".to_string());
        }

        let mut info = BITMAPINFO::default();
        info.bmiHeader = BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: width as i32,
            biHeight: -(height as i32), // top-down, matching screen coordinates
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            biSizeImage: (width * height * 4) as u32,
            ..Default::default()
        };

        let mut bits: *mut c_void = std::ptr::null_mut();
        let bitmap = match unsafe {
            CreateDIBSection(Some(dc), &info, DIB_RGB_COLORS, &mut bits, None, 0)
        } {
            Ok(bitmap) => bitmap,
            Err(error) => {
                let _ = unsafe { DeleteDC(dc) };
                return Err(format!("could not create capture bitmap: {error}"));
            }
        };

        let old = unsafe { SelectObject(dc, HGDIOBJ(bitmap.0)) };
        let rendered =
            unsafe { PrintWindow(hwnd, dc, PRINT_WINDOW_FLAGS(PW_RENDERFULLCONTENT)) }.as_bool();
        let bgra = if rendered && !bits.is_null() {
            unsafe { std::slice::from_raw_parts(bits as *const u8, width * height * 4) }.to_vec()
        } else {
            Vec::new()
        };

        unsafe {
            SelectObject(dc, old);
            let _ = DeleteObject(HGDIOBJ(bitmap.0));
            let _ = DeleteDC(dc);
        }

        if bgra.is_empty() {
            return Err("Serum window did not render".to_string());
        }
        Ok(Frame {
            width,
            height,
            bgra,
        })
    }

    fn crop_preset_label(frame: &Frame) -> Option<Frame> {
        // Measured from Serum 2's complete VST3 window, including Ableton's
        // title bar. Ratios keep the crop aligned across Serum UI zoom levels.
        let x = frame.width * 448 / 1_000;
        let y = frame.height * 44 / 1_000;
        let width = frame.width * 325 / 1_000;
        let height = (frame.height * 39 / 1_000).max(24);
        if x + width > frame.width || y + height > frame.height {
            return None;
        }

        let mut bgra = Vec::with_capacity(width * height * 4);
        for row in y..y + height {
            let start = (row * frame.width + x) * 4;
            bgra.extend_from_slice(&frame.bgra[start..start + width * 4]);
        }
        Some(Frame {
            width,
            height,
            bgra,
        })
    }

    fn prepare_for_ocr(frame: &Frame, scale: usize) -> Frame {
        let width = frame.width * scale;
        let height = frame.height * scale;
        let mut bgra = vec![0; width * height * 4];
        for y in 0..height {
            for x in 0..width {
                let source = ((y / scale) * frame.width + (x / scale)) * 4;
                let target = (y * width + x) * 4;
                let blue = frame.bgra[source] as u16;
                let green = frame.bgra[source + 1] as u16;
                let red = frame.bgra[source + 2] as u16;
                let luminance = (blue * 11 + green * 59 + red * 30) / 100;
                let value = if luminance >= 105 { 255 } else { 0 };
                bgra[target] = value;
                bgra[target + 1] = value;
                bgra[target + 2] = value;
                bgra[target + 3] = 255;
            }
        }
        Frame {
            width,
            height,
            bgra,
        }
    }

    fn recognize(engine: &OcrEngine, frame: &Frame) -> Result<String, String> {
        let length: u32 = frame
            .bgra
            .len()
            .try_into()
            .map_err(|_| "OCR frame is too large".to_string())?;
        let buffer = Buffer::Create(length)
            .map_err(|error| format!("could not allocate OCR buffer: {error}"))?;
        buffer
            .SetLength(length)
            .map_err(|error| format!("could not size OCR buffer: {error}"))?;
        let access: IBufferByteAccess = buffer
            .cast()
            .map_err(|error| format!("could not access OCR buffer: {error}"))?;
        let destination = unsafe { access.Buffer() }
            .map_err(|error| format!("could not map OCR buffer: {error}"))?;
        if destination.is_null() {
            return Err("Windows returned a null OCR buffer".to_string());
        }
        unsafe {
            std::ptr::copy_nonoverlapping(frame.bgra.as_ptr(), destination, frame.bgra.len())
        };

        let bitmap = SoftwareBitmap::CreateCopyFromBuffer(
            &buffer,
            BitmapPixelFormat::Bgra8,
            frame.width as i32,
            frame.height as i32,
        )
        .map_err(|error| format!("could not create OCR bitmap: {error}"))?;
        let result = engine
            .RecognizeAsync(&bitmap)
            .and_then(|operation| operation.get())
            .map_err(|error| format!("OCR failed: {error}"))?;
        result
            .Text()
            .map(|text| text.to_string())
            .map_err(|error| format!("could not read OCR text: {error}"))
    }
}

/// Starts the no-setup observer. On other platforms it is intentionally a no-op
/// until an equivalent native window capture path is implemented.
pub fn start_serum_preset_observer() {
    #[cfg(windows)]
    windows_observer::start();
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture_index(names: &[&str]) -> PresetIndex {
        let mut index = PresetIndex::default();
        for name in names {
            let normalized = normalize_preset_name(name);
            let position = index.candidates.len();
            index.candidates.push(PresetCandidate {
                name: (*name).to_string(),
                path: PathBuf::from(format!("C:/Presets/{name}.SerumPreset")),
                normalized: normalized.clone(),
            });
            index.exact.entry(normalized).or_default().push(position);
        }
        index
    }

    #[test]
    fn normalization_folds_the_separators_windows_ocr_changes() {
        assert_eq!(
            normalize_preset_name("gogoi-toronto bass_baked"),
            "gogoitorontobassbaked"
        );
    }

    #[test]
    fn exact_ocr_resolves_to_the_real_filename_spelling() {
        let index = fixture_index(&["gogoi_toronto_bass_baked"]);
        let found = index.resolve("gogoi-toronto-bass-baked").unwrap();
        assert_eq!(found.preset_name, "gogoi_toronto_bass_baked");
        assert_eq!(found.match_kind, "filename_exact");
    }

    #[test]
    fn small_ocr_errors_resolve_when_the_best_name_is_unique() {
        let index = fixture_index(&["s0_serum_bass_gritty", "wide_air_pad"]);
        let found = index.resolve("J so-serum-bass-gritty").unwrap();
        assert_eq!(found.preset_name, "s0_serum_bass_gritty");
        assert_eq!(found.match_kind, "filename_fuzzy");
    }

    #[test]
    fn ambiguous_fuzzy_matches_are_rejected_instead_of_guessed() {
        let index = fixture_index(&["bass_one", "bass_owe"]);
        assert!(index.resolve("bass-ore").is_none());
    }

    #[test]
    fn window_title_yields_a_track_label_without_treating_number_as_identity() {
        assert_eq!(
            track_name_from_window_title("Serum 2/12-Bass Lead").as_deref(),
            Some("Bass Lead")
        );
    }

    #[test]
    fn serum_extensions_include_legacy_fxp_banks() {
        assert!(is_serum_preset_file(Path::new("Bass.SerumPreset")));
        assert!(is_serum_preset_file(Path::new("Bass.fxp")));
        assert!(!is_serum_preset_file(Path::new("Bass.wav")));
    }
}
