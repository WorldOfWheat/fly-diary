//! Decode, resize and re-encode image attachments entirely in Rust.
//!
//! The webview only decodes images for display. Attachment input bytes are sent
//! here so the stored format does not depend on which canvas encoders the
//! platform happens to ship (WebKitGTK and WKWebView cannot encode WebP, which
//! used to leave multi-megabyte PNGs on disk). Every image is written as lossy
//! WebP, so the same source produces roughly the same size on every platform.
//!
//! EXIF orientation is applied before resizing and the re-encode drops all other
//! metadata (including GPS), matching the previous canvas pipeline.

use std::io::Cursor;

use image::{DynamicImage, ImageDecoder, ImageReader, Limits};
use serde::Serialize;

use crate::{attachments, crypto};

/// Longest edge of the stored image, in pixels.
pub const MAX_LONG_EDGE: u32 = 1000;
/// Lossy WebP quality. The `webp` crate expects the same 0–100 scale as libwebp.
pub const WEBP_QUALITY: f32 = 80.0;
/// Largest input file accepted before decoding. Mirrors the frontend picker.
pub const MAX_INPUT_BYTES: usize = 64 * 1024 * 1024;
/// Reject absurd dimensions from a decompression bomb before allocating pixels.
const MAX_INPUT_EDGE: u32 = 32_768;

/// A compressed image ready to be encrypted and stored.
#[derive(Debug, Serialize)]
pub struct PreparedImage {
    pub mime: String,
    /// Base64-encoded WebP bytes.
    pub data: String,
    pub width: u32,
    pub height: u32,
}

/// Scale `width`/`height` so the longest edge is at most `MAX_LONG_EDGE`.
pub fn target_dimensions(width: u32, height: u32) -> (u32, u32) {
    if width == 0 || height == 0 {
        return (0, 0);
    }
    let longest = width.max(height);
    if longest <= MAX_LONG_EDGE {
        return (width, height);
    }
    let scale = f64::from(MAX_LONG_EDGE) / f64::from(longest);
    let scaled_width = (f64::from(width) * scale).round().max(1.0) as u32;
    let scaled_height = (f64::from(height) * scale).round().max(1.0) as u32;
    (scaled_width, scaled_height)
}

/// Decode `bytes`, apply EXIF orientation, resize, and encode lossy WebP.
pub fn prepare_image(bytes: &[u8]) -> Result<PreparedImage, String> {
    if bytes.is_empty() {
        return Err("Image is empty".to_string());
    }
    if bytes.len() > MAX_INPUT_BYTES {
        return Err(format!(
            "Image is too large (limit {} MiB)",
            MAX_INPUT_BYTES / (1024 * 1024)
        ));
    }

    let mut reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|e| format!("Could not read image: {e}"))?;
    let mut limits = Limits::default();
    limits.max_image_width = Some(MAX_INPUT_EDGE);
    limits.max_image_height = Some(MAX_INPUT_EDGE);
    reader.limits(limits);

    let mut decoder = reader
        .into_decoder()
        .map_err(|e| format!("Could not decode image: {e}"))?;
    let orientation = decoder
        .orientation()
        .map_err(|e| format!("Could not read image orientation: {e}"))?;
    let mut image =
        DynamicImage::from_decoder(decoder).map_err(|e| format!("Could not decode image: {e}"))?;
    image.apply_orientation(orientation);

    let (width, height) = target_dimensions(image.width(), image.height());
    if width == 0 || height == 0 {
        return Err("Image has no usable dimensions".to_string());
    }
    if width != image.width() || height != image.height() {
        image = image.resize_exact(width, height, image::imageops::FilterType::Lanczos3);
    }

    // RGBA keeps transparent PNG/WebP sources intact; lossy WebP supports alpha.
    let rgba = image.to_rgba8();
    let encoded = webp::Encoder::from_rgba(rgba.as_raw(), width, height)
        .encode_simple(false, WEBP_QUALITY)
        .map_err(|e| format!("Could not encode WebP: {e:?}"))?;
    let data = encoded.to_vec();
    if data.len() > attachments::MAX_ATTACHMENT_BYTES {
        return Err(format!(
            "Compressed image is too large (limit {} MiB)",
            attachments::MAX_ATTACHMENT_BYTES / (1024 * 1024)
        ));
    }

    Ok(PreparedImage {
        mime: "image/webp".to_string(),
        data: crypto::b64_encode(&data),
        width,
        height,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{ImageBuffer, ImageFormat, Rgba};
    use std::io::Cursor;

    fn png_bytes(width: u32, height: u32) -> Vec<u8> {
        let image = ImageBuffer::from_fn(width, height, |x, y| {
            let r = (x * 255 / width.max(1)) as u8;
            let g = (y * 255 / height.max(1)) as u8;
            Rgba([r, g, 128, 255])
        });
        let mut out = Cursor::new(Vec::new());
        image.write_to(&mut out, ImageFormat::Png).unwrap();
        out.into_inner()
    }

    #[test]
    fn target_dimensions_keeps_the_aspect_ratio_and_never_upscales() {
        assert_eq!(target_dimensions(2000, 1000), (1000, 500));
        assert_eq!(target_dimensions(1000, 2000), (500, 1000));
        assert_eq!(target_dimensions(800, 600), (800, 600));
        assert_eq!(target_dimensions(0, 600), (0, 0));
    }

    #[test]
    fn prepare_image_resizes_and_encodes_lossy_webp() {
        let input = png_bytes(2000, 1000);
        let prepared = prepare_image(&input).unwrap();

        assert_eq!(prepared.mime, "image/webp");
        assert_eq!((prepared.width, prepared.height), (1000, 500));

        let bytes = crypto::b64_decode(&prepared.data).unwrap();
        assert_eq!(&bytes[..4], b"RIFF");
        assert_eq!(&bytes[8..12], b"WEBP");
        assert!(bytes.len() < attachments::MAX_ATTACHMENT_BYTES);

        let decoded = image::load_from_memory(&bytes).unwrap();
        assert_eq!((decoded.width(), decoded.height()), (1000, 500));
    }

    #[test]
    fn prepare_image_never_upscales_small_inputs() {
        let input = png_bytes(320, 200);
        let prepared = prepare_image(&input).unwrap();
        assert_eq!((prepared.width, prepared.height), (320, 200));
    }

    #[test]
    fn prepare_image_rejects_empty_and_undecodable_input() {
        assert!(prepare_image(&[]).is_err());
        assert!(prepare_image(b"not an image").is_err());
    }
}
