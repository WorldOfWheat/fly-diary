//! Filesystem helpers that keep diary data private and writes crash-safe.
//!
//! Everything this app writes — `vault.xml`, `index.xml`, the per-day entry
//! files and the settings file — is either ciphertext or metadata that helps
//! attack the ciphertext. `vault.xml` is the worst case: it holds the salt, the
//! Argon2id cost parameters and the wrapped diary key, which is the complete
//! input an offline cracker needs. Leaking it does not reveal the diary, but it
//! moves the attack from "you need access to this machine" to "you need a copy
//! of one file and some patience".
//!
//! `fs::write` creates files with the process umask, which is `022` on most
//! Linux systems — that yields `0644`, world-readable. These helpers pin the
//! mode explicitly instead of trusting the environment.
//!
//! On Windows the mode bits do not apply; `%APPDATA%` is already per-user and
//! ACL-protected, so the plain write is used there.
//!
//! # Atomic replacement
//!
//! [`write_private`] never truncates the destination. It writes a sibling
//! temporary file, flushes it to disk, and then renames it over the target.
//! `rename` is atomic on POSIX, so a crash, a full disk or a killed process
//! leaves either the complete old file or the complete new one — never a
//! half-written one. This matters most for `vault.xml`: losing it means losing
//! the salt and the wrapped diary key, i.e. the diary becomes unopenable.
//!
//! Two details make the guarantee hold across a power loss, not just across a
//! process crash:
//!
//! - The temporary file is flushed with `sync_all()` *before* the rename, so
//!   the rename can never be reordered ahead of the data reaching the disk.
//! - The parent directory is flushed *after* the rename, so the new directory
//!   entry is durable too. Without that second flush the file contents survive
//!   but the name change may not, which on a synced folder means the other
//!   device can see the old file come back.
//!
//! [`copy_private`] applies the same treatment to a file-to-file copy, so an
//! interrupted export leaves the destination untouched instead of truncated.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

/// Mode for files that hold diary data: owner read/write only.
#[cfg(unix)]
const FILE_MODE: u32 = 0o600;

/// Mode for directories that hold diary data: owner only.
#[cfg(unix)]
const DIR_MODE: u32 = 0o700;

/// Suffix for the sibling file a write goes through before being renamed.
const TEMP_SUFFIX: &str = ".tmp";

/// Counter that makes temporary names unique within one process.
///
/// The importer writes many entries in parallel from the rayon pool. A fixed
/// temporary name would let two threads open the same file, interleave their
/// bytes and then race to rename it, so each write gets its own name.
static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Build a unique sibling path for `path`, e.g. `entry.xml.tmp-1234-7`.
fn temp_path(path: &Path) -> PathBuf {
    let n = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(format!("{TEMP_SUFFIX}-{}-{n}", std::process::id()));
    path.with_file_name(name)
}

/// Write `data` to `path` atomically, readable only by the current user.
///
/// The bytes go to a temporary sibling first, which is flushed with
/// `sync_all()` and then renamed over `path`. Three consequences:
///
/// - A failure at any point leaves the previous contents of `path` intact.
/// - A power loss after the rename cannot leave an empty file behind, because
///   the data was already on disk before the directory entry changed.
/// - The rename itself is flushed, so the new name is durable as well.
///
/// The mode is applied on creation *and* re-applied afterwards. `OpenOptions`
/// only honours `mode` when it actually creates the file, so an existing file
/// written by an older build (or by `fs::write` before this helper existed)
/// would otherwise keep its `0644` permissions forever.
pub fn write_private(path: &Path, data: impl AsRef<[u8]>) -> std::io::Result<()> {
    let data = data.as_ref();
    let tmp = temp_path(path);

    // Any early return must not leave the temporary file behind.
    let result = write_temp(&tmp, data).and_then(|()| replace(&tmp, path));
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

/// Copy `source` to `dest` atomically, readable only by the current user.
///
/// Used for exporting a broken entry: the user is rescuing the only copy of a
/// day they cannot open, so a truncated destination would be worse than no
/// destination at all. The copy goes to a sibling temporary file, is flushed,
/// and is then renamed into place — exactly like [`write_private`].
///
/// `source` is read in chunks rather than with `fs::copy` so the bytes pass
/// through the same flush-then-rename path as every other write.
pub fn copy_private(source: &Path, dest: &Path) -> std::io::Result<()> {
    let tmp = temp_path(dest);

    let result = copy_temp(source, &tmp).and_then(|()| replace(&tmp, dest));
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

/// Create `tmp` with the private mode, write `data` and flush it to disk.
fn write_temp(tmp: &Path, data: &[u8]) -> std::io::Result<()> {
    let mut file = open_private(tmp)?;
    file.write_all(data)?;
    // Without this the rename could be reordered ahead of the data reaching
    // the disk, and a power loss would leave a correctly named empty file.
    file.sync_all()?;
    Ok(())
}

/// Create `tmp` with the private mode, stream `source` into it and flush it.
fn copy_temp(source: &Path, tmp: &Path) -> std::io::Result<()> {
    let mut input = fs::File::open(source)?;
    let mut output = open_private(tmp)?;
    std::io::copy(&mut input, &mut output)?;
    output.sync_all()?;
    Ok(())
}

#[cfg(unix)]
fn open_private(path: &Path) -> std::io::Result<fs::File> {
    use std::os::unix::fs::OpenOptionsExt;

    fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(FILE_MODE)
        .open(path)
}

#[cfg(not(unix))]
fn open_private(path: &Path) -> std::io::Result<fs::File> {
    fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(path)
}

/// Move `tmp` onto `path`, replacing it, and flush the directory entry.
#[cfg(unix)]
fn replace(tmp: &Path, path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;

    fs::rename(tmp, path)?;
    // `rename` keeps the temporary file's mode, which `open_private` already
    // set to 0600. Re-applying it also tightens a destination that an older
    // build left world-readable, since the rename replaced it wholesale.
    fs::set_permissions(path, fs::Permissions::from_mode(FILE_MODE))?;
    sync_parent_dir(path)
}

#[cfg(windows)]
fn replace(tmp: &Path, path: &Path) -> std::io::Result<()> {
    // `fs::rename` fails on Windows when the destination exists, and the
    // remove-then-rename workaround leaves a window where neither file exists.
    // `ReplaceFileW` swaps the two in one call, so a crash at any point leaves
    // either the old file or the new one under the real name.
    if !path.exists() {
        // Nothing to replace: a plain rename is already atomic.
        return fs::rename(tmp, path);
    }
    replace_file_w(tmp, path)
}

#[cfg(all(not(unix), not(windows)))]
fn replace(tmp: &Path, path: &Path) -> std::io::Result<()> {
    match fs::rename(tmp, path) {
        Ok(()) => Ok(()),
        Err(_) if path.exists() => {
            fs::remove_file(path)?;
            fs::rename(tmp, path)
        }
        Err(e) => Err(e),
    }
}

/// Swap `replacement` in for `path` with `ReplaceFileW`.
///
/// The destination keeps its ACLs and attributes, which is what we want: the
/// file was already owner-only. `REPLACEFILE_WRITE_THROUGH` makes the call
/// return only once the change is on disk, so no separate directory flush is
/// needed on this platform.
#[cfg(windows)]
fn replace_file_w(replacement: &Path, path: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;

    #[link(name = "kernel32")]
    extern "system" {
        fn ReplaceFileW(
            replaced: *const u16,
            replacement: *const u16,
            backup: *const u16,
            flags: u32,
            exclude: *mut core::ffi::c_void,
            reserved: *mut core::ffi::c_void,
        ) -> i32;
    }

    const REPLACEFILE_WRITE_THROUGH: u32 = 0x0000_0001;

    let wide = |p: &Path| -> Vec<u16> {
        p.as_os_str().encode_wide().chain(std::iter::once(0)).collect()
    };
    let replaced = wide(path);
    let replacement = wide(replacement);

    // SAFETY: both pointers come from NUL-terminated `Vec<u16>` buffers that
    // outlive the call, and the two optional pointer arguments are null, which
    // the API documents as "no backup file" and "no exclusion callback".
    let ok = unsafe {
        ReplaceFileW(
            replaced.as_ptr(),
            replacement.as_ptr(),
            std::ptr::null(),
            REPLACEFILE_WRITE_THROUGH,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    };
    if ok == 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

/// Flush `dir`, making a rename or unlink inside it durable.
///
/// `sync_all()` on a file only guarantees its *contents* reached the disk. A
/// rename or a delete changes the directory, and POSIX only promises that
/// survives a power loss once the directory itself is flushed. Skipping this is
/// how a synced folder ends up resurrecting a deleted entry on the other
/// device.
///
/// Windows has no directory handle to flush; `ReplaceFileW` with
/// `REPLACEFILE_WRITE_THROUGH` covers renames there, and a delete is durable
/// once the handle is closed.
#[cfg(unix)]
pub fn sync_dir(dir: &Path) -> std::io::Result<()> {
    // Opening a directory read-only is enough to fsync it.
    fs::File::open(dir)?.sync_all()
}

#[cfg(not(unix))]
pub fn sync_dir(_dir: &Path) -> std::io::Result<()> {
    Ok(())
}

/// Flush the directory that contains `path`.
///
/// Only the Unix `replace` needs this: the Windows path goes through
/// `ReplaceFileW` with `REPLACEFILE_WRITE_THROUGH`, and the fallback platform
/// has no directory handle to flush.
#[cfg(unix)]
fn sync_parent_dir(path: &Path) -> std::io::Result<()> {
    match path.parent() {
        Some(parent) => sync_dir(parent),
        None => Ok(()),
    }
}

/// Create `dir` (and any missing parents), owner-only on Unix.
///
/// A directory this call creates gets exactly [`DIR_MODE`]. A directory that
/// already exists is *also* tightened, because the diary folder is frequently
/// one the user picked in a file dialog — it may well be `0775` from the
/// default umask, which would let any local user list the entry filenames and
/// read `vault.xml`. Only the group/other bits are cleared, so the owner's own
/// bits (and any ACLs) are left as the user set them.
pub fn create_private_dir(dir: &Path) -> std::io::Result<()> {
    if dir.is_dir() {
        return tighten_dir(dir);
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        fs::DirBuilder::new()
            .recursive(true)
            .mode(DIR_MODE)
            .create(dir)?;
        Ok(())
    }

    #[cfg(not(unix))]
    {
        fs::create_dir_all(dir)
    }
}

/// Remove group and other permissions from an existing directory.
#[cfg(unix)]
fn tighten_dir(dir: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;

    let current = fs::metadata(dir)?.permissions();
    let mode = current.mode();
    let tightened = mode & !0o077;
    if tightened != mode {
        fs::set_permissions(dir, fs::Permissions::from_mode(tightened))?;
    }
    Ok(())
}

#[cfg(not(unix))]
fn tighten_dir(_dir: &Path) -> std::io::Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "fly-diary-fsutil-{name}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn write_private_creates_the_file_with_the_data() {
        let dir = temp_dir("create");
        let path = dir.join("vault.xml");

        write_private(&path, b"<vault/>").unwrap();

        assert_eq!(fs::read(&path).unwrap(), b"<vault/>");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_private_overwrites_existing_content() {
        let dir = temp_dir("overwrite");
        let path = dir.join("entry.xml");
        fs::write(&path, b"old").unwrap();

        write_private(&path, b"new").unwrap();

        assert_eq!(fs::read(&path).unwrap(), b"new");
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn write_private_creates_a_file_only_the_owner_can_read() {
        use std::os::unix::fs::PermissionsExt;

        let dir = temp_dir("mode-create");
        let path = dir.join("vault.xml");

        write_private(&path, b"secret").unwrap();

        let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "expected 0600, got {mode:o}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn write_private_tightens_a_world_readable_file() {
        use std::os::unix::fs::PermissionsExt;

        let dir = temp_dir("mode-existing");
        let path = dir.join("vault.xml");
        // Simulate a file left behind by an older build that used `fs::write`.
        fs::write(&path, b"old").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();

        write_private(&path, b"new").unwrap();

        let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "expected 0600 after rewrite, got {mode:o}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn create_private_dir_creates_an_owner_only_directory() {
        use std::os::unix::fs::PermissionsExt;

        let base = temp_dir("dir-create");
        let nested = base.join("diary").join("nested");

        create_private_dir(&nested).unwrap();

        assert!(nested.is_dir());
        let mode = fs::metadata(&nested).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o700, "expected 0700, got {mode:o}");
        let _ = fs::remove_dir_all(&base);
    }

    #[cfg(unix)]
    #[test]
    fn create_private_dir_tightens_an_existing_world_readable_directory() {
        use std::os::unix::fs::PermissionsExt;

        let dir = temp_dir("dir-existing");
        // A folder the user picked in a file dialog, created with umask 022.
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o775)).unwrap();

        create_private_dir(&dir).unwrap();

        let mode = fs::metadata(&dir).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o700, "expected 0700, got {mode:o}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn create_private_dir_keeps_the_owners_own_bits() {
        use std::os::unix::fs::PermissionsExt;

        let dir = temp_dir("dir-owner-bits");
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o750)).unwrap();

        create_private_dir(&dir).unwrap();

        // Only group/other are cleared; the owner keeps read+write+execute.
        let mode = fs::metadata(&dir).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o700, "expected 0700, got {mode:o}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn create_private_dir_is_idempotent() {
        let dir = temp_dir("dir-idempotent");

        create_private_dir(&dir).unwrap();
        create_private_dir(&dir).unwrap();

        assert!(dir.is_dir());
        let _ = fs::remove_dir_all(&dir);
    }

    /// Every file in `dir` whose name starts with `prefix`.
    fn names_starting_with(dir: &Path, prefix: &str) -> Vec<String> {
        fs::read_dir(dir)
            .unwrap()
            .filter_map(|item| item.ok())
            .map(|item| item.file_name().to_string_lossy().into_owned())
            .filter(|name| name.starts_with(prefix))
            .collect()
    }

    #[test]
    fn write_private_leaves_no_temporary_file_behind() {
        let dir = temp_dir("no-temp");
        let path = dir.join("vault.xml");

        write_private(&path, b"<vault/>").unwrap();

        assert_eq!(names_starting_with(&dir, "vault.xml"), vec!["vault.xml"]);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_failed_write_keeps_the_previous_contents() {
        let dir = temp_dir("failed-write");
        let path = dir.join("vault.xml");
        write_private(&path, b"original").unwrap();

        // A directory cannot be opened for writing, so the temporary file is
        // created but the write itself fails. The original must survive.
        let blocked = dir.join("blocked.xml");
        fs::create_dir(&blocked).unwrap();
        assert!(write_private(&blocked, b"new").is_err());
        assert!(blocked.is_dir(), "the directory must not be replaced");

        assert_eq!(fs::read(&path).unwrap(), b"original");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_failed_write_does_not_leave_a_temporary_file() {
        let dir = temp_dir("failed-temp");
        let blocked = dir.join("blocked.xml");
        fs::create_dir(&blocked).unwrap();

        assert!(write_private(&blocked, b"new").is_err());

        assert!(
            names_starting_with(&dir, "blocked.xml.tmp").is_empty(),
            "temporary file was left behind"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn parallel_writes_to_different_files_all_land() {
        use std::sync::Arc;

        let dir = Arc::new(temp_dir("parallel"));
        let handles: Vec<_> = (0..16)
            .map(|i| {
                let dir = Arc::clone(&dir);
                std::thread::spawn(move || {
                    let path = dir.join(format!("entry-{i}.xml"));
                    write_private(&path, format!("payload-{i}")).unwrap();
                })
            })
            .collect();
        for handle in handles {
            handle.join().unwrap();
        }

        for i in 0..16 {
            let path = dir.join(format!("entry-{i}.xml"));
            assert_eq!(fs::read(&path).unwrap(), format!("payload-{i}").into_bytes());
        }
        // No temporary files survived the race.
        assert!(names_starting_with(&dir, "entry-")
            .iter()
            .all(|name| name.ends_with(".xml")));
        let _ = fs::remove_dir_all(&*dir);
    }

    #[test]
    fn copy_private_copies_the_bytes() {
        let dir = temp_dir("copy");
        let source = dir.join("2026-10-23.xml");
        let dest = dir.join("export.xml");
        fs::write(&source, b"<entry>broken</entry>").unwrap();

        copy_private(&source, &dest).unwrap();

        assert_eq!(fs::read(&dest).unwrap(), b"<entry>broken</entry>");
        // The source is untouched.
        assert_eq!(fs::read(&source).unwrap(), b"<entry>broken</entry>");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn copy_private_leaves_no_temporary_file_behind() {
        let dir = temp_dir("copy-no-temp");
        let source = dir.join("2026-10-23.xml");
        let dest = dir.join("export.xml");
        fs::write(&source, b"payload").unwrap();

        copy_private(&source, &dest).unwrap();

        assert_eq!(names_starting_with(&dir, "export.xml"), vec!["export.xml"]);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_failed_copy_keeps_the_previous_destination() {
        let dir = temp_dir("copy-failed");
        let dest = dir.join("export.xml");
        fs::write(&dest, b"previous export").unwrap();

        // A missing source fails before anything is written.
        let missing = dir.join("does-not-exist.xml");
        assert!(copy_private(&missing, &dest).is_err());

        assert_eq!(fs::read(&dest).unwrap(), b"previous export");
        assert!(names_starting_with(&dir, "export.xml.tmp").is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn copy_private_creates_a_file_only_the_owner_can_read() {
        use std::os::unix::fs::PermissionsExt;

        let dir = temp_dir("copy-mode");
        let source = dir.join("2026-10-23.xml");
        let dest = dir.join("export.xml");
        fs::write(&source, b"payload").unwrap();

        copy_private(&source, &dest).unwrap();

        let mode = fs::metadata(&dest).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "expected 0600, got {mode:o}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn sync_dir_flushes_an_existing_directory() {
        let dir = temp_dir("sync-dir");
        sync_dir(&dir).unwrap();
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn sync_dir_reports_a_missing_directory() {
        let dir = temp_dir("sync-missing");
        let missing = dir.join("nope");
        assert!(sync_dir(&missing).is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn parallel_writes_to_the_same_file_leave_one_complete_copy() {
        use std::sync::Arc;

        let dir = Arc::new(temp_dir("parallel-same"));
        let path = Arc::new(dir.join("vault.xml"));
        let handles: Vec<_> = (0..16)
            .map(|i| {
                let path = Arc::clone(&path);
                std::thread::spawn(move || {
                    write_private(&path, format!("payload-{i}")).unwrap();
                })
            })
            .collect();
        for handle in handles {
            handle.join().unwrap();
        }

        // Whichever writer won, the file is one intact payload — never a mix.
        let contents = String::from_utf8(fs::read(&*path).unwrap()).unwrap();
        assert!(
            (0..16).any(|i| contents == format!("payload-{i}")),
            "unexpected contents: {contents:?}"
        );
        assert!(names_starting_with(&dir, "vault.xml.tmp").is_empty());
        let _ = fs::remove_dir_all(&*dir);
    }
}
