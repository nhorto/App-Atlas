//! The commands the webview can invoke — the app's doors into the engine.

use tauri::{command, AppHandle};

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

/// The idiomatic spelling, which is the *common* one and was read by nothing (#195):
/// import the macro, use the short name. lencx/ChatGPT writes all eleven of its
/// commands this way and reported no doors at all.
#[command]
pub fn view_reload(window: String) -> bool {
    let _ = window;
    true
}

/// A `#[command]` that is nobody's Tauri command: this crate imports the macro, but a
/// bare attribute from some other library must not become a door on that account —
/// which is why the fixture keeps one here, spelled the way clap's is.
#[clap::command]
pub fn cli_entry(args: Vec<String>) -> usize {
    args.len()
}
