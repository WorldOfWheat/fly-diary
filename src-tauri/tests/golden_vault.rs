//! Golden-vault regression tests.
//!
//! `tests/fixtures/golden-vault/` holds a real diary written by release 2.2.0
//! and then frozen. The tests below only *read* those bytes: they copy the
//! fixture into a scratch directory and unlock it with the current code. If a
//! dependency upgrade, a refactor, or a format change breaks backwards
//! compatibility, these tests fail even though a fresh encrypt/decrypt
//! round-trip would still pass.
//!
//! The fixture is intentionally immutable:
//!
//! * `the_committed_fixture_is_frozen` asserts the SHA-256 of every fixture
//!   file. Do not regenerate the fixture to make a failing test green — fix the
//!   regression instead. A deliberate new format belongs in a new fixture with
//!   its own versioned directory, so this one can keep proving that old diaries
//!   still open.
//! * The passphrase and recovery phrase below are public test data. Never put
//!   real diary content in the fixture.

use std::fmt::Write as _;
use std::fs;
use std::path::{Path, PathBuf};

use fly_diary_lib::{attachments, crypto, db, storage};
use sha2::{Digest, Sha256};

/// Public passphrase of the frozen vault.
const PASSPHRASE: &str = "fly-diary golden fixture passphrase";

/// Public BIP39 recovery phrase of the frozen vault (all-zero entropy).
const RECOVERY_PHRASE: &str =
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

const FIRST_DATE: &str = "2026-10-22";
const FIRST_TITLE: &str = "First frozen day";
const FIRST_CONTENT: &str =
    "The fixture was frozen on 2026-11-24.\nThis plaintext must survive every future upgrade.";

const SECOND_DATE: &str = "2026-10-23";
const SECOND_TITLE: &str = "Second frozen day";
const SECOND_CONTENT: &str =
    "Unicode must round-trip too: 日本語、한국어、emoji 🛫.\n留給未來的測試。";

const ATTACHMENT_ID: &str = "6385e137b5feaf45f64cc7c0d5c42905";

/// The 1×1 transparent PNG stored as the frozen attachment.
const ATTACHMENT_PNG: &[u8] = &[
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
    0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x60, 0x60, 0x60, 0x60,
    0x00, 0x00, 0x00, 0x05, 0x00, 0x01, 0xa5, 0xf6, 0x45, 0x40, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45,
    0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
];

/// Argon2id parameters recorded in the frozen `vault.xml`.
const EXPECTED_KDF: crypto::KdfParams = crypto::KdfParams {
    memory_kib: 65_536,
    iterations: 3,
    parallelism: 1,
};

const VAULT_XML_SHA256: &str = "23603941b34ca3e4beaaffa52fa263a69a47e16d131bb9cd4f5c448f4030f16a";
const RECOVERY_XML_SHA256: &str =
    "f06e0aa12ae2f4f4648df8d183d40a899ba8e6e3a26c104f95cb0803d7d6fcd4";
const DIARY_DB_SHA256: &str = "80665523381bb5bb13320fdd43c0fab7aff1b46dd1ab38f89c0ecc68cc885335";
const ATTACHMENT_SHA256: &str = "7348432d1c582c3d157ea1784bf1471c7f5ce240cdd7fa63db336fce9cfb9334";

fn fixture_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/golden-vault")
}

/// A unique scratch directory, removed when the guard is dropped.
struct TempDir(PathBuf);

impl TempDir {
    fn new(name: &str) -> Self {
        let mut path = std::env::temp_dir();
        path.push(format!(
            "fly-diary-golden-{}-{}-{}",
            name,
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&path).expect("create temp dir");
        Self(path)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// Copy the frozen vault into a scratch directory, leaving the fixture intact.
fn copy_fixture(dest: &Path) {
    let src = fixture_dir();
    fs::create_dir_all(dest.join("attachments")).expect("create attachments dir");
    for name in ["vault.xml", "recovery.xml", "diary.db"] {
        fs::copy(src.join(name), dest.join(name))
            .unwrap_or_else(|e| panic!("copy fixture {name}: {e}"));
    }
    let name = format!("{ATTACHMENT_ID}.bin");
    fs::copy(
        src.join("attachments").join(&name),
        dest.join("attachments").join(&name),
    )
    .unwrap_or_else(|e| panic!("copy fixture attachment {name}: {e}"));
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut out = String::with_capacity(digest.len() * 2);
    for byte in digest {
        write!(out, "{byte:02x}").expect("write to String");
    }
    out
}

fn assert_frozen(relative: &str, expected: &str) {
    let path = fixture_dir().join(relative);
    let bytes = fs::read(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
    assert_eq!(
        sha256_hex(&bytes),
        expected,
        "{} was modified. The golden fixture is frozen test data; do not \
         regenerate it to make a failure disappear.",
        path.display()
    );
}

#[test]
fn the_committed_fixture_is_frozen() {
    assert_frozen("vault.xml", VAULT_XML_SHA256);
    assert_frozen("recovery.xml", RECOVERY_XML_SHA256);
    assert_frozen("diary.db", DIARY_DB_SHA256);
    assert_frozen(
        &format!("attachments/{ATTACHMENT_ID}.bin"),
        ATTACHMENT_SHA256,
    );
}

#[test]
fn the_frozen_vault_unlocks_and_reads_its_entries() {
    let dir = TempDir::new("unlock");
    copy_fixture(dir.path());

    let key = storage::unlock_vault(dir.path(), PASSPHRASE)
        .expect("the frozen vault must still unlock with its passphrase");
    assert!(db::key_matches(dir.path(), &key).expect("check key"));
    assert_eq!(
        storage::vault_kdf_params(dir.path()).expect("read KDF params"),
        Some(EXPECTED_KDF),
        "the frozen vault's Argon2id parameters changed"
    );

    let first = db::read_entry(dir.path(), &key, FIRST_DATE)
        .expect("read first entry")
        .expect("first entry exists");
    assert_eq!(first.title, FIRST_TITLE);
    assert_eq!(first.content, FIRST_CONTENT);
    assert!(!first.favourite);

    let second = db::read_entry(dir.path(), &key, SECOND_DATE)
        .expect("read second entry")
        .expect("second entry exists");
    assert_eq!(second.title, SECOND_TITLE);
    assert_eq!(second.content, SECOND_CONTENT);
    assert!(second.favourite);

    let entries = db::list_entries(dir.path(), &key).expect("list entries");
    assert_eq!(entries.len(), 2);
    assert_eq!(entries[0].date, SECOND_DATE);
    assert_eq!(entries[0].title, SECOND_TITLE);
    assert!(entries[0].favourite);
    assert_eq!(entries[1].date, FIRST_DATE);
    assert_eq!(entries[1].title, FIRST_TITLE);
}

#[test]
fn the_frozen_vault_rejects_the_wrong_passphrase() {
    let dir = TempDir::new("wrong-pass");
    copy_fixture(dir.path());

    let err = storage::unlock_vault(dir.path(), "definitely not the passphrase")
        .expect_err("a wrong passphrase must not unlock the frozen vault");
    assert!(
        err.to_lowercase().contains("passphrase"),
        "unexpected error: {err}"
    );
}

#[test]
fn the_frozen_attachment_decrypts_with_its_metadata() {
    let dir = TempDir::new("attachment");
    copy_fixture(dir.path());
    let key = storage::unlock_vault(dir.path(), PASSPHRASE).expect("unlock");

    let list =
        attachments::list_attachments(dir.path(), &key, SECOND_DATE).expect("list attachments");
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].id, ATTACHMENT_ID);
    assert_eq!(list[0].mime, "image/png");
    assert_eq!(list[0].width, 1);
    assert_eq!(list[0].height, 1);
    // `size` is the on-disk envelope: magic + version + IV + ciphertext/tag.
    assert_eq!(
        list[0].size,
        (ATTACHMENT_PNG.len() + 4 + 1 + crypto::IV_LEN + 16) as u64
    );
    assert!(!list[0].missing);

    let data = attachments::read_attachment(dir.path(), &key, SECOND_DATE, ATTACHMENT_ID)
        .expect("decrypt attachment");
    assert_eq!(data.mime, "image/png");
    assert_eq!(
        crypto::b64_decode(&data.data).expect("decode attachment"),
        ATTACHMENT_PNG
    );
}

#[test]
fn the_frozen_recovery_phrase_returns_the_same_diary_key() {
    let dir = TempDir::new("recovery");
    copy_fixture(dir.path());

    let key = storage::unlock_vault(dir.path(), PASSPHRASE).expect("unlock with passphrase");
    let recovered =
        storage::recover_diary_key(dir.path(), RECOVERY_PHRASE).expect("recover with phrase");
    assert_eq!(
        *recovered, *key,
        "the recovery phrase must unwrap the same diary key"
    );

    let entry = db::read_entry(dir.path(), &recovered, SECOND_DATE)
        .expect("read entry with recovered key")
        .expect("second entry exists");
    assert_eq!(entry.content, SECOND_CONTENT);
}
