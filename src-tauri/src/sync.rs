//! Android-only folder synchronisation bridge.
//!
//! The private app folder stays the source of truth. This module mirrors the
//! encrypted files to a folder the user picked through the Android Storage
//! Access Framework (SAF), so a desktop sync client (Syncthing, a cloud drive,
//! ...) can exchange the ciphertext with the phone.
//!
//! Nothing here needs the diary key: entries, attachments, `vault.xml` and
//! `recovery.xml` are copied as opaque bytes. That is what lets a sync run on
//! the lock screen if it is ever needed, and it keeps the plaintext surface
//! unchanged.
//!
//! ## Conflict rules
//!
//! A three-way comparison against the last successful sync (`sync-state.json`)
//! decides what to move:
//!
//! * only the local copy changed → upload it;
//! * only the remote copy changed → download it;
//! * both changed → **neither side is touched**; the file is reported as a
//!   conflict and the user resolves it explicitly in the settings dialog;
//! * the local copy is missing while the remote one still matches the last
//!   sync → the remote copy is deleted, because the phone's private vault is
//!   authoritative and deleting a day there should stop it coming back;
//! * the remote copy is missing while the local one still matches the last
//!   sync → the remote copy is **restored** (uploaded again), so a temporarily
//!   empty or partially visible folder can never erase the private diary;
//! * one side is missing and the other changed → conflict.
//!
//! The asymmetry is deliberate. Local deletions propagate; remote deletions
//! only do so after an explicit "delete local" conflict resolution. An empty
//! remote folder while state exists is rejected outright instead of deleting
//! everything. Resolving a conflict with "keep remote" is the only automatic
//! path that removes a local file, and "keep local" is the only path that
//! removes a remote file.
//!
//! Only known files are accepted (`vault.xml`, `recovery.xml`,
//! `YYYY-MM-DD.xml`, `attachments/YYYY-MM-DD/manifest.xml` and
//! `attachments/YYYY-MM-DD/<32 hex>.bin`). `index.xml` is a cache and is
//! deliberately left out; after pulling an entry the local cache is deleted so
//! the next list rebuilds it. Temporary and migration files are ignored.

// Most of this module is only reachable from Android command handlers. The
// desktop build still compiles it (and its tests) but never calls it.
#![cfg_attr(not(target_os = "android"), allow(dead_code))]

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use quick_xml::events::Event;
use quick_xml::Reader;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::crypto;
use crate::fsutil;
use crate::storage;

/// Serialises every sync/resolve/adopt operation. SAF providers are not
/// designed for concurrent writers, and two sync runs would race on the state
/// file even if their file copies happened to be safe.
pub static SYNC_LOCK: Mutex<()> = Mutex::new(());

/// Settings file for the bridge, kept separate from `settings.xml` so the
/// desktop build never reads or rewrites Android-only state.
pub const CONFIG_FILE: &str = "sync.xml";

/// Three-way sync state, kept outside the diary folder (it names ciphertext
/// hashes and paths, but contains no key material).
pub const STATE_FILE: &str = "sync-state.json";

/// Derived, encrypted cache. It is never uploaded; instead both sides delete it
/// after an entry changes so the next launch rebuilds it against the real files.
const INDEX_FILE: &str = "index.xml";

/// Largest file the bridge will copy. Attachments are capped at 5 MiB before
/// encryption; the envelope is small, so 16 MiB leaves plenty of headroom.
pub const MAX_SYNC_FILE_BYTES: u64 = 16 * 1024 * 1024;

/// `vault.xml` is tiny; anything larger is not a vault this app wrote.
const MAX_PEEK_BYTES: u64 = 256 * 1024;

/// Hard cap on the number of files in either side. A mis-selected folder such
/// as `/` should fail fast instead of trying to hash the device.
const MAX_FILES: usize = 50_000;

/// Saved configuration of the bridge.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SyncConfig {
    /// SAF tree URI (`content://...`). Persisted by Android per app.
    pub tree_uri: String,
    /// Display name shown in settings (not trusted for filesystem access).
    pub display_name: String,
    /// Whether the hook after unlock and after a save should sync.
    pub auto_sync: bool,
}

/// A file reported by the SAF folder.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteFile {
    /// Slash-separated path relative to the picked folder.
    pub path: String,
    pub size: u64,
    pub mtime_ms: i64,
}

/// What kind of object a synced path is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Vault,
    Recovery,
    Entry,
    Manifest,
    Attachment,
}

/// A file both sides changed (or that appeared on both sides with different
/// bytes on the first sync).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ConflictKind {
    BothChanged,
    LocalEditedRemoteDeleted,
    RemoteEditedLocalDeleted,
}

/// One unresolved conflict.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncConflict {
    pub path: String,
    pub kind: ConflictKind,
    pub local_size: Option<u64>,
    pub remote_size: Option<u64>,
}

/// Result of a sync run, returned to the settings dialog.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncReport {
    pub pushed: Vec<String>,
    pub pulled: Vec<String>,
    pub conflicts: Vec<SyncConflict>,
    /// Informational messages (e.g. a missing copy was restored).
    pub notes: Vec<String>,
    pub synced_at_ms: i64,
}

/// Summary shown before binding a folder.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Inspection {
    pub has_vault: bool,
    /// Base64 vault id, when the folder has a v3 vault.
    pub vault_id: Option<String>,
    pub entries: usize,
    pub attachments: usize,
    pub files: usize,
}

/// Result of replacing the private vault with the folder's contents.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdoptReport {
    pub report: SyncReport,
    /// Absolute path of the previous private vault, kept as a safety copy.
    pub backup_path: Option<String>,
    /// Base64 vault id read from the adopted folder (empty for legacy vaults).
    pub vault_id: String,
}

/// Per-file record of the last successful sync.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileState {
    /// SHA-256 of the ciphertext, hex encoded. Both sides hold the same bytes
    /// right after a successful sync, so one hash describes both.
    pub hash: String,
    /// Remote metadata as reported right after the sync. Providers may set
    /// these to zero; the planner falls back to hashing in that case.
    pub remote_size: u64,
    pub remote_mtime_ms: i64,
    /// Local metadata cached to avoid re-reading (and re-hashing) every
    /// attachment on each autosave-triggered sync.
    #[serde(default)]
    pub local_size: u64,
    #[serde(default)]
    pub local_mtime_ns: u64,
}

/// Persisted three-way state.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SyncState {
    pub tree_uri: String,
    pub vault_id: String,
    pub last_synced_at_ms: i64,
    pub files: BTreeMap<String, FileState>,
}

/// Access to the external folder. Implemented by the SAF plugin on Android and
/// by a temp-directory fake in tests.
pub trait Remote {
    fn list(&self) -> Result<Vec<RemoteFile>, String>;
    fn copy_to_local(&self, remote_path: &str, local_path: &Path) -> Result<(), String>;
    fn copy_from_local(&self, local_path: &Path, remote_path: &str) -> Result<(), String>;
    fn delete(&self, remote_path: &str) -> Result<(), String>;
}

/// Everything needed to run a sync.
pub struct SyncRequest<'a> {
    pub local_dir: &'a Path,
    pub config_dir: &'a Path,
    pub tree_uri: &'a str,
    /// Base64 vault id of the private vault; empty for a legacy v2 vault.
    pub vault_id: &'a str,
}

// ---------------------------------------------------------------------------
// Path classification
// ---------------------------------------------------------------------------

/// Classify a path the bridge is allowed to copy.
///
/// This is also the path-traversal gate: every component is checked, so a
/// compromised or hostile folder cannot make the app read or write outside the
/// private diary directory.
pub fn classify_path(path: &str) -> Option<Kind> {
    if path.is_empty() || path.len() > 300 {
        return None;
    }
    if path.contains('\\') || path.chars().any(|c| c.is_control()) {
        return None;
    }
    let parts: Vec<&str> = path.split('/').collect();
    if parts.is_empty() || parts.iter().any(|part| part.is_empty()) {
        return None;
    }

    match parts.as_slice() {
        ["vault.xml"] => Some(Kind::Vault),
        ["recovery.xml"] => Some(Kind::Recovery),
        [name] => {
            let date = name.strip_suffix(".xml")?;
            storage::validate_date(date).ok()?;
            Some(Kind::Entry)
        }
        ["attachments", date, name] => {
            storage::validate_date(date).ok()?;
            if *name == "manifest.xml" {
                Some(Kind::Manifest)
            } else {
                let id = name.strip_suffix(".bin")?;
                if id.len() == 32 && id.bytes().all(|b| b.is_ascii_hexdigit()) {
                    Some(Kind::Attachment)
                } else {
                    None
                }
            }
        }
        _ => None,
    }
}

/// Whether `path` is a diary entry (`YYYY-MM-DD.xml`).
pub fn is_entry_path(path: &str) -> bool {
    matches!(classify_path(path), Some(Kind::Entry))
}

// ---------------------------------------------------------------------------
// Config / state persistence
// ---------------------------------------------------------------------------

/// Read `sync.xml`, returning `None` when the bridge has not been bound.
pub fn read_config(config_dir: &Path) -> Result<Option<SyncConfig>, String> {
    let path = config_dir.join(CONFIG_FILE);
    let text = match fsutil::read_string_limited(&path, 16 * 1024) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("Failed to read sync settings: {error}")),
    };

    let mut tree_uri = None;
    let mut display_name = None;
    let mut auto_sync = None;
    let mut current = String::new();

    let mut reader = Reader::from_str(&text);
    reader.config_mut().trim_text(false);
    loop {
        match reader.read_event() {
            Ok(Event::Start(event)) => current = event.name().as_ref().to_string(),
            Ok(Event::Text(event)) => {
                let value = quick_xml::escape::unescape(event.as_ref())
                    .map_err(|e| format!("Invalid sync settings XML: {e}"))?;
                match current.as_str() {
                    "tree-uri" => tree_uri.get_or_insert_with(String::new).push_str(&value),
                    "display-name" => display_name
                        .get_or_insert_with(String::new)
                        .push_str(&value),
                    "auto" => auto_sync.get_or_insert_with(String::new).push_str(&value),
                    _ => {}
                }
            }
            Ok(Event::GeneralRef(event)) => {
                let raw = format!("&{};", event.as_ref());
                let value = quick_xml::escape::unescape(&raw)
                    .map_err(|e| format!("Invalid sync settings entity: {e}"))?;
                match current.as_str() {
                    "tree-uri" => tree_uri.get_or_insert_with(String::new).push_str(&value),
                    "display-name" => display_name
                        .get_or_insert_with(String::new)
                        .push_str(&value),
                    "auto" => auto_sync.get_or_insert_with(String::new).push_str(&value),
                    _ => {}
                }
            }
            Ok(Event::End(_)) => current.clear(),
            Ok(Event::Eof) => break,
            Err(error) => return Err(format!("Failed to parse sync settings: {error}")),
            _ => {}
        }
    }

    let tree_uri = tree_uri.unwrap_or_default().trim().to_string();
    if tree_uri.is_empty() {
        return Ok(None);
    }
    validate_tree_uri(&tree_uri)?;

    let display_name = display_name
        .unwrap_or_default()
        .trim()
        .chars()
        .take(200)
        .collect::<String>();
    let auto_sync = auto_sync
        .as_deref()
        .map(|value| value.trim() == "1")
        .unwrap_or(false);

    Ok(Some(SyncConfig {
        tree_uri,
        display_name,
        auto_sync,
    }))
}

/// Accept only an Android SAF tree URI.
pub fn validate_tree_uri(uri: &str) -> Result<(), String> {
    if !uri.starts_with("content://") {
        return Err("Sync folder must be an Android content:// tree URI".to_string());
    }
    if uri.len() > 4096 || uri.chars().any(|c| c.is_control()) {
        return Err("Sync folder URI is malformed".to_string());
    }
    Ok(())
}

/// Write `sync.xml`.
pub fn write_config(config_dir: &Path, config: &SyncConfig) -> Result<(), String> {
    validate_tree_uri(&config.tree_uri)?;
    fsutil::create_private_dir(config_dir)
        .map_err(|e| format!("Failed to create config directory: {e}"))?;

    let mut xml =
        String::from("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<sync version=\"1\">\n");
    xml.push_str("  <tree-uri>");
    xml.push_str(&quick_xml::escape::escape(&config.tree_uri));
    xml.push_str("</tree-uri>\n  <display-name>");
    xml.push_str(&quick_xml::escape::escape(
        config.display_name.chars().take(200).collect::<String>(),
    ));
    xml.push_str("</display-name>\n  <auto>");
    xml.push_str(if config.auto_sync { "1" } else { "0" });
    xml.push_str("</auto>\n</sync>\n");

    fsutil::write_private(&config_dir.join(CONFIG_FILE), xml)
        .map_err(|e| format!("Failed to write sync settings: {e}"))
}

/// Remove the binding and the three-way state.
pub fn clear_config(config_dir: &Path) -> Result<(), String> {
    for name in [CONFIG_FILE, STATE_FILE] {
        match fs::remove_file(config_dir.join(name)) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("Failed to remove {name}: {error}")),
        }
    }
    Ok(())
}

/// Read the last sync state. A corrupt file is treated as "no state", which
/// makes the next run report conflicts instead of overwriting anything.
pub fn read_state(config_dir: &Path) -> SyncState {
    let path = config_dir.join(STATE_FILE);
    let Ok(text) = fsutil::read_string_limited(&path, 32 * 1024 * 1024) else {
        return SyncState::default();
    };
    serde_json::from_str(&text).unwrap_or_default()
}

fn write_state(config_dir: &Path, state: &SyncState) -> Result<(), String> {
    fsutil::create_private_dir(config_dir)
        .map_err(|e| format!("Failed to create config directory: {e}"))?;
    let bytes = serde_json::to_vec_pretty(state)
        .map_err(|e| format!("Failed to serialise sync state: {e}"))?;
    fsutil::write_private(&config_dir.join(STATE_FILE), bytes)
        .map_err(|e| format!("Failed to write sync state: {e}"))
}

/// Reset the three-way state without touching the binding.
pub fn clear_state(config_dir: &Path) -> Result<(), String> {
    match fs::remove_file(config_dir.join(STATE_FILE)) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("Failed to reset sync state: {error}")),
    }
}

// ---------------------------------------------------------------------------
// Local scanning
// ---------------------------------------------------------------------------

fn hash_bytes(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut out = String::with_capacity(64);
    for byte in digest {
        use std::fmt::Write;
        let _ = write!(out, "{byte:02x}");
    }
    out
}

#[derive(Debug, Clone)]
struct LocalFile {
    size: u64,
    hash: String,
    mtime_ns: u64,
}

fn mtime_ns(metadata: &fs::Metadata) -> u64 {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_nanos().min(u64::MAX as u128) as u64)
        .unwrap_or(0)
}

fn local_metadata(path: &Path) -> Result<fs::Metadata, String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|e| format!("Failed to inspect {}: {e}", path.display()))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(format!(
            "Refusing to read non-regular file {}",
            path.display()
        ));
    }
    if metadata.len() > MAX_SYNC_FILE_BYTES {
        return Err(format!("File is too large to sync: {}", path.display()));
    }
    Ok(metadata)
}

fn hash_local(path: &Path, metadata: &fs::Metadata) -> Result<LocalFile, String> {
    let bytes = fs::read(path).map_err(|e| format!("Failed to read {}: {e}", path.display()))?;
    Ok(LocalFile {
        size: bytes.len() as u64,
        hash: hash_bytes(&bytes),
        mtime_ns: mtime_ns(metadata),
    })
}

fn read_and_hash(path: &Path) -> Result<LocalFile, String> {
    let metadata = local_metadata(path)?;
    hash_local(path, &metadata)
}

/// Hash a local file, reusing the cached hash when its size and mtime still
/// match the last successful sync.
///
/// Without this, an autosave-triggered sync would read every attachment on the
/// phone just to discover that none of them changed.
fn read_and_hash_cached(
    path: &Path,
    relative: &str,
    known: &BTreeMap<String, FileState>,
) -> Result<LocalFile, String> {
    let metadata = local_metadata(path)?;
    let size = metadata.len();
    let mtime = mtime_ns(&metadata);
    if mtime != 0 {
        if let Some(base) = known.get(relative) {
            if base.local_size == size && base.local_mtime_ns == mtime && !base.hash.is_empty() {
                return Ok(LocalFile {
                    size,
                    hash: base.hash.clone(),
                    mtime_ns: mtime,
                });
            }
        }
    }
    hash_local(path, &metadata)
}

fn scan_local(
    dir: &Path,
    known: &BTreeMap<String, FileState>,
) -> Result<BTreeMap<String, LocalFile>, String> {
    let mut files = BTreeMap::new();
    if !dir.exists() {
        return Ok(files);
    }
    if !dir.is_dir() {
        return Err("Diary path is not a directory".to_string());
    }

    for entry in fs::read_dir(dir).map_err(|e| format!("Failed to read diary folder: {e}"))? {
        let entry = entry.map_err(|e| format!("Failed to read diary folder: {e}"))?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let kind = entry
            .file_type()
            .map_err(|e| format!("Failed to inspect {name}: {e}"))?;
        if kind.is_symlink() {
            continue;
        }
        if kind.is_file() {
            if classify_path(&name).is_some() {
                files.insert(
                    name.clone(),
                    read_and_hash_cached(&entry.path(), &name, known)?,
                );
            }
        } else if kind.is_dir() && name == "attachments" {
            scan_attachments(&entry.path(), known, &mut files)?;
        }
        if files.len() > MAX_FILES {
            return Err("The diary folder contains too many files to sync".to_string());
        }
    }
    Ok(files)
}

fn scan_attachments(
    root: &Path,
    known: &BTreeMap<String, FileState>,
    files: &mut BTreeMap<String, LocalFile>,
) -> Result<(), String> {
    for date_entry in
        fs::read_dir(root).map_err(|e| format!("Failed to read attachments folder: {e}"))?
    {
        let date_entry =
            date_entry.map_err(|e| format!("Failed to read attachments folder: {e}"))?;
        let date = date_entry.file_name().to_string_lossy().into_owned();
        if storage::validate_date(&date).is_err() {
            continue;
        }
        let kind = date_entry
            .file_type()
            .map_err(|e| format!("Failed to inspect attachment folder: {e}"))?;
        if !kind.is_dir() || kind.is_symlink() {
            continue;
        }
        for file_entry in fs::read_dir(date_entry.path())
            .map_err(|e| format!("Failed to read attachment folder: {e}"))?
        {
            let file_entry =
                file_entry.map_err(|e| format!("Failed to read attachment folder: {e}"))?;
            let name = file_entry.file_name().to_string_lossy().into_owned();
            let path = format!("attachments/{date}/{name}");
            if classify_path(&path).is_none() {
                continue;
            }
            let kind = file_entry
                .file_type()
                .map_err(|e| format!("Failed to inspect attachment: {e}"))?;
            if kind.is_symlink() || !kind.is_file() {
                continue;
            }
            files.insert(
                path.clone(),
                read_and_hash_cached(&file_entry.path(), &path, known)?,
            );
        }
        if files.len() > MAX_FILES {
            return Err("The diary folder contains too many files to sync".to_string());
        }
    }
    Ok(())
}

fn invalidate_index(local_dir: &Path) -> Result<(), String> {
    match fs::remove_file(local_dir.join("index.xml")) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("Failed to invalidate the diary index: {error}")),
    }
}

// ---------------------------------------------------------------------------
// Remote helpers
// ---------------------------------------------------------------------------

fn validate_remote_list(list: Vec<RemoteFile>) -> Result<BTreeMap<String, RemoteFile>, String> {
    if list.len() > MAX_FILES {
        return Err("The selected folder contains too many files".to_string());
    }
    let mut map = BTreeMap::new();
    for file in list {
        if classify_path(&file.path).is_none() {
            continue;
        }
        if map.contains_key(&file.path) {
            return Err(format!(
                "The selected folder lists the same file twice: {}",
                file.path
            ));
        }
        map.insert(file.path.clone(), file);
    }
    Ok(map)
}

fn scratch_path(config_dir: &Path, prefix: &str) -> PathBuf {
    config_dir.join(format!(".{prefix}-{:016x}", rand::random::<u64>()))
}

fn hash_remote(
    remote: &dyn Remote,
    config_dir: &Path,
    path: &str,
    cache: &mut BTreeMap<String, String>,
) -> Result<String, String> {
    if let Some(hash) = cache.get(path) {
        return Ok(hash.clone());
    }
    let temp = scratch_path(config_dir, "sync-peek");
    remote
        .copy_to_local(path, &temp)
        .map_err(|e| format!("Failed to read {path} from the folder: {e}"))?;
    let result = read_and_hash(&temp)
        .map(|file| file.hash)
        .map_err(|e| format!("Failed to hash {path}: {e}"));
    let _ = fs::remove_file(&temp);
    let hash = result?;
    cache.insert(path.to_string(), hash.clone());
    Ok(hash)
}

/// Read the vault id from a `vault.xml` document.
///
/// Only the two public identifiers are extracted; the wrapped key and salt are
/// not needed and are never inspected here.
fn vault_identity(text: &str) -> Result<Option<[u8; 16]>, String> {
    let mut vault_id = None;
    let mut current = String::new();
    let mut reader = Reader::from_str(text);
    reader.config_mut().trim_text(true);
    loop {
        match reader.read_event() {
            Ok(Event::Start(event)) => current = event.name().as_ref().to_string(),
            Ok(Event::Text(event)) if current == "vault-id" => {
                let value = quick_xml::escape::unescape(event.as_ref())
                    .map_err(|e| format!("Invalid vault XML: {e}"))?;
                vault_id.get_or_insert_with(String::new).push_str(&value);
            }
            Ok(Event::End(_)) => current.clear(),
            Ok(Event::Eof) => break,
            Err(error) => return Err(format!("Invalid vault XML: {error}")),
            _ => {}
        }
    }

    let Some(raw) = vault_id else {
        return Ok(None);
    };
    let bytes = crypto::b64_decode(raw.trim())?;
    if bytes.len() != 16 {
        return Err("Vault id has the wrong length".to_string());
    }
    let mut id = [0u8; 16];
    id.copy_from_slice(&bytes);
    Ok(Some(id))
}

fn peek_remote_vault(remote: &dyn Remote, config_dir: &Path) -> Result<Option<[u8; 16]>, String> {
    let temp = scratch_path(config_dir, "sync-vault");
    remote
        .copy_to_local("vault.xml", &temp)
        .map_err(|e| format!("Failed to read vault.xml from the folder: {e}"))?;
    let result = fsutil::read_string_limited(&temp, MAX_PEEK_BYTES)
        .map_err(|e| format!("Failed to read vault.xml from the folder: {e}"));
    let text = result;
    let _ = fs::remove_file(&temp);
    vault_identity(&text?)
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

fn reliable(meta: &RemoteFile) -> bool {
    meta.mtime_ms > 0 && meta.size > 0
}

/// Copy every known file from the folder without comparing. Used by the
/// "restore from this folder" flow, which replaces the private vault.
fn pull_all_into(
    remote: &dyn Remote,
    remote_map: &BTreeMap<String, RemoteFile>,
    target: &Path,
) -> Result<(), String> {
    for path in remote_map.keys() {
        let local = target.join(path);
        ensure_parent(&local)?;
        remote
            .copy_to_local(path, &local)
            .map_err(|e| format!("Failed to copy {path}: {e}"))?;
    }
    Ok(())
}

fn ensure_parent(path: &Path) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fsutil::create_private_dir(parent)
            .map_err(|e| format!("Failed to create {}: {e}", parent.display()))?;
    }
    Ok(())
}

/// Inspect the folder before binding it.
pub fn inspect(remote: &dyn Remote, config_dir: &Path) -> Result<Inspection, String> {
    fsutil::create_private_dir(config_dir)
        .map_err(|e| format!("Failed to create config directory: {e}"))?;
    let remote_map = validate_remote_list(remote.list()?)?;
    let mut entries = 0;
    let mut attachments = 0;
    for path in remote_map.keys() {
        match classify_path(path) {
            Some(Kind::Entry) => entries += 1,
            Some(Kind::Attachment) => attachments += 1,
            _ => {}
        }
    }
    let vault_id = if remote_map.contains_key("vault.xml") {
        peek_remote_vault(remote, config_dir)?.map(|id| crypto::b64_encode(&id))
    } else {
        None
    };
    Ok(Inspection {
        has_vault: remote_map.contains_key("vault.xml"),
        vault_id,
        entries,
        attachments,
        files: remote_map.len(),
    })
}

/// Run a three-way sync.
pub fn sync(req: &SyncRequest<'_>, remote: &dyn Remote) -> Result<SyncReport, String> {
    fsutil::create_private_dir(req.config_dir)
        .map_err(|e| format!("Failed to create config directory: {e}"))?;

    let mut state = read_state(req.config_dir);
    if state.tree_uri != req.tree_uri || state.vault_id != req.vault_id {
        state = SyncState {
            tree_uri: req.tree_uri.to_string(),
            vault_id: req.vault_id.to_string(),
            last_synced_at_ms: 0,
            files: BTreeMap::new(),
        };
    }

    let remote_map = validate_remote_list(remote.list()?)?;
    let local = scan_local(req.local_dir, &state.files)?;

    // A provider or sync client that temporarily reports an empty folder must
    // not be interpreted as "delete every remote file". The user can unlink and
    // bind again if they really want to start from an empty folder.
    if remote_map.is_empty() && !state.files.is_empty() && !local.is_empty() {
        return Err(
            "The sync folder looks empty. Refusing to treat that as deleting every file; \
             check the folder and the sync client, or unlink and bind it again."
                .to_string(),
        );
    }

    // A folder that now belongs to another vault must not be merged: the user
    // has to choose "restore from folder" explicitly. `vault.xml` is tiny, so
    // it is checked on every run rather than trusting cached metadata.
    if !req.vault_id.is_empty() && remote_map.contains_key("vault.xml") {
        if let Some(id) = peek_remote_vault(remote, req.config_dir)? {
            let remote_id = crypto::b64_encode(&id);
            if remote_id != req.vault_id {
                return Err("The selected folder belongs to a different diary vault. \
                     Use \"restore from folder\" to adopt it, or pick another folder."
                    .to_string());
            }
        }
    }

    let mut report = SyncReport::default();
    let mut in_sync: BTreeSet<String> = BTreeSet::new();
    let mut pushed: BTreeSet<String> = BTreeSet::new();
    let mut pulled: BTreeSet<String> = BTreeSet::new();
    let mut removed: BTreeSet<String> = BTreeSet::new();
    let mut remote_hashes: BTreeMap<String, String> = BTreeMap::new();
    let mut index_dirty = false;

    let paths: BTreeSet<String> = local.keys().chain(remote_map.keys()).cloned().collect();

    for path in paths {
        let Some(kind) = classify_path(&path) else {
            continue;
        };
        let local_file = local.get(&path);
        let remote_file = remote_map.get(&path);
        let base = state.files.get(&path);

        match (local_file, remote_file) {
            (Some(local_file), Some(remote_file)) => {
                // Reuse the last hash when the remote metadata still matches
                // it; otherwise fetch the bytes once and hash them.
                let remote_need_hash = base.map_or(true, |base| {
                    !reliable(remote_file)
                        || base.remote_size != remote_file.size
                        || base.remote_mtime_ms != remote_file.mtime_ms
                });
                let remote_hash = if remote_need_hash {
                    hash_remote(remote, req.config_dir, &path, &mut remote_hashes)?
                } else {
                    base.map(|base| base.hash.clone()).unwrap_or_default()
                };

                if local_file.hash == remote_hash {
                    in_sync.insert(path.clone());
                    continue;
                }

                match base {
                    None => report.conflicts.push(SyncConflict {
                        path,
                        kind: ConflictKind::BothChanged,
                        local_size: Some(local_file.size),
                        remote_size: Some(remote_file.size),
                    }),
                    Some(base) => {
                        let local_changed = local_file.hash != base.hash;
                        let remote_changed = remote_hash != base.hash;
                        match (local_changed, remote_changed) {
                            (true, false) => {
                                remote
                                    .copy_from_local(&req.local_dir.join(&path), &path)
                                    .map_err(|e| format!("Failed to upload {path}: {e}"))?;
                                pushed.insert(path.clone());
                                report.pushed.push(path);
                                if matches!(kind, Kind::Entry) {
                                    index_dirty = true;
                                }
                            }
                            (false, true) => {
                                let local = req.local_dir.join(&path);
                                ensure_parent(&local)?;
                                remote
                                    .copy_to_local(&path, &local)
                                    .map_err(|e| format!("Failed to download {path}: {e}"))?;
                                pulled.insert(path.clone());
                                report.pulled.push(path);
                                if matches!(kind, Kind::Entry) {
                                    index_dirty = true;
                                }
                            }
                            _ => report.conflicts.push(SyncConflict {
                                path,
                                kind: ConflictKind::BothChanged,
                                local_size: Some(local_file.size),
                                remote_size: Some(remote_file.size),
                            }),
                        }
                    }
                }
            }
            (Some(local_file), None) => match base {
                None => {
                    remote
                        .copy_from_local(&req.local_dir.join(&path), &path)
                        .map_err(|e| format!("Failed to upload {path}: {e}"))?;
                    pushed.insert(path.clone());
                    report.pushed.push(path);
                    if matches!(kind, Kind::Entry) {
                        index_dirty = true;
                    }
                }
                Some(base) if local_file.hash == base.hash => {
                    remote
                        .copy_from_local(&req.local_dir.join(&path), &path)
                        .map_err(|e| format!("Failed to restore {path}: {e}"))?;
                    pushed.insert(path.clone());
                    report.pushed.push(path.clone());
                    report.notes.push(format!(
                        "{path} was missing from the folder and has been restored"
                    ));
                    if matches!(kind, Kind::Entry) {
                        index_dirty = true;
                    }
                }
                Some(_) => report.conflicts.push(SyncConflict {
                    path,
                    kind: ConflictKind::LocalEditedRemoteDeleted,
                    local_size: Some(local_file.size),
                    remote_size: None,
                }),
            },
            (None, Some(remote_file)) => {
                let remote_changed = match base {
                    None => true,
                    Some(base) => {
                        if reliable(remote_file)
                            && base.remote_size == remote_file.size
                            && base.remote_mtime_ms == remote_file.mtime_ms
                        {
                            false
                        } else {
                            hash_remote(remote, req.config_dir, &path, &mut remote_hashes)?
                                != base.hash
                        }
                    }
                };
                match base {
                    None => {
                        let local = req.local_dir.join(&path);
                        ensure_parent(&local)?;
                        remote
                            .copy_to_local(&path, &local)
                            .map_err(|e| format!("Failed to download {path}: {e}"))?;
                        pulled.insert(path.clone());
                        report.pulled.push(path);
                        if matches!(kind, Kind::Entry) {
                            index_dirty = true;
                        }
                    }
                    Some(_) if !remote_changed => {
                        // The private vault is authoritative: deleting a day on
                        // the phone deletes the mirrored copy too. The reverse
                        // case is deliberately asymmetric (see below) so a
                        // folder glitch can never erase the private diary.
                        remote
                            .delete(&path)
                            .map_err(|e| format!("Failed to delete {path} from the folder: {e}"))?;
                        removed.insert(path.clone());
                        report.notes.push(format!(
                            "{path} was deleted locally and has been removed from the folder"
                        ));
                        if matches!(kind, Kind::Entry) {
                            index_dirty = true;
                        }
                    }
                    Some(_) => report.conflicts.push(SyncConflict {
                        path,
                        kind: ConflictKind::RemoteEditedLocalDeleted,
                        local_size: None,
                        remote_size: Some(remote_file.size),
                    }),
                }
            }
            (None, None) => unreachable!(),
        }
    }

    if index_dirty {
        // SQLCipher no longer writes an index file. Removing a stale one left
        // by a pre-migration device is still useful; a provider that refuses
        // is not fatal because the database is authoritative.
        invalidate_index(req.local_dir)?;
        let _ = remote.delete(INDEX_FILE);
    }

    // Refresh both sides so the state records the metadata the provider
    // actually assigned to the files we just wrote.
    let remote_after = validate_remote_list(remote.list()?)?;
    let local_after = scan_local(req.local_dir, &state.files)?;
    let mut synced: BTreeSet<String> = in_sync;
    synced.extend(pushed);
    synced.extend(pulled);
    for path in synced {
        if let (Some(local), Some(remote)) = (local_after.get(&path), remote_after.get(&path)) {
            state.files.insert(
                path,
                FileState {
                    hash: local.hash.clone(),
                    remote_size: remote.size,
                    remote_mtime_ms: remote.mtime_ms,
                    local_size: local.size,
                    local_mtime_ns: local.mtime_ns,
                },
            );
        }
    }
    state
        .files
        .retain(|path, _| local_after.contains_key(path) || remote_after.contains_key(path));
    for path in &removed {
        state.files.remove(path);
    }
    state.last_synced_at_ms = now_ms();
    report.synced_at_ms = state.last_synced_at_ms;
    write_state(req.config_dir, &state)?;

    Ok(report)
}

/// Keep one side of a conflict.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Resolution {
    Local,
    Remote,
}

/// Resolve one conflict explicitly. The caller is responsible for choosing
/// which side the user wants to keep.
pub fn resolve(
    req: &SyncRequest<'_>,
    remote: &dyn Remote,
    path: &str,
    resolution: Resolution,
) -> Result<(), String> {
    let kind = classify_path(path).ok_or_else(|| format!("Not a syncable file: {path}"))?;
    let mut state = read_state(req.config_dir);
    if state.tree_uri != req.tree_uri || state.vault_id != req.vault_id {
        state = SyncState {
            tree_uri: req.tree_uri.to_string(),
            vault_id: req.vault_id.to_string(),
            last_synced_at_ms: 0,
            files: BTreeMap::new(),
        };
    }

    let local = req.local_dir.join(path);
    match resolution {
        Resolution::Local => {
            if fs::symlink_metadata(&local)
                .map(|m| m.is_file())
                .unwrap_or(false)
            {
                remote
                    .copy_from_local(&local, path)
                    .map_err(|e| format!("Failed to upload {path}: {e}"))?;
            } else {
                remote
                    .delete(path)
                    .map_err(|e| format!("Failed to delete {path} from the folder: {e}"))?;
            }
        }
        Resolution::Remote => {
            let remote_map = validate_remote_list(remote.list()?)?;
            if remote_map.contains_key(path) {
                // Pulling a foreign vault.xml would silently switch the whole
                // diary to a vault this session cannot prove it owns.
                if matches!(kind, Kind::Vault) && !req.vault_id.is_empty() {
                    if let Some(id) = peek_remote_vault(remote, req.config_dir)? {
                        if crypto::b64_encode(&id) != req.vault_id {
                            return Err(
                                "That folder's vault.xml belongs to a different vault".to_string()
                            );
                        }
                    }
                }
                ensure_parent(&local)?;
                remote
                    .copy_to_local(path, &local)
                    .map_err(|e| format!("Failed to download {path}: {e}"))?;
            } else {
                match fs::symlink_metadata(&local) {
                    Ok(metadata) if metadata.is_file() => {
                        fs::remove_file(&local)
                            .map_err(|e| format!("Failed to delete {path}: {e}"))?;
                    }
                    Ok(_) => return Err(format!("{path} is not a regular file")),
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                    Err(error) => return Err(format!("Failed to inspect {path}: {error}")),
                }
            }
        }
    }

    if matches!(kind, Kind::Entry) {
        // The cache no longer describes the entries on at least one side.
        invalidate_index(req.local_dir)?;
        let _ = remote.delete(INDEX_FILE);
    }

    state.files.remove(path);
    state.last_synced_at_ms = now_ms();
    write_state(req.config_dir, &state)
}

/// Replace the private vault with the external folder's contents.
///
/// The previous private folder is renamed to a sibling backup instead of being
/// deleted, so an accidental restore can be undone. The caller must make sure
/// the session is locked first.
pub fn adopt(
    local_dir: &Path,
    config_dir: &Path,
    tree_uri: &str,
    remote: &dyn Remote,
) -> Result<AdoptReport, String> {
    fsutil::create_private_dir(config_dir)
        .map_err(|e| format!("Failed to create config directory: {e}"))?;
    let remote_map = validate_remote_list(remote.list()?)?;
    if !remote_map.contains_key("vault.xml") {
        return Err("The selected folder does not contain a diary vault".to_string());
    }

    let parent = local_dir
        .parent()
        .ok_or_else(|| "Diary path has no parent directory".to_string())?;
    fsutil::create_private_dir(parent)
        .map_err(|e| format!("Failed to create diary parent directory: {e}"))?;

    let staging = parent.join(format!(".restore-{:016x}", rand::random::<u64>()));
    fsutil::create_private_dir(&staging)
        .map_err(|e| format!("Failed to create restore folder: {e}"))?;

    let result = (|| -> Result<AdoptReport, String> {
        pull_all_into(remote, &remote_map, &staging)?;

        let vault_text = fsutil::read_string_limited(&staging.join("vault.xml"), MAX_PEEK_BYTES)
            .map_err(|e| format!("Failed to read the restored vault: {e}"))?;
        let vault_id = vault_identity(&vault_text)?
            .map(|id| crypto::b64_encode(&id))
            .unwrap_or_default();

        let backup = if local_dir.exists() {
            let stamp = now_ms();
            let mut backup = parent.join(format!(
                "{}.local-backup-{stamp}",
                local_dir
                    .file_name()
                    .map(|name| name.to_string_lossy().into_owned())
                    .unwrap_or_else(|| "diary".to_string())
            ));
            let mut counter = 1;
            while backup.exists() {
                backup = parent.join(format!(
                    "{}.local-backup-{stamp}-{counter}",
                    local_dir
                        .file_name()
                        .map(|name| name.to_string_lossy().into_owned())
                        .unwrap_or_else(|| "diary".to_string())
                ));
                counter += 1;
            }
            fs::rename(local_dir, &backup)
                .map_err(|e| format!("Failed to back up the current diary: {e}"))?;
            Some(backup)
        } else {
            None
        };

        if let Err(error) = fs::rename(&staging, local_dir) {
            if let Some(backup) = &backup {
                let _ = fs::rename(backup, local_dir);
            }
            return Err(format!("Failed to install the restored diary: {error}"));
        }

        // The installed files are byte copies of the remote files, so the
        // fresh state can treat both sides as in sync.
        let local_after = scan_local(local_dir, &BTreeMap::new())?;
        let remote_after = validate_remote_list(remote.list()?)?;
        let mut state = SyncState {
            tree_uri: tree_uri.to_string(),
            vault_id: vault_id.clone(),
            last_synced_at_ms: now_ms(),
            files: BTreeMap::new(),
        };
        for (path, local) in &local_after {
            if let Some(remote) = remote_after.get(path) {
                state.files.insert(
                    path.clone(),
                    FileState {
                        hash: local.hash.clone(),
                        remote_size: remote.size,
                        remote_mtime_ms: remote.mtime_ms,
                        local_size: local.size,
                        local_mtime_ns: local.mtime_ns,
                    },
                );
            }
        }
        write_state(config_dir, &state)?;

        let report = SyncReport {
            pushed: Vec::new(),
            pulled: remote_map.keys().cloned().collect(),
            conflicts: Vec::new(),
            notes: vec!["The previous diary was kept as a local backup".to_string()],
            synced_at_ms: state.last_synced_at_ms,
        };
        Ok(AdoptReport {
            report,
            backup_path: backup.map(|path| path.to_string_lossy().into_owned()),
            vault_id,
        })
    })();

    if result.is_err() {
        let _ = fs::remove_dir_all(&staging);
    }
    result
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "fly-diary-sync-test-{}-{}",
            name,
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write(path: &Path, bytes: &[u8]) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        let mut file = fs::File::create(path).unwrap();
        file.write_all(bytes).unwrap();
    }

    struct FakeRemote {
        root: PathBuf,
    }

    impl FakeRemote {
        fn new(root: PathBuf) -> Self {
            fs::create_dir_all(&root).unwrap();
            Self { root }
        }

        fn path(&self, remote: &str) -> PathBuf {
            self.root.join(remote)
        }

        fn put(&self, remote: &str, bytes: &[u8]) {
            write(&self.path(remote), bytes);
        }

        fn get(&self, remote: &str) -> Vec<u8> {
            fs::read(self.path(remote)).unwrap()
        }
    }

    impl Remote for FakeRemote {
        fn list(&self) -> Result<Vec<RemoteFile>, String> {
            let mut out = Vec::new();
            fn walk(root: &Path, dir: &Path, out: &mut Vec<RemoteFile>) {
                for entry in fs::read_dir(dir).unwrap() {
                    let entry = entry.unwrap();
                    let path = entry.path();
                    let metadata = entry.metadata().unwrap();
                    if metadata.is_dir() {
                        walk(root, &path, out);
                    } else {
                        let relative = path.strip_prefix(root).unwrap().to_string_lossy();
                        out.push(RemoteFile {
                            path: relative.replace('\\', "/"),
                            size: metadata.len(),
                            mtime_ms: metadata
                                .modified()
                                .ok()
                                .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                                .map(|duration| duration.as_millis() as i64)
                                .unwrap_or(0),
                        });
                    }
                }
            }
            walk(&self.root, &self.root, &mut out);
            out.sort_by(|a, b| a.path.cmp(&b.path));
            Ok(out)
        }

        fn copy_to_local(&self, remote_path: &str, local_path: &Path) -> Result<(), String> {
            fs::copy(self.path(remote_path), local_path).map_err(|e| e.to_string())?;
            Ok(())
        }

        fn copy_from_local(&self, local_path: &Path, remote_path: &str) -> Result<(), String> {
            write(&self.path(remote_path), &fs::read(local_path).unwrap());
            Ok(())
        }

        fn delete(&self, remote_path: &str) -> Result<(), String> {
            match fs::remove_file(self.path(remote_path)) {
                Ok(()) => Ok(()),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Err(error) => Err(error.to_string()),
            }
        }
    }

    fn setup(name: &str) -> (PathBuf, PathBuf, FakeRemote) {
        let base = temp(name);
        let local = base.join("diary");
        let config = base.join("config");
        fs::create_dir_all(&local).unwrap();
        write(&local.join("vault.xml"), b"<vault>local</vault>");
        let remote = FakeRemote::new(base.join("remote"));
        (local, config, remote)
    }

    fn request<'a>(local: &'a Path, config: &'a Path, tree: &'a str) -> SyncRequest<'a> {
        SyncRequest {
            local_dir: local,
            config_dir: config,
            tree_uri: tree,
            vault_id: "",
        }
    }

    #[test]
    fn classifies_only_known_files() {
        assert_eq!(classify_path("vault.xml"), Some(Kind::Vault));
        assert_eq!(classify_path("recovery.xml"), Some(Kind::Recovery));
        assert_eq!(classify_path("2026-11-16.xml"), Some(Kind::Entry));
        assert_eq!(
            classify_path("attachments/2026-11-16/manifest.xml"),
            Some(Kind::Manifest)
        );
        assert_eq!(
            classify_path("attachments/2026-11-16/0123456789abcdef0123456789abcdef.bin"),
            Some(Kind::Attachment)
        );
        for bad in [
            "index.xml",
            "migration.journal",
            "../vault.xml",
            "attachments/../vault.xml",
            "attachments/2026-11-16/../../vault.xml",
            "2026-11-16.xml.tmp-1234",
            "attachments/2026-11-16/not-an-id.bin",
            "attachments/2026-13-01/manifest.xml",
            "",
        ] {
            assert_eq!(classify_path(bad), None, "should reject {bad:?}");
        }
    }

    #[test]
    fn config_roundtrip_and_validation() {
        let base = temp("config");
        let config = SyncConfig {
            tree_uri: "content://com.android.providers.downloads.documents/tree/primary%3ADiary"
                .to_string(),
            display_name: "My & Diary".to_string(),
            auto_sync: true,
        };
        write_config(&base, &config).unwrap();
        assert_eq!(read_config(&base).unwrap(), Some(config));
        assert!(validate_tree_uri("file:///tmp/diary").is_err());
        clear_config(&base).unwrap();
        assert_eq!(read_config(&base).unwrap(), None);
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn first_sync_pushes_local_files() {
        let (local, config, remote) = setup("first-push");
        write(&local.join("2026-11-16.xml"), b"entry");
        write(
            &local.join("attachments/2026-11-16/manifest.xml"),
            b"manifest",
        );
        write(&local.join("index.xml"), b"index");
        remote.put("index.xml", b"remote index");

        let report = sync(&request(&local, &config, "content://tree"), &remote).unwrap();
        assert!(report.pushed.contains(&"vault.xml".to_string()));
        assert!(report.pushed.contains(&"2026-11-16.xml".to_string()));
        assert!(report
            .pushed
            .contains(&"attachments/2026-11-16/manifest.xml".to_string()));
        assert!(!report.pushed.contains(&"index.xml".to_string()));
        assert_eq!(remote.get("2026-11-16.xml"), b"entry");
        assert!(!remote.path("index.xml").exists());
        assert!(!local.join("index.xml").exists());
        assert!(report.conflicts.is_empty());
        let _ = fs::remove_dir_all(local.parent().unwrap());
    }

    #[test]
    fn first_sync_pulls_remote_files() {
        let (local, config, remote) = setup("first-pull");
        remote.put("2026-11-17.xml", b"remote entry");
        remote.put("attachments/2026-11-17/manifest.xml", b"manifest");
        let report = sync(&request(&local, &config, "content://tree"), &remote).unwrap();
        assert!(report.pulled.contains(&"2026-11-17.xml".to_string()));
        assert_eq!(
            fs::read(local.join("2026-11-17.xml")).unwrap(),
            b"remote entry"
        );
        assert!(!local.join("index.xml").exists());
        let _ = fs::remove_dir_all(local.parent().unwrap());
    }

    #[test]
    fn unchanged_files_are_not_copied() {
        let (local, config, remote) = setup("unchanged");
        write(&local.join("2026-11-16.xml"), b"entry");
        sync(&request(&local, &config, "content://tree"), &remote).unwrap();
        let report = sync(&request(&local, &config, "content://tree"), &remote).unwrap();
        assert!(report.pushed.is_empty());
        assert!(report.pulled.is_empty());
        assert!(report.conflicts.is_empty());
        let _ = fs::remove_dir_all(local.parent().unwrap());
    }

    #[test]
    fn both_changed_is_a_conflict_and_nothing_is_overwritten() {
        let (local, config, remote) = setup("conflict");
        write(&local.join("2026-11-16.xml"), b"base");
        sync(&request(&local, &config, "content://tree"), &remote).unwrap();

        write(&local.join("2026-11-16.xml"), b"local change");
        remote.put("2026-11-16.xml", b"remote change");

        let report = sync(&request(&local, &config, "content://tree"), &remote).unwrap();
        assert_eq!(report.conflicts.len(), 1);
        assert_eq!(report.conflicts[0].path, "2026-11-16.xml");
        assert_eq!(report.conflicts[0].kind, ConflictKind::BothChanged);
        assert_eq!(
            fs::read(local.join("2026-11-16.xml")).unwrap(),
            b"local change"
        );
        assert_eq!(remote.get("2026-11-16.xml"), b"remote change");

        resolve(
            &request(&local, &config, "content://tree"),
            &remote,
            "2026-11-16.xml",
            Resolution::Remote,
        )
        .unwrap();
        assert_eq!(
            fs::read(local.join("2026-11-16.xml")).unwrap(),
            b"remote change"
        );
        let report = sync(&request(&local, &config, "content://tree"), &remote).unwrap();
        assert!(report.conflicts.is_empty());
        let _ = fs::remove_dir_all(local.parent().unwrap());
    }

    #[test]
    fn keeping_local_overwrites_the_folder() {
        let (local, config, remote) = setup("keep-local");
        write(&local.join("2026-11-16.xml"), b"base");
        sync(&request(&local, &config, "content://tree"), &remote).unwrap();

        write(&local.join("2026-11-16.xml"), b"local change");
        remote.put("2026-11-16.xml", b"remote change");
        resolve(
            &request(&local, &config, "content://tree"),
            &remote,
            "2026-11-16.xml",
            Resolution::Local,
        )
        .unwrap();
        assert_eq!(remote.get("2026-11-16.xml"), b"local change");
        assert_eq!(
            fs::read(local.join("2026-11-16.xml")).unwrap(),
            b"local change"
        );
        let _ = fs::remove_dir_all(local.parent().unwrap());
    }

    #[test]
    fn one_sided_change_is_synced() {
        let (local, config, remote) = setup("one-sided");
        write(&local.join("2026-11-16.xml"), b"base");
        sync(&request(&local, &config, "content://tree"), &remote).unwrap();

        write(&local.join("2026-11-16.xml"), b"new local");
        let report = sync(&request(&local, &config, "content://tree"), &remote).unwrap();
        assert_eq!(report.pushed, vec!["2026-11-16.xml"]);
        assert_eq!(remote.get("2026-11-16.xml"), b"new local");

        remote.put("2026-11-16.xml", b"new remote");
        let report = sync(&request(&local, &config, "content://tree"), &remote).unwrap();
        assert_eq!(report.pulled, vec!["2026-11-16.xml"]);
        assert_eq!(
            fs::read(local.join("2026-11-16.xml")).unwrap(),
            b"new remote"
        );
        let _ = fs::remove_dir_all(local.parent().unwrap());
    }

    #[test]
    fn deleting_locally_removes_the_mirrored_copy() {
        let (local, config, remote) = setup("local-delete");
        write(&local.join("2026-11-16.xml"), b"entry");
        sync(&request(&local, &config, "content://tree"), &remote).unwrap();

        fs::remove_file(local.join("2026-11-16.xml")).unwrap();
        let report = sync(&request(&local, &config, "content://tree"), &remote).unwrap();
        assert!(report.pulled.is_empty());
        assert!(report
            .notes
            .iter()
            .any(|note| note.contains("deleted locally")));
        assert!(!remote.path("2026-11-16.xml").exists());
        assert!(!local.join("2026-11-16.xml").exists());
        let _ = fs::remove_dir_all(local.parent().unwrap());
    }

    #[test]
    fn deleting_remotely_restores_the_private_copy() {
        let (local, config, remote) = setup("remote-delete");
        write(&local.join("2026-11-16.xml"), b"entry");
        sync(&request(&local, &config, "content://tree"), &remote).unwrap();

        remote.delete("2026-11-16.xml").unwrap();
        let report = sync(&request(&local, &config, "content://tree"), &remote).unwrap();
        assert_eq!(report.pushed, vec!["2026-11-16.xml"]);
        assert_eq!(remote.get("2026-11-16.xml"), b"entry");
        assert_eq!(fs::read(local.join("2026-11-16.xml")).unwrap(), b"entry");
        let _ = fs::remove_dir_all(local.parent().unwrap());
    }

    #[test]
    fn an_empty_folder_does_not_delete_everything() {
        let (local, config, remote) = setup("empty-guard");
        write(&local.join("2026-11-16.xml"), b"entry");
        sync(&request(&local, &config, "content://tree"), &remote).unwrap();

        fs::remove_file(remote.path("2026-11-16.xml")).unwrap();
        fs::remove_file(remote.path("vault.xml")).unwrap();
        let error = sync(&request(&local, &config, "content://tree"), &remote).unwrap_err();
        assert!(error.contains("looks empty"), "got: {error}");
        assert!(local.join("2026-11-16.xml").exists());
        let _ = fs::remove_dir_all(local.parent().unwrap());
    }

    #[test]
    fn adopt_swaps_the_vault_and_keeps_a_backup() {
        let (local, config, remote) = setup("adopt");
        write(&local.join("2026-11-16.xml"), b"old local");
        let vault_xml = "<vault><vault-id>AAAAAAAAAAAAAAAAAAAAAA==</vault-id></vault>";
        remote.put("vault.xml", vault_xml.as_bytes());
        remote.put("2026-11-17.xml", b"remote entry");

        let adopted = adopt(&local, &config, "content://tree", &remote).unwrap();
        assert_eq!(adopted.vault_id, "AAAAAAAAAAAAAAAAAAAAAA==");
        assert!(adopted.backup_path.is_some());
        assert_eq!(
            fs::read(local.join("vault.xml")).unwrap(),
            vault_xml.as_bytes()
        );
        assert_eq!(
            fs::read(local.join("2026-11-17.xml")).unwrap(),
            b"remote entry"
        );
        assert!(!local.join("2026-11-16.xml").exists());
        let _ = fs::remove_dir_all(local.parent().unwrap());
    }
}
