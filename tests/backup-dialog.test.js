// ---------------------------------------------------------------------------
// Encrypted tar import dialog tests
// ---------------------------------------------------------------------------

import test from "node:test";
import assert from "node:assert/strict";

import { createBackupImportDialog } from "../src/backup-dialog.js";
import {
  installDom,
  fakeEls,
  fakeT,
  fakeInvoke,
  spy,
} from "./helpers/dom.js";

const IDS = [
  "backupImportOverlay",
  "backupImportClose",
  "backupImportCancel",
  "backupImportConfirm",
  "backupImportPass",
  "backupImportStatus",
  "backupImportError",
];

function harness(overrides = {}) {
  const restore = installDom();
  const els = fakeEls(IDS);
  els.backupImportOverlay.hidden = true;

  const invoke = fakeInvoke({
    vault_exists: false,
    import_backup: { files: 2, attachments: 1 },
    ...(overrides.invokeTable ?? {}),
  });

  const deps = {
    els,
    invoke,
    t: fakeT(),
    onImported: spy(),
    onClosed: spy(),
    beginNativePicker: spy(),
    endNativePicker: spy(),
    confirm: () => true,
    ...overrides.deps,
  };

  return {
    els,
    deps,
    invoke,
    dialog: createBackupImportDialog(deps),
    restore,
  };
}

async function withDialog(body, overrides) {
  const h = harness(overrides);
  try {
    return await body(h);
  } finally {
    h.restore();
  }
}

test("open shows the dialog, clears secrets and focuses the passphrase", () => {
  withDialog(({ dialog, els }) => {
    els.backupImportPass.value = "stale";
    els.backupImportError.textContent = "stale";

    dialog.open({ targetDir: "/tmp/diary" });

    assert.equal(dialog.isOpen(), true);
    assert.equal(els.backupImportOverlay.hidden, false);
    assert.equal(els.backupImportPass.value, "");
    assert.equal(els.backupImportError.textContent, "");
    assert.equal(document.activeElement, els.backupImportPass);
  });
});

test("submit requires the backup passphrase", async () => {
  await withDialog(async ({ dialog, els, invoke }) => {
    dialog.open();
    await dialog.submit();

    assert.equal(els.backupImportError.textContent, "backup.importPassRequired");
    assert.deepEqual(invoke.commands(), []);
  });
});

test("submit imports with the entered passphrase and closes on success", async () => {
  await withDialog(async ({ dialog, els, invoke, deps }) => {
    dialog.open({ targetDir: "/tmp/diary" });
    els.backupImportPass.value = "backup-passphrase";

    await dialog.submit();

    assert.deepEqual(invoke.argsOf("import_backup"), {
      passphrase: "backup-passphrase",
      targetDir: "/tmp/diary",
      overwrite: false,
    });
    assert.deepEqual(deps.beginNativePicker.args(), [[]]);
    assert.deepEqual(deps.endNativePicker.args(), [[]]);
    assert.deepEqual(deps.onImported.args(), [
      [{ files: 2, attachments: 1 }],
    ]);
    // A successful import must not reopen settings via `onClosed`.
    assert.deepEqual(deps.onClosed.args(), []);
    assert.equal(els.backupImportOverlay.hidden, true);
    assert.equal(els.backupImportPass.value, "");
  });
});

test("submit asks before replacing an existing vault", async () => {
  await withDialog(
    async ({ dialog, els, invoke, deps }) => {
      dialog.open();
      els.backupImportPass.value = "backup-passphrase";

      await dialog.submit();

      assert.deepEqual(invoke.argsOf("import_backup"), {
        passphrase: "backup-passphrase",
        targetDir: null,
        overwrite: true,
      });
      assert.deepEqual(deps.onImported.args(), [
        [{ files: 2, attachments: 1 }],
      ]);
    },
    {
      invokeTable: { vault_exists: true },
      deps: { confirm: () => true },
    }
  );
});

test("submit does nothing when the replacement confirmation is declined", async () => {
  await withDialog(
    async ({ dialog, els, invoke }) => {
      dialog.open();
      els.backupImportPass.value = "backup-passphrase";

      await dialog.submit();

      assert.deepEqual(invoke.commands(), ["vault_exists"]);
    },
    {
      invokeTable: { vault_exists: true },
      deps: { confirm: () => false },
    }
  );
});

test("cancelling the file picker leaves the dialog open", async () => {
  await withDialog(
    async ({ dialog, els, deps }) => {
      dialog.open();
      els.backupImportPass.value = "backup-passphrase";

      await dialog.submit();

      assert.equal(els.backupImportOverlay.hidden, false);
      assert.deepEqual(deps.onImported.args(), []);
      assert.equal(els.backupImportStatus.textContent, "");
    },
    { invokeTable: { import_backup: null } }
  );
});

test("a failed import is reported and the dialog stays open", async () => {
  await withDialog(
    async ({ dialog, els }) => {
      dialog.open();
      els.backupImportPass.value = "wrong";

      await dialog.submit();

      assert.equal(els.backupImportOverlay.hidden, false);
      assert.equal(
        els.backupImportError.textContent,
        "backup.importFailed(message=bad passphrase)"
      );
      assert.equal(els.backupImportConfirm.disabled, false);
    },
    {
      invokeTable: {
        import_backup: () => {
          throw "bad passphrase";
        },
      },
    }
  );
});

test("close calls onClosed and clears the passphrase", () => {
  withDialog(({ dialog, els, deps }) => {
    dialog.open();
    els.backupImportPass.value = "secret";

    dialog.close();

    assert.equal(dialog.isOpen(), false);
    assert.equal(els.backupImportOverlay.hidden, true);
    assert.equal(els.backupImportPass.value, "");
    assert.deepEqual(deps.onClosed.args(), [[]]);
  });
});
