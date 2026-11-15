//! Integration coverage for the image attachment lifecycle.
//!
//! The unit tests in `attachments.rs` exercise one function at a time. This
//! test walks the same path a user does: create a vault, attach images, reorder
//! them, lock, unlock, read them back, then delete the entry and its images.

use std::path::{Path, PathBuf};

use fly_diary_lib::{attachments, crypto, storage};

struct TempDir(PathBuf);

impl TempDir {
    fn new(name: &str) -> Self {
        let mut path = std::env::temp_dir();
        path.push(format!(
            "fly-diary-att-it-{}-{}-{}",
            name,
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&path).expect("create temp dir");
        Self(path)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn fast() -> crypto::KdfParams {
    crypto::KdfParams {
        memory_kib: crypto::KdfParams::MIN_MEMORY_KIB,
        iterations: crypto::KdfParams::MIN_ITERATIONS,
        parallelism: crypto::KdfParams::MIN_PARALLELISM,
    }
}

const WEBP: &[u8] = b"RIFF\x24\x00\x00\x00WEBPVP8 integration";
const PNG: &[u8] = b"\x89PNG\r\n\x1a\nintegration";

#[test]
fn attachments_survive_lock_unlock_and_follow_entry_deletion() {
    let dir = TempDir::new("lifecycle");
    let key = storage::create_vault(dir.path(), "passphrase-123", fast()).unwrap();

    let first = attachments::save_attachment(
        dir.path(),
        &key,
        "2026-10-23",
        "image/webp",
        WEBP,
        1000,
        500,
    )
    .unwrap();
    let second =
        attachments::save_attachment(dir.path(), &key, "2026-10-23", "image/png", PNG, 500, 1000)
            .unwrap();

    let listed = attachments::list_attachments(dir.path(), &key, "2026-10-23").unwrap();
    assert_eq!(listed.len(), 2);
    assert_eq!(listed[0].id, first.id);
    assert_eq!(listed[1].id, second.id);

    attachments::reorder_attachments(
        dir.path(),
        &key,
        "2026-10-23",
        &[second.id.clone(), first.id.clone()],
    )
    .unwrap();

    // Locking is just dropping the key; the manifest and images stay on disk.
    let reopened = storage::unlock_vault(dir.path(), "passphrase-123").unwrap();
    let listed = attachments::list_attachments(dir.path(), &reopened, "2026-10-23").unwrap();
    assert_eq!(listed[0].id, second.id);
    assert_eq!(listed[1].id, first.id);

    let data =
        attachments::read_attachment(dir.path(), &reopened, "2026-10-23", &first.id).unwrap();
    assert_eq!(data.mime, "image/webp");
    assert_eq!(crypto::b64_decode(&data.data).unwrap(), WEBP);

    storage::delete_entry(dir.path(), &reopened, "2026-10-23").unwrap();
    assert!(!dir.path().join("attachments").join("2026-10-23").exists());
    assert!(
        attachments::list_attachments(dir.path(), &reopened, "2026-10-23")
            .unwrap()
            .is_empty()
    );
}
