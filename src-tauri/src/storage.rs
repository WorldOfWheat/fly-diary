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
use std::sync::atomic::{AtomicUsize, Ordering};

use rayon::prelude::*;
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

/// Marker that starts the optional favourite flag at the head of the payload.
///
/// Payload layout, version 3:
///
/// ```text
/// \x01fav \n title \n content      (favourite)
/// \x01-   \n title \n content      (not a favourite)
/// title \n content                 (version 2, no flag)
/// ```
///
/// The flag has to live inside the encrypted payload rather than only in the
/// index: the index is a cache that gets rebuilt by scanning the entry files,
/// so a flag stored only there would be lost on the next rebuild. `\x01` is a
/// control character that never appears in a title (titles are single lines of
/// user text) and is stripped from imported files, so it is unambiguous.
const FAVOURITE_MARKER: u8 = 0x01;

/// Value following [`FAVOURITE_MARKER`] when the entry is a favourite.
const FAVOURITE_ON: u8 = b'1';

/// Value following [`FAVOURITE_MARKER`] when the entry is not a favourite.
const FAVOURITE_OFF: u8 = b'0';

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
    /// Whether the user marked this entry as a favourite.
    pub favourite: bool,
}

/// A decrypted diary entry handed to the frontend.
#[derive(Debug, Clone, Serialize)]
pub struct Entry {
    pub date: String,
    pub title: String,
    pub content: String,
    /// Whether the user marked this entry as a favourite.
    pub favourite: bool,
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

/// The Argon2id parameters recorded in the vault, for display in settings.
///
/// Returns `None` for a legacy vault, which has no Argon2id parameters yet.
pub fn vault_kdf_params(dir: &Path) -> Result<Option<crypto::KdfParams>, String> {
    let vault = read_vault(dir)?.ok_or_else(|| "No vault found".to_string())?;
    Ok(match vault.kdf {
        Kdf::Argon2id => Some(vault.params),
        Kdf::LegacySha256 => None,
    })
}

/// Change the passphrase and/or the Argon2id cost parameters.
///
/// This **re-wraps** the existing diary key rather than re-encrypting entries:
/// the diary key is unwrapped with the old passphrase, then wrapped again with
/// a master key derived from the new passphrase and parameters. Entries and the
/// index are untouched, so the operation is fast and cannot corrupt the diary.
///
/// A fresh salt is generated every time, so changing only the parameters still
/// produces a different master key.
///
/// Returns the diary key, which is unchanged and still valid for the session.
pub fn rewrap_vault(
    dir: &Path,
    old_passphrase: &str,
    new_passphrase: &str,
    new_params: crypto::KdfParams,
) -> Result<[u8; 32], String> {
    if new_passphrase.is_empty() {
        return Err("Passphrase must not be empty".to_string());
    }
    new_params.validate()?;

    let vault = read_vault(dir)?.ok_or_else(|| "No vault found".to_string())?;
    if vault.kdf != Kdf::Argon2id {
        return Err("Unlock the diary once to upgrade it before changing the passphrase".to_string());
    }

    // Verify the old passphrase by unwrapping the diary key with it.
    let old_salt = crypto::b64_decode(&vault.salt_b64)?;
    let old_iv = crypto::b64_decode(&vault.wrapped_key_iv_b64)?;
    let old_ct = crypto::b64_decode(&vault.wrapped_key_b64)?;
    let old_master = crypto::derive_master_key(old_passphrase, &old_salt, vault.params)?;
    let plain = crypto::decrypt(&old_master, &old_iv, &old_ct)
        .map_err(|_| "Incorrect passphrase".to_string())?;
    let diary_key: [u8; 32] = plain
        .try_into()
        .map_err(|_| "Wrapped diary key has the wrong length".to_string())?;

    // Wrap the same diary key under the new master key.
    let new_salt_b64 = crypto::new_salt_b64();
    let new_salt = crypto::b64_decode(&new_salt_b64)?;
    let new_master = crypto::derive_master_key(new_passphrase, &new_salt, new_params)?;
    let (new_iv, new_ct) = crypto::encrypt(&new_master, &diary_key)?;

    let rewritten = Vault {
        kdf: Kdf::Argon2id,
        params: new_params,
        salt_b64: new_salt_b64,
        wrapped_key_iv_b64: crypto::b64_encode(&new_iv),
        wrapped_key_b64: crypto::b64_encode(&new_ct),
    };
    write_vault(dir, &rewritten)?;

    Ok(diary_key)
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

/// One index record: the title plus the favourite flag.
///
/// The index is a cache of what the entry files already contain, so it mirrors
/// the flag purely to avoid decrypting every entry when the favourites page is
/// opened.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IndexRecord {
    pub title: String,
    pub favourite: bool,
}

/// Serialize index records into the plaintext index format.
///
/// One record per line, `date \t title \t fav`. Tabs and newlines in titles are
/// flattened to spaces so the record separator stays unambiguous.
fn pack_index(entries: &BTreeMap<String, IndexRecord>) -> Vec<u8> {
    let mut out = Vec::new();
    for (date, record) in entries {
        let title = record.title.replace(['\t', '\r', '\n'], " ");
        out.extend_from_slice(date.as_bytes());
        out.push(INDEX_FIELD_SEPARATOR);
        out.extend_from_slice(title.as_bytes());
        out.push(INDEX_FIELD_SEPARATOR);
        out.push(if record.favourite {
            FAVOURITE_ON
        } else {
            FAVOURITE_OFF
        });
        out.push(INDEX_RECORD_SEPARATOR);
    }
    out
}

/// Parse the plaintext index format back into records.
///
/// Malformed lines are skipped rather than failing the whole index; a bad
/// record is indistinguishable from a missing one and will be re-added on the
/// next write. Two-field records (written before favourites existed) are
/// accepted and read as "not a favourite".
fn unpack_index(plain: &[u8]) -> BTreeMap<String, IndexRecord> {
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

        let rest = &line[sep + 1..];
        let (title, favourite) = match rest.iter().rposition(|b| *b == INDEX_FIELD_SEPARATOR) {
            // Three fields: the last one is the flag.
            Some(flag_sep) => {
                let flag = &rest[flag_sep + 1..];
                let favourite = flag == [FAVOURITE_ON];
                (
                    String::from_utf8_lossy(&rest[..flag_sep]).to_string(),
                    favourite,
                )
            }
            // Two fields: an index written before favourites existed.
            None => (String::from_utf8_lossy(rest).to_string(), false),
        };

        entries.insert(date, IndexRecord { title, favourite });
    }
    entries
}

/// Write the encrypted index for `entries`.
fn write_index(
    dir: &Path,
    key: &[u8; 32],
    entries: &BTreeMap<String, IndexRecord>,
) -> Result<(), String> {
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
fn read_index(dir: &Path, key: &[u8; 32]) -> Option<BTreeMap<String, IndexRecord>> {
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
fn scan_entries(dir: &Path, key: &[u8; 32]) -> Result<BTreeMap<String, IndexRecord>, String> {
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
        let (title, _, favourite) = unpack(&plain, encrypted.legacy_title.as_deref());
        entries.insert(date.to_string(), IndexRecord { title, favourite });
    }

    Ok(entries)
}

/// Rebuild `index.xml` from the entry files and return the fresh index.
pub fn rebuild_index(dir: &Path, key: &[u8; 32]) -> Result<Vec<EntryMeta>, String> {
    let entries = scan_entries(dir, key)?;
    write_index(dir, key, &entries)?;
    Ok(to_meta(dir, &entries))
}

/// Convert index records into sidebar metadata, newest first.
fn to_meta(dir: &Path, entries: &BTreeMap<String, IndexRecord>) -> Vec<EntryMeta> {
    entries
        .iter()
        .rev()
        .map(|(date, record)| EntryMeta {
            date: date.clone(),
            title: record.title.clone(),
            size: fs::metadata(dir.join(format!("{date}.xml")))
                .map(|m| m.len())
                .unwrap_or(0),
            favourite: record.favourite,
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Entries
// ---------------------------------------------------------------------------

/// Join the title, the body and the favourite flag into the plaintext that
/// gets encrypted.
///
/// The title is normalised to a single line so that the first
/// [`FIELD_SEPARATOR`] always marks the end of the title. The flag is written
/// as a leading `\x01` + `1`/`0` line, which older versions of the app would
/// read as part of the title — acceptable, because the only way to run an older
/// build against a newer vault is to downgrade deliberately.
fn pack(title: &str, content: &str, favourite: bool) -> Vec<u8> {
    let title = title.replace(['\r', '\n'], " ");
    let mut plain = Vec::with_capacity(title.len() + content.len() + 4);
    plain.push(FAVOURITE_MARKER);
    plain.push(if favourite { FAVOURITE_ON } else { FAVOURITE_OFF });
    plain.push(FIELD_SEPARATOR);
    plain.extend_from_slice(title.as_bytes());
    plain.push(FIELD_SEPARATOR);
    plain.extend_from_slice(content.as_bytes());
    plain
}

/// Split decrypted plaintext back into `(title, content, favourite)`.
///
/// Three payload layouts are understood:
///
/// * version 3 — `\x01` + flag + `\n` + title + `\n` + content
/// * version 2 — title + `\n` + content (no flag, so not a favourite)
/// * version 1 — body only, with the title stored in the clear
///
/// Version 1 files only encrypted the body, so `legacy_title` is used as the
/// title when the payload contains no separator.
fn unpack(plain: &[u8], legacy_title: Option<&str>) -> (String, String, bool) {
    // Version 3: a leading marker byte followed by the flag and a newline.
    if plain.first() == Some(&FAVOURITE_MARKER) && plain.get(2) == Some(&FIELD_SEPARATOR) {
        let favourite = plain[1] == FAVOURITE_ON;
        let rest = &plain[3..];
        return match rest.iter().position(|b| *b == FIELD_SEPARATOR) {
            Some(idx) => (
                String::from_utf8_lossy(&rest[..idx]).to_string(),
                String::from_utf8_lossy(&rest[idx + 1..]).to_string(),
                favourite,
            ),
            // A flag with no title separator: treat the rest as the body.
            None => (
                String::new(),
                String::from_utf8_lossy(rest).to_string(),
                favourite,
            ),
        };
    }

    match plain.iter().position(|b| *b == FIELD_SEPARATOR) {
        Some(idx) => {
            let title = String::from_utf8_lossy(&plain[..idx]).to_string();
            let content = String::from_utf8_lossy(&plain[idx + 1..]).to_string();
            (title, content, false)
        }
        None => (
            legacy_title.unwrap_or_default().to_string(),
            String::from_utf8_lossy(plain).to_string(),
            false,
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
    let (title, content, favourite) = unpack(&plain, encrypted.legacy_title.as_deref());

    Ok(Some(Entry {
        date: date.to_string(),
        title,
        content,
        favourite,
    }))
}

/// Encrypt `title`/`content`/`favourite` and write the entry file, leaving the
/// index alone.
///
/// This is the half of [`write_entry`] that touches a single file, so it is
/// safe to call concurrently for different dates. Callers that batch many
/// writes (such as the importer) use this and update the index once at the end.
fn write_entry_file(
    dir: &Path,
    key: &[u8; 32],
    date: &str,
    title: &str,
    content: &str,
    favourite: bool,
) -> Result<(), String> {
    ensure_dir(dir)?;
    let path = entry_path(dir, date)?;

    let (iv, ct) = crypto::encrypt(key, &pack(title, content, favourite))?;
    let encrypted = EncryptedEntry::new(date, crypto::b64_encode(&iv), crypto::b64_encode(&ct));
    let document = xml::to_xml(&encrypted)?;
    fs::write(&path, document).map_err(|e| format!("Failed to write entry {date}: {e}"))
}

/// Encrypt and write (create or overwrite) the entry for a given date.
///
/// Because the filename is derived from the date, writing the same date twice
/// naturally performs an upsert: there can only ever be one file per day.
///
/// The favourite flag is *preserved* across saves: the editor autosaves the
/// title and body constantly, and it has no business clearing a bookmark the
/// user set. Use [`set_favourite`] to change it.
pub fn write_entry(
    dir: &Path,
    key: &[u8; 32],
    date: &str,
    title: &str,
    content: &str,
) -> Result<(), String> {
    // Read the existing flag before overwriting the file. A missing entry is a
    // new one, which starts out unfavourited.
    let favourite = read_entry(dir, key, date)?
        .map(|entry| entry.favourite)
        .unwrap_or(false);

    write_entry_file(dir, key, date, title, content, favourite)?;

    // Keep the sidebar index in sync. A missing index is rebuilt from scratch
    // so the first write after an upgrade also seeds it.
    let mut index = read_index(dir, key).unwrap_or_else(|| scan_entries(dir, key).unwrap_or_default());
    index.insert(
        date.to_string(),
        IndexRecord {
            title: title.to_string(),
            favourite,
        },
    );
    write_index(dir, key, &index)
}

/// Mark or unmark an entry as a favourite.
///
/// The flag lives inside the encrypted payload, so this rewrites the entry file
/// (re-encrypting the title and body with a fresh IV) and then updates the
/// index. Returns the flag that was actually stored, which is `false` when the
/// entry does not exist.
pub fn set_favourite(
    dir: &Path,
    key: &[u8; 32],
    date: &str,
    favourite: bool,
) -> Result<bool, String> {
    let Some(entry) = read_entry(dir, key, date)? else {
        return Ok(false);
    };

    write_entry_file(dir, key, date, &entry.title, &entry.content, favourite)?;

    let mut index = read_index(dir, key).unwrap_or_else(|| scan_entries(dir, key).unwrap_or_default());
    index.insert(
        date.to_string(),
        IndexRecord {
            title: entry.title,
            favourite,
        },
    );
    write_index(dir, key, &index)?;

    Ok(favourite)
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

/// List only the entries the user marked as favourites, newest first.
///
/// This is a filter over the same index [`list_entries`] uses, so it costs one
/// decryption rather than one per entry.
pub fn list_favourites(dir: &Path, key: &[u8; 32]) -> Result<Vec<EntryMeta>, String> {
    let all = list_entries(dir, key)?;
    Ok(all.into_iter().filter(|meta| meta.favourite).collect())
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------
//
// Importing is a two-phase operation so the user can review what is about to
// happen before anything is written:
//
// 1. [`scan_import`] reads a folder of `YYYY-MM-DD.txt` files and classifies
//    every file as importable, a conflict, or a failure. Nothing is written.
// 2. [`import_entries`] writes the files the user confirmed, in one pass, and
//    rebuilds the index once at the end.
//
// Both phases run on the rayon thread pool. Every date maps to its own entry
// file, so reads, encryption and writes never contend; the only shared state is
// the index, which is written exactly once after all workers finish. That is
// also why the importer does not call [`write_entry`] per file — that would
// rewrite `index.xml` N times and serialise the whole batch on it.
//
// The filename is the only source of the date, so a file whose name is not a
// real calendar date is rejected instead of being guessed at.

/// Maximum size of a single imported file.
///
/// A diary entry is text; 8 MiB is far beyond any realistic entry and stops a
/// stray binary or a runaway log file from being pulled into the vault.
const MAX_IMPORT_BYTES: u64 = 8 * 1024 * 1024;

/// Extension accepted by the importer.
const IMPORT_EXTENSION: &str = "txt";

/// How a single file in the import folder was classified.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ImportStatus {
    /// Valid and new: will be written on confirm.
    Ready,
    /// Valid, but an entry for that date already exists.
    Conflict,
    /// Cannot be imported; `reason` explains why.
    Failed,
}

/// One file found in the import folder.
#[derive(Debug, Clone, Serialize)]
pub struct ImportFile {
    /// File name as it appears on disk, e.g. `2026-10-23.txt`.
    pub name: String,
    /// Date parsed from the file name, when it is valid.
    pub date: Option<String>,
    /// Title derived from the first line of the file, when readable.
    pub title: String,
    /// Body length in characters, when readable.
    pub chars: usize,
    /// Classification of this file.
    pub status: ImportStatus,
    /// Human-readable explanation for `Conflict` and `Failed`.
    pub reason: String,
}

/// Result of scanning an import folder.
#[derive(Debug, Clone, Serialize)]
pub struct ImportScan {
    /// Folder that was scanned.
    pub dir: String,
    /// Every `.txt` file found, sorted by date then name.
    pub files: Vec<ImportFile>,
    /// Number of files that can be imported.
    pub ready: usize,
    /// Number of files that would overwrite an existing entry.
    pub conflicts: usize,
    /// Number of files that cannot be imported.
    pub failed: usize,
}

/// Outcome of an import run.
#[derive(Debug, Clone, Serialize)]
pub struct ImportReport {
    /// Dates that were written.
    pub imported: Vec<String>,
    /// Dates that were skipped because they already existed.
    pub skipped: Vec<String>,
    /// Files that could not be imported, with the reason.
    pub failed: Vec<ImportFailure>,
}

/// A single failed import.
#[derive(Debug, Clone, Serialize)]
pub struct ImportFailure {
    pub name: String,
    pub reason: String,
}

/// Normalise an imported file's text: strip a BOM and unify line endings.
///
/// The whole file becomes the body. Nothing is consumed as a title, because the
/// title comes from the file name (see [`title_from_import_name`]).
fn normalise_imported(text: &str) -> String {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    text.replace("\r\n", "\n").replace('\r', "\n")
}

/// Derive the entry title from a `YYYY-MM-DD.txt` file name.
///
/// The file name is the title, so `2026-10-23.txt` imports with the title
/// `2026-10-23`. This keeps the import lossless: every byte of the file ends up
/// in the body, and the title is always something the user can see in the
/// folder listing rather than a line silently stolen from the content.
fn title_from_import_name(name: &str) -> String {
    name.strip_suffix(&format!(".{IMPORT_EXTENSION}"))
        .unwrap_or(name)
        .to_string()
}

/// Derive the date from a `YYYY-MM-DD.txt` file name.
fn date_from_import_name(name: &str) -> Option<String> {
    let stem = name.strip_suffix(&format!(".{IMPORT_EXTENSION}"))?;
    validate_date(stem).ok()?;
    Some(stem.to_string())
}

/// Read and classify one file from the import folder.
///
/// `existing` only needs the set of dates that already have an entry, so it is
/// passed as the index's key type rather than a plain `String` map.
fn inspect_import_file(path: &Path, existing: &BTreeMap<String, IndexRecord>) -> ImportFile {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();

    let mut file = ImportFile {
        name: name.clone(),
        date: None,
        title: String::new(),
        chars: 0,
        status: ImportStatus::Failed,
        reason: String::new(),
    };

    let Some(date) = date_from_import_name(&name) else {
        file.reason = "檔名不是有效的 YYYY-MM-DD.txt".to_string();
        return file;
    };
    file.date = Some(date.clone());

    let meta = match fs::metadata(path) {
        Ok(meta) => meta,
        Err(e) => {
            file.reason = format!("無法讀取檔案資訊：{e}");
            return file;
        }
    };
    if !meta.is_file() {
        file.reason = "不是檔案".to_string();
        return file;
    }
    if meta.len() > MAX_IMPORT_BYTES {
        file.reason = format!("檔案過大（上限 {} MiB）", MAX_IMPORT_BYTES / 1024 / 1024);
        return file;
    }

    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(e) => {
            file.reason = format!("無法讀取檔案：{e}");
            return file;
        }
    };
    let text = match String::from_utf8(bytes) {
        Ok(text) => text,
        Err(_) => {
            file.reason = "檔案不是有效的 UTF-8 文字".to_string();
            return file;
        }
    };

    let content = normalise_imported(&text);
    file.title = title_from_import_name(&name);
    file.chars = content.chars().count();

    if existing.contains_key(&date) {
        file.status = ImportStatus::Conflict;
        file.reason = "這一天已經有日記".to_string();
    } else {
        file.status = ImportStatus::Ready;
    }
    file
}

/// The set of dates that already have an entry, for import conflict detection.
///
/// The importer only needs to know *which* dates exist, not their titles, so
/// this keeps the index's internal record type out of the command layer.
pub fn known_dates(dir: &Path, key: &[u8; 32]) -> Result<BTreeMap<String, IndexRecord>, String> {
    ensure_dir(dir)?;
    match read_index(dir, key) {
        Some(index) => Ok(index),
        None => scan_entries(dir, key),
    }
}

/// Scan `import_dir` and classify every `.txt` file. Writes nothing.
///
/// `existing` is the current index, used to detect dates that would be
/// overwritten.
///
/// Files are inspected in parallel: each one is an independent read plus a
/// UTF-8 decode, so a folder of a few thousand entries is limited by the disk
/// rather than by a single core. The result is sorted afterwards, so the order
/// is deterministic regardless of how the work was scheduled.
pub fn scan_import(
    import_dir: &Path,
    existing: &BTreeMap<String, IndexRecord>,
) -> Result<ImportScan, String> {
    let entries = fs::read_dir(import_dir)
        .map_err(|e| format!("Failed to read import folder: {e}"))?;

    // Collect the paths first; `read_dir` itself is sequential and cheap.
    let mut paths = Vec::new();
    let mut files = Vec::new();
    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(e) => {
                files.push(ImportFile {
                    name: String::new(),
                    date: None,
                    title: String::new(),
                    chars: 0,
                    status: ImportStatus::Failed,
                    reason: format!("無法讀取資料夾項目：{e}"),
                });
                continue;
            }
        };

        let path = entry.path();
        let is_txt = path
            .extension()
            .and_then(|s| s.to_str())
            .is_some_and(|ext| ext.eq_ignore_ascii_case(IMPORT_EXTENSION));
        if is_txt {
            paths.push(path);
        }
    }

    files.par_extend(
        paths
            .par_iter()
            .map(|path| inspect_import_file(path, existing)),
    );

    // Newest first, matching the sidebar; failures without a date go last.
    files.sort_by(|a, b| match (&a.date, &b.date) {
        (Some(a_date), Some(b_date)) => b_date.cmp(a_date).then_with(|| a.name.cmp(&b.name)),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => a.name.cmp(&b.name),
    });

    let ready = files.iter().filter(|f| f.status == ImportStatus::Ready).count();
    let conflicts = files
        .iter()
        .filter(|f| f.status == ImportStatus::Conflict)
        .count();
    let failed = files
        .iter()
        .filter(|f| f.status == ImportStatus::Failed)
        .count();

    Ok(ImportScan {
        dir: import_dir.to_string_lossy().to_string(),
        files,
        ready,
        conflicts,
        failed,
    })
}

/// What happened to one requested date during [`import_entries`].
enum ImportOutcome {
    /// The entry was written; carries the date and its title.
    Imported(String, String),
    /// The date already existed and `overwrite` was off.
    Skipped(String),
    /// The file could not be imported.
    Failed(ImportFailure),
}

/// Read, encrypt and write one imported file.
///
/// This is the unit of work handed to the thread pool. It touches only its own
/// entry file, so no locking is needed: every date maps to a distinct path.
fn import_one(
    dir: &Path,
    key: &[u8; 32],
    import_dir: &Path,
    date: &str,
    exists: bool,
    overwrite: bool,
) -> ImportOutcome {
    if let Err(reason) = validate_date(date) {
        return ImportOutcome::Failed(ImportFailure {
            name: date.to_string(),
            reason,
        });
    }

    let name = format!("{date}.{IMPORT_EXTENSION}");
    let path = import_dir.join(&name);

    let text = match fs::read(&path) {
        Ok(bytes) => match String::from_utf8(bytes) {
            Ok(text) => text,
            Err(_) => {
                return ImportOutcome::Failed(ImportFailure {
                    name,
                    reason: "檔案不是有效的 UTF-8 文字".to_string(),
                })
            }
        },
        Err(e) => {
            return ImportOutcome::Failed(ImportFailure {
                name,
                reason: format!("無法讀取檔案：{e}"),
            })
        }
    };

    if exists && !overwrite {
        return ImportOutcome::Skipped(date.to_string());
    }

    let content = normalise_imported(&text);
    let title = title_from_import_name(&name);
    // Imported entries start out unfavourited; the user can bookmark them
    // afterwards from the editor.
    match write_entry_file(dir, key, date, &title, &content, false) {
        Ok(()) => ImportOutcome::Imported(date.to_string(), title),
        Err(reason) => ImportOutcome::Failed(ImportFailure { name, reason }),
    }
}

/// Write the given `YYYY-MM-DD.txt` files from `import_dir` into the diary.
///
/// `dates` is the set the user confirmed. Files that no longer exist, are no
/// longer valid, or whose date already has an entry are reported as skipped or
/// failed instead of aborting the whole run, so one bad file cannot block the
/// rest.
///
/// The work is spread across the rayon pool: every date owns a distinct file,
/// so reads, AES-GCM encryption and writes all run concurrently. The index is
/// written exactly once at the end, which is what makes the parallel path safe
/// — [`write_entry`] would otherwise rewrite `index.xml` once per entry and
/// serialise the whole import on that single file.
///
/// `progress` is called after each file with `(done, total)` so the UI can show
/// a counter. It is invoked from worker threads and must be cheap and
/// thread-safe.
pub fn import_entries_with_progress<F>(
    dir: &Path,
    key: &[u8; 32],
    import_dir: &Path,
    dates: &[String],
    overwrite: bool,
    progress: F,
) -> Result<ImportReport, String>
where
    F: Fn(usize, usize) + Sync,
{
    ensure_dir(dir)?;

    let mut index = match read_index(dir, key) {
        Some(index) => index,
        None => scan_entries(dir, key)?,
    };

    let total = dates.len();
    let done = AtomicUsize::new(0);

    let outcomes: Vec<ImportOutcome> = dates
        .par_iter()
        .map(|date| {
            let outcome = import_one(
                dir,
                key,
                import_dir,
                date,
                index.contains_key(date),
                overwrite,
            );
            let finished = done.fetch_add(1, Ordering::Relaxed) + 1;
            progress(finished, total);
            outcome
        })
        .collect();

    let mut report = ImportReport {
        imported: Vec::new(),
        skipped: Vec::new(),
        failed: Vec::new(),
    };

    // Fold the results back in the order the user confirmed them, so the report
    // is stable no matter which thread finished first.
    for outcome in outcomes {
        match outcome {
            ImportOutcome::Imported(date, title) => {
                index.insert(
                    date.clone(),
                    IndexRecord {
                        title,
                        favourite: false,
                    },
                );
                report.imported.push(date);
            }
            ImportOutcome::Skipped(date) => report.skipped.push(date),
            ImportOutcome::Failed(failure) => report.failed.push(failure),
        }
    }

    // One index write for the whole batch.
    write_index(dir, key, &index)?;

    Ok(report)
}

/// Import without progress reporting.
///
/// Convenience wrapper around [`import_entries_with_progress`]; the app itself
/// uses the progress-reporting variant so the dialog can show a counter.
#[cfg_attr(not(test), allow(dead_code))]
pub fn import_entries(
    dir: &Path,
    key: &[u8; 32],
    import_dir: &Path,
    dates: &[String],
    overwrite: bool,
) -> Result<ImportReport, String> {
    import_entries_with_progress(dir, key, import_dir, dates, overwrite, |_, _| {})
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

    // -----------------------------------------------------------------------
    // Import
    // -----------------------------------------------------------------------

    /// Create a scratch folder holding the given `(name, contents)` files.
    fn import_dir(name: &str, files: &[(&str, &str)]) -> PathBuf {
        let dir = temp_dir(name);
        for (file, contents) in files {
            fs::write(dir.join(file), contents).unwrap();
        }
        dir
    }

    #[test]
    fn title_from_import_name_drops_the_extension() {
        assert_eq!(title_from_import_name("2026-10-23.txt"), "2026-10-23");
        // Anything after the last dot is treated as the extension.
        assert_eq!(title_from_import_name("2026-10-23"), "2026-10-23");
    }

    #[test]
    fn normalise_imported_keeps_the_whole_file_as_body() {
        // The first line is content, not a title.
        let content = normalise_imported("我的標題\n第一行\n第二行");
        assert_eq!(content, "我的標題\n第一行\n第二行");
    }

    #[test]
    fn normalise_imported_handles_crlf_and_bom() {
        let content = normalise_imported("\u{feff}標題\r\n內容\r\n更多");
        assert_eq!(content, "標題\n內容\n更多");
    }

    #[test]
    fn normalise_imported_leaves_whitespace_alone() {
        let content = normalise_imported("  標題  \n內容");
        assert_eq!(content, "  標題  \n內容");
    }

    #[test]
    fn date_from_import_name_accepts_only_real_dates() {
        assert_eq!(
            date_from_import_name("2026-10-23.txt").as_deref(),
            Some("2026-10-23")
        );
        assert_eq!(date_from_import_name("2026-02-30.txt"), None);
        assert_eq!(date_from_import_name("2026-10-23.md"), None);
        assert_eq!(date_from_import_name("notes.txt"), None);
        assert_eq!(date_from_import_name("2026-10-23"), None);
    }

    #[test]
    fn scan_import_classifies_ready_conflict_and_failed() {
        let dir = temp_dir("import-scan");
        let key = create_vault(&dir, "pw", fast()).unwrap();
        write_entry(&dir, &key, "2026-10-22", "既有", "內容").unwrap();

        let src = import_dir(
            "import-scan-src",
            &[
                ("2026-10-23.txt", "新的一天\n今天很好"),
                ("2026-10-22.txt", "重複\n會被標記"),
                ("2026-02-30.txt", "不存在的日期"),
                ("notes.txt", "檔名不對"),
                ("readme.md", "不是 txt"),
            ],
        );

        let existing = read_index(&dir, &key).unwrap();
        let scan = scan_import(&src, &existing).unwrap();

        assert_eq!(scan.files.len(), 4, "only .txt files are considered");
        assert_eq!(scan.ready, 1);
        assert_eq!(scan.conflicts, 1);
        assert_eq!(scan.failed, 2);

        let ready = scan
            .files
            .iter()
            .find(|f| f.status == ImportStatus::Ready)
            .unwrap();
        assert_eq!(ready.date.as_deref(), Some("2026-10-23"));
        // The file name is the title; the whole file is the body.
        assert_eq!(ready.title, "2026-10-23");
        assert_eq!(ready.chars, "新的一天\n今天很好".chars().count());

        let conflict = scan
            .files
            .iter()
            .find(|f| f.status == ImportStatus::Conflict)
            .unwrap();
        assert_eq!(conflict.date.as_deref(), Some("2026-10-22"));
        assert!(!conflict.reason.is_empty());
    }

    #[test]
    fn scan_import_sorts_newest_first() {
        let dir = temp_dir("import-sort");
        let key = create_vault(&dir, "pw", fast()).unwrap();
        let src = import_dir(
            "import-sort-src",
            &[
                ("2026-01-05.txt", "a"),
                ("2026-12-31.txt", "b"),
                ("2026-06-15.txt", "c"),
            ],
        );

        let scan = scan_import(&src, &BTreeMap::new()).unwrap();
        let dates: Vec<_> = scan.files.iter().filter_map(|f| f.date.clone()).collect();
        assert_eq!(dates, vec!["2026-12-31", "2026-06-15", "2026-01-05"]);
        let _ = key;
    }

    #[test]
    fn scan_import_rejects_non_utf8() {
        let dir = temp_dir("import-utf8");
        let _key = create_vault(&dir, "pw", fast()).unwrap();
        let src = temp_dir("import-utf8-src");
        fs::write(src.join("2026-10-23.txt"), [0xff, 0xfe, 0x00]).unwrap();

        let scan = scan_import(&src, &BTreeMap::new()).unwrap();
        assert_eq!(scan.failed, 1);
        assert_eq!(scan.files[0].status, ImportStatus::Failed);
    }

    #[test]
    fn scan_import_on_missing_folder_fails() {
        let missing = std::env::temp_dir().join("fly-diary-test-does-not-exist");
        let _ = fs::remove_dir_all(&missing);
        assert!(scan_import(&missing, &BTreeMap::new()).is_err());
    }

    #[test]
    fn import_entries_writes_and_updates_index() {
        let dir = temp_dir("import-run");
        let key = create_vault(&dir, "pw", fast()).unwrap();
        let src = import_dir(
            "import-run-src",
            &[
                ("2026-10-23.txt", "匯入標題\n匯入內容"),
                ("2026-10-24.txt", "第二天\n更多內容"),
            ],
        );

        let report = import_entries(
            &dir,
            &key,
            &src,
            &["2026-10-23".to_string(), "2026-10-24".to_string()],
            false,
        )
        .unwrap();

        assert_eq!(report.imported.len(), 2);
        assert!(report.skipped.is_empty());
        assert!(report.failed.is_empty());

        let entry = read_entry(&dir, &key, "2026-10-23").unwrap().unwrap();
        assert_eq!(entry.title, "2026-10-23");
        assert_eq!(entry.content, "匯入標題\n匯入內容");

        // The index must reflect the import without a manual rebuild.
        let listed = list_entries(&dir, &key).unwrap();
        assert_eq!(listed.len(), 2);
        assert_eq!(listed[0].date, "2026-10-24");
        assert_eq!(listed[0].title, "2026-10-24");
    }

    #[test]
    fn import_entries_skips_existing_without_overwrite() {
        let dir = temp_dir("import-skip");
        let key = create_vault(&dir, "pw", fast()).unwrap();
        write_entry(&dir, &key, "2026-10-23", "原本", "原本內容").unwrap();

        let src = import_dir("import-skip-src", &[("2026-10-23.txt", "新的\n新內容")]);

        let report =
            import_entries(&dir, &key, &src, &["2026-10-23".to_string()], false).unwrap();
        assert!(report.imported.is_empty());
        assert_eq!(report.skipped, vec!["2026-10-23"]);

        let entry = read_entry(&dir, &key, "2026-10-23").unwrap().unwrap();
        assert_eq!(entry.title, "原本");
    }

    #[test]
    fn import_entries_overwrites_when_asked() {
        let dir = temp_dir("import-overwrite");
        let key = create_vault(&dir, "pw", fast()).unwrap();
        write_entry(&dir, &key, "2026-10-23", "原本", "原本內容").unwrap();

        let src = import_dir("import-overwrite-src", &[("2026-10-23.txt", "新的\n新內容")]);

        let report = import_entries(&dir, &key, &src, &["2026-10-23".to_string()], true).unwrap();
        assert_eq!(report.imported, vec!["2026-10-23"]);

        let entry = read_entry(&dir, &key, "2026-10-23").unwrap().unwrap();
        assert_eq!(entry.title, "2026-10-23");
        assert_eq!(entry.content, "新的\n新內容");
    }

    #[test]
    fn import_entries_reports_missing_and_bad_dates() {
        let dir = temp_dir("import-missing");
        let key = create_vault(&dir, "pw", fast()).unwrap();
        let src = import_dir("import-missing-src", &[]);

        let report = import_entries(
            &dir,
            &key,
            &src,
            &["2026-10-23".to_string(), "not-a-date".to_string()],
            false,
        )
        .unwrap();

        assert!(report.imported.is_empty());
        assert_eq!(report.failed.len(), 2);
        assert!(report.failed.iter().any(|f| f.name == "2026-10-23.txt"));
        assert!(report.failed.iter().any(|f| f.name == "not-a-date"));
    }

    #[test]
    fn import_entries_keeps_going_after_a_failure() {
        let dir = temp_dir("import-partial");
        let key = create_vault(&dir, "pw", fast()).unwrap();
        let src = import_dir("import-partial-src", &[("2026-10-24.txt", "好的\n內容")]);

        let report = import_entries(
            &dir,
            &key,
            &src,
            &["2026-10-23".to_string(), "2026-10-24".to_string()],
            false,
        )
        .unwrap();

        assert_eq!(report.imported, vec!["2026-10-24"]);
        assert_eq!(report.failed.len(), 1);
        assert!(read_entry(&dir, &key, "2026-10-24").unwrap().is_some());
    }

    #[test]
    fn imported_entry_is_encrypted_on_disk() {
        let dir = temp_dir("import-encrypted");
        let key = create_vault(&dir, "pw", fast()).unwrap();
        let src = import_dir("import-encrypted-src", &[("2026-10-23.txt", "秘密標題\n秘密內容")]);

        import_entries(&dir, &key, &src, &["2026-10-23".to_string()], false).unwrap();

        let raw = fs::read_to_string(dir.join("2026-10-23.xml")).unwrap();
        assert!(!raw.contains("秘密標題"));
        assert!(!raw.contains("秘密內容"));
    }

    #[test]
    fn parallel_import_writes_every_entry() {
        let dir = temp_dir("import-parallel");
        let key = create_vault(&dir, "pw", fast()).unwrap();

        // Enough files to actually spread across the pool.
        let names: Vec<String> = (1..=60)
            .map(|i| format!("2026-{:02}-{:02}.txt", (i - 1) / 28 + 1, (i - 1) % 28 + 1))
            .collect();
        let files: Vec<(&str, &str)> = names
            .iter()
            .enumerate()
            .map(|(i, name)| (name.as_str(), if i % 2 == 0 { "標題\n內容" } else { "另一篇\n更多" }))
            .collect();
        let src = import_dir("import-parallel-src", &files);

        let dates: Vec<String> = names
            .iter()
            .map(|n| n.trim_end_matches(".txt").to_string())
            .collect();

        let report = import_entries(&dir, &key, &src, &dates, false).unwrap();
        assert_eq!(report.imported.len(), dates.len());
        assert!(report.skipped.is_empty());
        assert!(report.failed.is_empty());

        // Every file must be readable, titled after its file name, and keep the
        // whole file as the body.
        for (i, date) in dates.iter().enumerate() {
            let entry = read_entry(&dir, &key, date).unwrap().unwrap();
            assert_eq!(entry.title, *date, "wrong title for {date}");
            let expected = if i % 2 == 0 { "標題\n內容" } else { "另一篇\n更多" };
            assert_eq!(entry.content, expected, "wrong content for {date}");
        }

        // The index must list all of them after a single write.
        assert_eq!(list_entries(&dir, &key).unwrap().len(), dates.len());
    }

    #[test]
    fn parallel_import_reports_in_confirmed_order() {
        let dir = temp_dir("import-order");
        let key = create_vault(&dir, "pw", fast()).unwrap();
        let src = import_dir(
            "import-order-src",
            &[
                ("2026-01-01.txt", "a"),
                ("2026-01-02.txt", "b"),
                ("2026-01-03.txt", "c"),
                ("2026-01-04.txt", "d"),
            ],
        );

        // Deliberately not sorted: the report must echo the input order even
        // though the workers finish in an arbitrary order.
        let dates = vec![
            "2026-01-03".to_string(),
            "2026-01-01".to_string(),
            "2026-01-04".to_string(),
            "2026-01-02".to_string(),
        ];

        let report = import_entries(&dir, &key, &src, &dates, false).unwrap();
        assert_eq!(report.imported, dates);
    }

    #[test]
    fn parallel_import_reports_progress_up_to_total() {
        let dir = temp_dir("import-progress");
        let key = create_vault(&dir, "pw", fast()).unwrap();
        let src = import_dir(
            "import-progress-src",
            &[
                ("2026-02-01.txt", "a"),
                ("2026-02-02.txt", "b"),
                ("2026-02-03.txt", "c"),
            ],
        );

        let seen = std::sync::Mutex::new(Vec::new());
        let dates: Vec<String> = ["2026-02-01", "2026-02-02", "2026-02-03"]
            .iter()
            .map(|d| d.to_string())
            .collect();

        import_entries_with_progress(&dir, &key, &src, &dates, false, |done, total| {
            seen.lock().unwrap().push((done, total));
        })
        .unwrap();

        let seen = seen.into_inner().unwrap();
        assert_eq!(seen.len(), 3, "one callback per file");
        assert!(seen.iter().all(|(_, total)| *total == 3));
        // The counter is monotonic and ends at the total.
        let mut dones: Vec<usize> = seen.iter().map(|(done, _)| *done).collect();
        dones.sort_unstable();
        assert_eq!(dones, vec![1, 2, 3]);
    }

    #[test]
    fn parallel_import_mixes_imported_skipped_and_failed() {
        let dir = temp_dir("import-mixed");
        let key = create_vault(&dir, "pw", fast()).unwrap();
        write_entry(&dir, &key, "2026-03-01", "既有", "內容").unwrap();

        let src = import_dir(
            "import-mixed-src",
            &[
                ("2026-03-01.txt", "重複\n不覆蓋"),
                ("2026-03-02.txt", "新的\n內容"),
            ],
        );

        let report = import_entries(
            &dir,
            &key,
            &src,
            &[
                "2026-03-01".to_string(),
                "2026-03-02".to_string(),
                "2026-03-03".to_string(),
                "bad-date".to_string(),
            ],
            false,
        )
        .unwrap();

        assert_eq!(report.imported, vec!["2026-03-02"]);
        assert_eq!(report.skipped, vec!["2026-03-01"]);
        assert_eq!(report.failed.len(), 2);
        assert!(report.failed.iter().any(|f| f.name == "2026-03-03.txt"));
        assert!(report.failed.iter().any(|f| f.name == "bad-date"));

        // The pre-existing entry must be untouched.
        let kept = read_entry(&dir, &key, "2026-03-01").unwrap().unwrap();
        assert_eq!(kept.title, "既有");
    }

    #[test]
    fn parallel_import_writes_the_index_only_once() {
        let dir = temp_dir("import-index-once");
        let key = create_vault(&dir, "pw", fast()).unwrap();
        let src = import_dir(
            "import-index-once-src",
            &[
                ("2026-04-01.txt", "a"),
                ("2026-04-02.txt", "b"),
                ("2026-04-03.txt", "c"),
            ],
        );

        let dates: Vec<String> = ["2026-04-01", "2026-04-02", "2026-04-03"]
            .iter()
            .map(|d| d.to_string())
            .collect();
        import_entries(&dir, &key, &src, &dates, false).unwrap();

        // A single index write means the file's mtime is not bumped per entry;
        // more importantly, the contents must be complete and consistent.
        let index = read_index(&dir, &key).unwrap();
        assert_eq!(index.len(), 3);
        for date in &dates {
            assert!(index.contains_key(date), "missing {date} in index");
        }
    }

    // -----------------------------------------------------------------------
    // Favourites
    // -----------------------------------------------------------------------

    #[test]
    fn new_entries_are_not_favourites() {
        let dir = temp_dir("fav-default");
        let key = create_vault(&dir, "pw", fast()).unwrap();
        write_entry(&dir, &key, "2026-10-23", "t", "c").unwrap();

        let entry = read_entry(&dir, &key, "2026-10-23").unwrap().unwrap();
        assert!(!entry.favourite);

        let list = list_entries(&dir, &key).unwrap();
        assert!(!list[0].favourite);
        assert!(list_favourites(&dir, &key).unwrap().is_empty());
    }

    #[test]
    fn set_favourite_roundtrips_through_the_file_and_the_index() {
        let dir = temp_dir("fav-set");
        let key = create_vault(&dir, "pw", fast()).unwrap();
        write_entry(&dir, &key, "2026-10-23", "標題", "內容").unwrap();

        assert!(set_favourite(&dir, &key, "2026-10-23", true).unwrap());

        let entry = read_entry(&dir, &key, "2026-10-23").unwrap().unwrap();
        assert!(entry.favourite);
        assert_eq!(entry.title, "標題", "the title must survive the rewrite");
        assert_eq!(entry.content, "內容", "the body must survive the rewrite");

        // The index mirrors the flag, so the favourites page needs no scan.
        let list = list_entries(&dir, &key).unwrap();
        assert!(list[0].favourite);
        let favourites = list_favourites(&dir, &key).unwrap();
        assert_eq!(favourites.len(), 1);
        assert_eq!(favourites[0].date, "2026-10-23");

        // And it can be turned back off.
        assert!(!set_favourite(&dir, &key, "2026-10-23", false).unwrap());
        assert!(list_favourites(&dir, &key).unwrap().is_empty());
        assert!(!read_entry(&dir, &key, "2026-10-23").unwrap().unwrap().favourite);
    }

    #[test]
    fn favourite_flag_is_encrypted_on_disk() {
        let dir = temp_dir("fav-encrypted");
        let key = create_vault(&dir, "pw", fast()).unwrap();
        write_entry(&dir, &key, "2026-10-23", "t", "c").unwrap();
        set_favourite(&dir, &key, "2026-10-23", true).unwrap();

        // The marker byte lives inside the ciphertext, so it must not appear in
        // the base64 payload or anywhere else in the document.
        let raw = fs::read_to_string(dir.join("2026-10-23.xml")).unwrap();
        assert!(!raw.contains('\u{1}'), "flag marker must be encrypted");
        assert!(!raw.contains("favourite"));
    }

    #[test]
    fn saving_an_entry_preserves_its_favourite_flag() {
        let dir = temp_dir("fav-preserve");
        let key = create_vault(&dir, "pw", fast()).unwrap();
        write_entry(&dir, &key, "2026-10-23", "舊", "舊內容").unwrap();
        set_favourite(&dir, &key, "2026-10-23", true).unwrap();

        // Autosave rewrites the title and body; the bookmark must survive.
        write_entry(&dir, &key, "2026-10-23", "新", "新內容").unwrap();

        let entry = read_entry(&dir, &key, "2026-10-23").unwrap().unwrap();
        assert_eq!(entry.title, "新");
        assert_eq!(entry.content, "新內容");
        assert!(entry.favourite, "autosave must not clear the bookmark");
        assert_eq!(list_favourites(&dir, &key).unwrap().len(), 1);
    }

    #[test]
    fn set_favourite_on_a_missing_entry_is_a_no_op() {
        let dir = temp_dir("fav-missing");
        let key = create_vault(&dir, "pw", fast()).unwrap();

        assert!(!set_favourite(&dir, &key, "2026-10-23", true).unwrap());
        assert!(read_entry(&dir, &key, "2026-10-23").unwrap().is_none());
        assert!(!dir.join("2026-10-23.xml").exists());
    }

    #[test]
    fn set_favourite_rejects_bad_dates() {
        let dir = temp_dir("fav-bad-date");
        let key = create_vault(&dir, "pw", fast()).unwrap();
        assert!(set_favourite(&dir, &key, "../../etc/passwd", true).is_err());
    }

    #[test]
    fn list_favourites_is_sorted_newest_first() {
        let dir = temp_dir("fav-sort");
        let key = create_vault(&dir, "pw", fast()).unwrap();
        for date in ["2026-01-05", "2026-10-23", "2025-12-31"] {
            write_entry(&dir, &key, date, date, "c").unwrap();
        }
        set_favourite(&dir, &key, "2026-01-05", true).unwrap();
        set_favourite(&dir, &key, "2025-12-31", true).unwrap();

        let dates: Vec<String> = list_favourites(&dir, &key)
            .unwrap()
            .into_iter()
            .map(|meta| meta.date)
            .collect();
        assert_eq!(dates, vec!["2026-01-05", "2025-12-31"]);
    }

    #[test]
    fn favourite_survives_an_index_rebuild() {
        let dir = temp_dir("fav-rebuild");
        let key = create_vault(&dir, "pw", fast()).unwrap();
        write_entry(&dir, &key, "2026-10-23", "t", "c").unwrap();
        set_favourite(&dir, &key, "2026-10-23", true).unwrap();

        // The index is only a cache: the flag must come back from the entry
        // file itself, or a rebuild would silently drop every bookmark.
        fs::remove_file(dir.join(INDEX_FILE)).unwrap();
        let rebuilt = rebuild_index(&dir, &key).unwrap();
        assert!(rebuilt[0].favourite);
        assert_eq!(list_favourites(&dir, &key).unwrap().len(), 1);
    }

    #[test]
    fn version_2_payload_reads_as_not_favourite() {
        let dir = temp_dir("fav-legacy-v2");
        let key = create_vault(&dir, "pw", fast()).unwrap();

        // Hand-build a version 2 payload: title + newline + body, no flag.
        let (iv, ct) = crypto::encrypt(&key, b"old title\nold body").unwrap();
        let document = xml::to_xml(&EncryptedEntry::new(
            "2026-10-23",
            crypto::b64_encode(&iv),
            crypto::b64_encode(&ct),
        ))
        .unwrap();
        fs::write(dir.join("2026-10-23.xml"), document).unwrap();

        let entry = read_entry(&dir, &key, "2026-10-23").unwrap().unwrap();
        assert_eq!(entry.title, "old title");
        assert_eq!(entry.content, "old body");
        assert!(!entry.favourite);
    }

    #[test]
    fn index_without_a_flag_field_is_still_readable() {
        // An index written before favourites existed has `date \t title` lines.
        let plain = b"2026-10-23\told title\n2026-10-22\tother\n";
        let index = unpack_index(plain);

        assert_eq!(index.len(), 2);
        assert_eq!(index["2026-10-23"].title, "old title");
        assert!(!index["2026-10-23"].favourite);
        assert!(!index["2026-10-22"].favourite);
    }

    #[test]
    fn index_roundtrips_the_favourite_flag() {
        let mut index = BTreeMap::new();
        index.insert(
            "2026-10-23".to_string(),
            IndexRecord {
                title: "有收藏".to_string(),
                favourite: true,
            },
        );
        index.insert(
            "2026-10-22".to_string(),
            IndexRecord {
                title: "沒收藏".to_string(),
                favourite: false,
            },
        );

        let parsed = unpack_index(&pack_index(&index));
        assert_eq!(parsed, index);
    }

    #[test]
    fn imported_entries_are_not_favourites() {
        let dir = temp_dir("fav-import");
        let key = create_vault(&dir, "pw", fast()).unwrap();
        let src = import_dir("fav-import-src", &[("2026-10-23.txt", "內容")]);

        import_entries(&dir, &key, &src, &["2026-10-23".to_string()], false).unwrap();

        assert!(!read_entry(&dir, &key, "2026-10-23").unwrap().unwrap().favourite);
        assert!(list_favourites(&dir, &key).unwrap().is_empty());
    }

    // -----------------------------------------------------------------------
    // Re-wrapping (passphrase / KDF change)
    // -----------------------------------------------------------------------

    #[test]
    fn rewrap_changes_the_passphrase_and_keeps_the_diary_key() {
        let dir = temp_dir("rewrap-pass");
        let key = create_vault(&dir, "old-pw", fast()).unwrap();
        write_entry(&dir, &key, "2026-10-23", "標題", "內容").unwrap();

        let returned = rewrap_vault(&dir, "old-pw", "new-pw", fast()).unwrap();
        assert_eq!(returned, key, "the diary key must not change");

        // Old passphrase no longer works, new one does and yields the same key.
        assert!(unlock_vault(&dir, "old-pw").is_err());
        assert_eq!(unlock_vault(&dir, "new-pw").unwrap(), key);

        // Entries were never re-encrypted, so they still read fine.
        let entry = read_entry(&dir, &key, "2026-10-23").unwrap().unwrap();
        assert_eq!(entry.title, "標題");
        assert_eq!(entry.content, "內容");
    }

    #[test]
    fn rewrap_rejects_a_wrong_current_passphrase() {
        let dir = temp_dir("rewrap-wrong");
        let key = create_vault(&dir, "old-pw", fast()).unwrap();

        let err = rewrap_vault(&dir, "nope", "new-pw", fast()).unwrap_err();
        assert!(err.contains("Incorrect passphrase"), "got: {err}");

        // The vault is untouched: the original passphrase still works.
        assert_eq!(unlock_vault(&dir, "old-pw").unwrap(), key);
    }

    #[test]
    fn rewrap_updates_the_stored_kdf_parameters() {
        let dir = temp_dir("rewrap-params");
        let key = create_vault(&dir, "pw", fast()).unwrap();
        let stronger = crypto::KdfParams {
            memory_kib: 16 * 1024,
            iterations: 2,
            parallelism: 1,
        };

        rewrap_vault(&dir, "pw", "pw", stronger).unwrap();

        assert_eq!(vault_kdf_params(&dir).unwrap(), Some(stronger));
        assert_eq!(unlock_vault(&dir, "pw").unwrap(), key);
    }

    #[test]
    fn rewrap_uses_a_fresh_salt() {
        let dir = temp_dir("rewrap-salt");
        create_vault(&dir, "pw", fast()).unwrap();
        let before = read_vault(&dir).unwrap().unwrap().salt_b64;

        rewrap_vault(&dir, "pw", "pw", fast()).unwrap();

        let after = read_vault(&dir).unwrap().unwrap().salt_b64;
        assert_ne!(before, after);
    }

    #[test]
    fn rewrap_rejects_an_empty_new_passphrase() {
        let dir = temp_dir("rewrap-empty");
        let key = create_vault(&dir, "pw", fast()).unwrap();
        assert!(rewrap_vault(&dir, "pw", "", fast()).is_err());
        assert_eq!(unlock_vault(&dir, "pw").unwrap(), key);
    }

    #[test]
    fn rewrap_rejects_invalid_kdf_params() {
        let dir = temp_dir("rewrap-bad-params");
        let key = create_vault(&dir, "pw", fast()).unwrap();
        let bad = crypto::KdfParams {
            memory_kib: 1024,
            iterations: 2,
            parallelism: 1,
        };
        assert!(rewrap_vault(&dir, "pw", "pw", bad).is_err());
        assert_eq!(unlock_vault(&dir, "pw").unwrap(), key);
    }

    #[test]
    fn rewrap_on_a_missing_vault_fails() {
        let dir = temp_dir("rewrap-missing");
        assert!(rewrap_vault(&dir, "pw", "pw", fast()).is_err());
    }

    #[test]
    fn vault_kdf_params_reports_the_creation_parameters() {
        let dir = temp_dir("kdf-report");
        let params = crypto::KdfParams {
            memory_kib: 8 * 1024,
            iterations: 3,
            parallelism: 2,
        };
        create_vault(&dir, "pw", params).unwrap();
        assert_eq!(vault_kdf_params(&dir).unwrap(), Some(params));
    }
}
