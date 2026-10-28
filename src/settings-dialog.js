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

    // Not awaited: the path is informational, so the dialog should not wait on
    // a second round trip before it appears.
    renderDiaryPath();

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
    } catch (err) {
      console.error("settings load failed:", err);
      els.settingsError.textContent = deps.t("settings.errSave", {
        message: typeof err === "string" ? err : String(err),
      });
    }

    els.settingsOverlay.hidden = false;
    els.settingsCurrentPass.focus();
  }

  /** Close the settings dialog without saving. */
  function closeSettings() {
    els.settingsOverlay.hidden = true;
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

    if (wantsPassChange) {
      if (!current) {
        els.settingsError.textContent = deps.t("settings.errCurrentRequired");
        return;
      }
      if (next !== confirm) {
        els.settingsError.textContent = deps.t("settings.errMismatch");
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

      if (wantsPassChange) {
        const kdf = readSettingsKdf();
        if (
          !Number.isFinite(kdf.memoryKib) ||
          !Number.isFinite(kdf.iterations) ||
          !Number.isFinite(kdf.parallelism)
        ) {
          els.settingsError.textContent = deps.t("lock.errKdfNaN");
          return;
        }
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
    openSettings,
    closeSettings,
    calibrateKdf,
    saveSettings,
    openImport: () => handOver(deps.openImport),
    openStats: () => handOver(deps.openStats),
    changeDiaryDir: () => handOver(deps.changeDiaryDir),
  };
}
