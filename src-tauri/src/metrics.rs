use serde::Serialize;
use std::sync::{
    atomic::{AtomicI64, AtomicU64, Ordering},
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
        }
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
}
