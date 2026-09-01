//! # Event Catalog — the single source of truth for the Recall event vocabulary
//!
//! Every kind of thing the bridge can report (a track being created, a sample
//! being dropped in, automation being written, …) is one row in [`CATALOG`].
//!
//! ## Why this module exists
//!
//! The backend needs three pieces of static knowledge about each `event_type`:
//!   1. its **priority** — whether it may be shed when the ingest queue saturates,
//!   2. a fallback **title**, and
//!   3. a fallback **description**
//!
//! Previously those three lived in three separate `match` blocks in
//! `udp_listener.rs`. Adding one event meant editing all three, and they drifted.
//! Now each event is declared **once** here, as data. Adding an event is a single
//! new row — no new code paths, no scattered handlers to keep in sync.
//!
//! ## Scope of this table
//!
//! The catalog is intentionally *complete*: it lists events the bridge emits today
//! **and** events we plan to capture (mixing moves, scenes, warp changes, freeze/
//! flatten, …). Listing a planned event here is free — it simply means that the day
//! the bridge starts emitting it, the backend already classifies, titles, and
//! describes it correctly with zero code changes.
//!
//! The wire contract these strings belong to is documented for humans in
//! `docs/recall-protocol-v2.md`. Keep the two in step.

/// How aggressively an event may be dropped when the ingest queue is saturated.
///
/// This is the backend's overload-shedding policy. Under a burst that fills the
/// bounded channel between the UDP receive loop and the persistence worker, we
/// must protect the events a producer would notice losing (a device add, a sample
/// drop) and may discard cheap, re-derivable telemetry (a transport snapshot).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EventPriority {
    /// A deliberate creative action or a lifecycle marker. **Never dropped** —
    /// losing one loses a real moment from the producer's session story.
    Critical,
    /// Meaningful context worth keeping unless the queue is truly saturated.
    Important,
    /// High-frequency or re-derivable telemetry. **First to be shed** under load.
    Coalescible,
}

/// One row of the catalog: everything the backend statically knows about a single
/// `event_type` string arriving on the wire.
pub struct EventDef {
    /// Exact wire string emitted by the bridge — lowercase `snake_case`.
    pub event_type: &'static str,
    /// Overload-shedding priority (see [`EventPriority`]).
    pub priority: EventPriority,
    /// Fallback human title, used only when the bridge didn't send its own.
    pub title: &'static str,
    /// Fallback human description, used only when the bridge didn't send its own.
    pub description: &'static str,
}

// A small constructor keeps each catalog row to a single readable line below.
const fn def(
    event_type: &'static str,
    priority: EventPriority,
    title: &'static str,
    description: &'static str,
) -> EventDef {
    EventDef {
        event_type,
        priority,
        title,
        description,
    }
}

use EventPriority::{Coalescible, Critical, Important};

/// The complete event vocabulary, grouped by domain.
///
/// Lookup is a linear scan (see [`lookup`]). The table is small (well under a few
/// hundred rows) and lookups happen once per ingested event at human interaction
/// rates, so a scan is far simpler than a hash map and costs nothing measurable.
pub static CATALOG: &[EventDef] = &[
    // ── Bridge lifecycle ────────────────────────────────────────────────────
    // Connection health and start/stop bookends. Heartbeats are handled before
    // the queue (never persisted); the rest bracket a capture session in the DB.
    def(
        "heartbeat",
        Coalescible,
        "Heartbeat Received",
        "Heartbeat received from the Max for Live bridge.",
    ),
    def(
        "device_loaded",
        Important,
        "Bridge Loaded",
        "The Max for Live bridge initialized.",
    ),
    def(
        "bridge_started",
        Critical,
        "Ableton Bridge Started",
        "The Max for Live bridge started sending telemetry.",
    ),
    def(
        "bridge_stopped",
        Critical,
        "Ableton Bridge Stopped",
        "The Max for Live bridge stopped sending telemetry.",
    ),
    // ── Transport & tempo ───────────────────────────────────────────────────
    // Play/stop are kept (Important) for analytics but the frontend hides them
    // from the curated timeline. Snapshots are pure context and shed first.
    def(
        "transport_play",
        Important,
        "Playback Started",
        "Ableton playback started.",
    ),
    def(
        "transport_stop",
        Important,
        "Playback Stopped",
        "Ableton playback stopped.",
    ),
    def(
        "transport_snapshot",
        Coalescible,
        "Transport Snapshot",
        "Ableton transport state changed.",
    ),
    def(
        "transport_changed",
        Coalescible,
        "Transport Changed",
        "Ableton transport state changed.",
    ),
    def(
        "playback_state_changed",
        Coalescible,
        "Playback State Changed",
        "Ableton playback state changed.",
    ),
    def(
        "beat_time_changed",
        Coalescible,
        "Beat Time Changed",
        "Ableton beat position changed.",
    ),
    def(
        "tempo_changed",
        Important,
        "Tempo Changed",
        "Ableton tempo changed.",
    ),
    def(
        "signature_changed",
        Important,
        "Meter Changed",
        "The Live Set time signature changed.",
    ),
    def(
        "scale_changed",
        Important,
        "Key or Scale Changed",
        "The Live Set key or scale changed.",
    ),
    def(
        "swing_changed",
        Important,
        "Swing Changed",
        "The Live Set swing amount changed.",
    ),
    def(
        "groove_changed",
        Important,
        "Groove Changed",
        "The Live Set groove amount changed.",
    ),
    def(
        "metronome_toggled",
        Coalescible,
        "Metronome Toggled",
        "The metronome was toggled.",
    ),
    def(
        "loop_toggled",
        Coalescible,
        "Loop Toggled",
        "The arrangement loop was toggled.",
    ),
    def(
        "recording_state_changed",
        Important,
        "Recording State Changed",
        "Ableton recording state changed.",
    ),
    // ── Track lifecycle ─────────────────────────────────────────────────────
    // Selection/focus is navigation (Coalescible, hidden downstream). Everything
    // else is a deliberate structural act and is Critical. Freeze/flatten mark
    // "point of no return" decisions a producer will want to find later.
    def(
        "track_selected",
        Coalescible,
        "Track Selected",
        "Ableton selected track changed.",
    ),
    def(
        "selected_track_focus_snapshot",
        Coalescible,
        "Track Focus Snapshot",
        "Focused detail captured for the selected track.",
    ),
    // Navigation, not authorship — the producer moved their attention, they did
    // not change the set. Coalescible for the same reason track_selected is: it
    // is high-frequency, re-derivable, and must never crowd out a real edit.
    def(
        "focus_changed",
        Coalescible,
        "Focus Changed",
        "The focused track or device changed in Ableton.",
    ),
    def(
        "track_created",
        Critical,
        "Track Created",
        "A track was created in Ableton.",
    ),
    def(
        "track_deleted",
        Critical,
        "Track Deleted",
        "A track was deleted in Ableton.",
    ),
    // The bridge's coarse structural signal: it fires when the set's track list
    // changes at all, without saying which track. Critical for the same reason
    // track_created/track_deleted are — it is the only notice some structural
    // edits give, and a producer would notice losing one. (Until this row existed
    // it fell through to the unknown-event default, Coalescible, which made a
    // structural change the FIRST thing shed under load.)
    def(
        "track_list_changed",
        Critical,
        "Track List Changed",
        "Tracks were added to or removed from the set.",
    ),
    def(
        "track_name_changed",
        Critical,
        "Track Renamed",
        "A track was renamed in Ableton.",
    ),
    def(
        "track_duplicated",
        Critical,
        "Track Duplicated",
        "A track was duplicated in Ableton.",
    ),
    def(
        "track_muted",
        Critical,
        "Track Muted",
        "A track was muted in Ableton.",
    ),
    def(
        "track_unmuted",
        Critical,
        "Track Unmuted",
        "A track was unmuted in Ableton.",
    ),
    def(
        "track_soloed",
        Critical,
        "Track Soloed",
        "A track was soloed in Ableton.",
    ),
    def(
        "track_unsoloed",
        Critical,
        "Track Unsoloed",
        "A track was unsoloed in Ableton.",
    ),
    def(
        "track_armed",
        Critical,
        "Track Armed",
        "A track was armed for recording in Ableton.",
    ),
    def(
        "track_unarmed",
        Critical,
        "Track Unarmed",
        "A track was unarmed in Ableton.",
    ),
    def(
        "track_frozen",
        Critical,
        "Track Frozen",
        "A track was frozen in Ableton.",
    ),
    def(
        "track_flattened",
        Critical,
        "Track Flattened",
        "A frozen track was flattened to audio in Ableton.",
    ),
    def(
        "track_unfrozen",
        Important,
        "Track Unfrozen",
        "A frozen track was thawed back to its instrument in Ableton.",
    ),
    def(
        "track_color_changed",
        Coalescible,
        "Track Color Changed",
        "A track's color changed in Ableton.",
    ),
    // ── Groups & routing ────────────────────────────────────────────────────
    def(
        "group_focused",
        Coalescible,
        "Group Focused",
        "A group track was focused.",
    ),
    def(
        "tracks_grouped",
        Critical,
        "Tracks Grouped",
        "Tracks were grouped in Ableton.",
    ),
    def(
        "track_ungrouped",
        Critical,
        "Tracks Ungrouped",
        "A track group was dissolved in Ableton.",
    ),
    def(
        "return_track_added",
        Critical,
        "Return Track Added",
        "A return track was added in Ableton.",
    ),
    def(
        "track_routing_changed",
        Important,
        "Routing Changed",
        "A track's input or output routing changed.",
    ),
    // ── Devices: instruments & effects ──────────────────────────────────────
    def(
        "device_added",
        Critical,
        "Device Added",
        "A device was added to a track.",
    ),
    def(
        "device_removed",
        Critical,
        "Device Removed",
        "A device was removed from a track.",
    ),
    def(
        "device_chain_changed",
        Critical,
        "Signal Chain Changed",
        "The device chain on a track changed.",
    ),
    def(
        "device_event",
        Coalescible,
        "Device Event",
        "Ableton device event received.",
    ),
    def(
        "device_selected",
        Important,
        "Device Selected",
        "Ableton selected device changed.",
    ),
    def(
        "device_toggled",
        Important,
        "Device Toggled",
        "A device was turned on or off.",
    ),
    def(
        "device_preset_changed",
        Important,
        "Preset Changed",
        "A device preset was changed.",
    ),
    def(
        "macro_mapped",
        Important,
        "Macro Mapped",
        "A macro control was mapped to a parameter.",
    ),
    def(
        "rack_variation_stored",
        Important,
        "Rack Variation Stored",
        "A device rack variation was stored.",
    ),
    def(
        "rack_variation_recalled",
        Important,
        "Rack Variation Recalled",
        "A device rack variation was recalled.",
    ),
    def(
        "rack_variation_deleted",
        Important,
        "Rack Variation Deleted",
        "A device rack variation was deleted.",
    ),
    // ── Parameters & automation ─────────────────────────────────────────────
    // Live parameter moves are already debounced at the bridge, so keep them
    // durable under queue pressure. Writing automation is a creative decision
    // and is Critical.
    def(
        "parameter_changed",
        Important,
        "Parameter Changed",
        "A device parameter was adjusted.",
    ),
    def(
        "device_parameter_changed",
        Important,
        "Parameter Changed",
        "A device parameter was adjusted.",
    ),
    def(
        "automation_created",
        Critical,
        "Automation Created",
        "Automation was written on a parameter in Ableton.",
    ),
    def(
        "automation_edited",
        Important,
        "Automation Edited",
        "Existing automation was edited in Ableton.",
    ),
    def(
        "automation_deleted",
        Coalescible,
        "Automation Deleted",
        "Automation was removed from a parameter in Ableton.",
    ),
    // ── Clips & samples ─────────────────────────────────────────────────────
    // Creation/import is Critical (a composition moment). Launch/stop are
    // performance gestures and shed first. sample_added carries the file name.
    def(
        "clip_created",
        Critical,
        "Clip Created",
        "A clip was created in Ableton.",
    ),
    def(
        "clip_deleted",
        Critical,
        "Clip Deleted",
        "A clip was deleted in Ableton.",
    ),
    def(
        "sample_added",
        Critical,
        "Sample Added",
        "A sample was added to a track in Ableton.",
    ),
    def(
        "audio_clip_added",
        Critical,
        "Audio Clip Added",
        "An audio clip was added to a track in Ableton.",
    ),
    def(
        "midi_clip_created",
        Critical,
        "MIDI Clip Created",
        "A MIDI clip was created in Ableton.",
    ),
    def(
        "audio_clip_recorded",
        Critical,
        "Audio Recorded",
        "Audio was recorded into an armed Ableton track.",
    ),
    def(
        "midi_clip_recorded",
        Critical,
        "MIDI Recorded",
        "MIDI was recorded into an armed Ableton track.",
    ),
    def(
        "clip_notes_changed",
        Critical,
        "Notes Changed",
        "The notes in a MIDI clip were edited in Ableton.",
    ),
    def(
        "clip_launched",
        Important,
        "Clip Launched",
        "An Ableton clip was launched.",
    ),
    def(
        "clip_stopped",
        Coalescible,
        "Clip Stopped",
        "An Ableton clip was stopped.",
    ),
    def(
        "clip_renamed",
        Important,
        "Clip Renamed",
        "A clip was renamed in Ableton.",
    ),
    def(
        "clip_moved",
        Coalescible,
        "Clip Moved",
        "A clip was moved in the arrangement.",
    ),
    def(
        "clip_duplicated",
        Important,
        "Clip Duplicated",
        "A clip was duplicated in Ableton.",
    ),
    def(
        "clip_recording_started",
        Critical,
        "Clip Recording Started",
        "Ableton clip recording started.",
    ),
    def(
        "clip_recording_stopped",
        Critical,
        "Clip Recording Stopped",
        "Ableton clip recording stopped.",
    ),
    def(
        "warp_mode_changed",
        Important,
        "Warp Mode Changed",
        "A clip's warp mode changed in Ableton.",
    ),
    def(
        "warp_markers_changed",
        Important,
        "Warp Markers Changed",
        "An audio clip's warp timing changed in Ableton.",
    ),
    def(
        "clip_gain_changed",
        Important,
        "Clip Gain Changed",
        "An audio clip's gain changed in Ableton.",
    ),
    def(
        "clip_pitch_changed",
        Important,
        "Clip Pitch Changed",
        "An audio clip's pitch changed in Ableton.",
    ),
    def(
        "clip_loop_changed",
        Important,
        "Clip Loop Changed",
        "An audio clip's loop changed in Ableton.",
    ),
    def(
        "clip_markers_changed",
        Important,
        "Clip Boundaries Changed",
        "An audio clip's start or end marker changed in Ableton.",
    ),
    def(
        "audio_clip_changed",
        Important,
        "Audio Clip Changed",
        "An audio clip property changed in Ableton.",
    ),
    def(
        "clip_consolidated",
        Important,
        "Clip Consolidated",
        "Clips were consolidated in Ableton.",
    ),
    def(
        "clip_event",
        Coalescible,
        "Clip Event",
        "Ableton clip event received.",
    ),
    // ── Scenes & session performance ────────────────────────────────────────
    def(
        "scene_launched",
        Important,
        "Scene Launched",
        "An Ableton scene was launched.",
    ),
    def(
        "scene_changed",
        Coalescible,
        "Scene Changed",
        "Ableton scene selection changed.",
    ),
    def(
        "scene_created",
        Critical,
        "Scene Created",
        "A scene was created in Ableton.",
    ),
    def(
        "scene_renamed",
        Important,
        "Scene Renamed",
        "A scene was renamed in Ableton.",
    ),
    def(
        "scene_deleted",
        Important,
        "Scene Deleted",
        "A scene was deleted in Ableton.",
    ),
    def(
        "follow_action_fired",
        Coalescible,
        "Follow Action",
        "A clip follow action fired in Ableton.",
    ),
    // ── Mixing ──────────────────────────────────────────────────────────────
    // The bridge settles continuous fader gestures before emitting, so each
    // event is one intentional mix move rather than high-frequency telemetry.
    def(
        "volume_changed",
        Important,
        "Volume Changed",
        "A track's volume changed.",
    ),
    def(
        "pan_changed",
        Important,
        "Pan Changed",
        "A track's pan changed.",
    ),
    def(
        "send_changed",
        Important,
        "Send Changed",
        "A track send level changed.",
    ),
    def(
        "crossfader_changed",
        Coalescible,
        "Crossfader Changed",
        "The crossfader position changed.",
    ),
    def(
        "crossfade_assignment_changed",
        Important,
        "Crossfade Assignment Changed",
        "A track's crossfade assignment changed.",
    ),
    // ── Recording ───────────────────────────────────────────────────────────
    def(
        "recording_started",
        Critical,
        "Recording Started",
        "Recording started in Ableton.",
    ),
    def(
        "recording_stopped",
        Critical,
        "Recording Stopped",
        "Recording stopped in Ableton.",
    ),
    def(
        "take_comped",
        Important,
        "Take Comped",
        "A take was comped in Ableton.",
    ),
    // ── Session, project & arrangement ──────────────────────────────────────
    def(
        "live_set_snapshot",
        Important,
        "Live Set Snapshot",
        "Ableton live set snapshot received.",
    ),
    def(
        "session_snapshot",
        Critical,
        "Session Snapshot",
        "Ableton session snapshot received.",
    ),
    def(
        "session_snapshot_started",
        Important,
        "Session Snapshot Started",
        "Manual deep session snapshot started.",
    ),
    def(
        "session_snapshot_completed",
        Important,
        "Session Snapshot Completed",
        "Manual deep session snapshot completed.",
    ),
    def(
        "project_context",
        Important,
        "Project Name Captured",
        "Ableton project name captured.",
    ),
    def(
        "project_saved",
        Important,
        "Project Saved",
        "The Live Set was saved.",
    ),
    def(
        "project_file_changed",
        Important,
        "Project File Changed",
        "Ableton project file activity was detected.",
    ),
    def(
        "cue_point_added",
        Important,
        "Song Section Marked",
        "A locator was added to the Arrangement.",
    ),
    def(
        "cue_point_renamed",
        Important,
        "Song Section Renamed",
        "An Arrangement locator was renamed.",
    ),
    def(
        "cue_point_moved",
        Important,
        "Song Section Moved",
        "An Arrangement locator moved to another beat.",
    ),
    def(
        "cue_point_deleted",
        Important,
        "Song Section Removed",
        "An Arrangement locator was deleted.",
    ),
    def(
        "locator_added",
        Important,
        "Locator Added",
        "A locator marker was added in the arrangement.",
    ),
    def(
        "arrangement_section_changed",
        Coalescible,
        "Arrangement Section Changed",
        "The arrangement section changed.",
    ),
    def(
        "creative_decision",
        Critical,
        "Creative Decision",
        "A creative decision marker was received.",
    ),
    // ── Debug ───────────────────────────────────────────────────────────────
    def(
        "raw_max_message",
        Coalescible,
        "Raw Max Message",
        "Raw Max message received for debugging.",
    ),
];

/// Events that are NOT the producer making something.
///
/// Recall's "moments" count is what tells a producer how much they did in a
/// sitting, and it was defined as "every event that isn't a heartbeat". That let
/// navigation and bookkeeping masquerade as work: one real session recorded 85
/// moments, of which 49 were focus changes, 16 were whole-set snapshots, and 5
/// were the bridge starting and stopping. Three knob moves and two note edits
/// were the actual work. A producer reads 85, looks at a nearly empty timeline,
/// and concludes capture is broken — a number that manufactures alarm is worse
/// than no number.
///
/// Kept as the exclusion list rather than a per-row flag because noise is the
/// small, stable, well-understood set: it is where the producer's ATTENTION went
/// (focus, selection), what Recall did to keep itself honest (snapshots,
/// heartbeats, lifecycle), and transport state. Everything else — a knob moved, a
/// note written, a clip made, a track added — is work, and a new creative event
/// type should count as work the day it lands without anyone remembering to flag
/// it. The default has to be "this counts".
const NON_CREATIVE_EVENT_TYPES: &[&str] = &[
    // Bookkeeping: Recall talking to itself.
    "heartbeat",
    "bridge_started",
    "bridge_stopped",
    "raw_max_message",
    "project_context",
    // Snapshots: a picture of the set, not a change to it.
    "live_set_snapshot",
    "session_snapshot",
    "session_snapshot_started",
    "session_snapshot_completed",
    "transport_snapshot",
    "selected_track_focus_snapshot",
    // Attention, not authorship. Where the producer looked, not what they did.
    "focus_changed",
    "track_selected",
    "device_selected",
    "group_focused",
    // Transport: pressing play is not a change to the song.
    "transport_changed",
    "transport_play",
    "transport_stop",
    "playback_state_changed",
    "beat_time_changed",
    "loop_toggled",
    "metronome_toggled",
];

/// Whether an event represents the producer making something, and so should count
/// toward a session's "moments".
///
/// Unknown events count as creative on purpose: an event type we don't recognize
/// is far more likely to be new capture we haven't catalogued than new noise, and
/// under-counting real work is the failure that sends someone hunting a capture
/// bug that isn't there.
/// Not called in the lib build today: the counting happens in SQL, via
/// `non_creative_sql_list`. This is the rule stated in Rust so a test can prove
/// the two agree (`the_sql_exclusion_list_matches_is_creative`), and so any
/// future caller that needs the decision outside a query has one to call rather
/// than re-deriving it. Deleting it would leave the SQL fragment as the only
/// definition of "work", which is how the `!= 'heartbeat'` rule went unexamined
/// for as long as it did.
#[allow(dead_code)]
pub fn is_creative(event_type: &str) -> bool {
    !NON_CREATIVE_EVENT_TYPES.contains(&event_type)
}

/// The signature of a Live API object that was never turned into a value.
///
/// Live hands the remote script objects, not strings, for some properties —
/// routing channels above all. Where the script could not find a readable name
/// on one, Python's default `repr` was recorded instead:
///
/// ```text
/// "input_routing_channel": "<Track.RoutingChannel object at 0x000000002B0AF110>"
/// ```
///
/// That is a memory address. It differs on every read of the SAME unchanged
/// route, so each refresh compares unequal and reports as a change. One real
/// session recorded 195 `track_routing_changed` inside a single second at
/// capture start this way — 45% of everything it captured — and every one of
/// them counted as producer work. Across the library, 2,700 of 21,400 events
/// carry this signature.
///
/// Script 0.7.2 stopped producing them, but the recorded history cannot be
/// un-recorded, and Recall must not keep reporting it as work in the meantime.
const UNREADABLE_VALUE_MARKER: &str = "object at 0x";

/// Whether one recorded event counts as producer work.
///
/// Two rules, not one. The event's TYPE has to be a kind of work (`is_creative`)
/// and its recorded VALUE has to be something Recall could actually read. An
/// event whose value is a memory address is not evidence of anything: it says
/// only that Recall looked, not that the producer acted. §1 — Recall states what
/// it knows, and it does not know what that route was.
///
/// The type is deliberately not reclassified to get this: re-routing a track IS
/// a decision when a human does it, and blanket-excluding `track_routing_changed`
/// would throw the real ones away with the noise.
pub fn counts_as_work(event_type: &str, payload: Option<&str>) -> bool {
    is_creative(event_type) && !carries_unreadable_value(payload)
}

/// True when an event's payload records a Live object Recall could not read.
pub fn carries_unreadable_value(payload: Option<&str>) -> bool {
    payload.is_some_and(|body| body.contains(UNREADABLE_VALUE_MARKER))
}

/// The value rule as a SQL predicate, for the ONE place it is still asked in
/// SQL: the migration that backfills `events.value_unreadable` for rows written
/// before the flag existed. Every read since answers from the flag instead —
/// the counting aggregate runs once a second and must not scan 152MB of payload
/// to do it.
pub fn unreadable_value_sql_predicate() -> String {
    format!("payload LIKE '%{}%'", UNREADABLE_VALUE_MARKER)
}

/// The non-creative event types as a SQL literal list, e.g. `'heartbeat','...'`.
///
/// Exists so the counting query and `is_creative` can never disagree. The names
/// are compile-time `&'static str` from the list above — no user input reaches
/// this, so building the fragment by hand is safe here in a way it would not be
/// for anything caller-supplied.
pub fn non_creative_sql_list() -> String {
    NON_CREATIVE_EVENT_TYPES
        .iter()
        .map(|event_type| format!("'{}'", event_type))
        .collect::<Vec<_>>()
        .join(",")
}

/// Find the catalog row for an `event_type`, or `None` if it isn't in the
/// vocabulary. All three public helpers below funnel through this so there is one
/// lookup rule, not three.
pub fn lookup(event_type: &str) -> Option<&'static EventDef> {
    CATALOG.iter().find(|def| def.event_type == event_type)
}

/// Priority for the overload-shedding policy. Unknown events default to
/// `Coalescible` — if we don't recognize it, we won't let it crowd out events we
/// do recognize under pressure.
pub fn classify_priority(event_type: &str) -> EventPriority {
    lookup(event_type).map_or(EventPriority::Coalescible, |def| def.priority)
}

/// Fallback title for events whose bridge packet omitted `title`. Unknown events
/// get a readable, self-identifying default rather than an empty string.
pub fn title_for_event_type(event_type: &str) -> String {
    lookup(event_type).map_or_else(
        || format!("Recall Event: {event_type}"),
        |def| def.title.to_string(),
    )
}

/// Fallback description for events whose bridge packet omitted `description`.
pub fn description_for_event_type(event_type: &str) -> String {
    lookup(event_type).map_or_else(
        || format!("Recall event received: {event_type}"),
        |def| def.description.to_string(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn event_types_are_unique() {
        // A duplicate row would make lookups order-dependent and silently mask a
        // mistake, so guard against it explicitly.
        let mut seen = std::collections::HashSet::new();
        for def in CATALOG {
            assert!(
                seen.insert(def.event_type),
                "duplicate event_type in CATALOG: {}",
                def.event_type
            );
        }
    }

    /// Every `event_type` the bridge can actually put on the wire, taken from the
    /// `_emit(...)` call sites in `remote-script/Recall/__init__.py`.
    ///
    /// Keep this in step with the script. It is deliberately a hand-maintained
    /// list rather than something parsed at build time: the script ships
    /// separately (it runs from Ableton's MIDI Remote Scripts folder, not from
    /// this crate), so there is no build-time link between the two and this list
    /// is the only place the contract between them is written down.
    const BRIDGE_EMITTED_EVENT_TYPES: &[&str] = &[
        "audio_clip_added",
        "audio_clip_changed",
        "audio_clip_recorded",
        "bridge_started",
        "bridge_stopped",
        "clip_deleted",
        "clip_gain_changed",
        "clip_loop_changed",
        "clip_markers_changed",
        "clip_moved",
        "clip_notes_changed",
        "clip_pitch_changed",
        "clip_renamed",
        "crossfade_assignment_changed",
        "cue_point_added",
        "cue_point_deleted",
        "cue_point_moved",
        "cue_point_renamed",
        "device_added",
        "device_chain_changed",
        "device_removed",
        "device_toggled",
        "focus_changed",
        "heartbeat",
        "live_set_snapshot",
        "midi_clip_created",
        "midi_clip_recorded",
        "automation_created",
        "automation_edited",
        "parameter_changed",
        "pan_changed",
        "project_saved",
        "rack_variation_deleted",
        "rack_variation_recalled",
        "rack_variation_stored",
        "recording_started",
        "recording_stopped",
        "send_changed",
        "scene_created",
        "scene_deleted",
        "scene_launched",
        "scene_renamed",
        "scale_changed",
        "signature_changed",
        "swing_changed",
        "groove_changed",
        "tempo_changed",
        "track_created",
        "track_deleted",
        "track_frozen",
        "track_flattened",
        "track_unfrozen",
        "track_list_changed",
        "track_name_changed",
        "track_routing_changed",
        "tracks_grouped",
        "track_ungrouped",
        "clip_launched",
        "return_track_added",
        "volume_changed",
        "warp_markers_changed",
        "warp_mode_changed",
    ];

    // An event the bridge emits but the catalog doesn't know falls through to the
    // unknown-event defaults: Coalescible priority — FIRST to be shed when the
    // ingest queue saturates — and an auto-generated "Recall Event: x" title in
    // the timeline. Both failures are silent. This test is what makes the script
    // and the catalog drifting apart loud instead.
    #[test]
    fn every_event_the_bridge_emits_has_a_catalog_row() {
        let missing: Vec<&str> = BRIDGE_EMITTED_EVENT_TYPES
            .iter()
            .copied()
            .filter(|event_type| lookup(event_type).is_none())
            .collect();

        assert!(
            missing.is_empty(),
            "the bridge emits these event types but the catalog has no row for them, \
             so they are shed first under load and render with a generated title: {:?}",
            missing
        );
    }

    // Structural edits are the ones a producer would notice losing, so none of
    // them may sit in the shed-first tier. Pinned separately from the row itself
    // because the priority, not the row's existence, is what protects the event.
    #[test]
    fn structural_bridge_events_are_never_shed_first() {
        for event_type in ["track_list_changed", "live_set_snapshot"] {
            assert_ne!(
                classify_priority(event_type),
                EventPriority::Coalescible,
                "{event_type} is structural and must not be first to shed"
            );
        }
    }

    // The session that exposed this. 85 events arrived, the UI said "85 moments",
    // and the producer went looking for 85 things on a timeline that had five.
    // Real counts from that take, by event_type.
    #[test]
    fn a_real_session_counts_only_the_work_the_producer_did() {
        let session = [
            ("focus_changed", 49),
            ("live_set_snapshot", 16),
            ("track_list_changed", 8),
            ("parameter_changed", 3),
            ("bridge_started", 3),
            ("tempo_changed", 2),
            ("clip_notes_changed", 2),
            ("bridge_stopped", 2),
        ];

        let total: u32 = session.iter().map(|(_, count)| count).sum();
        let creative: u32 = session
            .iter()
            .filter(|(event_type, _)| is_creative(event_type))
            .map(|(_, count)| count)
            .sum();

        assert_eq!(total, 85, "the take really did receive 85 events");
        // 8 track_list_changed + 3 parameter_changed + 2 tempo_changed
        // + 2 clip_notes_changed. Structural and creative edits count; looking
        // around, snapshotting, and the bridge connecting do not.
        assert_eq!(creative, 15);
    }

    #[test]
    fn looking_around_is_not_work_but_touching_the_song_is() {
        for noise in [
            "heartbeat",
            "focus_changed",
            "track_selected",
            "live_set_snapshot",
            "bridge_started",
            "transport_play",
        ] {
            assert!(!is_creative(noise), "{noise} should not count as a moment");
        }

        for work in [
            "parameter_changed",
            "clip_notes_changed",
            "midi_clip_created",
            "audio_clip_added",
            "midi_clip_recorded",
            "audio_clip_recorded",
            "volume_changed",
            "pan_changed",
            "send_changed",
            "track_created",
            "device_added",
            "automation_created",
            "automation_edited",
        ] {
            assert!(is_creative(work), "{work} should count as a moment");
        }
    }

    // An event type nobody has catalogued yet is far more likely to be new
    // capture than new noise, and under-counting real work is what sends someone
    // hunting a capture bug that does not exist.
    #[test]
    fn an_unknown_event_counts_as_work() {
        assert!(is_creative("some_future_event_we_have_not_shipped_yet"));
    }

    // The counting query builds its NOT IN list from the same constant
    // `is_creative` reads. If these ever disagree, the number on screen stops
    // matching the rule the code believes it is applying.
    #[test]
    fn the_value_rule_is_the_same_in_rust_and_in_sql() {
        // Two definitions of "work" in two languages is how the first one drifted.
        let repr = "{\"input_routing_channel\":\"<Track.RoutingChannel object at 0x2B0AF110>\"}";
        assert!(carries_unreadable_value(Some(repr)));
        assert!(unreadable_value_sql_predicate().contains(UNREADABLE_VALUE_MARKER));
    }

    #[test]
    fn a_route_recall_could_actually_read_still_counts_as_work() {
        // The type is not the problem and must not be blamed for it: re-routing
        // a track IS a decision when a human does it.
        assert!(counts_as_work(
            "track_routing_changed",
            Some("{\"input_routing_channel\":\"Ext. In 1\"}")
        ));
        assert!(!counts_as_work(
            "track_routing_changed",
            Some("{\"input_routing_channel\":\"<Track.RoutingChannel object at 0x1>\"}")
        ));
    }

    #[test]
    fn an_event_with_no_payload_at_all_is_judged_on_its_type_alone() {
        assert!(counts_as_work("parameter_changed", None));
        assert!(!counts_as_work("heartbeat", None));
    }

    #[test]
    fn the_sql_exclusion_list_matches_is_creative() {
        let sql = non_creative_sql_list();

        for event_type in NON_CREATIVE_EVENT_TYPES {
            assert!(
                sql.contains(&format!("'{event_type}'")),
                "{event_type} is excluded in Rust but missing from the SQL list"
            );
            assert!(!is_creative(event_type));
        }

        assert_eq!(
            sql.matches('\'').count(),
            NON_CREATIVE_EVENT_TYPES.len() * 2,
            "every entry should be quoted exactly once, and none should contain a quote"
        );
    }

    #[test]
    fn titles_and_descriptions_are_present() {
        // Every declared row must carry real fallback copy.
        for def in CATALOG {
            assert!(!def.title.is_empty(), "empty title for {}", def.event_type);
            assert!(
                !def.description.is_empty(),
                "empty description for {}",
                def.event_type
            );
        }
    }

    #[test]
    fn creative_actions_are_critical() {
        // These are the moments a producer would notice losing — pin them so a
        // careless edit can't quietly demote them into the shed-able tier.
        for et in [
            "track_created",
            "device_added",
            "sample_added",
            "midi_clip_created",
            "midi_clip_recorded",
            "audio_clip_recorded",
            "clip_notes_changed",
            "automation_created",
        ] {
            assert_eq!(
                classify_priority(et),
                EventPriority::Critical,
                "{et} must be Critical"
            );
        }
    }

    #[test]
    fn high_frequency_telemetry_is_coalescible() {
        for et in [
            "transport_snapshot",
            "selected_track_focus_snapshot",
        ] {
            assert_eq!(
                classify_priority(et),
                EventPriority::Coalescible,
                "{et} must be Coalescible"
            );
        }
    }

    #[test]
    fn settled_mixer_moves_are_important() {
        for et in ["volume_changed", "pan_changed", "send_changed"] {
            assert_eq!(
                classify_priority(et),
                EventPriority::Important,
                "{et} must survive queue pressure once the bridge has settled it"
            );
        }
    }

    #[test]
    fn unknown_events_get_safe_defaults() {
        assert_eq!(
            classify_priority("totally_made_up"),
            EventPriority::Coalescible
        );
        assert_eq!(
            title_for_event_type("totally_made_up"),
            "Recall Event: totally_made_up"
        );
        assert_eq!(
            description_for_event_type("totally_made_up"),
            "Recall event received: totally_made_up"
        );
    }

    #[test]
    fn known_events_resolve_their_copy() {
        assert_eq!(title_for_event_type("sample_added"), "Sample Added");
        assert_eq!(
            title_for_event_type("device_chain_changed"),
            "Signal Chain Changed"
        );
    }
}
