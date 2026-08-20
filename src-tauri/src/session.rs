use crate::protocol::RecallEvent;
use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Serialize)]
pub struct SessionStatus {
    pub active: bool,
    pub session_id: Option<String>,
    pub started_at_ms: Option<u64>,
    pub ended_at_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SavedSessionMetadata {
    pub id: String,
    pub name: String,
    pub project_id: Option<String>,
    pub capture_name: Option<String>,
    pub capture_status: String,
    pub project_name: Option<String>,
    pub project_path: Option<String>,
    // The specific `.als` file this take is anchored to (its durable identity for
    // resume/relink), and whether the take was `recorded` (has live telemetry) or
    // `scanned` (a version found on disk by a folder scan, no events yet).
    pub als_path: Option<String>,
    pub take_origin: String,
    pub display_name: Option<String>,
    pub started_at_ms: u64,
    pub ended_at_ms: Option<u64>,
    pub last_updated_at_ms: u64,
    pub event_count: usize,
    pub creative_event_count: usize,
    pub heartbeat_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SavedSession {
    pub id: String,
    pub name: String,
    pub project_id: Option<String>,
    pub capture_name: Option<String>,
    pub capture_status: String,
    pub project_name: Option<String>,
    pub project_path: Option<String>,
    pub als_path: Option<String>,
    pub take_origin: String,
    pub display_name: Option<String>,
    pub started_at_ms: u64,
    pub ended_at_ms: Option<u64>,
    pub last_updated_at_ms: u64,
    pub event_count: usize,
    pub creative_event_count: usize,
    pub heartbeat_count: usize,
    pub events: Vec<SavedSessionEvent>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectFolderMetadata {
    pub created_at_ms: Option<u64>,
    pub modified_at_ms: Option<u64>,
    pub latest_file_modified_at_ms: Option<u64>,
    pub file_count: usize,
    pub total_size_bytes: u64,
    pub als_file_count: usize,
    pub audio_file_count: usize,
    pub scanned_at_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SavedProject {
    pub id: String,
    pub display_name: String,
    pub ableton_name: Option<String>,
    pub ableton_path: Option<String>,
    pub archived_at_ms: Option<u64>,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
    pub last_updated_at_ms: u64,
    pub capture_count: usize,
    pub active_capture_count: usize,
    pub captures: Vec<SavedSessionMetadata>,
    /// A cached snapshot of the connected Windows folder. This is refreshed by
    /// an explicit scan rather than every library poll, because traversing a
    /// sample-heavy Ableton project can be expensive.
    pub folder_metadata: Option<ProjectFolderMetadata>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SavedSessionEvent {
    pub id: String,
    #[serde(rename = "type")]
    pub event_type: String,
    pub timestamp_ms: u64,
    pub summary: Option<String>,
    pub title: String,
    pub description: String,
    pub source: String,
    pub payload: Option<String>,
    pub session_id: Option<String>,
    // Canonical structured fields, mirrored from the `events` table columns. These
    // are populated first-class on load (with a payload fallback for legacy rows)
    // so a reloaded session is as rich as it was live — no payload digging needed.
    // `track`/`device`/`parameter` keep their short names for frontend back-compat;
    // they hold the track_name / device_name / parameter_name values.
    pub track: Option<String>,
    pub track_type: Option<String>,
    pub device: Option<String>,
    pub device_chain: Option<String>,
    pub parameter: Option<String>,
    pub parameter_value: Option<f64>,
    pub previous_parameter_value: Option<f64>,
    pub parameter_value_percent: Option<f64>,
    pub previous_parameter_value_percent: Option<f64>,
    // Live-formatted display: mode name for quantized params ("Sinefold"), or the
    // unit-bearing value for continuous ones ("440 Hz"). parameter_is_quantized
    // distinguishes the two so the UI can render a mode label vs a numeric value.
    pub parameter_display_value: Option<String>,
    pub previous_parameter_display_value: Option<String>,
    pub parameter_is_quantized: Option<bool>,
    pub clip_name: Option<String>,
    pub sample_name: Option<String>,
    pub file_path: Option<String>,
    pub bpm: Option<f64>,
    pub playing: Option<bool>,
    pub observed_arrangement_position: Option<String>,
    pub observed_arrangement_beats: Option<f64>,
    pub arrangement_start_beats: Option<f64>,
    pub arrangement_end_beats: Option<f64>,
    pub is_heartbeat: bool,
}

impl From<RecallEvent> for SavedSessionEvent {
    fn from(event: RecallEvent) -> Self {
        let is_heartbeat = event.event_type == "heartbeat";

        Self {
            id: format!(
                "{}-{}-{}",
                event.session_id.as_deref().unwrap_or("unsaved-session"),
                event.event_type,
                event.timestamp_ms
            ),
            event_type: event.event_type,
            timestamp_ms: event.timestamp_ms,
            summary: Some(event.title.clone()),
            title: event.title,
            description: event.description,
            source: event.source,
            payload: event.payload,
            session_id: event.session_id,
            // Carry the structured fields through instead of dropping them.
            track: event.track_name,
            track_type: event.track_type,
            device: event.device_name,
            device_chain: event.device_chain,
            parameter: event.parameter_name,
            parameter_value: event.parameter_value,
            previous_parameter_value: event.previous_parameter_value,
            parameter_value_percent: event.parameter_value_percent,
            previous_parameter_value_percent: event.previous_parameter_value_percent,
            parameter_display_value: event.parameter_display_value,
            previous_parameter_display_value: event.previous_parameter_display_value,
            parameter_is_quantized: event.parameter_is_quantized,
            clip_name: event.clip_name,
            sample_name: event.sample_name,
            file_path: event.file_path,
            bpm: event.bpm,
            playing: event.playing,
            observed_arrangement_position: event.observed_arrangement_position,
            observed_arrangement_beats: event.observed_arrangement_beats,
            arrangement_start_beats: event.arrangement_start_beats,
            arrangement_end_beats: event.arrangement_end_beats,
            is_heartbeat,
        }
    }
}

#[derive(Debug, Clone)]
pub struct SessionState {
    active: bool,
    session_id: Option<String>,
    started_at_ms: Option<u64>,
    ended_at_ms: Option<u64>,
    // The timestamp of the most recent CAPTURED event assigned to this take —
    // never a heartbeat, which proves only that Ableton is open, not that the
    // producer did anything. This is the in-memory clock rotate_session_if_stale
    // reads on every incoming packet; it is cheap (no DB round trip) precisely
    // because it is only ever updated here, not queried fresh each time.
    //
    // Seeded from storage at resume (see resolve_resumed_session), not left at
    // None, so a session that was legitimately active five minutes before this
    // process started doesn't read as having zero activity and immediately
    // qualify as idle again.
    last_event_at_ms: Option<u64>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("System time error")
        .as_millis() as u64
}

/// How long a take may sit with no captured activity before it counts as
/// abandoned rather than merely quiet.
///
/// WHY THIS EXISTS: nothing used to end a take except a deliberate user action
/// (New Take, End Take, switching projects). Close Recall mid-session on Friday,
/// reopen it Monday, and Monday's work landed in Friday's take — there was no
/// boundary at all (issue #13). Two independent mechanisms both key off this one
/// constant: `resolve_resumed_session` in storage.rs (does the take we're about
/// to resume at app start look abandoned?) and `rotate_session_if_stale` in
/// udp_listener.rs (has the take we're actively writing into gone idle while the
/// app stayed open?). One number, one mental model, instead of two clocks that
/// could quietly drift apart.
///
/// Four hours: long enough that a mixing session with a lunch break, or a
/// producer sitting on one idea for a while, doesn't get split up underneath
/// them; short enough that it reliably represents a day boundary rather than a
/// pause.
pub const STALE_SESSION_IDLE_MS: u64 = 4 * 60 * 60 * 1000;

impl SessionState {
    pub fn new() -> Self {
        Self {
            active: false,
            session_id: None,
            started_at_ms: None,
            ended_at_ms: None,
            last_event_at_ms: None,
        }
    }

    pub fn start(&mut self) -> SessionStatus {
        if self.active {
            return self.status();
        }

        let started_at_ms = now_ms();

        self.active = true;
        self.session_id = Some(format!("session-{}", started_at_ms));
        self.started_at_ms = Some(started_at_ms);
        self.ended_at_ms = None;
        // A freshly started take's only known activity is starting it.
        self.last_event_at_ms = Some(started_at_ms);

        self.status()
    }

    /// Resume a take that was already running, seeding the idle clock from
    /// storage's record of its real activity rather than leaving it at None
    /// (which `is_stale` would have to special-case) or `now_ms()` (which would
    /// hand every resumed take a fresh four-hour grace period regardless of how
    /// long it had actually been quiet).
    ///
    /// `last_event_at_ms` should be the take's most recent captured-event
    /// timestamp if it has one, else its `started_at_ms` — see
    /// `storage::session_last_activity_ms`.
    pub fn restore_active(
        &mut self,
        session_id: String,
        started_at_ms: u64,
        last_event_at_ms: u64,
    ) -> SessionStatus {
        self.active = true;
        self.session_id = Some(session_id);
        self.started_at_ms = Some(started_at_ms);
        self.ended_at_ms = None;
        self.last_event_at_ms = Some(last_event_at_ms);

        self.status()
    }

    pub fn stop(&mut self) -> SessionStatus {
        self.stop_at(now_ms())
    }

    /// Stop with an explicit end time rather than `now()`.
    ///
    /// Exists for exactly one caller today: closing a take discovered to be
    /// stale. Backdating to its LAST REAL ACTIVITY rather than the moment we
    /// happened to notice is what stops a take resumed after a weekend from
    /// reporting a 60-hour duration — the take ended when the producer stopped
    /// touching it, not when Recall got around to checking.
    pub fn stop_at(&mut self, ended_at_ms: u64) -> SessionStatus {
        if !self.active {
            return self.status();
        }

        self.active = false;
        self.ended_at_ms = Some(ended_at_ms);

        self.status()
    }

    /// Record that a real (non-heartbeat) event just landed in this take.
    ///
    /// `max` against the existing value, not an unconditional overwrite: a
    /// delayed or out-of-order packet must never be able to regress the idle
    /// clock backwards and make an active take look older than it is.
    pub fn note_activity(&mut self, timestamp_ms: u64) {
        if !self.active {
            return;
        }
        self.last_event_at_ms = Some(match self.last_event_at_ms {
            Some(existing) => existing.max(timestamp_ms),
            None => timestamp_ms,
        });
    }

    /// Whether this take has gone quiet for long enough to count as abandoned.
    ///
    /// A session with no recorded activity at all (should not happen given
    /// `start`/`restore_active` always set one, but this is state a reviewer
    /// should be able to trust without re-deriving the invariant) is never
    /// judged stale — there is nothing to measure the gap from.
    pub fn is_stale(&self, now_ms: u64) -> bool {
        self.active
            && self
                .last_event_at_ms
                .is_some_and(|last| now_ms.saturating_sub(last) >= STALE_SESSION_IDLE_MS)
    }

    /// The take's own last-known activity, for backdating `stop_at` when
    /// `is_stale` says it should be closed — the take ended when the producer
    /// stopped touching it, not at whatever moment something got around to
    /// checking.
    pub fn last_activity_ms(&self) -> Option<u64> {
        self.last_event_at_ms
    }

    pub fn status(&self) -> SessionStatus {
        SessionStatus {
            active: self.active,
            session_id: self.session_id.clone(),
            started_at_ms: self.started_at_ms,
            ended_at_ms: self.ended_at_ms,
        }
    }

    pub fn active_session_id(&self) -> Option<String> {
        if self.active {
            return self.session_id.clone();
        }

        None
    }
}

#[cfg(test)]
mod tests {
    //! `SessionState` had no tests at all before this. These cover the idle
    //! clock added for issue #13 (a take that runs for days because nothing
    //! ever closed it), plus enough of the pre-existing start/stop/restore
    //! surface that the new tests aren't building fixtures on unverified
    //! ground.

    use super::*;

    const HOUR_MS: u64 = 60 * 60 * 1000;

    #[test]
    fn a_freshly_started_session_is_not_stale() {
        let mut session = SessionState::new();
        let status = session.start();
        let now = status.started_at_ms.unwrap();

        assert!(!session.is_stale(now));
    }

    #[test]
    fn a_session_that_has_never_started_is_never_stale() {
        // Nothing to measure a gap from — is_stale must not panic or guess.
        let session = SessionState::new();
        assert!(!session.is_stale(u64::MAX));
    }

    #[test]
    fn a_session_becomes_stale_exactly_at_the_idle_threshold() {
        let mut session = SessionState::new();
        let status = session.start();
        let started = status.started_at_ms.unwrap();

        assert!(!session.is_stale(started + STALE_SESSION_IDLE_MS - 1));
        assert!(session.is_stale(started + STALE_SESSION_IDLE_MS));
    }

    #[test]
    fn note_activity_resets_the_idle_clock() {
        let mut session = SessionState::new();
        let status = session.start();
        let started = status.started_at_ms.unwrap();

        // Without any activity this would be stale...
        assert!(session.is_stale(started + STALE_SESSION_IDLE_MS));

        // ...but a real event two hours in moves the baseline forward, so the
        // take is not stale until four hours PAST THAT.
        let touched_at = started + 2 * HOUR_MS;
        session.note_activity(touched_at);

        assert!(!session.is_stale(touched_at + STALE_SESSION_IDLE_MS - 1));
        assert!(session.is_stale(touched_at + STALE_SESSION_IDLE_MS));
    }

    #[test]
    fn note_activity_cannot_move_the_clock_backwards() {
        // A delayed or out-of-order packet must never regress the idle clock
        // and make an active take look older (more stale) than it is.
        let mut session = SessionState::new();
        let status = session.start();
        let started = status.started_at_ms.unwrap();

        session.note_activity(started + 3 * HOUR_MS);
        session.note_activity(started + 1 * HOUR_MS); // arrives "late"

        // If the older timestamp had won, this would already read stale.
        assert!(!session.is_stale(started + 3 * HOUR_MS + STALE_SESSION_IDLE_MS - 1));
    }

    #[test]
    fn note_activity_is_a_no_op_when_nothing_is_active() {
        let mut session = SessionState::new();
        session.note_activity(123);
        assert_eq!(session.last_activity_ms(), None);
    }

    #[test]
    fn stop_at_backdates_the_end_time_rather_than_using_now() {
        // The whole point: a take resumed after a weekend away must report
        // when the producer actually stopped touching it, not the moment
        // something got around to checking.
        let mut session = SessionState::new();
        let status = session.start();
        let started = status.started_at_ms.unwrap();

        let backdated = started + 5 * HOUR_MS;
        let stopped = session.stop_at(backdated);

        assert_eq!(stopped.ended_at_ms, Some(backdated));
        assert!(!stopped.active);
    }

    #[test]
    fn stopping_an_inactive_session_is_a_harmless_no_op() {
        let mut session = SessionState::new();
        let before = session.status();
        let after = session.stop_at(999);
        assert_eq!(before.ended_at_ms, after.ended_at_ms);
    }

    #[test]
    fn restore_active_seeds_the_idle_clock_from_the_given_value() {
        // The seed matters: without it, a session resumed at boot would read
        // as having zero activity and could immediately look stale (if seeded
        // with None) or get a fresh four-hour grace period it hasn't earned
        // (if seeded with now()) instead of reflecting when it was truly last
        // touched.
        let mut session = SessionState::new();
        let last_activity = 1_700_000_000_000u64;
        session.restore_active("session-123".to_string(), 1_699_999_000_000, last_activity);

        assert_eq!(session.last_activity_ms(), Some(last_activity));
        assert!(!session.is_stale(last_activity + STALE_SESSION_IDLE_MS - 1));
        assert!(session.is_stale(last_activity + STALE_SESSION_IDLE_MS));
    }

    // `rotate_session_if_stale` runs on every incoming packet and closes the take
    // whenever this reads true. If staleness ever stopped being gated on `active`,
    // an already-stopped take would qualify forever and every subsequent heartbeat
    // would close-and-recreate a take — a rotation loop that shreds history into
    // one-packet fragments. The `active` guard is what prevents that.
    #[test]
    fn a_stopped_session_is_never_stale_however_long_it_sits() {
        let mut session = SessionState::new();
        let status = session.start();
        let started = status.started_at_ms.unwrap();

        session.stop_at(started);

        assert!(!session.is_stale(started + STALE_SESSION_IDLE_MS));
        assert!(!session.is_stale(u64::MAX));
    }

    // Starting an already-running take must hand back the SAME take, not mint a
    // fresh id. A new id here would leave the in-memory session pointing at a take
    // the previous events were never written to, orphaning everything captured so
    // far — and it must not reset the idle clock either, or a take could be kept
    // alive indefinitely by repeated starts.
    #[test]
    fn starting_an_already_active_session_returns_the_same_take() {
        let mut session = SessionState::new();
        let first = session.start();
        let started = first.started_at_ms.unwrap();

        session.note_activity(started + HOUR_MS);
        let second = session.start();

        assert_eq!(first.session_id, second.session_id);
        assert_eq!(first.started_at_ms, second.started_at_ms);
        assert_eq!(session.last_activity_ms(), Some(started + HOUR_MS));
    }

    #[test]
    fn active_session_id_is_none_once_stopped() {
        let mut session = SessionState::new();
        session.start();
        assert!(session.active_session_id().is_some());

        session.stop();
        assert_eq!(session.active_session_id(), None);
    }
}
