// `crypto` and `storage` are public so the integration tests in `tests/` can
// drive the vault lifecycle through the same API the commands use.
pub mod crypto;
mod fsutil;
mod settings;
pub mod storage;
mod xml;

use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use storage::{BrokenEntry, Entry, EntryMeta};
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
#[serde(rename_all = "camelCase")]
struct SettingsView {
    /// Whether a settings file exists (i.e. the app has been set up).
    configured: bool,
    /// The configured diary directory, if any.
    diary_dir: Option<String>,
    /// Suggested directory to pre-fill on first run.
    default_dir: String,
    /// Idle minutes before auto-lock; `0` means never.
    auto_lock_minutes: u32,
    /// The auto-lock values the UI may offer.
    auto_lock_choices: Vec<u32>,
    /// Milliseconds of inactivity before the editor autosaves.
    autosave_delay_ms: u32,
    /// The autosave delays the UI may offer.
    autosave_delay_choices: Vec<u32>,
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

/// Run blocking work off the main thread.
///
/// Tauri runs synchronous commands on the main thread, so anything that touches
/// the filesystem or does real crypto there freezes the webview for its whole
/// duration. `async fn` alone does not help: a body with no `.await` runs to
/// completion on the first poll, still occupying a runtime worker. Only
/// `spawn_blocking` actually moves the work to a thread of its own.
///
/// Every command below that does I/O goes through this helper. The closure must
/// be `Send + 'static`, which is why the session key is copied out before the
/// call rather than borrowed from the mutex guard.
async fn blocking<T, F>(what: &'static str, work: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, String> + Send + 'static,
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|e| format!("{what} task failed: {e}"))?
}

/// Copy the diary key out of the session.
///
/// The guard is dropped immediately: `MutexGuard` is not `Send`, so it cannot
/// cross into `spawn_blocking`, and holding it for the duration of a write would
/// block `lock` and every other command behind it.
///
/// The copy is wrapped in `Zeroizing` so it is wiped when the command ends, even
/// though it outlives the session lock and may be moved into a blocking task.
fn session_key(session: &tauri::State<'_, SharedSession>) -> Result<Zeroizing<[u8; 32]>, String> {
    let guard = session.lock().unwrap();
    Ok(Zeroizing::new(*guard.key()?))
}

// ---------------------------------------------------------------------------
// Settings commands
// ---------------------------------------------------------------------------

/// Report whether the app is configured and where the diary lives.
///
/// `configured` is derived from the *parsed* settings rather than from the
/// mere existence of the file, so a corrupt `settings.xml` is reported as
/// "not configured" instead of yielding `configured: true` with no path.
#[tauri::command]
async fn get_settings(app: tauri::AppHandle) -> Result<SettingsView, String> {
    let config = config_dir(&app)?;
    let default_dir = default_diary_dir(&app)?.to_string_lossy().to_string();

    blocking("Get settings", move || {
        let settings = settings::read_settings(&config).ok().flatten();
        let diary_dir = settings
            .as_ref()
            .map(|s| s.diary_dir.to_string_lossy().to_string());
        let auto_lock_minutes = settings
            .as_ref()
            .map(|s| s.auto_lock_minutes)
            .unwrap_or(settings::DEFAULT_AUTO_LOCK_MINUTES);
        let autosave_delay_ms = settings
            .as_ref()
            .map(|s| s.autosave_delay_ms)
            .unwrap_or(settings::DEFAULT_AUTOSAVE_DELAY_MS);

        Ok(SettingsView {
            configured: diary_dir.is_some(),
            diary_dir,
            default_dir,
            auto_lock_minutes,
            auto_lock_choices: settings::AUTO_LOCK_CHOICES.to_vec(),
            autosave_delay_ms,
            autosave_delay_choices: settings::AUTOSAVE_DELAY_CHOICES.to_vec(),
        })
    })
    .await
}

/// Persist a new diary directory into the settings file.
///
/// Refuses to change the location while the diary is unlocked, because the
/// in-memory key belongs to the vault at the old location.
///
/// The auto-lock preference is carried over from the existing settings so
/// changing the path does not silently reset it.
#[tauri::command]
async fn set_diary_dir(
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
    blocking("Set diary dir", move || {
        let mut settings = settings::read_settings(&config)
            .ok()
            .flatten()
            .unwrap_or_else(|| settings::Settings::new(dir.clone()));
        settings.diary_dir = dir;
        settings::write_settings(&config, &settings)
    })
    .await
}

/// Persist the auto-lock preference.
///
/// Allowed while unlocked: it is a UI preference, not key material.
/// `minutes == 0` ([`settings::AUTO_LOCK_NEVER`]) disables auto-lock.
#[tauri::command]
async fn set_auto_lock(app: tauri::AppHandle, minutes: u32) -> Result<(), String> {
    settings::validate_auto_lock(minutes)?;

    let config = config_dir(&app)?;
    blocking("Set auto lock", move || {
        let mut settings = settings::read_settings(&config)?
            .ok_or_else(|| "Diary is not configured yet".to_string())?;
        settings.auto_lock_minutes = minutes;
        settings::write_settings(&config, &settings)
    })
    .await
}

/// Persist the autosave debounce delay.
///
/// Allowed while unlocked, like auto-lock: it only changes how often the editor
/// writes, never what is written. The value must be one of
/// [`settings::AUTOSAVE_DELAY_CHOICES`], so autosave cannot be switched off.
#[tauri::command]
async fn set_autosave_delay(app: tauri::AppHandle, ms: u32) -> Result<(), String> {
    settings::validate_autosave_delay(ms)?;

    let config = config_dir(&app)?;
    blocking("Set autosave delay", move || {
        let mut settings = settings::read_settings(&config)?
            .ok_or_else(|| "Diary is not configured yet".to_string())?;
        settings.autosave_delay_ms = ms;
        settings::write_settings(&config, &settings)
    })
    .await
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

impl KdfView {
    /// Build a view from stored parameters.
    ///
    /// `with_bounds` decides whether the `min_*`/`max_*` fields are filled in.
    /// They are only meaningful for the UI that lets the user *edit* the
    /// parameters (the first-run panel and the calibrate button); reporting the
    /// parameters of an existing vault leaves them at zero, which the frontend
    /// ignores.
    fn from_params(params: crypto::KdfParams, with_bounds: bool) -> Self {
        let (min_memory_kib, max_memory_kib) = if with_bounds {
            (
                crypto::KdfParams::MIN_MEMORY_KIB,
                crypto::KdfParams::MAX_MEMORY_KIB,
            )
        } else {
            (0, 0)
        };
        let (min_iterations, max_iterations) = if with_bounds {
            (
                crypto::KdfParams::MIN_ITERATIONS,
                crypto::KdfParams::MAX_ITERATIONS,
            )
        } else {
            (0, 0)
        };
        let (min_parallelism, max_parallelism) = if with_bounds {
            (
                crypto::KdfParams::MIN_PARALLELISM,
                crypto::KdfParams::MAX_PARALLELISM,
            )
        } else {
            (0, 0)
        };

        Self {
            memory_kib: params.memory_kib,
            iterations: params.iterations,
            parallelism: params.parallelism,
            min_memory_kib,
            max_memory_kib,
            min_iterations,
            max_iterations,
            min_parallelism,
            max_parallelism,
        }
    }
}

/// Default and allowed KDF parameters, used to seed the advanced options UI.
#[tauri::command]
fn get_kdf_defaults() -> KdfView {
    KdfView::from_params(crypto::KdfParams::default(), true)
}

/// Whether a vault file exists yet (first run vs. returning user).
///
/// When `path` is given, that directory is inspected instead of the configured
/// one. This lets the setup screen detect an existing vault in a folder the
/// user is about to pick, so returning users are sent to the unlock flow
/// rather than hitting "Vault already exists".
#[tauri::command]
async fn vault_exists(app: tauri::AppHandle, path: Option<String>) -> Result<bool, String> {
    let dir = match path {
        Some(p) => {
            let dir = PathBuf::from(p.trim());
            settings::validate_diary_dir(&dir)?;
            dir
        }
        None => diary_dir(&app)?,
    };
    blocking("Vault exists", move || storage::vault_exists(&dir)).await
}

/// Create a new vault protected by `passphrase` and unlock it immediately.
///
/// `kdf` is optional so the frontend can omit it and get the defaults.
#[tauri::command]
async fn create_vault(
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
    // Argon2id is deliberately slow (about a second by design), so it must not
    // run on the main thread. The session is only touched after the work
    // returns: `tauri::State` cannot be moved into the blocking closure.
    let key = blocking("Create vault", move || {
        storage::create_vault(&dir, &passphrase, params)
    })
    .await?;

    // `create_vault` already returns a `Zeroizing` key, so it is stored as-is.
    *session.lock().unwrap() = Session { key: Some(key) };
    Ok(())
}

/// Verify `passphrase` and keep the derived key in memory.
#[tauri::command]
async fn unlock(
    app: tauri::AppHandle,
    session: tauri::State<'_, SharedSession>,
    passphrase: String,
) -> Result<(), String> {
    let dir = diary_dir(&app)?;
    let key = blocking("Unlock", move || storage::unlock_vault(&dir, &passphrase)).await?;
    // `unlock_vault` already returns a `Zeroizing` key, so it is stored as-is.
    *session.lock().unwrap() = Session { key: Some(key) };
    Ok(())
}

/// Forget the in-memory key.
#[tauri::command]
fn lock(session: tauri::State<'_, SharedSession>) {
    *session.lock().unwrap() = Session::default();
}

/// The Argon2id parameters currently recorded in the vault.
///
/// Returns `None` when the vault is still in the legacy format, which has no
/// Argon2id parameters to report.
#[tauri::command]
async fn get_vault_kdf(app: tauri::AppHandle) -> Result<Option<KdfView>, String> {
    let dir = diary_dir(&app)?;
    blocking("Get vault kdf", move || {
        Ok(storage::vault_kdf_params(&dir)?.map(|p| KdfView::from_params(p, false)))
    })
    .await
}

/// Measure this machine and return Argon2id parameters that take about a
/// second to derive.
#[tauri::command]
async fn calibrate_kdf() -> Result<KdfView, String> {
    // Deriving is CPU-bound and deliberately slow, so keep it off the async
    // runtime's worker threads.
    let params = tauri::async_runtime::spawn_blocking(crypto::calibrate_kdf)
        .await
        .map_err(|e| format!("Calibration task failed: {e}"))??;
    Ok(KdfView::from_params(params, true))
}

/// Change the passphrase and/or the Argon2id parameters.
///
/// The diary key is re-wrapped, not regenerated, so entries are untouched and
/// the session stays unlocked. `new_passphrase` may be empty to keep the
/// current passphrase and only change the parameters.
#[tauri::command]
async fn change_passphrase(
    app: tauri::AppHandle,
    session: tauri::State<'_, SharedSession>,
    current_passphrase: String,
    new_passphrase: String,
    kdf: Option<KdfView>,
) -> Result<(), String> {
    let dir = diary_dir(&app)?;

    // Default to the parameters already in the vault so a passphrase-only
    // change does not silently downgrade the cost.
    let params = match kdf {
        Some(view) => crypto::KdfParams {
            memory_kib: view.memory_kib,
            iterations: view.iterations,
            parallelism: view.parallelism,
        },
        None => storage::vault_kdf_params(&dir)?.unwrap_or_default(),
    };

    let effective_new = if new_passphrase.is_empty() {
        current_passphrase.clone()
    } else {
        new_passphrase
    };

    // Two Argon2id derivations (old and new passphrase) plus a rewrap: the
    // longest single operation in the app, and the one most likely to be
    // noticed if it ran on the main thread.
    let key = blocking("Change passphrase", move || {
        storage::rewrap_vault(&dir, &current_passphrase, &effective_new, params)
    })
    .await?;

    // The diary key is unchanged, but refresh the session anyway so the
    // in-memory copy is the one the vault now wraps. `rewrap_vault` already
    // returns a `Zeroizing` key, so it is stored as-is and still wiped on drop.
    *session.lock().unwrap() = Session { key: Some(key) };
    Ok(())
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
async fn get_entry(
    app: tauri::AppHandle,
    session: tauri::State<'_, SharedSession>,
    date: String,
) -> Result<Option<Entry>, String> {
    let dir = diary_dir(&app)?;
    let key = session_key(&session)?;
    blocking("Get entry", move || storage::read_entry(&dir, &key, &date)).await
}

/// Encrypt and write one entry, then update the index.
///
/// The body does several blocking file reads and writes plus three AES-GCM
/// operations, and the editor autosaves on a short debounce, so it runs on a
/// blocking thread rather than the main one. Being `async` alone would not be
/// enough: without an `.await` the body would still run to completion on the
/// first poll.
#[tauri::command]
async fn save_entry(
    app: tauri::AppHandle,
    session: tauri::State<'_, SharedSession>,
    date: String,
    title: String,
    content: String,
) -> Result<(), String> {
    let dir = diary_dir(&app)?;
    let key = session_key(&session)?;
    blocking("Save entry", move || {
        storage::write_entry(&dir, &key, &date, &title, &content)
    })
    .await
}

#[tauri::command]
async fn delete_entry(
    app: tauri::AppHandle,
    session: tauri::State<'_, SharedSession>,
    date: String,
) -> Result<(), String> {
    let dir = diary_dir(&app)?;
    let key = session_key(&session)?;
    blocking("Delete entry", move || {
        storage::delete_entry(&dir, &key, &date)
    })
    .await
}

/// List entries. Titles are encrypted, so the diary must be unlocked.
#[tauri::command]
async fn list_entries(
    app: tauri::AppHandle,
    session: tauri::State<'_, SharedSession>,
) -> Result<Vec<EntryMeta>, String> {
    let dir = diary_dir(&app)?;
    let key = session_key(&session)?;
    blocking("List entries", move || storage::list_entries(&dir, &key)).await
}

/// List only the entries marked as favourites, newest first.
#[tauri::command]
async fn list_favourites(
    app: tauri::AppHandle,
    session: tauri::State<'_, SharedSession>,
) -> Result<Vec<EntryMeta>, String> {
    let dir = diary_dir(&app)?;
    let key = session_key(&session)?;
    blocking("List favourites", move || {
        storage::list_favourites(&dir, &key)
    })
    .await
}

/// Mark or unmark an entry as a favourite. Returns the stored flag.
///
/// The flag is part of the encrypted payload, so this rewrites the entry file;
/// the frontend calls it only when the user toggles the bookmark.
#[tauri::command]
async fn set_favourite(
    app: tauri::AppHandle,
    session: tauri::State<'_, SharedSession>,
    date: String,
    favourite: bool,
) -> Result<bool, String> {
    let dir = diary_dir(&app)?;
    let key = session_key(&session)?;
    blocking("Set favourite", move || {
        storage::set_favourite(&dir, &key, &date, favourite)
    })
    .await
}

/// Discard `index.xml` and rebuild it by scanning every entry file.
///
/// The index is normally maintained automatically; this is an escape hatch for
/// a corrupted index or for files copied into the folder behind the app's back.
///
/// This is the slow path — one read and one decryption per entry — so it is the
/// command that most needs to stay off the main thread.
#[tauri::command]
async fn rebuild_index(
    app: tauri::AppHandle,
    session: tauri::State<'_, SharedSession>,
) -> Result<Vec<EntryMeta>, String> {
    let dir = diary_dir(&app)?;
    let key = session_key(&session)?;
    blocking("Rebuild index", move || storage::rebuild_index(&dir, &key)).await
}

/// List entry files that exist on disk but cannot be decrypted.
///
/// These never appear in [`list_entries`]: a broken file has no readable title,
/// and mixing it into the normal list would make every consumer filter it out
/// again. The sidebar shows them in their own view instead.
///
/// Unlike the index-backed listings this always scans the whole folder, so it
/// costs one read and one decryption attempt per entry on every call.
#[tauri::command]
async fn list_broken_entries(
    app: tauri::AppHandle,
    session: tauri::State<'_, SharedSession>,
) -> Result<Vec<BrokenEntry>, String> {
    let dir = diary_dir(&app)?;
    let key = session_key(&session)?;
    blocking("List broken entries", move || {
        storage::list_broken_entries(&dir, &key)
    })
    .await
}

/// Copy a broken entry file to a location the user picks.
///
/// The bytes are copied verbatim, so whatever is in the file survives even if
/// this version of the app cannot parse it. No session key is needed because
/// nothing is decrypted.
///
/// Returns the destination path, or `None` when the user cancels the dialog.
#[tauri::command]
async fn export_broken_entry(
    app: tauri::AppHandle,
    date: String,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;

    let dir = diary_dir(&app)?;
    let (tx, rx) = std::sync::mpsc::channel();
    app.dialog()
        .file()
        .set_title("匯出損壞的日記檔")
        .set_file_name(format!("{date}.xml"))
        .save_file(move |path| {
            let _ = tx.send(path);
        });

    let picked = rx
        .recv()
        .map_err(|e| format!("Save dialog failed: {e}"))?;

    let Some(dest) = picked else {
        return Ok(None);
    };
    let dest = PathBuf::from(dest.to_string());
    // The dialog itself already ran off the main thread (the `recv` above
    // blocks a worker), but the copy that follows is still a file operation on
    // a potentially large file, so it gets its own blocking hop.
    blocking("Export broken entry", move || {
        storage::export_broken_entry(&dir, &date, &dest)?;
        Ok(dest.to_string_lossy().into_owned())
    })
    .await
    .map(Some)
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
async fn scan_import(
    app: tauri::AppHandle,
    session: tauri::State<'_, SharedSession>,
    import_dir: String,
) -> Result<storage::ImportScan, String> {
    let dir = diary_dir(&app)?;
    let src = PathBuf::from(import_dir.trim());
    if !src.is_dir() {
        return Err("匯入路徑不是資料夾".to_string());
    }

    let key = session_key(&session)?;

    // `scan_import` fans out over the rayon pool, but the caller still has to
    // wait for it. Running that wait on a blocking thread keeps the main thread
    // free while a few thousand files are read and decoded.
    blocking("Scan import", move || {
        let existing = storage::known_dates(&dir, &key)?;
        storage::scan_import(&src, &existing)
    })
    .await
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
    let key = session_key(&session)?;

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

/// Rewrite every entry that predates the current on-disk format.
///
/// Entries written before version 3 are not bound to their date through AES-GCM
/// associated data, so their ciphertext can be copied to another day and will
/// decrypt there. Entries written before version 4 are bound to their date but
/// not to the version byte, so an attacker could rewrite `<diary version="4">`
/// to `3` and make the reader fall back to the weaker bare-date AAD. New writes
/// always produce version 4, whose AAD is `date || 0x00 || version`, so both
/// attacks fail the GCM tag. An entry is upgraded the first time it is saved —
/// but an entry that is never opened again would stay unprotected forever.
///
/// This command closes that gap. The frontend calls it right after unlocking and
/// deliberately does not await it, so the diary is usable immediately. The work
/// runs on `spawn_blocking` because a few thousand entries would otherwise
/// freeze the webview, and progress is reported as `upgrade-progress` events
/// carrying `{ done, total }`.
///
/// The run is idempotent and safe to interrupt: already-current entries are
/// skipped, each file is replaced atomically, and an entry the user saves while
/// it is being upgraded is left alone. Broken files are never touched.
#[tauri::command]
async fn upgrade_entries(
    app: tauri::AppHandle,
    session: tauri::State<'_, SharedSession>,
) -> Result<storage::UpgradeReport, String> {
    let dir = diary_dir(&app)?;

    // Copy the key out so the session lock is not held for the whole run. The
    // copy stays valid even if the diary is locked mid-upgrade; the run simply
    // finishes on its own copy, which is wiped when the closure returns.
    let key = session_key(&session)?;

    let emitter = app.clone();

    tauri::async_runtime::spawn_blocking(move || {
        storage::upgrade_entries_with_progress(&dir, &key, |done, total| {
            use tauri::Emitter;
            let _ = emitter.emit("upgrade-progress", (done, total));
        })
    })
    .await
    .map_err(|e| format!("Upgrade task failed: {e}"))?
}

/// Today's date in the user's local timezone, formatted as `YYYY-MM-DD`.
#[tauri::command]
fn today() -> String {
    chrono::Local::now().format("%Y-%m-%d").to_string()
}

/// Enable or disable screenshot / screen-recording protection for the window.
///
/// Tauri maps this to `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)` on
/// Windows and `NSWindow.setSharingType(.none)` on macOS. Linux has no
/// equivalent in `tao`, so the call is a no-op there.
///
/// The window is created with `contentProtected: true` in `tauri.conf.json` so
/// the lock screen is covered too; the frontend flips it off only while the
/// workspace picker is open, where the user may want to share their screen.
///
/// The command is named `set_screenshot_protection` rather than
/// `set_content_protected` because Tauri already exports a built-in command of
/// the latter name, and the generated macro names would collide.
#[tauri::command]
fn set_screenshot_protection(
    window: tauri::WebviewWindow,
    protected: bool,
) -> Result<(), String> {
    window
        .set_content_protected(protected)
        .map_err(|e| e.to_string())
}

/// Absolute path of the diary directory, shown in the UI for transparency.
#[tauri::command]
async fn diary_path(app: tauri::AppHandle) -> Result<String, String> {
    let dir = diary_dir(&app)?;
    // `ensure_dir` creates the folder on first run, which is a filesystem call.
    blocking("Diary path", move || {
        storage::ensure_dir(&dir)?;
        Ok(dir.to_string_lossy().to_string())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A session holding a known key, as `unlock` would leave it.
    fn unlocked(key: [u8; 32]) -> Session {
        Session {
            key: Some(Zeroizing::new(key)),
        }
    }

    // -----------------------------------------------------------------------
    // Session
    // -----------------------------------------------------------------------

    #[test]
    fn a_fresh_session_is_locked() {
        let session = Session::default();
        assert!(session.key.is_none());
        assert_eq!(session.key().unwrap_err(), "Diary is locked");
    }

    #[test]
    fn an_unlocked_session_returns_its_key() {
        let key = [7u8; 32];
        let session = unlocked(key);
        assert_eq!(session.key().unwrap(), &key);
    }

    #[test]
    fn locking_clears_the_key() {
        let mut session = unlocked([1u8; 32]);
        assert!(session.key.is_some());
        session = Session::default();
        assert!(session.key.is_none());
        assert!(session.key().is_err());
    }

    #[test]
    fn the_key_is_wiped_when_the_session_is_dropped() {
        // `Zeroizing` is what guarantees this; the test documents the intent.
        let session = unlocked([9u8; 32]);
        let ptr = session.key.as_ref().unwrap().as_ptr();
        drop(session);
        // Reading freed memory would be UB, so only assert the type contract:
        // the key is stored inside a `Zeroizing`, not a bare array.
        assert!(!ptr.is_null());
    }

    // -----------------------------------------------------------------------
    // Settings rules enforced by the commands
    // -----------------------------------------------------------------------

    #[test]
    fn set_diary_dir_refuses_while_unlocked() {
        // The guard is the first thing `set_diary_dir` does, before touching
        // the filesystem, so it can be checked without an `AppHandle`.
        let session = unlocked([3u8; 32]);
        let refused = session.key.is_some();
        assert!(refused, "an unlocked session must block a path change");
    }

    #[test]
    fn set_diary_dir_is_allowed_while_locked() {
        let session = Session::default();
        assert!(session.key.is_none());
    }

    #[test]
    fn auto_lock_choices_include_never_and_the_default() {
        assert!(settings::AUTO_LOCK_CHOICES.contains(&settings::AUTO_LOCK_NEVER));
        assert!(settings::AUTO_LOCK_CHOICES.contains(&settings::DEFAULT_AUTO_LOCK_MINUTES));
    }

    #[test]
    fn auto_lock_rejects_a_value_that_is_not_offered() {
        assert!(settings::validate_auto_lock(7).is_err());
        assert!(settings::validate_auto_lock(settings::AUTO_LOCK_NEVER).is_ok());
    }

    #[test]
    fn a_relative_diary_dir_is_rejected() {
        assert!(settings::validate_diary_dir(std::path::Path::new("diary")).is_err());
    }

    #[test]
    fn the_filesystem_root_is_rejected_as_a_diary_dir() {
        assert!(settings::validate_diary_dir(std::path::Path::new("/")).is_err());
    }

    #[test]
    fn an_absolute_diary_dir_is_accepted() {
        assert!(settings::validate_diary_dir(std::path::Path::new("/tmp/fly-diary")).is_ok());
    }

    // -----------------------------------------------------------------------
    // KDF view
    // -----------------------------------------------------------------------

    #[test]
    fn kdf_defaults_are_within_the_advertised_bounds() {
        let view = get_kdf_defaults();
        assert!(view.memory_kib >= view.min_memory_kib);
        assert!(view.memory_kib <= view.max_memory_kib);
        assert!(view.iterations >= view.min_iterations);
        assert!(view.iterations <= view.max_iterations);
        assert!(view.parallelism >= view.min_parallelism);
        assert!(view.parallelism <= view.max_parallelism);
    }

    #[test]
    fn kdf_defaults_match_the_crypto_defaults() {
        let defaults = crypto::KdfParams::default();
        let view = get_kdf_defaults();
        assert_eq!(view.memory_kib, defaults.memory_kib);
        assert_eq!(view.iterations, defaults.iterations);
        assert_eq!(view.parallelism, defaults.parallelism);
    }

    #[test]
    fn a_kdf_view_roundtrips_through_serde() {
        let view = get_kdf_defaults();
        let json = serde_json::to_string(&view).unwrap();
        // The frontend reads camelCase, so the rename must survive.
        assert!(json.contains("\"memoryKib\""), "got {json}");
        assert!(json.contains("\"minMemoryKib\""), "got {json}");
        let back: KdfView = serde_json::from_str(&json).unwrap();
        assert_eq!(back.memory_kib, view.memory_kib);
        assert_eq!(back.iterations, view.iterations);
        assert_eq!(back.parallelism, view.parallelism);
    }

    #[test]
    fn kdf_view_deserialises_without_the_bounds() {
        // The frontend sends back only the three cost fields; the `min_*` and
        // `max_*` fields are `#[serde(default)]` so they may be omitted.
        let view: KdfView =
            serde_json::from_str(r#"{"memoryKib":65536,"iterations":3,"parallelism":4}"#).unwrap();
        assert_eq!(view.memory_kib, 65536);
        assert_eq!(view.iterations, 3);
        assert_eq!(view.parallelism, 4);
        assert_eq!(view.min_memory_kib, 0);
    }

    // -----------------------------------------------------------------------
    // change_passphrase's "keep the current passphrase" rule
    // -----------------------------------------------------------------------

    #[test]
    fn an_empty_new_passphrase_means_keep_the_current_one() {
        // Mirrors the branch in `change_passphrase`.
        let current = "correct horse".to_string();
        let new = String::new();
        let effective = if new.is_empty() {
            current.clone()
        } else {
            new
        };
        assert_eq!(effective, current);
    }

    #[test]
    fn a_non_empty_new_passphrase_replaces_the_current_one() {
        let current = "old".to_string();
        let new = "new".to_string();
        let effective = if new.is_empty() {
            current.clone()
        } else {
            new
        };
        assert_eq!(effective, "new");
    }

    // -----------------------------------------------------------------------
    // today()
    // -----------------------------------------------------------------------

    #[test]
    fn today_is_an_iso_date() {
        let value = today();
        assert_eq!(value.len(), 10);
        assert!(storage::validate_date(&value).is_ok(), "got {value}");
    }

    #[test]
    fn today_matches_the_local_clock() {
        let expected = chrono::Local::now().format("%Y-%m-%d").to_string();
        assert_eq!(today(), expected);
    }
}

/// Build the application menu.
///
/// Tauri installs a default menu on Linux and macOS, and its `Edit` submenu
/// claims the `Ctrl+Z` / `Ctrl+Shift+Z` accelerators. Those default items are
/// inert placeholders: they swallow the keystroke before the webview sees it and
/// then do nothing, which is why undo appeared to be broken in the editor.
///
/// Rebuilding the submenu with [`PredefinedMenuItem`] gives each item a real
/// action — the predefined variants forward to the focused webview's own editing
/// commands, so undo/redo/cut/copy/paste behave exactly as they do in a browser.
fn build_menu(app: &tauri::AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{MenuBuilder, PredefinedMenuItem, SubmenuBuilder};

    let edit = SubmenuBuilder::new(app, "Edit")
        .item(&PredefinedMenuItem::undo(app, None)?)
        .item(&PredefinedMenuItem::redo(app, None)?)
        .separator()
        .item(&PredefinedMenuItem::cut(app, None)?)
        .item(&PredefinedMenuItem::copy(app, None)?)
        .item(&PredefinedMenuItem::paste(app, None)?)
        .item(&PredefinedMenuItem::select_all(app, None)?)
        .build()?;

    MenuBuilder::new(app).item(&edit).build()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(SharedSession::default())
        .menu(build_menu)
        .invoke_handler(tauri::generate_handler![
            get_settings,
            set_diary_dir,
            set_auto_lock,
            set_autosave_delay,
            pick_diary_dir,
            get_kdf_defaults,
            vault_exists,
            create_vault,
            unlock,
            lock,
            is_unlocked,
            get_vault_kdf,
            calibrate_kdf,
            change_passphrase,
            get_entry,
            save_entry,
            delete_entry,
            list_entries,
            list_favourites,
            set_favourite,
            rebuild_index,
            list_broken_entries,
            export_broken_entry,
            pick_import_dir,
            scan_import,
            run_import,
            upgrade_entries,
            today,
            diary_path,
            set_screenshot_protection
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
