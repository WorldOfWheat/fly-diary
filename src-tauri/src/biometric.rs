// ---------------------------------------------------------------------------
// Android biometric unlock
// ---------------------------------------------------------------------------
//
// The passphrase remains the root secret. Enabling biometric unlock wraps the
// already-derived diary key with an Android Keystore AES key that only becomes
// usable after a successful BiometricPrompt. The wrapper is device-bound and
// deliberately not part of the encrypted tar:
//
//   - it cannot be opened on another device (the Keystore alias is local), and
//   - restoring/importing a vault must require the passphrase again.
//
// `biometric.json` lives next to `vault.xml`. It contains only ciphertext,
// an IV, the alias and the vault/key identifiers; the diary key never appears
// in plaintext on disk.

use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use zeroize::Zeroizing;

use crate::{crypto, db, storage};

/// Device-bound biometric wrapper. Never included in `.tar` backups.
pub const WRAPPER_FILE: &str = "biometric.json";
const WRAPPER_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Enrollment {
    version: u32,
    vault_id: String,
    key_id: String,
    alias: String,
    iv: String,
    ciphertext: String,
}

/// What the settings page and lock screen need to know.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub available: bool,
    pub enabled: bool,
    pub reason: Option<String>,
}

impl Status {
    fn unavailable(reason: &str) -> Self {
        Self {
            available: false,
            enabled: false,
            reason: Some(reason.to_string()),
        }
    }
}

fn path(dir: &Path) -> std::path::PathBuf {
    dir.join(WRAPPER_FILE)
}

fn read(dir: &Path) -> Result<Option<Enrollment>, String> {
    let file = path(dir);
    if !file.is_file() {
        return Ok(None);
    }
    let bytes = crate::fsutil::read_limited(&file, 64 * 1024)
        .map_err(|error| format!("Failed to read the biometric wrapper: {error}"))?;
    let enrollment: Enrollment = serde_json::from_slice(&bytes)
        .map_err(|error| format!("The biometric wrapper is malformed: {error}"))?;
    if enrollment.version != WRAPPER_VERSION {
        return Err("The biometric wrapper has an unsupported version".to_string());
    }
    Ok(Some(enrollment))
}

fn write(dir: &Path, enrollment: &Enrollment) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(enrollment)
        .map_err(|error| format!("Failed to encode the biometric wrapper: {error}"))?;
    crate::fsutil::write_private(&path(dir), bytes)
        .map_err(|error| format!("Failed to write the biometric wrapper: {error}"))
}

/// Remove the wrapper. The Keystore alias is left for the caller to delete.
pub fn remove_wrapper(dir: &Path) {
    let _ = fs::remove_file(path(dir));
}

fn hex16(bytes: &[u8; 16]) -> String {
    let mut output = String::with_capacity(32);
    for byte in bytes {
        output.push_str(&format!("{byte:02x}"));
    }
    output
}

fn aad(context: &crate::xml::VaultContext) -> String {
    format!(
        "fly-diary-biometric-v1|{}|{}",
        hex16(&context.vault_id),
        hex16(&context.key_id)
    )
}

fn new_alias(context: &crate::xml::VaultContext) -> String {
    let stamp = chrono::Local::now().timestamp_millis();
    let random: u32 = rand::random();
    let prefix = hex16(&context.vault_id);
    format!("fly-diary-bio-{}-{stamp}-{random:08x}", &prefix[..8])
}

fn wrapper_matches(enrollment: &Enrollment, context: &crate::xml::VaultContext) -> bool {
    enrollment.vault_id == hex16(&context.vault_id) && enrollment.key_id == hex16(&context.key_id)
}

/// Current status for the settings page and lock screen.
pub async fn status(app: &AppHandle) -> Result<Status, String> {
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        return Ok(Status::unavailable("unsupported_platform"));
    }

    #[cfg(target_os = "android")]
    {
        let Some(dir) = crate::diary_dir(app).ok() else {
            return Ok(Status::unavailable("not_configured"));
        };

        let mut wrapper = match read(&dir) {
            Ok(wrapper) => wrapper,
            Err(_) => {
                remove_wrapper(&dir);
                None
            }
        };
        let mut stale: Option<&'static str> = None;

        if let Some(enrollment) = wrapper.as_ref() {
            match storage::vault_context(&dir) {
                Ok(Some(context)) if wrapper_matches(enrollment, &context) => {}
                _ => {
                    remove_wrapper(&dir);
                    wrapper = None;
                    stale = Some("stale");
                }
            }
        }

        let alias = wrapper.as_ref().map(|enrollment| enrollment.alias.clone());
        let native = native_status(app, alias).await?;

        if let Some(enrollment) = wrapper.as_ref() {
            if !native.key_exists {
                remove_wrapper(&dir);
                wrapper = None;
                stale = Some("key_missing");
            }
        }

        // `enabled` means a wrapper is installed for this vault; `available`
        // reports whether the device can authenticate right now. Keeping them
        // separate lets settings still offer "disable" when biometrics are
        // temporarily unavailable (for example after removing all fingerprints).
        let enabled = wrapper.is_some();
        let reason = if !native.available {
            native.reason
        } else {
            stale.map(str::to_string)
        };

        Ok(Status {
            available: native.available,
            enabled,
            reason,
        })
    }
}

/// Wrap the current diary key with a fresh Keystore key.
///
/// The passphrase is checked again so an attacker who finds an already-unlocked
/// app cannot enroll their own fingerprint.
pub async fn enable(app: &AppHandle, passphrase: &str) -> Result<Status, String> {
    if passphrase.is_empty() {
        return Err("Enter the current passphrase".to_string());
    }

    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        return Err("Biometric unlock is only available on Android".to_string());
    }

    #[cfg(target_os = "android")]
    {
        let dir = crate::diary_dir(app)?;
        let native = native_status(app, None).await?;
        if !native.available {
            return Err(format!(
                "BIOMETRIC_UNAVAILABLE: {}",
                native.reason.unwrap_or_else(|| "unavailable".to_string())
            ));
        }

        // Argon2id is deliberately expensive; keep it off the async runtime
        // just like the normal unlock command does.
        let dir_for_key = dir.clone();
        let passphrase = passphrase.to_string();
        let (context, key) = crate::blocking("Verify biometric passphrase", move || {
            let context = storage::vault_context(&dir_for_key)?
                .ok_or_else(|| "This diary has no upgraded vault".to_string())?;
            let key = storage::unlock_vault(&dir_for_key, &passphrase)?;
            Ok((context, key))
        })
        .await?;

        let previous = read(&dir).ok().flatten();
        let alias = new_alias(&context);
        let payload = crypto::b64_encode(&key[..]);
        let enrollment = match native_enroll(app, alias.clone(), payload, aad(&context)).await {
            Ok(enrollment) => enrollment,
            Err(error) => {
                let _ = native_delete(app, alias).await;
                return Err(error);
            }
        };

        let wrapper = Enrollment {
            version: WRAPPER_VERSION,
            vault_id: hex16(&context.vault_id),
            key_id: hex16(&context.key_id),
            alias: alias.clone(),
            iv: enrollment.iv,
            ciphertext: enrollment.ciphertext,
        };
        if let Err(error) = write(&dir, &wrapper) {
            let _ = native_delete(app, alias).await;
            return Err(error);
        }

        if let Some(previous) = previous {
            if previous.alias != alias {
                let _ = native_delete(app, previous.alias).await;
            }
        }

        status(app).await
    }
}

/// Remove the wrapper and its Keystore key.
pub async fn disable(app: &AppHandle) -> Result<Status, String> {
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        return Ok(Status::unavailable("unsupported_platform"));
    }

    #[cfg(target_os = "android")]
    {
        let dir = crate::diary_dir(app)?;
        let previous = read(&dir).ok().flatten();
        remove_wrapper(&dir);
        if let Some(previous) = previous {
            let _ = native_delete(app, previous.alias).await;
        }
        status(app).await
    }
}

/// Decrypt the diary key after a successful BiometricPrompt.
pub async fn unlock(app: &AppHandle) -> Result<Zeroizing<[u8; 32]>, String> {
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        return Err("Biometric unlock is only available on Android".to_string());
    }

    #[cfg(target_os = "android")]
    {
        let dir = crate::diary_dir(app)?;
        let wrapper = read(&dir)?.ok_or_else(|| "Biometric unlock is not enabled".to_string())?;
        let context = storage::vault_context(&dir)?
            .ok_or_else(|| "This diary has no upgraded vault".to_string())?;
        if !wrapper_matches(&wrapper, &context) {
            remove_wrapper(&dir);
            return Err(
                "BIOMETRIC_STALE: the biometric wrapper belongs to another vault".to_string(),
            );
        }
        if !db::database_exists(&dir) {
            return Err("The encrypted database is missing".to_string());
        }

        let decrypted = match native_decrypt(
            app,
            wrapper.alias.clone(),
            wrapper.iv,
            wrapper.ciphertext,
            aad(&context),
        )
        .await
        {
            Ok(decrypted) => decrypted,
            Err(error) => {
                if error.contains("BIOMETRIC_KEY_INVALIDATED") {
                    remove_wrapper(&dir);
                    let _ = native_delete(app, wrapper.alias).await;
                }
                return Err(error);
            }
        };

        let bytes = crypto::b64_decode(&decrypted.payload)?;
        if bytes.len() != 32 {
            remove_wrapper(&dir);
            return Err("BIOMETRIC_STALE: the biometric key has the wrong length".to_string());
        }
        let mut key = Zeroizing::new([0u8; 32]);
        key.copy_from_slice(&bytes);
        if !db::key_matches(&dir, &key)? {
            remove_wrapper(&dir);
            return Err("BIOMETRIC_STALE: the biometric key does not open this diary".to_string());
        }
        Ok(key)
    }
}

#[cfg(target_os = "android")]
async fn native_handle(
    app: &AppHandle,
) -> Result<fly_diary_biometric::Biometric<tauri::Wry>, String> {
    app.try_state::<fly_diary_biometric::Biometric<tauri::Wry>>()
        .map(|state| state.inner().clone())
        .ok_or_else(|| "The biometric plugin is not available".to_string())
}

#[cfg(target_os = "android")]
async fn native_status(
    app: &AppHandle,
    alias: Option<String>,
) -> Result<fly_diary_biometric::NativeStatus, String> {
    let handle = native_handle(app).await?;
    tauri::async_runtime::spawn_blocking(move || handle.status(alias))
        .await
        .map_err(|error| format!("Biometric status task failed: {error}"))?
}

#[cfg(target_os = "android")]
async fn native_enroll(
    app: &AppHandle,
    alias: String,
    payload: String,
    aad: String,
) -> Result<fly_diary_biometric::Enrollment, String> {
    let handle = native_handle(app).await?;
    tauri::async_runtime::spawn_blocking(move || handle.enroll(alias, payload, aad))
        .await
        .map_err(|error| format!("Biometric enrollment task failed: {error}"))?
}

#[cfg(target_os = "android")]
async fn native_decrypt(
    app: &AppHandle,
    alias: String,
    iv: String,
    ciphertext: String,
    aad: String,
) -> Result<fly_diary_biometric::Decrypted, String> {
    let handle = native_handle(app).await?;
    tauri::async_runtime::spawn_blocking(move || handle.decrypt(alias, iv, ciphertext, aad))
        .await
        .map_err(|error| format!("Biometric unlock task failed: {error}"))?
}

#[cfg(target_os = "android")]
async fn native_delete(app: &AppHandle, alias: String) -> Result<(), String> {
    let handle = native_handle(app).await?;
    tauri::async_runtime::spawn_blocking(move || handle.delete_key(alias))
        .await
        .map_err(|error| format!("Biometric cleanup task failed: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::engine::general_purpose::STANDARD as B64;
    use base64::Engine;

    #[test]
    fn the_aad_binds_both_identifiers_and_the_version() {
        let context = crate::xml::VaultContext {
            vault_id: [0x11; 16],
            key_id: [0x22; 16],
        };
        assert_eq!(
            aad(&context),
            format!(
                "fly-diary-biometric-v1|{}|{}",
                "11".repeat(16),
                "22".repeat(16)
            )
        );
    }

    #[test]
    fn a_wrapper_is_bound_to_its_vault_and_key() {
        let context = crate::xml::VaultContext {
            vault_id: [0x11; 16],
            key_id: [0x22; 16],
        };
        let enrollment = Enrollment {
            version: WRAPPER_VERSION,
            vault_id: hex16(&context.vault_id),
            key_id: hex16(&context.key_id),
            alias: "alias".to_string(),
            iv: "iv".to_string(),
            ciphertext: "ciphertext".to_string(),
        };
        assert!(wrapper_matches(&enrollment, &context));
        let other = crate::xml::VaultContext {
            vault_id: [0x33; 16],
            key_id: [0x22; 16],
        };
        assert!(!wrapper_matches(&enrollment, &other));
    }

    #[test]
    fn a_wrapper_roundtrips_through_the_private_file() {
        let dir = std::env::temp_dir().join(format!(
            "fly-diary-biometric-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        let enrollment = Enrollment {
            version: WRAPPER_VERSION,
            vault_id: "11".repeat(16),
            key_id: "22".repeat(16),
            alias: "alias".to_string(),
            iv: B64.encode(b"iv"),
            ciphertext: B64.encode(b"ciphertext"),
        };
        write(&dir, &enrollment).unwrap();
        let read_back = read(&dir).unwrap().unwrap();
        assert_eq!(read_back.alias, enrollment.alias);
        assert_eq!(read_back.ciphertext, enrollment.ciphertext);
        remove_wrapper(&dir);
        assert!(!path(&dir).exists());
        let _ = fs::remove_dir_all(&dir);
    }
}
