//! Encryption layer built on RustCrypto primitives.
//!
//! ## Key hierarchy
//!
//! ```text
//! passphrase ──Argon2id(salt, params)──▶ master key (32 bytes, never stored)
//!                                          │
//!                                          │ AES-256-GCM
//!                                          ▼
//!                            wrapped diary key (stored in vault.xml)
//!                                          │
//!                                          │ AES-256-GCM
//!                                          ▼
//!                                  diary entries
//! ```
//!
//! The **diary key** is random and does the actual entry encryption. The
//! **master key** is derived from the passphrase and only ever wraps the diary
//! key. This indirection means the passphrase can be changed (or the KDF
//! parameters upgraded) by re-wrapping a single 32-byte value instead of
//! re-encrypting every entry.
//!
//! ## Cipher
//!
//! AES-256-GCM with a fresh random 96-bit nonce (IV) per write. The IV is
//! stored alongside the ciphertext in the XML file; no key material ever
//! touches the disk in the clear.

use aes_gcm::aead::{Aead, KeyInit, OsRng, Payload};
use aes_gcm::{AeadCore, Aes256Gcm, Key, Nonce};
use argon2::{Algorithm, Argon2, Params, Version};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

/// AES-GCM nonce length in bytes (96 bits, the recommended size).
pub const IV_LEN: usize = 12;

/// Length of the random diary key in bytes (AES-256).
pub const KEY_LEN: usize = 32;

/// Domain separator for the legacy SHA-256 derivation.
const LEGACY_DOMAIN: &[u8] = b"fly-diary/v1";

// ---------------------------------------------------------------------------
// KDF parameters
// ---------------------------------------------------------------------------

/// Argon2id cost parameters, persisted in `vault.xml` so the same values are
/// used on every unlock.
///
/// Defaults follow the OWASP recommendation for Argon2id (19 MiB, 2 passes,
/// 1 lane). Raising `memory_kib` is the single most effective knob against
/// GPU cracking, because it makes each guess require that much RAM.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KdfParams {
    /// Memory cost in kibibytes (1 KiB = 1024 bytes).
    pub memory_kib: u32,
    /// Number of passes over the memory.
    pub iterations: u32,
    /// Degree of parallelism (lanes).
    pub parallelism: u32,
}

impl Default for KdfParams {
    fn default() -> Self {
        Self {
            memory_kib: 19 * 1024,
            iterations: 2,
            parallelism: 1,
        }
    }
}

impl KdfParams {
    /// Lower bounds that keep the KDF meaningfully slow.
    pub const MIN_MEMORY_KIB: u32 = 8 * 1024;
    pub const MIN_ITERATIONS: u32 = 1;
    pub const MIN_PARALLELISM: u32 = 1;

    /// Upper bounds that keep a single unlock from freezing the app.
    pub const MAX_MEMORY_KIB: u32 = 1024 * 1024;
    pub const MAX_ITERATIONS: u32 = 16;
    pub const MAX_PARALLELISM: u32 = 16;

    /// Reject values that are out of range or that Argon2 itself refuses.
    pub fn validate(&self) -> Result<(), String> {
        if self.memory_kib < Self::MIN_MEMORY_KIB || self.memory_kib > Self::MAX_MEMORY_KIB {
            return Err(format!(
                "Memory cost must be between {} and {} KiB",
                Self::MIN_MEMORY_KIB,
                Self::MAX_MEMORY_KIB
            ));
        }
        if self.iterations < Self::MIN_ITERATIONS || self.iterations > Self::MAX_ITERATIONS {
            return Err(format!(
                "Iterations must be between {} and {}",
                Self::MIN_ITERATIONS,
                Self::MAX_ITERATIONS
            ));
        }
        if self.parallelism < Self::MIN_PARALLELISM || self.parallelism > Self::MAX_PARALLELISM {
            return Err(format!(
                "Parallelism must be between {} and {}",
                Self::MIN_PARALLELISM,
                Self::MAX_PARALLELISM
            ));
        }
        // Argon2 requires memory >= 8 * parallelism KiB.
        if self.memory_kib < 8 * self.parallelism {
            return Err("Memory cost is too low for the chosen parallelism".to_string());
        }
        self.build_argon2()
            .map(|_| ())
            .map_err(|e| format!("Invalid Argon2 parameters: {e}"))
    }

    fn build_argon2(&self) -> Result<Argon2<'static>, String> {
        let params = Params::new(
            self.memory_kib,
            self.iterations,
            self.parallelism,
            Some(KEY_LEN),
        )
        .map_err(|e| format!("Invalid Argon2 parameters: {e}"))?;
        Ok(Argon2::new(Algorithm::Argon2id, Version::V0x13, params))
    }
}

// ---------------------------------------------------------------------------
// Key derivation
// ---------------------------------------------------------------------------

/// Derive the master key from `passphrase` with Argon2id.
///
/// The returned buffer zeroizes itself when dropped.
pub fn derive_master_key(
    passphrase: &str,
    salt: &[u8],
    params: KdfParams,
) -> Result<Zeroizing<[u8; KEY_LEN]>, String> {
    params.validate()?;
    let argon2 = params.build_argon2()?;

    let mut key = Zeroizing::new([0u8; KEY_LEN]);
    argon2
        .hash_password_into(passphrase.as_bytes(), salt, key.as_mut())
        .map_err(|e| format!("Key derivation failed: {e}"))?;
    Ok(key)
}

/// Legacy derivation used by version 1 vaults: a single SHA-256 pass.
///
/// Kept only so existing diaries can still be unlocked and migrated.
pub fn derive_legacy_key(passphrase: &str, salt: &[u8]) -> Zeroizing<[u8; KEY_LEN]> {
    let mut hasher = Sha256::new();
    hasher.update(LEGACY_DOMAIN);
    hasher.update(salt);
    hasher.update(passphrase.as_bytes());
    let digest = hasher.finalize();

    let mut key = Zeroizing::new([0u8; KEY_LEN]);
    key.copy_from_slice(&digest);
    key
}

/// Generate a fresh random diary key.
pub fn new_diary_key() -> Zeroizing<[u8; KEY_LEN]> {
    let mut key = Zeroizing::new([0u8; KEY_LEN]);
    rand::RngCore::fill_bytes(&mut OsRng, key.as_mut());
    key
}

// ---------------------------------------------------------------------------
// Calibration
// ---------------------------------------------------------------------------

/// Target wall-clock time for a single unlock, in milliseconds.
pub const CALIBRATION_TARGET_MS: u128 = 1000;

/// Memory cost the calibration starts from (64 MiB).
///
/// Starting high and scaling *down* is deliberate: the first measurement is
/// then an upper bound, so a slow machine never gets a parameter set that is
/// already too expensive before we have measured anything.
const CALIBRATION_START_MEMORY_KIB: u32 = 64 * 1024;

/// Memory cost the calibration will not go below, even on very slow hardware.
/// Below this Argon2id stops being a meaningful barrier.
const CALIBRATION_FLOOR_MEMORY_KIB: u32 = 19 * 1024;

/// Measure how long one Argon2id derivation takes with `params`.
///
/// The passphrase and salt are throwaway values; only the timing matters.
fn measure_derivation(params: KdfParams) -> Result<u128, String> {
    let salt = [0x5au8; 16];
    let started = std::time::Instant::now();
    let _ = derive_master_key("calibration-probe", &salt, params)?;
    Ok(started.elapsed().as_millis())
}

/// Pick Argon2id parameters that take roughly [`CALIBRATION_TARGET_MS`] on this
/// machine.
///
/// The strategy is a coarse search over memory cost, which is the knob that
/// matters most against GPU cracking, followed by a fine adjustment of the
/// iteration count. Parallelism is left at 1 so the result is reproducible on
/// machines with different core counts.
///
/// The returned parameters are always valid per [`KdfParams::validate`].
pub fn calibrate_kdf() -> Result<KdfParams, String> {
    // Step 1: find the largest memory cost that still fits in the budget.
    let mut memory_kib = CALIBRATION_START_MEMORY_KIB;
    let mut elapsed = measure_derivation(KdfParams {
        memory_kib,
        iterations: 1,
        parallelism: 1,
    })?;

    // Halve until we are inside the budget, or until we hit the floor.
    while elapsed > CALIBRATION_TARGET_MS && memory_kib > CALIBRATION_FLOOR_MEMORY_KIB {
        memory_kib = (memory_kib / 2).max(CALIBRATION_FLOOR_MEMORY_KIB);
        elapsed = measure_derivation(KdfParams {
            memory_kib,
            iterations: 1,
            parallelism: 1,
        })?;
    }

    // Step 2: spend any leftover budget on extra passes. Each pass costs
    // roughly the same as the first, so the ratio tells us how many fit.
    let per_pass = elapsed.max(1);
    let budget_passes = (CALIBRATION_TARGET_MS / per_pass).max(1) as u32;
    let iterations = budget_passes.clamp(KdfParams::MIN_ITERATIONS, KdfParams::MAX_ITERATIONS);

    let params = KdfParams {
        memory_kib,
        iterations,
        parallelism: 1,
    };
    params.validate()?;
    Ok(params)
}

// ---------------------------------------------------------------------------
// AES-256-GCM
// ---------------------------------------------------------------------------

/// Encrypt `plaintext` with AES-256-GCM, binding it to `aad`.
///
/// Returns `(iv, ciphertext)` where `iv` is 12 bytes and `ciphertext` includes
/// the 16-byte GCM authentication tag.
///
/// `aad` (associated data) is authenticated but not encrypted. Passing the
/// entry's date here is what stops a ciphertext from being moved to a different
/// day: the tag only verifies against the same AAD, so a file copied from
/// `2026-10-23.xml` to `2026-10-24.xml` fails to decrypt instead of silently
/// displaying the wrong day's diary.
pub fn encrypt_with_aad(
    key: &[u8; KEY_LEN],
    aad: &[u8],
    plaintext: &[u8],
) -> Result<([u8; IV_LEN], Vec<u8>), String> {
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
    let ciphertext = cipher
        .encrypt(
            &nonce,
            Payload {
                msg: plaintext,
                aad,
            },
        )
        .map_err(|_| "Encryption failed".to_string())?;

    let mut iv = [0u8; IV_LEN];
    iv.copy_from_slice(nonce.as_slice());
    Ok((iv, ciphertext))
}

/// Decrypt `ciphertext` with AES-256-GCM, verifying the tag against `aad`.
pub fn decrypt_with_aad(
    key: &[u8; KEY_LEN],
    aad: &[u8],
    iv: &[u8],
    ciphertext: &[u8],
) -> Result<Vec<u8>, String> {
    if iv.len() != IV_LEN {
        return Err(format!("Invalid IV length: {}", iv.len()));
    }
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    let nonce = Nonce::from_slice(iv);
    cipher
        .decrypt(
            nonce,
            Payload {
                msg: ciphertext,
                aad,
            },
        )
        .map_err(|_| "Decryption failed: wrong passphrase or corrupted entry".to_string())
}

/// Encrypt `plaintext` with AES-256-GCM and no associated data.
///
/// Kept for the vault's wrapped key, which has no natural context to bind to,
/// and for reading payloads written before AAD was introduced.
pub fn encrypt(key: &[u8; KEY_LEN], plaintext: &[u8]) -> Result<([u8; IV_LEN], Vec<u8>), String> {
    encrypt_with_aad(key, b"", plaintext)
}

/// Decrypt `ciphertext` with AES-256-GCM and no associated data.
pub fn decrypt(key: &[u8; KEY_LEN], iv: &[u8], ciphertext: &[u8]) -> Result<Vec<u8>, String> {
    decrypt_with_aad(key, b"", iv, ciphertext)
}

// ---------------------------------------------------------------------------
// Encoding helpers
// ---------------------------------------------------------------------------

/// Generate a random 16-byte salt, base64 encoded (stored in the vault file).
pub fn new_salt_b64() -> String {
    let mut bytes = [0u8; 16];
    rand::RngCore::fill_bytes(&mut OsRng, &mut bytes);
    B64.encode(bytes)
}

/// Encode bytes as standard base64.
pub fn b64_encode(bytes: &[u8]) -> String {
    B64.encode(bytes)
}

/// Decode standard base64.
pub fn b64_decode(text: &str) -> Result<Vec<u8>, String> {
    B64.decode(text.trim())
        .map_err(|e| format!("Invalid base64 data: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Cheap parameters so the test suite stays fast.
    fn fast() -> KdfParams {
        KdfParams {
            memory_kib: 8 * 1024,
            iterations: 1,
            parallelism: 1,
        }
    }

    /// Argon2 rejects salts shorter than 8 bytes, so every test salt is padded
    /// to a realistic length before being handed to the KDF.
    fn salt(label: &str) -> Vec<u8> {
        let mut bytes = label.as_bytes().to_vec();
        bytes.resize(16, b'0');
        bytes
    }

    fn key(passphrase: &str, salt: &[u8]) -> Zeroizing<[u8; KEY_LEN]> {
        derive_master_key(passphrase, salt, fast()).unwrap()
    }

    #[test]
    fn roundtrip() {
        let k = key("correct horse battery staple", &salt("some-salt"));
        let (iv, ct) = encrypt(&k, "今天過得不錯".as_bytes()).unwrap();
        let pt = decrypt(&k, &iv, &ct).unwrap();
        assert_eq!(String::from_utf8(pt).unwrap(), "今天過得不錯");
    }

    #[test]
    fn wrong_key_fails() {
        let k = key("password-a", &salt("salt"));
        let other = key("password-b", &salt("salt"));
        let (iv, ct) = encrypt(&k, b"secret").unwrap();
        assert!(decrypt(&other, &iv, &ct).is_err());
    }

    #[test]
    fn tampered_ciphertext_fails() {
        let k = key("pw", &salt("salt"));
        let (iv, mut ct) = encrypt(&k, b"secret").unwrap();
        ct[0] ^= 0xff;
        assert!(decrypt(&k, &iv, &ct).is_err());
    }

    #[test]
    fn iv_is_random_per_write() {
        let k = key("pw", &salt("salt"));
        let (iv1, _) = encrypt(&k, b"same").unwrap();
        let (iv2, _) = encrypt(&k, b"same").unwrap();
        assert_ne!(iv1, iv2);
    }

    #[test]
    fn derived_key_is_deterministic() {
        let a = key("same-pass", &salt("same-salt"));
        let b = key("same-pass", &salt("same-salt"));
        assert_eq!(*a, *b);
    }

    #[test]
    fn derived_key_depends_on_salt_and_passphrase() {
        let base = key("pass", &salt("salt-1"));
        assert_ne!(*base, *key("pass", &salt("salt-2")));
        assert_ne!(*base, *key("other", &salt("salt-1")));
    }

    #[test]
    fn derived_key_depends_on_kdf_params() {
        let salt = salt("salt");
        let a = derive_master_key("pw", &salt, fast()).unwrap();
        let b = derive_master_key(
            "pw",
            &salt,
            KdfParams {
                iterations: 2,
                ..fast()
            },
        )
        .unwrap();
        assert_ne!(*a, *b, "changing iterations must change the key");
    }

    #[test]
    fn derived_key_is_32_bytes() {
        let k = key("pw", &salt("salt"));
        assert_eq!(k.len(), KEY_LEN);
    }

    #[test]
    fn argon2id_differs_from_legacy_sha256() {
        let salt = salt("salt");
        let modern = derive_master_key("pw", &salt, fast()).unwrap();
        let legacy = derive_legacy_key("pw", &salt);
        assert_ne!(*modern, *legacy);
    }

    #[test]
    fn legacy_key_is_deterministic() {
        assert_eq!(
            *derive_legacy_key("pw", &salt("salt")),
            *derive_legacy_key("pw", &salt("salt"))
        );
    }

    #[test]
    fn diary_key_is_random_and_32_bytes() {
        let a = new_diary_key();
        let b = new_diary_key();
        assert_eq!(a.len(), KEY_LEN);
        assert_ne!(*a, *b);
    }

    #[test]
    fn default_params_are_valid() {
        assert!(KdfParams::default().validate().is_ok());
    }

    #[test]
    fn calibration_returns_valid_params() {
        let params = calibrate_kdf().unwrap();
        assert!(params.validate().is_ok(), "got: {params:?}");
        assert_eq!(params.parallelism, 1);
        assert!(params.memory_kib >= CALIBRATION_FLOOR_MEMORY_KIB);
        assert!(params.memory_kib <= CALIBRATION_START_MEMORY_KIB);
        assert!(params.iterations >= KdfParams::MIN_ITERATIONS);
        assert!(params.iterations <= KdfParams::MAX_ITERATIONS);
    }

    #[test]
    fn calibrated_params_can_derive_a_key() {
        let params = calibrate_kdf().unwrap();
        let key = derive_master_key("pw", &salt("calibrated"), params).unwrap();
        assert_eq!(key.len(), KEY_LEN);
    }

    #[test]
    fn rejects_memory_below_minimum() {
        let err = KdfParams {
            memory_kib: 1024,
            ..KdfParams::default()
        }
        .validate()
        .unwrap_err();
        assert!(err.contains("Memory cost"), "got: {err}");
    }

    #[test]
    fn rejects_memory_above_maximum() {
        let err = KdfParams {
            memory_kib: 2 * 1024 * 1024,
            ..KdfParams::default()
        }
        .validate()
        .unwrap_err();
        assert!(err.contains("Memory cost"), "got: {err}");
    }

    #[test]
    fn rejects_zero_iterations() {
        let err = KdfParams {
            iterations: 0,
            ..KdfParams::default()
        }
        .validate()
        .unwrap_err();
        assert!(err.contains("Iterations"), "got: {err}");
    }

    #[test]
    fn rejects_excessive_iterations() {
        let err = KdfParams {
            iterations: 99,
            ..KdfParams::default()
        }
        .validate()
        .unwrap_err();
        assert!(err.contains("Iterations"), "got: {err}");
    }

    #[test]
    fn rejects_zero_parallelism() {
        let err = KdfParams {
            parallelism: 0,
            ..KdfParams::default()
        }
        .validate()
        .unwrap_err();
        assert!(err.contains("Parallelism"), "got: {err}");
    }

    #[test]
    fn rejects_memory_too_low_for_parallelism() {
        // Argon2 needs at least 8 KiB per lane. With the current bounds
        // (min 8 MiB, max 16 lanes) the absolute floor always satisfies the
        // per-lane rule, so exercise the rule through `to_argon2` directly.
        let params = KdfParams {
            memory_kib: 64,
            parallelism: 16,
            ..KdfParams::default()
        };
        let err = params.build_argon2().unwrap_err();
        assert!(err.contains("Invalid Argon2 parameters"), "got: {err}");
    }

    #[test]
    fn empty_plaintext_roundtrip() {
        let k = key("pw", &salt("salt"));
        let (iv, ct) = encrypt(&k, b"").unwrap();
        // GCM still emits the 16-byte authentication tag.
        assert_eq!(ct.len(), 16);
        assert_eq!(decrypt(&k, &iv, &ct).unwrap(), Vec::<u8>::new());
    }

    #[test]
    fn large_plaintext_roundtrip() {
        let k = key("pw", &salt("salt"));
        let plaintext: Vec<u8> = (0..100_000u32).map(|i| (i % 251) as u8).collect();
        let (iv, ct) = encrypt(&k, &plaintext).unwrap();
        assert_eq!(decrypt(&k, &iv, &ct).unwrap(), plaintext);
    }

    #[test]
    fn binary_plaintext_roundtrip() {
        let k = key("pw", &salt("salt"));
        let plaintext: Vec<u8> = (0..=255u8).collect();
        let (iv, ct) = encrypt(&k, &plaintext).unwrap();
        assert_eq!(decrypt(&k, &iv, &ct).unwrap(), plaintext);
    }

    #[test]
    fn ciphertext_differs_for_same_plaintext() {
        let k = key("pw", &salt("salt"));
        let (_, ct1) = encrypt(&k, b"identical").unwrap();
        let (_, ct2) = encrypt(&k, b"identical").unwrap();
        assert_ne!(ct1, ct2, "random IV must make ciphertexts differ");
    }

    #[test]
    fn tampered_iv_fails() {
        let k = key("pw", &salt("salt"));
        let (mut iv, ct) = encrypt(&k, b"secret").unwrap();
        iv[0] ^= 0xff;
        assert!(decrypt(&k, &iv, &ct).is_err());
    }

    #[test]
    fn truncated_ciphertext_fails() {
        let k = key("pw", &salt("salt"));
        let (iv, ct) = encrypt(&k, b"secret").unwrap();
        let truncated = &ct[..ct.len() - 1];
        assert!(decrypt(&k, &iv, truncated).is_err());
    }

    #[test]
    fn wrong_iv_length_is_rejected() {
        let k = key("pw", &salt("salt"));
        let (_, ct) = encrypt(&k, b"secret").unwrap();
        let err = decrypt(&k, &[0u8; 8], &ct).unwrap_err();
        assert!(err.contains("Invalid IV length"), "got: {err}");
    }

    // -- Associated data ----------------------------------------------------

    #[test]
    fn aad_roundtrip() {
        let k = key("pw", &salt("salt"));
        let (iv, ct) = encrypt_with_aad(&k, b"2026-10-23", b"today I flew").unwrap();
        assert_eq!(
            decrypt_with_aad(&k, b"2026-10-23", &iv, &ct).unwrap(),
            b"today I flew"
        );
    }

    #[test]
    fn aad_mismatch_fails_to_decrypt() {
        let k = key("pw", &salt("salt"));
        let (iv, ct) = encrypt_with_aad(&k, b"2026-10-23", b"secret").unwrap();

        // This is the attack the AAD prevents: the same ciphertext presented
        // under a different date must not decrypt.
        let err = decrypt_with_aad(&k, b"2026-10-24", &iv, &ct).unwrap_err();
        assert!(err.contains("Decryption failed"), "got: {err}");
    }

    #[test]
    fn aad_ciphertext_does_not_decrypt_without_aad() {
        let k = key("pw", &salt("salt"));
        let (iv, ct) = encrypt_with_aad(&k, b"2026-10-23", b"secret").unwrap();

        // A payload written with AAD must not be readable by the legacy
        // no-AAD path, or the binding could be stripped by a downgrade.
        assert!(decrypt(&k, &iv, &ct).is_err());
    }

    #[test]
    fn no_aad_ciphertext_does_not_decrypt_with_aad() {
        let k = key("pw", &salt("salt"));
        let (iv, ct) = encrypt(&k, b"secret").unwrap();

        assert!(decrypt_with_aad(&k, b"2026-10-23", &iv, &ct).is_err());
    }

    #[test]
    fn empty_aad_matches_the_plain_helpers() {
        let k = key("pw", &salt("salt"));
        let (iv, ct) = encrypt(&k, b"secret").unwrap();

        assert_eq!(decrypt_with_aad(&k, b"", &iv, &ct).unwrap(), b"secret");
    }

    #[test]
    fn different_aad_produces_different_ciphertext() {
        let k = key("pw", &salt("salt"));
        let (_, ct1) = encrypt_with_aad(&k, b"a", b"same").unwrap();
        let (_, ct2) = encrypt_with_aad(&k, b"b", b"same").unwrap();
        assert_ne!(ct1, ct2);
    }

    #[test]
    fn salt_is_unique_and_16_bytes() {
        let a = new_salt_b64();
        let b = new_salt_b64();
        assert_ne!(a, b);
        assert_eq!(b64_decode(&a).unwrap().len(), 16);
        assert_eq!(b64_decode(&b).unwrap().len(), 16);
    }

    #[test]
    fn base64_roundtrip() {
        let data = b"\x00\x01\xfe\xff hello";
        assert_eq!(b64_decode(&b64_encode(data)).unwrap(), data);
    }

    #[test]
    fn base64_decode_rejects_garbage() {
        assert!(b64_decode("not valid base64!!!").is_err());
    }

    #[test]
    fn base64_decode_trims_whitespace() {
        let encoded = b64_encode(b"abc");
        let padded = format!("  {encoded}\n");
        assert_eq!(b64_decode(&padded).unwrap(), b"abc");
    }
}
