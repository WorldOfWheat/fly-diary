use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

/// Metadata for a single diary entry, used by the sidebar list.
#[derive(Debug, Clone, Serialize)]
pub struct EntryMeta {
    /// Date in `YYYY-MM-DD` format.
    pub date: String,
    /// First non-empty line of the entry, trimmed for display.
    pub preview: String,
    /// File size in bytes.
    pub size: u64,
}

/// A full diary entry.
#[derive(Debug, Clone, Serialize)]
pub struct Entry {
    pub date: String,
    pub content: String,
}

/// Validate that `date` is a real calendar date in `YYYY-MM-DD` form.
///
/// This is the single source of truth for what counts as a valid entry key,
/// and it also prevents path traversal (e.g. `../../etc/passwd`).
pub fn validate_date(date: &str) -> Result<(), String> {
    if date.len() != 10 {
        return Err(format!("Invalid date format: {date}"));
    }
    chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d")
        .map(|_| ())
        .map_err(|_| format!("Invalid date: {date}"))
}

/// Resolve the file path for a given date inside the diary directory.
fn entry_path(dir: &Path, date: &str) -> Result<PathBuf, String> {
    validate_date(date)?;
    Ok(dir.join(format!("{date}.md")))
}

/// Ensure the diary directory exists, creating it if necessary.
pub fn ensure_dir(dir: &Path) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| format!("Failed to create diary directory: {e}"))
}

/// Read a single entry. Returns `None` when the file does not exist yet.
pub fn read_entry(dir: &Path, date: &str) -> Result<Option<Entry>, String> {
    let path = entry_path(dir, date)?;
    match fs::read_to_string(&path) {
        Ok(content) => Ok(Some(Entry {
            date: date.to_string(),
            content,
        })),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("Failed to read entry {date}: {e}")),
    }
}

/// Write (create or overwrite) the entry for a given date.
///
/// Because the filename is derived from the date, writing the same date twice
/// naturally performs an upsert: there can only ever be one file per day.
pub fn write_entry(dir: &Path, date: &str, content: &str) -> Result<(), String> {
    ensure_dir(dir)?;
    let path = entry_path(dir, date)?;
    fs::write(&path, content).map_err(|e| format!("Failed to write entry {date}: {e}"))
}

/// Delete the entry for a given date. Missing files are treated as success.
pub fn delete_entry(dir: &Path, date: &str) -> Result<(), String> {
    let path = entry_path(dir, date)?;
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("Failed to delete entry {date}: {e}")),
    }
}

/// List all entries, newest first.
pub fn list_entries(dir: &Path) -> Result<Vec<EntryMeta>, String> {
    ensure_dir(dir)?;
    let mut entries = Vec::new();

    let read_dir = fs::read_dir(dir).map_err(|e| format!("Failed to read diary directory: {e}"))?;
    for item in read_dir {
        let item = item.map_err(|e| format!("Failed to read directory entry: {e}"))?;
        let path = item.path();
        if path.extension().and_then(|s| s.to_str()) != Some("md") {
            continue;
        }
        let Some(date) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        // Skip files whose names are not valid dates.
        if validate_date(date).is_err() {
            continue;
        }

        let content = fs::read_to_string(&path).unwrap_or_default();
        let size = item.metadata().map(|m| m.len()).unwrap_or(0);
        entries.push(EntryMeta {
            date: date.to_string(),
            preview: make_preview(&content),
            size,
        });
    }

    // Newest first; ISO dates sort lexicographically.
    entries.sort_by(|a, b| b.date.cmp(&a.date));
    Ok(entries)
}

/// Build a short single-line preview from entry content.
fn make_preview(content: &str) -> String {
    let line = content
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("");
    let mut preview: String = line.chars().take(60).collect();
    if line.chars().count() > 60 {
        preview.push('…');
    }
    preview
}
