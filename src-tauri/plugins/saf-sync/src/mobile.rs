use serde::de::DeserializeOwned;
use tauri::{
    plugin::{PluginApi, PluginHandle},
    AppHandle, Runtime,
};

use crate::models::*;
use crate::{Error, Result};

/// Handle to the Kotlin `SafSyncPlugin`.
pub struct SafSync<R: Runtime>(PluginHandle<R>);

pub fn init<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    api: PluginApi<R, C>,
) -> Result<SafSync<R>> {
    let handle =
        api.register_android_plugin("com.flydiary.safsync", "SafSyncPlugin")?;
    Ok(SafSync(handle))
}

impl<R: Runtime> SafSync<R> {
    fn call<I: serde::Serialize, O: DeserializeOwned>(&self, command: &str, payload: I) -> Result<O> {
        self.0
            .run_mobile_plugin(command, payload)
            .map_err(|error| Error::Plugin(error.to_string()))
    }

    /// Open the SAF folder picker. Resolves to `None` fields when cancelled.
    pub fn pick_directory(&self) -> Result<PickedDirectory> {
        self.call("pickDirectory", Empty {})
    }

    /// Verify that the persisted URI permission is still granted.
    pub fn check_directory(&self, uri: &str) -> Result<DirectoryCheck> {
        self.call(
            "checkDirectory",
            UriRequest {
                uri: uri.to_string(),
            },
        )
    }

    /// List every file below the tree, with slash-separated relative paths.
    pub fn list_files(&self, uri: &str) -> Result<Vec<RemoteFile>> {
        let response: RemoteFiles = self.call(
            "listFiles",
            UriRequest {
                uri: uri.to_string(),
            },
        )?;
        Ok(response.files)
    }

    /// Copy one SAF document into an app-private file atomically.
    pub fn copy_to_local(
        &self,
        uri: &str,
        remote_path: &str,
        local_path: &str,
        max_bytes: u64,
    ) -> Result<CopyResult> {
        self.call(
            "copyToLocal",
            CopyToLocalRequest {
                uri: uri.to_string(),
                remote_path: remote_path.to_string(),
                local_path: local_path.to_string(),
                max_bytes,
            },
        )
    }

    /// Copy an app-private file to the SAF tree, replacing any existing file.
    pub fn copy_from_local(
        &self,
        uri: &str,
        local_path: &str,
        remote_path: &str,
    ) -> Result<FileMeta> {
        self.call(
            "copyFromLocal",
            CopyFromLocalRequest {
                uri: uri.to_string(),
                local_path: local_path.to_string(),
                remote_path: remote_path.to_string(),
            },
        )
    }

    /// Delete one SAF document. Missing files are treated as success.
    pub fn delete(&self, uri: &str, remote_path: &str) -> Result<()> {
        let _: Empty = self.call(
            "deleteFile",
            DeleteRequest {
                uri: uri.to_string(),
                remote_path: remote_path.to_string(),
            },
        )?;
        Ok(())
    }
}
