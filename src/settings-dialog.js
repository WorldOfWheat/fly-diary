import { createFocusTrap } from "./focus-trap.js";
import { animateOverlayExit } from "./lib/motion.js";

// ---------------------------------------------------------------------------
// Settings dialog
// ---------------------------------------------------------------------------
//
// The dialog does three independent jobs: it changes the idle auto-lock
// duration, it changes the autosave debounce delay, and it changes the
// passphrase (optionally with new Argon2id parameters). They are deliberately
// decoupled — the two timing values are always written, the passphrase only
// when the user typed something — so the dialog is usable for any one of them
// alone.
//
// It also hosts the vault-wide actions that used to be footer buttons: the
// storage location, import and statistics. Those are not settings, so they do
// not take part in `saveSettings`; they hand over to the controller that owns
// them. Statistics is a detour rather than a hand-off, so the dialog is hidden
// and brought back when the statistics close.
//
// `deps` shape:
//
//   els                — the lookup table from `dom.js`
//   invoke             — (command: string, args?: object) => Promise<any>
//   t                  — (key: string, params?: object) => string
//   setStatus          — (text: string, saved?: boolean) => void
//   setAutoLockMinutes — (minutes: number) => void
//   setAutosaveDelay   — (ms: number) => void
//   openImport         — () => void | Promise<void>
//   openStats          — () => void
//   changeDiaryDir     — () => void | Promise<void>
//   openRecovery       — () => void | Promise<void>
//   openImportBackup   — () => void | Promise<void>
//   listen             — (event: string, handler: Function) => Promise<Function>
//   flushSave          — () => Promise<void>
//   afterRestore       — () => Promise<void>
//   afterRecompress    — (report: object) => Promise<void>
//   beginNativePicker / endNativePicker — optional picker guard

/** Fallback choices if the backend does not report any. */
const DEFAULT_AUTO_LOCK_CHOICES = [0, 1, 5, 10, 15, 30, 60];

/** Fallback autosave delays, mirroring `settings::AUTOSAVE_DELAY_CHOICES`. */
const DEFAULT_AUTOSAVE_DELAY_CHOICES = [200, 400, 800, 1500, 3000];

/** Human-readable byte count for the recompression report. */
function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Create the settings dialog controller.
 *
 * Returns the functions `main.js` and `wiring.js` need.
 */
export function createSettingsDialog(deps) {
  const { els } = deps;
  const focusTrap = createFocusTrap(els.settingsOverlay);

  /**
   * The Argon2id parameters currently recorded in the vault, as last read from
   * the backend. Used to tell whether the advanced inputs were actually edited,
   * so a parameter-only change is not silently dropped just because the
   * passphrase fields are empty.
   */
  let vaultKdf = null;

  /** Whether closing the statistics should bring this dialog back. */
  let returnToSettings = false;

  /** Whether the settings dialog is open. */
  function isSettingsOpen() {
    return !els.settingsOverlay.hidden;
  }

  /** Every collapsible settings block, in document order. */
  function settingsSections() {
    return Array.from(
      els.settingsOverlay?.querySelectorAll?.("details.settings-section") ?? []
    );
  }

  /** Open or close every settings block at once. */
  function setSectionsOpen(open) {
    for (const section of settingsSections()) section.open = open;
  }

  /** Fill the auto-lock dropdown from the choices the backend allows. */
  function renderAutoLockChoices(choices, current) {
    els.autoLockSelect.replaceChildren();
    for (const minutes of choices) {
      const option = document.createElement("option");
      option.value = String(minutes);
      option.textContent =
        minutes === 0
          ? deps.t("settings.autoLockNever")
          : deps.t("settings.autoLockMinutes", { n: minutes });
      if (minutes === current) option.selected = true;
      els.autoLockSelect.append(option);
    }
  }

  /** Fill the autosave dropdown from the choices the backend allows. */
  function renderAutosaveChoices(choices, current) {
    els.autosaveDelaySelect.replaceChildren();
    for (const ms of choices) {
      const option = document.createElement("option");
      option.value = String(ms);
      option.textContent = deps.t("settings.autosaveMs", { n: ms });
      if (ms === current) option.selected = true;
      els.autosaveDelaySelect.append(option);
    }
  }

  /** Show the Argon2id parameters currently recorded in the vault. */
  function renderVaultKdf(params) {
    // Remember what the vault holds so `saveSettings` can detect edits.
    vaultKdf = params ?? null;

    if (!params) {
      els.vaultKdf.textContent = deps.t("settings.vaultKdfLegacy");
      return;
    }
    els.vaultKdf.textContent = deps.t("settings.vaultKdf", {
      memory: Math.round(params.memoryKib / 1024),
      iterations: params.iterations,
      parallelism: params.parallelism,
    });
  }

  /** Copy the vault's current parameters into the advanced inputs. */
  function fillSettingsKdf(params) {
    if (!params) return;
    els.settingsKdfMemory.value = Math.round(params.memoryKib / 1024);
    els.settingsKdfIterations.value = params.iterations;
    els.settingsKdfParallelism.value = params.parallelism;
  }

  /** Read the advanced inputs as a KdfView payload. */
  function readSettingsKdf() {
    return {
      memoryKib: Number(els.settingsKdfMemory.value) * 1024,
      iterations: Number(els.settingsKdfIterations.value),
      parallelism: Number(els.settingsKdfParallelism.value),
    };
  }

  /**
   * Whether the advanced inputs differ from the parameters in the vault.
   *
   * Returns `false` when there is nothing to compare against: either the vault
   * is legacy (`vaultKdf === null`) or the fields are blank/non-numeric because
   * the dialog was never populated. In both cases the inputs carry no intent,
   * so a timing-only save must not be turned into a passphrase prompt. When a
   * passphrase change *is* requested, `saveSettings` still rejects NaN values
   * before invoking the backend.
   */
  function kdfChanged(kdf) {
    if (!vaultKdf) return false;
    if (
      !Number.isFinite(kdf.memoryKib) ||
      !Number.isFinite(kdf.iterations) ||
      !Number.isFinite(kdf.parallelism)
    ) {
      return false;
    }
    return (
      kdf.memoryKib !== vaultKdf.memoryKib ||
      kdf.iterations !== vaultKdf.iterations ||
      kdf.parallelism !== vaultKdf.parallelism
    );
  }

  /** Show whether a recovery phrase is configured and adjust the buttons. */
  async function refreshRecoveryStatus() {
    try {
      const status = await deps.invoke("get_recovery_status");
      if (status.enabled) {
        els.recoveryStatus.textContent = deps.t("recovery.statusEnabled");
        els.recoveryGenerateBtn.textContent = deps.t("recovery.regenerate");
        els.recoveryRemoveBtn.hidden = false;
      } else {
        els.recoveryStatus.textContent = deps.t("recovery.statusDisabled");
        els.recoveryGenerateBtn.textContent = deps.t("recovery.generate");
        els.recoveryRemoveBtn.hidden = true;
      }
    } catch (err) {
      console.error("get_recovery_status failed:", err);
      els.recoveryStatus.textContent = "";
      els.recoveryGenerateBtn.textContent = deps.t("recovery.generate");
      els.recoveryRemoveBtn.hidden = true;
    }
  }

  /** Remove the recovery phrase after a confirmation prompt. */
  async function removeRecovery() {
    if (!confirm(deps.t("recovery.removeConfirm"))) return;
    els.settingsError.textContent = "";
    try {
      await deps.invoke("remove_recovery");
      await refreshRecoveryStatus();
      deps.setStatus(deps.t("recovery.removed"), true);
    } catch (err) {
      console.error("remove_recovery failed:", err);
      els.settingsError.textContent = deps.t("recovery.errRemove", {
        message: typeof err === "string" ? err : String(err),
      });
    }
  }

  /** Open the recovery dialog from the settings section. */
  function openRecovery() {
    return deps.openRecovery?.();
  }

  /** Show the build metadata embedded by the Rust backend. */
  async function renderAppInfo() {
    try {
      const info = await deps.invoke("app_info");
      if (els.settingsAppVersion) els.settingsAppVersion.textContent = info.version;
      if (els.settingsAppCommit) els.settingsAppCommit.textContent = info.commit;
      if (els.settingsAppAuthor) els.settingsAppAuthor.textContent = info.author;
    } catch (err) {
      console.error("app_info failed:", err);
    }
  }

  /** Write a one-line result under a vault action. */
  function showSectionStatus(el, text, saved = false) {
    if (!el) return;
    el.textContent = text;
    el.classList.toggle("is-saved", saved);
  }

  /** Clear both vault-action status lines. */
  function clearVaultStatus() {
    showSectionStatus(els.settingsBackupStatus, "");
    showSectionStatus(els.settingsTransferStatus, "");
  }

  /**
   * Export the whole vault as one encrypted tar.
   *
   * The pending autosave is flushed first, otherwise the snapshot would miss
   * the last keystrokes. Cancelling the save dialog is not an error.
   */
  async function exportBackup() {
    if (!els.settingsTarExportBtn) return;
    els.settingsTarExportBtn.disabled = true;
    showSectionStatus(els.settingsTransferStatus, "");
    try {
      await deps.flushSave?.();
      deps.beginNativePicker?.();
      let path;
      try {
        path = await deps.invoke("export_backup");
      } finally {
        deps.endNativePicker?.();
      }
      if (path) {
        showSectionStatus(
          els.settingsTransferStatus,
          deps.t("backup.exported", { path }),
          true
        );
      }
    } catch (err) {
      console.error("export_backup failed:", err);
      showSectionStatus(
        els.settingsTransferStatus,
        deps.t("backup.exportFailed", {
          message: typeof err === "string" ? err : String(err),
        })
      );
    } finally {
      els.settingsTarExportBtn.disabled = false;
    }
  }

  /**
   * Restore a tar into the *current* vault.
   *
   * This is the rescue path: the session key stays the same, `vault.xml` and
   * `recovery.xml` are not replaced, and the backend keeps the old database and
   * attachments in `*.local-backup-*`. Importing a different vault lives in the
   * separate transfer section.
   */
  async function restoreBackup() {
    if (!els.settingsRestoreBtn) return;
    if (!confirm(deps.t("backup.restoreConfirm"))) return;
    els.settingsRestoreBtn.disabled = true;
    showSectionStatus(els.settingsBackupStatus, "");
    try {
      await deps.flushSave?.();
      deps.beginNativePicker?.();
      let path;
      try {
        path = await deps.invoke("restore_backup");
      } finally {
        deps.endNativePicker?.();
      }
      if (path) {
        await deps.afterRestore?.();
        showSectionStatus(
          els.settingsBackupStatus,
          deps.t("backup.restored", { path }),
          true
        );
      }
    } catch (err) {
      console.error("restore_backup failed:", err);
      showSectionStatus(
        els.settingsBackupStatus,
        deps.t("backup.restoreFailed", {
          message: typeof err === "string" ? err : String(err),
        })
      );
    } finally {
      els.settingsRestoreBtn.disabled = false;
    }
  }

  /** Show the update progress bar at `done / total`. */
  function setRecompressProgress(done, total) {
    if (!els.settingsRecompressProgress) return;
    const safeTotal = Math.max(total, 1);
    const percent = Math.min(100, Math.round((done / safeTotal) * 100));

    els.settingsRecompressProgress.hidden = false;
    els.settingsRecompressBar.style.width = `${percent}%`;
    els.settingsRecompressCount.textContent = `${done} / ${total}`;
    els.settingsRecompressTrack.setAttribute("aria-valuenow", String(percent));
  }

  /** Hide and reset the update progress bar. */
  function hideRecompressProgress() {
    if (!els.settingsRecompressProgress) return;
    els.settingsRecompressProgress.hidden = true;
    els.settingsRecompressBar.style.width = "0%";
    els.settingsRecompressCount.textContent = "0 / 0";
    els.settingsRecompressTrack.setAttribute("aria-valuenow", "0");
  }

  /**
   * Move old attachments into the flat folder and shrink the ones that benefit
   * from a lossy WebP re-encode.
   *
   * Replacing bytes is lossy, so the pass is explicit and confirmed. Images that
   * are already small or already lossy WebP are only moved by the backend.
   */
  async function recompressImages() {
    if (!els.settingsRecompressBtn) return;
    if (!confirm(deps.t("settings.recompressConfirm"))) return;

    els.settingsRecompressBtn.disabled = true;
    els.settingsRecompressStatus.textContent = "";
    setRecompressProgress(0, 0);

    const onProgress = (event) => {
      const { done, total } = event.payload || {};
      if (typeof done !== "number" || typeof total !== "number") return;
      setRecompressProgress(done, total);
    };
    let unlisten = null;
    try {
      unlisten = await deps.listen?.("recompress-progress", onProgress);
    } catch (err) {
      // Progress is cosmetic; the update still runs without it.
      console.warn("recompress-progress listener failed:", err);
    }

    try {
      const report = await deps.invoke("recompress_attachments");
      const recompressed = Number(report?.recompressed) || 0;
      const moved = Number(report?.moved) || 0;
      const skipped = Number(report?.skipped) || 0;
      const failed = Number(report?.failed) || 0;
      const saved = Math.max(
        0,
        (Number(report?.bytesBefore) || 0) - (Number(report?.bytesAfter) || 0)
      );
      if (typeof report?.scanned === "number") {
        setRecompressProgress(report.scanned, report.scanned);
      }

      const text =
        recompressed > 0 || moved > 0
          ? deps.t("settings.recompressDone", {
              n: recompressed,
              moved,
              skipped,
              failed,
              saved: formatBytes(saved),
            })
          : deps.t("settings.recompressNothing", { skipped, failed });

      showSectionStatus(
        els.settingsRecompressStatus,
        text,
        failed === 0 && (recompressed > 0 || moved > 0)
      );
      await deps.afterRecompress?.(report);
    } catch (err) {
      console.error("recompress_attachments failed:", err);
      showSectionStatus(
        els.settingsRecompressStatus,
        deps.t("settings.recompressFailed", {
          message: typeof err === "string" ? err : String(err),
        })
      );
    } finally {
      if (typeof unlisten === "function") unlisten();
      hideRecompressProgress();
      els.settingsRecompressBtn.disabled = false;
    }
  }

  /** Open the separate tar-import dialog. */
  function openImportBackup() {
    return handOver(deps.openImportBackup);
  }

  /** Human-readable explanation for an unavailable biometric state. */
  function biometricReasonText(reason) {
    switch (reason) {
      case "no_hardware":
        return deps.t("biometric.reasonNoHardware");
      case "not_enrolled":
        return deps.t("biometric.reasonNotEnrolled");
      case "no_device_credential":
        return deps.t("biometric.reasonNoDeviceCredential");
      case "unavailable":
        return deps.t("biometric.reasonUnavailable");
      case "security_update":
        return deps.t("biometric.reasonSecurityUpdate");
      case "unsupported":
        return deps.t("biometric.reasonUnsupported");
      case "key_missing":
        return deps.t("biometric.reasonKeyMissing");
      case "stale":
        return deps.t("biometric.reasonStale");
      case "not_configured":
        return deps.t("biometric.reasonNotConfigured");
      default:
        return deps.t("biometric.reasonUnknown");
    }
  }

  function showBiometricMessage(text, saved = false) {
    if (!els.settingsBiometricMessage) return;
    els.settingsBiometricMessage.textContent = text;
    els.settingsBiometricMessage.classList.toggle("is-saved", saved);
  }

  /**
   * Paint the Android biometric section.
   *
   * `unsupported_platform` hides the whole block on desktop. Other reasons stay
   * visible so the user can see why the button is disabled (no enrolled
   * fingerprint, no screen lock, and so on).
   */
  function renderBiometric(status) {
    const section = els.settingsBiometricSection;
    if (!section) return;
    if (!status || status.reason === "unsupported_platform") {
      section.hidden = true;
      return;
    }
    section.hidden = false;

    const enrolled = Boolean(status.enabled);
    if (els.settingsBiometricEnableRow) {
      els.settingsBiometricEnableRow.hidden = enrolled;
    }
    if (els.settingsBiometricEnable) {
      els.settingsBiometricEnable.hidden = enrolled;
      els.settingsBiometricEnable.disabled = !status.available;
    }
    if (els.settingsBiometricDisable) {
      els.settingsBiometricDisable.hidden = !enrolled;
    }
    if (els.settingsBiometricStatus) {
      els.settingsBiometricStatus.textContent = enrolled
        ? status.available
          ? deps.t("settings.biometricEnabled")
          : biometricReasonText(status.reason)
        : status.available
          ? deps.t("settings.biometricDisabled")
          : biometricReasonText(status.reason);
    }
  }

  async function refreshBiometric() {
    if (!els.settingsBiometricSection) return;
    try {
      const status = await deps.invoke("biometric_status");
      renderBiometric(status);
    } catch (err) {
      console.error("biometric_status failed:", err);
      // Older backends or non-Android builds simply do not offer the feature.
      renderBiometric({ reason: "unsupported_platform" });
    }
  }

  async function enableBiometric() {
    if (!els.settingsBiometricEnable) return;
    const passphrase = els.settingsBiometricPass?.value ?? "";
    if (!passphrase) {
      showBiometricMessage(deps.t("settings.biometricPassRequired"));
      els.settingsBiometricPass?.focus?.();
      return;
    }

    els.settingsBiometricEnable.disabled = true;
    showBiometricMessage("");
    try {
      const status = await deps.invoke("biometric_enable", { passphrase });
      if (els.settingsBiometricPass) els.settingsBiometricPass.value = "";
      renderBiometric(status);
      showBiometricMessage(deps.t("settings.biometricEnabledDone"), true);
    } catch (err) {
      showBiometricMessage(
        deps.t("settings.biometricEnableFailed", {
          message: typeof err === "string" ? err : String(err),
        })
      );
    } finally {
      els.settingsBiometricEnable.disabled = false;
      void refreshBiometric();
    }
  }

  async function disableBiometric() {
    if (!els.settingsBiometricDisable) return;
    if (!confirm(deps.t("settings.biometricDisableConfirm"))) return;

    els.settingsBiometricDisable.disabled = true;
    showBiometricMessage("");
    try {
      const status = await deps.invoke("biometric_disable");
      renderBiometric(status);
      showBiometricMessage(deps.t("settings.biometricDisabledDone"), true);
    } catch (err) {
      showBiometricMessage(
        deps.t("settings.biometricDisableFailed", {
          message: typeof err === "string" ? err : String(err),
        })
      );
    } finally {
      els.settingsBiometricDisable.disabled = false;
      void refreshBiometric();
    }
  }

  /** Show the folder the diary is stored in. */
  async function renderDiaryPath() {
    try {
      const path = await deps.invoke("diary_path");
      els.settingsDiaryPath.textContent = path;
      els.settingsDiaryPath.title = path;
    } catch (err) {
      console.error("diary_path failed:", err);
      els.settingsDiaryPath.textContent = "";
    }
  }

  /** Open the settings dialog and populate it from the backend. */
  async function openSettings() {
    els.settingsError.textContent = "";
    els.settingsCalibrateNote.textContent = "";
    els.settingsCurrentPass.value = "";
    els.settingsNewPass.value = "";
    els.settingsNewPassConfirm.value = "";
    if (els.settingsBiometricPass) els.settingsBiometricPass.value = "";
    clearVaultStatus();
    showBiometricMessage("");
    returnToSettings = false;

    // Not awaited: the path and build info are informational, so the dialog
    // should not wait on extra round trips before it appears.
    await Promise.all([renderDiaryPath(), renderAppInfo()]);

    let mobile = false;
    try {
      const settings = await deps.invoke("get_settings");
      mobile = Boolean(settings.mobile);
      // Mobile has no folder picker, so the diary path is fixed. Hiding the
      // action is clearer than opening a picker that cannot change anything.
      if (els.settingsChangeDirBtn) {
        els.settingsChangeDirBtn.hidden = mobile;
      }
      renderAutoLockChoices(
        settings.autoLockChoices ?? DEFAULT_AUTO_LOCK_CHOICES,
        settings.autoLockMinutes ?? 0
      );
      renderAutosaveChoices(
        settings.autosaveDelayChoices ?? DEFAULT_AUTOSAVE_DELAY_CHOICES,
        settings.autosaveDelayMs ?? DEFAULT_AUTOSAVE_DELAY_CHOICES[2]
      );
      const params = await deps.invoke("get_vault_kdf");
      renderVaultKdf(params);
      fillSettingsKdf(params);
      await refreshRecoveryStatus();
    } catch (err) {
      console.error("settings load failed:", err);
      els.settingsError.textContent = deps.t("settings.errSave", {
        message: typeof err === "string" ? err : String(err),
      });
    }

    // A phone has a long settings dialog on a short screen. Start with every
    // block closed so the headings act as a menu; desktop keeps them open.
    setSectionsOpen(!mobile);

    // Android-only. Desktop hides the block as soon as the backend reports
    // `unsupported_platform`; the rest of the dialog does not wait on it.
    void refreshBiometric();

    els.settingsOverlay.hidden = false;
    focusTrap.activate();
    if (mobile) {
      const first = els.settingsOverlay?.querySelector?.(".settings-disclosure");
      (first ?? els.settingsClose)?.focus?.();
    } else {
      els.settingsCurrentPass.focus();
    }
  }

  /** Close the settings dialog without saving. */
  function closeSettings() {
    returnToSettings = false;
    animateOverlayExit(els.settingsOverlay, { redactInputs: true });
    els.settingsOverlay.hidden = true;
    focusTrap.deactivate();
    els.settingsError.textContent = "";
    // Never leave a passphrase sitting in a hidden input.
    els.settingsCurrentPass.value = "";
    els.settingsNewPass.value = "";
    els.settingsNewPassConfirm.value = "";
    if (els.settingsBiometricPass) els.settingsBiometricPass.value = "";
    clearVaultStatus();
    showBiometricMessage("");
  }

  /**
   * Close the dialog, then run one of the vault-wide actions.
   *
   * Closing first matters: import and statistics are full-screen overlays of
   * their own, and the folder picker takes over the lock screen. Leaving the
   * settings dialog open underneath would leave two modals stacked.
   */
  function handOver(action) {
    closeSettings();
    return action();
  }

  /**
   * Open statistics without losing the settings dialog.
   *
   * Statistics is a temporary detour, so the dialog is only hidden; the
   * statistics controller calls `returnFromStats` when it closes, which shows
   * the dialog again with its scroll position and unsaved fields intact.
   */
  function openStats() {
    returnToSettings = true;
    els.settingsOverlay.hidden = true;
    focusTrap.deactivate({ restore: false });
    return deps.openStats();
  }

  /** Bring the settings dialog back after the statistics close. */
  function returnFromStats() {
    if (!returnToSettings) return false;
    returnToSettings = false;
    els.settingsOverlay.hidden = false;
    focusTrap.activate();
    els.settingsStatsBtn?.focus?.();
    return true;
  }

  /** Measure this machine and fill the advanced inputs with the result. */
  async function calibrateKdf() {
    els.settingsError.textContent = "";
    els.settingsCalibrate.disabled = true;
    els.settingsCalibrateNote.textContent = deps.t("settings.calibrating");
    try {
      const params = await deps.invoke("calibrate_kdf");
      fillSettingsKdf(params);
      els.settingsCalibrateNote.textContent = deps.t("settings.calibrated", {
        memory: Math.round(params.memoryKib / 1024),
        iterations: params.iterations,
        parallelism: params.parallelism,
      });
    } catch (err) {
      console.error("calibrate_kdf failed:", err);
      els.settingsCalibrateNote.textContent = "";
      els.settingsError.textContent = deps.t("settings.errCalibrate", {
        message: typeof err === "string" ? err : String(err),
      });
    } finally {
      els.settingsCalibrate.disabled = false;
    }
  }

  /** Save the dialog. */
  async function saveSettings() {
    els.settingsError.textContent = "";

    const current = els.settingsCurrentPass.value;
    const next = els.settingsNewPass.value;
    const confirm = els.settingsNewPassConfirm.value;
    const wantsPassChange = current !== "" || next !== "" || confirm !== "";

    // Editing the Argon2id parameters is a vault change of its own: it re-wraps
    // the diary key, so it needs the current passphrase just like a passphrase
    // change does. Detecting it separately is what makes a parameter-only edit
    // work — previously it was skipped whenever the passphrase fields were
    // empty, so the new values were never sent to the backend.
    const kdf = readSettingsKdf();
    const wantsKdfChange = kdfChanged(kdf);
    const wantsVaultChange = wantsPassChange || wantsKdfChange;

    if (wantsVaultChange) {
      if (!current) {
        els.settingsError.textContent = deps.t("settings.errCurrentRequired");
        return;
      }
      if (next !== confirm) {
        els.settingsError.textContent = deps.t("settings.errMismatch");
        return;
      }
      if (next !== "" && next.length < 12) {
        els.settingsError.textContent = deps.t("lock.errTooShort");
        return;
      }
    }

    els.settingsSave.disabled = true;
    try {
      const minutes = Number(els.autoLockSelect.value);
      await deps.invoke("set_auto_lock", { minutes });
      deps.setAutoLockMinutes(minutes);

      const delayMs = Number(els.autosaveDelaySelect.value);
      await deps.invoke("set_autosave_delay", { ms: delayMs });
      deps.setAutosaveDelay(delayMs);

      if (wantsVaultChange) {
        if (
          !Number.isFinite(kdf.memoryKib) ||
          !Number.isFinite(kdf.iterations) ||
          !Number.isFinite(kdf.parallelism)
        ) {
          els.settingsError.textContent = deps.t("lock.errKdfNaN");
          return;
        }
        // An empty `newPassphrase` tells the backend to keep the current
        // passphrase and only re-wrap with the new parameters.
        await deps.invoke("change_passphrase", {
          currentPassphrase: current,
          newPassphrase: next,
          kdf,
        });
        // The vault now records the parameters we just sent.
        renderVaultKdf(kdf);
      }

      closeSettings();
      deps.setStatus(deps.t("settings.saved"), true);
    } catch (err) {
      console.error("save settings failed:", err);
      els.settingsError.textContent = deps.t("settings.errSave", {
        message: typeof err === "string" ? err : String(err),
      });
    } finally {
      els.settingsSave.disabled = false;
    }
  }

  return {
    isSettingsOpen,
    renderAutoLockChoices,
    renderAutosaveChoices,
    renderVaultKdf,
    fillSettingsKdf,
    readSettingsKdf,
    renderDiaryPath,
    renderAppInfo,
    openSettings,
    closeSettings,
    calibrateKdf,
    saveSettings,
    refreshRecoveryStatus,
    removeRecovery,
    openRecovery,
    openStats,
    returnFromStats,
    exportBackup,
    restoreBackup,
    recompressImages,
    openImportBackup,
    enableBiometric,
    disableBiometric,
    openImport: () => handOver(deps.openImport),
    changeDiaryDir: () => handOver(deps.changeDiaryDir),
  };
}
