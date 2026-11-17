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
//! ├── diary.db               # SQLCipher database (authoritative)
//! ├── YYYY-MM-DD.fd          # binary encrypted per-day sync record
//! └── attachments/...        # image sidecars
//! ```
//!
//! XML is no longer used for entries or attachment manifests. The `.fd` record
//! is the one-per-day sync unit: each save rewrites that day's record, and the
//! Android SAF bridge copies it. When a record arrives from another device the
//! sync command imports it into the database. The database is authoritative.

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

/// HKDF info string for the per-day sync record.
const SYNC_KEY_INFO: &[u8] = b"fly-diary/sync/v1";

/// Magic bytes for a per-day sync record. Deliberately not XML.
const SYNC_MAGIC: &[u8; 5] = b"FDDAY";

/// Current per-day sync record version.
const SYNC_VERSION: u8 = 1;

/// Extension of a per-day sync record.
pub const SYNC_EXTENSION: &str = "fd";

/// Refuse to allocate absurd sync records before parsing lengths.
const MAX_SYNC_RECORD_BYTES: usize = 32 * 1024 * 1024;

/// Temporary database used while migrating from the XML layout.
const MIGRATING_FILE: &str = "diary.db.migrating";

/// File systems with coarse timestamps can round a fresh record behind the
/// `updated_at` millisecond value. A small tolerance avoids rewriting every
/// record (and therefore re-uploading it) on those file systems.
const SYNC_MTIME_SLACK_MS: i64 = 2_000;

/// How the directory is currently stored.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum StorageFormat {
    /// `diary.db` exists; the SQLCipher store is authoritative.
    Sqlcipher,
    /// `vault.xml` and `.fd` sync records exist, but the database is missing
    /// (for example after restoring a sync folder). Rebuild from `.fd`.
    NeedsRebuild,
    /// `vault.xml` exists without `diary.db` or `.fd`; the old XML layout.
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
    /// Number of top-level `.fd` sync records, if any.
    pub sync_records: usize,
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
    /// Set when a corrupt database was moved aside before rebuilding.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub database_backup: Option<String>,
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
    let sync_records = count_sync_records(dir);
    let format = if has_database {
        StorageFormat::Sqlcipher
    } else if has_vault && sync_records > 0 {
        StorageFormat::NeedsRebuild
    } else if has_vault {
        StorageFormat::Legacy
    } else {
        StorageFormat::Empty
    };
    StorageStatus {
        format,
        has_vault,
        has_database,
        sync_records,
    }
}

/// Count top-level `.fd` sync records.
pub fn count_sync_records(dir: &Path) -> usize {
    let Ok(read_dir) = fs::read_dir(dir) else {
        return 0;
    };
    read_dir
        .flatten()
        .filter(|item| {
            let path = item.path();
            path.extension().and_then(|s| s.to_str()) == Some(SYNC_EXTENSION)
                && path
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .is_some_and(|date| storage::validate_date(date).is_ok())
        })
        .count()
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

/// Derive the key for per-day sync records.
pub fn derive_sync_key(diary_key: &[u8; 32]) -> Zeroizing<[u8; 32]> {
    derive_subkey(diary_key, SYNC_KEY_INFO)
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
// Per-day sync record (binary, not XML)
// ---------------------------------------------------------------------------

/// The entry and attachment metadata that travels as one per-day file.
#[derive(Debug, Clone)]
struct SyncRecord {
    title: String,
    content: String,
    favourite: bool,
    attachments: Vec<AttachmentRow>,
}

fn sync_aad(context: &VaultContext, date: &str, version: u8) -> Vec<u8> {
    let mut aad = Vec::with_capacity(32 + context.vault_id.len() + context.key_id.len() + 12);
    aad.extend_from_slice(b"fly-diary/sync/v1\0");
    aad.extend_from_slice(&context.vault_id);
    aad.extend_from_slice(&context.key_id);
    aad.extend_from_slice(date.as_bytes());
    aad.push(0);
    aad.push(version);
    aad
}

fn put_u32(out: &mut Vec<u8>, value: usize) -> Result<(), String> {
    let value = u32::try_from(value).map_err(|_| "Sync record field is too large".to_string())?;
    out.extend_from_slice(&value.to_be_bytes());
    Ok(())
}

fn put_bytes(out: &mut Vec<u8>, bytes: &[u8]) -> Result<(), String> {
    put_u32(out, bytes.len())?;
    out.extend_from_slice(bytes);
    Ok(())
}

fn read_u32(bytes: &[u8], cursor: &mut usize) -> Result<u32, String> {
    let end = cursor
        .checked_add(4)
        .ok_or_else(|| "Sync record is truncated".to_string())?;
    let slice = bytes
        .get(*cursor..end)
        .ok_or_else(|| "Sync record is truncated".to_string())?;
    *cursor = end;
    Ok(u32::from_be_bytes(
        slice.try_into().expect("slice is exactly 4 bytes"),
    ))
}

fn read_bytes<'a>(bytes: &'a [u8], cursor: &mut usize, max: usize) -> Result<&'a [u8], String> {
    let len = read_u32(bytes, cursor)? as usize;
    if len > max {
        return Err("Sync record field is too large".to_string());
    }
    let end = cursor
        .checked_add(len)
        .ok_or_else(|| "Sync record is truncated".to_string())?;
    let slice = bytes
        .get(*cursor..end)
        .ok_or_else(|| "Sync record is truncated".to_string())?;
    *cursor = end;
    Ok(slice)
}

fn read_string(bytes: &[u8], cursor: &mut usize, max: usize) -> Result<String, String> {
    let raw = read_bytes(bytes, cursor, max)?;
    String::from_utf8(raw.to_vec()).map_err(|_| "Sync record is not valid UTF-8".to_string())
}

fn encode_sync_payload(record: &SyncRecord) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    out.push(SYNC_VERSION);
    put_bytes(&mut out, record.title.as_bytes())?;
    put_bytes(&mut out, record.content.as_bytes())?;
    out.push(record.favourite as u8);
    put_u32(&mut out, record.attachments.len())?;
    for attachment in &record.attachments {
        put_bytes(&mut out, attachment.id.as_bytes())?;
        put_bytes(&mut out, attachment.mime.as_bytes())?;
        put_u32(&mut out, attachment.width as usize)?;
        put_u32(&mut out, attachment.height as usize)?;
        put_u32(&mut out, attachment.position.max(0) as usize)?;
    }
    if out.len() > MAX_SYNC_RECORD_BYTES {
        return Err("Sync record is too large".to_string());
    }
    Ok(out)
}

fn decode_sync_payload(bytes: &[u8]) -> Result<SyncRecord, String> {
    if bytes.len() > MAX_SYNC_RECORD_BYTES {
        return Err("Sync record is too large".to_string());
    }
    let mut cursor = 0usize;
    let version = *bytes
        .get(cursor)
        .ok_or_else(|| "Sync record is truncated".to_string())?;
    cursor += 1;
    if version != SYNC_VERSION {
        return Err(format!("Unsupported sync record version: {version}"));
    }
    let title = read_string(bytes, &mut cursor, MAX_SYNC_RECORD_BYTES)?;
    let content = read_string(bytes, &mut cursor, MAX_SYNC_RECORD_BYTES)?;
    let favourite = match bytes.get(cursor).copied() {
        Some(0) => false,
        Some(1) => true,
        _ => return Err("Sync record has an invalid favourite flag".to_string()),
    };
    cursor += 1;
    let count = read_u32(bytes, &mut cursor)? as usize;
    if count > 10_000 {
        return Err("Sync record has too many attachments".to_string());
    }
    let mut attachments = Vec::with_capacity(count);
    for position in 0..count {
        let id = read_string(bytes, &mut cursor, 1024)?;
        let mime = read_string(bytes, &mut cursor, 1024)?;
        let width = read_u32(bytes, &mut cursor)?;
        let height = read_u32(bytes, &mut cursor)?;
        let stored_position = read_u32(bytes, &mut cursor)?;
        attachments.push(AttachmentRow {
            id,
            mime,
            width,
            height,
            position: i64::from(stored_position.max(position as u32)),
        });
    }
    if cursor != bytes.len() {
        return Err("Sync record has trailing data".to_string());
    }
    Ok(SyncRecord {
        title,
        content,
        favourite,
        attachments,
    })
}

fn sync_record_path(dir: &Path, date: &str) -> PathBuf {
    dir.join(format!("{date}.{SYNC_EXTENSION}"))
}

fn encode_sync_record(
    diary_key: &[u8; 32],
    context: &VaultContext,
    date: &str,
    record: &SyncRecord,
) -> Result<Vec<u8>, String> {
    let payload = encode_sync_payload(record)?;
    let sync_key = derive_sync_key(diary_key);
    let aad = sync_aad(context, date, SYNC_VERSION);
    let (iv, ciphertext) = crypto::encrypt_with_aad(&sync_key, &aad, &payload)?;
    let mut out = Vec::with_capacity(SYNC_MAGIC.len() + 1 + 10 + crypto::IV_LEN + ciphertext.len());
    out.extend_from_slice(SYNC_MAGIC);
    out.push(SYNC_VERSION);
    out.extend_from_slice(date.as_bytes());
    out.extend_from_slice(&iv);
    out.extend_from_slice(&ciphertext);
    Ok(out)
}

fn decode_sync_record(
    diary_key: &[u8; 32],
    context: &VaultContext,
    date: &str,
    bytes: &[u8],
) -> Result<SyncRecord, String> {
    let header = SYNC_MAGIC.len() + 1 + 10 + crypto::IV_LEN;
    if bytes.len() < header {
        return Err("Sync record is truncated".to_string());
    }
    if &bytes[..SYNC_MAGIC.len()] != SYNC_MAGIC {
        return Err("Sync record has an unknown header".to_string());
    }
    let version = bytes[SYNC_MAGIC.len()];
    if version != SYNC_VERSION {
        return Err(format!("Unsupported sync record version: {version}"));
    }
    let date_start = SYNC_MAGIC.len() + 1;
    let date_end = date_start + 10;
    if &bytes[date_start..date_end] != date.as_bytes() {
        return Err("Sync record date does not match its filename".to_string());
    }
    let iv_start = date_end;
    let iv = &bytes[iv_start..iv_start + crypto::IV_LEN];
    let ciphertext = &bytes[iv_start + crypto::IV_LEN..];
    let sync_key = derive_sync_key(diary_key);
    let aad = sync_aad(context, date, version);
    let payload = crypto::decrypt_with_aad(&sync_key, &aad, iv, ciphertext)?;
    decode_sync_payload(&payload)
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
    let stored_vault = meta_value(&conn, "vault_id")?;
    let stored_key = meta_value(&conn, "key_id")?;
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

/// Remove top-level `.fd` records left behind without a vault.
///
/// Used when creating a fresh vault in a folder whose `vault.xml` is gone. The
/// new diary key could never open those records anyway.
pub fn remove_sync_records(dir: &Path) -> Result<(), String> {
    let read_dir = match fs::read_dir(dir) {
        Ok(read_dir) => read_dir,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("Failed to read the diary directory: {error}")),
    };
    for item in read_dir.flatten() {
        let path = item.path();
        if path.extension().and_then(|s| s.to_str()) != Some(SYNC_EXTENSION) {
            continue;
        }
        let Some(date) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        if storage::validate_date(date).is_err() {
            continue;
        }
        match fs::remove_file(&path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(format!(
                    "Failed to remove the stale sync record {}: {error}",
                    path.display()
                ))
            }
        }
    }
    Ok(())
}

/// Move an unreadable database aside so the sync records can rebuild it.
///
/// The backup keeps the original DB and its WAL sidecars, so a forensic rescue
/// remains possible. Returns the backup path when a database existed.
pub fn move_corrupt_database(dir: &Path) -> Result<Option<PathBuf>, String> {
    let source = db_path(dir);
    if !source.is_file() {
        return Ok(None);
    }
    let stamp = chrono::Utc::now().format("%Y%m%d-%H%M%S");
    let mut backup = dir.join(format!("{DB_FILE}.corrupt-{stamp}"));
    if backup.exists() {
        backup = dir.join(format!("{DB_FILE}.corrupt-{stamp}-{}", std::process::id()));
    }
    fs::rename(&source, &backup)
        .map_err(|e| format!("Failed to move the unreadable database aside: {e}"))?;
    let backup_name = backup
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(DB_FILE)
        .to_string();
    for suffix in ["-wal", "-shm"] {
        let sidecar = dir.join(format!("{DB_FILE}{suffix}"));
        if sidecar.is_file() {
            let target = dir.join(format!("{backup_name}{suffix}"));
            fs::rename(&sidecar, &target)
                .map_err(|e| format!("Failed to move the database sidecar aside: {e}"))?;
        }
    }
    let _ = fsutil::sync_dir(dir);
    Ok(Some(backup))
}

// ---------------------------------------------------------------------------
// XML -> SQLCipher migration
// ---------------------------------------------------------------------------

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
/// and the binary `.fd` records are written, the XML entry and manifest files
/// are deleted; only `vault.xml` and `recovery.xml` remain. Unreadable entries
/// are preserved as raw bytes in `legacy_broken` so they can still be listed
/// and exported. The database is built under a temporary name and renamed only
/// after a successful integrity check, so an interrupted migration leaves the
/// old layout usable and can simply be retried.
pub fn migrate_from_xml(dir: &Path, diary_key: &[u8; 32]) -> Result<MigrationReport, String> {
    storage::ensure_dir(dir)?;

    let target = db_path(dir);
    let context = storage::vault_context(dir)?.ok_or_else(|| {
        "Unlock this vault once so it can be upgraded before migrating".to_string()
    })?;

    if target.is_file() {
        verify(dir, diary_key, &context)?;
        ensure_sync_records(dir, diary_key)?;
        let warnings = cleanup_legacy_xml(dir, diary_key)?;
        return Ok(MigrationReport {
            warnings,
            ..MigrationReport::default()
        });
    }

    // A folder restored from sync has `.fd` records but no database. Creating a
    // database from the (usually absent) legacy XML would silently discard
    // those records, so direct the caller to the rebuild path instead.
    if count_sync_records(dir) > 0 {
        return Err(
            "This folder has .fd sync records but no database; rebuild it from them instead"
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
    // Write the new binary per-day records before deleting the old XML files.
    // If this fails, the XML source is still present and the migration can be
    // retried.
    ensure_sync_records(dir, diary_key)?;
    report.warnings.extend(cleanup_legacy_xml(dir, diary_key)?);
    Ok(report)
}

/// Delete XML entry files whose data is safely in the database.
///
/// Migration is a break change: the folder keeps only `vault.xml`,
/// `recovery.xml`, the SQLCipher database, the `.fd` sync records and the
/// attachment sidecars. A file whose bytes could not be preserved is left in
/// place and reported, because deleting the only copy of damaged data would be
/// worse than leaving one stray XML file.
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

/// Rebuild a fresh database from the encrypted per-day `.fd` records.
///
/// This is the rescue path when `diary.db` cannot be opened. The caller must
/// move the damaged database aside first. Image sidecars are untouched; the
/// records carry the entry text and attachment metadata.
pub fn rebuild_from_sync_records(
    dir: &Path,
    diary_key: &[u8; 32],
) -> Result<MigrationReport, String> {
    storage::ensure_dir(dir)?;
    if db_path(dir).is_file() {
        return Err("Move the damaged database aside before rebuilding".to_string());
    }
    let context =
        storage::vault_context(dir)?.ok_or_else(|| "The vault has no sync context".to_string())?;
    let temp = dir.join(MIGRATING_FILE);
    let _ = fs::remove_file(&temp);
    let mut conn = create_at(&temp, diary_key, &context)?;

    let mut report = MigrationReport::default();
    {
        let transaction = conn
            .transaction()
            .map_err(|e| format!("Failed to start the rebuild: {e}"))?;
        let read_dir =
            fs::read_dir(dir).map_err(|e| format!("Failed to read diary directory: {e}"))?;
        let mut dates = Vec::new();
        for item in read_dir.flatten() {
            let path = item.path();
            if path.extension().and_then(|s| s.to_str()) != Some(SYNC_EXTENSION) {
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

        for date in dates {
            let path = sync_record_path(dir, &date);
            let bytes = match fs::read(&path) {
                Ok(bytes) => bytes,
                Err(error) => {
                    report.broken.push(MigrationFailure {
                        date,
                        reason: format!("Could not read sync record: {error}"),
                    });
                    continue;
                }
            };
            let record = match decode_sync_record(diary_key, &context, &date, &bytes) {
                Ok(record) => record,
                Err(reason) => {
                    report.broken.push(MigrationFailure { date, reason });
                    continue;
                }
            };
            let timestamp = file_mtime_ms(&path).unwrap_or_else(now_ms);
            insert_entry(
                &transaction,
                &date,
                &record.title,
                &record.content,
                record.favourite,
                timestamp,
            )?;
            for (index, attachment) in record.attachments.iter().enumerate() {
                transaction
                    .execute(
                        "INSERT INTO attachments (date, id, mime, width, height, position)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                        params![
                            &date,
                            attachment.id,
                            attachment.mime,
                            attachment.width as i64,
                            attachment.height as i64,
                            if attachment.position >= 0 {
                                attachment.position
                            } else {
                                index as i64
                            }
                        ],
                    )
                    .map_err(|e| format!("Failed to rebuild attachments for {date}: {e}"))?;
                report.attachments += 1;
            }
            transaction
                .execute(
                    "INSERT INTO attachment_manifests (date, updated_at)
                     VALUES (?1, ?2)
                     ON CONFLICT(date) DO UPDATE SET updated_at = excluded.updated_at",
                    params![&date, timestamp],
                )
                .map_err(|e| format!("Failed to rebuild manifest for {date}: {e}"))?;
            report.migrated += 1;
        }

        transaction
            .commit()
            .map_err(|e| format!("Failed to commit the rebuild: {e}"))?;
    }

    finalize(conn, &temp)?;
    install_new_database(&temp, &db_path(dir), dir)?;
    report.warnings.extend(cleanup_legacy_xml(dir, diary_key)?);
    Ok(report)
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
    let context =
        storage::vault_context(dir)?.ok_or_else(|| "The vault has no sync context".to_string())?;
    let conn = open(dir, diary_key)?;
    let existing = read_row(&conn, date)?;
    let favourite = existing.as_ref().map(|(_, _, flag)| *flag).unwrap_or(false);
    let changed = existing
        .as_ref()
        .map(|(old_title, old_content, _)| old_title != title || old_content != content)
        .unwrap_or(true);

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

    if changed || !sync_record_path(dir, date).is_file() {
        write_sync_record_with_conn(&conn, dir, diary_key, &context, date)?;
    }
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
    let context =
        storage::vault_context(dir)?.ok_or_else(|| "The vault has no sync context".to_string())?;
    let conn = open(dir, diary_key)?;
    let Some((_title, _content, current)) = read_row(&conn, date)? else {
        return Ok(false);
    };
    if current == favourite {
        if !sync_record_path(dir, date).is_file() {
            write_sync_record_with_conn(&conn, dir, diary_key, &context, date)?;
        }
        return Ok(true);
    }
    conn.execute(
        "UPDATE entries SET favourite = ?1, updated_at = ?2 WHERE date = ?3",
        params![favourite as i64, now_ms(), date],
    )
    .map_err(|e| format!("Failed to update entry {date}: {e}"))?;
    write_sync_record_with_conn(&conn, dir, diary_key, &context, date)?;
    Ok(true)
}

/// Delete an entry, its attachment metadata and its sync record.
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
    let record = sync_record_path(dir, date);
    match fs::remove_file(&record) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(format!("Failed to delete entry {date}: {error}")),
    }
    let _ = crate::attachments::delete_all_for_date(dir, date);
    let _ = fsutil::sync_dir(dir);
    Ok(())
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
// Per-day sync records
// ---------------------------------------------------------------------------

fn write_sync_record_with_conn(
    conn: &Connection,
    dir: &Path,
    diary_key: &[u8; 32],
    context: &VaultContext,
    date: &str,
) -> Result<(), String> {
    let Some((title, content, favourite)) = read_row(conn, date)? else {
        match fs::remove_file(sync_record_path(dir, date)) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("Failed to remove sync record for {date}: {error}")),
        }
        return Ok(());
    };
    let record = SyncRecord {
        title,
        content,
        favourite,
        attachments: read_attachment_rows(conn, date)?,
    };
    let bytes = encode_sync_record(diary_key, context, date, &record)?;
    fsutil::write_private(&sync_record_path(dir, date), bytes)
        .map_err(|e| format!("Failed to write sync record for {date}: {e}"))
}

/// Write one day's sync record from the current database state.
pub fn export_sync_record(dir: &Path, diary_key: &[u8; 32], date: &str) -> Result<(), String> {
    storage::validate_date(date)?;
    let context =
        storage::vault_context(dir)?.ok_or_else(|| "The vault has no sync context".to_string())?;
    let conn = open(dir, diary_key)?;
    write_sync_record_with_conn(&conn, dir, diary_key, &context, date)
}

fn sync_record_date(path: &str) -> Option<&str> {
    if path.contains('/') || path.contains('\\') {
        return None;
    }
    let date = path.strip_suffix(&format!(".{SYNC_EXTENSION}"))?;
    if storage::validate_date(date).is_ok() {
        Some(date)
    } else {
        None
    }
}

/// Bring every `.fd` record up to date and remove records for deleted entries.
///
/// This is the sync equivalent of the old per-day file refresh: it only rewrites
/// missing or stale records, so a normal sync after a save does not re-encrypt
/// every day.
pub fn ensure_sync_records(dir: &Path, diary_key: &[u8; 32]) -> Result<(), String> {
    let context =
        storage::vault_context(dir)?.ok_or_else(|| "The vault has no sync context".to_string())?;
    let conn = open(dir, diary_key)?;

    let mut entries = BTreeMap::new();
    let mut stmt = conn
        .prepare("SELECT date, updated_at FROM entries")
        .map_err(|e| format!("Failed to prepare sync records: {e}"))?;
    let rows = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })
        .map_err(|e| format!("Failed to read entries for sync records: {e}"))?;
    for row in rows {
        let (date, updated_at) =
            row.map_err(|e| format!("Failed to read entries for sync records: {e}"))?;
        entries.insert(date, updated_at);
    }
    drop(stmt);

    let mut manifests = BTreeMap::new();
    let mut stmt = conn
        .prepare("SELECT date, updated_at FROM attachment_manifests")
        .map_err(|e| format!("Failed to prepare attachment sync records: {e}"))?;
    let rows = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })
        .map_err(|e| format!("Failed to read attachment sync records: {e}"))?;
    for row in rows {
        let (date, updated_at) =
            row.map_err(|e| format!("Failed to read attachment sync records: {e}"))?;
        manifests.insert(date, updated_at);
    }
    drop(stmt);

    for (date, updated_at) in &entries {
        let effective = (*updated_at).max(*manifests.get(date).unwrap_or(&0));
        let path = sync_record_path(dir, date);
        let fresh = file_mtime_ms(&path)
            .is_some_and(|mtime| mtime >= effective.saturating_sub(SYNC_MTIME_SLACK_MS));
        if !fresh {
            write_sync_record_with_conn(&conn, dir, diary_key, &context, date)?;
        }
    }

    // A local record whose entry no longer exists must disappear so the sync
    // engine can propagate the deletion.
    if let Ok(read_dir) = fs::read_dir(dir) {
        for item in read_dir.flatten() {
            let path = item.path();
            if path.extension().and_then(|s| s.to_str()) != Some(SYNC_EXTENSION) {
                continue;
            }
            let Some(date) = path.file_stem().and_then(|s| s.to_str()) else {
                continue;
            };
            if !entries.contains_key(date) {
                let _ = fs::remove_file(&path);
            }
        }
    }
    Ok(())
}

/// Import the `.fd` files the sync bridge just pulled.
///
/// A missing record means the remote side deleted that day, so the local entry
/// and its attachment metadata are removed as well. Attachment image files are
/// separate sidecars and need no import.
pub fn import_sync_paths(
    dir: &Path,
    diary_key: &[u8; 32],
    paths: &[String],
) -> Result<Vec<String>, String> {
    if paths.is_empty() {
        return Ok(Vec::new());
    }
    let context =
        storage::vault_context(dir)?.ok_or_else(|| "The vault has no sync context".to_string())?;
    let mut conn = open(dir, diary_key)?;
    let transaction = conn
        .transaction()
        .map_err(|e| format!("Failed to start the sync import: {e}"))?;
    let mut warnings = Vec::new();
    let mut deleted_dates = Vec::new();

    for path in paths {
        let Some(date) = sync_record_date(path) else {
            continue;
        };
        let local = sync_record_path(dir, date);
        if !local.is_file() {
            transaction
                .execute("DELETE FROM attachments WHERE date = ?1", params![date])
                .map_err(|e| format!("Failed to delete synced entry {date}: {e}"))?;
            transaction
                .execute(
                    "DELETE FROM attachment_manifests WHERE date = ?1",
                    params![date],
                )
                .map_err(|e| format!("Failed to delete synced entry {date}: {e}"))?;
            transaction
                .execute("DELETE FROM entries WHERE date = ?1", params![date])
                .map_err(|e| format!("Failed to delete synced entry {date}: {e}"))?;
            deleted_dates.push(date.to_string());
            continue;
        }

        let bytes = match fs::read(&local) {
            Ok(bytes) => bytes,
            Err(error) => {
                warnings.push(format!("{date}: {error}"));
                continue;
            }
        };
        let record = match decode_sync_record(diary_key, &context, date, &bytes) {
            Ok(record) => record,
            Err(reason) => {
                warnings.push(format!("{date}: {reason}"));
                continue;
            }
        };
        let timestamp = file_mtime_ms(&local).unwrap_or_else(now_ms);
        transaction
            .execute(
                "INSERT INTO entries (date, title, content, favourite, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?5)
                 ON CONFLICT(date) DO UPDATE SET
                     title = excluded.title,
                     content = excluded.content,
                     favourite = excluded.favourite,
                     updated_at = excluded.updated_at",
                params![
                    date,
                    record.title,
                    record.content,
                    record.favourite as i64,
                    timestamp
                ],
            )
            .map_err(|e| format!("Failed to import synced entry {date}: {e}"))?;
        transaction
            .execute("DELETE FROM attachments WHERE date = ?1", params![date])
            .map_err(|e| format!("Failed to import synced attachments for {date}: {e}"))?;
        for (index, attachment) in record.attachments.iter().enumerate() {
            let position = if attachment.position >= 0 {
                attachment.position
            } else {
                index as i64
            };
            transaction
                .execute(
                    "INSERT INTO attachments (date, id, mime, width, height, position)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                    params![
                        date,
                        attachment.id,
                        attachment.mime,
                        attachment.width as i64,
                        attachment.height as i64,
                        position
                    ],
                )
                .map_err(|e| format!("Failed to import synced attachments for {date}: {e}"))?;
        }
        transaction
            .execute(
                "INSERT INTO attachment_manifests (date, updated_at)
                 VALUES (?1, ?2)
                 ON CONFLICT(date) DO UPDATE SET updated_at = excluded.updated_at",
                params![date, timestamp],
            )
            .map_err(|e| format!("Failed to import synced manifest for {date}: {e}"))?;
    }

    transaction
        .commit()
        .map_err(|e| format!("Failed to commit the sync import: {e}"))?;

    for date in deleted_dates {
        let _ = crate::attachments::delete_all_for_date(dir, &date);
    }
    Ok(warnings)
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
    drop(conn);

    // Refresh the per-day sync records after the commit. A failure here is
    // reported, but the imported rows are already safely in the database.
    ensure_sync_records(dir, diary_key)?;
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
