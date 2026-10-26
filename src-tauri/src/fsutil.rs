//! Filesystem helpers that keep diary data private.
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

use std::fs;
use std::path::Path;

/// Mode for files that hold diary data: owner read/write only.
#[cfg(unix)]
const FILE_MODE: u32 = 0o600;

/// Mode for directories that hold diary data: owner only.
#[cfg(unix)]
const DIR_MODE: u32 = 0o700;

/// Write `data` to `path`, readable only by the current user.
///
/// The mode is applied on creation *and* re-applied afterwards. `OpenOptions`
/// only honours `mode` when it actually creates the file, so an existing file
/// written by an older build (or by `fs::write` before this helper existed)
/// would otherwise keep its `0644` permissions forever.
pub fn write_private(path: &Path, data: impl AsRef<[u8]>) -> std::io::Result<()> {
    let data = data.as_ref();

    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

        let mut file = fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(FILE_MODE)
            .open(path)?;
        file.write_all(data)?;
        // Covers the "file already existed" case, where `mode` was ignored.
        file.set_permissions(fs::Permissions::from_mode(FILE_MODE))?;
        Ok(())
    }

    #[cfg(not(unix))]
    {
        fs::write(path, data)
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
}
