mod storage;

use std::path::PathBuf;

use storage::{Entry, EntryMeta};
use tauri::Manager;

/// Directory where diary Markdown files live.
///
/// Uses the platform app-data directory (e.g. `~/.local/share/com.flydiary.app/diary`
/// on Linux) so entries survive app updates and are easy to back up.
fn diary_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {e}"))?;
    Ok(base.join("diary"))
}

#[tauri::command]
fn get_entry(app: tauri::AppHandle, date: String) -> Result<Option<Entry>, String> {
    let dir = diary_dir(&app)?;
    storage::read_entry(&dir, &date)
}

#[tauri::command]
fn save_entry(app: tauri::AppHandle, date: String, content: String) -> Result<(), String> {
    let dir = diary_dir(&app)?;
    storage::write_entry(&dir, &date, &content)
}

#[tauri::command]
fn delete_entry(app: tauri::AppHandle, date: String) -> Result<(), String> {
    let dir = diary_dir(&app)?;
    storage::delete_entry(&dir, &date)
}

#[tauri::command]
fn list_entries(app: tauri::AppHandle) -> Result<Vec<EntryMeta>, String> {
    let dir = diary_dir(&app)?;
    storage::list_entries(&dir)
}

/// Today's date in the user's local timezone, formatted as `YYYY-MM-DD`.
#[tauri::command]
fn today() -> String {
    chrono::Local::now().format("%Y-%m-%d").to_string()
}

/// Absolute path of the diary directory, shown in the UI for transparency.
#[tauri::command]
fn diary_path(app: tauri::AppHandle) -> Result<String, String> {
    let dir = diary_dir(&app)?;
    storage::ensure_dir(&dir)?;
    Ok(dir.to_string_lossy().to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            get_entry,
            save_entry,
            delete_entry,
            list_entries,
            today,
            diary_path
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
