use serde::Serialize;
use std::sync::{
    atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering},
    Arc, Mutex,
};
use std::time::{SystemTime, UNIX_EPOCH};

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("System time error")
        .as_millis() as u64
}

// Live health counters for the Ableton -> Recall data pipeline. Shared (Arc)
// between the UDP receive loop and the persistence worker. All counters are
// atomic so neither thread has to take a lock on the hot path. queue_depth is a
// signed gauge (enqueued minus dequeued) rather than a monotonic counter.
#[derive(Debug, Default)]
pub struct BridgeMetrics {
    pub packets_received: AtomicU64,
    pub malformed_packets: AtomicU64,
    pub dropped_packets: AtomicU64,
    pub events_queued: AtomicU64,
    pub events_persisted: AtomicU64,
    pub events_emitted: AtomicU64,
    pub queue_depth: AtomicI64,
    pub last_event_ms: AtomicU64,
    pub last_error: Mutex<Option<String>>,

    // Of dropped_packets, how many were Critical or Important. This is the bar
    // PRD §8 actually cares about — Coalescible shedding is the design working,
    // protected loss is the design failing, and one number cannot say both.
    pub protected_dropped: AtomicU64,

    // Events the bridge sent that never reached us, counted from gaps in the
    // per-device sequence the bridge stamps on every event.
    //
    // This is the ONLY counter that can see loss upstream of our code. Everything
    // above counts what we received; if the kernel discards a packet because the
    // socket buffer overflowed, or the sender never got it out, no counter here
    // will ever fire — the event dies before `packets_received` increments. That
    // blind spot is exactly why the diagnostics panel would have reported
    // "0 dropped" during a measured 80% loss. Sequence gaps close it.
    pub sequence_gaps: AtomicU64,

    // Events dropped because no capture session was active. Previously these
    // vanished silently: not persisted, not counted as dropped, not counted as
    // persisted. Counted now so gap detection doesn't blame the transport for
    // something the session lifecycle did.
    pub session_discarded: AtomicU64,

    // Packets whose processing panicked and was caught. Should always be 0; if it
    // ever isn't, capture survived something it should never have met, and the
    // packet that did it is worth chasing.
    pub panics_recovered: AtomicU64,

    // Datagrams larger than the receive buffer. Windows rejects these whole
    // (WSAEMSGSIZE) rather than truncating, so they arrive as a recv error and
    // never reach the Ok path — which is why they previously incremented no
    // counter whatsoever, not even packets_received.
    pub oversized_packets: AtomicU64,

    // The capture port was already taken when this instance tried to bind it —
    // meaning ANOTHER Recall is running and holding it.
    //
    // Closing Recall hides it to the tray rather than quitting, so instances
    // accumulate: four were running at once during one session. Exactly one can
    // own the socket. The others look completely healthy — window up, database
    // readable, timeline showing captures the OTHER process is writing — while
    // receiving nothing themselves. The producer sees "Ableton isn't talking to
    // Recall" and goes hunting the bridge, which is the wrong place entirely.
    //
    // A distinct flag rather than parsing `last_error`: "someone else has the
    // port" has a specific, actionable remedy ("quit the other one") that no
    // other bind failure shares, and matching on error prose would break the
    // moment the wording changed.
    pub capture_port_conflict: AtomicBool,
}

impl BridgeMetrics {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    pub fn incr_packets_received(&self) {
        self.packets_received.fetch_add(1, Ordering::Relaxed);
    }

    pub fn incr_malformed(&self) {
        self.malformed_packets.fetch_add(1, Ordering::Relaxed);
    }

    pub fn incr_dropped(&self) {
        self.dropped_packets.fetch_add(1, Ordering::Relaxed);
    }

    // Call alongside incr_dropped when the dropped event was Critical/Important.
    pub fn incr_protected_dropped(&self) {
        self.protected_dropped.fetch_add(1, Ordering::Relaxed);
    }

    pub fn add_sequence_gaps(&self, n: u64) {
        self.sequence_gaps.fetch_add(n, Ordering::Relaxed);
    }

    pub fn incr_session_discarded(&self) {
        self.session_discarded.fetch_add(1, Ordering::Relaxed);
    }

    pub fn incr_panics_recovered(&self) {
        self.panics_recovered.fetch_add(1, Ordering::Relaxed);
    }

    pub fn incr_oversized(&self) {
        self.oversized_packets.fetch_add(1, Ordering::Relaxed);
    }

    /// Record that the capture port was already in use, i.e. another Recall owns
    /// it. Sticky for the life of the process: the listener thread binds once at
    /// startup and does not retry, so this stays true until the app is restarted
    /// — which is exactly when the producer would want to be told.
    pub fn note_capture_port_conflict(&self) {
        self.capture_port_conflict.store(true, Ordering::Relaxed);
    }

    pub fn on_enqueue(&self) {
        self.events_queued.fetch_add(1, Ordering::Relaxed);
        self.queue_depth.fetch_add(1, Ordering::Relaxed);
    }

    pub fn on_dequeue(&self) {
        self.queue_depth.fetch_sub(1, Ordering::Relaxed);
    }

    pub fn incr_persisted(&self) {
        self.events_persisted.fetch_add(1, Ordering::Relaxed);
    }

    pub fn incr_emitted(&self) {
        self.events_emitted.fetch_add(1, Ordering::Relaxed);
        self.last_event_ms.store(now_ms(), Ordering::Relaxed);
    }

    pub fn set_last_error(&self, message: impl Into<String>) {
        if let Ok(mut slot) = self.last_error.lock() {
            *slot = Some(message.into());
        }
    }

    pub fn snapshot(&self) -> BridgeMetricsSnapshot {
        let last_event_ms = self.last_event_ms.load(Ordering::Relaxed);

        BridgeMetricsSnapshot {
            packets_received: self.packets_received.load(Ordering::Relaxed),
            malformed_packets: self.malformed_packets.load(Ordering::Relaxed),
            dropped_packets: self.dropped_packets.load(Ordering::Relaxed),
            events_queued: self.events_queued.load(Ordering::Relaxed),
            events_persisted: self.events_persisted.load(Ordering::Relaxed),
            events_emitted: self.events_emitted.load(Ordering::Relaxed),
            queue_depth: self.queue_depth.load(Ordering::Relaxed).max(0) as u64,
            last_event_ms: if last_event_ms == 0 {
                None
            } else {
                Some(last_event_ms)
            },
            last_error: self.last_error.lock().ok().and_then(|slot| slot.clone()),
            protected_dropped: self.protected_dropped.load(Ordering::Relaxed),
            sequence_gaps: self.sequence_gaps.load(Ordering::Relaxed),
            session_discarded: self.session_discarded.load(Ordering::Relaxed),
            panics_recovered: self.panics_recovered.load(Ordering::Relaxed),
            oversized_packets: self.oversized_packets.load(Ordering::Relaxed),
            capture_port_conflict: self.capture_port_conflict.load(Ordering::Relaxed),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // queue_depth is the one signed gauge here, and `snapshot` narrows it to u64
    // for the UI. The `.max(0)` is load-bearing: a bare `as u64` on -1 renders as
    // 18_446_744_073_709_551_615, so a gauge that dips below zero (a dequeue
    // observed before its enqueue under Relaxed ordering) would show the
    // diagnostics panel a quintillion-deep queue instead of an empty one.
    #[test]
    fn queue_depth_never_reports_a_negative_gauge_as_a_huge_number() {
        let metrics = BridgeMetrics::new();
        metrics.on_dequeue();

        assert_eq!(metrics.snapshot().queue_depth, 0);
    }

    #[test]
    fn queue_depth_tracks_enqueue_minus_dequeue() {
        let metrics = BridgeMetrics::new();
        metrics.on_enqueue();
        metrics.on_enqueue();
        metrics.on_enqueue();
        metrics.on_dequeue();

        let snapshot = metrics.snapshot();
        assert_eq!(snapshot.queue_depth, 2);
        // events_queued is monotonic and must NOT be decremented by a dequeue —
        // it answers "how many did we ever take in", not "how many are waiting".
        assert_eq!(snapshot.events_queued, 3);
    }

    // 0 is the "never happened" sentinel for last_event_ms, and the snapshot has to
    // translate it to None rather than handing the UI a 1970 timestamp.
    #[test]
    fn last_event_ms_is_none_until_something_is_emitted() {
        let metrics = BridgeMetrics::new();
        assert_eq!(metrics.snapshot().last_event_ms, None);

        metrics.incr_emitted();

        let snapshot = metrics.snapshot();
        assert_eq!(snapshot.events_emitted, 1);
        assert!(snapshot.last_event_ms.is_some_and(|ms| ms > 0));
    }

    // Protected loss is counted separately from total drops on purpose: shedding
    // Coalescible telemetry is the design working, losing a Critical event is the
    // design failing, and one counter cannot say both (see the field's comment).
    #[test]
    fn protected_drops_are_counted_separately_from_total_drops() {
        let metrics = BridgeMetrics::new();
        metrics.incr_dropped();
        metrics.incr_dropped();
        metrics.incr_protected_dropped();

        let snapshot = metrics.snapshot();
        assert_eq!(snapshot.dropped_packets, 2);
        assert_eq!(snapshot.protected_dropped, 1);
    }

    // The trap this exists for: a second Recall looks completely healthy while
    // receiving nothing, because the first one owns the socket. Default false so
    // a normal instance never claims a conflict it doesn't have.
    #[test]
    fn a_capture_port_conflict_is_off_until_the_bind_actually_fails() {
        let metrics = BridgeMetrics::new();
        assert!(!metrics.snapshot().capture_port_conflict);

        metrics.note_capture_port_conflict();

        assert!(metrics.snapshot().capture_port_conflict);
    }

    // Sticky: the listener binds once at startup and never retries, so the
    // conflict remains true for the life of the process. Later unrelated errors
    // must not clear it — the instance is still deaf.
    #[test]
    fn a_capture_port_conflict_survives_later_errors() {
        let metrics = BridgeMetrics::new();
        metrics.note_capture_port_conflict();
        metrics.set_last_error("something else went wrong");

        assert!(metrics.snapshot().capture_port_conflict);
    }

    #[test]
    fn the_most_recent_error_is_the_one_reported() {
        let metrics = BridgeMetrics::new();
        assert_eq!(metrics.snapshot().last_error, None);

        metrics.set_last_error("first");
        metrics.set_last_error("second");

        assert_eq!(metrics.snapshot().last_error.as_deref(), Some("second"));
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct BridgeMetricsSnapshot {
    pub packets_received: u64,
    pub malformed_packets: u64,
    pub dropped_packets: u64,
    pub events_queued: u64,
    pub events_persisted: u64,
    pub events_emitted: u64,
    pub queue_depth: u64,
    pub last_event_ms: Option<u64>,
    pub last_error: Option<String>,
    pub protected_dropped: u64,
    pub sequence_gaps: u64,
    pub session_discarded: u64,
    pub panics_recovered: u64,
    pub oversized_packets: u64,
    /// Another Recall process holds the capture port; this one receives nothing.
    pub capture_port_conflict: bool,
}
