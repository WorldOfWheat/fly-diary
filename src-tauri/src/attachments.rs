//! Encrypted image attachments stored next to the diary entries.
//!
//! Layout:
//!
//! ```text
//! diary/
//! └── attachments/
//!     └── 2026-10-23/
//!         ├── manifest.xml
//!         ├── 9f2c....bin
//!         └── 4d8e....bin
//! ```
//!
//! Each image is encrypted with the vault's diary key and a fresh IV. The
//! manifest is an encrypted XML document that records the display order and the
//! small pieces of metadata the gallery needs before decrypting every image.
//!
//! The manifest deliberately reuses the entry XML envelope (`<diary>`) so it
//! goes through the same `xml`/`fsutil`/base64 path as `index.xml`. Its payload
//! is a second XML document:
//!
//! ```xml
//! <manifest version="1" date="2026-10-23">
//!   <attachment id="..." mime="image/webp" width="1000" height="750"/>
//!   ...
//! </manifest>
//! ```
//!
//! Element order is the display order. There is no separate `added-at` field:
//! the order is the data, and a manifest that is lost can only be rebuilt with
//! an approximate order (file mtime/name).

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::UNIX_EPOCH;

use quick_xml::events::{BytesDecl, BytesEnd, BytesStart, Event};
use quick_xml::{Reader, Writer};
use rand::RngCore;
use serde::Serialize;
use zeroize::Zeroizing;

use crate::crypto;
use crate::fsutil;
use crate::storage;
use crate::xml::{self, EncryptedEntry};

/// Directory under the diary root that holds all attachments.
const ATTACHMENTS_DIR: &str = "attachments";
/// Manifest file inside a per-date attachment directory.
const MANIFEST_FILE: &str = "manifest.xml";
/// Magic bytes at the start of an encrypted attachment file.
const ATTACHMENT_MAGIC: &[u8; 4] = b"FDAT";
/// On-disk attachment envelope version.
const ATTACHMENT_VERSION: u8 = 1;
/// Manifest schema version (inside the encrypted payload).
const MANIFEST_VERSION: u8 = 1;
/// AAD label for the manifest. Must differ from index and entry labels.
const MANIFEST_AAD_LABEL: &[u8] = b"fly-diary/attachment-manifest";
/// AAD label for an image.
const ATTACHMENT_AAD_LABEL: &[u8] = b"fly-diary/attachment";

/// Largest decoded image accepted by the backend. The frontend resizes before
/// upload, so this is a defence against a buggy or malicious client, not the
/// normal file-size limit.
pub const MAX_ATTACHMENT_BYTES: usize = 5 * 1024 * 1024;

/// Maximum number of images per day.
pub const MAX_ATTACHMENTS_PER_DAY: usize = 200;

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

/// An attachment directory with no matching diary entry.
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

fn attachment_path(dir: &Path, date: &str, id: &str) -> Result<PathBuf, String> {
    validate_attachment_id(id)?;
    Ok(attachment_dir(dir, date)?.join(format!("{id}.bin")))
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

fn attr_value(e: &BytesStart<'_>, name: &[u8]) -> Result<Option<String>, String> {
    for attr in e.attributes() {
        let attr = attr.map_err(|err| format!("Invalid manifest attribute: {err}"))?;
        if attr.key.as_ref() == name {
            return attr
                .unescape_value()
                .map(|value| Some(value.into_owned()))
                .map_err(|err| format!("Invalid manifest attribute value: {err}"));
        }
    }
    Ok(None)
}

fn required_attr(e: &BytesStart<'_>, name: &str) -> Result<String, String> {
    attr_value(e, name.as_bytes())?
        .ok_or_else(|| format!("Manifest is missing the {name} attribute"))
}

fn pack_manifest(date: &str, manifest: &Manifest) -> Result<Zeroizing<Vec<u8>>, String> {
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

    let bytes = writer.into_inner();
    Ok(Zeroizing::new(bytes))
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
                b"manifest" => {
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
                b"attachment" => {
                    if !root_seen {
                        return Err("Attachment appeared before <manifest>".to_string());
                    }
                    let id = required_attr(&e, "id")?;
                    validate_attachment_id(&id)?;
                    let mime = required_attr(&e, "mime")?;
                    if mime != UNKNOWN_MIME {
                        validate_mime(&mime)?;
                    }
                    let width = attr_value(&e, b"width")?
                        .unwrap_or_else(|| "0".to_string())
                        .parse::<u32>()
                        .map_err(|_| "Invalid manifest width".to_string())?;
                    let height = attr_value(&e, b"height")?
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
    if version != Some(MANIFEST_VERSION) {
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

fn write_manifest(
    dir: &Path,
    key: &[u8; 32],
    date: &str,
    manifest: &Manifest,
) -> Result<(), String> {
    let attachment_dir = attachment_dir(dir, date)?;
    fsutil::create_private_dir(&attachment_dir)
        .map_err(|e| format!("Failed to create attachment directory: {e}"))?;

    let plain = pack_manifest(date, manifest)?;
    let (iv, ciphertext) = crypto::encrypt_with_aad(key, &manifest_aad(date), &plain)?;
    let document = xml::to_xml(&EncryptedEntry::new(
        date,
        crypto::b64_encode(&iv),
        crypto::b64_encode(&ciphertext),
    ))?;
    fsutil::write_private(&manifest_path(dir, date)?, document)
        .map_err(|e| format!("Failed to write attachment manifest: {e}"))
}

fn read_manifest(dir: &Path, key: &[u8; 32], date: &str) -> Result<Option<Manifest>, String> {
    let path = manifest_path(dir, date)?;
    match fs::metadata(&path) {
        Ok(metadata) if metadata.len() > MAX_MANIFEST_BYTES => {
            return Err("Attachment manifest is too large".to_string())
        }
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("Failed to read attachment manifest: {e}")),
    }
    let text = match fs::read_to_string(&path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("Failed to read attachment manifest: {e}")),
    };

    let encrypted = xml::from_xml(&text)?;
    if encrypted.version != xml::CURRENT_VERSION {
        return Err("Unsupported attachment manifest envelope version".to_string());
    }
    if encrypted.date != date {
        return Err("Attachment manifest date does not match its folder".to_string());
    }

    let iv = crypto::b64_decode(&encrypted.iv)?;
    let ciphertext = crypto::b64_decode(&encrypted.payload)?;
    let plain = crypto::decrypt_with_aad(key, &manifest_aad(date), &iv, &ciphertext)?;
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
) -> Result<Vec<u8>, String> {
    let aad = attachment_aad(date, id, ATTACHMENT_VERSION);
    let (iv, ciphertext) = crypto::encrypt_with_aad(key, &aad, data)?;
    let mut out =
        Vec::with_capacity(ATTACHMENT_MAGIC.len() + 1 + crypto::IV_LEN + ciphertext.len());
    out.extend_from_slice(ATTACHMENT_MAGIC);
    out.push(ATTACHMENT_VERSION);
    out.extend_from_slice(&iv);
    out.extend_from_slice(&ciphertext);
    Ok(out)
}

fn decrypt_attachment(
    key: &[u8; 32],
    date: &str,
    id: &str,
    bytes: &[u8],
) -> Result<Zeroizing<Vec<u8>>, String> {
    let header_len = ATTACHMENT_MAGIC.len() + 1 + crypto::IV_LEN;
    if bytes.len() < header_len {
        return Err("Attachment file is truncated".to_string());
    }
    if &bytes[..ATTACHMENT_MAGIC.len()] != ATTACHMENT_MAGIC {
        return Err("Attachment file has an unknown header".to_string());
    }
    let version = bytes[ATTACHMENT_MAGIC.len()];
    if version != ATTACHMENT_VERSION {
        return Err(format!("Unsupported attachment version: {version}"));
    }
    let iv_start = ATTACHMENT_MAGIC.len() + 1;
    let iv = &bytes[iv_start..iv_start + crypto::IV_LEN];
    let ciphertext = &bytes[header_len..];
    let aad = attachment_aad(date, id, version);
    crypto::decrypt_with_aad(key, &aad, iv, ciphertext)
}

fn read_attachment_bytes(
    dir: &Path,
    key: &[u8; 32],
    date: &str,
    id: &str,
) -> Result<Zeroizing<Vec<u8>>, String> {
    let path = attachment_path(dir, date, id)?;
    let max_encrypted = MAX_ATTACHMENT_BYTES as u64 + 1024;
    match fs::metadata(&path) {
        Ok(metadata) if metadata.len() > max_encrypted => {
            return Err(format!("Attachment {id} is too large"))
        }
        Ok(_) => {}
        Err(e) => return Err(format!("Failed to read attachment {id}: {e}")),
    }
    let bytes = fs::read(&path).map_err(|e| format!("Failed to read attachment {id}: {e}"))?;
    decrypt_attachment(key, date, id, &bytes)
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

/// Load a manifest, repairing it from the files on disk when it is missing,
/// corrupt, or does not mention an attachment file.
fn ensure_manifest(dir: &Path, key: &[u8; 32], date: &str) -> Result<Manifest, String> {
    let attachment_dir = attachment_dir(dir, date)?;
    if !attachment_dir.is_dir() {
        return Ok(Manifest::default());
    }

    let files = scan_attachment_files(dir, date)?;
    let read = read_manifest(dir, key, date);
    let needs_rebuild = !matches!(read, Ok(Some(_)));
    let mut manifest = match read {
        Ok(Some(manifest)) => manifest,
        _ => Manifest::default(),
    };

    let mut changed = needs_rebuild;
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
    fsutil::create_private_dir(&attachment_dir(dir, date)?)
        .map_err(|e| format!("Failed to create attachment directory: {e}"))?;

    // A day with images but no entry would be invisible in the sidebar, and the
    // attachment would look orphaned. Create the empty entry first.
    if storage::read_entry(dir, key, date)?.is_none() {
        storage::write_entry(dir, key, date, "", "")?;
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

    let encrypted = encrypt_attachment(key, date, &id, data)?;
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
        // The image file is now unreferenced; remove it when possible instead of
        // leaving a garbage file behind. A crash can still leave one, which the
        // next `list_attachments` recovers.
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
/// order would let an unreferenced file be "recovered" by the next
/// `ensure_manifest` call, resurrecting an image the user asked to delete.
pub fn delete_attachment(dir: &Path, key: &[u8; 32], date: &str, id: &str) -> Result<(), String> {
    storage::validate_date(date)?;
    validate_attachment_id(id)?;
    let path = attachment_path(dir, date, id)?;

    let _guard = lock_attachments();
    let mut manifest = ensure_manifest(dir, key, date)?;
    if !manifest.items.iter().any(|item| item.id == id) {
        return Err(format!("Attachment {id} does not exist"));
    }

    match fs::remove_file(&path) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("Failed to delete attachment {id}: {e}")),
    }

    manifest.items.retain(|item| item.id != id);
    write_manifest(dir, key, date, &manifest)?;
    if let Ok(dir) = attachment_dir(dir, date) {
        let _ = fsutil::sync_dir(&dir);
    }
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

/// Find attachment directories whose entry file no longer exists.
///
/// The check is deliberately based on file existence, not decryptability: a
/// broken entry still owns its images and must not be reported as an orphan.
pub fn list_orphan_attachments(dir: &Path) -> Result<Vec<OrphanAttachment>, String> {
    let root = attachments_root(dir);
    let read_dir = match fs::read_dir(&root) {
        Ok(read_dir) => read_dir,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("Failed to read attachment root: {e}")),
    };

    let mut orphans = Vec::new();
    for item in read_dir {
        let item = item.map_err(|e| format!("Failed to read attachment root: {e}"))?;
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
        if dir.join(format!("{date}.xml")).is_file() {
            continue;
        }

        let mut file_count = 0u64;
        let mut size = 0u64;
        if let Ok(entries) = fs::read_dir(&path) {
            for entry in entries.flatten() {
                if let Ok(metadata) = entry.metadata() {
                    if metadata.is_file() {
                        file_count += 1;
                        size += metadata.len();
                    }
                }
            }
        }
        orphans.push(OrphanAttachment {
            date: date.to_string(),
            file_count,
            size,
        });
    }
    orphans.sort_by(|a, b| b.date.cmp(&a.date));
    Ok(orphans)
}

/// Delete an orphaned attachment directory. Refuses when an entry file exists.
pub fn delete_orphan_attachments(dir: &Path, date: &str) -> Result<(), String> {
    storage::validate_date(date)?;
    if dir.join(format!("{date}.xml")).is_file() {
        return Err(format!("Entry {date} still exists"));
    }
    delete_all_for_date(dir, date)
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
    fn a_missing_manifest_is_rebuilt_from_files() {
        let dir = temp_dir("rebuild");
        let key = key(&dir);
        let a = save(&dir, &key, "2026-10-23", "image/webp", WEBP).unwrap();
        let b = save(&dir, &key, "2026-10-23", "image/jpeg", JPEG).unwrap();
        fs::remove_file(manifest_path(&dir, "2026-10-23").unwrap()).unwrap();

        let listed = list_attachments(&dir, &key, "2026-10-23").unwrap();
        assert_eq!(listed.len(), 2);
        assert!(listed.iter().any(|item| item.id == a.id));
        assert!(listed.iter().any(|item| item.id == b.id));
        assert!(manifest_path(&dir, "2026-10-23").unwrap().is_file());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn deleting_an_entry_deletes_its_attachments() {
        let dir = temp_dir("cascade");
        let key = key(&dir);
        save(&dir, &key, "2026-10-23", "image/webp", WEBP).unwrap();
        storage::delete_entry(&dir, &key, "2026-10-23").unwrap();
        assert!(!attachment_dir(&dir, "2026-10-23").unwrap().exists());
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
        save(&dir, &key, "2026-10-22", "image/webp", WEBP).unwrap();
        fs::remove_file(dir.join("2026-10-22.xml")).unwrap();

        let orphans = list_orphan_attachments(&dir).unwrap();
        assert_eq!(orphans.len(), 1);
        assert_eq!(orphans[0].date, "2026-10-22");
        assert_eq!(orphans[0].file_count, 2); // manifest + one image

        delete_orphan_attachments(&dir, "2026-10-22").unwrap();
        assert!(!attachment_dir(&dir, "2026-10-22").unwrap().exists());
        assert!(delete_orphan_attachments(&dir, "2026-10-23").is_err());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn manifest_files_are_not_plaintext() {
        let dir = temp_dir("ciphertext");
        let key = key(&dir);
        let item = save(&dir, &key, "2026-10-23", "image/webp", WEBP).unwrap();
        let manifest = fs::read_to_string(manifest_path(&dir, "2026-10-23").unwrap()).unwrap();
        assert!(!manifest.contains(&item.id));
        assert!(!manifest.contains("image/webp"));
        assert!(manifest.contains("version=\"4\""));

        let _ = fs::remove_dir_all(&dir);
    }
}
