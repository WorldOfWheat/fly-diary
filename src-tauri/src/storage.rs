//! Encrypted, XML-backed storage layer.
//!
//! Layout of the diary directory:
//!
//! ```text
//! diary/
//! ├── vault.xml              # KDF params + wrapped diary key (no key material)
//! ├── index.xml              # encrypted {date, title} index for the sidebar
//! ├── 2026-10-23.xml         # one encrypted entry per day
//! └── 2026-10-22.xml
//! ```
//!
//! Every entry file is an XML document holding `date`, `iv` and the
//! AES-256-GCM encrypted `payload` (see [`crate::xml`]). The payload is the
//! title and the body joined by [`FIELD_SEPARATOR`], so neither of them is
//! readable on disk without the passphrase.
//!
//! ## Why an index?
//!
//! Titles live inside the encrypted payload, so listing the sidebar would
//! otherwise require decrypting *every* entry file on every unlock. With a few
//! thousand entries that is hundreds of milliseconds of disk I/O. `index.xml`
//! stores all `{date, title}` pairs in a single encrypted blob, so unlocking
//! decrypts one file instead of thousands. The index is a cache: if it is
//! missing, stale or corrupt it is rebuilt by scanning the entry files.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::crypto;
use crate::xml::{self, EncryptedEntry};

/// Name of the vault metadata file (salt + verifier).
const VAULT_FILE: &str = "vault.xml";

/// Name of the encrypted sidebar index.
const INDEX_FILE: &str = "index.xml";

/// Separator between index records inside the encrypted index payload.
///
/// Records are `date \t title`; a tab cannot appear in a date, and titles have
/// their tabs flattened on write, so the split is unambiguous.
const INDEX_FIELD_SEPARATOR: u8 = b'\t';

/// Separator between index records.
const INDEX_RECORD_SEPARATOR: u8 = b'\n';

/// Separator between the title and the body inside the encrypted payload.
///
/// The title is the first line of the plaintext, so a title can never contain
/// a newline; the body may contain any number of them.
const FIELD_SEPARATOR: u8 = b'\n';

/// Metadata for a single diary entry, used by the sidebar list.
#[derive(Debug, Clone, Serialize)]
pub struct EntryMeta {
    /// Date in `YYYY-MM-DD` format.
    pub date: String,
    /// Entry title. Only available while the diary is unlocked, because the
    /// title is stored inside the encrypted payload.
    pub title: String,
    /// File size in bytes.
    pub size: u64,
}

/// A decrypted diary entry handed to the frontend.
#[derive(Debug, Clone, Serialize)]
pub struct Entry {
    pub date: String,
    pub title: String,
    pub content: String,
}

/// Validate that `date` is a real calendar date in `YYYY-MM-DD` form.
///
/// This is the single source of truth for what counts as a valid entry key,
/// and it also prevents path traversal (e.g. `../../etc/passwd`).
pub fn validate_date(date: &str) -> Result<(), String> {
    if date.len() != 10 {
        return Err(format!("Invalid date format: {date}"));
    }
    chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d")
        .map(|_| ())
        .map_err(|_| format!("Invalid date: {date}"))
}

/// Resolve the file path for a given date inside the diary directory.
fn entry_path(dir: &Path, date: &str) -> Result<PathBuf, String> {
    validate_date(date)?;
    Ok(dir.join(format!("{date}.xml")))
}

/// Ensure the diary directory exists, creating it if necessary.
pub fn ensure_dir(dir: &Path) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| format!("Failed to create diary directory: {e}"))
}

// ---------------------------------------------------------------------------
// Vault (KDF params + wrapped diary key)
// ---------------------------------------------------------------------------

/// Plaintext that version 1 vaults encrypted to prove the passphrase.
///
/// Only used to validate legacy vaults before migrating them.
const VERIFIER_PLAINTEXT: &[u8] = b"fly-diary-verifier";
//
// Version 2 layout:
//
// ```xml
// <vault version="2">
//   <kdf>argon2id</kdf>
//   <kdf-memory>19456</kdf-memory>
//   <kdf-iterations>2</kdf-iterations>
//   <kdf-parallelism>1</kdf-parallelism>
//   <salt>BASE64(16 bytes)</salt>
//   <wrapped-key-iv>BASE64(12 bytes)</wrapped-key-iv>
//   <wrapped-key>BASE64(AES-GCM(master key, diary key))</wrapped-key>
// </vault>
// ```
//
// The master key is derived from the passphrase and is never stored. It only
// wraps the random diary key, which is what actually encrypts entries.

/// Which KDF produced the master key.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kdf {
    /// Version 1: single SHA-256 pass (legacy, migration only).
    LegacySha256,
    /// Version 2: Argon2id with the stored cost parameters.
    Argon2id,
}

/// Contents of `vault.xml`.
struct Vault {
    kdf: Kdf,
    /// Only meaningful for [`Kdf::Argon2id`].
    params: crypto::KdfParams,
    salt_b64: String,
    /// Base64 of `AES-GCM(master key, diary key)`.
    wrapped_key_iv_b64: String,
    wrapped_key_b64: String,
}

fn vault_path(dir: &Path) -> PathBuf {
    dir.join(VAULT_FILE)
}

fn write_vault(dir: &Path, vault: &Vault) -> Result<(), String> {
    ensure_dir(dir)?;
    let xml = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
         <vault version=\"2\">\n\
         \x20 <kdf>argon2id</kdf>\n\
         \x20 <kdf-memory>{}</kdf-memory>\n\
         \x20 <kdf-iterations>{}</kdf-iterations>\n\
         \x20 <kdf-parallelism>{}</kdf-parallelism>\n\
         \x20 <salt>{}</salt>\n\
         \x20 <wrapped-key-iv>{}</wrapped-key-iv>\n\
         \x20 <wrapped-key>{}</wrapped-key>\n\
         </vault>\n",
        vault.params.memory_kib,
        vault.params.iterations,
        vault.params.parallelism,
        vault.salt_b64,
        vault.wrapped_key_iv_b64,
        vault.wrapped_key_b64
    );
    fs::write(vault_path(dir), xml).map_err(|e| format!("Failed to write vault: {e}"))
}

fn read_vault(dir: &Path) -> Result<Option<Vault>, String> {
    let path = vault_path(dir);
    let text = match fs::read_to_string(&path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("Failed to read vault: {e}")),
    };

    let mut version = String::new();
    let mut kdf = None;
    let mut memory = None;
    let mut iterations = None;
    let mut parallelism = None;
    let mut salt = None;
    let mut wrapped_key_iv = None;
    let mut wrapped_key = None;
    // Version 1 fields.
    let mut verifier_iv = None;
    let mut verifier = None;
    let mut current = String::new();

    let mut reader = quick_xml::Reader::from_str(&text);
    reader.config_mut().trim_text(true);
    loop {
        match reader.read_event() {
            Ok(quick_xml::events::Event::Start(e)) => {
                let name = String::from_utf8_lossy(e.name().as_ref()).to_string();
                if name == "vault" {
                    for attr in e.attributes().flatten() {
                        if attr.key.as_ref() == b"version" {
                            version = String::from_utf8_lossy(&attr.value).to_string();
                        }
                    }
                }
                current = name;
            }
            Ok(quick_xml::events::Event::Text(e)) => {
                let value = e
                    .unescape()
                    .map_err(|err| format!("Invalid vault XML: {err}"))?
                    .to_string();
                match current.as_str() {
                    "kdf" => kdf = Some(value),
                    "kdf-memory" => memory = Some(value),
                    "kdf-iterations" => iterations = Some(value),
                    "kdf-parallelism" => parallelism = Some(value),
                    "salt" => salt = Some(value),
                    "wrapped-key-iv" => wrapped_key_iv = Some(value),
                    "wrapped-key" => wrapped_key = Some(value),
                    "verifier-iv" => verifier_iv = Some(value),
                    "verifier" => verifier = Some(value),
                    _ => {}
                }
            }
            Ok(quick_xml::events::Event::End(_)) => current.clear(),
            Ok(quick_xml::events::Event::Eof) => break,
            Err(e) => return Err(format!("Failed to parse vault: {e}")),
            _ => {}
        }
    }

    let salt_b64 = salt.ok_or_else(|| "Vault is missing <salt>".to_string())?;

    // Version 1 vaults have no <kdf> element and store a verifier instead of a
    // wrapped key. Treat them as legacy so they can be migrated on unlock.
    let is_legacy = kdf.is_none() || version == "1";
    if is_legacy {
        return Ok(Some(Vault {
            kdf: Kdf::LegacySha256,
            params: crypto::KdfParams::default(),
            salt_b64,
            wrapped_key_iv_b64: verifier_iv
                .ok_or_else(|| "Vault is missing <verifier-iv>".to_string())?,
            wrapped_key_b64: verifier.ok_or_else(|| "Vault is missing <verifier>".to_string())?,
        }));
    }

    let kdf_name = kdf.unwrap_or_default();
    if kdf_name != "argon2id" {
        return Err(format!("Unsupported KDF: {kdf_name}"));
    }

    let parse_u32 = |value: Option<String>, field: &str| -> Result<u32, String> {
        value
            .ok_or_else(|| format!("Vault is missing <{field}>"))?
            .parse::<u32>()
            .map_err(|e| format!("Invalid <{field}> value: {e}"))
    };

    Ok(Some(Vault {
        kdf: Kdf::Argon2id,
        params: crypto::KdfParams {
            memory_kib: parse_u32(memory, "kdf-memory")?,
            iterations: parse_u32(iterations, "kdf-iterations")?,
            parallelism: parse_u32(parallelism, "kdf-parallelism")?,
        },
        salt_b64,
        wrapped_key_iv_b64: wrapped_key_iv
            .ok_or_else(|| "Vault is missing <wrapped-key-iv>".to_string())?,
        wrapped_key_b64: wrapped_key
            .ok_or_else(|| "Vault is missing <wrapped-key>".to_string())?,
    }))
}

/// Whether a vault already exists (i.e. the diary has been initialised).
pub fn vault_exists(dir: &Path) -> Result<bool, String> {
    Ok(vault_path(dir).exists())
}

/// Create a brand-new vault and return the random diary key.
///
/// A fresh diary key is generated, wrapped with the Argon2id-derived master
/// key, and stored in `vault.xml`. The diary key itself never touches the disk
/// unwrapped.
pub fn create_vault(
    dir: &Path,
    passphrase: &str,
    params: crypto::KdfParams,
) -> Result<[u8; 32], String> {
    if vault_exists(dir)? {
        return Err("Vault already exists".to_string());
    }
    if passphrase.is_empty() {
        return Err("Passphrase must not be empty".to_string());
    }
    params.validate()?;

    let salt_b64 = crypto::new_salt_b64();
    let salt = crypto::b64_decode(&salt_b64)?;
    let master = crypto::derive_master_key(passphrase, &salt, params)?;

    let diary_key = crypto::new_diary_key();
    let (iv, ct) = crypto::encrypt(&master, diary_key.as_ref())?;

    let vault = Vault {
        kdf: Kdf::Argon2id,
        params,
        salt_b64,
        wrapped_key_iv_b64: crypto::b64_encode(&iv),
        wrapped_key_b64: crypto::b64_encode(&ct),
    };
    write_vault(dir, &vault)?;

    Ok(*diary_key)
}

/// Verify `passphrase` and return the unwrapped diary key.
///
/// Version 1 vaults are migrated in place: the legacy key is used to decrypt
/// the verifier, then a fresh diary key is generated and wrapped with an
/// Argon2id master key. Because the diary key changes, **every entry must be
/// re-encrypted** — [`migrate_entries`] does that.
pub fn unlock_vault(dir: &Path, passphrase: &str) -> Result<[u8; 32], String> {
    let vault = read_vault(dir)?.ok_or_else(|| "No vault found".to_string())?;
    let salt = crypto::b64_decode(&vault.salt_b64)?;
    let iv = crypto::b64_decode(&vault.wrapped_key_iv_b64)?;
    let ct = crypto::b64_decode(&vault.wrapped_key_b64)?;

    match vault.kdf {
        Kdf::Argon2id => {
            let master = crypto::derive_master_key(passphrase, &salt, vault.params)?;
            let plain = crypto::decrypt(&master, &iv, &ct)
                .map_err(|_| "Incorrect passphrase".to_string())?;
            let key: [u8; 32] = plain
                .try_into()
                .map_err(|_| "Wrapped diary key has the wrong length".to_string())?;
            Ok(key)
        }
        Kdf::LegacySha256 => {
            let legacy = crypto::derive_legacy_key(passphrase, &salt);
            let plain = crypto::decrypt(&legacy, &iv, &ct)
                .map_err(|_| "Incorrect passphrase".to_string())?;
            if plain != VERIFIER_PLAINTEXT {
                return Err("Incorrect passphrase".to_string());
            }
            migrate_legacy_vault(dir, passphrase, &salt)
        }
    }
}

/// Upgrade a version 1 vault to Argon2id + wrapped diary key.
///
/// Re-encrypts every entry under the new diary key. If any step fails the
/// vault file is left untouched, so the old passphrase still works.
fn migrate_legacy_vault(dir: &Path, passphrase: &str, salt: &[u8]) -> Result<[u8; 32], String> {
    let legacy_key = crypto::derive_legacy_key(passphrase, salt);
    let params = crypto::KdfParams::default();
    let master = crypto::derive_master_key(passphrase, salt, params)?;
    let diary_key = crypto::new_diary_key();

    // Re-encrypt all entries first: if this fails, the vault is still v1.
    migrate_entries(dir, &legacy_key, &diary_key)?;

    let (iv, ct) = crypto::encrypt(&master, diary_key.as_ref())?;
    let vault = Vault {
        kdf: Kdf::Argon2id,
        params,
        salt_b64: crypto::b64_encode(salt),
        wrapped_key_iv_b64: crypto::b64_encode(&iv),
        wrapped_key_b64: crypto::b64_encode(&ct),
    };
    write_vault(dir, &vault)?;

    Ok(*diary_key)
}

/// Re-encrypt every entry from `old_key` to `new_key`.
fn migrate_entries(
    dir: &Path,
    old_key: &[u8; 32],
    new_key: &[u8; 32],
) -> Result<(), String> {
    let read_dir = fs::read_dir(dir).map_err(|e| format!("Failed to read diary directory: {e}"))?;
    for item in read_dir {
        let item = item.map_err(|e| format!("Failed to read directory entry: {e}"))?;
        let path = item.path();
        if path.extension().and_then(|s| s.to_str()) != Some("xml") {
            continue;
        }
        let Some(date) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        if validate_date(date).is_err() {
            continue;
        }

        let text = fs::read_to_string(&path)
            .map_err(|e| format!("Failed to read entry {date}: {e}"))?;
        let encrypted = xml::from_xml(&text)?;
        let iv = crypto::b64_decode(&encrypted.iv)?;
        let ct = crypto::b64_decode(&encrypted.payload)?;
        let plain = crypto::decrypt(old_key, &iv, &ct)
            .map_err(|_| format!("Entry {date} could not be decrypted during migration"))?;

        let (new_iv, new_ct) = crypto::encrypt(new_key, &plain)?;
        let rewritten = xml::EncryptedEntry::new(
            date,
            crypto::b64_encode(&new_iv),
            crypto::b64_encode(&new_ct),
        );
        fs::write(&path, xml::to_xml(&rewritten)?)
            .map_err(|e| format!("Failed to rewrite entry {date}: {e}"))?;
    }

    // The old index was encrypted with `old_key`, so it is now unreadable.
    // Rebuild it under the new key from the freshly re-encrypted entries.
    let index = scan_entries(dir, new_key)?;
    write_index(dir, new_key, &index)
}

// ---------------------------------------------------------------------------
// Encrypted sidebar index
// ---------------------------------------------------------------------------

fn index_path(dir: &Path) -> PathBuf {
    dir.join(INDEX_FILE)
}

/// Serialize `{date, title}` pairs into the plaintext index format.
///
/// One record per line, `date \t title`. Tabs and newlines in titles are
/// flattened to spaces so the record separator stays unambiguous.
fn pack_index(entries: &BTreeMap<String, String>) -> Vec<u8> {
    let mut out = Vec::new();
    for (date, title) in entries {
        let title = title.replace(['\t', '\r', '\n'], " ");
        out.extend_from_slice(date.as_bytes());
        out.push(INDEX_FIELD_SEPARATOR);
        out.extend_from_slice(title.as_bytes());
        out.push(INDEX_RECORD_SEPARATOR);
    }
    out
}

/// Parse the plaintext index format back into `{date, title}` pairs.
///
/// Malformed lines are skipped rather than failing the whole index; a bad
/// record is indistinguishable from a missing one and will be re-added on the
/// next write.
fn unpack_index(plain: &[u8]) -> BTreeMap<String, String> {
    let mut entries = BTreeMap::new();
    for line in plain.split(|b| *b == INDEX_RECORD_SEPARATOR) {
        if line.is_empty() {
            continue;
        }
        let Some(sep) = line.iter().position(|b| *b == INDEX_FIELD_SEPARATOR) else {
            continue;
        };
        let date = String::from_utf8_lossy(&line[..sep]).to_string();
        if validate_date(&date).is_err() {
            continue;
        }
        let title = String::from_utf8_lossy(&line[sep + 1..]).to_string();
        entries.insert(date, title);
    }
    entries
}

/// Write the encrypted index for `entries`.
fn write_index(dir: &Path, key: &[u8; 32], entries: &BTreeMap<String, String>) -> Result<(), String> {
    ensure_dir(dir)?;
    let (iv, ct) = crypto::encrypt(key, &pack_index(entries))?;
    let document = xml::to_xml(&EncryptedEntry::new(
        "index",
        crypto::b64_encode(&iv),
        crypto::b64_encode(&ct),
    ))?;
    fs::write(index_path(dir), document).map_err(|e| format!("Failed to write index: {e}"))
}

/// Read and decrypt the index, returning `None` when it is missing or cannot
/// be decrypted (wrong key, corrupt file, or written by another vault).
fn read_index(dir: &Path, key: &[u8; 32]) -> Option<BTreeMap<String, String>> {
    let text = fs::read_to_string(index_path(dir)).ok()?;
    let encrypted = xml::from_xml(&text).ok()?;
    let iv = crypto::b64_decode(&encrypted.iv).ok()?;
    let ct = crypto::b64_decode(&encrypted.payload).ok()?;
    let plain = crypto::decrypt(key, &iv, &ct).ok()?;
    Some(unpack_index(&plain))
}

/// Scan every entry file and decrypt its title.
///
/// This is the slow path: it is only used to build the index from scratch, or
/// to repair it when it is missing or stale.
fn scan_entries(dir: &Path, key: &[u8; 32]) -> Result<BTreeMap<String, String>, String> {
    ensure_dir(dir)?;
    let mut entries = BTreeMap::new();

    let read_dir = fs::read_dir(dir).map_err(|e| format!("Failed to read diary directory: {e}"))?;
    for item in read_dir {
        let item = item.map_err(|e| format!("Failed to read directory entry: {e}"))?;
        let path = item.path();
        if path.extension().and_then(|s| s.to_str()) != Some("xml") {
            continue;
        }
        let Some(date) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        // Skip the vault/index files and anything that is not a valid date.
        if validate_date(date).is_err() {
            continue;
        }

        let Ok(text) = fs::read_to_string(&path) else {
            continue;
        };
        let Ok(encrypted) = xml::from_xml(&text) else {
            continue;
        };
        let (Ok(iv), Ok(ct)) = (
            crypto::b64_decode(&encrypted.iv),
            crypto::b64_decode(&encrypted.payload),
        ) else {
            continue;
        };
        let Ok(plain) = crypto::decrypt(key, &iv, &ct) else {
            continue;
        };
        let (title, _) = unpack(&plain, encrypted.legacy_title.as_deref());
        entries.insert(date.to_string(), title);
    }

    Ok(entries)
}

/// Rebuild `index.xml` from the entry files and return the fresh index.
pub fn rebuild_index(dir: &Path, key: &[u8; 32]) -> Result<Vec<EntryMeta>, String> {
    let entries = scan_entries(dir, key)?;
    write_index(dir, key, &entries)?;
    Ok(to_meta(dir, &entries))
}

/// Convert `{date, title}` pairs into sidebar metadata, newest first.
fn to_meta(dir: &Path, entries: &BTreeMap<String, String>) -> Vec<EntryMeta> {
    entries
        .iter()
        .rev()
        .map(|(date, title)| EntryMeta {
            date: date.clone(),
            title: title.clone(),
            size: fs::metadata(dir.join(format!("{date}.xml")))
                .map(|m| m.len())
                .unwrap_or(0),
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Entries
// ---------------------------------------------------------------------------

/// Join the title and the body into the plaintext that gets encrypted.
///
/// The title is normalised to a single line so that the first
/// [`FIELD_SEPARATOR`] always marks the end of the title.
fn pack(title: &str, content: &str) -> Vec<u8> {
    let title = title.replace(['\r', '\n'], " ");
    let mut plain = Vec::with_capacity(title.len() + 1 + content.len());
    plain.extend_from_slice(title.as_bytes());
    plain.push(FIELD_SEPARATOR);
    plain.extend_from_slice(content.as_bytes());
    plain
}

/// Split decrypted plaintext back into `(title, content)`.
///
/// Version 1 files only encrypted the body, so `legacy_title` is used as the
/// title when the payload contains no separator.
fn unpack(plain: &[u8], legacy_title: Option<&str>) -> (String, String) {
    match plain.iter().position(|b| *b == FIELD_SEPARATOR) {
        Some(idx) => {
            let title = String::from_utf8_lossy(&plain[..idx]).to_string();
            let content = String::from_utf8_lossy(&plain[idx + 1..]).to_string();
            (title, content)
        }
        None => (
            legacy_title.unwrap_or_default().to_string(),
            String::from_utf8_lossy(plain).to_string(),
        ),
    }
}

/// Read and decrypt a single entry. Returns `None` when the file is missing.
pub fn read_entry(dir: &Path, key: &[u8; 32], date: &str) -> Result<Option<Entry>, String> {
    let path = entry_path(dir, date)?;
    let text = match fs::read_to_string(&path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("Failed to read entry {date}: {e}")),
    };

    let encrypted = xml::from_xml(&text)?;
    let iv = crypto::b64_decode(&encrypted.iv)?;
    let ct = crypto::b64_decode(&encrypted.payload)?;
    let plain = crypto::decrypt(key, &iv, &ct)?;
    let (title, content) = unpack(&plain, encrypted.legacy_title.as_deref());

    Ok(Some(Entry {
        date: date.to_string(),
        title,
        content,
    }))
}

/// Encrypt and write (create or overwrite) the entry for a given date.
///
/// Because the filename is derived from the date, writing the same date twice
/// naturally performs an upsert: there can only ever be one file per day.
pub fn write_entry(
    dir: &Path,
    key: &[u8; 32],
    date: &str,
    title: &str,
    content: &str,
) -> Result<(), String> {
    ensure_dir(dir)?;
    let path = entry_path(dir, date)?;

    let (iv, ct) = crypto::encrypt(key, &pack(title, content))?;
    let encrypted = EncryptedEntry::new(date, crypto::b64_encode(&iv), crypto::b64_encode(&ct));
    let document = xml::to_xml(&encrypted)?;
    fs::write(&path, document).map_err(|e| format!("Failed to write entry {date}: {e}"))?;

    // Keep the sidebar index in sync. A missing index is rebuilt from scratch
    // so the first write after an upgrade also seeds it.
    let mut index = read_index(dir, key).unwrap_or_else(|| scan_entries(dir, key).unwrap_or_default());
    index.insert(date.to_string(), title.to_string());
    write_index(dir, key, &index)
}

/// Delete the entry for a given date. Missing files are treated as success.
pub fn delete_entry(dir: &Path, key: &[u8; 32], date: &str) -> Result<(), String> {
    let path = entry_path(dir, date)?;
    match fs::remove_file(&path) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("Failed to delete entry {date}: {e}")),
    }

    // Drop the record from the index. If the index is unreadable, rebuild it
    // from the remaining files instead of leaving a stale entry behind.
    let mut index = match read_index(dir, key) {
        Some(index) => index,
        None => scan_entries(dir, key)?,
    };
    index.remove(date);
    write_index(dir, key, &index)
}

/// List all entries, newest first.
///
/// The title lives inside the encrypted payload, so `key` is required. This
/// reads the encrypted `index.xml` (one decryption) instead of every entry
/// file. When the index is missing or unreadable it is rebuilt by scanning the
/// entry files, which also repairs it for next time.
pub fn list_entries(dir: &Path, key: &[u8; 32]) -> Result<Vec<EntryMeta>, String> {
    ensure_dir(dir)?;

    if let Some(index) = read_index(dir, key) {
        return Ok(to_meta(dir, &index));
    }

    // No usable index: fall back to the slow path and persist the result.
    rebuild_index(dir, key)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("fly-diary-test-{name}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Cheap Argon2id parameters so the suite stays fast.
    fn fast() -> crypto::KdfParams {
        crypto::KdfParams {
            memory_kib: 8 * 1024,
            iterations: 1,
            parallelism: 1,
        }
    }

    #[test]
    fn rejects_bad_dates() {
        assert!(validate_date("2026-10-23").is_ok());
        assert!(validate_date("2026-02-30").is_err());
        assert!(validate_date("../../etc/passwd").is_err());
        assert!(validate_date("2026-1-1").is_err());
    }

    #[test]
    fn vault_roundtrip_and_wrong_passphrase() {
        let dir = temp_dir("vault");
        let key = create_vault(&dir, "hunter2", fast()).unwrap();
        assert!(create_vault(&dir, "again", fast()).is_err());

        let unlocked = unlock_vault(&dir, "hunter2").unwrap();
        assert_eq!(key, unlocked);
        assert!(unlock_vault(&dir, "wrong").is_err());
    }

    #[test]
    fn entry_roundtrip_is_encrypted_on_disk() {
        let dir = temp_dir("entry");
        let key = create_vault(&dir, "pw", fast()).unwrap();

        write_entry(&dir, &key, "2026-10-23", "我的標題", "秘密內容").unwrap();

        let raw = fs::read_to_string(dir.join("2026-10-23.xml")).unwrap();
        assert!(!raw.contains("我的標題"), "title must be encrypted");
        assert!(!raw.contains("秘密內容"), "content must be encrypted");
        assert!(!raw.contains("<title>"), "no cleartext title element");
        assert!(raw.contains("<payload>"));

        let entry = read_entry(&dir, &key, "2026-10-23").unwrap().unwrap();
        assert_eq!(entry.title, "我的標題");
        assert_eq!(entry.content, "秘密內容");

        let list = list_entries(&dir, &key).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].title, "我的標題");
    }

    #[test]
    fn title_is_not_readable_without_the_key() {
        let dir = temp_dir("title-secret");
        let key = create_vault(&dir, "pw", fast()).unwrap();
        write_entry(&dir, &key, "2026-10-23", "極機密標題", "body").unwrap();

        // A wrong key must not reveal the title through the listing.
        let wrong = [0u8; 32];
        let list = list_entries(&dir, &wrong).unwrap();
        assert!(list.is_empty(), "undecryptable entries are skipped");
    }

    #[test]
    fn title_with_newlines_is_flattened() {
        let dir = temp_dir("title-newline");
        let key = create_vault(&dir, "pw", fast()).unwrap();
        write_entry(&dir, &key, "2026-10-23", "第一行\n第二行", "body").unwrap();

        let entry = read_entry(&dir, &key, "2026-10-23").unwrap().unwrap();
        assert_eq!(entry.title, "第一行 第二行");
        assert_eq!(entry.content, "body");
    }

    #[test]
    fn content_starting_with_newline_is_preserved() {
        let dir = temp_dir("content-newline");
        let key = create_vault(&dir, "pw", fast()).unwrap();
        write_entry(&dir, &key, "2026-10-23", "t", "\n\nbody").unwrap();

        let entry = read_entry(&dir, &key, "2026-10-23").unwrap().unwrap();
        assert_eq!(entry.title, "t");
        assert_eq!(entry.content, "\n\nbody");
    }

    #[test]
    fn version_1_entry_is_still_readable() {
        let dir = temp_dir("legacy-v1");
        let key = create_vault(&dir, "pw", fast()).unwrap();

        // Hand-build a version 1 file: cleartext title, encrypted body only.
        let (iv, ct) = crypto::encrypt(&key, b"legacy body").unwrap();
        let legacy = format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
             <diary version=\"1\">\n\
             \x20 <title>舊標題</title>\n\
             \x20 <date>2026-10-23</date>\n\
             \x20 <iv>{}</iv>\n\
             \x20 <content>{}</content>\n\
             </diary>\n",
            crypto::b64_encode(&iv),
            crypto::b64_encode(&ct)
        );
        fs::write(dir.join("2026-10-23.xml"), legacy).unwrap();

        let entry = read_entry(&dir, &key, "2026-10-23").unwrap().unwrap();
        assert_eq!(entry.title, "舊標題");
        assert_eq!(entry.content, "legacy body");

        let list = list_entries(&dir, &key).unwrap();
        assert_eq!(list[0].title, "舊標題");

        // Saving rewrites the file in the version 2 layout.
        write_entry(&dir, &key, "2026-10-23", "舊標題", "legacy body").unwrap();
        let raw = fs::read_to_string(dir.join("2026-10-23.xml")).unwrap();
        assert!(!raw.contains("舊標題"));
        assert!(raw.contains("version=\"2\""));
    }

    #[test]
    fn missing_entry_is_none() {
        let dir = temp_dir("missing");
        let key = create_vault(&dir, "pw", fast()).unwrap();
        assert!(read_entry(&dir, &key, "2026-01-01").unwrap().is_none());
    }

    #[test]
    fn validate_date_accepts_leap_day() {
        assert!(validate_date("2024-02-29").is_ok());
        assert!(validate_date("2025-02-29").is_err());
    }

    #[test]
    fn validate_date_rejects_traversal_and_junk() {
        for bad in [
            "",
            "2026-10-2",
            "2026-10-233",
            "../../etc/passwd",
            "2026/10/23",
            "2026-13-01",
            "2026-00-10",
            "abcd-ef-gh",
            "2026-10-23\n",
        ] {
            assert!(validate_date(bad).is_err(), "should reject {bad:?}");
        }
    }

    #[test]
    fn vault_exists_reflects_creation() {
        let dir = temp_dir("vault-exists");
        assert!(!vault_exists(&dir).unwrap());
        create_vault(&dir, "pw", fast()).unwrap();
        assert!(vault_exists(&dir).unwrap());
    }

    #[test]
    fn empty_passphrase_is_rejected() {
        let dir = temp_dir("empty-pass");
        let err = create_vault(&dir, "", fast()).unwrap_err();
        assert!(err.contains("empty"), "got: {err}");
        assert!(!vault_exists(&dir).unwrap());
    }

    #[test]
    fn vault_file_contains_no_plaintext_passphrase() {
        let dir = temp_dir("vault-plaintext");
        create_vault(&dir, "super-secret-passphrase", fast()).unwrap();
        let raw = fs::read_to_string(dir.join("vault.xml")).unwrap();
        assert!(!raw.contains("super-secret-passphrase"));
        assert!(raw.contains("<salt>"));
        assert!(raw.contains("<wrapped-key>"));
    }

    #[test]
    fn vault_file_records_kdf_parameters() {
        let dir = temp_dir("vault-kdf");
        let params = crypto::KdfParams {
            memory_kib: 16 * 1024,
            iterations: 3,
            parallelism: 2,
        };
        create_vault(&dir, "pw", params).unwrap();

        let raw = fs::read_to_string(dir.join("vault.xml")).unwrap();
        assert!(raw.contains("<kdf>argon2id</kdf>"));
        assert!(raw.contains("<kdf-memory>16384</kdf-memory>"));
        assert!(raw.contains("<kdf-iterations>3</kdf-iterations>"));
        assert!(raw.contains("<kdf-parallelism>2</kdf-parallelism>"));
        assert!(raw.contains("version=\"2\""));
    }

    #[test]
    fn vault_file_does_not_contain_the_diary_key() {
        let dir = temp_dir("vault-key-secret");
        let key = create_vault(&dir, "pw", fast()).unwrap();
        let raw = fs::read_to_string(dir.join("vault.xml")).unwrap();
        let encoded = crypto::b64_encode(&key);
        assert!(!raw.contains(&encoded), "diary key must be wrapped");
    }

    #[test]
    fn unlock_returns_the_same_diary_key() {
        let dir = temp_dir("vault-key-stable");
        let created = create_vault(&dir, "pw", fast()).unwrap();
        let unlocked = unlock_vault(&dir, "pw").unwrap();
        assert_eq!(created, unlocked);
    }

    #[test]
    fn create_vault_rejects_invalid_kdf_params() {
        let dir = temp_dir("vault-bad-kdf");
        let bad = crypto::KdfParams {
            memory_kib: 1024,
            ..fast()
        };
        assert!(create_vault(&dir, "pw", bad).is_err());
        assert!(!vault_exists(&dir).unwrap());
    }

    #[test]
    fn legacy_vault_is_migrated_on_unlock() {
        let dir = temp_dir("legacy-migrate");
        let salt_b64 = crypto::new_salt_b64();
        let salt = crypto::b64_decode(&salt_b64).unwrap();
        let legacy_key = crypto::derive_legacy_key("old-pass", &salt);

        // A version 1 vault plus one entry encrypted with the legacy key.
        let (v_iv, v_ct) = crypto::encrypt(&legacy_key, VERIFIER_PLAINTEXT).unwrap();
        let legacy_vault = format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
             <vault version=\"1\">\n\
             \x20 <salt>{salt_b64}</salt>\n\
             \x20 <verifier-iv>{}</verifier-iv>\n\
             \x20 <verifier>{}</verifier>\n\
             </vault>\n",
            crypto::b64_encode(&v_iv),
            crypto::b64_encode(&v_ct)
        );
        fs::write(dir.join("vault.xml"), legacy_vault).unwrap();

        let (e_iv, e_ct) = crypto::encrypt(&legacy_key, b"legacy title\nlegacy body").unwrap();
        let legacy_entry = xml::EncryptedEntry::new(
            "2026-10-23",
            crypto::b64_encode(&e_iv),
            crypto::b64_encode(&e_ct),
        );
        fs::write(
            dir.join("2026-10-23.xml"),
            xml::to_xml(&legacy_entry).unwrap(),
        )
        .unwrap();

        // Unlocking migrates the vault and re-encrypts the entry.
        let new_key = unlock_vault(&dir, "old-pass").unwrap();
        assert_ne!(new_key, *legacy_key);

        let raw_vault = fs::read_to_string(dir.join("vault.xml")).unwrap();
        assert!(raw_vault.contains("version=\"2\""));
        assert!(raw_vault.contains("<kdf>argon2id</kdf>"));

        let entry = read_entry(&dir, &new_key, "2026-10-23").unwrap().unwrap();
        assert_eq!(entry.title, "legacy title");
        assert_eq!(entry.content, "legacy body");

        // The old key no longer decrypts the entry.
        assert!(read_entry(&dir, &legacy_key, "2026-10-23").is_err());

        // And the passphrase still works after migration.
        assert_eq!(unlock_vault(&dir, "old-pass").unwrap(), new_key);
    }

    #[test]
    fn legacy_vault_with_wrong_passphrase_is_not_migrated() {
        let dir = temp_dir("legacy-wrong-pass");
        let salt_b64 = crypto::new_salt_b64();
        let salt = crypto::b64_decode(&salt_b64).unwrap();
        let legacy_key = crypto::derive_legacy_key("right", &salt);
        let (v_iv, v_ct) = crypto::encrypt(&legacy_key, VERIFIER_PLAINTEXT).unwrap();
        let legacy_vault = format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
             <vault version=\"1\">\n\
             \x20 <salt>{salt_b64}</salt>\n\
             \x20 <verifier-iv>{}</verifier-iv>\n\
             \x20 <verifier>{}</verifier>\n\
             </vault>\n",
            crypto::b64_encode(&v_iv),
            crypto::b64_encode(&v_ct)
        );
        fs::write(dir.join("vault.xml"), legacy_vault).unwrap();

        assert!(unlock_vault(&dir, "wrong").is_err());
        let raw = fs::read_to_string(dir.join("vault.xml")).unwrap();
        assert!(raw.contains("version=\"1\""), "vault must stay untouched");
    }

    #[test]
    fn unlock_on_missing_vault_fails() {
        let dir = temp_dir("no-vault");
        let err = unlock_vault(&dir, "pw").unwrap_err();
        assert!(err.contains("No vault"), "got: {err}");
    }

    #[test]
    fn write_entry_overwrites_same_date() {
        let dir = temp_dir("overwrite");
        let key = create_vault(&dir, "pw", fast()).unwrap();

        write_entry(&dir, &key, "2026-10-23", "舊標題", "舊內容").unwrap();
        write_entry(&dir, &key, "2026-10-23", "新標題", "新內容").unwrap();

        let entry = read_entry(&dir, &key, "2026-10-23").unwrap().unwrap();
        assert_eq!(entry.title, "新標題");
        assert_eq!(entry.content, "新內容");

        // Exactly one entry file per day (vault.xml and index.xml are metadata).
        let count = fs::read_dir(&dir)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|e| e.path().extension().and_then(|s| s.to_str()) == Some("xml"))
            .filter(|e| {
                let name = e.file_name();
                let name = name.to_string_lossy();
                name != VAULT_FILE && name != INDEX_FILE
            })
            .count();
        assert_eq!(count, 1);
    }

    #[test]
    fn delete_entry_removes_file_and_is_idempotent() {
        let dir = temp_dir("delete");
        let key = create_vault(&dir, "pw", fast()).unwrap();

        write_entry(&dir, &key, "2026-10-23", "t", "c").unwrap();
        assert!(dir.join("2026-10-23.xml").exists());

        delete_entry(&dir, &key, "2026-10-23").unwrap();
        assert!(!dir.join("2026-10-23.xml").exists());
        assert!(read_entry(&dir, &key, "2026-10-23").unwrap().is_none());

        // Deleting again must not fail.
        delete_entry(&dir, &key, "2026-10-23").unwrap();
    }

    #[test]
    fn delete_entry_rejects_bad_date() {
        let dir = temp_dir("delete-bad");
        let key = create_vault(&dir, "pw", fast()).unwrap();
        assert!(delete_entry(&dir, &key, "../../etc/passwd").is_err());
    }

    #[test]
    fn write_entry_rejects_bad_date() {
        let dir = temp_dir("write-bad");
        let key = create_vault(&dir, "pw", fast()).unwrap();
        assert!(write_entry(&dir, &key, "../evil", "t", "c").is_err());
    }

    #[test]
    fn read_entry_rejects_bad_date() {
        let dir = temp_dir("read-bad");
        let key = create_vault(&dir, "pw", fast()).unwrap();
        assert!(read_entry(&dir, &key, "../../etc/passwd").is_err());
    }

    #[test]
    fn list_entries_is_sorted_newest_first() {
        let dir = temp_dir("sort");
        let key = create_vault(&dir, "pw", fast()).unwrap();

        for date in ["2026-01-05", "2026-10-23", "2025-12-31", "2026-06-15"] {
            write_entry(&dir, &key, date, date, "c").unwrap();
        }

        let list = list_entries(&dir, &key).unwrap();
        let dates: Vec<&str> = list.iter().map(|e| e.date.as_str()).collect();
        assert_eq!(
            dates,
            vec!["2026-10-23", "2026-06-15", "2026-01-05", "2025-12-31"]
        );
    }

    #[test]
    fn list_entries_skips_vault_and_non_date_files() {
        let dir = temp_dir("list-filter");
        let key = create_vault(&dir, "pw", fast()).unwrap();
        write_entry(&dir, &key, "2026-10-23", "t", "c").unwrap();

        fs::write(dir.join("notes.xml"), "<diary/>").unwrap();
        fs::write(dir.join("2026-10-22.md"), "legacy").unwrap();
        fs::write(dir.join("random.txt"), "junk").unwrap();

        let list = list_entries(&dir, &key).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].date, "2026-10-23");
    }

    #[test]
    fn list_entries_requires_the_key_for_titles() {
        let dir = temp_dir("list-locked");
        let key = create_vault(&dir, "pw", fast()).unwrap();
        write_entry(&dir, &key, "2026-10-23", "加密標題", "秘密").unwrap();

        let list = list_entries(&dir, &key).unwrap();
        assert_eq!(list[0].title, "加密標題");
        assert!(list[0].size > 0);
    }

    #[test]
    fn entry_from_another_vault_cannot_be_decrypted() {
        let dir_a = temp_dir("cross-a");
        let dir_b = temp_dir("cross-b");
        let key_a = create_vault(&dir_a, "pw-a", fast()).unwrap();
        let key_b = create_vault(&dir_b, "pw-b", fast()).unwrap();

        write_entry(&dir_a, &key_a, "2026-10-23", "t", "secret").unwrap();

        // Copy the encrypted file into the other vault's directory.
        fs::copy(
            dir_a.join("2026-10-23.xml"),
            dir_b.join("2026-10-23.xml"),
        )
        .unwrap();

        assert!(read_entry(&dir_b, &key_b, "2026-10-23").is_err());
    }

    #[test]
    fn tampered_entry_file_fails_to_decrypt() {
        let dir = temp_dir("tamper");
        let key = create_vault(&dir, "pw", fast()).unwrap();
        write_entry(&dir, &key, "2026-10-23", "t", "secret").unwrap();

        let path = dir.join("2026-10-23.xml");
        let raw = fs::read_to_string(&path).unwrap();
        // Flip a character inside the base64 ciphertext.
        let tampered = raw.replacen("<payload>", "<payload>A", 1);
        assert_ne!(raw, tampered, "payload element must exist");
        fs::write(&path, tampered).unwrap();

        assert!(read_entry(&dir, &key, "2026-10-23").is_err());
    }

    #[test]
    fn corrupt_xml_entry_fails_to_read() {
        let dir = temp_dir("corrupt");
        let key = create_vault(&dir, "pw", fast()).unwrap();
        fs::write(dir.join("2026-10-23.xml"), "not xml at all").unwrap();
        assert!(read_entry(&dir, &key, "2026-10-23").is_err());
    }

    #[test]
    fn empty_title_and_content_roundtrip() {
        let dir = temp_dir("empty-fields");
        let key = create_vault(&dir, "pw", fast()).unwrap();
        write_entry(&dir, &key, "2026-10-23", "", "").unwrap();

        let entry = read_entry(&dir, &key, "2026-10-23").unwrap().unwrap();
        assert_eq!(entry.title, "");
        assert_eq!(entry.content, "");
    }

    #[test]
    fn multiline_markdown_content_roundtrip() {
        let dir = temp_dir("multiline");
        let key = create_vault(&dir, "pw", fast()).unwrap();
        let content = "# 標題\n\n- 項目一\n- 項目二\n\n> 引言\n\n```rust\nfn main() {}\n```";
        write_entry(&dir, &key, "2026-10-23", "Markdown", content).unwrap();

        let entry = read_entry(&dir, &key, "2026-10-23").unwrap().unwrap();
        assert_eq!(entry.content, content);
    }

    #[test]
    fn each_write_uses_a_fresh_iv() {
        let dir = temp_dir("fresh-iv");
        let key = create_vault(&dir, "pw", fast()).unwrap();

        write_entry(&dir, &key, "2026-10-23", "t", "same content").unwrap();
        let first = fs::read_to_string(dir.join("2026-10-23.xml")).unwrap();
        write_entry(&dir, &key, "2026-10-23", "t", "same content").unwrap();
        let second = fs::read_to_string(dir.join("2026-10-23.xml")).unwrap();

        assert_ne!(first, second, "IV must change on every write");
    }
}
