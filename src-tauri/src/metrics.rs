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
}
