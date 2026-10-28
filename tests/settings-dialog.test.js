// ---------------------------------------------------------------------------
// Settings dialog tests
// ---------------------------------------------------------------------------
//
// The dialog has two independent jobs — the auto-lock duration and the
// passphrase change — and the tests are grouped the same way. The interesting
// cases are the validation branches in `saveSettings`, because a wrong branch
// there either silently drops a passphrase change or sends a half-filled one to
// the backend.

import test from "node:test";
import assert from "node:assert/strict";

import { createSettingsDialog } from "../src/settings-dialog.js";
import {
  installDom,
  fakeEls,
  fakeT,
  fakeInvoke,
  spy,
} from "./helpers/dom.js";

const SETTINGS_IDS = [
  "settingsOverlay",
  "settingsError",
  "settingsCalibrateNote",
  "settingsCurrentPass",
  "settingsNewPass",
  "settingsNewPassConfirm",
  "settingsSave",
  "settingsCalibrate",
  "autoLockSelect",
  "autosaveDelaySelect",
  "vaultKdf",
  "settingsKdfMemory",
  "settingsKdfIterations",
  "settingsKdfParallelism",
];

/** The KDF parameters the fake backend reports. */
const KDF = { memoryKib: 65536, iterations: 3, parallelism: 4 };

/** Build a settings controller plus the fakes it needs. */
function harness(overrides = {}) {
  const restore = installDom();
  const els = fakeEls(SETTINGS_IDS);
  els.settingsOverlay.hidden = true;

  const invoke = fakeInvoke({
    get_settings: {
      autoLockChoices: [0, 5, 15],
      autoLockMinutes: 5,
      autosaveDelayChoices: [200, 800, 3000],
      autosaveDelayMs: 800,
    },
    get_vault_kdf: KDF,
    set_auto_lock: null,
    set_autosave_delay: null,
    change_passphrase: null,
    calibrate_kdf: { memoryKib: 131072, iterations: 4, parallelism: 2 },
    ...(overrides.invokeTable ?? {}),
  });

  const deps = {
    els,
    invoke,
    t: fakeT(),
    setStatus: spy(),
    setAutoLockMinutes: spy(),
    setAutosaveDelay: spy(),
    ...overrides.deps,
  };

  return {
    els,
    deps,
    invoke,
    settings: createSettingsDialog(deps),
    restore,
  };
}

/**
 * Run `body` with a fresh harness, always restoring the DOM globals.
 *
 * Awaiting the body before restoring matters: the async tests would otherwise
 * tear the DOM down while `openSettings`/`saveSettings` are still in flight.
 */
async function withSettings(body, overrides) {
  const h = harness(overrides);
  try {
    return await body(h);
  } finally {
    h.restore();
  }
}

// ---------------------------------------------------------------------------
// Open / close
// ---------------------------------------------------------------------------

test("isSettingsOpen reflects the overlay's hidden flag", () => {
  withSettings(({ settings, els }) => {
    els.settingsOverlay.hidden = true;
    assert.equal(settings.isSettingsOpen(), false);

    els.settingsOverlay.hidden = false;
    assert.equal(settings.isSettingsOpen(), true);
  });
});

test("openSettings loads the choices, the vault KDF and shows the dialog", async () => {
  await withSettings(async ({ settings, els }) => {
    await settings.openSettings();

    assert.equal(els.settingsOverlay.hidden, false);
    assert.equal(document.activeElement, els.settingsCurrentPass);
    assert.deepEqual(
      els.autoLockSelect.children.map((option) => option.value),
      ["0", "5", "15"]
    );
    assert.deepEqual(
      els.autosaveDelaySelect.children.map((option) => option.value),
      ["200", "800", "3000"]
    );
    assert.equal(
      els.vaultKdf.textContent,
      "settings.vaultKdf(memory=64,iterations=3,parallelism=4)"
    );
  });
});

test("openSettings selects the current autosave delay", async () => {
  await withSettings(async ({ settings, els }) => {
    await settings.openSettings();

    const selected = els.autosaveDelaySelect.children.filter((o) => o.selected);
    assert.equal(selected.length, 1);
    assert.equal(selected[0].value, "800");
  });
});

test("openSettings falls back to the default autosave delays", async () => {
  await withSettings(
    async ({ settings, els }) => {
      await settings.openSettings();

      assert.deepEqual(
        els.autosaveDelaySelect.children.map((option) => option.value),
        ["200", "400", "800", "1500", "3000"]
      );
      // The default delay is the one the fallback list marks as current.
      const selected = els.autosaveDelaySelect.children.filter((o) => o.selected);
      assert.equal(selected.length, 1);
      assert.equal(selected[0].value, "800");
    },
    { invokeTable: { get_settings: { autoLockMinutes: 0 } } }
  );
});

test("openSettings selects the current auto-lock value", async () => {
  await withSettings(async ({ settings, els }) => {
    await settings.openSettings();

    const selected = els.autoLockSelect.children.filter((o) => o.selected);
    assert.equal(selected.length, 1);
    assert.equal(selected[0].value, "5");
  });
});

test("openSettings clears the passphrase fields and messages", async () => {
  await withSettings(async ({ settings, els }) => {
    els.settingsCurrentPass.value = "old";
    els.settingsNewPass.value = "new";
    els.settingsNewPassConfirm.value = "new";
    els.settingsError.textContent = "stale";
    els.settingsCalibrateNote.textContent = "stale";

    await settings.openSettings();

    assert.equal(els.settingsCurrentPass.value, "");
    assert.equal(els.settingsNewPass.value, "");
    assert.equal(els.settingsNewPassConfirm.value, "");
    assert.equal(els.settingsError.textContent, "");
    assert.equal(els.settingsCalibrateNote.textContent, "");
  });
});

test("openSettings falls back to the default choices when none are reported", async () => {
  await withSettings(
    async ({ settings, els }) => {
      await settings.openSettings();

      assert.deepEqual(
        els.autoLockSelect.children.map((option) => option.value),
        ["0", "1", "5", "10", "15", "30", "60"]
      );
    },
    { invokeTable: { get_settings: { autoLockMinutes: 0 } } }
  );
});

test("openSettings reports a load failure but still opens", async () => {
  await withSettings(
    async ({ settings, els }) => {
      await settings.openSettings();

      assert.equal(els.settingsOverlay.hidden, false);
      assert.equal(
        els.settingsError.textContent,
        "settings.errSave(message=boom)"
      );
    },
    {
      invokeTable: {
        get_settings: () => {
          throw "boom";
        },
      },
    }
  );
});

test("closeSettings hides the dialog and wipes the passphrase fields", () => {
  withSettings(({ settings, els }) => {
    els.settingsOverlay.hidden = false;
    els.settingsCurrentPass.value = "secret";
    els.settingsNewPass.value = "secret2";
    els.settingsNewPassConfirm.value = "secret2";
    els.settingsError.textContent = "oops";

    settings.closeSettings();

    assert.equal(els.settingsOverlay.hidden, true);
    assert.equal(els.settingsCurrentPass.value, "");
    assert.equal(els.settingsNewPass.value, "");
    assert.equal(els.settingsNewPassConfirm.value, "");
    assert.equal(els.settingsError.textContent, "");
  });
});

// ---------------------------------------------------------------------------
// Auto-lock choices
// ---------------------------------------------------------------------------

test("renderAutoLockChoices labels zero as Never", () => {
  withSettings(({ settings, els }) => {
    settings.renderAutoLockChoices([0, 5], 0);

    assert.equal(els.autoLockSelect.children[0].textContent, "settings.autoLockNever");
    assert.equal(
      els.autoLockSelect.children[1].textContent,
      "settings.autoLockMinutes(n=5)"
    );
  });
});

test("renderAutoLockChoices replaces the previous options", () => {
  withSettings(({ settings, els }) => {
    settings.renderAutoLockChoices([0, 5, 15], 5);
    settings.renderAutoLockChoices([0], 0);

    assert.equal(els.autoLockSelect.children.length, 1);
  });
});

test("renderAutosaveChoices labels each option in milliseconds", () => {
  withSettings(({ settings, els }) => {
    settings.renderAutosaveChoices([200, 800], 200);

    assert.equal(
      els.autosaveDelaySelect.children[0].textContent,
      "settings.autosaveMs(n=200)"
    );
    assert.equal(
      els.autosaveDelaySelect.children[1].textContent,
      "settings.autosaveMs(n=800)"
    );
    assert.equal(els.autosaveDelaySelect.children[0].selected, true);
    assert.equal(els.autosaveDelaySelect.children[1].selected, false);
  });
});

test("renderAutosaveChoices replaces the previous options", () => {
  withSettings(({ settings, els }) => {
    settings.renderAutosaveChoices([200, 800, 3000], 800);
    settings.renderAutosaveChoices([200], 200);

    assert.equal(els.autosaveDelaySelect.children.length, 1);
  });
});

// ---------------------------------------------------------------------------
// Vault KDF display
// ---------------------------------------------------------------------------

test("renderVaultKdf converts KiB to MiB", () => {
  withSettings(({ settings, els }) => {
    settings.renderVaultKdf({ memoryKib: 262144, iterations: 2, parallelism: 1 });
    assert.equal(
      els.vaultKdf.textContent,
      "settings.vaultKdf(memory=256,iterations=2,parallelism=1)"
    );
  });
});

test("renderVaultKdf reports a legacy vault when there are no parameters", () => {
  withSettings(({ settings, els }) => {
    settings.renderVaultKdf(null);
    assert.equal(els.vaultKdf.textContent, "settings.vaultKdfLegacy");
  });
});

test("fillSettingsKdf copies the parameters into the advanced inputs", () => {
  withSettings(({ settings, els }) => {
    settings.fillSettingsKdf(KDF);

    assert.equal(els.settingsKdfMemory.value, 64);
    assert.equal(els.settingsKdfIterations.value, 3);
    assert.equal(els.settingsKdfParallelism.value, 4);
  });
});

test("fillSettingsKdf leaves the inputs alone without parameters", () => {
  withSettings(({ settings, els }) => {
    els.settingsKdfMemory.value = "keep";
    settings.fillSettingsKdf(null);
    assert.equal(els.settingsKdfMemory.value, "keep");
  });
});

test("readSettingsKdf converts MiB back to KiB", () => {
  withSettings(({ settings, els }) => {
    els.settingsKdfMemory.value = "128";
    els.settingsKdfIterations.value = "5";
    els.settingsKdfParallelism.value = "2";

    assert.deepEqual(settings.readSettingsKdf(), {
      memoryKib: 131072,
      iterations: 5,
      parallelism: 2,
    });
  });
});

// ---------------------------------------------------------------------------
// Calibration
// ---------------------------------------------------------------------------

test("calibrateKdf fills the inputs and reports the result", async () => {
  await withSettings(async ({ settings, els }) => {
    await settings.calibrateKdf();

    assert.equal(els.settingsKdfMemory.value, 128);
    assert.equal(els.settingsKdfIterations.value, 4);
    assert.equal(els.settingsKdfParallelism.value, 2);
    assert.equal(
      els.settingsCalibrateNote.textContent,
      "settings.calibrated(memory=128,iterations=4,parallelism=2)"
    );
    assert.equal(els.settingsCalibrate.disabled, false);
  });
});

test("calibrateKdf disables the button while it runs", async () => {
  await withSettings(async ({ settings, els }) => {
    let disabledDuring = null;
    const invoke = fakeInvoke({
      calibrate_kdf: () => {
        disabledDuring = els.settingsCalibrate.disabled;
        return { memoryKib: 65536, iterations: 3, parallelism: 1 };
      },
    });
    const local = createSettingsDialog({ ...settingsDeps(els), invoke });

    await local.calibrateKdf();

    assert.equal(disabledDuring, true);
    assert.equal(els.settingsCalibrate.disabled, false);
  });
});

test("calibrateKdf reports a failure and re-enables the button", async () => {
  await withSettings(
    async ({ settings, els }) => {
      await settings.calibrateKdf();

      assert.equal(
        els.settingsError.textContent,
        "settings.errCalibrate(message=nope)"
      );
      assert.equal(els.settingsCalibrateNote.textContent, "");
      assert.equal(els.settingsCalibrate.disabled, false);
    },
    {
      invokeTable: {
        calibrate_kdf: () => {
          throw "nope";
        },
      },
    }
  );
});

// ---------------------------------------------------------------------------
// Saving
// ---------------------------------------------------------------------------

test("saveSettings writes the auto-lock value and closes", async () => {
  await withSettings(async ({ settings, els, invoke, deps }) => {
    els.settingsOverlay.hidden = false;
    els.autoLockSelect.value = "15";
    els.autosaveDelaySelect.value = "800";

    await settings.saveSettings();

    assert.equal(invoke.argsOf("set_auto_lock").minutes, 15);
    assert.deepEqual(deps.setAutoLockMinutes.args(), [[15]]);
    assert.equal(els.settingsOverlay.hidden, true);
    assert.deepEqual(deps.setStatus.args(), [["settings.saved", true]]);
    // No passphrase change was requested.
    assert.equal(invoke.commands().includes("change_passphrase"), false);
  });
});

test("saveSettings writes the autosave delay and applies it", async () => {
  await withSettings(async ({ settings, els, invoke, deps }) => {
    els.settingsOverlay.hidden = false;
    els.autoLockSelect.value = "5";
    els.autosaveDelaySelect.value = "3000";

    await settings.saveSettings();

    assert.equal(invoke.argsOf("set_autosave_delay").ms, 3000);
    assert.deepEqual(deps.setAutosaveDelay.args(), [[3000]]);
    assert.equal(els.settingsOverlay.hidden, true);
  });
});

test("saveSettings writes both timing values before the passphrase", async () => {
  await withSettings(async ({ settings, els, invoke }) => {
    els.autoLockSelect.value = "15";
    els.autosaveDelaySelect.value = "200";
    els.settingsCurrentPass.value = "old";
    els.settingsNewPass.value = "newpass";
    els.settingsNewPassConfirm.value = "newpass";

    await settings.saveSettings();

    assert.deepEqual(invoke.commands(), [
      "set_auto_lock",
      "set_autosave_delay",
      "change_passphrase",
    ]);
  });
});

test("saveSettings requires the current passphrase before changing it", async () => {
  await withSettings(async ({ settings, els, invoke }) => {
    els.autoLockSelect.value = "5";
    els.autosaveDelaySelect.value = "800";
    els.settingsNewPass.value = "newpass";
    els.settingsNewPassConfirm.value = "newpass";

    await settings.saveSettings();

    assert.equal(els.settingsError.textContent, "settings.errCurrentRequired");
    // Nothing was written.
    assert.deepEqual(invoke.commands(), []);
  });
});

test("saveSettings rejects a mismatched confirmation", async () => {
  await withSettings(async ({ settings, els, invoke }) => {
    els.settingsCurrentPass.value = "old";
    els.settingsNewPass.value = "newpass";
    els.settingsNewPassConfirm.value = "different";

    await settings.saveSettings();

    assert.equal(els.settingsError.textContent, "settings.errMismatch");
    assert.deepEqual(invoke.commands(), []);
  });
});

test("saveSettings changes the passphrase with the advanced KDF", async () => {
  await withSettings(async ({ settings, els, invoke }) => {
    els.autoLockSelect.value = "5";
    els.autosaveDelaySelect.value = "800";
    els.settingsCurrentPass.value = "old";
    els.settingsNewPass.value = "newpass";
    els.settingsNewPassConfirm.value = "newpass";
    els.settingsKdfMemory.value = "64";
    els.settingsKdfIterations.value = "3";
    els.settingsKdfParallelism.value = "4";

    await settings.saveSettings();

    assert.deepEqual(invoke.argsOf("change_passphrase"), {
      currentPassphrase: "old",
      newPassphrase: "newpass",
      kdf: { memoryKib: 65536, iterations: 3, parallelism: 4 },
    });
    // The dialog now shows the parameters it just sent.
    assert.equal(
      els.vaultKdf.textContent,
      "settings.vaultKdf(memory=64,iterations=3,parallelism=4)"
    );
  });
});

test("saveSettings rejects non-numeric KDF parameters", async () => {
  await withSettings(async ({ settings, els, invoke }) => {
    els.autoLockSelect.value = "5";
    els.autosaveDelaySelect.value = "800";
    els.settingsCurrentPass.value = "old";
    els.settingsNewPass.value = "newpass";
    els.settingsNewPassConfirm.value = "newpass";
    els.settingsKdfMemory.value = "abc";

    await settings.saveSettings();

    assert.equal(els.settingsError.textContent, "lock.errKdfNaN");
    // Both timing values were already written, but the passphrase was not.
    assert.deepEqual(invoke.commands(), ["set_auto_lock", "set_autosave_delay"]);
  });
});

test("saveSettings reports a backend failure and keeps the dialog open", async () => {
  await withSettings(
    async ({ settings, els }) => {
      els.settingsOverlay.hidden = false;
      els.autoLockSelect.value = "5";
      els.autosaveDelaySelect.value = "800";

      await settings.saveSettings();

      assert.equal(els.settingsOverlay.hidden, false);
      assert.equal(
        els.settingsError.textContent,
        "settings.errSave(message=disk full)"
      );
      assert.equal(els.settingsSave.disabled, false);
    },
    {
      invokeTable: {
        set_auto_lock: () => {
          throw "disk full";
        },
      },
    }
  );
});

test("saveSettings re-enables the save button after a failure", async () => {
  await withSettings(
    async ({ settings, els }) => {
      await settings.saveSettings();
      assert.equal(els.settingsSave.disabled, false);
    },
    {
      invokeTable: {
        set_auto_lock: () => {
          throw "nope";
        },
      },
    }
  );
});

/** Shared deps for the tests that build a second controller. */
function settingsDeps(els) {
  return {
    els,
    t: fakeT(),
    setStatus: spy(),
    setAutoLockMinutes: spy(),
    setAutosaveDelay: spy(),
  };
}
