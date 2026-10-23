//! End-to-end tests for the diary's on-disk lifecycle.
//!
//! The unit tests inside `storage.rs` exercise each function in isolation. This
//! file instead walks the sequence a real user goes through — create a vault,
//! write entries, lock, unlock, read them back, change the passphrase — against
//! a temporary directory, so a regression in how the pieces fit together is
//! caught even when every individual function still passes.
//!
//! Only the public `storage` and `crypto` APIs are used; the Tauri command
//! wrappers in `lib.rs` are thin enough that their logic is covered by the unit
//! tests there.

use std::path::{Path, PathBuf};

use fly_diary_lib::storage;
use fly_diary_lib::crypto;

/// A unique scratch directory, removed when the guard is dropped.
struct TempDir(PathBuf);

impl TempDir {
    fn new(name: &str) -> Self {
        let mut path = std::env::temp_dir();
        let unique = format!(
            "fly-diary-it-{}-{}-{}",
            name,
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        path.push(unique);
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

/// Cheap Argon2id parameters so the suite stays fast.
fn fast() -> crypto::KdfParams {
    crypto::KdfParams {
        memory_kib: crypto::KdfParams::MIN_MEMORY_KIB,
        iterations: crypto::KdfParams::MIN_ITERATIONS,
        parallelism: crypto::KdfParams::MIN_PARALLELISM,
    }
}

#[test]
fn create_write_lock_unlock_read_roundtrip() {
    let dir = TempDir::new("roundtrip");
    let passphrase = "a long enough passphrase";

    // 1. Create the vault. It is unlocked immediately and returns the key.
    let key = storage::create_vault(dir.path(), passphrase, fast()).expect("create vault");
    assert!(storage::vault_exists(dir.path()).unwrap());

    // 2. Write two entries.
    storage::write_entry(dir.path(), &key, "2026-10-22", "First", "Hello").unwrap();
    storage::write_entry(dir.path(), &key, "2026-10-23", "Second", "World").unwrap();

    // 3. The list is newest first and carries the decrypted titles.
    let entries = storage::list_entries(dir.path(), &key).unwrap();
    assert_eq!(entries.len(), 2);
    assert_eq!(entries[0].date, "2026-10-23");
    assert_eq!(entries[0].title, "Second");
    assert_eq!(entries[1].date, "2026-10-22");

    // 4. "Lock" is simply forgetting the key; the vault stays on disk.
    let _ = key;

    // 5. Unlocking with the right passphrase yields the same diary key, so the
    //    entries written before the lock are still readable.
    let reopened = storage::unlock_vault(dir.path(), passphrase).expect("unlock");
    let entry = storage::read_entry(dir.path(), &reopened, "2026-10-23")
        .unwrap()
        .expect("entry exists");
    assert_eq!(entry.title, "Second");
    assert_eq!(entry.content, "World");
}

#[test]
fn the_wrong_passphrase_cannot_unlock() {
    let dir = TempDir::new("wrong-pass");
    storage::create_vault(dir.path(), "right", fast()).unwrap();

    let err = storage::unlock_vault(dir.path(), "wrong").unwrap_err();
    assert!(
        err.to_lowercase().contains("passphrase"),
        "unexpected error: {err}"
    );
}

#[test]
fn entries_are_unreadable_without_the_key() {
    let dir = TempDir::new("encrypted");
    let key = storage::create_vault(dir.path(), "pass", fast()).unwrap();
    storage::write_entry(dir.path(), &key, "2026-10-23", "Secret title", "Secret body").unwrap();

    // The raw file must not leak the plaintext.
    let raw = std::fs::read_to_string(dir.path().join("2026-10-23.xml")).unwrap();
    assert!(!raw.contains("Secret title"));
    assert!(!raw.contains("Secret body"));

    // A key from a different vault cannot decrypt it either.
    let other = TempDir::new("other-vault");
    let other_key = storage::create_vault(other.path(), "pass", fast()).unwrap();
    assert!(storage::read_entry(dir.path(), &other_key, "2026-10-23").is_err());
}

#[test]
fn changing_the_passphrase_keeps_the_entries_and_invalidates_the_old_one() {
    let dir = TempDir::new("rewrap");
    let key = storage::create_vault(dir.path(), "old-pass", fast()).unwrap();
    storage::write_entry(dir.path(), &key, "2026-10-23", "Kept", "Still here").unwrap();

    // Re-wrap under a new passphrase. The diary key is unchanged.
    let same_key = storage::rewrap_vault(dir.path(), "old-pass", "new-pass", fast()).unwrap();
    assert_eq!(same_key, key, "rewrap must not regenerate the diary key");

    // The old passphrase no longer works...
    assert!(storage::unlock_vault(dir.path(), "old-pass").is_err());
    // ...and the new one does, with the entry intact.
    let reopened = storage::unlock_vault(dir.path(), "new-pass").unwrap();
    let entry = storage::read_entry(dir.path(), &reopened, "2026-10-23")
        .unwrap()
        .expect("entry survives the rewrap");
    assert_eq!(entry.content, "Still here");
}

#[test]
fn a_second_create_on_the_same_directory_is_refused() {
    let dir = TempDir::new("duplicate");
    storage::create_vault(dir.path(), "pass", fast()).unwrap();
    let err = storage::create_vault(dir.path(), "pass", fast()).unwrap_err();
    assert!(err.contains("already exists"), "unexpected error: {err}");
}

#[test]
fn an_empty_passphrase_is_refused_at_creation() {
    let dir = TempDir::new("empty-pass");
    assert!(storage::create_vault(dir.path(), "", fast()).is_err());
    assert!(!storage::vault_exists(dir.path()).unwrap());
}

#[test]
fn deleting_an_entry_removes_it_from_the_list() {
    let dir = TempDir::new("delete");
    let key = storage::create_vault(dir.path(), "pass", fast()).unwrap();
    storage::write_entry(dir.path(), &key, "2026-10-23", "Gone", "bye").unwrap();
    storage::write_entry(dir.path(), &key, "2026-10-22", "Stays", "hi").unwrap();

    storage::delete_entry(dir.path(), &key, "2026-10-23").unwrap();

    let entries = storage::list_entries(dir.path(), &key).unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].date, "2026-10-22");
    assert!(storage::read_entry(dir.path(), &key, "2026-10-23")
        .unwrap()
        .is_none());
}

#[test]
fn favourites_survive_a_lock_and_unlock() {
    let dir = TempDir::new("favourite");
    let key = storage::create_vault(dir.path(), "pass", fast()).unwrap();
    storage::write_entry(dir.path(), &key, "2026-10-23", "Starred", "body").unwrap();
    storage::set_favourite(dir.path(), &key, "2026-10-23", true).unwrap();

    let reopened = storage::unlock_vault(dir.path(), "pass").unwrap();
    let favourites = storage::list_favourites(dir.path(), &reopened).unwrap();
    assert_eq!(favourites.len(), 1);
    assert_eq!(favourites[0].date, "2026-10-23");
}

#[test]
fn rebuilding_the_index_recovers_from_a_deleted_index_file() {
    let dir = TempDir::new("rebuild");
    let key = storage::create_vault(dir.path(), "pass", fast()).unwrap();
    storage::write_entry(dir.path(), &key, "2026-10-23", "One", "a").unwrap();
    storage::write_entry(dir.path(), &key, "2026-10-22", "Two", "b").unwrap();

    // Simulate a lost index.
    let _ = std::fs::remove_file(dir.path().join("index.xml"));

    let rebuilt = storage::rebuild_index(dir.path(), &key).unwrap();
    assert_eq!(rebuilt.len(), 2);
    assert_eq!(rebuilt[0].date, "2026-10-23");
}

#[test]
fn the_vault_records_the_kdf_parameters_it_was_created_with() {
    let dir = TempDir::new("kdf");
    let params = crypto::KdfParams {
        memory_kib: crypto::KdfParams::MIN_MEMORY_KIB,
        iterations: 2,
        parallelism: 1,
    };
    storage::create_vault(dir.path(), "pass", params).unwrap();

    let stored = storage::vault_kdf_params(dir.path()).unwrap().unwrap();
    assert_eq!(stored.memory_kib, params.memory_kib);
    assert_eq!(stored.iterations, params.iterations);
    assert_eq!(stored.parallelism, params.parallelism);
}

#[test]
fn a_full_import_cycle_lands_in_the_diary() {
    let diary = TempDir::new("import-diary");
    let source = TempDir::new("import-source");
    let key = storage::create_vault(diary.path(), "pass", fast()).unwrap();

    std::fs::write(source.path().join("2026-10-20.txt"), "older entry").unwrap();
    std::fs::write(source.path().join("2026-10-21.txt"), "newer entry").unwrap();
    std::fs::write(source.path().join("notes.txt"), "not a date").unwrap();

    // Scan first, as the UI does.
    let existing = storage::known_dates(diary.path(), &key).unwrap();
    let scan = storage::scan_import(source.path(), &existing).unwrap();
    let ready: Vec<String> = scan
        .files
        .iter()
        .filter(|f| matches!(f.status, storage::ImportStatus::Ready))
        .map(|f| f.date.clone().unwrap())
        .collect();
    assert_eq!(ready.len(), 2);

    // Then import the confirmed dates.
    let report = storage::import_entries(diary.path(), &key, source.path(), &ready, false).unwrap();
    assert_eq!(report.imported.len(), 2);
    assert!(report.skipped.is_empty());
    assert!(report.failed.is_empty());

    let entries = storage::list_entries(diary.path(), &key).unwrap();
    assert_eq!(entries.len(), 2);
    assert_eq!(entries[0].date, "2026-10-21");
}
