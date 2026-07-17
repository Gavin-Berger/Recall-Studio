// Native durable storage for the Project Organizer.
//
// Structured metadata (projects, tracks, exports, comments, measurements) lives
// in SQLite alongside the session database. Large derived assets — the
// high-resolution waveform envelope and processed cover artwork — live as files
// under the app-data directory, referenced by path, so they never bloat the
// database. Original audio is never copied in; it is referenced by its source
// path and reloaded on demand.
//
// Persistence is a single transactional whole-project save. The frontend mutates
// a whole project object at a time, so replacing its rows atomically (delete
// children, reinsert in order) is both simpler and safer than a fan-out of
// partial writes, and it keeps track/version ordering exact via `position`.
//
// Assets are hydrated into the returned project on load and dehydrated to files
// on save, so the frontend sees the same shape it always has.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

fn default_volume() -> f64 {
    1.0
}

fn default_release_type() -> String {
    "album".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrganizerAls {
    pub id: String,
    pub path: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrganizerComment {
    pub id: String,
    #[serde(rename = "timeSec")]
    pub time_sec: f64,
    pub text: String,
    pub created_at_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrganizerBounce {
    pub id: String,
    #[serde(rename = "fileName", default)]
    pub file_name: String,
    #[serde(rename = "sourcePath", default, skip_serializing_if = "Option::is_none")]
    pub source_path: Option<String>,
    #[serde(rename = "fileSizeBytes", default)]
    pub file_size_bytes: i64,
    #[serde(rename = "durationSec", default)]
    pub duration_sec: f64,
    #[serde(rename = "sampleRate", default)]
    pub sample_rate: i64,
    #[serde(rename = "channelCount", default)]
    pub channel_count: i64,
    #[serde(default)]
    pub peaks: Vec<f64>,
    // Hydrated from / dehydrated to the waveform cache file. Not a DB column.
    #[serde(
        rename = "waveformChannels",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub waveform_channels: Option<Vec<String>>,
    #[serde(
        rename = "waveformPoints",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub waveform_points: Option<i64>,
    #[serde(rename = "integratedLufs", default)]
    pub integrated_lufs: Option<f64>,
    #[serde(rename = "dynamicRangeLu", default)]
    pub dynamic_range_lu: Option<f64>,
    #[serde(rename = "peakDb", default)]
    pub peak_db: f64,
    #[serde(rename = "peakKind", default, skip_serializing_if = "Option::is_none")]
    pub peak_kind: Option<String>,
    #[serde(
        rename = "analysisVersion",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub analysis_version: Option<i64>,
    #[serde(default = "default_volume")]
    pub volume: f64,
    pub added_at_ms: i64,
    #[serde(rename = "timedComments", default)]
    pub timed_comments: Vec<OrganizerComment>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrganizerTrack {
    pub id: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub comment: String,
    #[serde(rename = "alsFile", default)]
    pub als_file: Option<OrganizerAls>,
    #[serde(default)]
    pub bounces: Vec<OrganizerBounce>,
    #[serde(rename = "finalBounceId", default)]
    pub final_bounce_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrganizerProject {
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub artist: String,
    #[serde(rename = "releaseDate", default)]
    pub release_date: String,
    #[serde(default)]
    pub notes: String,
    #[serde(rename = "releaseType", default = "default_release_type")]
    pub release_type: String,
    #[serde(
        rename = "coverImageDataUrl",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub cover_image_data_url: Option<String>,
    #[serde(default)]
    pub tracks: Vec<OrganizerTrack>,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

pub const CACHE_FORMAT_VERSION: i64 = 1;

pub fn initialize_schema(connection: &Connection) -> rusqlite::Result<()> {
    connection.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS organizer_projects (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL DEFAULT '',
            artist TEXT NOT NULL DEFAULT '',
            release_date TEXT NOT NULL DEFAULT '',
            notes TEXT NOT NULL DEFAULT '',
            release_type TEXT NOT NULL DEFAULT 'album',
            cover_path TEXT,
            created_at_ms INTEGER NOT NULL,
            updated_at_ms INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS organizer_tracks (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL,
            position INTEGER NOT NULL,
            title TEXT NOT NULL DEFAULT '',
            comment TEXT NOT NULL DEFAULT '',
            als_id TEXT,
            als_path TEXT,
            als_name TEXT,
            final_bounce_id TEXT,
            FOREIGN KEY(project_id) REFERENCES organizer_projects(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_organizer_tracks_project
        ON organizer_tracks(project_id);

        CREATE TABLE IF NOT EXISTS organizer_bounces (
            id TEXT PRIMARY KEY,
            track_id TEXT NOT NULL,
            position INTEGER NOT NULL,
            file_name TEXT NOT NULL DEFAULT '',
            source_path TEXT,
            file_size_bytes INTEGER NOT NULL DEFAULT 0,
            duration_sec REAL NOT NULL DEFAULT 0,
            sample_rate INTEGER NOT NULL DEFAULT 0,
            channel_count INTEGER NOT NULL DEFAULT 0,
            integrated_lufs REAL,
            dynamic_range_lu REAL,
            peak_db REAL NOT NULL DEFAULT 0,
            peak_kind TEXT,
            analysis_version INTEGER,
            volume REAL NOT NULL DEFAULT 1,
            peaks TEXT,
            waveform_path TEXT,
            waveform_points INTEGER,
            waveform_cache_version INTEGER,
            added_at_ms INTEGER NOT NULL,
            FOREIGN KEY(track_id) REFERENCES organizer_tracks(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_organizer_bounces_track
        ON organizer_bounces(track_id);

        CREATE TABLE IF NOT EXISTS organizer_comments (
            id TEXT PRIMARY KEY,
            bounce_id TEXT NOT NULL,
            time_sec REAL NOT NULL DEFAULT 0,
            text TEXT NOT NULL DEFAULT '',
            created_at_ms INTEGER NOT NULL,
            FOREIGN KEY(bounce_id) REFERENCES organizer_bounces(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_organizer_comments_bounce
        ON organizer_comments(bounce_id);
        ",
    )
}

// --- Asset files (waveform cache + cover art) ------------------------------

fn waveforms_dir(assets_dir: &Path) -> PathBuf {
    assets_dir.join("waveforms")
}

fn covers_dir(assets_dir: &Path) -> PathBuf {
    assets_dir.join("covers")
}

/// A cache filename derived from an app-generated id. Never trust the id as a
/// path: keep only `[A-Za-z0-9_-]`, reject if nothing survives, and forbid path
/// separators or `..` in the result. The returned name is a leaf, never a path.
fn safe_asset_name(id: &str, prefix: &str, ext: &str) -> Result<String, String> {
    let sanitized: String = id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let trimmed = sanitized.trim_matches('_');
    if trimmed.is_empty() {
        return Err(format!("Cannot derive a safe cache name from id: {id}"));
    }
    Ok(format!("{prefix}-{trimmed}.{ext}"))
}

/// Reject any stored name that is not a bare leaf before joining it to a cache
/// directory — defense in depth even though we generate these names ourselves.
fn resolve_in_dir(dir: &Path, name: &str) -> Result<PathBuf, String> {
    if name.is_empty()
        || name.contains('/')
        || name.contains('\\')
        || name.contains("..")
        || Path::new(name).file_name().map(|f| f != name).unwrap_or(true)
    {
        return Err(format!("Unsafe cache filename: {name}"));
    }
    Ok(dir.join(name))
}

/// Write bytes atomically: to a temp sibling, fsync-free rename over the target.
/// A crash mid-write leaves either the old file or nothing, never a torn file.
fn atomic_write(dir: &Path, name: &str, bytes: &[u8]) -> Result<(), String> {
    std::fs::create_dir_all(dir)
        .map_err(|error| format!("Failed to create cache directory: {error}"))?;
    let target = resolve_in_dir(dir, name)?;
    let temp = dir.join(format!(".tmp-{}-{}", std::process::id(), name));
    std::fs::write(&temp, bytes).map_err(|error| format!("Failed to write cache file: {error}"))?;
    std::fs::rename(&temp, &target).map_err(|error| {
        let _ = std::fs::remove_file(&temp);
        format!("Failed to commit cache file: {error}")
    })?;
    Ok(())
}

fn read_asset(dir: &Path, name: &str) -> Result<Vec<u8>, String> {
    let path = resolve_in_dir(dir, name)?;
    std::fs::read(&path).map_err(|error| format!("Failed to read cache file: {error}"))
}

fn remove_asset(dir: &Path, name: &str) {
    if let Ok(path) = resolve_in_dir(dir, name) {
        let _ = std::fs::remove_file(path);
    }
}

// --- Repository ------------------------------------------------------------

pub fn list_projects(
    connection: &Connection,
    assets_dir: &Path,
) -> Result<Vec<OrganizerProject>, String> {
    let mut project_statement = connection
        .prepare(
            "SELECT id, name, artist, release_date, notes, release_type, cover_path,
                    created_at_ms, updated_at_ms
             FROM organizer_projects
             ORDER BY updated_at_ms DESC, created_at_ms DESC",
        )
        .map_err(|error| format!("Failed to prepare organizer projects query: {error}"))?;

    let project_rows = project_statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, Option<String>>(6)?,
                row.get::<_, i64>(7)?,
                row.get::<_, i64>(8)?,
            ))
        })
        .map_err(|error| format!("Failed to read organizer projects: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Failed to collect organizer projects: {error}"))?;

    let mut projects = Vec::with_capacity(project_rows.len());
    for (id, name, artist, release_date, notes, release_type, cover_path, created, updated) in
        project_rows
    {
        let cover_image_data_url = match cover_path {
            Some(name) => read_asset(&covers_dir(assets_dir), &name)
                .ok()
                .and_then(|bytes| String::from_utf8(bytes).ok()),
            None => None,
        };

        let tracks = load_tracks(connection, &id, assets_dir)?;

        projects.push(OrganizerProject {
            id,
            name,
            artist,
            release_date,
            notes,
            release_type,
            cover_image_data_url,
            tracks,
            created_at_ms: created,
            updated_at_ms: updated,
        });
    }

    Ok(projects)
}

fn load_tracks(
    connection: &Connection,
    project_id: &str,
    assets_dir: &Path,
) -> Result<Vec<OrganizerTrack>, String> {
    let mut statement = connection
        .prepare(
            "SELECT id, title, comment, als_id, als_path, als_name, final_bounce_id
             FROM organizer_tracks
             WHERE project_id = ?1
             ORDER BY position ASC",
        )
        .map_err(|error| format!("Failed to prepare organizer tracks query: {error}"))?;

    let rows = statement
        .query_map(params![project_id], |row| {
            let als_id = row.get::<_, Option<String>>(3)?;
            let als_path = row.get::<_, Option<String>>(4)?;
            let als_name = row.get::<_, Option<String>>(5)?;
            let als_file = match (als_id, als_path) {
                (Some(id), Some(path)) => Some(OrganizerAls {
                    name: als_name.unwrap_or_else(|| path.clone()),
                    id,
                    path,
                }),
                _ => None,
            };
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                als_file,
                row.get::<_, Option<String>>(6)?,
            ))
        })
        .map_err(|error| format!("Failed to read organizer tracks: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Failed to collect organizer tracks: {error}"))?;

    let mut tracks = Vec::with_capacity(rows.len());
    for (id, title, comment, als_file, final_bounce_id) in rows {
        let bounces = load_bounces(connection, &id, assets_dir)?;
        tracks.push(OrganizerTrack {
            id,
            title,
            comment,
            als_file,
            bounces,
            final_bounce_id,
        });
    }
    Ok(tracks)
}

fn load_bounces(
    connection: &Connection,
    track_id: &str,
    assets_dir: &Path,
) -> Result<Vec<OrganizerBounce>, String> {
    let mut statement = connection
        .prepare(
            "SELECT id, file_name, source_path, file_size_bytes, duration_sec, sample_rate,
                    channel_count, integrated_lufs, dynamic_range_lu, peak_db, peak_kind,
                    analysis_version, volume, peaks, waveform_path, waveform_points, added_at_ms
             FROM organizer_bounces
             WHERE track_id = ?1
             ORDER BY position ASC",
        )
        .map_err(|error| format!("Failed to prepare organizer bounces query: {error}"))?;

    let rows = statement
        .query_map(params![track_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, f64>(4)?,
                row.get::<_, i64>(5)?,
                row.get::<_, i64>(6)?,
                row.get::<_, Option<f64>>(7)?,
                row.get::<_, Option<f64>>(8)?,
                row.get::<_, f64>(9)?,
                row.get::<_, Option<String>>(10)?,
                row.get::<_, Option<i64>>(11)?,
                row.get::<_, f64>(12)?,
                row.get::<_, Option<String>>(13)?,
                row.get::<_, Option<String>>(14)?,
                row.get::<_, Option<i64>>(15)?,
                row.get::<_, i64>(16)?,
            ))
        })
        .map_err(|error| format!("Failed to read organizer bounces: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Failed to collect organizer bounces: {error}"))?;

    let mut bounces = Vec::with_capacity(rows.len());
    for row in rows {
        let (
            id,
            file_name,
            source_path,
            file_size_bytes,
            duration_sec,
            sample_rate,
            channel_count,
            integrated_lufs,
            dynamic_range_lu,
            peak_db,
            peak_kind,
            analysis_version,
            volume,
            peaks_json,
            waveform_path,
            waveform_points,
            added_at_ms,
        ) = row;

        let peaks: Vec<f64> = peaks_json
            .and_then(|json| serde_json::from_str(&json).ok())
            .unwrap_or_default();

        // Hydrate the high-resolution envelope from its cache file. A missing or
        // corrupt cache is not fatal: the bounce still carries its metadata and
        // low-res peaks, and the UI can regenerate from the source audio.
        let waveform_channels = waveform_path.as_deref().and_then(|name| {
            read_asset(&waveforms_dir(assets_dir), name)
                .ok()
                .and_then(|bytes| String::from_utf8(bytes).ok())
                .and_then(|json| serde_json::from_str::<Vec<String>>(&json).ok())
        });

        let comments = load_comments(connection, &id)?;

        bounces.push(OrganizerBounce {
            id,
            file_name,
            source_path,
            file_size_bytes,
            duration_sec,
            sample_rate,
            channel_count,
            peaks,
            waveform_channels,
            waveform_points,
            integrated_lufs,
            dynamic_range_lu,
            peak_db,
            peak_kind,
            analysis_version,
            volume,
            added_at_ms,
            timed_comments: comments,
        });
    }
    Ok(bounces)
}

fn load_comments(connection: &Connection, bounce_id: &str) -> Result<Vec<OrganizerComment>, String> {
    let mut statement = connection
        .prepare(
            "SELECT id, time_sec, text, created_at_ms
             FROM organizer_comments
             WHERE bounce_id = ?1
             ORDER BY time_sec ASC, created_at_ms ASC",
        )
        .map_err(|error| format!("Failed to prepare organizer comments query: {error}"))?;

    let comments = statement
        .query_map(params![bounce_id], |row| {
            Ok(OrganizerComment {
                id: row.get(0)?,
                time_sec: row.get(1)?,
                text: row.get(2)?,
                created_at_ms: row.get(3)?,
            })
        })
        .map_err(|error| format!("Failed to read organizer comments: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Failed to collect organizer comments: {error}"))?;
    Ok(comments)
}

/// Save a whole project atomically. Assets are written to files first (so a
/// failure aborts before the database is touched), then the project's rows are
/// replaced inside one transaction — delete its tracks (cascading to bounces and
/// comments) and reinsert everything in order. On any DB error the transaction
/// rolls back and the previously stored project is untouched.
pub fn save_project(
    connection: &mut Connection,
    project: &OrganizerProject,
    assets_dir: &Path,
) -> Result<(), String> {
    if project.id.trim().is_empty() {
        return Err("Organizer project id cannot be empty.".to_string());
    }

    // Files first, outside the transaction.
    let cover_path = match project.cover_image_data_url.as_deref() {
        Some(data_url) if data_url.starts_with("data:") => {
            let name = safe_asset_name(&project.id, "cover", "dataurl")?;
            atomic_write(&covers_dir(assets_dir), &name, data_url.as_bytes())?;
            Some(name)
        }
        _ => None,
    };

    // waveform filename per bounce id, written now so paths are known at insert.
    let mut waveform_names: std::collections::HashMap<String, String> =
        std::collections::HashMap::new();
    for track in &project.tracks {
        for bounce in &track.bounces {
            if let Some(channels) = bounce.waveform_channels.as_ref() {
                if !channels.is_empty() {
                    let name = safe_asset_name(&bounce.id, "wave", "json")?;
                    let json = serde_json::to_string(channels)
                        .map_err(|error| format!("Failed to encode waveform cache: {error}"))?;
                    atomic_write(&waveforms_dir(assets_dir), &name, json.as_bytes())?;
                    waveform_names.insert(bounce.id.clone(), name);
                }
            }
        }
    }

    let transaction = connection
        .transaction()
        .map_err(|error| format!("Failed to start organizer save transaction: {error}"))?;

    transaction
        .execute(
            "INSERT INTO organizer_projects (
                id, name, artist, release_date, notes, release_type, cover_path,
                created_at_ms, updated_at_ms
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT(id) DO UPDATE SET
                name = excluded.name,
                artist = excluded.artist,
                release_date = excluded.release_date,
                notes = excluded.notes,
                release_type = excluded.release_type,
                cover_path = excluded.cover_path,
                updated_at_ms = excluded.updated_at_ms",
            params![
                project.id,
                project.name,
                project.artist,
                project.release_date,
                project.notes,
                project.release_type,
                cover_path,
                project.created_at_ms,
                project.updated_at_ms,
            ],
        )
        .map_err(|error| format!("Failed to save organizer project: {error}"))?;

    // Replace the whole tree. Cascades delete bounces + comments.
    transaction
        .execute(
            "DELETE FROM organizer_tracks WHERE project_id = ?1",
            params![project.id],
        )
        .map_err(|error| format!("Failed to clear organizer tracks: {error}"))?;

    for (track_index, track) in project.tracks.iter().enumerate() {
        let (als_id, als_path, als_name) = match &track.als_file {
            Some(als) => (
                Some(als.id.clone()),
                Some(als.path.clone()),
                Some(als.name.clone()),
            ),
            None => (None, None, None),
        };
        transaction
            .execute(
                "INSERT INTO organizer_tracks (
                    id, project_id, position, title, comment,
                    als_id, als_path, als_name, final_bounce_id
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![
                    track.id,
                    project.id,
                    track_index as i64,
                    track.title,
                    track.comment,
                    als_id,
                    als_path,
                    als_name,
                    track.final_bounce_id,
                ],
            )
            .map_err(|error| format!("Failed to save organizer track: {error}"))?;

        for (bounce_index, bounce) in track.bounces.iter().enumerate() {
            let peaks_json = serde_json::to_string(&bounce.peaks)
                .map_err(|error| format!("Failed to encode peaks: {error}"))?;
            let waveform_path = waveform_names.get(&bounce.id).cloned();
            let waveform_cache_version = waveform_path.as_ref().map(|_| CACHE_FORMAT_VERSION);

            transaction
                .execute(
                    "INSERT INTO organizer_bounces (
                        id, track_id, position, file_name, source_path, file_size_bytes,
                        duration_sec, sample_rate, channel_count, integrated_lufs,
                        dynamic_range_lu, peak_db, peak_kind, analysis_version, volume,
                        peaks, waveform_path, waveform_points, waveform_cache_version, added_at_ms
                     ) VALUES (
                        ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10,
                        ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20
                     )",
                    params![
                        bounce.id,
                        track.id,
                        bounce_index as i64,
                        bounce.file_name,
                        bounce.source_path,
                        bounce.file_size_bytes,
                        bounce.duration_sec,
                        bounce.sample_rate,
                        bounce.channel_count,
                        bounce.integrated_lufs,
                        bounce.dynamic_range_lu,
                        bounce.peak_db,
                        bounce.peak_kind,
                        bounce.analysis_version,
                        bounce.volume,
                        peaks_json,
                        waveform_path,
                        bounce.waveform_points,
                        waveform_cache_version,
                        bounce.added_at_ms,
                    ],
                )
                .map_err(|error| format!("Failed to save organizer bounce: {error}"))?;

            for comment in &bounce.timed_comments {
                transaction
                    .execute(
                        "INSERT INTO organizer_comments (id, bounce_id, time_sec, text, created_at_ms)
                         VALUES (?1, ?2, ?3, ?4, ?5)",
                        params![
                            comment.id,
                            bounce.id,
                            comment.time_sec,
                            comment.text,
                            comment.created_at_ms,
                        ],
                    )
                    .map_err(|error| format!("Failed to save organizer comment: {error}"))?;
            }
        }
    }

    transaction
        .commit()
        .map_err(|error| format!("Failed to commit organizer save: {error}"))?;

    Ok(())
}

pub fn delete_project(
    connection: &mut Connection,
    project_id: &str,
    assets_dir: &Path,
) -> Result<(), String> {
    // Gather asset filenames before the rows disappear.
    let cover_name: Option<String> = connection
        .query_row(
            "SELECT cover_path FROM organizer_projects WHERE id = ?1",
            params![project_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()
        .map_err(|error| format!("Failed to read project cover: {error}"))?
        .flatten();

    let waveform_names: Vec<String> = {
        let mut statement = connection
            .prepare(
                "SELECT b.waveform_path
                 FROM organizer_bounces b
                 JOIN organizer_tracks t ON t.id = b.track_id
                 WHERE t.project_id = ?1 AND b.waveform_path IS NOT NULL",
            )
            .map_err(|error| format!("Failed to prepare waveform cleanup query: {error}"))?;
        let names = statement
            .query_map(params![project_id], |row| row.get::<_, String>(0))
            .map_err(|error| format!("Failed to read waveform paths: {error}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("Failed to collect waveform paths: {error}"))?;
        names
    };

    let transaction = connection
        .transaction()
        .map_err(|error| format!("Failed to start organizer delete transaction: {error}"))?;
    transaction
        .execute(
            "DELETE FROM organizer_projects WHERE id = ?1",
            params![project_id],
        )
        .map_err(|error| format!("Failed to delete organizer project: {error}"))?;
    transaction
        .commit()
        .map_err(|error| format!("Failed to commit organizer delete: {error}"))?;

    // Files last — a failed unlink must not undo a committed delete.
    for name in waveform_names {
        remove_asset(&waveforms_dir(assets_dir), &name);
    }
    if let Some(name) = cover_name {
        remove_asset(&covers_dir(assets_dir), &name);
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn memory_db() -> Connection {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch("PRAGMA foreign_keys = ON;")
            .unwrap();
        initialize_schema(&connection).unwrap();
        connection
    }

    fn temp_assets() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "recall-organizer-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn bounce(id: &str, comments: Vec<OrganizerComment>) -> OrganizerBounce {
        OrganizerBounce {
            id: id.to_string(),
            file_name: format!("{id}.wav"),
            source_path: Some(format!("C:/music/{id}.wav")),
            file_size_bytes: 1234,
            duration_sec: 200.0,
            sample_rate: 48000,
            channel_count: 2,
            peaks: vec![0.1, 0.5, 0.9],
            waveform_channels: Some(vec!["AAAA".to_string(), "BBBB".to_string()]),
            waveform_points: Some(2),
            integrated_lufs: Some(-9.5),
            dynamic_range_lu: Some(7.2),
            peak_db: -0.3,
            peak_kind: Some("true".to_string()),
            analysis_version: Some(3),
            volume: 0.8,
            added_at_ms: 1000,
            timed_comments: comments,
        }
    }

    fn sample_project(id: &str) -> OrganizerProject {
        OrganizerProject {
            id: id.to_string(),
            name: "Perseus EP".to_string(),
            artist: "Inspected".to_string(),
            release_date: "2026-08-01".to_string(),
            notes: "the concept".to_string(),
            release_type: "ep".to_string(),
            cover_image_data_url: Some("data:image/webp;base64,Zm9v".to_string()),
            tracks: vec![
                OrganizerTrack {
                    id: "track-1".to_string(),
                    title: "Intro".to_string(),
                    comment: "mix notes".to_string(),
                    als_file: Some(OrganizerAls {
                        id: "als-1".to_string(),
                        path: "C:/music/intro.als".to_string(),
                        name: "intro.als".to_string(),
                    }),
                    bounces: vec![bounce(
                        "bounce-1a",
                        vec![OrganizerComment {
                            id: "c-1".to_string(),
                            time_sec: 12.5,
                            text: "drop here".to_string(),
                            created_at_ms: 900,
                        }],
                    )],
                    final_bounce_id: Some("bounce-1a".to_string()),
                },
                OrganizerTrack {
                    id: "track-2".to_string(),
                    title: "Outro".to_string(),
                    comment: String::new(),
                    als_file: None,
                    bounces: vec![bounce("bounce-2a", vec![]), bounce("bounce-2b", vec![])],
                    final_bounce_id: Some("bounce-2b".to_string()),
                },
            ],
            created_at_ms: 500,
            updated_at_ms: 600,
        }
    }

    #[test]
    fn round_trips_a_full_project() {
        let mut db = memory_db();
        let assets = temp_assets();
        let project = sample_project("org-1");
        save_project(&mut db, &project, &assets).unwrap();

        let loaded = list_projects(&db, &assets).unwrap();
        assert_eq!(loaded.len(), 1);
        let p = &loaded[0];
        assert_eq!(p.name, "Perseus EP");
        assert_eq!(p.artist, "Inspected");
        assert_eq!(p.release_type, "ep");
        assert_eq!(p.cover_image_data_url.as_deref(), Some("data:image/webp;base64,Zm9v"));
        assert_eq!(p.tracks.len(), 2);
        assert_eq!(p.tracks[0].title, "Intro");
        assert_eq!(p.tracks[0].als_file.as_ref().unwrap().name, "intro.als");
        assert_eq!(p.tracks[0].bounces[0].integrated_lufs, Some(-9.5));
        assert_eq!(p.tracks[0].bounces[0].peaks, vec![0.1, 0.5, 0.9]);
        assert_eq!(
            p.tracks[0].bounces[0].waveform_channels.as_ref().unwrap(),
            &vec!["AAAA".to_string(), "BBBB".to_string()]
        );
        assert_eq!(p.tracks[0].bounces[0].timed_comments.len(), 1);
        assert_eq!(p.tracks[0].bounces[0].timed_comments[0].text, "drop here");
        std::fs::remove_dir_all(&assets).ok();
    }

    #[test]
    fn preserves_track_and_version_order() {
        let mut db = memory_db();
        let assets = temp_assets();
        save_project(&mut db, &sample_project("org-2"), &assets).unwrap();
        let loaded = list_projects(&db, &assets).unwrap();
        let p = &loaded[0];
        assert_eq!(p.tracks[0].id, "track-1");
        assert_eq!(p.tracks[1].id, "track-2");
        assert_eq!(p.tracks[1].bounces[0].id, "bounce-2a");
        assert_eq!(p.tracks[1].bounces[1].id, "bounce-2b");
        assert_eq!(p.tracks[1].final_bounce_id.as_deref(), Some("bounce-2b"));
        std::fs::remove_dir_all(&assets).ok();
    }

    #[test]
    fn resaving_replaces_children_without_duplicates() {
        let mut db = memory_db();
        let assets = temp_assets();
        save_project(&mut db, &sample_project("org-3"), &assets).unwrap();

        let mut edited = sample_project("org-3");
        edited.tracks.remove(1); // drop the second track
        edited.tracks[0].title = "Renamed".to_string();
        save_project(&mut db, &edited, &assets).unwrap();

        let loaded = list_projects(&db, &assets).unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].tracks.len(), 1);
        assert_eq!(loaded[0].tracks[0].title, "Renamed");

        // Orphaned rows must be gone, not merely hidden.
        let track_count: i64 = db
            .query_row("SELECT COUNT(*) FROM organizer_tracks", [], |r| r.get(0))
            .unwrap();
        let bounce_count: i64 = db
            .query_row("SELECT COUNT(*) FROM organizer_bounces", [], |r| r.get(0))
            .unwrap();
        assert_eq!(track_count, 1);
        assert_eq!(bounce_count, 1);
        std::fs::remove_dir_all(&assets).ok();
    }

    #[test]
    fn delete_cascades_to_tracks_bounces_and_comments() {
        let mut db = memory_db();
        let assets = temp_assets();
        save_project(&mut db, &sample_project("org-4"), &assets).unwrap();
        delete_project(&mut db, "org-4", &assets).unwrap();

        assert!(list_projects(&db, &assets).unwrap().is_empty());
        for table in [
            "organizer_tracks",
            "organizer_bounces",
            "organizer_comments",
        ] {
            let count: i64 = db
                .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
                .unwrap();
            assert_eq!(count, 0, "{table} should be empty after cascade delete");
        }
        std::fs::remove_dir_all(&assets).ok();
    }

    #[test]
    fn missing_waveform_cache_is_not_fatal() {
        let mut db = memory_db();
        let assets = temp_assets();
        save_project(&mut db, &sample_project("org-5"), &assets).unwrap();
        // Wipe the waveform cache: metadata must survive, channels become None.
        std::fs::remove_dir_all(waveforms_dir(&assets)).ok();
        let loaded = list_projects(&db, &assets).unwrap();
        let b = &loaded[0].tracks[0].bounces[0];
        assert!(b.waveform_channels.is_none());
        assert_eq!(b.integrated_lufs, Some(-9.5));
        assert_eq!(b.peaks, vec![0.1, 0.5, 0.9]);
        std::fs::remove_dir_all(&assets).ok();
    }

    #[test]
    fn rejects_unsafe_asset_names() {
        assert!(safe_asset_name("../../etc/passwd", "wave", "json")
            .unwrap()
            .starts_with("wave-"));
        assert!(safe_asset_name("...", "wave", "json").is_err());
        assert!(resolve_in_dir(Path::new("/cache"), "../escape.json").is_err());
        assert!(resolve_in_dir(Path::new("/cache"), "a/b.json").is_err());
        assert!(resolve_in_dir(Path::new("/cache"), "ok.json").is_ok());
    }

    #[test]
    fn empty_project_id_is_rejected() {
        let mut db = memory_db();
        let assets = temp_assets();
        let mut project = sample_project("org-6");
        project.id = "   ".to_string();
        assert!(save_project(&mut db, &project, &assets).is_err());
        std::fs::remove_dir_all(&assets).ok();
    }
}
