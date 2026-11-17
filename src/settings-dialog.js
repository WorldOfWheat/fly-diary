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
// not take part in `saveSettings`; they simply close the dialog and hand over
// to the controller that owns them.
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
//   flushSave          — () => Promise<void>
//   flushAndLock       — () => Promise<void>
//   afterRestore       — () => Promise<void>
//   afterSync          — (report: object) => void | Promise<void>
//   setSyncAutoEnabled — (enabled: boolean) => void

/** Fallback choices if the backend does not report any. */
const DEFAULT_AUTO_LOCK_CHOICES = [0, 1, 5, 10, 15, 30, 60];

/** Fallback autosave delays, mirroring `settings::AUTOSAVE_DELAY_CHOICES`. */
const DEFAULT_AUTOSAVE_DELAY_CHOICES = [200, 400, 800, 1500, 3000];

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

  /** Last sync result, so the conflict list survives reopening the dialog. */
  let lastSyncReport = null;

  /** Whether the settings dialog is open. */
  function isSettingsOpen() {
    return !els.settingsOverlay.hidden;
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

  // -------------------------------------------------------------------------
  // Android folder sync
  // -------------------------------------------------------------------------
  //
  // Hidden on desktop: `get_sync_status` reports `supported: false` there, and
  // none of the other sync commands exist in a desktop build either.

  /** Human label for the kind of conflict. */
  function conflictLabel(kind) {
    if (kind === "localEditedRemoteDeleted") {
      return deps.t("sync.conflictLocalDeleted");
    }
    if (kind === "remoteEditedLocalDeleted") {
      return deps.t("sync.conflictRemoteDeleted");
    }
    return deps.t("sync.conflictBoth");
  }

  /** Format a sync timestamp, falling back to "never". */
  function formatSyncTime(ms) {
    if (!ms) return deps.t("sync.never");
    try {
      return new Date(ms).toLocaleString();
    } catch {
      return deps.t("sync.never");
    }
  }

  /** Render the list of unresolved conflicts with per-file buttons. */
  function renderSyncConflicts(conflicts) {
    if (!els.syncConflicts || !els.syncConflictList) return;
    const list = Array.isArray(conflicts) ? conflicts : [];
    els.syncConflictList.replaceChildren();

    for (const conflict of list) {
      const item = document.createElement("li");
      item.className = "sync-conflict";

      const text = document.createElement("div");
      text.className = "sync-conflict-text";
      const path = document.createElement("span");
      path.className = "sync-conflict-path";
      path.textContent = conflict.path;
      const kind = document.createElement("span");
      kind.className = "sync-conflict-kind";
      kind.textContent = conflictLabel(conflict.kind);
      text.append(path, kind);

      const actions = document.createElement("div");
      actions.className = "sync-conflict-actions";
      for (const keep of ["local", "remote"]) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "btn-browse";
        button.dataset.path = conflict.path;
        button.dataset.keep = keep;
        if (keep === "local") {
          // A missing remote side means "keep local" deletes from the folder,
          // so label the action by its consequence rather than by its side.
          button.textContent =
            conflict.remoteSize == null
              ? deps.t("sync.deleteRemote")
              : deps.t("sync.keepLocal");
        } else {
          button.textContent =
            conflict.localSize == null
              ? deps.t("sync.deleteLocal")
              : deps.t("sync.keepRemote");
        }
        actions.append(button);
      }

      item.append(text, actions);
      els.syncConflictList.append(item);
    }

    els.syncConflicts.hidden = list.length === 0;
  }

  /** Show the outcome of one sync run. */
  function renderSyncReport(report) {
    lastSyncReport = report ?? null;
    const pushed = report?.pushed?.length ?? 0;
    const pulled = report?.pulled?.length ?? 0;
    const conflicts = report?.conflicts ?? [];

    renderSyncConflicts(conflicts);
    if (els.syncStatus) {
      els.syncStatus.textContent =
        pushed || pulled || conflicts.length
          ? deps.t("sync.result", {
              pushed,
              pulled,
              conflicts: conflicts.length,
            })
          : deps.t("sync.upToDate");
    }
    if (els.syncLast && report?.syncedAtMs) {
      els.syncLast.textContent = formatSyncTime(report.syncedAtMs);
    }
  }

  /** Read the binding and last run from the backend. */
  async function refreshSyncStatus() {
    if (!els.syncSection) return;
    try {
      const status = await deps.invoke("get_sync_status");
      if (!status?.supported) {
        els.syncSection.hidden = true;
        return;
      }

      els.syncSection.hidden = false;
      const bound = Boolean(status.bound);
      if (els.syncUnbound) els.syncUnbound.hidden = bound;
      if (els.syncBound) els.syncBound.hidden = !bound;
      if (els.syncDisplayName) {
        els.syncDisplayName.textContent = status.displayName || "";
        els.syncDisplayName.title = status.treeUri || "";
      }
      if (els.syncAuto) els.syncAuto.checked = Boolean(status.autoSync);
      deps.setSyncAutoEnabled?.(Boolean(status.autoSync));
      if (els.syncLast) {
        els.syncLast.textContent = formatSyncTime(status.lastSyncedAtMs);
      }
      if (els.syncStatus) {
        els.syncStatus.textContent = bound
          ? lastSyncReport
            ? els.syncStatus.textContent
            : deps.t("sync.bound")
          : "";
      }
      renderSyncConflicts(status.conflicts ?? []);
      if (els.syncError) els.syncError.textContent = "";
    } catch (err) {
      console.error("get_sync_status failed:", err);
      els.syncSection.hidden = true;
    }
  }

  /** Show a sync error beneath the section. */
  function showSyncError(err) {
    if (!els.syncError) return;
    els.syncError.textContent = deps.t("sync.failed", {
      message: typeof err === "string" ? err : String(err),
    });
  }

  /**
   * Pick a folder and either merge into it or adopt it.
   *
   * Adopting replaces the private vault, so the session is locked first and the
   * caller resets the UI to the lock screen afterwards.
   */
  async function pickSyncDir() {
    if (els.syncError) els.syncError.textContent = "";
    try {
      const picked = await deps.invoke("pick_sync_dir");
      if (!picked) return;

      const inspection = await deps.invoke("inspect_sync_dir", {
        treeUri: picked.uri,
      });

      if (inspection?.hasVault && !inspection.sameVault) {
        if (!confirm(deps.t("sync.restoreConfirm", { name: picked.name }))) {
          return;
        }
        await deps.flushAndLock?.();
        try {
          await deps.invoke("restore_from_sync_dir", {
            treeUri: picked.uri,
            displayName: picked.name,
          });
        } catch (err) {
          console.error("restore_from_sync_dir failed:", err);
          await deps.afterRestore?.();
          globalThis.alert?.(
            deps.t("sync.restoreFailed", {
              message: typeof err === "string" ? err : String(err),
            })
          );
          return;
        }
        await deps.afterRestore?.();
        return;
      }

      const report = await deps.invoke("bind_sync_dir", {
        treeUri: picked.uri,
        displayName: picked.name,
      });
      renderSyncReport(report);
      await refreshSyncStatus();
      await deps.afterSync?.(report);
    } catch (err) {
      console.error("pick_sync_dir failed:", err);
      showSyncError(err);
    }
  }

  /** Mirror the vault and the folder now. */
  async function syncNow() {
    if (!els.syncNowBtn) return;
    els.syncNowBtn.disabled = true;
    if (els.syncError) els.syncError.textContent = "";
    if (els.syncStatus) els.syncStatus.textContent = deps.t("sync.running");
    try {
      // Flush first so unsaved typing becomes part of the comparison instead
      // of being overwritten by a pull that happened "before" it.
      await deps.flushSave?.();
      const report = await deps.invoke("sync_now");
      renderSyncReport(report);
      await refreshSyncStatus();
      await deps.afterSync?.(report);
    } catch (err) {
      console.error("sync_now failed:", err);
      showSyncError(err);
    } finally {
      els.syncNowBtn.disabled = false;
    }
  }

  /** Stop mirroring to the folder. */
  async function unbindSyncDir() {
    if (!confirm(deps.t("sync.unbindConfirm"))) return;
    try {
      await deps.invoke("unbind_sync_dir");
      lastSyncReport = null;
      await refreshSyncStatus();
    } catch (err) {
      console.error("unbind_sync_dir failed:", err);
      showSyncError(err);
    }
  }

  /** Toggle the automatic sync hooks. */
  async function setSyncAuto(enabled) {
    try {
      await deps.invoke("set_sync_auto", { enabled });
      deps.setSyncAutoEnabled?.(enabled);
      if (els.syncError) els.syncError.textContent = "";
    } catch (err) {
      console.error("set_sync_auto failed:", err);
      if (els.syncAuto) els.syncAuto.checked = !enabled;
      showSyncError(err);
    }
  }

  /** Resolve one conflict and then refresh the report. */
  async function resolveSyncConflict(path, keep) {
    if (!path || (keep !== "local" && keep !== "remote")) return;
    if (!confirm(deps.t("sync.resolveConfirm", { path }))) return;
    try {
      await deps.flushSave?.();
      await deps.invoke("resolve_sync_conflict", { path, keep });
      await syncNow();
    } catch (err) {
      console.error("resolve_sync_conflict failed:", err);
      showSyncError(err);
    }
  }

  /** Open the settings dialog and populate it from the backend. */
  async function openSettings() {
    els.settingsError.textContent = "";
    els.settingsCalibrateNote.textContent = "";
    els.settingsCurrentPass.value = "";
    els.settingsNewPass.value = "";
    els.settingsNewPassConfirm.value = "";

    // Not awaited: the path and build info are informational, so the dialog
    // should not wait on extra round trips before it appears.
    await Promise.all([renderDiaryPath(), renderAppInfo(), refreshSyncStatus()]);

    try {
      const settings = await deps.invoke("get_settings");
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

    els.settingsOverlay.hidden = false;
    focusTrap.activate();
    els.settingsCurrentPass.focus();
  }

  /** Close the settings dialog without saving. */
  function closeSettings() {
    animateOverlayExit(els.settingsOverlay, { redactInputs: true });
    els.settingsOverlay.hidden = true;
    focusTrap.deactivate();
    els.settingsError.textContent = "";
    // Never leave a passphrase sitting in a hidden input.
    els.settingsCurrentPass.value = "";
    els.settingsNewPass.value = "";
    els.settingsNewPassConfirm.value = "";
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
    refreshSyncStatus,
    pickSyncDir,
    syncNow,
    unbindSyncDir,
    setSyncAuto,
    resolveSyncConflict,
    openImport: () => handOver(deps.openImport),
    openStats: () => handOver(deps.openStats),
    changeDiaryDir: () => handOver(deps.changeDiaryDir),
  };
}
