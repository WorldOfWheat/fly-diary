use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Runtime,
};

mod error;
mod models;

#[cfg(target_os = "android")]
mod mobile;

#[cfg(not(target_os = "android"))]
mod desktop;

pub use error::{Error, Result};
pub use models::*;

#[cfg(target_os = "android")]
pub use mobile::SafSync;

#[cfg(not(target_os = "android"))]
pub use desktop::SafSync;

/// Access the plugin handle from an app or window handle.
pub trait SafSyncExt<R: Runtime> {
    fn saf_sync(&self) -> &SafSync<R>;
}

impl<R: Runtime, T: Manager<R>> SafSyncExt<R> for T {
    fn saf_sync(&self) -> &SafSync<R> {
        self.state::<SafSync<R>>().inner()
    }
}

/// Initializes the plugin and stores the handle in Tauri's state.
///
/// There is no `invoke_handler`: the commands are called from Rust, never from
/// JavaScript, so the webview cannot reach the folder even if a script is
/// injected into it.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("saf-sync")
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            let handle = mobile::init(app, api)?;
            #[cfg(not(target_os = "android"))]
            let handle = desktop::init(app, api)?;
            app.manage(handle);
            Ok(())
        })
        .build()
}
