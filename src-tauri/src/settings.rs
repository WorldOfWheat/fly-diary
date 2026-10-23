//! Application settings persisted outside the diary directory.
//!
//! The settings file lives in the platform config directory (e.g.
//! `~/.config/com.flydiary.app/settings.xml` on Linux) and records *where* the
//! encrypted diary lives. It deliberately never stores the passphrase or any
//! key material — only the location, so the user has to type the passphrase on
//! every launch.
//!
//! ```xml
//! <?xml version="1.0" encoding="UTF-8"?>
//! <settings version="1">
//!   <diary-dir>/home/user/Documents/diary</diary-dir>
//! </settings>
//! ```

use std::fs;
use std::path::{Path, PathBuf};

use quick_xml::events::{BytesDecl, BytesEnd, BytesStart, BytesText, Event};
use quick_xml::{Reader, Writer};

/// Name of the settings file inside the config directory.
const SETTINGS_FILE: &str = "settings.xml";

/// Persisted application settings.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Settings {
    /// Absolute path of the directory holding the encrypted diary files.
    pub diary_dir: PathBuf,
}

/// Resolve the settings file path inside `config_dir`.
pub fn settings_path(config_dir: &Path) -> PathBuf {
    config_dir.join(SETTINGS_FILE)
}

/// Validate a user-supplied diary directory.
///
/// The path must be absolute so the diary does not silently move when the
/// process working directory changes, and it must not be the filesystem root.
pub fn validate_diary_dir(dir: &Path) -> Result<(), String> {
    if !dir.is_absolute() {
        return Err(format!(
            "Diary path must be absolute: {}",
            dir.to_string_lossy()
        ));
    }
    if dir.parent().is_none() {
        return Err("Diary path must not be the filesystem root".to_string());
    }
    Ok(())
}

/// Read the settings file, returning `None` when it does not exist yet.
pub fn read_settings(config_dir: &Path) -> Result<Option<Settings>, String> {
    let path = settings_path(config_dir);
    let text = match fs::read_to_string(&path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("Failed to read settings: {e}")),
    };

    let mut diary_dir = None;
    let mut seen_diary_dir = false;
    let mut current = String::new();

    let mut reader = Reader::from_str(&text);
    reader.config_mut().trim_text(true);
    loop {
        match reader.read_event() {
            Ok(Event::Start(e)) => {
                current = String::from_utf8_lossy(e.name().as_ref()).to_string();
                if current == "diary-dir" {
                    seen_diary_dir = true;
                }
            }
            Ok(Event::Text(e)) => {
                let value = e
                    .unescape()
                    .map_err(|err| format!("Invalid settings XML: {err}"))?
                    .to_string();
                if current == "diary-dir" {
                    diary_dir = Some(value);
                }
            }
            Ok(Event::End(_)) => current.clear(),
            Ok(Event::Eof) => break,
            Err(e) => return Err(format!("Failed to parse settings: {e}")),
            _ => {}
        }
    }

    if !seen_diary_dir {
        return Err("Settings file is missing <diary-dir>".to_string());
    }

    let raw = diary_dir.unwrap_or_default();
    if raw.is_empty() {
        return Err("Settings file has an empty <diary-dir>".to_string());
    }

    let dir = PathBuf::from(raw);
    validate_diary_dir(&dir)?;
    Ok(Some(Settings { diary_dir: dir }))
}

/// Serialize settings to an XML document.
pub fn to_xml(settings: &Settings) -> Result<String, String> {
    let mut writer = Writer::new_with_indent(Vec::new(), b' ', 2);

    writer
        .write_event(Event::Decl(BytesDecl::new("1.0", Some("UTF-8"), None)))
        .map_err(|e| format!("Failed to write XML declaration: {e}"))?;

    let mut root = BytesStart::new("settings");
    root.push_attribute(("version", "1"));
    writer
        .write_event(Event::Start(root))
        .map_err(|e| format!("Failed to write <settings>: {e}"))?;

    writer
        .write_event(Event::Start(BytesStart::new("diary-dir")))
        .map_err(|e| format!("Failed to write <diary-dir>: {e}"))?;
    writer
        .write_event(Event::Text(BytesText::new(
            &settings.diary_dir.to_string_lossy(),
        )))
        .map_err(|e| format!("Failed to write diary path: {e}"))?;
    writer
        .write_event(Event::End(BytesEnd::new("diary-dir")))
        .map_err(|e| format!("Failed to close <diary-dir>: {e}"))?;

    writer
        .write_event(Event::End(BytesEnd::new("settings")))
        .map_err(|e| format!("Failed to close <settings>: {e}"))?;

    String::from_utf8(writer.into_inner())
        .map_err(|e| format!("Serialized settings are not valid UTF-8: {e}"))
}

/// Write settings, creating the config directory if needed.
pub fn write_settings(config_dir: &Path, settings: &Settings) -> Result<(), String> {
    validate_diary_dir(&settings.diary_dir)?;
    fs::create_dir_all(config_dir)
        .map_err(|e| format!("Failed to create config directory: {e}"))?;
    let document = to_xml(settings)?;
    fs::write(settings_path(config_dir), document)
        .map_err(|e| format!("Failed to write settings: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "fly-diary-settings-test-{}-{}",
            name,
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn sample(dir: &Path) -> Settings {
        Settings {
            diary_dir: dir.join("diary"),
        }
    }

    #[test]
    fn roundtrip() {
        let config = temp_dir("roundtrip");
        let settings = sample(&config);
        write_settings(&config, &settings).unwrap();

        let loaded = read_settings(&config).unwrap().unwrap();
        assert_eq!(loaded, settings);

        let _ = fs::remove_dir_all(&config);
    }

    #[test]
    fn missing_file_returns_none() {
        let config = temp_dir("missing");
        assert!(read_settings(&config).unwrap().is_none());
        let _ = fs::remove_dir_all(&config);
    }

    #[test]
    fn written_settings_are_readable() {
        let config = temp_dir("exists");
        assert!(read_settings(&config).unwrap().is_none());
        write_settings(&config, &sample(&config)).unwrap();
        assert!(read_settings(&config).unwrap().is_some());
        let _ = fs::remove_dir_all(&config);
    }

    #[test]
    fn rejects_relative_path() {
        let err = validate_diary_dir(Path::new("relative/diary")).unwrap_err();
        assert!(err.contains("absolute"), "got: {err}");
    }

    #[test]
    fn rejects_filesystem_root() {
        let err = validate_diary_dir(Path::new("/")).unwrap_err();
        assert!(err.contains("root"), "got: {err}");
    }

    #[test]
    fn accepts_absolute_path() {
        assert!(validate_diary_dir(Path::new("/home/user/diary")).is_ok());
    }

    #[test]
    fn write_rejects_relative_path() {
        let config = temp_dir("write-relative");
        let bad = Settings {
            diary_dir: PathBuf::from("relative/diary"),
        };
        assert!(write_settings(&config, &bad).is_err());
        assert!(read_settings(&config).unwrap().is_none());
        let _ = fs::remove_dir_all(&config);
    }

    #[test]
    fn creates_config_directory() {
        let base = temp_dir("create-config");
        let config = base.join("nested").join("config");
        write_settings(&config, &sample(&base)).unwrap();
        assert!(settings_path(&config).exists());
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn xml_declares_utf8_and_version() {
        let config = temp_dir("decl");
        let xml = to_xml(&sample(&config)).unwrap();
        assert!(xml.starts_with("<?xml version=\"1.0\" encoding=\"UTF-8\"?>"));
        assert!(xml.contains("<settings version=\"1\">"));
        let _ = fs::remove_dir_all(&config);
    }

    #[test]
    fn path_with_special_characters_roundtrips() {
        let config = temp_dir("specials");
        let settings = Settings {
            diary_dir: config.join("a & b < c > d \" e ' f"),
        };
        write_settings(&config, &settings).unwrap();
        let loaded = read_settings(&config).unwrap().unwrap();
        assert_eq!(loaded, settings);
        let _ = fs::remove_dir_all(&config);
    }

    #[test]
    fn path_with_cjk_roundtrips() {
        let config = temp_dir("cjk");
        let settings = Settings {
            diary_dir: config.join("我的日記 🦋"),
        };
        write_settings(&config, &settings).unwrap();
        let loaded = read_settings(&config).unwrap().unwrap();
        assert_eq!(loaded, settings);
        let _ = fs::remove_dir_all(&config);
    }

    #[test]
    fn empty_diary_dir_is_error() {
        let config = temp_dir("empty-dir");
        fs::write(
            settings_path(&config),
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<settings version=\"1\">\n  <diary-dir></diary-dir>\n</settings>\n",
        )
        .unwrap();
        let err = read_settings(&config).unwrap_err();
        assert!(err.contains("empty"), "got: {err}");
        let _ = fs::remove_dir_all(&config);
    }

    #[test]
    fn missing_diary_dir_element_is_error() {
        let config = temp_dir("no-element");
        fs::write(
            settings_path(&config),
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<settings version=\"1\">\n</settings>\n",
        )
        .unwrap();
        let err = read_settings(&config).unwrap_err();
        assert!(err.contains("<diary-dir>"), "got: {err}");
        let _ = fs::remove_dir_all(&config);
    }

    #[test]
    fn relative_path_in_file_is_rejected() {
        let config = temp_dir("relative-file");
        fs::write(
            settings_path(&config),
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<settings version=\"1\">\n  <diary-dir>relative/diary</diary-dir>\n</settings>\n",
        )
        .unwrap();
        let err = read_settings(&config).unwrap_err();
        assert!(err.contains("absolute"), "got: {err}");
        let _ = fs::remove_dir_all(&config);
    }

    #[test]
    fn malformed_xml_is_error() {
        let config = temp_dir("malformed");
        fs::write(settings_path(&config), "<settings><diary-dir>unclosed").unwrap();
        assert!(read_settings(&config).is_err());
        let _ = fs::remove_dir_all(&config);
    }

    #[test]
    fn overwrite_replaces_previous_path() {
        let config = temp_dir("overwrite");
        let first = Settings {
            diary_dir: config.join("first"),
        };
        let second = Settings {
            diary_dir: config.join("second"),
        };
        write_settings(&config, &first).unwrap();
        write_settings(&config, &second).unwrap();
        assert_eq!(read_settings(&config).unwrap().unwrap(), second);
        let _ = fs::remove_dir_all(&config);
    }

    #[test]
    fn settings_file_contains_no_passphrase() {
        let config = temp_dir("no-secret");
        write_settings(&config, &sample(&config)).unwrap();
        let text = fs::read_to_string(settings_path(&config)).unwrap();
        assert!(!text.contains("passphrase"));
        assert!(!text.contains("password"));
        assert!(!text.contains("key"));
        let _ = fs::remove_dir_all(&config);
    }
}
