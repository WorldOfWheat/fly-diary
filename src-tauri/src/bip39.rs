//! BIP39 mnemonic encoding for the optional recovery key.
//!
//! The recovery phrase is a 128-bit random value encoded as 12 words from the
//! official English BIP39 wordlist (`bip-0039/english.txt` from `bitcoin/bips`).
//! It is **not** a wallet seed: the app only uses the encoded entropy as the
//! input to a domain-separated SHA-256, which produces the AES-256 key that
//! wraps the diary key.
//!
//! 128 bits is deliberate. The phrase is meant to be written down by hand, and
//! twelve words is the longest list a person can transcribe without losing
//! patience. 128 bits is still far beyond offline brute force, and the BIP39
//! checksum catches most transcription mistakes before they become a support
//! problem.

use std::sync::OnceLock;

use rand::RngCore;
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

/// Entropy size in bytes (128 bits → 12 words).
pub const ENTROPY_BYTES: usize = 16;

/// Number of words in a generated phrase.
pub const WORD_COUNT: usize = 12;

/// Number of words the user must re-enter to prove they wrote the phrase down.
pub const CONFIRMATION_WORDS: usize = 3;

/// Bits contributed by each word.
const BITS_PER_WORD: usize = 11;

/// Checksum bits for 128-bit entropy: 128 / 32 = 4.
const CHECKSUM_BITS: usize = 4;

/// Total number of bits encoded by the phrase.
const TOTAL_BITS: usize = ENTROPY_BYTES * 8 + CHECKSUM_BITS;

/// Official BIP39 English wordlist, embedded at compile time.
const WORDLIST: &str = include_str!("bip39_english.txt");

/// Cached wordlist split into lines.
fn wordlist() -> &'static [&'static str] {
    static WORDS: OnceLock<Vec<&'static str>> = OnceLock::new();
    WORDS.get_or_init(|| WORDLIST.lines().collect())
}

/// The official BIP39 English wordlist, in alphabetical order.
pub fn words() -> &'static [&'static str] {
    wordlist()
}

/// Generate a fresh 128-bit value from the operating system RNG.
pub fn generate_entropy() -> Zeroizing<[u8; ENTROPY_BYTES]> {
    let mut entropy = Zeroizing::new([0u8; ENTROPY_BYTES]);
    rand::rngs::OsRng.fill_bytes(entropy.as_mut());
    entropy
}

/// Encode entropy as twelve BIP39 words.
pub fn entropy_to_words(entropy: &[u8; ENTROPY_BYTES]) -> Result<Vec<String>, String> {
    let words = wordlist();
    if words.len() != 2048 {
        return Err(format!(
            "BIP39 wordlist has {} words, expected 2048",
            words.len()
        ));
    }

    let checksum = Sha256::digest(entropy);
    let mut bits = Vec::with_capacity(TOTAL_BITS);
    for byte in entropy {
        for shift in (0..8).rev() {
            bits.push((*byte >> shift) & 1);
        }
    }
    for shift in (8 - CHECKSUM_BITS..8).rev() {
        bits.push((checksum[0] >> shift) & 1);
    }

    let mut result = Vec::with_capacity(WORD_COUNT);
    for chunk in bits.chunks(BITS_PER_WORD) {
        let mut index = 0usize;
        for bit in chunk {
            index = (index << 1) | usize::from(*bit);
        }
        result.push(words[index].to_string());
    }
    Ok(result)
}

/// Normalise a phrase into lowercase words.
///
/// The returned vector is checked for the exact word count, but the words are
/// not validated against the wordlist yet; [`words_to_entropy`] does that.
pub fn normalize_phrase(phrase: &str) -> Result<Vec<String>, String> {
    let words: Vec<String> = phrase
        .split_whitespace()
        .map(|word| word.to_lowercase())
        .collect();
    if words.len() != WORD_COUNT {
        return Err(format!(
            "Recovery phrase must contain {WORD_COUNT} words, got {}",
            words.len()
        ));
    }
    Ok(words)
}

/// Decode a normalised phrase back into entropy, verifying the BIP39 checksum.
pub fn words_to_entropy(words: &[String]) -> Result<Zeroizing<[u8; ENTROPY_BYTES]>, String> {
    if words.len() != WORD_COUNT {
        return Err(format!(
            "Recovery phrase must contain {WORD_COUNT} words, got {}",
            words.len()
        ));
    }

    let mut bits = Vec::with_capacity(TOTAL_BITS);
    for word in words {
        let index = wordlist()
            .iter()
            .position(|candidate| *candidate == word)
            .ok_or_else(|| format!("Unknown BIP39 word: {word}"))?;
        for shift in (0..BITS_PER_WORD).rev() {
            bits.push(((index >> shift) & 1) as u8);
        }
    }

    let mut entropy = Zeroizing::new([0u8; ENTROPY_BYTES]);
    for (position, bit) in bits.iter().take(ENTROPY_BYTES * 8).enumerate() {
        if *bit == 1 {
            entropy[position / 8] |= 1 << (7 - (position % 8));
        }
    }

    let expected_checksum =
        (Sha256::digest(&entropy[..])[0] >> (8 - CHECKSUM_BITS)) & ((1 << CHECKSUM_BITS) - 1);
    let mut actual_checksum = 0u8;
    for (offset, bit) in bits.iter().skip(ENTROPY_BYTES * 8).enumerate() {
        actual_checksum |= *bit << (CHECKSUM_BITS - 1 - offset);
    }

    if actual_checksum != expected_checksum {
        return Err("Recovery phrase checksum is invalid".to_string());
    }

    Ok(entropy)
}

/// Parse and validate a phrase in one step.
pub fn parse_phrase(phrase: &str) -> Result<Zeroizing<[u8; ENTROPY_BYTES]>, String> {
    let words = normalize_phrase(phrase)?;
    words_to_entropy(&words)
}

/// Pick three distinct word positions for the written-down confirmation step.
///
/// The indices are sorted so the UI can present them in phrase order.
pub fn confirmation_indices() -> Vec<usize> {
    use rand::seq::SliceRandom;

    let mut indices: Vec<usize> = (0..WORD_COUNT).collect();
    indices.shuffle(&mut rand::rngs::OsRng);
    indices.truncate(CONFIRMATION_WORDS);
    indices.sort_unstable();
    indices
}

/// Check the words the user typed for the requested positions.
///
/// The error never contains the expected word: a mistyped confirmation should
/// not turn the dialog into an oracle for the rest of the phrase.
pub fn verify_answers(
    words: &[String],
    indices: &[usize],
    answers: &[String],
) -> Result<(), String> {
    if indices.len() != CONFIRMATION_WORDS || answers.len() != indices.len() {
        return Err("Please fill in all requested words".to_string());
    }
    let mut seen = [false; WORD_COUNT];
    for (position, index) in indices.iter().enumerate() {
        if *index >= WORD_COUNT || seen[*index] {
            return Err("Invalid confirmation positions".to_string());
        }
        seen[*index] = true;

        let answer = answers[position].trim().to_lowercase();
        if answer.is_empty() {
            return Err("Please fill in all requested words".to_string());
        }
        if answer != words[*index] {
            return Err(format!(
                "Word {} does not match the recovery phrase",
                index + 1
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The canonical BIP39 vector for all-zero 128-bit entropy.
    const ZERO_PHRASE: &str = "abandon abandon abandon abandon abandon abandon \
                               abandon abandon abandon abandon abandon about";

    #[test]
    fn wordlist_has_the_official_boundaries() {
        assert_eq!(wordlist().len(), 2048);
        assert_eq!(wordlist()[0], "abandon");
        assert_eq!(wordlist()[2047], "zoo");
    }

    #[test]
    fn zero_entropy_matches_the_bip39_test_vector() {
        let words = entropy_to_words(&[0u8; ENTROPY_BYTES]).unwrap();
        assert_eq!(words.join(" "), ZERO_PHRASE);

        let parsed = parse_phrase(ZERO_PHRASE).unwrap();
        assert_eq!(*parsed, [0u8; ENTROPY_BYTES]);
    }

    #[test]
    fn random_entropy_roundtrips() {
        for _ in 0..64 {
            let entropy = generate_entropy();
            let words = entropy_to_words(&entropy).unwrap();
            assert_eq!(words.len(), WORD_COUNT);
            let parsed = parse_phrase(&words.join(" ")).unwrap();
            assert_eq!(*parsed, *entropy);
        }
    }

    #[test]
    fn uppercase_and_extra_whitespace_are_accepted() {
        let upper = ZERO_PHRASE.to_uppercase().replace(' ', "   ");
        assert_eq!(*parse_phrase(&upper).unwrap(), [0u8; ENTROPY_BYTES]);
    }

    #[test]
    fn checksum_is_enforced() {
        let words = ZERO_PHRASE.replace("about", "abandon");
        assert!(parse_phrase(&words).is_err());
    }

    #[test]
    fn unknown_words_are_rejected() {
        let words = ZERO_PHRASE.replace("about", "notaword");
        let err = parse_phrase(&words).unwrap_err();
        assert!(err.contains("Unknown BIP39 word"), "got: {err}");
    }

    #[test]
    fn wrong_word_count_is_rejected() {
        assert!(parse_phrase("abandon abandon").is_err());
        assert!(normalize_phrase("").is_err());
    }

    #[test]
    fn confirmation_indices_are_three_distinct_positions() {
        for _ in 0..64 {
            let indices = confirmation_indices();
            assert_eq!(indices.len(), CONFIRMATION_WORDS);
            assert!(indices.iter().all(|index| *index < WORD_COUNT));
            assert_eq!(
                indices
                    .iter()
                    .collect::<std::collections::BTreeSet<_>>()
                    .len(),
                CONFIRMATION_WORDS
            );
            assert!(indices.windows(2).all(|pair| pair[0] < pair[1]));
        }
    }

    #[test]
    fn confirmation_accepts_the_right_words_case_insensitively() {
        let words = entropy_to_words(&[7u8; ENTROPY_BYTES]).unwrap();
        let indices = vec![0, 5, 11];
        let answers: Vec<String> = indices
            .iter()
            .map(|index| words[*index].to_uppercase())
            .collect();
        assert!(verify_answers(&words, &indices, &answers).is_ok());
    }

    #[test]
    fn confirmation_rejects_a_wrong_word_without_leaking_it() {
        let words = entropy_to_words(&[7u8; ENTROPY_BYTES]).unwrap();
        let indices = vec![0, 5, 11];
        let answers = vec!["wrong".to_string(), words[5].clone(), words[11].clone()];
        let err = verify_answers(&words, &indices, &answers).unwrap_err();
        assert!(!err.contains(&words[0]), "error leaked the expected word");
        assert!(err.contains("does not match"), "got: {err}");
    }

    #[test]
    fn confirmation_rejects_duplicate_or_out_of_range_positions() {
        let words = entropy_to_words(&[9u8; ENTROPY_BYTES]).unwrap();
        assert!(verify_answers(&words, &[0, 0, 1], &words[..3]).is_err());
        assert!(verify_answers(&words, &[0, 1, 12], &words[..3]).is_err());
    }

    #[test]
    fn confirmation_requires_every_answer() {
        let words = entropy_to_words(&[3u8; ENTROPY_BYTES]).unwrap();
        let indices = vec![0, 1, 2];
        let answers = vec!["".to_string(), words[1].clone(), words[2].clone()];
        assert!(verify_answers(&words, &indices, &answers).is_err());
    }
}
