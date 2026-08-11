use serde::{Deserialize, Serialize};

/// One deliberate piece of studio work scheduled in Recall. Dates stay as
/// `YYYY-MM-DD` strings so a task always belongs to the producer's chosen local
/// calendar day instead of drifting when the computer's timezone changes.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlannerTask {
    pub id: String,
    pub title: String,
    pub due_date: String,
    pub due_time: Option<String>,
    pub task_type: String,
    pub project_id: Option<String>,
    pub notes: Option<String>,
    pub completed: bool,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
}
