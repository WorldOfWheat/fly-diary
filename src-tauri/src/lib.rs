mod crypto;
mod settings;
mod storage;
mod xml;

use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use storage::{Entry, EntryMeta};
use tauri::Manager;
use zeroize::Zeroizing;

/// Directory holding the app's own configuration (not the diary itself).
///
/// On Linux this is `~/.config/com.flydiary.app`, on macOS
/// `~/Library/Application Support/com.flydiary.app`, on Windows
/// `%APPDATA%\com.flydiary.app`.
fn config_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map_err(|e| format!("Failed to resolve config dir: {e}"))
}

/// Default diary location offered on first run.
fn default_diary_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {e}"))?;
    Ok(base.join("diary"))
}

/// Resolve the diary directory from the settings file.
///
/// Returns an error when the app has not been configured yet, so callers can
/// distinguish "first run" from "configured but locked".
fn diary_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let config = config_dir(app)?;
    let settings = settings::read_settings(&config)?
        .ok_or_else(|| "Diary is not configured yet".to_string())?;
    Ok(settings.diary_dir)
}

/// Settings exposed to the frontend.
#[derive(Debug, Clone, Serialize)]
struct SettingsView {
    /// Whether a settings file exists (i.e. the app has been set up).
    configured: bool,
    /// The configured diary directory, if any.
    diary_dir: Option<String>,
    /// Suggested directory to pre-fill on first run.
    default_dir: String,
}

/// In-memory session state: the derived AES key while the vault is unlocked.
///
/// The key is wrapped in `Zeroizing` so it is wiped from memory on lock/drop.
#[derive(Default)]
struct Session {
    key: Option<Zeroizing<[u8; 32]>>,
}

impl Session {
    fn key(&self) -> Result<&[u8; 32], String> {
        self.key
            .as_deref()
            .ok_or_else(|| "Diary is locked".to_string())
    }
}

type SharedSession = Mutex<Session>;

// ---------------------------------------------------------------------------
// Settings commands
// ---------------------------------------------------------------------------

/// Report whether the app is configured and where the diary lives.
///
/// `configured` is derived from the *parsed* settings rather than from the
/// mere existence of the file, so a corrupt `settings.xml` is reported as
/// "not configured" instead of yielding `configured: true` with no path.
#[tauri::command]
fn get_settings(app: tauri::AppHandle) -> Result<SettingsView, String> {
    let config = config_dir(&app)?;
    let default_dir = default_diary_dir(&app)?.to_string_lossy().to_string();

    let settings = settings::read_settings(&config).ok().flatten();
    let diary_dir = settings
        .as_ref()
        .map(|s| s.diary_dir.to_string_lossy().to_string());

    Ok(SettingsView {
        configured: diary_dir.is_some(),
        diary_dir,
        default_dir,
    })
}

/// Persist a new diary directory into the settings file.
///
/// Refuses to change the location while the diary is unlocked, because the
/// in-memory key belongs to the vault at the old location.
#[tauri::command]
fn set_diary_dir(
    app: tauri::AppHandle,
    session: tauri::State<'_, SharedSession>,
    path: String,
) -> Result<(), String> {
    if session.lock().unwrap().key.is_some() {
        return Err("Lock the diary before changing its location".to_string());
    }

    let dir = PathBuf::from(path.trim());
    settings::validate_diary_dir(&dir)?;

    let config = config_dir(&app)?;
    settings::write_settings(&config, &settings::Settings { diary_dir: dir })
}

/// Open a native folder picker and return the chosen path.
///
/// Returns `None` when the user cancels.
#[tauri::command]
async fn pick_diary_dir(app: tauri::AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;

    let (tx, rx) = std::sync::mpsc::channel();
    app.dialog()
        .file()
        .set_title("選擇日記儲存資料夾")
        .pick_folder(move |folder| {
            let _ = tx.send(folder);
        });

    let picked = rx
        .recv()
        .map_err(|e| format!("Folder picker failed: {e}"))?;

    Ok(picked.map(|p| p.to_string()))
}

// ---------------------------------------------------------------------------
// Vault commands
// ---------------------------------------------------------------------------

/// Argon2id cost parameters as seen by the frontend.
///
/// The `min_*`/`max_*` fields are only populated by [`get_kdf_defaults`]; they
/// are ignored when the frontend sends parameters back to [`create_vault`].
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct KdfView {
    memory_kib: u32,
    iterations: u32,
    parallelism: u32,
    #[serde(default)]
    min_memory_kib: u32,
    #[serde(default)]
    max_memory_kib: u32,
    #[serde(default)]
    min_iterations: u32,
    #[serde(default)]
    max_iterations: u32,
    #[serde(default)]
    min_parallelism: u32,
    #[serde(default)]
    max_parallelism: u32,
}

/// Default and allowed KDF parameters, used to seed the advanced options UI.
#[tauri::command]
fn get_kdf_defaults() -> KdfView {
    let defaults = crypto::KdfParams::default();
    KdfView {
        memory_kib: defaults.memory_kib,
        iterations: defaults.iterations,
        parallelism: defaults.parallelism,
        min_memory_kib: crypto::KdfParams::MIN_MEMORY_KIB,
        max_memory_kib: crypto::KdfParams::MAX_MEMORY_KIB,
        min_iterations: crypto::KdfParams::MIN_ITERATIONS,
        max_iterations: crypto::KdfParams::MAX_ITERATIONS,
        min_parallelism: crypto::KdfParams::MIN_PARALLELISM,
        max_parallelism: crypto::KdfParams::MAX_PARALLELISM,
    }
}

/// Whether a vault file exists yet (first run vs. returning user).
///
/// When `path` is given, that directory is inspected instead of the configured
/// one. This lets the setup screen detect an existing vault in a folder the
/// user is about to pick, so returning users are sent to the unlock flow
/// rather than hitting "Vault already exists".
#[tauri::command]
fn vault_exists(app: tauri::AppHandle, path: Option<String>) -> Result<bool, String> {
    let dir = match path {
        Some(p) => {
            let dir = PathBuf::from(p.trim());
            settings::validate_diary_dir(&dir)?;
            dir
        }
        None => diary_dir(&app)?,
    };
    storage::vault_exists(&dir)
}

/// Create a new vault protected by `passphrase` and unlock it immediately.
///
/// `kdf` is optional so the frontend can omit it and get the defaults.
#[tauri::command]
fn create_vault(
    app: tauri::AppHandle,
    session: tauri::State<'_, SharedSession>,
    passphrase: String,
    kdf: Option<KdfView>,
) -> Result<(), String> {
    let params = match kdf {
        Some(view) => crypto::KdfParams {
            memory_kib: view.memory_kib,
            iterations: view.iterations,
            parallelism: view.parallelism,
        },
        None => crypto::KdfParams::default(),
    };

    let dir = diary_dir(&app)?;
    let key = storage::create_vault(&dir, &passphrase, params)?;
    *session.lock().unwrap() = Session {
        key: Some(Zeroizing::new(key)),
    };
    Ok(())
}

/// Verify `passphrase` and keep the derived key in memory.
#[tauri::command]
fn unlock(
    app: tauri::AppHandle,
    session: tauri::State<'_, SharedSession>,
    passphrase: String,
) -> Result<(), String> {
    let dir = diary_dir(&app)?;
    let key = storage::unlock_vault(&dir, &passphrase)?;
    *session.lock().unwrap() = Session {
        key: Some(Zeroizing::new(key)),
    };
    Ok(())
}

/// Forget the in-memory key.
#[tauri::command]
fn lock(session: tauri::State<'_, SharedSession>) {
    *session.lock().unwrap() = Session::default();
}

/// Whether the vault is currently unlocked.
#[tauri::command]
fn is_unlocked(session: tauri::State<'_, SharedSession>) -> bool {
    session.lock().unwrap().key.is_some()
}

// ---------------------------------------------------------------------------
// Entry commands
// ---------------------------------------------------------------------------

#[tauri::command]
fn get_entry(
    app: tauri::AppHandle,
    session: tauri::State<'_, SharedSession>,
    date: String,
) -> Result<Option<Entry>, String> {
    let dir = diary_dir(&app)?;
    let guard = session.lock().unwrap();
    storage::read_entry(&dir, guard.key()?, &date)
}

#[tauri::command]
fn save_entry(
    app: tauri::AppHandle,
    session: tauri::State<'_, SharedSession>,
    date: String,
    title: String,
    content: String,
) -> Result<(), String> {
    let dir = diary_dir(&app)?;
    let guard = session.lock().unwrap();
    storage::write_entry(&dir, guard.key()?, &date, &title, &content)
}

#[tauri::command]
fn delete_entry(
    app: tauri::AppHandle,
    session: tauri::State<'_, SharedSession>,
    date: String,
) -> Result<(), String> {
    let dir = diary_dir(&app)?;
    let guard = session.lock().unwrap();
    storage::delete_entry(&dir, guard.key()?, &date)
}

/// List entries. Titles are encrypted, so the diary must be unlocked.
#[tauri::command]
fn list_entries(
    app: tauri::AppHandle,
    session: tauri::State<'_, SharedSession>,
) -> Result<Vec<EntryMeta>, String> {
    let dir = diary_dir(&app)?;
    let guard = session.lock().unwrap();
    storage::list_entries(&dir, guard.key()?)
}

/// Discard `index.xml` and rebuild it by scanning every entry file.
///
/// The index is normally maintained automatically; this is an escape hatch for
/// a corrupted index or for files copied into the folder behind the app's back.
#[tauri::command]
fn rebuild_index(
    app: tauri::AppHandle,
    session: tauri::State<'_, SharedSession>,
) -> Result<Vec<EntryMeta>, String> {
    let dir = diary_dir(&app)?;
    let guard = session.lock().unwrap();
    storage::rebuild_index(&dir, guard.key()?)
}

// ---------------------------------------------------------------------------
// Import commands
// ---------------------------------------------------------------------------

/// Open a native folder picker for the import source and return its path.
///
/// Returns `None` when the user cancels.
#[tauri::command]
async fn pick_import_dir(app: tauri::AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;

    let (tx, rx) = std::sync::mpsc::channel();
    app.dialog()
        .file()
        .set_title("選擇要匯入的資料夾")
        .pick_folder(move |folder| {
            let _ = tx.send(folder);
        });

    let picked = rx
        .recv()
        .map_err(|e| format!("Folder picker failed: {e}"))?;

    Ok(picked.map(|p| p.to_string()))
}

/// Inspect a folder of `YYYY-MM-DD.txt` files without writing anything.
///
/// The frontend shows the result so the user can confirm before importing.
#[tauri::command]
fn scan_import(
    app: tauri::AppHandle,
    session: tauri::State<'_, SharedSession>,
    import_dir: String,
) -> Result<storage::ImportScan, String> {
    let dir = diary_dir(&app)?;
    let src = PathBuf::from(import_dir.trim());
    if !src.is_dir() {
        return Err("匯入路徑不是資料夾".to_string());
    }

    let guard = session.lock().unwrap();
    let key = guard.key()?;
    let existing = storage::list_entries(&dir, key)?;
    let existing: std::collections::BTreeMap<String, String> = existing
        .into_iter()
        .map(|meta| (meta.date, meta.title))
        .collect();

    storage::scan_import(&src, &existing)
}

/// Import the confirmed dates from `import_dir` into the diary.
///
/// `overwrite` decides whether dates that already exist are replaced or
/// skipped. The report lists what happened to every requested date.
///
/// The work runs on the rayon pool, so this command is `async` and hands the
/// blocking batch to `spawn_blocking`: a few thousand entries would otherwise
/// freeze the webview for the duration of the import. Progress is reported as
/// `import-progress` events carrying `{ done, total }`.
#[tauri::command]
async fn run_import(
    app: tauri::AppHandle,
    session: tauri::State<'_, SharedSession>,
    import_dir: String,
    dates: Vec<String>,
    overwrite: bool,
) -> Result<storage::ImportReport, String> {
    let dir = diary_dir(&app)?;
    let src = PathBuf::from(import_dir.trim());
    if !src.is_dir() {
        return Err("匯入路徑不是資料夾".to_string());
    }

    // Copy the key out so the session lock is not held across the whole import.
    let key = {
        let guard = session.lock().unwrap();
        *guard.key()?
    };

    let emitter = app.clone();

    tauri::async_runtime::spawn_blocking(move || {
        storage::import_entries_with_progress(&dir, &key, &src, &dates, overwrite, |done, total| {
            use tauri::Emitter;
            let _ = emitter.emit("import-progress", (done, total));
        })
    })
    .await
    .map_err(|e| format!("Import task failed: {e}"))?
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
        .plugin(tauri_plugin_dialog::init())
        .manage(SharedSession::default())
        .invoke_handler(tauri::generate_handler![
            get_settings,
            set_diary_dir,
            pick_diary_dir,
            get_kdf_defaults,
            vault_exists,
            create_vault,
            unlock,
            lock,
            is_unlocked,
            get_entry,
            save_entry,
            delete_entry,
            list_entries,
            rebuild_index,
            pick_import_dir,
            scan_import,
            run_import,
            today,
            diary_path
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
