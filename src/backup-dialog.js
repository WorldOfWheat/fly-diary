import { createFocusTrap } from "./focus-trap.js";
import { animateOverlayExit } from "./lib/motion.js";

// ---------------------------------------------------------------------------
// Encrypted tar import
// ---------------------------------------------------------------------------
//
// Restoring a backup in the settings dialog repairs the current vault: the
// session already holds the right key and `vault.xml` is left alone. Importing
// is different. It adopts the archive's `vault.xml`/`recovery.xml`, so it can
// seed a new device, replace a vault after app data was wiped, or move the diary
// to another folder. That requires the archive's own passphrase before anything
// on disk is touched, which is why this lives in a separate dialog instead of
// inside the backup section.
//
// `deps` shape:
//
//   els          — the lookup table from `dom.js`
//   invoke       — (command: string, args?: object) => Promise<any>
//   t            — (key: string, params?: object) => string
//   onImported   — (report) => void | Promise<void>
//   onClosed     — () => void | Promise<void>  (user cancelled; not on success)
//   beginNativePicker / endNativePicker — optional native picker guard

/** Create the tar-import dialog controller. */
export function createBackupImportDialog(deps) {
  const { els } = deps;
  const focusTrap = createFocusTrap(els.backupImportOverlay);
  const confirm = deps.confirm || ((message) => globalThis.confirm?.(message));

  let opened = false;
  let busy = false;
  let targetDir = null;

  function isOpen() {
    return opened;
  }

  function setBusy(value) {
    busy = value;
    if (els.backupImportConfirm) els.backupImportConfirm.disabled = value;
    if (els.backupImportCancel) els.backupImportCancel.disabled = value;
    if (els.backupImportClose) els.backupImportClose.disabled = value;
    els.backupImportOverlay?.setAttribute?.(
      "aria-busy",
      value ? "true" : "false"
    );
  }

  function clearMessages() {
    if (els.backupImportError) els.backupImportError.textContent = "";
    if (els.backupImportStatus) {
      els.backupImportStatus.textContent = "";
      els.backupImportStatus.classList.remove("is-saved");
    }
  }

  function showError(message) {
    if (els.backupImportError) els.backupImportError.textContent = message;
  }

  function showStatus(message, saved = false) {
    if (!els.backupImportStatus) return;
    els.backupImportStatus.textContent = message;
    els.backupImportStatus.classList.toggle("is-saved", saved);
  }

  /** Open the dialog. `targetDir` is only set when the lock screen is showing. */
  function open({ targetDir: dir = null } = {}) {
    targetDir = dir;
    opened = true;
    busy = false;
    clearMessages();
    if (els.backupImportPass) els.backupImportPass.value = "";
    setBusy(false);
    if (els.backupImportOverlay) els.backupImportOverlay.hidden = false;
    focusTrap.activate();
    els.backupImportPass?.focus?.();
  }

  /**
   * Close the dialog.
   *
   * `imported` suppresses `onClosed`: after a successful import the caller has
   * its own hand-off, and reopening the settings dialog underneath the new vault
   * would show stale data.
   */
  function close({ imported = false } = {}) {
    if (busy && !imported) return;
    opened = false;
    animateOverlayExit(els.backupImportOverlay, { redactInputs: true });
    if (els.backupImportOverlay) els.backupImportOverlay.hidden = true;
    focusTrap.deactivate();
    if (els.backupImportPass) els.backupImportPass.value = "";
    clearMessages();
    if (!imported) deps.onClosed?.();
  }

  /** Pick a tar and import it, after asking for confirmation if needed. */
  async function submit() {
    if (busy) return;
    clearMessages();

    const passphrase = els.backupImportPass?.value ?? "";
    if (!passphrase) {
      showError(deps.t("backup.importPassRequired"));
      els.backupImportPass?.focus?.();
      return;
    }

    let overwrite = false;
    try {
      const exists = await deps.invoke(
        "vault_exists",
        targetDir ? { path: targetDir } : {}
      );
      if (exists) {
        if (!confirm(deps.t("backup.importReplaceConfirm"))) return;
        overwrite = true;
      }
    } catch (err) {
      // A missing settings file (first run) simply means there is no vault to
      // replace. The backend still enforces `overwrite` before installing.
      console.error("vault_exists failed:", err);
    }

    setBusy(true);
    showStatus(deps.t("backup.importWorking"));
    try {
      deps.beginNativePicker?.();
      let report;
      try {
        report = await deps.invoke("import_backup", {
          passphrase,
          targetDir: targetDir || null,
          overwrite,
        });
      } finally {
        deps.endNativePicker?.();
      }

      if (!report) {
        // The user cancelled the file picker.
        showStatus("");
        return;
      }

      close({ imported: true });
      try {
        await deps.onImported?.(report);
      } catch (afterError) {
        // The vault is already installed. A failure to reload the UI must not
        // make the import look like it failed.
        console.error("after import failed:", afterError);
      }
    } catch (err) {
      console.error("import_backup failed:", err);
      showStatus("");
      showError(
        deps.t("backup.importFailed", {
          message: typeof err === "string" ? err : String(err),
        })
      );
    } finally {
      setBusy(false);
    }
  }

  return {
    isOpen,
    open,
    close,
    submit,
  };
}
