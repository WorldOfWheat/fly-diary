//! Reading an image from the OS clipboard.
//!
//! WebKitGTK does not reliably expose clipboard images through the HTML5
//! `paste` event, so the frontend falls back to this command when the event
//! carries no `File`. The image is re-encoded as PNG and returned as base64 so
//! it enters the same resize/encrypt pipeline as every other attachment.

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use serde::Serialize;
use std::path::Path;

/// Reject absurd clipboard bitmaps before allocating another full-size buffer.
/// 100 MP covers very large web/photo images while keeping the RGBA buffer
/// around 400 MB at most (desktop only).
const MAX_CLIPBOARD_PIXELS: u64 = 100_000_000;
/// Downscale very large clipboard images before PNG/base64 encoding. The
/// frontend still resizes to 1000 px for storage; this keeps the IPC payload and
/// PNG encoder work reasonable.
const MAX_CLIPBOARD_EDGE: u32 = 2048;

/// An image read from the clipboard, shaped like a dropped file.
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardImage {
    pub name: String,
    pub data: String,
}

fn is_image_path(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|extension| extension.to_str())
            .map(|extension| extension.to_ascii_lowercase())
            .as_deref(),
        Some("png" | "jpg" | "jpeg" | "webp" | "gif" | "bmp" | "tif" | "tiff" | "avif")
    )
}

/// Read copied image *files* from the clipboard.
///
/// Copying a file in a file manager puts a file list (Windows/macOS) or a
/// `text/uri-list` (Linux) on the clipboard, not a bitmap. Calling
/// `get_image()` on that clipboard can block while the OS tries to negotiate a
/// bitmap; checking the file list first is both faster and lets a copied image
/// file behave like a dropped one.
#[cfg(desktop)]
pub fn read_file_paths() -> Vec<String> {
    let mut clipboard = match arboard::Clipboard::new() {
        Ok(clipboard) => clipboard,
        Err(_) => return Vec::new(),
    };
    match clipboard.get().file_list() {
        Ok(paths) => paths
            .into_iter()
            .filter(|path| is_image_path(path))
            .take(20)
            .map(|path| path.to_string_lossy().into_owned())
            .collect(),
        Err(_) => Vec::new(),
    }
}

#[cfg(not(desktop))]
pub fn read_file_paths() -> Vec<String> {
    Vec::new()
}

/// Read the clipboard image, if there is one.
///
/// Returns `Ok(None)` when the clipboard is unavailable or holds no image
/// (which is the normal case for text paste). Only re-encoding failures are
/// reported as errors.
#[cfg(desktop)]
fn encode_clipboard_image(
    width: u32,
    height: u32,
    bytes: Vec<u8>,
) -> Result<ClipboardImage, String> {
    let pixels = u64::from(width) * u64::from(height);
    if pixels == 0 {
        return Err("Clipboard image has no pixels".to_string());
    }
    if pixels > MAX_CLIPBOARD_PIXELS {
        return Err(format!(
            "Clipboard image is too large ({pixels} pixels, maximum {MAX_CLIPBOARD_PIXELS})"
        ));
    }

    let buffer = image::RgbaImage::from_raw(width, height, bytes)
        .ok_or_else(|| "Clipboard image has invalid dimensions".to_string())?;
    let source = image::DynamicImage::ImageRgba8(buffer);
    // `thumbnail` uses a fast integer downsampler, which matters for a 50–100
    // MP bitmap. The frontend still does the final 1000 px resize.
    let image = if width > MAX_CLIPBOARD_EDGE || height > MAX_CLIPBOARD_EDGE {
        source.thumbnail(MAX_CLIPBOARD_EDGE, MAX_CLIPBOARD_EDGE)
    } else {
        source
    };

    let mut png = std::io::Cursor::new(Vec::new());
    image
        .write_to(&mut png, image::ImageFormat::Png)
        .map_err(|e| format!("Could not encode the clipboard image: {e}"))?;

    Ok(ClipboardImage {
        name: "clipboard.png".to_string(),
        data: B64.encode(png.into_inner()),
    })
}

#[cfg(desktop)]
pub fn read_image() -> Result<Option<ClipboardImage>, String> {
    let mut clipboard = match arboard::Clipboard::new() {
        Ok(clipboard) => clipboard,
        Err(err) => return Err(format!("Could not access the clipboard: {err}")),
    };
    let image = match clipboard.get_image() {
        Ok(image) => image,
        Err(arboard::Error::ContentNotAvailable) => return Ok(None),
        Err(err) => return Err(format!("Could not read the clipboard image: {err}")),
    };

    let width =
        u32::try_from(image.width).map_err(|_| "Clipboard image is too wide".to_string())?;
    let height =
        u32::try_from(image.height).map_err(|_| "Clipboard image is too tall".to_string())?;
    encode_clipboard_image(width, height, image.bytes.into_owned()).map(Some)
}

/// Mobile platforms have no desktop clipboard; paste is handled by the webview.
#[cfg(not(desktop))]
pub fn read_image() -> Result<Option<ClipboardImage>, String> {
    Ok(None)
}

#[cfg(all(test, desktop))]
mod tests {
    use super::*;

    #[test]
    fn only_image_paths_are_accepted() {
        assert!(is_image_path(Path::new("/tmp/photo.PNG")));
        assert!(is_image_path(Path::new("/tmp/photo.jpeg")));
        assert!(!is_image_path(Path::new("/tmp/notes.txt")));
        assert!(!is_image_path(Path::new("/tmp/README")));
    }

    #[test]
    fn small_bitmaps_become_png() {
        let image = encode_clipboard_image(2, 2, vec![255; 16]).unwrap();
        let png = B64.decode(image.data).unwrap();
        assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
        assert_eq!(image.name, "clipboard.png");
    }

    #[test]
    fn oversized_bitmaps_are_refused() {
        let err = encode_clipboard_image(20_000, 20_000, Vec::new()).unwrap_err();
        assert!(err.contains("too large"));
    }

    #[test]
    fn invalid_bitmap_sizes_are_refused() {
        assert!(encode_clipboard_image(0, 10, Vec::new()).is_err());
        assert!(encode_clipboard_image(2, 2, vec![0; 3]).is_err());
    }
}
