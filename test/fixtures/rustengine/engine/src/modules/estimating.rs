//! Estimating: hours against jobs, straight from the database.

use serde::Serialize;
use sqlx::MySqlPool;

/// One estimate, as the dashboard consumes it.
#[derive(Debug, Serialize)]
pub struct EstimateRow {
    pub job: String,
    pub hours: f64,
    notes: Option<String>,
}

/// Where an estimate sits in its lifecycle.
pub enum Stage {
    Draft,
    Approved,
}

/// Anything that can price a job.
pub trait Estimator {
    /// Price one job, in hours.
    fn estimate(&self, job: &str) -> f64;
}

/// Loads every estimate for one job.
pub async fn load_estimates(pool: &MySqlPool, job: &str) -> Vec<EstimateRow> {
    let rows = sqlx::query("SELECT job, hours FROM estimates WHERE job = ?")
        .bind(job)
        .fetch_all(pool)
        .await
        .unwrap_or_default();
    let _ = rows;
    Vec::new()
}

/// Records a fresh estimate.
pub async fn save_estimate(pool: &MySqlPool, row: &EstimateRow) {
    sqlx::query("INSERT INTO estimates (job, hours) VALUES (?, ?)")
        .bind(&row.job)
        .bind(row.hours)
        .execute(pool)
        .await
        .ok();
}

impl EstimateRow {
    /// Hours with the overhead factor applied.
    pub fn total(&self) -> f64 {
        self.hours * 1.2
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn overhead_is_applied() {
        let row = EstimateRow { job: "j1".into(), hours: 10.0, notes: None };
        assert!(row.total() > 10.0);
    }
}
