//! The desktop shell: wires the webview to the engine.

mod commands;

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![commands::load_dashboard, commands::save_note])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
