//! Session-scoped full-text search.
//!
//! The diary stores every entry in its own encrypted XML file, so searching the
//! body would otherwise mean decrypting the whole vault on every keystroke. This
//! module builds an in-memory index once after unlocking and keeps it in step
//! with saves and deletes.
//!
//! Nothing here is written to disk: the index is derived state and lives only
//! while the vault is unlocked. Dropping it zeroizes the decrypted text, and
//! `lock` replaces the session index with an empty one.

use std::collections::BTreeMap;
use std::path::Path;

use serde::Serialize;
use zeroize::{Zeroize, Zeroizing};

use crate::storage::{self, BrokenEntry};

/// Number of results returned when the caller does not ask for a specific size.
pub const DEFAULT_LIMIT: usize = 50;

/// Upper bound for a single query, so a pathological request cannot build a
/// huge response.
pub const MAX_LIMIT: usize = 100;

/// Characters of context kept before the first match in a snippet.
const SNIPPET_BEFORE: usize = 30;

/// Characters of context kept after the first match in a snippet.
const SNIPPET_AFTER: usize = 60;

/// One decrypted entry held in memory.
///
/// The original text is kept for snippets and the lowercased copy for matching.
/// `to_lowercase` can change the byte length of a string (for example `İ`), so
/// the two copies are stored side by side instead of mapping offsets at query
/// time. Every field is zeroized when the document is dropped.
struct SearchDoc {
    title: Zeroizing<String>,
    title_lower: Zeroizing<String>,
    content: Zeroizing<String>,
    content_lower: Zeroizing<String>,
    favourite: bool,
}

impl SearchDoc {
    fn new(title: &str, content: &str, favourite: bool) -> Self {
        Self {
            title: Zeroizing::new(title.to_string()),
            title_lower: Zeroizing::new(title.to_lowercase()),
            content: Zeroizing::new(content.to_string()),
            content_lower: Zeroizing::new(content.to_lowercase()),
            favourite,
        }
    }
}

/// The in-memory index: one document per date.
///
/// `date` is plaintext on disk (it is the filename), so it is not treated as a
/// secret. Title and body are.
#[derive(Default)]
pub struct SearchIndex {
    docs: BTreeMap<String, SearchDoc>,
}

impl SearchIndex {
    /// Add or replace the document for `date`, preserving its favourite flag.
    pub fn upsert(&mut self, date: &str, title: &str, content: &str) {
        let favourite = self
            .docs
            .get(date)
            .map(|doc| doc.favourite)
            .unwrap_or(false);
        self.docs
            .insert(date.to_string(), SearchDoc::new(title, content, favourite));
    }

    /// Drop a deleted entry from the index.
    pub fn remove(&mut self, date: &str) {
        self.docs.remove(date);
    }

    /// Update the favourite flag without touching the decrypted text.
    pub fn set_favourite(&mut self, date: &str, favourite: bool) {
        if let Some(doc) = self.docs.get_mut(date) {
            doc.favourite = favourite;
        }
    }

    /// Find entries matching `query`, newest first like the sidebar.
    ///
    /// Every whitespace-separated term must match somewhere in the date, title
    /// or body; quoted groups are treated as one phrase. Matching is
    /// case-insensitive substring search, which needs no language-specific
    /// tokenizer and works for Chinese, Japanese and Korean text.
    pub fn query(&self, query: &str, limit: usize, favourites_only: bool) -> SearchResponse {
        let terms = parse_terms(query);
        if terms.is_empty() {
            return SearchResponse {
                ready: true,
                hits: Vec::new(),
                total: 0,
                truncated: false,
            };
        }

        let limit = limit.clamp(1, MAX_LIMIT);
        let mut matched: Vec<(&String, &SearchDoc, Match)> = Vec::new();
        for (date, doc) in &self.docs {
            if favourites_only && !doc.favourite {
                continue;
            }
            if let Some(found) = doc.matches(date, &terms) {
                matched.push((date, doc, found));
            }
        }

        let total = matched.len();
        // Results follow the sidebar's order: newest first.
        matched.sort_by(|a, b| b.0.cmp(a.0));

        let hits = matched
            .into_iter()
            .take(limit)
            .map(|(date, doc, found)| {
                let (snippet, matches) = doc.snippet(found.content_pos, &terms);
                SearchHit {
                    date: date.clone(),
                    title: doc.title.to_string(),
                    snippet,
                    matches,
                    favourite: doc.favourite,
                }
            })
            .collect();

        SearchResponse {
            ready: true,
            hits,
            total,
            truncated: total > limit,
        }
    }
}

/// Build a fresh index by decrypting every entry file.
///
/// Readable entries are collected; broken files are returned so the sidebar can
/// keep advertising them. The collector borrows the plaintext only briefly, and
/// [`SearchDoc`] copies it into zeroizing buffers.
pub fn build(dir: &Path, key: &[u8; 32]) -> Result<(SearchIndex, Vec<BrokenEntry>), String> {
    let mut index = SearchIndex::default();
    let broken = storage::scan_entry_contents(dir, key, |date, title, content, favourite| {
        index
            .docs
            .insert(date.to_string(), SearchDoc::new(title, content, favourite));
    })?;
    Ok((index, broken))
}

/// One search result sent to the frontend.
///
/// `snippet` is a short excerpt rather than the whole entry, which keeps the
/// plaintext crossing the IPC boundary small. `matches` are UTF-16 code-unit
/// ranges relative to `snippet`, ready for `String.prototype.slice` in JS.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub date: String,
    pub title: String,
    pub snippet: String,
    pub matches: Vec<(usize, usize)>,
    pub favourite: bool,
}

impl Drop for SearchHit {
    fn drop(&mut self) {
        self.title.zeroize();
        self.snippet.zeroize();
    }
}

/// Response for one search request.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResponse {
    /// False when the session index has not been built yet, so the frontend can
    /// fall back to its local date/title filter instead of showing "no results".
    pub ready: bool,
    pub hits: Vec<SearchHit>,
    pub total: usize,
    pub truncated: bool,
}

impl SearchResponse {
    pub fn not_ready() -> Self {
        Self {
            ready: false,
            hits: Vec::new(),
            total: 0,
            truncated: false,
        }
    }
}

struct Match {
    /// Byte offset of the first body match, if there is one.
    content_pos: Option<usize>,
}

impl SearchDoc {
    fn matches(&self, date: &str, terms: &[String]) -> Option<Match> {
        let mut content_pos: Option<usize> = None;

        for term in terms {
            let title_hit = self.title_lower.contains(term.as_str());
            let content_hit = self.content_lower.find(term.as_str());
            let date_hit = date.contains(term.as_str());

            if !title_hit && content_hit.is_none() && !date_hit {
                return None;
            }

            if let Some(pos) = content_hit {
                content_pos = Some(match content_pos {
                    Some(current) => current.min(pos),
                    None => pos,
                });
            }
        }

        Some(Match { content_pos })
    }

    /// Build a one-line excerpt around `pos` and mark every term inside it.
    fn snippet(&self, pos: Option<usize>, terms: &[String]) -> (String, Vec<(usize, usize)>) {
        if self.content.is_empty() {
            return (String::new(), Vec::new());
        }

        let lower = self.content_lower.as_str();
        let match_char = pos.map(|byte| lower[..byte].chars().count()).unwrap_or(0);
        let start = match_char.saturating_sub(SNIPPET_BEFORE);

        let mut chars = self.content.chars().skip(start);
        let window: String = chars
            .by_ref()
            .take(SNIPPET_BEFORE + SNIPPET_AFTER)
            .collect();
        let has_more = chars.next().is_some();

        let mut snippet = String::new();
        if start > 0 {
            snippet.push('…');
        }
        snippet.push_str(&window);
        if has_more {
            snippet.push('…');
        }

        let matches = highlight_ranges(&snippet, terms);
        (snippet, matches)
    }
}

/// Split a query into lowercase terms.
///
/// Double quotes group words into one phrase; an unmatched quote simply keeps
/// collecting until the end, which is friendlier while the user is still typing.
fn parse_terms(query: &str) -> Vec<String> {
    let mut terms = Vec::new();
    let mut current = String::new();
    let mut quoted = false;

    for ch in query.chars() {
        match ch {
            '"' => {
                if !current.is_empty() {
                    terms.push(std::mem::take(&mut current));
                }
                quoted = !quoted;
            }
            c if c.is_whitespace() && !quoted => {
                if !current.is_empty() {
                    terms.push(std::mem::take(&mut current));
                }
            }
            c => current.push(c),
        }
    }
    if !current.is_empty() {
        terms.push(current);
    }

    terms
        .into_iter()
        .map(|term| term.to_lowercase())
        .filter(|term| !term.is_empty())
        .collect()
}

/// Find every term inside `text` and return UTF-16 ranges for a JS `slice`.
///
/// The offsets are computed against the original text, not the lowercased copy,
/// so a snippet keeps its original capitalisation even though matching is
/// case-insensitive.
fn highlight_ranges(text: &str, terms: &[String]) -> Vec<(usize, usize)> {
    let lower = text.to_lowercase();
    let mut ranges: Vec<(usize, usize)> = Vec::new();

    for term in terms {
        let mut from = 0;
        while from < lower.len() {
            let Some(offset) = lower[from..].find(term.as_str()) else {
                break;
            };
            let start = from + offset;
            let end = start + term.len();

            let start_chars = lower[..start].chars().count();
            let end_chars = lower[..end].chars().count();
            if let (Some(start_byte), Some(end_byte)) = (
                char_to_byte(text, start_chars),
                char_to_byte(text, end_chars),
            ) {
                let start_utf16 = text[..start_byte].encode_utf16().count();
                let end_utf16 = text[..end_byte].encode_utf16().count();
                if end_utf16 > start_utf16 {
                    ranges.push((start_utf16, end_utf16));
                }
            }

            from = end;
        }
    }

    // Merge overlaps so the frontend can walk the ranges in one pass.
    ranges.sort_unstable();
    let mut merged: Vec<(usize, usize)> = Vec::new();
    for (start, end) in ranges {
        match merged.last_mut() {
            Some((_, last_end)) if start <= *last_end => {
                *last_end = (*last_end).max(end);
            }
            _ => merged.push((start, end)),
        }
    }
    merged
}

/// Byte offset of the `index`-th character, or `None` when it is out of range.
fn char_to_byte(text: &str, index: usize) -> Option<usize> {
    if index == 0 {
        return Some(0);
    }
    let mut count = 0;
    for (byte, _) in text.char_indices() {
        if count == index {
            return Some(byte);
        }
        count += 1;
    }
    if count == index {
        Some(text.len())
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crypto::KdfParams;
    use std::fs;
    use std::path::PathBuf;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("fly-diary-search-test-{name}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn fast() -> KdfParams {
        KdfParams {
            memory_kib: 8 * 1024,
            iterations: 1,
            parallelism: 1,
        }
    }

    fn vault(name: &str) -> (PathBuf, Zeroizing<[u8; 32]>) {
        let dir = temp_dir(name);
        let key = storage::create_vault(&dir, "pw", fast()).unwrap();
        (dir, key)
    }

    #[test]
    fn finds_body_text_case_insensitively() {
        let (dir, key) = vault("body");
        storage::write_entry(&dir, &key, "2026-10-23", "Trip", "Visited Kyoto today").unwrap();
        let (index, broken) = build(&dir, &key).unwrap();
        assert!(broken.is_empty());

        let response = index.query("kyoto", DEFAULT_LIMIT, false);
        assert!(response.ready);
        assert_eq!(response.total, 1);
        assert_eq!(response.hits[0].date, "2026-10-23");
        assert_eq!(response.hits[0].title, "Trip");
        assert!(response.hits[0].snippet.contains("Kyoto"));
    }

    #[test]
    fn supports_chinese_substrings_without_tokenization() {
        let (dir, key) = vault("cjk");
        storage::write_entry(&dir, &key, "2026-10-23", "散步", "今天去河邊散步，風很舒服").unwrap();
        let (index, _) = build(&dir, &key).unwrap();

        let response = index.query("河邊散步", DEFAULT_LIMIT, false);
        assert_eq!(response.total, 1);
        assert!(response.hits[0].snippet.contains("河邊散步"));
        assert!(!response.hits[0].matches.is_empty());
    }

    #[test]
    fn requires_every_term_and_supports_phrases() {
        let (dir, key) = vault("terms");
        storage::write_entry(&dir, &key, "2026-10-23", "A", "red green blue").unwrap();
        storage::write_entry(&dir, &key, "2026-10-22", "B", "red only").unwrap();
        let (index, _) = build(&dir, &key).unwrap();

        let both = index.query("red blue", DEFAULT_LIMIT, false);
        assert_eq!(both.total, 1);
        assert_eq!(both.hits[0].date, "2026-10-23");

        let phrase = index.query("\"green blue\"", DEFAULT_LIMIT, false);
        assert_eq!(phrase.total, 1);

        let missing = index.query("\"green red\"", DEFAULT_LIMIT, false);
        assert_eq!(missing.total, 0);
    }

    #[test]
    fn matches_dates_and_titles_and_sorts_newest_first() {
        let (dir, key) = vault("rank");
        // The older entry has the stronger (title) hit; date order still wins,
        // matching the sidebar rather than a relevance score.
        storage::write_entry(&dir, &key, "2026-10-23", "Other", "Kyoto again").unwrap();
        storage::write_entry(&dir, &key, "2026-10-22", "Kyoto", "a trip").unwrap();
        let (index, _) = build(&dir, &key).unwrap();

        let response = index.query("kyoto", DEFAULT_LIMIT, false);
        assert_eq!(response.total, 2);
        assert_eq!(response.hits[0].date, "2026-10-23");
        assert_eq!(response.hits[1].date, "2026-10-22");

        let by_date = index.query("2026-10-22", DEFAULT_LIMIT, false);
        assert_eq!(by_date.total, 1);
        assert_eq!(by_date.hits[0].date, "2026-10-22");
    }

    #[test]
    fn filters_favourites_and_reports_truncation() {
        let (dir, key) = vault("favourites");
        for day in 1..=5 {
            let date = format!("2026-10-0{day}");
            storage::write_entry(&dir, &key, &date, "t", "shared word").unwrap();
        }
        storage::set_favourite(&dir, &key, "2026-10-03", true).unwrap();
        let (index, _) = build(&dir, &key).unwrap();

        let favourites = index.query("shared", MAX_LIMIT, true);
        assert_eq!(favourites.total, 1);
        assert_eq!(favourites.hits[0].date, "2026-10-03");
        assert!(favourites.hits[0].favourite);

        let limited = index.query("shared", 2, false);
        assert_eq!(limited.total, 5);
        assert_eq!(limited.hits.len(), 2);
        assert!(limited.truncated);
    }

    #[test]
    fn updates_and_removals_are_visible_immediately() {
        let (dir, key) = vault("update");
        storage::write_entry(&dir, &key, "2026-10-23", "t", "old word").unwrap();
        let (mut index, _) = build(&dir, &key).unwrap();
        assert_eq!(index.query("old", DEFAULT_LIMIT, false).total, 1);

        index.upsert("2026-10-23", "t", "new word");
        assert_eq!(index.query("old", DEFAULT_LIMIT, false).total, 0);
        assert_eq!(index.query("new", DEFAULT_LIMIT, false).total, 1);

        index.remove("2026-10-23");
        assert_eq!(index.query("new", DEFAULT_LIMIT, false).total, 0);
    }

    #[test]
    fn snippet_ranges_are_valid_utf16_boundaries() {
        let (dir, key) = vault("snippet");
        let body = "前言 ".repeat(20) + "要找的字 😀 後語";
        storage::write_entry(&dir, &key, "2026-10-23", "標題", &body).unwrap();
        let (index, _) = build(&dir, &key).unwrap();

        let response = index.query("要找的字", DEFAULT_LIMIT, false);
        assert_eq!(response.total, 1);
        let hit = &response.hits[0];
        for (start, end) in &hit.matches {
            assert!(end > start);
            let units: Vec<u16> = hit.snippet.encode_utf16().collect();
            assert!(*end <= units.len());
            let slice = String::from_utf16(&units[*start..*end]).unwrap();
            assert_eq!(slice, "要找的字");
        }
    }

    #[test]
    fn an_empty_query_returns_nothing_but_stays_ready() {
        let (dir, key) = vault("empty");
        storage::write_entry(&dir, &key, "2026-10-23", "t", "c").unwrap();
        let (index, _) = build(&dir, &key).unwrap();

        let response = index.query("   ", DEFAULT_LIMIT, false);
        assert!(response.ready);
        assert_eq!(response.total, 0);
        assert!(response.hits.is_empty());
    }
}
