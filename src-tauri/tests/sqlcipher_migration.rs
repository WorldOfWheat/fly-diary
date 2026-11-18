//! One-way migration from the legacy XML layout to SQLCipher.
//!
//! These tests deliberately simulate the old layout by creating a vault with
//! the current code and then removing `diary.db`: everything else (vault.xml,
//! recovery.xml, YYYY-MM-DD.xml and the attachment sidecars) is exactly what an
//! existing installation has.

use std::path::{Path, PathBuf};

use fly_diary_lib::{attachments, crypto, db, storage};

struct TempDir(PathBuf);

impl TempDir {
    fn new(name: &str) -> Self {
        let mut path = std::env::temp_dir();
        path.push(format!(
            "fly-diary-migrate-{}-{}-{}",
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

fn remove_database(dir: &Path) {
    for name in ["diary.db", "diary.db-wal", "diary.db-shm"] {
        let _ = std::fs::remove_file(dir.join(name));
    }
}

const WEBP: &[u8] = b"RIFF\x24\x00\x00\x00WEBPVP8 migration";

#[test]
fn migrates_entries_and_deletes_the_xml_files() {
    let dir = TempDir::new("entries");
    let key = storage::create_vault(dir.path(), "passphrase-123", fast()).unwrap();

    // The legacy writer produces the same XML envelope the old app wrote.
    storage::write_entry(dir.path(), &key, "2026-10-22", "First", "Hello").unwrap();
    storage::write_entry(dir.path(), &key, "2026-10-23", "Second", "World").unwrap();
    storage::set_favourite(dir.path(), &key, "2026-10-23", true).unwrap();

    remove_database(dir.path());
    assert_eq!(
        db::format_status(dir.path()).format,
        db::StorageFormat::Legacy
    );

    let report = db::migrate_from_xml(dir.path(), &key).unwrap();
    assert_eq!(report.migrated, 2);
    assert!(report.broken.is_empty());
    assert_eq!(
        db::format_status(dir.path()).format,
        db::StorageFormat::Sqlcipher
    );

    let entries = db::list_entries(dir.path(), &key).unwrap();
    assert_eq!(entries.len(), 2);
    assert_eq!(entries[0].date, "2026-10-23");
    assert!(entries[0].favourite);
    let entry = db::read_entry(dir.path(), &key, "2026-10-23")
        .unwrap()
        .unwrap();
    assert_eq!(entry.title, "Second");
    assert_eq!(entry.content, "World");

    // XML is a break change: after a successful migration the only XML left is
    // vault/recovery.
    assert!(!dir.path().join("2026-10-22.xml").exists());
    assert!(!dir.path().join("2026-10-23.xml").exists());
    assert!(!dir.path().join("index.xml").is_file());

    // A second migration is a no-op.
    let again = db::migrate_from_xml(dir.path(), &key).unwrap();
    assert_eq!(again.migrated, 0);
}

#[test]
fn migrates_attachment_order_from_the_encrypted_manifest() {
    let dir = TempDir::new("attachments");
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
        attachments::save_attachment(dir.path(), &key, "2026-10-23", "image/webp", WEBP, 640, 480)
            .unwrap();
    attachments::reorder_attachments(
        dir.path(),
        &key,
        "2026-10-23",
        &[second.id.clone(), first.id.clone()],
    )
    .unwrap();

    // Simulate a pre-SQLCipher installation: an XML entry plus an encrypted
    // XML manifest. The image sidecars stay exactly where they are.
    storage::write_entry(dir.path(), &key, "2026-10-23", "", "").unwrap();
    attachments::write_legacy_manifest(
        dir.path(),
        &key,
        "2026-10-23",
        &[
            (second.id.clone(), "image/webp".to_string(), 640, 480),
            (first.id.clone(), "image/webp".to_string(), 1000, 500),
        ],
    )
    .unwrap();

    remove_database(dir.path());
    let report = db::migrate_from_xml(dir.path(), &key).unwrap();
    assert_eq!(report.migrated, 1);
    assert_eq!(report.attachments, 2);

    let listed = attachments::list_attachments(dir.path(), &key, "2026-10-23").unwrap();
    assert_eq!(listed.len(), 2);
    assert_eq!(listed[0].id, second.id);
    assert_eq!(listed[1].id, first.id);
    let data = attachments::read_attachment(dir.path(), &key, "2026-10-23", &first.id).unwrap();
    assert_eq!(crypto::b64_decode(&data.data).unwrap(), WEBP);
    assert!(!dir
        .path()
        .join("attachments/2026-10-23/manifest.xml")
        .exists());
}

#[test]
fn a_broken_entry_is_reported_and_the_rest_still_migrate() {
    let dir = TempDir::new("broken");
    let key = storage::create_vault(dir.path(), "passphrase-123", fast()).unwrap();
    storage::write_entry(dir.path(), &key, "2026-10-22", "Good", "ok").unwrap();
    storage::write_entry(dir.path(), &key, "2026-10-23", "Bad", "broken").unwrap();
    std::fs::write(dir.path().join("2026-10-23.xml"), "not xml").unwrap();

    remove_database(dir.path());
    let report = db::migrate_from_xml(dir.path(), &key).unwrap();
    assert_eq!(report.migrated, 1);
    assert_eq!(report.broken.len(), 1);
    assert_eq!(report.broken[0].date, "2026-10-23");

    let entries = db::list_entries(dir.path(), &key).unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].date, "2026-10-22");

    // The unreadable bytes are preserved inside the encrypted database, not as
    // a stray XML file. The broken tab can still list and export them.
    assert!(!dir.path().join("2026-10-23.xml").exists());
    let broken = db::list_broken_entries(dir.path(), &key).unwrap();
    assert_eq!(broken.len(), 1);
    assert_eq!(broken[0].date, "2026-10-23");
    assert_eq!(
        db::legacy_broken_bytes(dir.path(), &key, "2026-10-23")
            .unwrap()
            .unwrap(),
        b"not xml"
    );

    // The old broken-entry delete flow still works: it removes the preserved
    // bytes from the encrypted database.
    db::delete_entry(dir.path(), &key, "2026-10-23").unwrap();
    assert!(db::list_broken_entries(dir.path(), &key)
        .unwrap()
        .is_empty());
    assert!(db::legacy_broken_bytes(dir.path(), &key, "2026-10-23")
        .unwrap()
        .is_none());
}

#[test]
fn a_wrong_key_does_not_create_an_empty_database() {
    let dir = TempDir::new("wrong-key");
    let key = storage::create_vault(dir.path(), "passphrase-123", fast()).unwrap();
    storage::write_entry(dir.path(), &key, "2026-10-23", "Secret", "body").unwrap();

    let other = TempDir::new("other");
    let other_key = storage::create_vault(other.path(), "passphrase-123", fast()).unwrap();

    remove_database(dir.path());
    let error = db::migrate_from_xml(dir.path(), &other_key).unwrap_err();
    assert!(
        error.contains("does not match") || error.contains("key"),
        "unexpected error: {error}"
    );
    assert!(!dir.path().join("diary.db").is_file());
    // A failed migration leaves the source untouched.
    assert!(dir.path().join("2026-10-23.xml").is_file());
}

#[test]
fn snapshot_is_a_consistent_encrypted_copy() {
    let dir = TempDir::new("snapshot");
    let key = storage::create_vault(dir.path(), "passphrase-123", fast()).unwrap();
    db::write_entry(dir.path(), &key, "2026-10-23", "Snapshot", "body").unwrap();

    let backup = dir.path().join("backup.db");
    db::snapshot(dir.path(), &key, &backup).unwrap();

    let copy = TempDir::new("snapshot-copy");
    std::fs::copy(&backup, copy.path().join("diary.db")).unwrap();
    std::fs::copy(dir.path().join("vault.xml"), copy.path().join("vault.xml")).unwrap();
    let entry = db::read_entry(copy.path(), &key, "2026-10-23")
        .unwrap()
        .unwrap();
    assert_eq!(entry.title, "Snapshot");
}
