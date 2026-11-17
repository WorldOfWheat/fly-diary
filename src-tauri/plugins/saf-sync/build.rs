//! No JavaScript-facing commands: the Rust side of the app calls these
//! methods directly, so no capability permission can expose the SAF folder to
//! the webview.

const COMMANDS: &[&str] = &[];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .build();
}
