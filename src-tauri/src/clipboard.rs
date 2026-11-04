//! Reading an image from the OS clipboard.
//!
//! WebKitGTK does not reliably expose clipboard images through the HTML5
//! `paste` event, so the frontend falls back to this command when the event
//! carries no `File`. The image is re-encoded as PNG and returned as base64 so
//! it enters the same resize/encrypt pipeline as every other attachment.

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use serde::Serialize;

/// An image read from the clipboard, shaped like a dropped file.
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardImage {
    pub name: String,
    pub data: String,
}

/// Read the clipboard image, if there is one.
///
/// Returns `Ok(None)` when the clipboard is unavailable or holds no image
/// (which is the normal case for text paste). Only re-encoding failures are
/// reported as errors.
#[cfg(desktop)]
pub fn read_image() -> Result<Option<ClipboardImage>, String> {
    let mut clipboard = match arboard::Clipboard::new() {
        Ok(clipboard) => clipboard,
        Err(_) => return Ok(None),
    };
    let image = match clipboard.get_image() {
        Ok(image) => image,
        Err(_) => return Ok(None),
    };

    let width = u32::try_from(image.width)
        .map_err(|_| "Clipboard image is too wide".to_string())?;
    let height = u32::try_from(image.height)
        .map_err(|_| "Clipboard image is too tall".to_string())?;
    let buffer = image::RgbaImage::from_raw(width, height, image.bytes.into_owned())
        .ok_or_else(|| "Clipboard image has an invalid size".to_string())?;

    let mut png = std::io::Cursor::new(Vec::new());
    image::DynamicImage::ImageRgba8(buffer)
        .write_to(&mut png, image::ImageFormat::Png)
        .map_err(|e| format!("Could not encode the clipboard image: {e}"))?;

    Ok(Some(ClipboardImage {
        name: "clipboard.png".to_string(),
        data: B64.encode(png.into_inner()),
    }))
}

/// Mobile platforms have no desktop clipboard; paste is handled by the webview.
#[cfg(not(desktop))]
pub fn read_image() -> Result<Option<ClipboardImage>, String> {
    Ok(None)
}
