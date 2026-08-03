//! Turns estimates into the weekly report.

use crate::modules::estimating::{load_estimates, EstimateRow};
use sqlx::MySqlPool;

/// A finished report: one line per job.
pub struct Report {
    pub lines: Vec<String>,
}

/// Builds the weekly report for one job.
pub async fn build(pool: &MySqlPool, job: &str) -> Report {
    let rows: Vec<EstimateRow> = load_estimates(pool, job).await;
    Report {
        lines: rows.iter().map(|row| format!("{}: {:.1}h", row.job, row.total())).collect(),
    }
}
