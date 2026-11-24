//! Encrypted image attachments stored next to the diary entries.
//!
//! Layout:
//!
//! ```text
//! diary/
//! └── attachments/
//!     ├── 9f2c....bin
//!     └── 4d8e....bin
//! ```
//!
//! All images share one flat folder. The database's `attachments` table is the
//! only index that maps an id to its date and display position, so the file
//! name alone is enough on disk. Vaults created before this layout kept one
//! folder per date (`attachments/YYYY-MM-DD/<id>.bin`); reads still fall back to
//! that path, and the "Update old images" pass moves the files into the flat
//! folder.
//!
//! Each image is encrypted with an HKDF-derived attachment key and a fresh IV.
//! The display order and metadata live in SQLCipher; backups copy the sidecars
//! together with a database snapshot. `manifest.xml` is read only by the
//! one-time legacy migration and is never written by the current app.
//!
//! Legacy `manifest.xml` payload (migration only):
//!
//! ```xml
//! <manifest version="1" date="2026-10-23">
//!   <attachment id="..." mime="image/webp" width="1000" height="750"/>
//!   ...
//! </manifest>
//! ```
//!
//! In the legacy manifest, element order is the display order. There is no
//! separate `added-at` field: the order is the data, and a manifest that is lost
//! can only be rebuilt with an approximate order (file mtime/name).

use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::UNIX_EPOCH;

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use quick_xml::events::{BytesStart, Event};
use quick_xml::Reader;
use rand::RngCore;
use rayon::prelude::*;
use serde::Serialize;
use zeroize::Zeroizing;

use crate::crypto;
use crate::db;
use crate::fsutil;
use crate::image_ops;
use crate::pool::vault_pool;
use crate::storage;
use crate::xml::{self, EncryptedEntry};

/// Directory under the diary root that holds all attachments.
const ATTACHMENTS_DIR: &str = "attachments";
/// Manifest file inside a per-date attachment directory. Legacy migration only.
const MANIFEST_FILE: &str = "manifest.xml";
/// Magic bytes at the start of an encrypted attachment file.
const ATTACHMENT_MAGIC: &[u8; 4] = b"FDAT";
/// Current on-disk attachment envelope version.
///
/// Version 3 uses the HKDF-derived attachment key. Versions 1 and 2 remain
/// readable with the historical diary key; the file header tells the reader
/// which key to use.
const ATTACHMENT_VERSION: u8 = 3;
const ATTACHMENT_VERSION_V5: u8 = 2;
const ATTACHMENT_VERSION_LEGACY: u8 = 1;
/// Manifest schema version (inside the encrypted payload).
const MANIFEST_VERSION: u8 = 2;
const MANIFEST_VERSION_LEGACY: u8 = 1;
/// AAD label for the manifest. Must differ from index and entry labels.
const MANIFEST_AAD_LABEL: &[u8] = b"fly-diary/attachment-manifest";
/// AAD label for an image.
const ATTACHMENT_AAD_LABEL: &[u8] = b"fly-diary/attachment";

/// Largest compressed image accepted by the backend. `prepare_image` enforces
/// the same limit after resizing and re-encoding, so this is also a defence
/// against a buggy or malicious client.
pub const MAX_ATTACHMENT_BYTES: usize = 5 * 1024 * 1024;

/// Largest original file accepted from a native drag-drop path. Mirrors the
/// frontend's `MAX_INPUT_BYTES`; the backend resizes it before storing it.
pub const MAX_DROPPED_FILE_BYTES: u64 = 64 * 1024 * 1024;

/// Maximum number of files accepted in a single native drop.
pub const MAX_DROPPED_FILES: usize = 20;

/// Maximum combined bytes accepted in a single native drop.
pub const MAX_DROPPED_TOTAL_BYTES: u64 = 128 * 1024 * 1024;

/// Maximum number of images per day.
pub const MAX_ATTACHMENTS_PER_DAY: usize = 200;

/// An existing image is only replaced when the lossy WebP re-encode is at least
/// this much smaller. This avoids generation loss on images that are already
/// compressed well.
const RECOMPRESS_MIN_SAVING_PERCENT: u64 = 10;
/// Cap the failure list so a vault with many broken files cannot bloat the IPC
/// response. `RecompressReport::failed` still holds the full count.
const MAX_RECOMPRESS_FAILURES: usize = 20;

/// Largest manifest accepted before parsing. A manifest with 200 images is a
/// few kilobytes; this only guards against a corrupt or hand-crafted file.
const MAX_MANIFEST_BYTES: u64 = 1024 * 1024;

/// MIME used when a file exists but cannot be decrypted while rebuilding a
/// missing manifest. The frontend shows it as a broken image.
const UNKNOWN_MIME: &str = "application/octet-stream";

/// Serializes the read-modify-write cycle of a manifest. The image files
/// themselves can be written in parallel, but the ordered list cannot.
static ATTACHMENT_LOCK: Mutex<()> = Mutex::new(());

fn lock_attachments() -> std::sync::MutexGuard<'static, ()> {
    ATTACHMENT_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// A single image as exposed to the frontend.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentMeta {
    pub id: String,
    pub mime: String,
    pub width: u32,
    pub height: u32,
    pub size: u64,
    /// True when the manifest references an id whose file is missing.
    pub missing: bool,
}

/// A decrypted image returned to the frontend as base64.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentData {
    pub id: String,
    pub mime: String,
    pub data: String,
}

/// Summary of the one-off pass that shrinks attachments uploaded before the
/// Rust WebP pipeline existed.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RecompressReport {
    /// Attachment entries examined.
    pub scanned: usize,
    /// Legacy per-date files moved into the flat `attachments/` folder.
    pub moved: usize,
    /// Images replaced with a smaller WebP file.
    pub recompressed: usize,
    /// Images that were already small enough or could not be improved.
    pub skipped: usize,
    /// Images that could not be read, decrypted or decoded.
    pub failed: usize,
    /// On-disk size of the examined files before the pass.
    pub bytes_before: u64,
    /// On-disk size after the pass.
    pub bytes_after: u64,
    /// At most [`MAX_RECOMPRESS_FAILURES`] failure details.
    pub failures: Vec<RecompressFailure>,
}

/// One attachment that could not be recompressed.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RecompressFailure {
    pub date: String,
    pub id: String,
    pub reason: String,
}

/// A file read from a path reported by the OS drag-drop handler.
///
/// The frontend needs the original bytes (not a path) so the dropped image goes
/// through the same backend compression pipeline as one chosen with the file
/// picker. Base64 keeps the IPC boundary uniform with the other image commands.
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DroppedImage {
    pub name: String,
    pub data: String,
}

/// Read files the OS handed us as paths.
///
/// Native drag-drop reports filesystem paths instead of `File` objects. The
/// webview cannot read those paths itself, so the backend reads them here and
/// returns base64. Only regular files within the same size limit as the file
/// picker are accepted; the frontend still validates the image format.
pub fn read_dropped_images(paths: &[String]) -> Result<Vec<DroppedImage>, String> {
    if paths.len() > MAX_DROPPED_FILES {
        return Err(format!(
            "Too many files dropped (at most {MAX_DROPPED_FILES})"
        ));
    }

    let mut files = Vec::with_capacity(paths.len());
    let mut total = 0u64;
    for path in paths {
        let path = Path::new(path);
        let metadata =
            fs::metadata(path).map_err(|e| format!("Could not read {}: {e}", path.display()))?;
        if !metadata.is_file() {
            return Err(format!("{} is not a file", path.display()));
        }
        if metadata.len() > MAX_DROPPED_FILE_BYTES {
            return Err(format!(
                "{} is larger than {} MB",
                path.display(),
                MAX_DROPPED_FILE_BYTES / (1024 * 1024)
            ));
        }
        total = total.saturating_add(metadata.len());
        if total > MAX_DROPPED_TOTAL_BYTES {
            return Err(format!(
                "Dropped files are larger than {} MB in total",
                MAX_DROPPED_TOTAL_BYTES / (1024 * 1024)
            ));
        }
        files.push(path.to_path_buf());
    }

    let images: Vec<Result<DroppedImage, String>> = vault_pool().install(|| {
        files
            .par_iter()
            .map(|path| {
                let bytes = fsutil::read_limited(path, MAX_DROPPED_FILE_BYTES)
                    .map_err(|e| format!("Could not read {}: {e}", path.display()))?;
                // The command only advertises images. Validating the magic here
                // keeps a crafted path (or a malicious renderer) from turning it
                // into a general-purpose local file reader.
                sniff_mime(&bytes)?;
                let name = path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or("image")
                    .to_string();
                Ok(DroppedImage {
                    name,
                    data: B64.encode(bytes),
                })
            })
            .collect()
    });

    // `par_iter` over a slice preserves input order, so the drop order the user
    // sees is stable even though the reads finish out of order.
    images.into_iter().collect()
}

/// Unreferenced attachment storage.
///
/// `date` is empty for flat-layout files that no `attachments` row references.
/// Legacy per-date folders keep the date they are named after.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OrphanAttachment {
    pub date: String,
    pub file_count: u64,
    pub size: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ManifestItem {
    id: String,
    mime: String,
    width: u32,
    height: u32,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct Manifest {
    items: Vec<ManifestItem>,
}

// ---------------------------------------------------------------------------
// Paths and validation
// ---------------------------------------------------------------------------

fn attachments_root(dir: &Path) -> PathBuf {
    dir.join(ATTACHMENTS_DIR)
}

fn attachment_dir(dir: &Path, date: &str) -> Result<PathBuf, String> {
    storage::validate_date(date)?;
    Ok(attachments_root(dir).join(date))
}

fn manifest_path(dir: &Path, date: &str) -> Result<PathBuf, String> {
    Ok(attachment_dir(dir, date)?.join(MANIFEST_FILE))
}

/// Validate a generated attachment id.
///
/// The frontend never supplies a path, but every command that takes an id still
/// validates it so a crafted IPC call cannot escape the attachment directory.
pub fn validate_attachment_id(id: &str) -> Result<(), String> {
    if id.len() != 32
        || !id
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    {
        return Err(format!("Invalid attachment id: {id}"));
    }
    Ok(())
}

/// Path used by the current flat layout and by new writes.
fn flat_attachment_path(dir: &Path, id: &str) -> Result<PathBuf, String> {
    validate_attachment_id(id)?;
    Ok(attachments_root(dir).join(format!("{id}.bin")))
}

/// Path used before the flat layout was introduced.
fn legacy_attachment_path(dir: &Path, date: &str, id: &str) -> Result<PathBuf, String> {
    validate_attachment_id(id)?;
    Ok(attachment_dir(dir, date)?.join(format!("{id}.bin")))
}

/// Resolve an attachment on disk, preferring the flat layout.
///
/// New files are written flat by [`save_attachment`]. Older vaults can still
/// have the per-date file, so every read checks it as a fallback. When neither
/// exists the flat path is returned, which is where a new file should go.
fn attachment_path(dir: &Path, date: &str, id: &str) -> Result<PathBuf, String> {
    let flat = flat_attachment_path(dir, id)?;
    if flat.is_file() {
        return Ok(flat);
    }
    let legacy = legacy_attachment_path(dir, date, id)?;
    if legacy.is_file() {
        return Ok(legacy);
    }
    Ok(flat)
}

/// Move a legacy per-date sidecar into the flat folder.
///
/// Returns `true` when a file was moved. Moving does not touch the ciphertext or
/// its AAD (which still binds the date), so it does not need the diary key.
fn move_to_flat(dir: &Path, date: &str, id: &str) -> Result<bool, String> {
    let flat = flat_attachment_path(dir, id)?;
    if flat.is_file() {
        return Ok(false);
    }
    let legacy = legacy_attachment_path(dir, date, id)?;
    if !legacy.is_file() {
        return Ok(false);
    }
    fsutil::create_private_dir(&attachments_root(dir))
        .map_err(|e| format!("Failed to create attachment directory: {e}"))?;
    fs::rename(&legacy, &flat).map_err(|e| format!("Failed to move attachment {id}: {e}"))?;
    Ok(true)
}

/// Every on-disk sidecar, keyed by id.
///
/// The flat layout wins when both layouts contain the same id. Used by the
/// backup exporter so an archive is always flat, even if the vault has not run
/// the update pass yet.
pub fn all_attachment_files(dir: &Path) -> Result<Vec<(String, PathBuf)>, String> {
    let root = attachments_root(dir);
    let read_dir = match fs::read_dir(&root) {
        Ok(read_dir) => read_dir,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("Failed to read attachment root: {e}")),
    };

    let mut dirs = Vec::new();
    let mut files: BTreeMap<String, PathBuf> = BTreeMap::new();
    for item in read_dir {
        let item = item.map_err(|e| format!("Failed to read attachment root: {e}"))?;
        let path = item.path();
        if path.is_dir() {
            dirs.push(path);
            continue;
        }
        if !path.is_file() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        let Some(id) = name.strip_suffix(".bin") else {
            continue;
        };
        if validate_attachment_id(id).is_ok() {
            files.insert(id.to_string(), path);
        }
    }

    for date_dir in dirs {
        let Some(date) = date_dir.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        if storage::validate_date(date).is_err() {
            continue;
        }
        let entries = match fs::read_dir(&date_dir) {
            Ok(entries) => entries,
            Err(e) => return Err(format!("Failed to read attachments for {date}: {e}")),
        };
        for entry in entries {
            let entry = entry.map_err(|e| format!("Failed to read attachments for {date}: {e}"))?;
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
                continue;
            };
            let Some(id) = name.strip_suffix(".bin") else {
                continue;
            };
            if validate_attachment_id(id).is_ok() {
                files.entry(id.to_string()).or_insert(path);
            }
        }
    }

    Ok(files.into_iter().collect())
}

/// Remove an empty legacy date folder and its obsolete encrypted manifest.
///
/// The folder is only removed when no `.bin` files remain, so a file that could
/// not be moved is never lost. A leftover `manifest.xml` without sidecars is
/// dead data after the SQLCipher migration.
fn cleanup_legacy_date_dir(dir: &Path, date: &str) {
    let Ok(date_dir) = attachment_dir(dir, date) else {
        return;
    };
    if !date_dir.is_dir() {
        return;
    }
    let has_bin = fs::read_dir(&date_dir)
        .map(|entries| {
            entries
                .flatten()
                .any(|entry| entry.path().extension().and_then(|ext| ext.to_str()) == Some("bin"))
        })
        .unwrap_or(true);
    if has_bin {
        return;
    }
    let _ = fs::remove_file(date_dir.join(MANIFEST_FILE));
    let _ = fs::remove_dir(&date_dir);
}

fn new_attachment_id() -> String {
    let mut bytes = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut bytes);
    let mut id = String::with_capacity(32);
    for byte in bytes {
        id.push_str(&format!("{byte:02x}"));
    }
    id
}

fn manifest_aad(date: &str) -> Vec<u8> {
    let mut aad = Vec::with_capacity(MANIFEST_AAD_LABEL.len() + date.len() + 1);
    aad.extend_from_slice(MANIFEST_AAD_LABEL);
    aad.push(0x00);
    aad.extend_from_slice(date.as_bytes());
    aad
}

fn manifest_aad_v5(date: &str, version: u8, context: &xml::VaultContext) -> Vec<u8> {
    xml::manifest_aad_v5(date, version, context)
}

fn attachment_aad_v5(date: &str, id: &str, version: u8, context: &xml::VaultContext) -> Vec<u8> {
    xml::attachment_aad_v5(date, id, version, context)
}

fn attachment_aad(date: &str, id: &str, version: u8) -> Vec<u8> {
    let mut aad = Vec::with_capacity(ATTACHMENT_AAD_LABEL.len() + date.len() + id.len() + 4);
    aad.extend_from_slice(ATTACHMENT_AAD_LABEL);
    aad.push(0x00);
    aad.extend_from_slice(date.as_bytes());
    aad.push(0x00);
    aad.extend_from_slice(id.as_bytes());
    aad.push(0x00);
    aad.push(version);
    aad
}

fn validate_mime(mime: &str) -> Result<(), String> {
    match mime {
        "image/webp" | "image/jpeg" | "image/png" => Ok(()),
        _ => Err(format!("Unsupported image type: {mime}")),
    }
}

fn sniff_mime(bytes: &[u8]) -> Result<&'static str, String> {
    if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return Ok("image/webp");
    }
    if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        return Ok("image/jpeg");
    }
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Ok("image/png");
    }
    Err("Unsupported or malformed image data".to_string())
}

// ---------------------------------------------------------------------------
// Manifest XML
// ---------------------------------------------------------------------------

fn attr_value(e: &BytesStart<'_>, name: &str) -> Result<Option<String>, String> {
    for attr in e.attributes() {
        let attr = attr.map_err(|err| format!("Invalid manifest attribute: {err}"))?;
        if attr.key.as_ref() == name {
            return attr
                .normalized_value(quick_xml::XmlVersion::Explicit1_0)
                .map(|value| Some(value.into_owned()))
                .map_err(|err| format!("Invalid manifest attribute value: {err}"));
        }
    }
    Ok(None)
}

fn required_attr(e: &BytesStart<'_>, name: &str) -> Result<String, String> {
    attr_value(e, name)?.ok_or_else(|| format!("Manifest is missing the {name} attribute"))
}

fn pack_manifest(date: &str, manifest: &Manifest) -> Result<Zeroizing<Vec<u8>>, String> {
    use quick_xml::events::{BytesDecl, BytesEnd};
    use quick_xml::Writer;

    let mut writer = Writer::new_with_indent(Vec::new(), b' ', 2);
    writer
        .write_event(Event::Decl(BytesDecl::new("1.0", Some("UTF-8"), None)))
        .map_err(|e| format!("Failed to write manifest declaration: {e}"))?;

    let mut root = BytesStart::new("manifest");
    let version = MANIFEST_VERSION.to_string();
    root.push_attribute(("version", version.as_str()));
    root.push_attribute(("date", date));
    writer
        .write_event(Event::Start(root))
        .map_err(|e| format!("Failed to write <manifest>: {e}"))?;

    for item in &manifest.items {
        let mut attachment = BytesStart::new("attachment");
        attachment.push_attribute(("id", item.id.as_str()));
        attachment.push_attribute(("mime", item.mime.as_str()));
        let width = item.width.to_string();
        let height = item.height.to_string();
        attachment.push_attribute(("width", width.as_str()));
        attachment.push_attribute(("height", height.as_str()));
        writer
            .write_event(Event::Empty(attachment))
            .map_err(|e| format!("Failed to write <attachment>: {e}"))?;
    }

    writer
        .write_event(Event::End(BytesEnd::new("manifest")))
        .map_err(|e| format!("Failed to close <manifest>: {e}"))?;

    Ok(Zeroizing::new(writer.into_inner()))
}

fn unpack_manifest(plain: &[u8], expected_date: &str) -> Result<Manifest, String> {
    let text = std::str::from_utf8(plain).map_err(|e| format!("Manifest is not UTF-8: {e}"))?;
    let mut reader = Reader::from_str(text);
    reader.config_mut().trim_text(true);

    let mut root_seen = false;
    let mut version = None;
    let mut date = None;
    let mut items: Vec<ManifestItem> = Vec::new();

    loop {
        match reader.read_event() {
            Ok(Event::Start(e)) | Ok(Event::Empty(e)) => match e.name().as_ref() {
                "manifest" => {
                    if root_seen {
                        return Err("Manifest has more than one root".to_string());
                    }
                    root_seen = true;
                    version = Some(
                        required_attr(&e, "version")?
                            .parse::<u8>()
                            .map_err(|_| "Manifest version is not a number".to_string())?,
                    );
                    date = Some(required_attr(&e, "date")?);
                }
                "attachment" => {
                    if !root_seen {
                        return Err("Attachment appeared before <manifest>".to_string());
                    }
                    let id = required_attr(&e, "id")?;
                    validate_attachment_id(&id)?;
                    let mime = required_attr(&e, "mime")?;
                    if mime != UNKNOWN_MIME {
                        validate_mime(&mime)?;
                    }
                    let width = attr_value(&e, "width")?
                        .unwrap_or_else(|| "0".to_string())
                        .parse::<u32>()
                        .map_err(|_| "Invalid manifest width".to_string())?;
                    let height = attr_value(&e, "height")?
                        .unwrap_or_else(|| "0".to_string())
                        .parse::<u32>()
                        .map_err(|_| "Invalid manifest height".to_string())?;
                    if items.iter().any(|item| item.id == id) {
                        return Err(format!("Duplicate attachment id in manifest: {id}"));
                    }
                    items.push(ManifestItem {
                        id,
                        mime,
                        width,
                        height,
                    });
                }
                _ => {}
            },
            Ok(Event::Eof) => break,
            Ok(_) => {}
            Err(e) => return Err(format!("Malformed manifest XML: {e}")),
        }
    }

    if !root_seen {
        return Err("Manifest has no <manifest> root".to_string());
    }
    if version != Some(MANIFEST_VERSION) && version != Some(MANIFEST_VERSION_LEGACY) {
        return Err(format!(
            "Unsupported manifest version: {}",
            version.unwrap_or(0)
        ));
    }
    if date.as_deref() != Some(expected_date) {
        return Err("Manifest date does not match its folder".to_string());
    }

    Ok(Manifest { items })
}

fn manifest_to_rows(manifest: &Manifest) -> Vec<db::AttachmentRow> {
    manifest
        .items
        .iter()
        .enumerate()
        .map(|(position, item)| db::AttachmentRow {
            id: item.id.clone(),
            mime: item.mime.clone(),
            width: item.width,
            height: item.height,
            position: position as i64,
        })
        .collect()
}

fn rows_to_manifest(rows: &[db::AttachmentRow]) -> Manifest {
    Manifest {
        items: rows
            .iter()
            .map(|row| ManifestItem {
                id: row.id.clone(),
                mime: row.mime.clone(),
                width: row.width,
                height: row.height,
            })
            .collect(),
    }
}

/// Persist the ordered attachment metadata inside SQLCipher.
fn write_manifest(
    dir: &Path,
    key: &[u8; 32],
    date: &str,
    manifest: &Manifest,
) -> Result<(), String> {
    db::replace_attachment_manifest(dir, key, date, &manifest_to_rows(manifest))
}

/// Read the ordered attachment metadata from SQLCipher.
fn read_manifest(dir: &Path, key: &[u8; 32], date: &str) -> Result<Option<Manifest>, String> {
    let rows = db::read_attachment_manifest(dir, key, date)?;
    if rows.is_empty() {
        Ok(None)
    } else {
        Ok(Some(rows_to_manifest(&rows)))
    }
}

/// Read a legacy encrypted XML manifest. Only used by the one-time SQLCipher
/// migration; the application never writes this file.
fn read_manifest_mirror(
    dir: &Path,
    key: &[u8; 32],
    date: &str,
) -> Result<Option<Manifest>, String> {
    let path = manifest_path(dir, date)?;
    let text = match fsutil::read_string_limited(&path, MAX_MANIFEST_BYTES) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("Failed to read attachment manifest: {e}")),
    };

    let encrypted = xml::from_xml(&text)?;
    if encrypted.version != xml::CURRENT_VERSION && encrypted.version != 4 {
        return Err("Unsupported attachment manifest envelope version".to_string());
    }
    if encrypted.date != date {
        return Err("Attachment manifest date does not match its folder".to_string());
    }

    let context = storage::vault_context(dir)?;
    let aad = if encrypted.uses_context_aad() {
        let context = context
            .as_ref()
            .ok_or_else(|| "Attachment manifest is missing its vault context".to_string())?;
        manifest_aad_v5(date, MANIFEST_VERSION, context)
    } else {
        manifest_aad(date)
    };
    let iv = crypto::b64_decode(&encrypted.iv)?;
    let ciphertext = crypto::b64_decode(&encrypted.payload)?;
    let plain = crypto::decrypt_with_aad(key, &aad, &iv, &ciphertext)?;
    unpack_manifest(&plain, date).map(Some)
}

// ---------------------------------------------------------------------------
// Attachment files
// ---------------------------------------------------------------------------

fn encrypt_attachment(
    key: &[u8; 32],
    date: &str,
    id: &str,
    data: &[u8],
    context: Option<&xml::VaultContext>,
) -> Result<Vec<u8>, String> {
    let (aad, version, encryption_key) = match context {
        Some(context) => (
            attachment_aad_v5(date, id, ATTACHMENT_VERSION, context),
            ATTACHMENT_VERSION,
            db::derive_attachment_key(key),
        ),
        None => (
            attachment_aad(date, id, ATTACHMENT_VERSION_LEGACY),
            ATTACHMENT_VERSION_LEGACY,
            Zeroizing::new(*key),
        ),
    };
    let (iv, ciphertext) = crypto::encrypt_with_aad(&encryption_key, &aad, data)?;
    let mut out =
        Vec::with_capacity(ATTACHMENT_MAGIC.len() + 1 + crypto::IV_LEN + ciphertext.len());
    out.extend_from_slice(ATTACHMENT_MAGIC);
    out.push(version);
    out.extend_from_slice(&iv);
    out.extend_from_slice(&ciphertext);
    Ok(out)
}

fn decrypt_attachment(
    key: &[u8; 32],
    date: &str,
    id: &str,
    bytes: &[u8],
    context: Option<&xml::VaultContext>,
) -> Result<Zeroizing<Vec<u8>>, String> {
    let header_len = ATTACHMENT_MAGIC.len() + 1 + crypto::IV_LEN;
    if bytes.len() < header_len {
        return Err("Attachment file is truncated".to_string());
    }
    if &bytes[..ATTACHMENT_MAGIC.len()] != ATTACHMENT_MAGIC {
        return Err("Attachment file has an unknown header".to_string());
    }
    let version = bytes[ATTACHMENT_MAGIC.len()];
    if version != ATTACHMENT_VERSION
        && version != ATTACHMENT_VERSION_V5
        && version != ATTACHMENT_VERSION_LEGACY
    {
        return Err(format!("Unsupported attachment version: {version}"));
    }
    let iv_start = ATTACHMENT_MAGIC.len() + 1;
    let iv = &bytes[iv_start..iv_start + crypto::IV_LEN];
    let ciphertext = &bytes[header_len..];

    if version >= ATTACHMENT_VERSION_V5 {
        let context =
            context.ok_or_else(|| "Attachment is missing its vault context".to_string())?;
        let aad = attachment_aad_v5(date, id, version, context);
        let encryption_key = if version >= ATTACHMENT_VERSION {
            db::derive_attachment_key(key)
        } else {
            Zeroizing::new(*key)
        };
        crypto::decrypt_with_aad(&encryption_key, &aad, iv, ciphertext)
    } else {
        let aad = attachment_aad(date, id, version);
        crypto::decrypt_with_aad(key, &aad, iv, ciphertext)
    }
}

fn read_attachment_bytes(
    dir: &Path,
    key: &[u8; 32],
    date: &str,
    id: &str,
) -> Result<Zeroizing<Vec<u8>>, String> {
    let path = attachment_path(dir, date, id)?;
    let max_encrypted = MAX_ATTACHMENT_BYTES as u64 + 1024;
    let bytes = fsutil::read_limited(&path, max_encrypted)
        .map_err(|e| format!("Failed to read attachment {id}: {e}"))?;
    let context = storage::vault_context(dir)?;
    decrypt_attachment(key, date, id, &bytes, context.as_ref())
}

fn read_attachment_mime(dir: &Path, key: &[u8; 32], date: &str, id: &str) -> String {
    match read_attachment_bytes(dir, key, date, id)
        .and_then(|bytes| sniff_mime(&bytes).map(|mime| mime.to_string()))
    {
        Ok(mime) => mime,
        Err(_) => UNKNOWN_MIME.to_string(),
    }
}

/// One `*.bin` file in a date directory.
struct AttachmentFile {
    id: String,
    modified: u128,
}

fn scan_attachment_files(dir: &Path, date: &str) -> Result<Vec<AttachmentFile>, String> {
    let attachment_dir = attachment_dir(dir, date)?;
    let read_dir = match fs::read_dir(&attachment_dir) {
        Ok(read_dir) => read_dir,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("Failed to read attachment directory: {e}")),
    };

    let mut files = Vec::new();
    for item in read_dir {
        let item = item.map_err(|e| format!("Failed to read attachment entry: {e}"))?;
        let path = item.path();
        if path.extension().and_then(|s| s.to_str()) != Some("bin") {
            continue;
        }
        let Some(id) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        if validate_attachment_id(id).is_err() {
            continue;
        }
        let metadata = item
            .metadata()
            .map_err(|e| format!("Failed to inspect attachment {id}: {e}"))?;
        let modified = metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        files.push(AttachmentFile {
            id: id.to_string(),
            modified,
        });
    }

    files.sort_by(|a, b| a.modified.cmp(&b.modified).then_with(|| a.id.cmp(&b.id)));
    Ok(files)
}

/// Load a manifest from SQLCipher, repairing it from legacy per-date files when
/// it is missing or does not mention one of them.
///
/// Flat `attachments/<id>.bin` files cannot be repaired this way: the file name
/// no longer carries the date, so the database is the only index for them.
fn ensure_manifest(dir: &Path, key: &[u8; 32], date: &str) -> Result<Manifest, String> {
    let attachment_dir = attachment_dir(dir, date)?;
    let exists = attachment_dir.is_dir();

    let mut manifest = read_manifest(dir, key, date)?.unwrap_or_default();
    let mut changed = false;

    if !exists {
        // No files means every referenced image is missing; do not create a new
        // directory just to describe that.
        return Ok(manifest);
    }

    let files = scan_attachment_files(dir, date)?;
    let mut known: HashSet<String> = manifest.items.iter().map(|item| item.id.clone()).collect();
    for file in &files {
        if known.contains(&file.id) {
            continue;
        }
        manifest.items.push(ManifestItem {
            id: file.id.clone(),
            mime: read_attachment_mime(dir, key, date, &file.id),
            width: 0,
            height: 0,
        });
        known.insert(file.id.clone());
        changed = true;
    }

    if changed {
        write_manifest(dir, key, date, &manifest)?;
    }
    Ok(manifest)
}

fn meta_for(dir: &Path, date: &str, item: &ManifestItem) -> AttachmentMeta {
    let path = attachment_path(dir, date, &item.id).ok();
    let (size, missing) = match path.and_then(|path| fs::metadata(path).ok()) {
        Some(metadata) => (metadata.len(), false),
        None => (0, true),
    };
    AttachmentMeta {
        id: item.id.clone(),
        mime: item.mime.clone(),
        width: item.width,
        height: item.height,
        size,
        missing,
    }
}

// ---------------------------------------------------------------------------
// Public operations
// ---------------------------------------------------------------------------

/// List the images for a date in display order.
pub fn list_attachments(
    dir: &Path,
    key: &[u8; 32],
    date: &str,
) -> Result<Vec<AttachmentMeta>, String> {
    storage::validate_date(date)?;
    let _guard = lock_attachments();
    let manifest = ensure_manifest(dir, key, date)?;
    Ok(manifest
        .items
        .iter()
        .map(|item| meta_for(dir, date, item))
        .collect())
}

/// Save a new image at the end of the list.
pub fn save_attachment(
    dir: &Path,
    key: &[u8; 32],
    date: &str,
    mime: &str,
    data: &[u8],
    width: u32,
    height: u32,
) -> Result<AttachmentMeta, String> {
    storage::validate_date(date)?;
    validate_mime(mime)?;
    if data.is_empty() {
        return Err("Attachment is empty".to_string());
    }
    if width > 100_000 || height > 100_000 {
        return Err("Attachment dimensions are too large".to_string());
    }
    if data.len() > MAX_ATTACHMENT_BYTES {
        return Err(format!(
            "Attachment is too large ({} bytes, maximum {})",
            data.len(),
            MAX_ATTACHMENT_BYTES
        ));
    }
    let detected = sniff_mime(data)?;
    if detected != mime {
        return Err(format!(
            "Attachment MIME mismatch: declared {mime}, data is {detected}"
        ));
    }

    storage::ensure_dir(dir)?;
    fsutil::create_private_dir(&attachments_root(dir))
        .map_err(|e| format!("Failed to create attachment directory: {e}"))?;

    // A day with images but no entry would be invisible in the sidebar, and the
    // attachment would look orphaned. Create the empty entry first.
    if db::read_entry(dir, key, date)?.is_none() {
        db::write_entry(dir, key, date, "", "")?;
    }

    let _guard = lock_attachments();
    let mut manifest = ensure_manifest(dir, key, date)?;
    if manifest.items.len() >= MAX_ATTACHMENTS_PER_DAY {
        return Err(format!(
            "This day already has the maximum of {MAX_ATTACHMENTS_PER_DAY} images"
        ));
    }

    let mut path = None;
    let mut id = String::new();
    for _ in 0..16 {
        let candidate = new_attachment_id();
        let candidate_path = attachment_path(dir, date, &candidate)?;
        if candidate_path.exists() || manifest.items.iter().any(|item| item.id == candidate) {
            continue;
        }
        id = candidate;
        path = Some(candidate_path);
        break;
    }
    let Some(path) = path else {
        return Err("Could not allocate a unique attachment id".to_string());
    };

    let context = storage::vault_context(dir)?;
    let encrypted = encrypt_attachment(key, date, &id, data, context.as_ref())?;
    fsutil::write_private(&path, encrypted)
        .map_err(|e| format!("Failed to write attachment {id}: {e}"))?;

    let item = ManifestItem {
        id: id.clone(),
        mime: mime.to_string(),
        width,
        height,
    };
    manifest.items.push(item.clone());
    if let Err(err) = write_manifest(dir, key, date, &manifest) {
        // The image file is now unreferenced; remove it instead of leaving a
        // garbage file behind. A crash can still leave a flat orphan, which the
        // orphan cleanup can find.
        let _ = fs::remove_file(&path);
        return Err(err);
    }

    Ok(meta_for(dir, date, &item))
}

/// Decrypt one image and return it as base64 for an `<img>` data URL.
pub fn read_attachment(
    dir: &Path,
    key: &[u8; 32],
    date: &str,
    id: &str,
) -> Result<AttachmentData, String> {
    validate_attachment_id(id)?;
    let plain = read_attachment_bytes(dir, key, date, id)?;
    let mime = sniff_mime(&plain)?.to_string();
    Ok(AttachmentData {
        id: id.to_string(),
        mime,
        data: crypto::b64_encode(&plain),
    })
}

/// Delete one image.
///
/// The file is removed first, then the manifest entry. If the process dies in
/// between, the manifest references a missing file and the gallery shows a
/// placeholder; retrying the delete removes the stale reference. The reverse
/// order would let an unreferenced legacy file be "recovered" by the next
/// `ensure_manifest` call, resurrecting an image the user asked to delete.
pub fn delete_attachment(dir: &Path, key: &[u8; 32], date: &str, id: &str) -> Result<(), String> {
    storage::validate_date(date)?;
    validate_attachment_id(id)?;

    let _guard = lock_attachments();
    let mut manifest = ensure_manifest(dir, key, date)?;
    if !manifest.items.iter().any(|item| item.id == id) {
        return Err(format!("Attachment {id} does not exist"));
    }

    // Remove both layouts in case a crash left a duplicate behind.
    let paths = [
        flat_attachment_path(dir, id)?,
        legacy_attachment_path(dir, date, id)?,
    ];
    for path in paths {
        match fs::remove_file(&path) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(format!("Failed to delete attachment {id}: {e}")),
        }
    }

    manifest.items.retain(|item| item.id != id);
    write_manifest(dir, key, date, &manifest)?;
    let _ = fsutil::sync_dir(&attachments_root(dir));
    cleanup_legacy_date_dir(dir, date);
    Ok(())
}

/// Remove the on-disk sidecars for the ids that belonged to a date.
///
/// The database rows are deleted first by the caller; file cleanup is therefore
/// best effort. Both the flat and the legacy per-date paths are checked so an
/// entry deleted before the layout update cannot leave its image behind.
pub fn delete_attachment_files(dir: &Path, date: &str, ids: &[String]) -> Result<(), String> {
    let _guard = lock_attachments();
    for id in ids {
        if validate_attachment_id(id).is_err() {
            continue;
        }
        let paths = [
            flat_attachment_path(dir, id),
            legacy_attachment_path(dir, date, id),
        ];
        for path in paths.into_iter().flatten() {
            match fs::remove_file(&path) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(format!("Failed to delete attachment {id}: {e}")),
            }
        }
    }
    let _ = fsutil::sync_dir(&attachments_root(dir));
    cleanup_legacy_date_dir(dir, date);
    Ok(())
}

/// Replace the display order. Every current id must appear exactly once.
pub fn reorder_attachments(
    dir: &Path,
    key: &[u8; 32],
    date: &str,
    ids: &[String],
) -> Result<(), String> {
    storage::validate_date(date)?;
    for id in ids {
        validate_attachment_id(id)?;
    }

    let _guard = lock_attachments();
    let mut manifest = ensure_manifest(dir, key, date)?;
    if ids.len() != manifest.items.len() {
        return Err("Reorder list does not match the current attachments".to_string());
    }
    let mut seen = HashSet::with_capacity(ids.len());
    let mut reordered = Vec::with_capacity(ids.len());
    for id in ids {
        if !seen.insert(id.clone()) {
            return Err("Reorder list contains a duplicate id".to_string());
        }
        let Some(item) = manifest.items.iter().find(|item| &item.id == id) else {
            return Err(format!("Unknown attachment id: {id}"));
        };
        reordered.push(item.clone());
    }
    manifest.items = reordered;
    write_manifest(dir, key, date, &manifest)
}

/// Dates that may contain attachments, oldest first.
///
/// The database is authoritative, but legacy per-date folders are included too
/// so a vault that still has them can be repaired, flattened and recompressed in
/// one pass.
fn attachment_dates(dir: &Path, key: &[u8; 32]) -> Result<Vec<String>, String> {
    let mut dates: HashSet<String> = db::attachment_dates(dir, key)?.into_iter().collect();

    let root = attachments_root(dir);
    match fs::read_dir(&root) {
        Ok(read_dir) => {
            for item in read_dir {
                let item = item.map_err(|e| format!("Failed to read attachment root: {e}"))?;
                let path = item.path();
                if !path.is_dir() {
                    continue;
                }
                let Some(date) = path.file_name().and_then(|s| s.to_str()) else {
                    continue;
                };
                if storage::validate_date(date).is_ok() {
                    dates.insert(date.to_string());
                }
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("Failed to read attachment root: {e}")),
    }

    let mut dates: Vec<String> = dates.into_iter().collect();
    dates.sort();
    Ok(dates)
}

/// True for a static lossy WebP. Lossy files are already the target format, so
/// re-encoding them would only add generation loss. A lossless WebP contains a
/// `VP8L` chunk and is still worth converting.
fn is_lossy_webp(bytes: &[u8]) -> bool {
    bytes.len() >= 12
        && &bytes[0..4] == b"RIFF"
        && &bytes[8..12] == b"WEBP"
        && !bytes.windows(4).any(|window| window == b"VP8L")
}

/// Only replace a file when the re-encode saves a meaningful amount of space.
fn worth_recompressing(old_len: usize, new_len: usize) -> bool {
    if old_len == 0 || new_len == 0 {
        return false;
    }
    let old = old_len as u64;
    let new = new_len as u64;
    new.saturating_mul(100) < old.saturating_mul(100 - RECOMPRESS_MIN_SAVING_PERCENT)
}

fn file_len(path: &Path) -> u64 {
    fs::metadata(path).map(|meta| meta.len()).unwrap_or(0)
}

fn push_recompress_failure(report: &mut RecompressReport, date: &str, id: &str, reason: String) {
    if report.failures.len() < MAX_RECOMPRESS_FAILURES {
        report.failures.push(RecompressFailure {
            date: date.to_string(),
            id: id.to_string(),
            reason,
        });
    }
}

/// Re-encode every existing attachment as lossy WebP and move legacy sidecars
/// into the flat `attachments/` folder.
///
/// Attachments uploaded before the Rust pipeline could be multi-megabyte PNGs
/// because WebKitGTK/WKWebView could not encode WebP. This pass decrypts each
/// file, runs it through the same decode/resize/encode path as a new upload,
/// and only replaces the file when the result is at least
/// [`RECOMPRESS_MIN_SAVING_PERCENT`] smaller. Lossy WebP files and images that
/// are already small are left byte-for-byte untouched, so they do not suffer a
/// re-encode generation loss; they are still moved into the flat folder.
///
/// The manifest row is rewritten after the new ciphertext is on disk. If the
/// manifest write fails, the old ciphertext is restored so the database never
/// points at bytes that are no longer there.
pub fn recompress_attachments(dir: &Path, key: &[u8; 32]) -> Result<RecompressReport, String> {
    recompress_attachments_with_progress(dir, key, |_, _| {})
}

/// [`recompress_attachments`] with a `(done, total)` progress callback.
pub fn recompress_attachments_with_progress<F>(
    dir: &Path,
    key: &[u8; 32],
    mut progress: F,
) -> Result<RecompressReport, String>
where
    F: FnMut(usize, usize),
{
    let dates = attachment_dates(dir, key)?;
    let context = storage::vault_context(dir)?;
    let _guard = lock_attachments();

    let mut report = RecompressReport {
        scanned: 0,
        moved: 0,
        recompressed: 0,
        skipped: 0,
        failed: 0,
        bytes_before: 0,
        bytes_after: 0,
        failures: Vec::new(),
    };

    // Build the work list first so the frontend can show a meaningful total.
    let mut manifests: Vec<(String, Manifest)> = Vec::new();
    let mut total = 0usize;
    for date in dates {
        match ensure_manifest(dir, key, &date) {
            Ok(manifest) => {
                if !manifest.items.is_empty() {
                    total += manifest.items.len();
                    manifests.push((date, manifest));
                }
            }
            Err(err) => {
                report.failed += 1;
                push_recompress_failure(&mut report, &date, "", err);
            }
        }
    }

    let mut done = 0usize;
    progress(done, total);

    for (date, mut manifest) in manifests {
        for index in 0..manifest.items.len() {
            let id = manifest.items[index].id.clone();
            report.scanned += 1;

            // A labelled block keeps the "advance the progress bar exactly once"
            // rule in one place even though every step can fail.
            'item: {
                match move_to_flat(dir, &date, &id) {
                    Ok(true) => report.moved += 1,
                    Ok(false) => {}
                    Err(err) => {
                        report.failed += 1;
                        push_recompress_failure(&mut report, &date, &id, err);
                        break 'item;
                    }
                }

                let path = match attachment_path(dir, &date, &id) {
                    Ok(path) => path,
                    Err(err) => {
                        report.failed += 1;
                        push_recompress_failure(&mut report, &date, &id, err);
                        break 'item;
                    }
                };
                let encrypted =
                    match fsutil::read_limited(&path, MAX_ATTACHMENT_BYTES as u64 + 1024) {
                        Ok(bytes) => bytes,
                        Err(err) => {
                            report.failed += 1;
                            push_recompress_failure(
                                &mut report,
                                &date,
                                &id,
                                format!("Failed to read attachment: {err}"),
                            );
                            break 'item;
                        }
                    };

                let old_size = encrypted.len() as u64;
                report.bytes_before += old_size;

                let plain = match decrypt_attachment(key, &date, &id, &encrypted, context.as_ref())
                {
                    Ok(plain) => plain,
                    Err(err) => {
                        report.failed += 1;
                        report.bytes_after += old_size;
                        push_recompress_failure(&mut report, &date, &id, err);
                        break 'item;
                    }
                };

                if is_lossy_webp(&plain) {
                    report.skipped += 1;
                    report.bytes_after += old_size;
                    break 'item;
                }

                let prepared = match image_ops::prepare_image_bytes(&plain) {
                    Ok(prepared) => prepared,
                    Err(err) => {
                        report.failed += 1;
                        report.bytes_after += old_size;
                        push_recompress_failure(&mut report, &date, &id, err);
                        break 'item;
                    }
                };

                if !worth_recompressing(plain.len(), prepared.data.len()) {
                    report.skipped += 1;
                    report.bytes_after += old_size;
                    break 'item;
                }

                let new_encrypted =
                    match encrypt_attachment(key, &date, &id, &prepared.data, context.as_ref()) {
                        Ok(bytes) => bytes,
                        Err(err) => {
                            report.failed += 1;
                            report.bytes_after += old_size;
                            push_recompress_failure(&mut report, &date, &id, err);
                            break 'item;
                        }
                    };
                let new_size = new_encrypted.len() as u64;

                if let Err(err) = fsutil::write_private(&path, &new_encrypted) {
                    report.failed += 1;
                    report.bytes_after += old_size;
                    push_recompress_failure(
                        &mut report,
                        &date,
                        &id,
                        format!("Failed to write attachment: {err}"),
                    );
                    break 'item;
                }

                let previous = manifest.items[index].clone();
                manifest.items[index].mime = prepared.mime;
                manifest.items[index].width = prepared.width;
                manifest.items[index].height = prepared.height;

                if let Err(err) = write_manifest(dir, key, &date, &manifest) {
                    // Put the original ciphertext back before reporting, so the
                    // old manifest metadata stays truthful.
                    let restored = fsutil::write_private(&path, &encrypted);
                    manifest.items[index] = previous;
                    report.failed += 1;
                    report.bytes_after += if restored.is_ok() {
                        old_size
                    } else {
                        file_len(&path)
                    };
                    push_recompress_failure(
                        &mut report,
                        &date,
                        &id,
                        format!("Failed to update attachment manifest: {err}"),
                    );
                    break 'item;
                }

                report.recompressed += 1;
                report.bytes_after += new_size;
            }

            done += 1;
            progress(done, total);
        }
        cleanup_legacy_date_dir(dir, &date);
    }

    Ok(report)
}

/// Remove the whole attachment directory for a date.
///
/// Called by `storage::delete_entry` after the entry file is gone. Failures are
/// intentionally non-fatal there: the entry is already deleted, and a leftover
/// directory is an orphan that the cleanup path can find later.
pub fn delete_all_for_date(dir: &Path, date: &str) -> Result<(), String> {
    storage::validate_date(date)?;
    let date_dir = attachment_dir(dir, date)?;
    let _guard = lock_attachments();
    match fs::remove_dir_all(&date_dir) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(format!("Failed to delete attachments for {date}: {e}")),
    }
    let root = attachments_root(dir);
    if root.is_dir() {
        let _ = fsutil::sync_dir(&root);
    }
    Ok(())
}

/// Find attachment storage that the database does not reference.
///
/// This covers two cases:
/// - legacy per-date folders whose date has no `entries` row;
/// - flat `attachments/<id>.bin` files whose id is in no `attachments` row.
///
/// The flat files are returned as one aggregate entry with an empty `date`,
/// because the file name no longer carries the date.
pub fn list_orphan_attachments(
    dir: &Path,
    key: &[u8; 32],
) -> Result<Vec<OrphanAttachment>, String> {
    let root = attachments_root(dir);
    let read_dir = match fs::read_dir(&root) {
        Ok(read_dir) => read_dir,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("Failed to read attachment root: {e}")),
    };

    let entries = db::entry_dates(dir, key)?;
    let referenced = db::attachment_ids(dir, key)?;
    let mut dirs = Vec::new();
    let mut flat_count = 0u64;
    let mut flat_size = 0u64;
    for item in read_dir {
        let item = item.map_err(|e| format!("Failed to read attachment root: {e}"))?;
        let path = item.path();
        if path.is_dir() {
            let Some(date) = path.file_name().and_then(|s| s.to_str()) else {
                continue;
            };
            if storage::validate_date(date).is_ok() && !entries.contains(date) {
                dirs.push((date.to_string(), path));
            }
            continue;
        }
        if path.extension().and_then(|ext| ext.to_str()) != Some("bin") {
            continue;
        }
        let Some(id) = path.file_stem().and_then(|stem| stem.to_str()) else {
            continue;
        };
        if validate_attachment_id(id).is_err() || referenced.contains(id) {
            continue;
        }
        if let Ok(metadata) = item.metadata() {
            flat_count += 1;
            flat_size += metadata.len();
        }
    }

    let mut orphans: Vec<OrphanAttachment> = vault_pool().install(|| {
        dirs.par_iter()
            .map(|(date, path)| {
                let mut file_count = 0u64;
                let mut size = 0u64;
                if let Ok(entries) = fs::read_dir(path) {
                    for entry in entries.flatten() {
                        if let Ok(metadata) = entry.metadata() {
                            if metadata.is_file() {
                                file_count += 1;
                                size += metadata.len();
                            }
                        }
                    }
                }
                OrphanAttachment {
                    date: date.clone(),
                    file_count,
                    size,
                }
            })
            .collect()
    });
    if flat_count > 0 {
        orphans.push(OrphanAttachment {
            date: String::new(),
            file_count: flat_count,
            size: flat_size,
        });
    }
    orphans.sort_by(|a, b| b.date.cmp(&a.date));
    Ok(orphans)
}

/// Delete unreferenced attachment storage.
///
/// An empty `date` deletes every flat `.bin` file that no `attachments` row
/// references. A real date keeps the legacy behaviour: the per-date folder must
/// no longer have an entry, and its rows and files are removed.
pub fn delete_orphan_attachments(dir: &Path, key: &[u8; 32], date: &str) -> Result<(), String> {
    if date.is_empty() {
        let _guard = lock_attachments();
        let referenced = db::attachment_ids(dir, key)?;
        let root = attachments_root(dir);
        let read_dir = match fs::read_dir(&root) {
            Ok(read_dir) => read_dir,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(e) => return Err(format!("Failed to read attachment root: {e}")),
        };
        for item in read_dir {
            let item = item.map_err(|e| format!("Failed to read attachment root: {e}"))?;
            let path = item.path();
            if !path.is_file() || path.extension().and_then(|ext| ext.to_str()) != Some("bin") {
                continue;
            }
            let Some(id) = path.file_stem().and_then(|stem| stem.to_str()) else {
                continue;
            };
            if validate_attachment_id(id).is_err() || referenced.contains(id) {
                continue;
            }
            match fs::remove_file(&path) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => {
                    return Err(format!("Failed to delete orphan attachment {id}: {e}"));
                }
            }
        }
        let _ = fsutil::sync_dir(&root);
        return Ok(());
    }

    storage::validate_date(date)?;
    if db::entry_dates(dir, key)?.contains(date) {
        return Err(format!("Entry {date} still exists"));
    }
    let ids: Vec<String> = db::read_attachment_manifest(dir, key, date)
        .unwrap_or_default()
        .into_iter()
        .map(|row| row.id)
        .collect();
    let _ = db::delete_attachment_rows(dir, key, date, None);
    let _ = delete_attachment_files(dir, date, &ids);
    delete_all_for_date(dir, date)
}

/// Write the legacy encrypted XML manifest.
///
/// The application never writes XML manifests; this is kept for migration
/// compatibility tests that simulate an existing installation.
#[doc(hidden)]
pub fn write_legacy_manifest(
    dir: &Path,
    key: &[u8; 32],
    date: &str,
    items: &[(String, String, u32, u32)],
) -> Result<(), String> {
    let manifest = Manifest {
        items: items
            .iter()
            .map(|(id, mime, width, height)| ManifestItem {
                id: id.clone(),
                mime: mime.clone(),
                width: *width,
                height: *height,
            })
            .collect(),
    };
    let attachment_dir = attachment_dir(dir, date)?;
    fsutil::create_private_dir(&attachment_dir)
        .map_err(|e| format!("Failed to create attachment directory: {e}"))?;
    let plain = pack_manifest(date, &manifest)?;
    let context = storage::vault_context(dir)?;
    let (aad, envelope_version) = match context.as_ref() {
        Some(context) => (
            manifest_aad_v5(date, MANIFEST_VERSION, context),
            xml::CURRENT_VERSION,
        ),
        None => (manifest_aad(date), 4),
    };
    let (iv, ciphertext) = crypto::encrypt_with_aad(key, &aad, &plain)?;
    let mut envelope = EncryptedEntry::new(
        date,
        crypto::b64_encode(&iv),
        crypto::b64_encode(&ciphertext),
    );
    envelope.version = envelope_version;
    let document = xml::to_xml(&envelope)?;
    fsutil::write_private(&manifest_path(dir, date)?, document)
        .map_err(|e| format!("Failed to write legacy attachment manifest: {e}"))
}

/// Read a legacy manifest for migration, falling back to the image files.
///
/// Used by the SQLCipher migration before the database exists.
pub(crate) fn legacy_manifest_items(
    dir: &Path,
    key: &[u8; 32],
    date: &str,
) -> Result<Vec<(String, String, u32, u32)>, String> {
    if let Ok(Some(manifest)) = read_manifest_mirror(dir, key, date) {
        return Ok(manifest
            .items
            .into_iter()
            .map(|item| (item.id, item.mime, item.width, item.height))
            .collect());
    }
    let files = scan_attachment_files(dir, date)?;
    Ok(files
        .into_iter()
        .map(|file| {
            let mime = read_attachment_mime(dir, key, date, &file.id);
            (file.id, mime, 0, 0)
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    const WEBP: &[u8] = b"RIFF\x24\x00\x00\x00WEBPVP8 fake";
    const JPEG: &[u8] = b"\xff\xd8\xff\xe0fake-jpeg";
    const PNG: &[u8] = b"\x89PNG\r\n\x1a\nfake-png";

    fn temp_dir(name: &str) -> PathBuf {
        let mut path = std::env::temp_dir();
        path.push(format!(
            "fly-diary-att-{}-{}-{}",
            name,
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).unwrap();
        path
    }

    fn save(
        dir: &Path,
        key: &[u8; 32],
        date: &str,
        mime: &str,
        data: &[u8],
    ) -> Result<AttachmentMeta, String> {
        super::save_attachment(dir, key, date, mime, data, 1000, 500)
    }

    fn png_image(width: u32, height: u32) -> Vec<u8> {
        use image::{ImageBuffer, ImageFormat, Rgba};

        let image = ImageBuffer::from_fn(width, height, |x, y| {
            // Noise makes the PNG large, which is what the recompression pass
            // is meant to fix.
            let seed = x
                .wrapping_mul(2_654_435_761)
                .wrapping_add(y.wrapping_mul(40_503));
            Rgba([
                seed as u8,
                seed.wrapping_add(37) as u8,
                seed.wrapping_mul(3) as u8,
                255,
            ])
        });
        let mut out = std::io::Cursor::new(Vec::new());
        image.write_to(&mut out, ImageFormat::Png).unwrap();
        out.into_inner()
    }

    fn attachment_file(dir: &Path, _date: &str, id: &str) -> PathBuf {
        flat_attachment_path(dir, id).unwrap()
    }

    fn legacy_attachment_file(dir: &Path, date: &str, id: &str) -> PathBuf {
        legacy_attachment_path(dir, date, id).unwrap()
    }

    fn key(dir: &Path) -> [u8; 32] {
        *storage::create_vault(
            dir,
            "passphrase",
            crypto::KdfParams {
                memory_kib: crypto::KdfParams::MIN_MEMORY_KIB,
                iterations: crypto::KdfParams::MIN_ITERATIONS,
                parallelism: crypto::KdfParams::MIN_PARALLELISM,
            },
        )
        .unwrap()
    }

    #[test]
    fn dropped_files_are_read_as_base64() {
        let dir = temp_dir("dropped-file");
        let path = dir.join("photo.png");
        fs::write(&path, PNG).unwrap();

        let images = read_dropped_images(&[path.to_string_lossy().to_string()]).unwrap();

        assert_eq!(images.len(), 1);
        assert_eq!(images[0].name, "photo.png");
        assert_eq!(B64.decode(&images[0].data).unwrap(), PNG);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn dropped_files_keep_the_order_they_were_dropped_in() {
        let dir = temp_dir("dropped-order");
        let names = ["first.png", "second.png", "third.png"];
        let paths: Vec<String> = names
            .iter()
            .map(|name| {
                let path = dir.join(name);
                fs::write(&path, PNG).unwrap();
                path.to_string_lossy().to_string()
            })
            .collect();

        let images = read_dropped_images(&paths).unwrap();

        let actual: Vec<_> = images.iter().map(|image| image.name.as_str()).collect();
        assert_eq!(actual, names.to_vec());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn dropped_directories_are_rejected() {
        let dir = temp_dir("dropped-dir");

        let error = read_dropped_images(&[dir.to_string_lossy().to_string()]).unwrap_err();

        assert!(error.contains("is not a file"), "{error}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn dropping_too_many_files_is_rejected_before_reading_them() {
        let paths = vec!["/nonexistent".to_string(); MAX_DROPPED_FILES + 1];

        let error = read_dropped_images(&paths).unwrap_err();

        assert!(error.contains("Too many files"), "{error}");
    }

    #[test]
    fn manifest_roundtrips_in_order() {
        let manifest = Manifest {
            items: vec![
                ManifestItem {
                    id: "a".repeat(32),
                    mime: "image/webp".into(),
                    width: 1000,
                    height: 750,
                },
                ManifestItem {
                    id: "b".repeat(32),
                    mime: "image/jpeg".into(),
                    width: 800,
                    height: 1000,
                },
            ],
        };
        let packed = pack_manifest("2026-10-23", &manifest).unwrap();
        let parsed = unpack_manifest(&packed, "2026-10-23").unwrap();
        assert_eq!(parsed, manifest);
    }

    #[test]
    fn manifest_rejects_the_wrong_date() {
        let manifest = Manifest {
            items: vec![ManifestItem {
                id: "a".repeat(32),
                mime: "image/webp".into(),
                width: 0,
                height: 0,
            }],
        };
        let packed = pack_manifest("2026-10-23", &manifest).unwrap();
        assert!(unpack_manifest(&packed, "2026-10-24").is_err());
    }

    #[test]
    fn save_list_read_and_delete_roundtrip() {
        let dir = temp_dir("roundtrip");
        let key = key(&dir);

        let first = save(&dir, &key, "2026-10-23", "image/webp", WEBP).unwrap();
        let second = save(&dir, &key, "2026-10-23", "image/jpeg", JPEG).unwrap();
        let listed = list_attachments(&dir, &key, "2026-10-23").unwrap();
        assert_eq!(
            listed.iter().map(|a| &a.id).collect::<Vec<_>>(),
            vec![&first.id, &second.id]
        );
        assert!(!listed[0].missing);

        let data = read_attachment(&dir, &key, "2026-10-23", &first.id).unwrap();
        assert_eq!(data.mime, "image/webp");
        assert_eq!(crypto::b64_decode(&data.data).unwrap(), WEBP);

        delete_attachment(&dir, &key, "2026-10-23", &first.id).unwrap();
        let listed = list_attachments(&dir, &key, "2026-10-23").unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, second.id);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn reorder_rewrites_the_manifest_order() {
        let dir = temp_dir("reorder");
        let key = key(&dir);
        let a = save(&dir, &key, "2026-10-23", "image/webp", WEBP).unwrap();
        let b = save(&dir, &key, "2026-10-23", "image/png", PNG).unwrap();

        reorder_attachments(&dir, &key, "2026-10-23", &[b.id.clone(), a.id.clone()]).unwrap();
        let listed = list_attachments(&dir, &key, "2026-10-23").unwrap();
        assert_eq!(listed[0].id, b.id);
        assert_eq!(listed[1].id, a.id);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_manifest_rows_are_rebuilt_from_legacy_files() {
        let dir = temp_dir("rebuild");
        let key = key(&dir);
        let date = "2026-10-23";
        let a = save(&dir, &key, date, "image/webp", WEBP).unwrap();
        let b = save(&dir, &key, date, "image/jpeg", JPEG).unwrap();

        // Simulate a vault created before the flat layout.
        let legacy = attachment_dir(&dir, date).unwrap();
        fs::create_dir_all(&legacy).unwrap();
        fs::rename(
            attachment_file(&dir, date, &a.id),
            legacy_attachment_file(&dir, date, &a.id),
        )
        .unwrap();
        fs::rename(
            attachment_file(&dir, date, &b.id),
            legacy_attachment_file(&dir, date, &b.id),
        )
        .unwrap();
        db::delete_attachment_rows(&dir, &key, date, None).unwrap();

        let listed = list_attachments(&dir, &key, date).unwrap();
        assert_eq!(listed.len(), 2);
        assert!(listed.iter().any(|item| item.id == a.id));
        assert!(listed.iter().any(|item| item.id == b.id));
        assert_eq!(
            db::read_attachment_manifest(&dir, &key, date)
                .unwrap()
                .len(),
            2
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn new_attachments_use_the_flat_layout() {
        let dir = temp_dir("flat");
        let key = key(&dir);
        let date = "2026-10-23";
        let item = save(&dir, &key, date, "image/webp", WEBP).unwrap();

        assert!(attachment_file(&dir, date, &item.id).is_file());
        assert!(!attachment_dir(&dir, date).unwrap().exists());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn deleting_an_entry_deletes_its_attachments() {
        let dir = temp_dir("cascade");
        let key = key(&dir);
        let item = save(&dir, &key, "2026-10-23", "image/webp", WEBP).unwrap();
        let path = attachment_file(&dir, "2026-10-23", &item.id);
        assert!(path.is_file());

        db::delete_entry(&dir, &key, "2026-10-23").unwrap();
        assert!(!path.exists());
        assert!(list_attachments(&dir, &key, "2026-10-23")
            .unwrap()
            .is_empty());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn saving_invalid_data_is_refused() {
        let dir = temp_dir("invalid");
        let key = key(&dir);
        assert!(save(&dir, &key, "2026-10-23", "image/webp", b"not an image").is_err());
        assert!(save(&dir, &key, "2026-10-23", "image/svg+xml", b"<svg/>").is_err());
        assert!(read_attachment(&dir, &key, "2026-10-23", "../../etc/passwd").is_err());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn orphan_scan_ignores_days_with_an_entry() {
        let dir = temp_dir("orphan");
        let key = key(&dir);
        save(&dir, &key, "2026-10-23", "image/webp", WEBP).unwrap();
        db::write_entry(&dir, &key, "2026-10-23", "Day", "body").unwrap();

        // A directory without an entry row is what a crashed delete leaves
        // behind. `save_attachment` never creates one: it makes sure the day
        // has an entry so its images stay reachable.
        let orphan = attachment_dir(&dir, "2026-10-22").unwrap();
        fs::create_dir_all(&orphan).unwrap();
        fs::write(orphan.join("dummy.bin"), b"orphan").unwrap();

        let orphans = list_orphan_attachments(&dir, &key).unwrap();
        assert_eq!(orphans.len(), 1);
        assert_eq!(orphans[0].date, "2026-10-22");
        assert_eq!(orphans[0].file_count, 1);

        delete_orphan_attachments(&dir, &key, "2026-10-22").unwrap();
        assert!(!attachment_dir(&dir, "2026-10-22").unwrap().exists());
        assert!(delete_orphan_attachments(&dir, &key, "2026-10-23").is_err());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn orphan_scan_finds_unreferenced_flat_files() {
        let dir = temp_dir("orphan-flat");
        let key = key(&dir);
        let root = attachments_root(&dir);
        fs::create_dir_all(&root).unwrap();
        let orphan = root.join(format!("{}.bin", "a".repeat(32)));
        fs::write(&orphan, b"orphan").unwrap();
        let kept = save(&dir, &key, "2026-10-23", "image/webp", WEBP).unwrap();

        let orphans = list_orphan_attachments(&dir, &key).unwrap();
        assert_eq!(orphans.len(), 1);
        assert_eq!(orphans[0].date, "");
        assert_eq!(orphans[0].file_count, 1);

        delete_orphan_attachments(&dir, &key, "").unwrap();
        assert!(!orphan.exists());
        assert!(attachment_file(&dir, "2026-10-23", &kept.id).is_file());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn saved_attachment_bytes_are_not_plaintext() {
        let dir = temp_dir("ciphertext");
        let key = key(&dir);
        let item = save(&dir, &key, "2026-10-23", "image/webp", WEBP).unwrap();
        let envelope = fs::read(attachment_file(&dir, "2026-10-23", &item.id)).unwrap();
        assert!(envelope.starts_with(b"FDAT"));
        assert!(!envelope
            .windows(item.id.len())
            .any(|window| window == item.id.as_bytes()));
        assert!(!envelope
            .windows("image/webp".len())
            .any(|window| window == b"image/webp"));
        assert!(!dir.join("attachments/2026-10-23/manifest.xml").exists());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn recompress_shrinks_existing_png_attachments() {
        let dir = temp_dir("recompress-png");
        let key = key(&dir);
        let date = "2026-10-23";
        let png = png_image(800, 600);
        let item = save(&dir, &key, date, "image/png", &png).unwrap();
        let path = attachment_file(&dir, date, &item.id);
        let before = fs::metadata(&path).unwrap().len();

        let report = recompress_attachments(&dir, &key).unwrap();

        assert_eq!(report.scanned, 1);
        assert_eq!(report.moved, 0);
        assert_eq!(report.recompressed, 1);
        assert_eq!(report.skipped, 0);
        assert_eq!(report.failed, 0);
        assert!(report.failures.is_empty());
        assert!(report.bytes_after < report.bytes_before);

        let after = fs::metadata(&path).unwrap().len();
        assert!(after < before, "{after} should be smaller than {before}");
        let listed = list_attachments(&dir, &key, date).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].mime, "image/webp");
        assert_eq!((listed[0].width, listed[0].height), (800, 600));
        let plain = read_attachment_bytes(&dir, &key, date, &item.id).unwrap();
        assert_eq!(&plain[..4], b"RIFF");
        assert_eq!(&plain[8..12], b"WEBP");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn recompress_skips_lossy_webp_without_touching_the_file() {
        let dir = temp_dir("recompress-skip");
        let key = key(&dir);
        let date = "2026-10-23";
        let source = image_ops::prepare_image_bytes(&png_image(64, 64)).unwrap();
        let item = save(&dir, &key, date, "image/webp", &source.data).unwrap();
        let path = attachment_file(&dir, date, &item.id);
        let before = fs::read(&path).unwrap();

        let report = recompress_attachments(&dir, &key).unwrap();

        assert_eq!(report.scanned, 1);
        assert_eq!(report.moved, 0);
        assert_eq!(report.recompressed, 0);
        assert_eq!(report.skipped, 1);
        assert_eq!(report.failed, 0);
        assert_eq!(fs::read(&path).unwrap(), before);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn recompress_moves_legacy_files_into_the_flat_folder() {
        let dir = temp_dir("recompress-flatten");
        let key = key(&dir);
        let date = "2026-10-23";
        let source = image_ops::prepare_image_bytes(&png_image(64, 64)).unwrap();
        let item = save(&dir, &key, date, "image/webp", &source.data).unwrap();
        let flat = attachment_file(&dir, date, &item.id);
        let legacy = legacy_attachment_file(&dir, date, &item.id);
        fs::create_dir_all(legacy.parent().unwrap()).unwrap();
        fs::rename(&flat, &legacy).unwrap();
        let before = fs::read(&legacy).unwrap();

        let report = recompress_attachments(&dir, &key).unwrap();

        assert_eq!(report.scanned, 1);
        assert_eq!(report.moved, 1);
        assert_eq!(report.recompressed, 0);
        assert_eq!(report.skipped, 1);
        assert_eq!(report.failed, 0);
        assert!(flat.is_file());
        assert!(!legacy.exists());
        assert!(!attachment_dir(&dir, date).unwrap().exists());
        assert_eq!(fs::read(&flat).unwrap(), before);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn recompress_reports_undecodable_attachments_without_touching_them() {
        let dir = temp_dir("recompress-fail");
        let key = key(&dir);
        let date = "2026-10-23";
        let item = save(&dir, &key, date, "image/png", PNG).unwrap();
        let path = attachment_file(&dir, date, &item.id);
        let before = fs::read(&path).unwrap();

        let report = recompress_attachments(&dir, &key).unwrap();

        assert_eq!(report.scanned, 1);
        assert_eq!(report.moved, 0);
        assert_eq!(report.recompressed, 0);
        assert_eq!(report.failed, 1);
        assert_eq!(report.failures.len(), 1);
        assert_eq!(report.failures[0].id, item.id);
        assert_eq!(fs::read(&path).unwrap(), before);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn lossy_webp_detection_only_matches_vp8_without_a_lossless_chunk() {
        assert!(is_lossy_webp(WEBP));
        assert!(!is_lossy_webp(b"RIFF\x10\x00\x00\x00WEBPVP8Lfake"));
        assert!(!is_lossy_webp(PNG));
    }
}
