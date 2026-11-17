use serde::de::DeserializeOwned;
use tauri::{plugin::PluginApi, AppHandle, Runtime};

use crate::models::*;
use crate::{Error, Result};

/// Desktop stand-in so the crate can still be type-checked on other targets.
pub struct SafSync<R: Runtime>(#[allow(dead_code)] AppHandle<R>);

pub fn init<R: Runtime, C: DeserializeOwned>(
    app: &AppHandle<R>,
    _api: PluginApi<R, C>,
) -> Result<SafSync<R>> {
    Ok(SafSync(app.clone()))
}

impl<R: Runtime> SafSync<R> {
    pub fn pick_directory(&self) -> Result<PickedDirectory> {
        Err(Error::Unsupported)
    }

    pub fn check_directory(&self, _uri: &str) -> Result<DirectoryCheck> {
        Err(Error::Unsupported)
    }

    pub fn list_files(&self, _uri: &str) -> Result<Vec<RemoteFile>> {
        Err(Error::Unsupported)
    }

    pub fn copy_to_local(
        &self,
        _uri: &str,
        _remote_path: &str,
        _local_path: &str,
        _max_bytes: u64,
    ) -> Result<CopyResult> {
        Err(Error::Unsupported)
    }

    pub fn copy_from_local(
        &self,
        _uri: &str,
        _local_path: &str,
        _remote_path: &str,
    ) -> Result<FileMeta> {
        Err(Error::Unsupported)
    }

    pub fn delete(&self, _uri: &str, _remote_path: &str) -> Result<()> {
        Err(Error::Unsupported)
    }
}
