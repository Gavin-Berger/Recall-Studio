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
        Coalescible,
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
    // ── Parameters & automation ─────────────────────────────────────────────
    // Live parameter moves are Coalescible (frequent, debounced at the bridge).
    // Writing automation is a creative decision and is Critical.
    def(
        "parameter_changed",
        Coalescible,
        "Parameter Changed",
        "A device parameter was adjusted.",
    ),
    def(
        "device_parameter_changed",
        Coalescible,
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
        "follow_action_fired",
        Coalescible,
        "Follow Action",
        "A clip follow action fired in Ableton.",
    ),
    // ── Mixing ──────────────────────────────────────────────────────────────
    // Continuous mixer moves; the bridge must debounce these before emitting.
    def(
        "volume_changed",
        Coalescible,
        "Volume Changed",
        "A track's volume changed.",
    ),
    def(
        "pan_changed",
        Coalescible,
        "Pan Changed",
        "A track's pan changed.",
    ),
    def(
        "send_changed",
        Coalescible,
        "Send Changed",
        "A track send level changed.",
    ),
    def(
        "crossfader_changed",
        Coalescible,
        "Crossfader Changed",
        "The crossfader position changed.",
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
            "automation_created",
            "track_armed",
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
            "pan_changed",
        ] {
            assert_eq!(
                classify_priority(et),
                EventPriority::Coalescible,
                "{et} must be Coalescible"
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
