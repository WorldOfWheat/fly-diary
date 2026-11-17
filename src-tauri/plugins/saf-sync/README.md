# tauri-plugin-saf-sync

Android-only Tauri plugin behind Fly Diary's folder-sync bridge.

The Kotlin side uses the Storage Access Framework:

- `ACTION_OPEN_DOCUMENT_TREE` + `takePersistableUriPermission` to choose a folder;
- `DocumentFile` to list the tree and create folders;
- `ContentResolver` streams to copy a document into an app-private file (atomically,
  via a sibling temporary file + rename) and to upload a local file (temporary
  document + `DocumentsContract.renameDocument`, with a direct-write fallback for
  providers that cannot rename).

There are intentionally **no** JavaScript-facing commands. The Rust app calls
`SafSyncExt::saf_sync()` from its own commands, so a compromised webview cannot
reach the folder.

The plugin is linked only under `cfg(target_os = "android")`; the desktop build
never compiles it. See `src/sync.rs` in the app for the three-way sync rules and
`docs/security.md` for the threat model.
