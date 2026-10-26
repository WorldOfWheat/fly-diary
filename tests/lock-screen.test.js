// ---------------------------------------------------------------------------
// Lock screen tests
// ---------------------------------------------------------------------------
//
// The lock screen is the only controller that owns state (`configured`,
// `vaultInitialized`, `kdfDefaults`), so the tests are organised around the
// three layouts those two flags select:
//
//   first run      — pick a folder, then choose a passphrase
//   empty folder   — choose a passphrase
//   returning user — passphrase only
//
// The other half is `handleUnlockSubmit`, which has to route to `create_vault`
// or `unlock` correctly and validate the passphrase before it touches the
// backend.

import test from "node:test";
import assert from "node:assert/strict";

import { createLockScreen } from "../src/lock-screen.js";
import { installDom, fakeEls, fakeT, fakeInvoke, spy } from "./helpers/dom.js";

const LOCK_IDS = [
  "app",
  "lockScreen",
  "lockError",
  "lockSubtitle",
  "lockSubmit",
  "passphrase",
  "passphraseConfirm",
  "workspaceRow",
  "workspacePath",
  "pathField",
  "diaryDir",
  "advancedField",
  "kdfMemory",
  "kdfIterations",
  "kdfParallelism",
  "kdfEstimate",
  "diaryPath",
];

/** The KDF bounds the fake backend reports. */
const KDF_DEFAULTS = {
  memoryKib: 65536,
  iterations: 3,
  parallelism: 4,
  minMemoryKib: 8192,
  maxMemoryKib: 1048576,
  minIterations: 1,
  maxIterations: 10,
  minParallelism: 1,
  maxParallelism: 8,
};

/** Build a lock screen controller plus the fakes it needs. */
function harness(overrides = {}) {
  const restore = installDom();
  const els = fakeEls(LOCK_IDS);
  els.lockScreen.hidden = false;
  els.app.hidden = true;

  const invoke = fakeInvoke({
    get_kdf_defaults: KDF_DEFAULTS,
    get_settings: {
      configured: true,
      diaryDir: "/home/u/diary",
      autoLockMinutes: 5,
    },
    vault_exists: true,
    diary_path: "/home/u/diary",
    today: "2026-10-23",
    set_diary_dir: null,
    unlock: null,
    create_vault: null,
    pick_diary_dir: "/home/u/other",
    ...(overrides.invokeTable ?? {}),
  });

  const deps = {
    els,
    invoke,
    t: fakeT(),
    setAutoLockMinutes: spy(),
    enterApp: spy(async () => {}),
    resetAutoLockTimer: spy(),
    stopAutoLockTimer: spy(),
    refreshList: spy(async () => {}),
    selectDate: spy(async () => {}),
    resetEditorState: spy(),
    closeCalendar: spy(),
    closeImport: spy(),
    closeSettings: spy(),
    renderDateLabel: spy(),
    lockAndFlush: spy(async () => {}),
    ...overrides.deps,
  };

  return {
    els,
    deps,
    invoke,
    lock: createLockScreen(deps),
    restore,
  };
}

async function withLock(body, overrides) {
  const h = harness(overrides);
  try {
    return await body(h);
  } finally {
    h.restore();
  }
}

/** A submit event that records `preventDefault()`. */
function submitEvent() {
  return {
    prevented: false,
    preventDefault() {
      this.prevented = true;
    },
  };
}

// ---------------------------------------------------------------------------
// State accessors
// ---------------------------------------------------------------------------

test("the lock screen starts unconfigured and without a vault", () => {
  withLock(({ lock }) => {
    assert.equal(lock.isConfigured(), false);
    assert.equal(lock.isVaultInitialized(), false);
  });
});

test("setConfigured and setVaultInitialized update the accessors", () => {
  withLock(({ lock }) => {
    lock.setConfigured(true);
    lock.setVaultInitialized(true);

    assert.equal(lock.isConfigured(), true);
    assert.equal(lock.isVaultInitialized(), true);
  });
});

// ---------------------------------------------------------------------------
// showLockScreen
// ---------------------------------------------------------------------------

test("showLockScreen hides the app and clears the passphrase fields", () => {
  withLock(({ lock, els }) => {
    els.app.hidden = false;
    els.lockScreen.hidden = true;
    els.passphrase.value = "typed";
    els.passphraseConfirm.value = "typed";

    lock.showLockScreen();

    assert.equal(els.app.hidden, true);
    assert.equal(els.lockScreen.hidden, false);
    assert.equal(els.passphrase.value, "");
    assert.equal(els.passphraseConfirm.value, "");
    assert.equal(document.activeElement, els.passphrase);
  });
});

test("showLockScreen displays the message it is given", () => {
  withLock(({ lock, els }) => {
    lock.showLockScreen("wrong passphrase");
    assert.equal(els.lockError.textContent, "wrong passphrase");
  });
});

test("showLockScreen clears the error when no message is given", () => {
  withLock(({ lock, els }) => {
    els.lockError.textContent = "stale";
    lock.showLockScreen();
    assert.equal(els.lockError.textContent, "");
  });
});

// ---------------------------------------------------------------------------
// KDF defaults
// ---------------------------------------------------------------------------

test("loadKdfDefaults applies the bounds and the recommended values", async () => {
  await withLock(async ({ lock, els }) => {
    await lock.loadKdfDefaults();

    assert.equal(els.kdfMemory.min, 8);
    assert.equal(els.kdfMemory.max, 1024);
    assert.equal(els.kdfIterations.min, 1);
    assert.equal(els.kdfIterations.max, 10);
    assert.equal(els.kdfParallelism.min, 1);
    assert.equal(els.kdfParallelism.max, 8);

    assert.equal(els.kdfMemory.value, 64);
    assert.equal(els.kdfIterations.value, 3);
    assert.equal(els.kdfParallelism.value, 4);
  });
});

test("loadKdfDefaults leaves the fields alone when the backend fails", async () => {
  await withLock(
    async ({ lock, els }) => {
      els.kdfMemory.value = "keep";
      await lock.loadKdfDefaults();
      assert.equal(els.kdfMemory.value, "keep");
    },
    {
      invokeTable: {
        get_kdf_defaults: () => {
          throw "nope";
        },
      },
    }
  );
});

test("resetKdfFields is a no-op before the defaults are loaded", () => {
  withLock(({ lock, els }) => {
    els.kdfMemory.value = "keep";
    lock.resetKdfFields();
    assert.equal(els.kdfMemory.value, "keep");
  });
});

test("resetKdfFields restores the recommended values", async () => {
  await withLock(async ({ lock, els }) => {
    await lock.loadKdfDefaults();
    els.kdfMemory.value = "999";

    lock.resetKdfFields();

    assert.equal(els.kdfMemory.value, 64);
  });
});

test("readKdfParams converts MiB to KiB and rounds", () => {
  withLock(({ lock, els }) => {
    els.kdfMemory.value = "64.5";
    els.kdfIterations.value = "3.4";
    els.kdfParallelism.value = "2.6";

    assert.deepEqual(lock.readKdfParams(), {
      memoryKib: 66048,
      iterations: 3,
      parallelism: 3,
    });
  });
});

test("updateKdfEstimate shows a rough unlock time", () => {
  withLock(({ lock, els }) => {
    els.kdfMemory.value = "64";
    els.kdfIterations.value = "3";

    lock.updateKdfEstimate();

    // 64 MiB * 3 iterations * 0.02 = 3.84 seconds.
    assert.equal(els.kdfEstimate.textContent, "lock.kdfEstimate(seconds=3.84)");
  });
});

test("updateKdfEstimate clears the label for non-numeric input", () => {
  withLock(({ lock, els }) => {
    els.kdfMemory.value = "abc";
    els.kdfEstimate.textContent = "stale";

    lock.updateKdfEstimate();

    assert.equal(els.kdfEstimate.textContent, "");
  });
});

// ---------------------------------------------------------------------------
// Layouts
// ---------------------------------------------------------------------------

test("renderLockScreen shows the path field on first run", () => {
  withLock(({ lock, els }) => {
    lock.setConfigured(false);
    lock.setVaultInitialized(false);

    lock.renderLockScreen();

    assert.equal(els.pathField.hidden, false);
    assert.equal(els.workspaceRow.hidden, true);
    assert.equal(els.advancedField.hidden, false);
    assert.equal(els.lockSubtitle.textContent, "lock.subtitle.firstRun");
    assert.equal(els.passphraseConfirm.hidden, false);
    assert.equal(els.passphrase.placeholder, "lock.passphraseSet");
    assert.equal(els.passphrase.autocomplete, "new-password");
    assert.equal(els.lockSubmit.textContent, "lock.submitCreate");
  });
});

test("renderLockScreen asks for a new passphrase in an empty folder", () => {
  withLock(({ lock, els }) => {
    lock.setConfigured(true);
    lock.setVaultInitialized(false);

    lock.renderLockScreen();

    assert.equal(els.pathField.hidden, true);
    assert.equal(els.workspaceRow.hidden, false);
    assert.equal(els.advancedField.hidden, false);
    assert.equal(els.lockSubtitle.textContent, "lock.subtitle.newInFolder");
    assert.equal(els.passphraseConfirm.hidden, false);
    assert.equal(els.lockSubmit.textContent, "lock.submitCreate");
  });
});

test("renderLockScreen asks only for the passphrase for a returning user", () => {
  withLock(({ lock, els }) => {
    lock.setConfigured(true);
    lock.setVaultInitialized(true);

    lock.renderLockScreen();

    assert.equal(els.pathField.hidden, true);
    assert.equal(els.workspaceRow.hidden, false);
    assert.equal(els.advancedField.hidden, true);
    assert.equal(els.lockSubtitle.textContent, "lock.subtitle.unlock");
    assert.equal(els.passphraseConfirm.hidden, true);
    assert.equal(els.passphrase.placeholder, "lock.passphrase");
    assert.equal(els.passphrase.autocomplete, "current-password");
    assert.equal(els.lockSubmit.textContent, "lock.submitUnlock");
  });
});

test("renderLockScreen uses the existing-vault subtitle when unconfigured", () => {
  withLock(({ lock, els }) => {
    lock.setConfigured(false);
    lock.setVaultInitialized(true);

    lock.renderLockScreen();

    assert.equal(els.lockSubtitle.textContent, "lock.subtitle.existing");
    assert.equal(els.pathField.hidden, false);
  });
});

test("renderLockScreen shows the path field while picking a workspace", () => {
  withLock(({ lock, els }) => {
    lock.setConfigured(true);
    lock.setVaultInitialized(true);
    lock.setPickingWorkspace(true);

    lock.renderLockScreen();

    // The picker replaces the workspace row, and the subtitle keeps saying
    // "unlock" because the app is still configured.
    assert.equal(els.pathField.hidden, false);
    assert.equal(els.workspaceRow.hidden, true);
    assert.equal(els.lockSubtitle.textContent, "lock.subtitle.unlock");
  });
});

test("renderLockScreen explains the picker when the folder has no vault", () => {
  withLock(({ lock, els }) => {
    lock.setConfigured(true);
    lock.setVaultInitialized(false);
    lock.setPickingWorkspace(true);

    lock.renderLockScreen();

    assert.equal(els.lockSubtitle.textContent, "lock.subtitle.switching");
  });
});

// ---------------------------------------------------------------------------
// enterApp hand-off
// ---------------------------------------------------------------------------
//
// The lock screen does not implement `enterApp` itself: revealing the app and
// picking today's entry belongs to `main.js`, which owns the editor state. The
// only thing to pin down here is that a successful unlock calls the injected
// callback exactly once.

test("handleUnlockSubmit hands off to deps.enterApp", async () => {
  await withLock(async ({ lock, els, deps }) => {
    lock.setConfigured(true);
    lock.setVaultInitialized(true);
    els.passphrase.value = "correct horse";

    await lock.handleUnlockSubmit(submitEvent());

    assert.equal(deps.enterApp.count(), 1);
  });
});

test("handleUnlockSubmit does not hand off when the unlock fails", async () => {
  await withLock(
    async ({ lock, els, deps }) => {
      lock.setConfigured(true);
      lock.setVaultInitialized(true);
      els.passphrase.value = "wrong";

      await lock.handleUnlockSubmit(submitEvent());

      assert.equal(deps.enterApp.count(), 0);
      assert.equal(els.lockError.textContent, "bad passphrase");
    },
    {
      invokeTable: {
        unlock: () => {
          throw "bad passphrase";
        },
      },
    }
  );
});

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

test("loadSettings stores the configured flag and the directory", async () => {
  await withLock(async ({ lock, els, deps }) => {
    const settings = await lock.loadSettings();

    assert.equal(lock.isConfigured(), true);
    assert.equal(els.diaryDir.value, "/home/u/diary");
    assert.deepEqual(deps.setAutoLockMinutes.args(), [[5]]);
    assert.equal(settings.autoLockMinutes, 5);
  });
});

test("loadSettings falls back to the default directory", async () => {
  await withLock(
    async ({ lock, els }) => {
      await lock.loadSettings();
      assert.equal(els.diaryDir.value, "/default/diary");
    },
    {
      invokeTable: {
        get_settings: { configured: false, defaultDir: "/default/diary" },
      },
    }
  );
});

test("loadSettings defaults the auto-lock to never", async () => {
  await withLock(
    async ({ lock, deps }) => {
      await lock.loadSettings();
      assert.deepEqual(deps.setAutoLockMinutes.args(), [[0]]);
    },
    { invokeTable: { get_settings: { configured: true, diaryDir: "/d" } } }
  );
});

// ---------------------------------------------------------------------------
// Vault detection
// ---------------------------------------------------------------------------

test("detectVault asks about the configured directory by default", async () => {
  await withLock(async ({ lock, invoke }) => {
    const found = await lock.detectVault();

    assert.equal(found, true);
    assert.deepEqual(invoke.argsOf("vault_exists"), {});
  });
});

test("detectVault asks about an explicit path", async () => {
  await withLock(async ({ lock, invoke }) => {
    await lock.detectVault("/some/dir");
    assert.deepEqual(invoke.argsOf("vault_exists"), { path: "/some/dir" });
  });
});

test("detectVault treats a backend failure as no vault", async () => {
  await withLock(
    async ({ lock }) => {
      assert.equal(await lock.detectVault(), false);
    },
    {
      invokeTable: {
        vault_exists: () => {
          throw "io error";
        },
      },
    }
  );
});

test("refreshVaultState stores the detection result", async () => {
  await withLock(
    async ({ lock }) => {
      await lock.refreshVaultState();
      assert.equal(lock.isVaultInitialized(), false);
    },
    { invokeTable: { vault_exists: false } }
  );
});

test("refreshSetupVaultState clears the flag for an empty path", async () => {
  await withLock(async ({ lock, els, invoke }) => {
    lock.setVaultInitialized(true);
    els.diaryDir.value = "   ";

    await lock.refreshSetupVaultState();

    assert.equal(lock.isVaultInitialized(), false);
    assert.equal(invoke.commands().includes("vault_exists"), false);
    // The layout was re-rendered for the first-run case.
    assert.equal(els.lockSubtitle.textContent, "lock.subtitle.firstRun");
  });
});

test("refreshSetupVaultState detects the vault in the typed path", async () => {
  await withLock(async ({ lock, els, invoke }) => {
    els.diaryDir.value = "/typed/dir";

    await lock.refreshSetupVaultState();

    assert.equal(lock.isVaultInitialized(), true);
    assert.deepEqual(invoke.argsOf("vault_exists"), { path: "/typed/dir" });
    assert.equal(els.lockSubtitle.textContent, "lock.subtitle.existing");
  });
});

// ---------------------------------------------------------------------------
// Unlock / create
// ---------------------------------------------------------------------------

test("handleUnlockSubmit prevents the default form submission", async () => {
  await withLock(async ({ lock }) => {
    const event = submitEvent();
    await lock.handleUnlockSubmit(event);
    assert.equal(event.prevented, true);
  });
});

test("handleUnlockSubmit rejects an empty passphrase", async () => {
  await withLock(async ({ lock, els, invoke }) => {
    lock.setConfigured(true);
    lock.setVaultInitialized(true);
    els.passphrase.value = "";

    await lock.handleUnlockSubmit(submitEvent());

    assert.equal(els.lockError.textContent, "lock.errNoPassphrase");
    assert.deepEqual(invoke.commands(), []);
  });
});

test("handleUnlockSubmit rejects a too-short new passphrase", async () => {
  await withLock(async ({ lock, els, invoke }) => {
    lock.setConfigured(true);
    lock.setVaultInitialized(false);
    els.passphrase.value = "short";
    els.passphraseConfirm.value = "short";

    await lock.handleUnlockSubmit(submitEvent());

    assert.equal(els.lockError.textContent, "lock.errTooShort");
    assert.deepEqual(invoke.commands(), []);
  });
});

test("handleUnlockSubmit rejects a mismatched confirmation", async () => {
  await withLock(async ({ lock, els, invoke }) => {
    lock.setConfigured(true);
    lock.setVaultInitialized(false);
    els.passphrase.value = "longenough";
    els.passphraseConfirm.value = "different";

    await lock.handleUnlockSubmit(submitEvent());

    assert.equal(els.lockError.textContent, "lock.errMismatch");
    assert.deepEqual(invoke.commands(), []);
  });
});

test("handleUnlockSubmit unlocks an existing vault", async () => {
  await withLock(async ({ lock, els, invoke, deps }) => {
    lock.setConfigured(true);
    lock.setVaultInitialized(true);
    els.passphrase.value = "correct horse";

    await lock.handleUnlockSubmit(submitEvent());

    assert.deepEqual(invoke.argsOf("unlock"), { passphrase: "correct horse" });
    assert.equal(invoke.commands().includes("create_vault"), false);
    // The hand-off into the editor is `main.js`'s job, injected as a dep.
    assert.equal(deps.enterApp.count(), 1);
    assert.equal(els.lockSubmit.disabled, false);
  });
});

test("handleUnlockSubmit creates a vault in a configured empty folder", async () => {
  await withLock(async ({ lock, els, invoke, deps }) => {
    lock.setConfigured(true);
    lock.setVaultInitialized(false);
    els.passphrase.value = "longenough";
    els.passphraseConfirm.value = "longenough";
    els.kdfMemory.value = "64";
    els.kdfIterations.value = "3";
    els.kdfParallelism.value = "4";

    await lock.handleUnlockSubmit(submitEvent());

    assert.deepEqual(invoke.argsOf("create_vault"), {
      passphrase: "longenough",
      kdf: { memoryKib: 65536, iterations: 3, parallelism: 4 },
    });
    assert.equal(lock.isVaultInitialized(), true);
    assert.equal(deps.enterApp.count(), 1);
  });
});

test("handleUnlockSubmit stores the directory on first run", async () => {
  await withLock(async ({ lock, els, invoke }) => {
    lock.setConfigured(false);
    lock.setVaultInitialized(false);
    els.diaryDir.value = "/new/diary";
    els.passphrase.value = "longenough";
    els.passphraseConfirm.value = "longenough";

    await lock.handleUnlockSubmit(submitEvent());

    assert.deepEqual(invoke.argsOf("set_diary_dir"), { path: "/new/diary" });
    assert.equal(lock.isConfigured(), true);
  });
});

test("handleUnlockSubmit requires a directory on first run", async () => {
  await withLock(async ({ lock, els, invoke }) => {
    lock.setConfigured(false);
    lock.setVaultInitialized(false);
    els.diaryDir.value = "  ";
    els.passphrase.value = "longenough";
    els.passphraseConfirm.value = "longenough";

    await lock.handleUnlockSubmit(submitEvent());

    assert.equal(els.lockError.textContent, "lock.errNoDir");
    assert.equal(invoke.commands().includes("set_diary_dir"), false);
  });
});

test("handleUnlockSubmit re-detects the vault before creating one", async () => {
  await withLock(
    async ({ lock, els, invoke }) => {
      lock.setConfigured(false);
      lock.setVaultInitialized(false);
      els.diaryDir.value = "/existing/diary";
      els.passphrase.value = "longenough";
      els.passphraseConfirm.value = "longenough";

      await lock.handleUnlockSubmit(submitEvent());

      // The folder turned out to hold a vault, so it unlocks instead.
      assert.equal(invoke.commands().includes("create_vault"), false);
      assert.deepEqual(invoke.argsOf("unlock"), { passphrase: "longenough" });
    },
    { invokeTable: { vault_exists: true } }
  );
});

test("handleUnlockSubmit rejects non-numeric KDF parameters", async () => {
  await withLock(async ({ lock, els, invoke }) => {
    lock.setConfigured(true);
    lock.setVaultInitialized(false);
    els.passphrase.value = "longenough";
    els.passphraseConfirm.value = "longenough";
    els.kdfMemory.value = "abc";

    await lock.handleUnlockSubmit(submitEvent());

    assert.equal(els.lockError.textContent, "lock.errKdfNaN");
    assert.equal(invoke.commands().includes("create_vault"), false);
  });
});

test("handleUnlockSubmit shows a string error from the backend", async () => {
  await withLock(
    async ({ lock, els }) => {
      lock.setConfigured(true);
      lock.setVaultInitialized(true);
      els.passphrase.value = "wrong";

      await lock.handleUnlockSubmit(submitEvent());

      assert.equal(els.lockError.textContent, "bad passphrase");
      assert.equal(els.passphrase.selectedText, true);
      assert.equal(els.lockSubmit.disabled, false);
    },
    {
      invokeTable: {
        unlock: () => {
          throw "bad passphrase";
        },
      },
    }
  );
});

test("handleUnlockSubmit uses a generic message for a non-string error", async () => {
  await withLock(
    async ({ lock, els }) => {
      lock.setConfigured(true);
      lock.setVaultInitialized(true);
      els.passphrase.value = "wrong";

      await lock.handleUnlockSubmit(submitEvent());

      assert.equal(els.lockError.textContent, "lock.errUnlockFailed");
    },
    {
      invokeTable: {
        unlock: () => {
          throw new Error("boom");
        },
      },
    }
  );
});

test("handleUnlockSubmit disables the button while it runs", async () => {
  await withLock(async ({ lock, els }) => {
    lock.setConfigured(true);
    lock.setVaultInitialized(true);
    els.passphrase.value = "correct horse";
    let disabledDuring = null;

    const invoke = fakeInvoke({
      unlock: () => {
        disabledDuring = els.lockSubmit.disabled;
        return null;
      },
    });
    const local = createLockScreen({ ...lockDeps(els), invoke });

    local.setConfigured(true);
    local.setVaultInitialized(true);
    await local.handleUnlockSubmit(submitEvent());

    assert.equal(disabledDuring, true);
    assert.equal(els.lockSubmit.disabled, false);
  });
});

// ---------------------------------------------------------------------------
// Browsing for a directory
// ---------------------------------------------------------------------------

test("browseForDir stores the picked path and re-detects the vault", async () => {
  await withLock(async ({ lock, els, invoke }) => {
    await lock.browseForDir();

    assert.equal(els.diaryDir.value, "/home/u/other");
    assert.deepEqual(invoke.argsOf("vault_exists"), { path: "/home/u/other" });
  });
});

test("browseForDir does nothing when the picker is cancelled", async () => {
  await withLock(
    async ({ lock, els }) => {
      els.diaryDir.value = "unchanged";
      await lock.browseForDir();
      assert.equal(els.diaryDir.value, "unchanged");
    },
    { invokeTable: { pick_diary_dir: null } }
  );
});

test("browseForDir reports a picker failure", async () => {
  await withLock(
    async ({ lock, els }) => {
      await lock.browseForDir();
      assert.equal(els.lockError.textContent, "lock.errPicker");
    },
    {
      invokeTable: {
        pick_diary_dir: () => {
          throw "no picker";
        },
      },
    }
  );
});

// ---------------------------------------------------------------------------
// Changing the directory
// ---------------------------------------------------------------------------

test("changeDiaryDir flushes, resets the editor and shows the path field", async () => {
  await withLock(async ({ lock, els, deps }) => {
    lock.setConfigured(true);
    lock.setVaultInitialized(true);

    await lock.changeDiaryDir();

    assert.equal(deps.lockAndFlush.count(), 1);
    assert.equal(deps.resetEditorState.count(), 1);
    assert.equal(deps.closeCalendar.count(), 1);
    assert.equal(deps.closeImport.count(), 1);
    assert.equal(deps.closeSettings.count(), 1);
    assert.equal(deps.renderDateLabel.count(), 1);
    assert.equal(deps.stopAutoLockTimer.count(), 1);

    // The app stays configured: only the picker is open, so the subtitle still
    // reads "unlock" rather than "first run".
    assert.equal(lock.isConfigured(), true);
    assert.equal(lock.isPickingWorkspace(), true);
    assert.equal(els.pathField.hidden, false);
    assert.equal(els.lockScreen.hidden, false);
    assert.equal(document.activeElement, els.diaryDir);
  });
});

test("changeDiaryDir keeps the vault flag so an existing diary unlocks", async () => {
  await withLock(async ({ lock, els }) => {
    lock.setConfigured(true);
    lock.setVaultInitialized(true);
    // The path field still holds the current folder, which does have a vault.
    els.diaryDir.value = "/home/u/diary";

    await lock.changeDiaryDir();

    // The folder the user lands on already holds a vault.
    assert.equal(lock.isVaultInitialized(), true);
    assert.equal(els.lockSubtitle.textContent, "lock.subtitle.unlock");
  });
});

// ---------------------------------------------------------------------------
// Switching workspace from the lock screen
// ---------------------------------------------------------------------------

test("openWorkspacePicker reveals the path field without unlocking", async () => {
  await withLock(async ({ lock, els }) => {
    lock.setConfigured(true);
    lock.setVaultInitialized(true);
    els.diaryDir.value = "/home/u/diary";

    await lock.openWorkspacePicker();

    assert.equal(lock.isPickingWorkspace(), true);
    assert.equal(els.pathField.hidden, false);
    assert.equal(els.workspaceRow.hidden, true);
    assert.equal(document.activeElement, els.diaryDir);
  });
});

test("openWorkspacePicker switches to the unlock form for an existing vault", async () => {
  await withLock(async ({ lock, els }) => {
    lock.setConfigured(true);
    lock.setVaultInitialized(false);
    els.diaryDir.value = "/home/u/other";

    await lock.openWorkspacePicker();

    // `vault_exists` is true in the fake backend, so the form asks for the
    // passphrase of the folder the user pointed at.
    assert.equal(lock.isVaultInitialized(), true);
    assert.equal(els.lockSubtitle.textContent, "lock.subtitle.unlock");
    assert.equal(els.passphraseConfirm.hidden, true);
    assert.equal(els.lockSubmit.textContent, "lock.submitUnlock");
  });
});

test("openWorkspacePicker offers to create a vault in an empty folder", async () => {
  await withLock(
    async ({ lock, els }) => {
      lock.setConfigured(true);
      lock.setVaultInitialized(true);
      els.diaryDir.value = "/home/u/empty";

      await lock.openWorkspacePicker();

      assert.equal(lock.isVaultInitialized(), false);
      assert.equal(els.lockSubtitle.textContent, "lock.subtitle.switching");
      assert.equal(els.passphraseConfirm.hidden, false);
      assert.equal(els.lockSubmit.textContent, "lock.submitCreate");
    },
    { invokeTable: { vault_exists: false } }
  );
});

test("cancelWorkspacePicker restores the saved folder and closes the picker", async () => {
  await withLock(async ({ lock, els }) => {
    lock.setConfigured(true);
    lock.setVaultInitialized(true);
    lock.setPickingWorkspace(true);
    els.diaryDir.value = "/home/u/half-typed";

    await lock.cancelWorkspacePicker();

    assert.equal(lock.isPickingWorkspace(), false);
    assert.equal(els.diaryDir.value, "/home/u/diary");
    assert.equal(els.pathField.hidden, true);
    assert.equal(els.workspaceRow.hidden, false);
    assert.equal(document.activeElement, els.passphrase);
  });
});

test("cancelWorkspacePicker does nothing on first run", async () => {
  await withLock(async ({ lock, els }) => {
    lock.setConfigured(false);
    els.diaryDir.value = "/typed";

    await lock.cancelWorkspacePicker();

    // The picker cannot be cancelled when there is no saved folder to go back
    // to, so the typed path is left alone.
    assert.equal(els.diaryDir.value, "/typed");
  });
});

test("handleUnlockSubmit persists the folder chosen in the picker", async () => {
  await withLock(async ({ lock, els, invoke }) => {
    lock.setConfigured(true);
    lock.setVaultInitialized(true);
    lock.setPickingWorkspace(true);
    els.diaryDir.value = "/home/u/other";
    els.passphrase.value = "correct horse";

    await lock.handleUnlockSubmit(submitEvent());

    assert.deepEqual(invoke.argsOf("set_diary_dir"), { path: "/home/u/other" });
    assert.deepEqual(invoke.argsOf("unlock"), { passphrase: "correct horse" });
    assert.equal(lock.isPickingWorkspace(), false);
    assert.equal(els.workspacePath.textContent, "/home/u/other");
  });
});

test("handleUnlockSubmit does not touch the settings when no picker is open", async () => {
  await withLock(async ({ lock, els, invoke }) => {
    lock.setConfigured(true);
    lock.setVaultInitialized(true);
    els.passphrase.value = "correct horse";

    await lock.handleUnlockSubmit(submitEvent());

    assert.equal(invoke.commands().includes("set_diary_dir"), false);
    assert.deepEqual(invoke.argsOf("unlock"), { passphrase: "correct horse" });
  });
});

// ---------------------------------------------------------------------------
// Locking
// ---------------------------------------------------------------------------

test("lockNow flushes, resets the editor and returns to the unlock form", async () => {
  await withLock(async ({ lock, els, deps }) => {
    lock.setConfigured(true);
    lock.setVaultInitialized(true);

    await lock.lockNow();

    assert.equal(deps.lockAndFlush.count(), 1);
    assert.equal(deps.resetEditorState.count(), 1);
    assert.equal(deps.stopAutoLockTimer.count(), 1);
    assert.equal(deps.closeSettings.count(), 1);
    assert.equal(deps.renderDateLabel.count(), 1);

    assert.equal(els.lockScreen.hidden, false);
    assert.equal(els.app.hidden, true);
    // Still configured, so the form asks for the passphrase rather than
    // offering to create a new vault.
    assert.equal(lock.isConfigured(), true);
    assert.equal(els.lockSubtitle.textContent, "lock.subtitle.unlock");
  });
});

test("lockNow re-detects the vault before rendering", async () => {
  await withLock(
    async ({ lock, els }) => {
      lock.setConfigured(true);
      lock.setVaultInitialized(true);

      await lock.lockNow();

      // The folder no longer holds a vault, so the layout follows.
      assert.equal(lock.isVaultInitialized(), false);
      assert.equal(els.lockSubtitle.textContent, "lock.subtitle.newInFolder");
    },
    { invokeTable: { vault_exists: false } }
  );
});

test("lockNow does not close the calendar twice", async () => {
  await withLock(async ({ lock, deps }) => {
    lock.setConfigured(true);
    lock.setVaultInitialized(true);

    await lock.lockNow();

    assert.equal(deps.closeCalendar.count(), 1);
    assert.equal(deps.closeImport.count(), 1);
  });
});

/** Shared deps for the tests that build a second controller. */
function lockDeps(els) {
  return {
    els,
    t: fakeT(),
    setAutoLockMinutes: spy(),
    enterApp: spy(async () => {}),
    resetAutoLockTimer: spy(),
    stopAutoLockTimer: spy(),
    refreshList: spy(async () => {}),
    selectDate: spy(async () => {}),
    resetEditorState: spy(),
    closeCalendar: spy(),
    closeImport: spy(),
    closeSettings: spy(),
    renderDateLabel: spy(),
    lockAndFlush: spy(async () => {}),
  };
}
