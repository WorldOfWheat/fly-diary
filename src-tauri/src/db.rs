//! SQLCipher-backed diary storage.
//!
//! The diary key stays wrapped in `vault.xml` (and optionally `recovery.xml`);
//! this module never stores or derives a passphrase.  It expands the 32-byte
//! diary key with HKDF into two subkeys:
//!
//! * `fly-diary/sqlcipher/v1` — the raw SQLCipher database key.
//! * `fly-diary/attachment/v3` — the key for new image sidecars.
//!
//! The database itself uses SQLCipher's raw-key form
//! (`PRAGMA key = "x'<64 hex>'"`), so SQLCipher does not run another PBKDF2 on
//! top of the Argon2id-derived diary key.
//!
//! ## Layout
//!
//! ```text
//! diary/
//! ├── vault.xml              # unchanged (only XML kept with recovery.xml)
//! ├── recovery.xml           # unchanged
//! ├── diary.db               # SQLCipher database (only store of entries)
//! └── attachments/...        # image sidecars
//! ```
//!
//! The database is the single store of truth. Backups are explicit encrypted
//! snapshot archives (`backup.rs`) containing a `VACUUM INTO` copy of the
//! database plus the key wrappers and attachment sidecars.

use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, UNIX_EPOCH};

use hkdf::Hkdf;
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde::Serialize;
use sha2::Sha256;
use zeroize::{Zeroize, Zeroizing};

use crate::crypto;
use crate::fsutil;
use crate::storage::{
    self, BrokenEntry, BrokenReason, Entry, EntryMeta, IndexRecord, ScanResult, ScannedEntry,
};
use crate::xml::VaultContext;

/// SQLCipher database file name inside the diary directory.
pub const DB_FILE: &str = "diary.db";

/// Current schema version (`PRAGMA user_version`).
pub const DB_VERSION: i64 = 1;

/// HKDF info string for the SQLCipher key.
const DB_KEY_INFO: &[u8] = b"fly-diary/sqlcipher/v1";

/// HKDF info string for new attachment sidecars.
const ATTACHMENT_KEY_INFO: &[u8] = b"fly-diary/attachment/v3";

/// Temporary database used while migrating from the XML layout.
const MIGRATING_FILE: &str = "diary.db.migrating";

/// How the directory is currently stored.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum StorageFormat {
    /// `diary.db` exists; the SQLCipher store is authoritative.
    Sqlcipher,
    /// `vault.xml` exists without `diary.db`; the old XML layout.
    Legacy,
    /// No vault at all.
    Empty,
}

/// Snapshot of what the lock screen should offer.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageStatus {
    pub format: StorageFormat,
    pub has_vault: bool,
    pub has_database: bool,
}

/// One date that could not be migrated.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationFailure {
    pub date: String,
    pub reason: String,
}

/// Result of the one-way XML -> SQLCipher migration.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationReport {
    pub migrated: usize,
    pub attachments: usize,
    pub broken: Vec<MigrationFailure>,
    /// Files that could not be cleaned up or preserved.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<String>,
}

/// One attachment manifest row stored inside the database.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AttachmentRow {
    pub id: String,
    pub mime: String,
    pub width: u32,
    pub height: u32,
    pub position: i64,
}

/// Result of an integrity check.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegrityReport {
    pub ok: bool,
    pub messages: Vec<String>,
}

/// The database file path.
pub fn db_path(dir: &Path) -> PathBuf {
    dir.join(DB_FILE)
}

/// Whether a SQLCipher database is present.
pub fn database_exists(dir: &Path) -> bool {
    db_path(dir).is_file()
}

/// Classify the directory without needing the diary key.
pub fn format_status(dir: &Path) -> StorageStatus {
    let has_database = database_exists(dir);
    let has_vault = storage::vault_exists(dir).unwrap_or(false);
    let format = if has_database {
        StorageFormat::Sqlcipher
    } else if has_vault {
        StorageFormat::Legacy
    } else {
        StorageFormat::Empty
    };
    StorageStatus {
        format,
        has_vault,
        has_database,
    }
}

// ---------------------------------------------------------------------------
// Key derivation
// ---------------------------------------------------------------------------

fn derive_subkey(root: &[u8; 32], info: &[u8]) -> Zeroizing<[u8; 32]> {
    let hkdf = Hkdf::<Sha256>::new(None, root);
    let mut out = Zeroizing::new([0u8; 32]);
    hkdf.expand(info, out.as_mut())
        .expect("32 bytes is a valid HKDF-SHA256 output length");
    out
}

/// Derive the SQLCipher raw key from the diary key.
pub fn derive_db_key(diary_key: &[u8; 32]) -> Zeroizing<[u8; 32]> {
    derive_subkey(diary_key, DB_KEY_INFO)
}

/// Derive the attachment sidecar key for new images.
pub fn derive_attachment_key(diary_key: &[u8; 32]) -> Zeroizing<[u8; 32]> {
    derive_subkey(diary_key, ATTACHMENT_KEY_INFO)
}

fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0x0f) as usize] as char);
    }
    out
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn file_mtime_ms(path: &Path) -> Option<i64> {
    fs::metadata(path)
        .ok()?
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|duration| duration.as_millis() as i64)
}

// ---------------------------------------------------------------------------
// Opening and configuring SQLCipher
// ---------------------------------------------------------------------------

fn apply_key(conn: &Connection, diary_key: &[u8; 32]) -> Result<(), String> {
    // These are safe to set before the key. SQLCipher ignores unknown pragmas,
    // so an older cipher build still opens the database; pinning the defaults
    // keeps future SQLCipher releases from changing the page format silently.
    conn.execute_batch(
        "PRAGMA cipher_memory_security = ON;\n\
         PRAGMA cipher_page_size = 4096;\n\
         PRAGMA cipher_hmac_algorithm = HMAC_SHA512;\n\
         PRAGMA cipher_kdf_algorithm = PBKDF2_HMAC_SHA512;",
    )
    .map_err(|e| format!("Failed to configure SQLCipher: {e}"))?;

    let db_key = derive_db_key(diary_key);
    let mut hex = Zeroizing::new(hex_encode(db_key.as_ref()));
    let mut sql = Zeroizing::new(format!("PRAGMA key = \"x'{}'\";", hex.as_str()));
    let result = conn
        .execute_batch(&sql)
        .map_err(|e| format!("Failed to apply the database key: {e}"));
    hex.zeroize();
    sql.zeroize();
    result?;

    // Force SQLCipher to read the first page, which verifies the HMAC and the
    // key. A wrong key produces SQLITE_NOTADB here, not on a later command.
    conn.query_row("SELECT count(*) FROM sqlite_master", [], |_| Ok(()))
        .map_err(|_| "This database cannot be opened with the current diary key".to_string())?;
    Ok(())
}

fn configure(conn: &Connection) -> Result<(), String> {
    conn.busy_timeout(Duration::from_secs(5))
        .map_err(|e| format!("Failed to set busy timeout: {e}"))?;
    conn.pragma_update(None, "foreign_keys", true)
        .map_err(|e| format!("Failed to enable foreign keys: {e}"))?;
    conn.pragma_update(None, "synchronous", "FULL")
        .map_err(|e| format!("Failed to set synchronous mode: {e}"))?;
    conn.execute_batch("PRAGMA secure_delete = ON;")
        .map_err(|e| format!("Failed to enable secure delete: {e}"))?;
    // `PRAGMA journal_mode` returns the new mode, so it cannot go through
    // `pragma_update` (which expects no rows).
    let mode: String = conn
        .query_row("PRAGMA journal_mode = WAL", [], |row| row.get(0))
        .map_err(|e| format!("Failed to enable WAL: {e}"))?;
    if !mode.eq_ignore_ascii_case("wal") {
        return Err(format!("SQLite refused WAL mode (got {mode})"));
    }
    Ok(())
}

fn check_schema(conn: &Connection) -> Result<(), String> {
    let version: i64 = conn
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(|e| format!("Failed to read the database version: {e}"))?;
    if version == 0 {
        return Err("This file is not a Fly Diary database".to_string());
    }
    if version > DB_VERSION {
        return Err(format!(
            "This diary was created by a newer version (schema {version}, this build supports {DB_VERSION})"
        ));
    }
    Ok(())
}

/// Open an existing database with the diary key.
pub fn open(dir: &Path, diary_key: &[u8; 32]) -> Result<Connection, String> {
    let path = db_path(dir);
    if !path.is_file() {
        return Err(
            "This workspace has not been migrated to the encrypted SQLite format yet".to_string(),
        );
    }
    let conn = Connection::open_with_flags(
        &path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| format!("Failed to open the diary database: {e}"))?;
    apply_key(&conn, diary_key)?;
    check_schema(&conn)?;
    configure(&conn)?;
    Ok(conn)
}

/// Verify that the database opens and belongs to the given vault.
pub fn verify(dir: &Path, diary_key: &[u8; 32], context: &VaultContext) -> Result<(), String> {
    let conn = open(dir, diary_key)?;
    verify_context(&conn, context)
}

/// Verify a database snapshot without switching it to WAL.
///
/// A backup is a standalone `VACUUM INTO` output. Opening it read-only avoids
/// creating `-wal`/`-shm` sidecars next to the file that is about to be
/// installed, and keeps the extracted archive byte-for-byte what the user
/// backed up.
pub fn verify_snapshot(
    dir: &Path,
    diary_key: &[u8; 32],
    context: &VaultContext,
) -> Result<(), String> {
    let path = db_path(dir);
    if !path.is_file() {
        return Err("The backup does not contain diary.db".to_string());
    }
    let conn = Connection::open_with_flags(
        &path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| format!("Failed to open the backup database: {e}"))?;
    apply_key(&conn, diary_key)?;
    check_schema(&conn)?;
    verify_context(&conn, context)
}

fn verify_context(conn: &Connection, context: &VaultContext) -> Result<(), String> {
    let stored_vault = meta_value(conn, "vault_id")?;
    let stored_key = meta_value(conn, "key_id")?;
    let expected_vault = crypto::b64_encode(&context.vault_id);
    let expected_key = crypto::b64_encode(&context.key_id);
    if stored_vault.as_deref() != Some(expected_vault.as_str())
        || stored_key.as_deref() != Some(expected_key.as_str())
    {
        return Err("The diary database belongs to a different vault".to_string());
    }
    Ok(())
}

fn meta_value(conn: &Connection, name: &str) -> Result<Option<String>, String> {
    conn.query_row(
        "SELECT value FROM meta WHERE key = ?1",
        params![name],
        |row| row.get::<_, String>(0),
    )
    .optional()
    .map_err(|e| format!("Failed to read database metadata: {e}"))
}

fn init_schema(conn: &Connection, context: &VaultContext) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS meta (
             key   TEXT PRIMARY KEY,
             value TEXT NOT NULL
         ) WITHOUT ROWID;

         CREATE TABLE IF NOT EXISTS entries (
             date       TEXT PRIMARY KEY,
             title      TEXT NOT NULL,
             content    TEXT NOT NULL,
             favourite  INTEGER NOT NULL DEFAULT 0,
             created_at INTEGER NOT NULL,
             updated_at INTEGER NOT NULL
         ) WITHOUT ROWID;

         CREATE INDEX IF NOT EXISTS entries_favourite_date
             ON entries(favourite, date DESC);

         CREATE TABLE IF NOT EXISTS attachments (
             date     TEXT NOT NULL,
             id       TEXT NOT NULL,
             mime     TEXT NOT NULL,
             width    INTEGER NOT NULL DEFAULT 0,
             height   INTEGER NOT NULL DEFAULT 0,
             position INTEGER NOT NULL,
             PRIMARY KEY (date, id)
         ) WITHOUT ROWID;

         CREATE INDEX IF NOT EXISTS attachments_date_position
             ON attachments(date, position);

         CREATE TABLE IF NOT EXISTS attachment_manifests (
             date       TEXT PRIMARY KEY,
             updated_at INTEGER NOT NULL
         ) WITHOUT ROWID;

         CREATE TABLE IF NOT EXISTS legacy_broken (
             date   TEXT PRIMARY KEY,
             reason TEXT NOT NULL,
             size   INTEGER NOT NULL,
             data   BLOB NOT NULL
         );",
    )
    .map_err(|e| format!("Failed to create the database schema: {e}"))?;

    let mut stmt = conn
        .prepare(
            "INSERT INTO meta (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        )
        .map_err(|e| format!("Failed to prepare metadata write: {e}"))?;
    let values = [
        ("schema_version", DB_VERSION.to_string()),
        ("format", "sqlcipher".to_string()),
        ("vault_id", crypto::b64_encode(&context.vault_id)),
        ("key_id", crypto::b64_encode(&context.key_id)),
    ];
    for (key, value) in values {
        stmt.execute(params![key, value])
            .map_err(|e| format!("Failed to write database metadata: {e}"))?;
    }
    drop(stmt);

    conn.pragma_update(None, "user_version", DB_VERSION)
        .map_err(|e| format!("Failed to set the database version: {e}"))?;
    Ok(())
}

#[cfg(unix)]
fn create_private_file(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::OpenOptionsExt;
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)?;
    Ok(())
}

#[cfg(not(unix))]
fn create_private_file(path: &Path) -> std::io::Result<()> {
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)?;
    Ok(())
}

fn tighten_permissions(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
    }
    #[cfg(not(unix))]
    {
        let _ = path;
    }
}

fn tighten_sidecars(path: &Path) {
    let name = match path.file_name().and_then(|name| name.to_str()) {
        Some(name) => name,
        None => return,
    };
    let Some(parent) = path.parent() else {
        return;
    };
    for suffix in ["-wal", "-shm"] {
        tighten_permissions(&parent.join(format!("{name}{suffix}")));
    }
}

fn create_at(
    path: &Path,
    diary_key: &[u8; 32],
    context: &VaultContext,
) -> Result<Connection, String> {
    create_private_file(path).map_err(|e| format!("Failed to create the database file: {e}"))?;
    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| format!("Failed to open the new database: {e}"))?;
    apply_key(&conn, diary_key)?;
    conn.execute_batch("PRAGMA journal_mode = DELETE; PRAGMA synchronous = OFF;")
        .map_err(|e| format!("Failed to configure the new database: {e}"))?;
    init_schema(&conn, context)?;
    Ok(conn)
}

fn finalize(conn: Connection, path: &Path) -> Result<(), String> {
    let check: String = conn
        .query_row("PRAGMA quick_check", [], |row| row.get(0))
        .map_err(|e| format!("Failed to check the new database: {e}"))?;
    if !check.eq_ignore_ascii_case("ok") {
        return Err(format!("New database failed its integrity check: {check}"));
    }
    conn.execute_batch("PRAGMA journal_mode = DELETE;")
        .map_err(|e| format!("Failed to close the new database cleanly: {e}"))?;
    conn.close()
        .map_err(|(_, error)| format!("Failed to close the new database: {error}"))?;
    tighten_permissions(path);
    Ok(())
}

fn install_new_database(temp: &Path, target: &Path, dir: &Path) -> Result<(), String> {
    if target.exists() {
        return Err("The SQLite database was created while this operation was running".to_string());
    }
    // The database was built with `synchronous=OFF` for speed. Flush the file
    // contents before the rename so a power loss cannot leave a complete-looking
    // file whose pages were still in the page cache.
    fs::OpenOptions::new()
        .write(true)
        .open(temp)
        .and_then(|file| file.sync_all())
        .map_err(|e| format!("Failed to flush the new database: {e}"))?;
    fs::rename(temp, target).map_err(|e| format!("Failed to install the database: {e}"))?;
    fsutil::sync_dir(dir).map_err(|e| format!("Failed to flush the diary directory: {e}"))?;
    tighten_permissions(target);
    tighten_sidecars(target);
    Ok(())
}

/// Create an empty SQLCipher database for a brand-new vault.
pub fn create_empty(
    dir: &Path,
    diary_key: &[u8; 32],
    context: &VaultContext,
) -> Result<(), String> {
    storage::ensure_dir(dir)?;
    let target = db_path(dir);
    if target.is_file() {
        return verify(dir, diary_key, context);
    }
    let temp = dir.join(format!("{MIGRATING_FILE}.new"));
    let _ = fs::remove_file(&temp);
    let conn = create_at(&temp, diary_key, context)?;
    finalize(conn, &temp)?;
    install_new_database(&temp, &target, dir)
}

/// Remove a database left behind by a vault whose `vault.xml` no longer exists.
///
/// Creating a new vault generates a fresh diary key, so any old database in the
/// same folder is undecryptable. Removing it keeps the folder from carrying an
/// orphaned encrypted file; the stale `recovery.xml` is removed for the same
/// reason in `storage::create_vault`.
pub fn remove_database(dir: &Path) -> Result<(), String> {
    let paths = [
        db_path(dir),
        dir.join(format!("{DB_FILE}-wal")),
        dir.join(format!("{DB_FILE}-shm")),
        dir.join(MIGRATING_FILE),
        dir.join(format!("{MIGRATING_FILE}.new")),
    ];
    for path in paths {
        match fs::remove_file(&path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(format!(
                    "Failed to remove the stale diary database {}: {error}",
                    path.display()
                ))
            }
        }
    }
    let _ = fsutil::sync_dir(dir);
    Ok(())
}

// ---------------------------------------------------------------------------
// XML -> SQLCipher migration
// ---------------------------------------------------------------------------

/// Legacy sync-only folders contain `.fd` records but no `diary.db`. They were
/// produced by the old Android folder-sync feature and can only be rebuilt by
/// that release; creating an empty database here would hide the only copy.
fn has_legacy_sync_records(dir: &Path) -> bool {
    let Ok(read_dir) = fs::read_dir(dir) else {
        return false;
    };
    read_dir.flatten().any(|item| {
        let path = item.path();
        path.extension().and_then(|ext| ext.to_str()) == Some("fd")
            && path
                .file_stem()
                .and_then(|stem| stem.to_str())
                .is_some_and(|date| storage::validate_date(date).is_ok())
    })
}

fn list_entry_dates(dir: &Path) -> Result<Vec<String>, String> {
    storage::ensure_dir(dir)?;
    let read_dir = fs::read_dir(dir).map_err(|e| format!("Failed to read diary directory: {e}"))?;
    let mut dates = Vec::new();
    for item in read_dir {
        let item = item.map_err(|e| format!("Failed to read directory entry: {e}"))?;
        let path = item.path();
        if path.extension().and_then(|s| s.to_str()) != Some("xml") {
            continue;
        }
        let Some(date) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        if storage::validate_date(date).is_ok() {
            dates.push(date.to_string());
        }
    }
    dates.sort();
    Ok(dates)
}

fn insert_entry(
    conn: &Connection,
    date: &str,
    title: &str,
    content: &str,
    favourite: bool,
    timestamp: i64,
) -> Result<(), String> {
    conn.execute(
        "INSERT INTO entries (date, title, content, favourite, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?5)
         ON CONFLICT(date) DO UPDATE SET
             title = excluded.title,
             content = excluded.content,
             favourite = excluded.favourite,
             updated_at = excluded.updated_at",
        params![date, title, content, favourite as i64, timestamp],
    )
    .map_err(|e| format!("Failed to write entry {date}: {e}"))?;
    Ok(())
}

/// Migrate the legacy XML diary into a new SQLCipher database.
///
/// This is a one-time break-change migration. After the database is installed
/// the XML entry and manifest files are deleted; only `vault.xml` and
/// `recovery.xml` remain. Unreadable entries are preserved as raw bytes in
/// `legacy_broken` so they can still be listed and exported. The database is
/// built under a temporary name and renamed only after a successful integrity
/// check, so an interrupted migration leaves the old layout usable and can
/// simply be retried.
pub fn migrate_from_xml(dir: &Path, diary_key: &[u8; 32]) -> Result<MigrationReport, String> {
    storage::ensure_dir(dir)?;

    let target = db_path(dir);
    let context = storage::vault_context(dir)?.ok_or_else(|| {
        "Unlock this vault once so it can be upgraded before migrating".to_string()
    })?;

    if target.is_file() {
        verify(dir, diary_key, &context)?;
        let warnings = cleanup_legacy_xml(dir, diary_key)?;
        return Ok(MigrationReport {
            warnings,
            ..MigrationReport::default()
        });
    }

    if has_legacy_sync_records(dir) {
        return Err(
            "This folder contains legacy .fd sync records but no database. Rebuild or export it with Fly Diary 1.0.0 before upgrading; this version no longer reads .fd files."
                .to_string(),
        );
    }

    // A wrong key would otherwise build an empty database and report every
    // entry as broken. The index (or the first readable entry) is the cheapest
    // proof that this key belongs to the XML vault.
    if !storage::diary_key_matches(dir, diary_key)? {
        return Err("This diary key does not match the XML entries".to_string());
    }

    let temp = dir.join(MIGRATING_FILE);
    let _ = fs::remove_file(&temp);
    let mut conn = create_at(&temp, diary_key, &context)?;

    let mut report = MigrationReport::default();
    let dates = list_entry_dates(dir)?;
    {
        let transaction = conn
            .transaction()
            .map_err(|e| format!("Failed to start the migration transaction: {e}"))?;
        for date in &dates {
            match storage::read_entry_with_context(dir, diary_key, date, Some(&context)) {
                Ok(Some(entry)) => {
                    let timestamp = storage::entry_path(dir, date)
                        .ok()
                        .and_then(|path| file_mtime_ms(&path))
                        .unwrap_or_else(now_ms);
                    insert_entry(
                        &transaction,
                        date,
                        &entry.title,
                        &entry.content,
                        entry.favourite,
                        timestamp,
                    )?;
                    report.migrated += 1;
                }
                Ok(None) => {}
                Err(reason) => {
                    // The break-change migration removes XML files after a
                    // successful run. Preserve the unreadable bytes inside the
                    // encrypted database instead of leaving the only copy of a
                    // damaged day on disk as XML.
                    let source = dir.join(format!("{date}.xml"));
                    match fs::read(&source) {
                        Ok(data) if !data.is_empty() => {
                            transaction
                                .execute(
                                    "INSERT INTO legacy_broken (date, reason, size, data)
                                     VALUES (?1, ?2, ?3, ?4)
                                     ON CONFLICT(date) DO UPDATE SET
                                         reason = excluded.reason,
                                         size = excluded.size,
                                         data = excluded.data",
                                    params![date, &reason, data.len() as i64, &data[..]],
                                )
                                .map_err(|e| {
                                    format!("Failed to preserve broken entry {date}: {e}")
                                })?;
                        }
                        Ok(_) => report
                            .warnings
                            .push(format!("{date}: {reason} (empty original; left in place)")),
                        Err(error) => report.warnings.push(format!(
                            "{date}: {reason} (could not read the original: {error}; left in place)"
                        )),
                    }
                    report.broken.push(MigrationFailure {
                        date: date.clone(),
                        reason,
                    });
                }
            }
        }

        // Attachment manifests are still XML at this point. Import their
        // order/MIME metadata; the image bytes stay as sidecars.
        let root = dir.join("attachments");
        if let Ok(read_dir) = fs::read_dir(&root) {
            for item in read_dir.flatten() {
                let path = item.path();
                if !path.is_dir() {
                    continue;
                }
                let Some(date) = path.file_name().and_then(|s| s.to_str()) else {
                    continue;
                };
                if storage::validate_date(date).is_err() {
                    continue;
                }
                let items = crate::attachments::legacy_manifest_items(dir, diary_key, date)
                    .unwrap_or_default();
                let has_items = !items.is_empty();
                for (position, (id, mime, width, height)) in items.into_iter().enumerate() {
                    transaction
                        .execute(
                            "INSERT INTO attachments
                                 (date, id, mime, width, height, position)
                             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                             ON CONFLICT(date, id) DO UPDATE SET
                                 mime = excluded.mime,
                                 width = excluded.width,
                                 height = excluded.height,
                                 position = excluded.position",
                            params![date, id, mime, width as i64, height as i64, position as i64],
                        )
                        .map_err(|e| format!("Failed to migrate attachments for {date}: {e}"))?;
                    report.attachments += 1;
                }
                if has_items {
                    let timestamp =
                        file_mtime_ms(&path.join("manifest.xml")).unwrap_or_else(now_ms);
                    transaction
                        .execute(
                            "INSERT INTO attachment_manifests (date, updated_at)
                             VALUES (?1, ?2)
                             ON CONFLICT(date) DO UPDATE SET updated_at = excluded.updated_at",
                            params![date, timestamp],
                        )
                        .map_err(|e| {
                            format!("Failed to migrate attachment manifest for {date}: {e}")
                        })?;
                }
            }
        }

        transaction
            .commit()
            .map_err(|e| format!("Failed to commit the migration: {e}"))?;
    }

    finalize(conn, &temp)?;
    install_new_database(&temp, &target, dir)?;
    report.warnings.extend(cleanup_legacy_xml(dir, diary_key)?);
    Ok(report)
}

/// Delete XML entry files whose data is safely in the database.
///
/// Migration is a break change: the folder keeps only `vault.xml`,
/// `recovery.xml`, the SQLCipher database and the attachment sidecars. A file
/// whose bytes could not be preserved is left in place and reported, because
/// deleting the only copy of damaged data would be worse than leaving one stray
/// XML file.
fn cleanup_legacy_xml(dir: &Path, diary_key: &[u8; 32]) -> Result<Vec<String>, String> {
    let conn = open(dir, diary_key)?;
    let mut known = HashSet::new();
    let mut stmt = conn
        .prepare("SELECT date FROM entries")
        .map_err(|e| format!("Failed to read entries during cleanup: {e}"))?;
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| format!("Failed to read entries during cleanup: {e}"))?;
    for row in rows {
        known.insert(row.map_err(|e| format!("Failed to read entries during cleanup: {e}"))?);
    }
    drop(stmt);

    let mut stmt = conn
        .prepare("SELECT date FROM legacy_broken")
        .map_err(|e| format!("Failed to read preserved entries during cleanup: {e}"))?;
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| format!("Failed to read preserved entries during cleanup: {e}"))?;
    for row in rows {
        known.insert(
            row.map_err(|e| format!("Failed to read preserved entries during cleanup: {e}"))?,
        );
    }
    drop(stmt);

    let mut warnings = Vec::new();
    for date in list_entry_dates(dir)? {
        let path = dir.join(format!("{date}.xml"));
        if known.contains(&date) {
            match fs::remove_file(&path) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => warnings.push(format!(
                    "Could not remove {}.xml after migration: {error}",
                    date
                )),
            }
        } else {
            warnings.push(format!(
                "{}.xml is not in the database and was left in place",
                date
            ));
        }
    }

    let _ = fs::remove_file(dir.join("index.xml"));

    let root = dir.join("attachments");
    if let Ok(read_dir) = fs::read_dir(&root) {
        for item in read_dir.flatten() {
            let path = item.path();
            if !path.is_dir() {
                continue;
            }
            let manifest = path.join("manifest.xml");
            if !manifest.is_file() {
                continue;
            }
            if let Err(error) = fs::remove_file(&manifest) {
                warnings.push(format!("Could not remove {}: {error}", manifest.display()));
            }
        }
    }

    Ok(warnings)
}

// ---------------------------------------------------------------------------
// Entries
// ---------------------------------------------------------------------------

fn read_row(conn: &Connection, date: &str) -> Result<Option<(String, String, bool)>, String> {
    conn.query_row(
        "SELECT title, content, favourite FROM entries WHERE date = ?1",
        params![date],
        |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)? != 0,
            ))
        },
    )
    .optional()
    .map_err(|e| format!("Failed to read entry {date}: {e}"))
}

/// Read one entry from the database.
pub fn read_entry(dir: &Path, diary_key: &[u8; 32], date: &str) -> Result<Option<Entry>, String> {
    storage::validate_date(date)?;
    let conn = open(dir, diary_key)?;
    let row = conn
        .query_row(
            "SELECT title, content, favourite FROM entries WHERE date = ?1",
            params![date],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)? != 0,
                ))
            },
        )
        .optional()
        .map_err(|e| format!("Failed to read entry {date}: {e}"))?;
    Ok(row.map(|(title, content, favourite)| Entry {
        date: date.to_string(),
        title,
        content,
        favourite,
    }))
}

/// Write one entry. The favourite flag is preserved across ordinary saves.
pub fn write_entry(
    dir: &Path,
    diary_key: &[u8; 32],
    date: &str,
    title: &str,
    content: &str,
) -> Result<(), String> {
    storage::validate_date(date)?;
    let conn = open(dir, diary_key)?;
    let existing = read_row(&conn, date)?;
    let favourite = existing.as_ref().map(|(_, _, flag)| *flag).unwrap_or(false);

    conn.execute(
        "INSERT INTO entries (date, title, content, favourite, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?5)
         ON CONFLICT(date) DO UPDATE SET
             title = excluded.title,
             content = excluded.content,
             updated_at = excluded.updated_at",
        params![date, title, content, favourite as i64, now_ms()],
    )
    .map_err(|e| format!("Failed to write entry {date}: {e}"))?;
    Ok(())
}

/// Mark or unmark an entry as a favourite. Returns the stored flag.
pub fn set_favourite(
    dir: &Path,
    diary_key: &[u8; 32],
    date: &str,
    favourite: bool,
) -> Result<bool, String> {
    storage::validate_date(date)?;
    let conn = open(dir, diary_key)?;
    let Some((_title, _content, current)) = read_row(&conn, date)? else {
        return Ok(false);
    };
    if current == favourite {
        return Ok(true);
    }
    conn.execute(
        "UPDATE entries SET favourite = ?1, updated_at = ?2 WHERE date = ?3",
        params![favourite as i64, now_ms(), date],
    )
    .map_err(|e| format!("Failed to update entry {date}: {e}"))?;
    Ok(true)
}

/// Delete an entry and its attachment metadata.
pub fn delete_entry(dir: &Path, diary_key: &[u8; 32], date: &str) -> Result<(), String> {
    storage::validate_date(date)?;
    let conn = open(dir, diary_key)?;
    // Attachment metadata has no foreign key because orphan attachment folders
    // (a date without an entry) are a supported state that the settings screen
    // can inspect and clean up. Remove the child rows explicitly instead.
    conn.execute("DELETE FROM attachments WHERE date = ?1", params![date])
        .map_err(|e| format!("Failed to delete attachment metadata for {date}: {e}"))?;
    conn.execute(
        "DELETE FROM attachment_manifests WHERE date = ?1",
        params![date],
    )
    .map_err(|e| format!("Failed to delete attachment metadata for {date}: {e}"))?;
    conn.execute("DELETE FROM legacy_broken WHERE date = ?1", params![date])
        .map_err(|e| format!("Failed to delete preserved broken entry {date}: {e}"))?;
    conn.execute("DELETE FROM entries WHERE date = ?1", params![date])
        .map_err(|e| format!("Failed to delete entry {date}: {e}"))?;
    let _ = crate::attachments::delete_all_for_date(dir, date);
    let _ = fsutil::sync_dir(dir);
    Ok(())
}

/// All dates that currently have an entry row.
pub fn entry_dates(dir: &Path, diary_key: &[u8; 32]) -> Result<HashSet<String>, String> {
    let conn = open(dir, diary_key)?;
    let mut stmt = conn
        .prepare("SELECT date FROM entries")
        .map_err(|e| format!("Failed to list entry dates: {e}"))?;
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| format!("Failed to list entry dates: {e}"))?;
    rows.collect::<rusqlite::Result<HashSet<_>>>()
        .map_err(|e| format!("Failed to list entry dates: {e}"))
}

/// List all entries, newest first.
pub fn list_entries(dir: &Path, diary_key: &[u8; 32]) -> Result<Vec<EntryMeta>, String> {
    storage::ensure_dir(dir)?;
    let conn = open(dir, diary_key)?;
    let mut stmt = conn
        .prepare(
            "SELECT date, title, favourite,
                    length(CAST(title AS BLOB)) + length(CAST(content AS BLOB))
             FROM entries ORDER BY date DESC",
        )
        .map_err(|e| format!("Failed to list entries: {e}"))?;
    let rows = stmt
        .query_map([], |row| {
            Ok(EntryMeta {
                date: row.get(0)?,
                title: row.get(1)?,
                size: row.get::<_, i64>(3)? as u64,
                favourite: row.get::<_, i64>(2)? != 0,
            })
        })
        .map_err(|e| format!("Failed to list entries: {e}"))?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| format!("Failed to list entries: {e}"))
}

/// List only favourite entries, newest first.
pub fn list_favourites(dir: &Path, diary_key: &[u8; 32]) -> Result<Vec<EntryMeta>, String> {
    let conn = open(dir, diary_key)?;
    let mut stmt = conn
        .prepare(
            "SELECT date, title, favourite,
                    length(CAST(title AS BLOB)) + length(CAST(content AS BLOB))
             FROM entries WHERE favourite = 1 ORDER BY date DESC",
        )
        .map_err(|e| format!("Failed to list favourites: {e}"))?;
    let rows = stmt
        .query_map([], |row| {
            Ok(EntryMeta {
                date: row.get(0)?,
                title: row.get(1)?,
                size: row.get::<_, i64>(3)? as u64,
                favourite: true,
            })
        })
        .map_err(|e| format!("Failed to list favourites: {e}"))?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| format!("Failed to list favourites: {e}"))
}

/// All decrypted entry contents, used to build the session search index.
pub fn scan_entry_contents(dir: &Path, diary_key: &[u8; 32]) -> Result<ScanResult, String> {
    let conn = open(dir, diary_key)?;
    let mut stmt = conn
        .prepare("SELECT date, title, content, favourite FROM entries ORDER BY date ASC")
        .map_err(|e| format!("Failed to scan entries: {e}"))?;
    let rows = stmt
        .query_map([], |row| {
            Ok(ScannedEntry {
                date: row.get(0)?,
                title: Zeroizing::new(row.get::<_, String>(1)?),
                content: Zeroizing::new(row.get::<_, String>(2)?),
                favourite: row.get::<_, i64>(3)? != 0,
            })
        })
        .map_err(|e| format!("Failed to scan entries: {e}"))?;
    let entries = rows
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| format!("Failed to scan entries: {e}"))?;
    Ok(ScanResult {
        entries,
        broken: read_broken_entries(&conn)?,
    })
}

fn read_broken_entries(conn: &Connection) -> Result<Vec<BrokenEntry>, String> {
    let mut stmt = conn
        .prepare("SELECT date, size, reason FROM legacy_broken ORDER BY date DESC")
        .map_err(|e| format!("Failed to list preserved broken entries: {e}"))?;
    let rows = stmt
        .query_map([], |row| {
            let reason: String = row.get(2)?;
            Ok(BrokenEntry {
                date: row.get(0)?,
                size: row.get::<_, i64>(1)? as u64,
                reason: classify_broken_reason(&reason),
            })
        })
        .map_err(|e| format!("Failed to list preserved broken entries: {e}"))?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| format!("Failed to list preserved broken entries: {e}"))
}

/// Broken entries preserved in the encrypted database during migration.
pub fn list_broken_entries(dir: &Path, diary_key: &[u8; 32]) -> Result<Vec<BrokenEntry>, String> {
    let conn = open(dir, diary_key)?;
    read_broken_entries(&conn)
}

fn classify_broken_reason(reason: &str) -> BrokenReason {
    let lower = reason.to_lowercase();
    if lower.contains("tag") || lower.contains("decrypt") || lower.contains("key") {
        BrokenReason::DecryptFailed
    } else if lower.contains("base64") || lower.contains("encoding") {
        BrokenReason::BadEncoding
    } else if lower.contains("xml") || lower.contains("document") || lower.contains("malformed") {
        BrokenReason::MalformedXml
    } else {
        BrokenReason::Unreadable
    }
}

/// Raw bytes of a legacy XML entry that could not be migrated.
pub fn legacy_broken_bytes(
    dir: &Path,
    diary_key: &[u8; 32],
    date: &str,
) -> Result<Option<Vec<u8>>, String> {
    storage::validate_date(date)?;
    let conn = open(dir, diary_key)?;
    conn.query_row(
        "SELECT data FROM legacy_broken WHERE date = ?1",
        params![date],
        |row| row.get::<_, Vec<u8>>(0),
    )
    .optional()
    .map_err(|e| format!("Failed to read preserved broken entry {date}: {e}"))
}

/// The dates that already exist, for import conflict detection.
pub fn known_dates(
    dir: &Path,
    diary_key: &[u8; 32],
) -> Result<BTreeMap<String, IndexRecord>, String> {
    let conn = open(dir, diary_key)?;
    let mut stmt = conn
        .prepare("SELECT date, title, favourite FROM entries")
        .map_err(|e| format!("Failed to read existing entries: {e}"))?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                IndexRecord {
                    title: row.get(1)?,
                    favourite: row.get::<_, i64>(2)? != 0,
                },
            ))
        })
        .map_err(|e| format!("Failed to read existing entries: {e}"))?;
    let mut map = BTreeMap::new();
    for row in rows {
        let (date, record) = row.map_err(|e| format!("Failed to read existing entries: {e}"))?;
        map.insert(date, record);
    }
    Ok(map)
}

/// Whether the database can be opened with `diary_key`.
///
/// Returns `true` when no database exists yet, because recovery still has to
/// support legacy XML vaults.
pub fn key_matches(dir: &Path, diary_key: &[u8; 32]) -> Result<bool, String> {
    if !database_exists(dir) {
        return Ok(true);
    }
    match open(dir, diary_key) {
        Ok(_) => Ok(true),
        Err(_) => Ok(false),
    }
}

// ---------------------------------------------------------------------------
// Attachment manifests (metadata only; image bytes stay in sidecars)
// ---------------------------------------------------------------------------

/// Read the ordered attachment rows for a date.
fn read_attachment_rows(conn: &Connection, date: &str) -> Result<Vec<AttachmentRow>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, mime, width, height, position
             FROM attachments WHERE date = ?1 ORDER BY position ASC, id ASC",
        )
        .map_err(|e| format!("Failed to read attachment manifest: {e}"))?;
    let rows = stmt
        .query_map(params![date], |row| {
            Ok(AttachmentRow {
                id: row.get(0)?,
                mime: row.get(1)?,
                width: row.get::<_, i64>(2)? as u32,
                height: row.get::<_, i64>(3)? as u32,
                position: row.get(4)?,
            })
        })
        .map_err(|e| format!("Failed to read attachment manifest: {e}"))?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| format!("Failed to read attachment manifest: {e}"))
}

pub fn read_attachment_manifest(
    dir: &Path,
    diary_key: &[u8; 32],
    date: &str,
) -> Result<Vec<AttachmentRow>, String> {
    storage::validate_date(date)?;
    let conn = open(dir, diary_key)?;
    read_attachment_rows(&conn, date)
}

/// Replace every attachment row for a date.
pub fn replace_attachment_manifest(
    dir: &Path,
    diary_key: &[u8; 32],
    date: &str,
    rows: &[AttachmentRow],
) -> Result<(), String> {
    storage::validate_date(date)?;
    let mut conn = open(dir, diary_key)?;
    let transaction = conn
        .transaction()
        .map_err(|e| format!("Failed to update attachment manifest: {e}"))?;
    transaction
        .execute("DELETE FROM attachments WHERE date = ?1", params![date])
        .map_err(|e| format!("Failed to update attachment manifest: {e}"))?;
    for (position, row) in rows.iter().enumerate() {
        transaction
            .execute(
                "INSERT INTO attachments (date, id, mime, width, height, position)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    date,
                    row.id,
                    row.mime,
                    row.width as i64,
                    row.height as i64,
                    position as i64
                ],
            )
            .map_err(|e| format!("Failed to update attachment manifest: {e}"))?;
    }
    transaction
        .execute(
            "INSERT INTO attachment_manifests (date, updated_at)
             VALUES (?1, ?2)
             ON CONFLICT(date) DO UPDATE SET updated_at = excluded.updated_at",
            params![date, now_ms()],
        )
        .map_err(|e| format!("Failed to update attachment manifest: {e}"))?;
    transaction
        .commit()
        .map_err(|e| format!("Failed to update attachment manifest: {e}"))
}

/// Delete the attachment rows for one date, or one image when `id` is given.
pub fn delete_attachment_rows(
    dir: &Path,
    diary_key: &[u8; 32],
    date: &str,
    id: Option<&str>,
) -> Result<(), String> {
    storage::validate_date(date)?;
    let conn = open(dir, diary_key)?;
    let result = match id {
        Some(id) => conn.execute(
            "DELETE FROM attachments WHERE date = ?1 AND id = ?2",
            params![date, id],
        ),
        None => conn.execute("DELETE FROM attachments WHERE date = ?1", params![date]),
    };
    result
        .map(|_| ())
        .map_err(|e| format!("Failed to delete attachment metadata: {e}"))?;
    if id.is_none() {
        conn.execute(
            "DELETE FROM attachment_manifests WHERE date = ?1",
            params![date],
        )
        .map_err(|e| format!("Failed to delete attachment metadata: {e}"))?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

const MAX_IMPORT_BYTES: u64 = 8 * 1024 * 1024;

/// Import `.txt` files into the database.
///
/// The old XML importer wrote one file per date and rebuilt the index once.
/// Here the whole batch is one transaction, so a few thousand files do not
/// produce a few thousand commits, and the per-day sync records are refreshed
/// after the commit.
pub fn import_entries_with_progress<F>(
    dir: &Path,
    diary_key: &[u8; 32],
    import_dir: &Path,
    dates: &[String],
    overwrite: bool,
    progress: F,
) -> Result<storage::ImportReport, String>
where
    F: Fn(usize, usize) + Sync,
{
    storage::ensure_dir(dir)?;
    let mut conn = open(dir, diary_key)?;
    let transaction = conn
        .transaction()
        .map_err(|e| format!("Failed to start the import: {e}"))?;

    let total = dates.len();
    let mut report = storage::ImportReport {
        imported: Vec::new(),
        skipped: Vec::new(),
        failed: Vec::new(),
    };

    for (done, date) in dates.iter().enumerate() {
        if let Err(reason) = storage::validate_date(date) {
            report.failed.push(storage::ImportFailure {
                name: date.clone(),
                reason,
            });
            progress(done + 1, total);
            continue;
        }

        let name = format!("{date}.txt");
        let path = import_dir.join(&name);
        let metadata = match fs::metadata(&path) {
            Ok(metadata) if metadata.is_file() => metadata,
            Ok(_) => {
                report.failed.push(storage::ImportFailure {
                    name,
                    reason: "不是檔案".to_string(),
                });
                progress(done + 1, total);
                continue;
            }
            Err(error) => {
                report.failed.push(storage::ImportFailure {
                    name,
                    reason: format!("無法讀取檔案：{error}"),
                });
                progress(done + 1, total);
                continue;
            }
        };
        if metadata.len() > MAX_IMPORT_BYTES {
            report.failed.push(storage::ImportFailure {
                name,
                reason: format!("檔案過大（上限 {} MiB）", MAX_IMPORT_BYTES / 1024 / 1024),
            });
            progress(done + 1, total);
            continue;
        }
        let bytes = match fs::read(&path) {
            Ok(bytes) => bytes,
            Err(error) => {
                report.failed.push(storage::ImportFailure {
                    name,
                    reason: format!("無法讀取檔案：{error}"),
                });
                progress(done + 1, total);
                continue;
            }
        };
        let text = match String::from_utf8(bytes) {
            Ok(text) => text,
            Err(_) => {
                report.failed.push(storage::ImportFailure {
                    name,
                    reason: "檔案不是有效的 UTF-8 文字".to_string(),
                });
                progress(done + 1, total);
                continue;
            }
        };

        let exists = transaction
            .query_row(
                "SELECT 1 FROM entries WHERE date = ?1",
                params![date],
                |_| Ok(()),
            )
            .optional()
            .map_err(|e| format!("Failed to check existing entries: {e}"))?
            .is_some();
        if exists && !overwrite {
            report.skipped.push(date.clone());
            progress(done + 1, total);
            continue;
        }

        let content = storage::normalise_imported(&text);
        let title = storage::title_from_import_name(&name);
        transaction
            .execute(
                "INSERT INTO entries (date, title, content, favourite, created_at, updated_at)
                 VALUES (?1, ?2, ?3, 0, ?4, ?4)
                 ON CONFLICT(date) DO UPDATE SET
                     title = excluded.title,
                     content = excluded.content,
                     favourite = 0,
                     updated_at = excluded.updated_at",
                params![date, title, content, now_ms()],
            )
            .map_err(|e| format!("Failed to import {date}: {e}"))?;
        report.imported.push(date.clone());
        progress(done + 1, total);
    }

    transaction
        .commit()
        .map_err(|e| format!("Failed to commit the import: {e}"))?;
    Ok(report)
}

/// Import without progress reporting.
pub fn import_entries(
    dir: &Path,
    diary_key: &[u8; 32],
    import_dir: &Path,
    dates: &[String],
    overwrite: bool,
) -> Result<storage::ImportReport, String> {
    import_entries_with_progress(dir, diary_key, import_dir, dates, overwrite, |_, _| {})
}

// ---------------------------------------------------------------------------
// Integrity and backups
// ---------------------------------------------------------------------------

/// Run SQLCipher's page HMAC check plus SQLite's logical integrity check.
pub fn integrity_check(dir: &Path, diary_key: &[u8; 32]) -> Result<IntegrityReport, String> {
    let conn = open(dir, diary_key)?;
    integrity_check_conn(&conn)
}

/// Run the same checks against an extracted backup without enabling WAL.
pub fn integrity_check_snapshot(
    dir: &Path,
    diary_key: &[u8; 32],
) -> Result<IntegrityReport, String> {
    let path = db_path(dir);
    let conn = Connection::open_with_flags(
        &path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| format!("Failed to open the backup database: {e}"))?;
    apply_key(&conn, diary_key)?;
    check_schema(&conn)?;
    integrity_check_conn(&conn)
}

fn integrity_check_conn(conn: &Connection) -> Result<IntegrityReport, String> {
    let mut messages = Vec::new();

    if let Ok(mut stmt) = conn.prepare("PRAGMA cipher_integrity_check") {
        if let Ok(rows) = stmt.query_map([], |row| row.get::<_, String>(0)) {
            for row in rows.flatten() {
                messages.push(row);
            }
        }
    }

    let logical: String = conn
        .query_row("PRAGMA integrity_check", [], |row| row.get(0))
        .map_err(|e| format!("Failed to run the integrity check: {e}"))?;
    if !logical.eq_ignore_ascii_case("ok") {
        messages.push(logical);
    }

    Ok(IntegrityReport {
        ok: messages.is_empty(),
        messages,
    })
}

/// Write a consistent encrypted copy of the database to `dest`.
pub fn snapshot(dir: &Path, diary_key: &[u8; 32], dest: &Path) -> Result<(), String> {
    if dest.exists() {
        return Err(format!("{} already exists", dest.display()));
    }
    let conn = open(dir, diary_key)?;
    let dest = dest
        .to_str()
        .ok_or_else(|| "Backup path is not valid UTF-8".to_string())?;
    let escaped = dest.replace('\'', "''");
    conn.execute_batch(&format!("VACUUM INTO '{escaped}';"))
        .map_err(|e| format!("Failed to write the database snapshot: {e}"))?;
    tighten_permissions(Path::new(dest));
    Ok(())
}
