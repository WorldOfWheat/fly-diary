//! XML serialization for encrypted diary entries.
//!
//! On-disk format (one file per day, `YYYY-MM-DD.xml`):
//!
//! ```xml
//! <?xml version="1.0" encoding="UTF-8"?>
//! <diary version="2">
//!   <date>2026-10-23</date>
//!   <iv>BASE64</iv>
//!   <payload>BASE64(AES-256-GCM ciphertext)</payload>
//! </diary>
//! ```
//!
//! Both the title and the body live inside `payload`, so nothing about the
//! entry's contents is readable without the passphrase. Only `date` stays in
//! the clear, and it is already implied by the filename.
//!
//! Version 1 files stored `<title>` in the clear and the body in `<content>`.
//! [`from_xml`] still accepts them so existing diaries keep working; the next
//! save rewrites the file in the version 2 layout.

use quick_xml::events::{BytesDecl, BytesEnd, BytesStart, BytesText, Event};
use quick_xml::{Reader, Writer};

/// An encrypted diary entry as it lives on disk.
#[derive(Debug, Clone)]
pub struct EncryptedEntry {
    pub date: String,
    /// Base64 encoded 12-byte AES-GCM nonce.
    pub iv: String,
    /// Base64 encoded ciphertext (includes the GCM tag).
    ///
    /// In version 2 this is the encrypted `title` + `content` bundle. In
    /// version 1 files it is the encrypted body only.
    pub payload: String,
    /// Version 1 only: the title, which used to be stored in the clear.
    pub legacy_title: Option<String>,
}

impl EncryptedEntry {
    /// Build a version 2 entry from an already encrypted payload.
    pub fn new(date: impl Into<String>, iv: impl Into<String>, payload: impl Into<String>) -> Self {
        Self {
            date: date.into(),
            iv: iv.into(),
            payload: payload.into(),
            legacy_title: None,
        }
    }
}

/// Remove characters that are illegal in XML 1.0 documents.
///
/// `quick-xml` escapes markup characters for us, but it does not reject
/// control characters, so we filter them out before handing text to the
/// writer. Tab, newline and carriage return are legal and preserved.
fn sanitize(text: &str) -> String {
    text.chars()
        .filter(|c| {
            let code = *c as u32;
            code == 0x09 || code == 0x0a || code == 0x0d || code >= 0x20
        })
        .collect()
}

/// Serialize an encrypted entry to an XML document.
///
/// Escaping is delegated to [`quick_xml::Writer`], which handles the XML
/// special characters (`&`, `<`, `>`, `"`, `'`) for us.
pub fn to_xml(entry: &EncryptedEntry) -> Result<String, String> {
    let mut writer = Writer::new_with_indent(Vec::new(), b' ', 2);

    writer
        .write_event(Event::Decl(BytesDecl::new("1.0", Some("UTF-8"), None)))
        .map_err(|e| format!("Failed to write XML declaration: {e}"))?;

    let mut root = BytesStart::new("diary");
    root.push_attribute(("version", "2"));
    writer
        .write_event(Event::Start(root))
        .map_err(|e| format!("Failed to write <diary>: {e}"))?;

    let fields = [
        ("date", &entry.date),
        ("iv", &entry.iv),
        ("payload", &entry.payload),
    ];

    for (tag, value) in fields {
        writer
            .write_event(Event::Start(BytesStart::new(tag)))
            .map_err(|e| format!("Failed to write <{tag}>: {e}"))?;
        writer
            .write_event(Event::Text(BytesText::new(&sanitize(value))))
            .map_err(|e| format!("Failed to write text of <{tag}>: {e}"))?;
        writer
            .write_event(Event::End(BytesEnd::new(tag)))
            .map_err(|e| format!("Failed to close <{tag}>: {e}"))?;
    }

    writer
        .write_event(Event::End(BytesEnd::new("diary")))
        .map_err(|e| format!("Failed to close <diary>: {e}"))?;

    String::from_utf8(writer.into_inner())
        .map_err(|e| format!("Serialized XML is not valid UTF-8: {e}"))
}

/// Parse an XML document produced by [`to_xml`].
///
/// Version 1 documents (`<title>` + `<content>`) are also accepted.
pub fn from_xml(xml: &str) -> Result<EncryptedEntry, String> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);

    let mut date = None;
    let mut iv = None;
    let mut payload = None;
    let mut legacy_title = None;
    let mut legacy_content = None;
    // Track which elements were *seen* separately from their text, so that an
    // empty `<payload></payload>` is not mistaken for a missing element.
    let mut seen_date = false;
    let mut seen_iv = false;
    let mut seen_payload = false;
    let mut seen_content = false;
    let mut current: Option<String> = None;

    loop {
        match reader.read_event() {
            Ok(Event::Start(e)) => {
                let name = String::from_utf8_lossy(e.name().as_ref()).to_string();
                match name.as_str() {
                    "date" => seen_date = true,
                    "iv" => seen_iv = true,
                    "payload" => seen_payload = true,
                    "content" => seen_content = true,
                    _ => {}
                }
                current = Some(name);
            }
            Ok(Event::Text(e)) => {
                let text = e
                    .unescape()
                    .map_err(|err| format!("Invalid XML text: {err}"))?
                    .to_string();
                match current.as_deref() {
                    Some("date") => date = Some(text),
                    Some("iv") => iv = Some(text),
                    Some("payload") => payload = Some(text),
                    Some("title") => legacy_title = Some(text),
                    Some("content") => legacy_content = Some(text),
                    _ => {}
                }
            }
            Ok(Event::End(_)) => current = None,
            Ok(Event::Eof) => break,
            Err(e) => return Err(format!("Failed to parse XML: {e}")),
            _ => {}
        }
    }

    if !seen_date {
        return Err("Missing <date> element".to_string());
    }
    if !seen_iv {
        return Err("Missing <iv> element".to_string());
    }

    // Version 2 uses <payload>; version 1 used <content>.
    let payload = if seen_payload {
        payload.unwrap_or_default()
    } else if seen_content {
        legacy_content.unwrap_or_default()
    } else {
        return Err("Missing <payload> element".to_string());
    };

    Ok(EncryptedEntry {
        date: date.unwrap_or_default(),
        iv: iv.unwrap_or_default(),
        payload,
        legacy_title,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip() {
        let entry = EncryptedEntry::new("2026-10-23", "AAAA", "BBBB");
        let parsed = from_xml(&to_xml(&entry).unwrap()).unwrap();
        assert_eq!(parsed.date, entry.date);
        assert_eq!(parsed.iv, entry.iv);
        assert_eq!(parsed.payload, entry.payload);
        assert!(parsed.legacy_title.is_none());
    }

    #[test]
    fn missing_date_is_error() {
        let xml = "<diary><iv>a</iv><payload>b</payload></diary>";
        assert!(from_xml(xml).is_err());
    }

    fn entry(payload: &str) -> EncryptedEntry {
        EncryptedEntry::new("2026-10-23", "AAAA", payload)
    }

    #[test]
    fn escapes_all_xml_specials() {
        let xml = to_xml(&entry("a & b < c > d \" e ' f")).unwrap();

        // Build the expected escaped form from character codes so this test
        // file never contains raw entity literals.
        let amp = '\u{26}'.to_string();
        let expected = format!(
            "a {amp}amp; b {amp}lt; c {amp}gt; d {amp}quot; e {amp}apos; f"
        );
        assert!(xml.contains(&expected), "xml was: {xml}");

        // No unescaped markup may leak into the document.
        assert!(!xml.contains("<b>"));
        assert!(!xml.contains("</b>"));
    }

    #[test]
    fn special_characters_roundtrip() {
        let original = entry("x & y < z");
        let parsed = from_xml(&to_xml(&original).unwrap()).unwrap();
        assert_eq!(parsed.payload, original.payload);
    }

    #[test]
    fn multiline_payload_roundtrip() {
        let original = entry("第一行\n第二行\n\n第四行");
        let parsed = from_xml(&to_xml(&original).unwrap()).unwrap();
        assert_eq!(parsed.payload, original.payload);
    }

    #[test]
    fn cjk_and_emoji_roundtrip() {
        let original = entry("日記標題 🦋 今天很開心 ✨ 內容");
        let parsed = from_xml(&to_xml(&original).unwrap()).unwrap();
        assert_eq!(parsed.payload, original.payload);
    }

    #[test]
    fn illegal_control_characters_are_stripped() {
        let xml = to_xml(&entry("bad\u{0}payload")).unwrap();
        assert!(!xml.contains('\u{0}'));
        let parsed = from_xml(&xml).unwrap();
        assert_eq!(parsed.payload, "badpayload");
    }

    #[test]
    fn tabs_and_newlines_are_preserved() {
        let xml = to_xml(&entry("a\tb")).unwrap();
        let parsed = from_xml(&xml).unwrap();
        assert_eq!(parsed.payload, "a\tb");
    }

    #[test]
    fn empty_payload_is_allowed() {
        let parsed = from_xml(&to_xml(&entry("")).unwrap()).unwrap();
        assert_eq!(parsed.payload, "");
    }

    #[test]
    fn missing_iv_is_error() {
        let xml = "<diary><date>2026-10-23</date><payload>b</payload></diary>";
        let err = from_xml(xml).unwrap_err();
        assert!(err.contains("<iv>"), "got: {err}");
    }

    #[test]
    fn missing_payload_is_error() {
        let xml = "<diary><date>2026-10-23</date><iv>a</iv></diary>";
        let err = from_xml(xml).unwrap_err();
        assert!(err.contains("<payload>"), "got: {err}");
    }

    #[test]
    fn malformed_xml_is_error() {
        assert!(from_xml("<diary><payload>unclosed").is_err());
    }

    #[test]
    fn empty_input_is_error() {
        assert!(from_xml("").is_err());
    }

    #[test]
    fn output_declares_utf8_and_version() {
        let xml = to_xml(&entry("c")).unwrap();
        assert!(xml.starts_with("<?xml version=\"1.0\" encoding=\"UTF-8\"?>"));
        assert!(xml.contains("<diary version=\"2\">"));
    }

    #[test]
    fn output_has_no_cleartext_title_element() {
        let xml = to_xml(&entry("c")).unwrap();
        assert!(!xml.contains("<title>"), "xml was: {xml}");
        assert!(!xml.contains("<content>"), "xml was: {xml}");
    }

    #[test]
    fn unknown_elements_are_ignored() {
        let xml = "<diary><date>2026-10-23</date>\
                   <iv>a</iv><payload>b</payload><extra>ignored</extra></diary>";
        let parsed = from_xml(xml).unwrap();
        assert_eq!(parsed.payload, "b");
    }

    #[test]
    fn reads_version_1_documents() {
        let xml = "<diary version=\"1\"><title>明文標題</title>\
                   <date>2026-10-23</date><iv>a</iv><content>b</content></diary>";
        let parsed = from_xml(xml).unwrap();
        assert_eq!(parsed.date, "2026-10-23");
        assert_eq!(parsed.iv, "a");
        assert_eq!(parsed.payload, "b");
        assert_eq!(parsed.legacy_title.as_deref(), Some("明文標題"));
    }

    #[test]
    fn version_1_without_title_yields_no_legacy_title() {
        // `trim_text(true)` drops the text event of an empty element, so an
        // empty <title></title> is indistinguishable from a missing one.
        let xml = "<diary version=\"1\">\
                   <date>2026-10-23</date><iv>a</iv><content>b</content></diary>";
        let parsed = from_xml(xml).unwrap();
        assert!(parsed.legacy_title.is_none());
        assert_eq!(parsed.payload, "b");
    }
}
