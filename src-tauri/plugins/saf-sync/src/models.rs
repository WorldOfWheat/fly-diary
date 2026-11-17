//! Rust wrapper around the Android SAF plugin.
//!
//! All bulk bytes stay inside Kotlin/Java I/O: the commands below only exchange
//! paths and metadata, and the Kotlin side copies directly between the SAF
//! document and the app-private file.

use serde::{Deserialize, Serialize};

/// Result of the folder picker. Both fields are `None` when the user cancels.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PickedDirectory {
    pub uri: Option<String>,
    pub name: Option<String>,
}

/// Whether the persisted SAF permission still works.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryCheck {
    pub available: bool,
    pub name: String,
}

/// One file inside the picked folder.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteFile {
    pub path: String,
    pub size: u64,
    pub mtime_ms: i64,
}

/// Response of `listFiles`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteFiles {
    pub files: Vec<RemoteFile>,
}

/// Response of `copyToLocal`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CopyResult {
    pub bytes: u64,
}

/// Response of `copyFromLocal`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileMeta {
    pub size: u64,
    pub mtime_ms: i64,
}

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct Empty {}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UriRequest {
    pub uri: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CopyToLocalRequest {
    pub uri: String,
    pub remote_path: String,
    pub local_path: String,
    pub max_bytes: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CopyFromLocalRequest {
    pub uri: String,
    pub local_path: String,
    pub remote_path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteRequest {
    pub uri: String,
    pub remote_path: String,
}
