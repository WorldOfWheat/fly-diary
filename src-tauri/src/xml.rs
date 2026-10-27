//! XML serialization for encrypted diary entries.
//!
//! On-disk format (one file per day, `YYYY-MM-DD.xml`):
//!
//! ```xml
//! <?xml version="1.0" encoding="UTF-8"?>
//! <diary version="4">
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
//! ## Versions
//!
//! * **4** — `payload` is encrypted with [`entry_aad`] as AES-GCM associated
//!   data: the entry's date *and* the document version. Binding the version
//!   means the `version` attribute cannot be edited to talk a reader into
//!   using a weaker (or no) AAD scheme.
//! * **3** — `payload` is encrypted with the entry's date as associated data,
//!   so a ciphertext cannot be moved to another day. The version itself is
//!   *not* authenticated, which is what version 4 fixes.
//! * **2** — `payload` is encrypted without associated data.
//! * **1** — `<title>` in the clear, body in `<content>`.
//!
//! [`from_xml`] accepts all four so existing diaries keep working; the next
//! save rewrites the file in the current layout.

use quick_xml::events::{BytesDecl, BytesEnd, BytesStart, BytesText, Event};
use quick_xml::{Reader, Writer};

/// The document version written by [`to_xml`].
///
/// Version 4 means the payload was encrypted with [`entry_aad`] — the entry's
/// date plus the version byte — as associated data. Readers use this to decide
/// which AAD (if any) to pass when decrypting.
pub const CURRENT_VERSION: u8 = 4;

/// Separator between the date and the version inside the AAD.
///
/// A byte that cannot appear in an ISO date, so `("2026-10-23", 4)` and
/// `("2026-10-2", 34)` can never produce the same associated data.
const AAD_SEPARATOR: u8 = 0x00;

/// The associated data a version 4 payload is bound to.
///
/// `date || 0x00 || version`. Including the version closes the downgrade hole
/// that version 3 left open: rewriting `<diary version="4">` to `3` (or `2`)
/// changes the AAD the reader derives, so the GCM tag no longer verifies and
/// the entry is reported as broken instead of being silently decrypted under
/// weaker rules.
pub fn entry_aad(date: &str, version: u8) -> Vec<u8> {
    let mut aad = Vec::with_capacity(date.len() + 2);
    aad.extend_from_slice(date.as_bytes());
    aad.push(AAD_SEPARATOR);
    aad.push(version);
    aad
}

/// An encrypted diary entry as it lives on disk.
#[derive(Debug, Clone)]
pub struct EncryptedEntry {
    pub date: String,
    /// Base64 encoded 12-byte AES-GCM nonce.
    pub iv: String,
    /// Base64 encoded ciphertext (includes the GCM tag).
    ///
    /// In versions 2, 3 and 4 this is the encrypted `title` + `content`
    /// bundle. In version 1 files it is the encrypted body only.
    pub payload: String,
    /// Version 1 only: the title, which used to be stored in the clear.
    pub legacy_title: Option<String>,
    /// Version of the document this entry was read from (or will be written
    /// as). Version 4 payloads are bound to date *and* version; version 3 to
    /// the date only; 1 and 2 are not bound at all.
    pub version: u8,
}

impl EncryptedEntry {
    /// Build a version 4 entry from an already encrypted payload.
    pub fn new(date: impl Into<String>, iv: impl Into<String>, payload: impl Into<String>) -> Self {
        Self {
            date: date.into(),
            iv: iv.into(),
            payload: payload.into(),
            legacy_title: None,
            version: CURRENT_VERSION,
        }
    }

    /// Override the document version.
    ///
    /// Only useful for tests that need to hand-build a document in an older
    /// layout: a version 1 or 2 payload is *not* AAD-bound, and a version 3
    /// payload is bound to the date alone, so writing one with the default
    /// version 4 header would produce a file that cannot be read.
    /// Production code always writes [`CURRENT_VERSION`], so this is test-only.
    #[cfg(test)]
    pub fn with_version(mut self, version: u8) -> Self {
        self.version = version;
        self
    }

    /// Whether the payload was encrypted with associated data at all.
    ///
    /// True for versions 3 and 4. Use [`Self::uses_version_aad`] to tell the
    /// two apart.
    pub fn is_aad_bound(&self) -> bool {
        self.version >= 3
    }

    /// Whether the payload is bound to the document version as well as the
    /// date (version 4 and up).
    pub fn uses_version_aad(&self) -> bool {
        self.version >= 4
    }

    /// The associated data this entry's payload must be decrypted with.
    ///
    /// Returns `None` for versions 1 and 2, which carry no AAD.
    pub fn aad(&self, date: &str) -> Option<Vec<u8>> {
        if self.uses_version_aad() {
            Some(entry_aad(date, self.version))
        } else if self.is_aad_bound() {
            Some(date.as_bytes().to_vec())
        } else {
            None
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
    root.push_attribute(("version", entry.version.to_string().as_str()));
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
    // Documents without a `version` attribute predate versioning; they are
    // treated as version 1, which is the only layout that had no attribute.
    let mut version: u8 = 1;
    let mut current: Option<String> = None;

    loop {
        match reader.read_event() {
            Ok(Event::Start(e)) | Ok(Event::Empty(e)) => {
                let name = String::from_utf8_lossy(e.name().as_ref()).to_string();
                if name == "diary" {
                    for attr in e.attributes().flatten() {
                        if attr.key.as_ref() == b"version" {
                            version = String::from_utf8_lossy(&attr.value)
                                .trim()
                                .parse()
                                .unwrap_or(1);
                        }
                    }
                }
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
        version,
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
        assert!(xml.contains("<diary version=\"4\">"), "xml was: {xml}");
    }

    #[test]
    fn version_roundtrips_through_the_document() {
        let xml = to_xml(&entry("c").with_version(2)).unwrap();
        assert!(xml.contains("<diary version=\"2\">"), "xml was: {xml}");
        assert_eq!(from_xml(&xml).unwrap().version, 2);
    }

    #[test]
    fn only_version_3_and_up_is_aad_bound() {
        assert!(!entry("c").with_version(1).is_aad_bound());
        assert!(!entry("c").with_version(2).is_aad_bound());
        assert!(entry("c").with_version(3).is_aad_bound());
        assert!(entry("c").with_version(4).is_aad_bound());
        assert!(entry("c").is_aad_bound());
    }

    #[test]
    fn only_version_4_and_up_binds_the_version() {
        assert!(!entry("c").with_version(1).uses_version_aad());
        assert!(!entry("c").with_version(2).uses_version_aad());
        assert!(!entry("c").with_version(3).uses_version_aad());
        assert!(entry("c").with_version(4).uses_version_aad());
        assert!(entry("c").uses_version_aad());
    }

    #[test]
    fn aad_is_none_for_versions_without_associated_data() {
        assert!(entry("c").with_version(1).aad("2026-10-23").is_none());
        assert!(entry("c").with_version(2).aad("2026-10-23").is_none());
    }

    #[test]
    fn version_3_aad_is_the_bare_date() {
        let aad = entry("c").with_version(3).aad("2026-10-23").unwrap();
        assert_eq!(aad, b"2026-10-23".to_vec());
    }

    #[test]
    fn version_4_aad_is_date_then_version() {
        let aad = entry("c").with_version(4).aad("2026-10-23").unwrap();
        assert_eq!(aad, entry_aad("2026-10-23", 4));
        assert_eq!(aad.len(), "2026-10-23".len() + 2);
        assert_eq!(aad[aad.len() - 2], 0x00);
        assert_eq!(aad[aad.len() - 1], 4);
    }

    #[test]
    fn aad_separator_prevents_date_version_ambiguity() {
        // Without a separator these two would collide.
        assert_ne!(entry_aad("2026-10-2", 34), entry_aad("2026-10-23", 4));
    }

    #[test]
    fn aad_differs_between_versions() {
        assert_ne!(entry_aad("2026-10-23", 3), entry_aad("2026-10-23", 4));
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
