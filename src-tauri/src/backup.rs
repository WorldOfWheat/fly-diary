//! Encrypted backup archives.
//!
//! A backup is a plain (uncompressed) tar file containing:
//!
//! ```text
//! diary.db                     # VACUUM INTO snapshot, still SQLCipher-encrypted
//! vault.xml                    # wrapped diary key
//! recovery.xml                 # optional wrapped diary key
//! attachments/<id>.bin       # encrypted image sidecars (flat)
//! ```
//!
//! Ciphertext is incompressible, so tar avoids a compression dependency while
//! remaining readable by standard archive tools. The database snapshot is the
//! authoritative content; the XML and attachment files make the archive
//! self-contained for a manual rescue when the app cannot be unlocked.

use std::collections::HashSet;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::Serialize;

use crate::attachments;
use crate::db;
use crate::fsutil;
use crate::storage;

const BLOCK: usize = 512;
const MAX_FILE_BYTES: u64 = 8 * 1024 * 1024 * 1024;
const MAX_FILES: usize = 200_000;

/// Suggested file name shown in the save dialog.
pub fn suggested_name() -> String {
    let today = chrono::Local::now().format("%Y-%m-%d");
    format!("fly-diary-backup-{today}.tar")
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportReport {
    pub files: usize,
    pub attachments: usize,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractReport {
    pub files: usize,
    pub attachments: usize,
}

/// Write an encrypted snapshot archive.
///
/// `snapshot` is a temporary path that must not exist yet. It is removed before
/// this function returns, whether or not the export succeeded.
pub fn export<W: Write>(
    dir: &Path,
    diary_key: &[u8; 32],
    snapshot: &Path,
    out: &mut W,
) -> Result<ExportReport, String> {
    let _cleanup = RemoveOnDrop(snapshot.to_path_buf());
    db::snapshot(dir, diary_key, snapshot)?;

    let mut report = ExportReport::default();
    write_file_entry(out, "diary.db", snapshot, &mut report)?;

    for name in ["vault.xml", "recovery.xml"] {
        let path = dir.join(name);
        if is_regular_file(&path) {
            write_file_entry(out, name, &path, &mut report)?;
        }
    }

    // Always write the archive in the flat layout, even when the vault still
    // has legacy per-date folders. The database snapshot already maps each id
    // to its date, so the folder name is redundant.
    for (id, path) in attachments::all_attachment_files(dir)? {
        let name = format!("attachments/{id}.bin");
        write_file_entry(out, &name, &path, &mut report)?;
        report.attachments += 1;
    }

    out.write_all(&[0u8; BLOCK])
        .and_then(|_| out.write_all(&[0u8; BLOCK]))
        .and_then(|_| out.flush())
        .map_err(|e| format!("Failed to finish the backup archive: {e}"))?;
    Ok(report)
}

fn write_file_entry<W: Write>(
    out: &mut W,
    name: &str,
    path: &Path,
    report: &mut ExportReport,
) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|e| format!("Failed to read {} for the backup: {e}", path.display()))?;
    if !metadata.file_type().is_file() {
        return Err(format!("{} is not a regular file", path.display()));
    }
    if metadata.len() > MAX_FILE_BYTES {
        return Err(format!("{} is too large to back up", path.display()));
    }
    let mtime = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs())
        .unwrap_or(0);
    write_header(out, name, metadata.len(), mtime)?;
    let mut file = File::open(path)
        .map_err(|e| format!("Failed to read {} for the backup: {e}", path.display()))?;
    io::copy(&mut file, out)
        .map_err(|e| format!("Failed to add {} to the backup: {e}", path.display()))?;
    write_padding(out, metadata.len())?;
    report.files += 1;
    Ok(())
}

fn write_header<W: Write>(out: &mut W, name: &str, size: u64, mtime: u64) -> Result<(), String> {
    if name.len() > 100 || !name.is_ascii() {
        return Err(format!("Unsupported backup path: {name}"));
    }
    if size > 0o77777777777 {
        return Err(format!("File is too large for a tar archive: {name}"));
    }
    let mut header = [0u8; BLOCK];
    header[..name.len()].copy_from_slice(name.as_bytes());
    write_octal(&mut header[100..108], 0o600)?;
    write_octal(&mut header[108..116], 0)?;
    write_octal(&mut header[116..124], 0)?;
    write_octal(&mut header[124..136], size)?;
    write_octal(&mut header[136..148], mtime)?;
    header[148..156].fill(b' ');
    header[156] = b'0';
    header[257..263].copy_from_slice(b"ustar\0");
    header[263..265].copy_from_slice(b"00");

    let checksum: u32 = header.iter().map(|byte| u32::from(*byte)).sum();
    let text = format!("{checksum:06o}\0 ");
    header[148..156].copy_from_slice(text.as_bytes());
    out.write_all(&header)
        .map_err(|e| format!("Failed to write the backup header: {e}"))
}

fn write_octal(field: &mut [u8], value: u64) -> Result<(), String> {
    let text = format!("{value:0width$o}\0", width = field.len() - 1);
    if text.len() != field.len() {
        return Err("Value does not fit the tar header".to_string());
    }
    field.copy_from_slice(text.as_bytes());
    Ok(())
}

fn write_padding<W: Write>(out: &mut W, size: u64) -> Result<(), String> {
    let remainder = (size % BLOCK as u64) as usize;
    if remainder == 0 {
        return Ok(());
    }
    let padding = [0u8; BLOCK];
    out.write_all(&padding[..BLOCK - remainder])
        .map_err(|e| format!("Failed to pad the backup archive: {e}"))
}

/// Extract a backup archive into an empty staging directory.
pub fn extract<R: Read>(input: &mut R, staging: &Path) -> Result<ExtractReport, String> {
    fsutil::create_private_dir(staging)
        .map_err(|e| format!("Failed to create the restore directory: {e}"))?;
    let mut report = ExtractReport::default();
    let mut seen = HashSet::new();
    let mut header = [0u8; BLOCK];

    loop {
        if !read_exact_or_eof(input, &mut header)? {
            break;
        }
        if header.iter().all(|byte| *byte == 0) {
            break;
        }
        verify_checksum(&header)?;
        let name = header_name(&header)?;
        let size = parse_octal(&header[124..136])?;
        let kind = header[156];
        if size > MAX_FILE_BYTES {
            return Err(format!("{name} is too large for a backup"));
        }
        // Accept both the flat layout and the per-date layout written by older
        // versions, and extract both into the flat `attachments/` folder.
        let Some(target_name) = normalized_entry_name(&name) else {
            return Err(format!("Unsupported path in the backup: {name}"));
        };
        if !seen.insert(target_name.clone()) {
            return Err(format!("Duplicate path in the backup: {target_name}"));
        }
        if seen.len() > MAX_FILES {
            return Err("The backup contains too many files".to_string());
        }

        match kind {
            b'0' | 0 => {
                if target_name.ends_with(".bin") {
                    report.attachments += 1;
                }
                let target = staging.join(&target_name);
                if let Some(parent) = target.parent() {
                    fsutil::create_private_dir(parent)
                        .map_err(|e| format!("Failed to create {}: {e}", parent.display()))?;
                }
                let mut file = create_private_file(&target)
                    .map_err(|e| format!("Failed to create {}: {e}", target.display()))?;
                let copied = io::copy(&mut input.by_ref().take(size), &mut file)
                    .map_err(|e| format!("Failed to extract {name}: {e}"))?;
                if copied != size {
                    return Err(format!("The backup archive is truncated: {name}"));
                }
                file.sync_all()
                    .map_err(|e| format!("Failed to flush {name}: {e}"))?;
                skip_padding(input, size)?;
                report.files += 1;
            }
            b'5' => skip_padding(input, size)?,
            _ => return Err(format!("Unsupported entry type in the backup: {name}")),
        }
    }

    if !staging.join("diary.db").is_file() {
        return Err("The backup does not contain diary.db".to_string());
    }
    if !staging.join("vault.xml").is_file() {
        return Err("The backup does not contain vault.xml".to_string());
    }
    Ok(report)
}

fn read_exact_or_eof<R: Read>(input: &mut R, buffer: &mut [u8]) -> Result<bool, String> {
    let mut filled = 0;
    while filled < buffer.len() {
        match input.read(&mut buffer[filled..]) {
            Ok(0) if filled == 0 => return Ok(false),
            Ok(0) => return Err("The backup archive is truncated".to_string()),
            Ok(read) => filled += read,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(error) => return Err(format!("Failed to read the backup: {error}")),
        }
    }
    Ok(true)
}

fn verify_checksum(header: &[u8; BLOCK]) -> Result<(), String> {
    let stored = parse_octal(&header[148..156])?;
    let actual: u32 = header
        .iter()
        .enumerate()
        .map(|(index, byte)| {
            if (148..156).contains(&index) {
                u32::from(b' ')
            } else {
                u32::from(*byte)
            }
        })
        .sum();
    if u64::from(actual) != stored {
        return Err("The backup archive has an invalid header checksum".to_string());
    }
    Ok(())
}

fn header_name(header: &[u8; BLOCK]) -> Result<String, String> {
    let end = header[..100]
        .iter()
        .position(|byte| *byte == 0)
        .unwrap_or(100);
    let name = std::str::from_utf8(&header[..end])
        .map_err(|_| "The backup contains a non-UTF-8 path".to_string())?;
    if name.is_empty() {
        return Err("The backup contains an empty path".to_string());
    }
    Ok(name.to_string())
}

fn parse_octal(field: &[u8]) -> Result<u64, String> {
    let text =
        std::str::from_utf8(field).map_err(|_| "The backup header is not valid tar".to_string())?;
    let text = text.trim_matches(|character| character == '\0' || character == ' ');
    if text.is_empty() {
        return Ok(0);
    }
    u64::from_str_radix(text, 8).map_err(|_| "The backup header has an invalid number".to_string())
}

fn skip_padding<R: Read>(input: &mut R, size: u64) -> Result<(), String> {
    let remainder = (size % BLOCK as u64) as usize;
    if remainder == 0 {
        return Ok(());
    }
    let mut padding = [0u8; BLOCK];
    input
        .read_exact(&mut padding[..BLOCK - remainder])
        .map_err(|e| format!("The backup archive is truncated: {e}"))
}

/// Accepted archive paths, normalized to the flat layout.
///
/// Old backups stored images under `attachments/YYYY-MM-DD/<id>.bin`. The date
/// is already in the database snapshot, so extracting them flat is lossless and
/// keeps a single layout after import.
fn normalized_entry_name(path: &str) -> Option<String> {
    match path.split('/').collect::<Vec<_>>().as_slice() {
        ["diary.db"] | ["vault.xml"] | ["recovery.xml"] => Some(path.to_string()),
        ["attachments", name] if is_attachment_name(name) => Some(path.to_string()),
        ["attachments", date, name]
            if storage::validate_date(date).is_ok() && is_attachment_name(name) =>
        {
            Some(format!("attachments/{name}"))
        }
        _ => None,
    }
}

fn is_attachment_name(name: &str) -> bool {
    name.strip_suffix(".bin").is_some_and(|id| {
        id.len() == 32
            && id
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    })
}

fn is_regular_file(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .map(|metadata| metadata.file_type().is_file())
        .unwrap_or(false)
}

fn create_private_file(path: &Path) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)
}

/// Replace the live database and attachments with an extracted backup.
///
/// `vault.xml` and `recovery.xml` are deliberately not replaced: the archive
/// contains them for manual rescue, but the unlocked session already proved the
/// current key wrappers work and replacing them could roll back a passphrase or
/// recovery phrase change.
///
/// On failure the previous database and attachments are moved back.
pub fn install(staging: &Path, dir: &Path) -> Result<PathBuf, String> {
    install_common(staging, dir, false)
}

/// Install an extracted archive as a complete vault.
///
/// Unlike [`install`], this also replaces `vault.xml` and `recovery.xml`. It is
/// used to import a backup as a new diary, so the imported vault keeps the key
/// wrappers it was created with. The caller must verify the archive and unlock
/// it before calling this function.
pub fn install_import(staging: &Path, dir: &Path) -> Result<PathBuf, String> {
    install_common(staging, dir, true)
}

fn install_common(
    staging: &Path,
    dir: &Path,
    replace_key_wrappers: bool,
) -> Result<PathBuf, String> {
    let staged_db = staging.join("diary.db");
    let staged_attachments = staging.join("attachments");
    let staged_vault = staging.join("vault.xml");
    if !staged_db.is_file() {
        return Err("The backup does not contain diary.db".to_string());
    }
    if replace_key_wrappers && !staged_vault.is_file() {
        return Err("The backup does not contain vault.xml".to_string());
    }

    fsutil::create_private_dir(dir)
        .map_err(|e| format!("Failed to create the diary directory: {e}"))?;

    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
    let parent = dir
        .parent()
        .ok_or_else(|| "The diary directory has no parent".to_string())?;
    let name = dir
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "The diary directory has no name".to_string())?;
    let mut backup = parent.join(format!("{name}.local-backup-{stamp}"));
    let mut suffix = 1;
    while backup.exists() {
        backup = parent.join(format!("{name}.local-backup-{stamp}-{suffix}"));
        suffix += 1;
    }
    fsutil::create_private_dir(&backup)
        .map_err(|e| format!("Failed to create {}: {e}", backup.display()))?;

    let mut current = vec!["diary.db", "diary.db-wal", "diary.db-shm", "attachments"];
    if replace_key_wrappers {
        // The biometric wrapper is device-bound. Import adopts a different
        // vault, so the old wrapper must go with the old key wrappers instead
        // of surviving next to the imported database.
        current.extend(["vault.xml", "recovery.xml", crate::biometric::WRAPPER_FILE]);
    }
    let mut moved_out = Vec::new();
    for item in current {
        let source = dir.join(item);
        if !source.exists() {
            continue;
        }
        let target = backup.join(item);
        if let Err(error) = fs::rename(&source, &target) {
            restore_moved_back(&backup, dir, &moved_out);
            return Err(format!("Failed to set the current vault aside: {error}"));
        }
        moved_out.push(item);
    }

    let mut moved_in: Vec<&str> = Vec::new();
    let result = (|| -> Result<(), String> {
        fs::rename(&staged_db, dir.join("diary.db"))
            .map_err(|e| format!("Failed to install the backup database: {e}"))?;
        moved_in.push("diary.db");
        if staged_attachments.is_dir() {
            fs::rename(&staged_attachments, dir.join("attachments"))
                .map_err(|e| format!("Failed to install the backup attachments: {e}"))?;
            moved_in.push("attachments");
        }
        if replace_key_wrappers {
            fs::rename(&staged_vault, dir.join("vault.xml"))
                .map_err(|e| format!("Failed to install the backup key wrapper: {e}"))?;
            moved_in.push("vault.xml");
            let staged_recovery = staging.join("recovery.xml");
            if staged_recovery.is_file() {
                fs::rename(&staged_recovery, dir.join("recovery.xml"))
                    .map_err(|e| format!("Failed to install the backup recovery file: {e}"))?;
                moved_in.push("recovery.xml");
            }
        }
        fsutil::sync_dir(dir).map_err(|e| format!("Failed to flush the diary directory: {e}"))?;
        Ok(())
    })();

    if let Err(error) = result {
        for item in moved_in {
            let _ = fs::remove_file(dir.join(item));
            let _ = fs::remove_dir_all(dir.join(item));
        }
        restore_moved_back(&backup, dir, &moved_out);
        return Err(error);
    }

    let _ = fs::remove_dir_all(staging);
    Ok(backup)
}

fn restore_moved_back(backup: &Path, dir: &Path, items: &[&str]) {
    for item in items {
        let _ = fs::rename(backup.join(item), dir.join(item));
    }
}

struct RemoveOnDrop(PathBuf);

impl Drop for RemoveOnDrop {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::attachments;
    use crate::crypto;

    const WEBP: &[u8] = b"RIFF\x24\x00\x00\x00WEBPVP8 backup";

    fn temp_dir(name: &str) -> PathBuf {
        let mut path = std::env::temp_dir();
        path.push(format!(
            "fly-diary-backup-{name}-{}-{}",
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

    fn params() -> crypto::KdfParams {
        crypto::KdfParams {
            memory_kib: crypto::KdfParams::MIN_MEMORY_KIB,
            iterations: crypto::KdfParams::MIN_ITERATIONS,
            parallelism: crypto::KdfParams::MIN_PARALLELISM,
        }
    }

    #[test]
    fn archive_roundtrip_restores_entries_and_attachments() {
        let dir = temp_dir("vault");
        let key = storage::create_vault(&dir, "passphrase-123", params()).unwrap();
        db::write_entry(&dir, &key, "2026-10-23", "Title", "Body").unwrap();
        let image =
            attachments::save_attachment(&dir, &key, "2026-10-23", "image/webp", WEBP, 100, 50)
                .unwrap();

        let cache = temp_dir("cache");
        let snapshot = cache.join("snapshot.db");
        let archive = cache.join("backup.tar");
        let mut output = File::create(&archive).unwrap();
        let report = export(&dir, &key, &snapshot, &mut output).unwrap();
        drop(output);
        assert_eq!(report.files, 3);
        assert_eq!(report.attachments, 1);
        assert!(!snapshot.exists());

        let mut input = File::open(&archive).unwrap();
        let staging = cache.join("staging");
        let extracted = extract(&mut input, &staging).unwrap();
        assert_eq!(extracted.files, 3);
        assert_eq!(extracted.attachments, 1);

        let context = storage::vault_context(&staging).unwrap().unwrap();
        db::verify_snapshot(&staging, &key, &context).unwrap();
        assert!(db::integrity_check_snapshot(&staging, &key).unwrap().ok);

        db::write_entry(&dir, &key, "2026-10-24", "Newer", "local").unwrap();
        let backup = install(&staging, &dir).unwrap();
        assert!(backup.is_dir());
        assert!(!staging.exists());
        assert_eq!(
            db::read_entry(&dir, &key, "2026-10-23")
                .unwrap()
                .unwrap()
                .title,
            "Title"
        );
        assert!(db::read_entry(&dir, &key, "2026-10-24").unwrap().is_none());
        let data = attachments::read_attachment(&dir, &key, "2026-10-23", &image.id).unwrap();
        assert_eq!(crypto::b64_decode(&data.data).unwrap(), WEBP);

        let _ = fs::remove_dir_all(&backup);
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&cache);
    }

    #[test]
    fn legacy_archive_paths_are_normalized_to_flat() {
        let id = "a".repeat(32);
        assert_eq!(
            normalized_entry_name(&format!("attachments/{id}.bin")),
            Some(format!("attachments/{id}.bin"))
        );
        assert_eq!(
            normalized_entry_name(&format!("attachments/2026-10-23/{id}.bin")),
            Some(format!("attachments/{id}.bin"))
        );
        assert_eq!(normalized_entry_name("../escape"), None);
        assert_eq!(normalized_entry_name("attachments/not-an-id.bin"), None);
    }

    #[test]
    fn extraction_rejects_path_traversal() {
        let root = temp_dir("traversal");
        let archive = root.join("bad.tar");
        let mut output = File::create(&archive).unwrap();
        write_header(&mut output, "../escape", 1, 0).unwrap();
        output.write_all(b"x").unwrap();
        write_padding(&mut output, 1).unwrap();
        output
            .write_all(&[0u8; BLOCK])
            .and_then(|_| output.write_all(&[0u8; BLOCK]))
            .unwrap();
        drop(output);

        let staging = root.join("staging");
        let mut input = File::open(&archive).unwrap();
        let error = extract(&mut input, &staging).unwrap_err();
        assert!(error.contains("Unsupported path"), "unexpected: {error}");
        assert!(!root.join("escape").exists());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn extraction_rejects_a_truncated_file() {
        let root = temp_dir("truncated");
        let archive = root.join("truncated.tar");
        let mut output = File::create(&archive).unwrap();
        write_header(&mut output, "vault.xml", BLOCK as u64 * 2, 0).unwrap();
        output.write_all(&[0u8; BLOCK]).unwrap();
        drop(output);

        let staging = root.join("staging");
        let mut input = File::open(&archive).unwrap();
        let error = extract(&mut input, &staging).unwrap_err();
        assert!(error.contains("truncated"), "unexpected: {error}");

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn import_install_adopts_the_archive_vault() {
        let source = temp_dir("import-source");
        let key = storage::create_vault(&source, "passphrase-123", params()).unwrap();
        db::write_entry(&source, &key, "2026-10-23", "Imported", "Body").unwrap();
        let image =
            attachments::save_attachment(&source, &key, "2026-10-23", "image/webp", WEBP, 100, 50)
                .unwrap();

        let cache = temp_dir("import-cache");
        let snapshot = cache.join("snapshot.db");
        let archive = cache.join("backup.tar");
        let mut output = File::create(&archive).unwrap();
        export(&source, &key, &snapshot, &mut output).unwrap();
        drop(output);

        let mut input = File::open(&archive).unwrap();
        let staging = cache.join("staging");
        extract(&mut input, &staging).unwrap();

        let parent = temp_dir("import-target");
        let target = parent.join("diary");
        let backup = install_import(&staging, &target).unwrap();

        assert!(backup.is_dir());
        assert!(target.join("diary.db").is_file());
        assert!(target.join("vault.xml").is_file());
        assert_eq!(
            db::read_entry(&target, &key, "2026-10-23")
                .unwrap()
                .unwrap()
                .title,
            "Imported"
        );
        let data = attachments::read_attachment(&target, &key, "2026-10-23", &image.id).unwrap();
        assert_eq!(crypto::b64_decode(&data.data).unwrap(), WEBP);

        let _ = fs::remove_dir_all(&parent);
        let _ = fs::remove_dir_all(&source);
        let _ = fs::remove_dir_all(&cache);
    }

    #[test]
    fn import_install_keeps_the_previous_vault_aside() {
        let source = temp_dir("import-replace-source");
        let key = storage::create_vault(&source, "passphrase-123", params()).unwrap();
        db::write_entry(&source, &key, "2026-10-23", "Imported", "Body").unwrap();

        let cache = temp_dir("import-replace-cache");
        let snapshot = cache.join("snapshot.db");
        let archive = cache.join("backup.tar");
        let mut output = File::create(&archive).unwrap();
        export(&source, &key, &snapshot, &mut output).unwrap();
        drop(output);

        let mut input = File::open(&archive).unwrap();
        let staging = cache.join("staging");
        extract(&mut input, &staging).unwrap();

        let target = temp_dir("import-replace-target");
        let old_key = storage::create_vault(&target, "old-passphrase-123", params()).unwrap();
        db::write_entry(&target, &old_key, "2026-10-24", "Old", "Body").unwrap();

        let backup = install_import(&staging, &target).unwrap();

        assert!(backup.join("diary.db").is_file());
        assert!(backup.join("vault.xml").is_file());
        assert!(db::key_matches(&target, &key).unwrap());
        assert!(!db::key_matches(&target, &old_key).unwrap());
        assert_eq!(
            db::read_entry(&target, &key, "2026-10-23")
                .unwrap()
                .unwrap()
                .title,
            "Imported"
        );

        let _ = fs::remove_dir_all(&backup);
        let _ = fs::remove_dir_all(&source);
        let _ = fs::remove_dir_all(&cache);
        let _ = fs::remove_dir_all(&target);
    }

    #[test]
    fn snapshot_does_not_exist_after_a_failed_export() {
        let dir = temp_dir("missing");
        let key = [0u8; 32];
        let cache = temp_dir("cache");
        let snapshot = cache.join("snapshot.db");
        let mut output = File::create(cache.join("backup.tar")).unwrap();
        assert!(export(&dir, &key, &snapshot, &mut output).is_err());
        assert!(!snapshot.exists());

        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&cache);
    }
}
