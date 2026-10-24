// ---------------------------------------------------------------------------
// Lock screen
// ---------------------------------------------------------------------------
//
// The lock screen has three layouts, chosen by two flags:
//
//   configured       — a settings file exists, so a diary folder is chosen
//   vaultInitialized — that folder already holds a vault
//
//   configured  vault  layout
//   ----------  -----  ------------------------------------------------------
//   false       false  first run: pick a folder, then choose a passphrase
//   true        false  folder chosen but empty: choose a passphrase
//   true        true   returning user: passphrase only
//
// A third flag, `pickingWorkspace`, decouples "the path field is visible" from
// "the app has no settings file yet". It is set when the user asks to switch
// workspace from the lock screen, so a returning user can point the app at a
// different diary folder *before* unlocking. The folder they land on decides
// the rest: if it already holds a vault the form asks for its passphrase,
// otherwise it offers to create a new one.
//
// All three flags are owned here because every function below reads or writes
// them. `main.js` reads them through `isConfigured()` / `isVaultInitialized()`
// and writes them through the setters, so there is still one source of truth.
//
// `deps` shape:
//
//   els                — the lookup table from `dom.js`
//   invoke             — (command: string, args?: object) => Promise<any>
//   t                  — (key: string, params?: object) => string
//   setAutoLockMinutes — (minutes: number) => void
//   enterApp           — () => Promise<void>
//   resetAutoLockTimer — () => void
//   stopAutoLockTimer  — () => void
//   refreshList        — () => Promise<void>
//   selectDate         — (iso: string) => Promise<void>
//   resetEditorState   — () => void
//   closeCalendar      — () => void
//   closeImport        — () => void
//   closeSettings      — () => void
//   renderDateLabel    — () => void

/**
 * Create the lock screen controller.
 *
 * Returns the functions `main.js` and `wiring.js` need, plus the two state
 * accessors.
 */
export function createLockScreen(deps) {
  const { els } = deps;

  /** Whether a settings file exists (a diary folder has been chosen). */
  let configured = false;
  /** Whether the chosen folder already holds a vault. */
  let vaultInitialized = false;
  /**
   * Whether the user asked to switch workspace and the path field is open.
   *
   * Kept separate from `configured` so that opening the picker does not make
   * the app look "unconfigured": the settings file is still there, and the
   * subtitle must keep saying "unlock" rather than "first run".
   */
  let pickingWorkspace = false;
  /** Bounds and defaults reported by the backend. */
  let kdfDefaults = null;

  function isConfigured() {
    return configured;
  }

  function setConfigured(value) {
    configured = value;
  }

  function isVaultInitialized() {
    return vaultInitialized;
  }

  function setVaultInitialized(value) {
    vaultInitialized = value;
  }

  function isPickingWorkspace() {
    return pickingWorkspace;
  }

  function setPickingWorkspace(value) {
    pickingWorkspace = value;
  }

  function showLockScreen(message = "") {
    els.app.hidden = true;
    els.lockScreen.hidden = false;
    els.lockError.textContent = message;
    els.passphrase.value = "";
    els.passphraseConfirm.value = "";
    els.passphrase.focus();
  }

  // -------------------------------------------------------------------------
  // Argon2id parameters (advanced options, first run only)
  // -------------------------------------------------------------------------

  /** Populate the advanced panel from the backend's defaults. */
  async function loadKdfDefaults() {
    try {
      kdfDefaults = await deps.invoke("get_kdf_defaults");
    } catch (err) {
      console.error("get_kdf_defaults failed:", err);
      return;
    }
    els.kdfMemory.min = kdfDefaults.minMemoryKib / 1024;
    els.kdfMemory.max = kdfDefaults.maxMemoryKib / 1024;
    els.kdfIterations.min = kdfDefaults.minIterations;
    els.kdfIterations.max = kdfDefaults.maxIterations;
    els.kdfParallelism.min = kdfDefaults.minParallelism;
    els.kdfParallelism.max = kdfDefaults.maxParallelism;
    resetKdfFields();
  }

  /** Restore the recommended (OWASP) parameters. */
  function resetKdfFields() {
    if (!kdfDefaults) return;
    els.kdfMemory.value = kdfDefaults.memoryKib / 1024;
    els.kdfIterations.value = kdfDefaults.iterations;
    els.kdfParallelism.value = kdfDefaults.parallelism;
    updateKdfEstimate();
  }

  /** Read the panel as `{ memoryKib, iterations, parallelism }`. */
  function readKdfParams() {
    return {
      memoryKib: Math.round(Number(els.kdfMemory.value) * 1024),
      iterations: Math.round(Number(els.kdfIterations.value)),
      parallelism: Math.round(Number(els.kdfParallelism.value)),
    };
  }

  /**
   * Rough unlock-time estimate.
   *
   * Argon2id cost is dominated by `memory * iterations`; the constant is a
   * deliberately conservative guess so the label errs on the slow side.
   */
  function updateKdfEstimate() {
    const { memoryKib, iterations } = readKdfParams();
    if (!Number.isFinite(memoryKib) || !Number.isFinite(iterations)) {
      els.kdfEstimate.textContent = "";
      return;
    }
    const seconds = (memoryKib / 1024) * iterations * 0.02;
    els.kdfEstimate.textContent = deps.t("lock.kdfEstimate", {
      seconds: seconds.toFixed(2),
    });
  }

  /** Apply the lock screen layout for the current setup state. */
  function renderLockScreen() {
    // The path field is shown on first run, and whenever the user opens the
    // workspace picker. It is *not* tied to `configured` any more: a returning
    // user must be able to point the app at another diary folder before they
    // unlock, otherwise a second workspace would be unreachable.
    els.pathField.hidden = configured && !pickingWorkspace;
    // The current workspace is only worth showing once one has been chosen,
    // and it is hidden while the picker is open (the path field says it all).
    els.workspaceRow.hidden = !configured || pickingWorkspace;
    // KDF parameters can only be chosen when a new vault is being created.
    els.advancedField.hidden = vaultInitialized;

    if (vaultInitialized) {
      // A vault exists at the selected location: ask for the passphrase only.
      els.lockSubtitle.textContent = configured
        ? deps.t("lock.subtitle.unlock")
        : deps.t("lock.subtitle.existing");
      els.passphraseConfirm.hidden = true;
      els.passphrase.placeholder = deps.t("lock.passphrase");
      els.passphrase.autocomplete = "current-password";
      els.lockSubmit.textContent = deps.t("lock.submitUnlock");
    } else if (configured) {
      // Configured folder but no vault yet (e.g. an empty folder was picked).
      els.lockSubtitle.textContent = pickingWorkspace
        ? deps.t("lock.subtitle.switching")
        : deps.t("lock.subtitle.newInFolder");
      els.passphraseConfirm.hidden = false;
      els.passphrase.placeholder = deps.t("lock.passphraseSet");
      els.passphrase.autocomplete = "new-password";
      els.lockSubmit.textContent = deps.t("lock.submitCreate");
    } else {
      // First run: pick a folder, then choose a passphrase.
      els.lockSubtitle.textContent = deps.t("lock.subtitle.firstRun");
      els.passphraseConfirm.hidden = false;
      els.passphrase.placeholder = deps.t("lock.passphraseSet");
      els.passphrase.autocomplete = "new-password";
      els.lockSubmit.textContent = deps.t("lock.submitCreate");
    }
  }

  /** Show the configured folder next to the "switch workspace" button. */
  function renderWorkspacePath() {
    const path = els.diaryDir.value.trim();
    els.workspacePath.textContent = path;
    els.workspacePath.title = path;
  }

  async function enterApp() {
    els.lockScreen.hidden = true;
    els.app.hidden = false;

    try {
      const path = await deps.invoke("diary_path");
      els.diaryPath.textContent = path;
      els.diaryPath.title = path;
    } catch (err) {
      console.error("diary_path failed:", err);
    }

    // Start the idle countdown as soon as the diary is visible. The duration was
    // read from the settings file during `init()`.
    deps.resetAutoLockTimer();

    await deps.refreshList();

    const today = await deps.invoke("today");
    await deps.selectDate(today);
  }

  /** Re-read the settings file and refresh the lock screen state. */
  async function loadSettings() {
    const settings = await deps.invoke("get_settings");
    configured = settings.configured;
    els.diaryDir.value = settings.diaryDir ?? settings.defaultDir ?? "";
    renderWorkspacePath();
    // Keep the idle timer in sync with whatever is on disk.
    deps.setAutoLockMinutes(settings.autoLockMinutes ?? 0);
    return settings;
  }

  /**
   * Check whether a directory already holds a vault.
   *
   * With no argument the configured directory is inspected; with a path the
   * given directory is inspected instead (used by the setup screen).
   */
  async function detectVault(path) {
    try {
      return await deps.invoke("vault_exists", path ? { path } : {});
    } catch (err) {
      console.error("vault_exists failed:", err);
      return false;
    }
  }

  /** Re-check whether the diary directory already holds a vault. */
  async function refreshVaultState() {
    vaultInitialized = await detectVault();
  }

  /**
   * Re-detect the vault in the path currently typed on the setup screen.
   *
   * This is what makes an existing diary folder open in unlock mode instead of
   * failing with "Vault already exists".
   */
  async function refreshSetupVaultState() {
    const dir = els.diaryDir.value.trim();
    if (!dir) {
      vaultInitialized = false;
      renderLockScreen();
      return;
    }
    vaultInitialized = await detectVault(dir);
    renderLockScreen();
  }

  /**
   * Open the workspace picker on the lock screen.
   *
   * The path field is pre-filled with the folder currently in use, so the user
   * can either edit it or hit "Browse…". Nothing is written to the settings
   * file until the form is submitted, so abandoning the picker leaves the app
   * pointing at the original workspace.
   */
  async function openWorkspacePicker() {
    els.lockError.textContent = "";
    pickingWorkspace = true;
    renderLockScreen();
    els.diaryDir.focus();
    els.diaryDir.select();
    // Re-detect so the layout matches the folder that is already in the field.
    await refreshSetupVaultState();
  }

  /**
   * Close the workspace picker and restore the folder that is actually saved.
   *
   * The field is reset from the settings file rather than from a remembered
   * value, so a half-typed path cannot leak into the next unlock attempt.
   */
  async function cancelWorkspacePicker() {
    if (!configured) return;
    els.lockError.textContent = "";
    pickingWorkspace = false;
    try {
      const settings = await deps.invoke("get_settings");
      els.diaryDir.value = settings.diaryDir ?? "";
    } catch (err) {
      console.error("get_settings failed:", err);
    }
    renderWorkspacePath();
    await refreshVaultState();
    renderLockScreen();
    els.passphrase.focus();
  }

  async function handleUnlockSubmit(event) {
    event.preventDefault();
    els.lockError.textContent = "";

    const passphrase = els.passphrase.value;
    if (!passphrase) {
      els.lockError.textContent = deps.t("lock.errNoPassphrase");
      return;
    }

    const creating = !vaultInitialized;
    if (creating) {
      const confirmValue = els.passphraseConfirm.value;
      if (passphrase.length < 6) {
        els.lockError.textContent = deps.t("lock.errTooShort");
        return;
      }
      if (passphrase !== confirmValue) {
        els.lockError.textContent = deps.t("lock.errMismatch");
        return;
      }
    }

    els.lockSubmit.disabled = true;
    try {
      // The path is persisted when the app is unconfigured (first run) *or*
      // when the user opened the workspace picker to point at another folder.
      // In both cases the folder is re-checked right before committing, because
      // it may already hold a vault.
      if (!configured || pickingWorkspace) {
        const dir = els.diaryDir.value.trim();
        if (!dir) {
          els.lockError.textContent = deps.t("lock.errNoDir");
          return;
        }
        vaultInitialized = await detectVault(dir);
        await deps.invoke("set_diary_dir", { path: dir });
        configured = true;
        pickingWorkspace = false;
        renderWorkspacePath();
      }

      if (vaultInitialized) {
        await deps.invoke("unlock", { passphrase });
      } else {
        const kdf = readKdfParams();
        if (
          !Number.isFinite(kdf.memoryKib) ||
          !Number.isFinite(kdf.iterations) ||
          !Number.isFinite(kdf.parallelism)
        ) {
          els.lockError.textContent = deps.t("lock.errKdfNaN");
          return;
        }
        await deps.invoke("create_vault", { passphrase, kdf });
        vaultInitialized = true;
      }
      await enterApp();
    } catch (err) {
      console.error("unlock failed:", err);
      els.lockError.textContent =
        typeof err === "string" ? err : deps.t("lock.errUnlockFailed");
      els.passphrase.select();
    } finally {
      els.lockSubmit.disabled = false;
    }
  }

  /** Open the native folder picker and store the result in the path field. */
  async function browseForDir() {
    els.lockError.textContent = "";
    try {
      const picked = await deps.invoke("pick_diary_dir");
      if (picked) {
        els.diaryDir.value = picked;
        await refreshSetupVaultState();
      }
    } catch (err) {
      console.error("pick_diary_dir failed:", err);
      els.lockError.textContent = deps.t("lock.errPicker");
    }
  }

  /** Change the diary location from the sidebar (must be locked first). */
  async function changeDiaryDir() {
    await deps.lockAndFlush();

    deps.resetEditorState();
    deps.closeCalendar();
    deps.closeImport();
    deps.closeSettings();
    deps.renderDateLabel();

    // Lock, then open the same workspace picker the lock screen offers. Going
    // through `openWorkspacePicker` keeps one code path for "choose another
    // folder": `configured` stays true, so the subtitle still reads "unlock"
    // when the folder the user lands on already holds a diary.
    deps.stopAutoLockTimer();
    await refreshVaultState();
    showLockScreen();
    await openWorkspacePicker();
  }

  async function lockNow() {
    await deps.lockAndFlush();

    deps.resetEditorState();
    deps.closeCalendar();
    deps.closeImport();
    deps.renderDateLabel();

    // Locking must return to the *unlock* form, not the first-run setup form.
    // `configured` stays true (the settings file is still there) and the vault
    // still exists, so re-render instead of leaving the previous layout on
    // screen. Re-detect the vault so a folder that was swapped out from under
    // us is handled correctly. A picker left open from a previous attempt is
    // closed, so locking always lands on the plain unlock form.
    deps.stopAutoLockTimer();
    deps.closeSettings();
    pickingWorkspace = false;
    await refreshVaultState();
    showLockScreen();
    renderLockScreen();
  }

  return {
    isConfigured,
    setConfigured,
    isVaultInitialized,
    setVaultInitialized,
    isPickingWorkspace,
    setPickingWorkspace,
    showLockScreen,
    loadKdfDefaults,
    resetKdfFields,
    readKdfParams,
    updateKdfEstimate,
    renderLockScreen,
    renderWorkspacePath,
    enterApp,
    loadSettings,
    detectVault,
    refreshVaultState,
    refreshSetupVaultState,
    openWorkspacePicker,
    cancelWorkspacePicker,
    handleUnlockSubmit,
    browseForDir,
    changeDiaryDir,
    lockNow,
  };
}
