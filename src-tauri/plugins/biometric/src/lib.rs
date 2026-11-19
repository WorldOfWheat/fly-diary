// Copyright 2026 Fly Diary contributors
// SPDX-License-Identifier: MIT

//! Android biometric unlock for Fly Diary.
//!
//! The Kotlin side owns the Android Keystore key and drives BiometricPrompt.
//! Rust only sees the wrapped diary key, never the passphrase or fingerprint
//! data. All methods are no-ops on desktop; the commands that use this plugin
//! are gated in the main crate.

use serde::Deserialize;
use tauri::{
    Runtime,
    plugin::{Builder, TauriPlugin},
};

#[cfg(target_os = "android")]
use serde::Serialize;
#[cfg(target_os = "android")]
use tauri::Manager;

#[cfg(target_os = "android")]
use tauri::plugin::PluginHandle;

#[cfg(target_os = "android")]
const PLUGIN_IDENTIFIER: &str = "com.flydiary.biometric";

/// Native availability returned by `BiometricManager`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeStatus {
    pub available: bool,
    pub key_exists: bool,
    pub reason: Option<String>,
}

/// Encrypted diary key returned after a successful enrollment prompt.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Enrollment {
    pub iv: String,
    pub ciphertext: String,
}

/// Decrypted diary key returned after a successful unlock prompt.
#[derive(Debug, Clone, Deserialize)]
pub struct Decrypted {
    pub payload: String,
}

#[cfg(target_os = "android")]
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StatusArgs {
    alias: Option<String>,
}

#[cfg(target_os = "android")]
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EnrollArgs {
    alias: String,
    payload: String,
    aad: String,
}

#[cfg(target_os = "android")]
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DecryptArgs {
    alias: String,
    iv: String,
    ciphertext: String,
    aad: String,
}

#[cfg(target_os = "android")]
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DeleteArgs {
    alias: String,
}

/// Handle to the Android plugin. Cloneable so it can move into a blocking task.
#[cfg(target_os = "android")]
#[derive(Clone)]
pub struct Biometric<R: Runtime>(PluginHandle<R>);

#[cfg(target_os = "android")]
impl<R: Runtime> Biometric<R> {
    pub fn status(&self, alias: Option<String>) -> Result<NativeStatus, String> {
        self.0
            .run_mobile_plugin("status", StatusArgs { alias })
            .map_err(|error| error.to_string())
    }

    pub fn enroll(
        &self,
        alias: String,
        payload: String,
        aad: String,
    ) -> Result<Enrollment, String> {
        self.0
            .run_mobile_plugin("enroll", EnrollArgs { alias, payload, aad })
            .map_err(|error| error.to_string())
    }

    pub fn decrypt(
        &self,
        alias: String,
        iv: String,
        ciphertext: String,
        aad: String,
    ) -> Result<Decrypted, String> {
        self.0
            .run_mobile_plugin(
                "decrypt",
                DecryptArgs {
                    alias,
                    iv,
                    ciphertext,
                    aad,
                },
            )
            .map_err(|error| error.to_string())
    }

    pub fn delete_key(&self, alias: String) -> Result<(), String> {
        self.0
            .run_mobile_plugin("deleteKey", DeleteArgs { alias })
            .map_err(|error| error.to_string())
    }
}

/// Register the native Android side of the plugin.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("biometric")
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            {
                let handle =
                    api.register_android_plugin(PLUGIN_IDENTIFIER, "BiometricPlugin")?;
                app.manage(Biometric(handle));
            }
            #[cfg(not(target_os = "android"))]
            {
                let _ = (app, api);
            }
            Ok(())
        })
        .build()
}
