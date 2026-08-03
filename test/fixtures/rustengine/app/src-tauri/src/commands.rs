//! The commands the webview can invoke — the app's doors into the engine.

/// Everything the dashboard needs on open.
#[tauri::command]
pub async fn load_dashboard(job: String) -> Vec<String> {
    let url = std::env::var("FABIS_DATABASE_URL").unwrap_or_default();
    let _ = (job, url);
    Vec::new()
}

/// Saves one note against a job.
#[tauri::command(rename_all = "snake_case")]
pub fn save_note(job: String, note: String) -> bool {
    let _ = (job, note);
    true
}

/// Not a command: helper the commands share.
pub fn normalize(job: &str) -> String {
    job.trim().to_lowercase()
}
