// ---------------------------------------------------------------------------
// Recovery phrase dialog tests
// ---------------------------------------------------------------------------
//
// The dialog has one critical invariant: the backend must not be asked to write
// `recovery.xml` until the three requested words have been re-typed. These
// tests drive the generate → render → confirm loop with the DOM stub.

import test from "node:test";
import assert from "node:assert/strict";

import { createRecoveryDialog } from "../src/recovery-dialog.js";
import { installDom, fakeEls, fakeT, fakeInvoke, spy } from "./helpers/dom.js";

const RECOVERY_IDS = [
  "recoveryOverlay",
  "recoveryError",
  "recoveryId",
  "recoveryWords",
  "recoveryConfirmFields",
  "recoveryConfirmBtn",
];

const WORDS = "abandon ability able about above absent absorb abstract absurd abuse access accident".split(
  " ",
);
const INDICES = [0, 4, 11];
const RECOVERY_ID = "cmVjb3ZlcnktaWQ=";

function harness(overrides = {}) {
  const restore = installDom();
  const els = fakeEls(RECOVERY_IDS);
  els.recoveryOverlay.hidden = true;

  const invoke = fakeInvoke({
    generate_recovery_phrase: {
      // A copy, because `close()` wipes the array it was handed.
      words: [...WORDS],
      indices: INDICES,
      recoveryId: RECOVERY_ID,
    },
    confirm_recovery_phrase: RECOVERY_ID,
    ...(overrides.invokeTable ?? {}),
  });

  const setStatus = spy();
  const onEnabled = spy();
  const deps = {
    els,
    invoke,
    t: fakeT(),
    setStatus,
    onEnabled,
    ...overrides.deps,
  };

  return {
    els,
    invoke,
    setStatus,
    onEnabled,
    dialog: createRecoveryDialog(deps),
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

/** The confirmation inputs, in phrase-position order. */
function confirmationInputs(els) {
  return els.recoveryConfirmFields.findAll((child) => child.tagName === "INPUT");
}

test("open renders the phrase, its id and the confirmation fields", async () => {
  await withDialog(async ({ dialog, els }) => {
    await dialog.open();

    assert.equal(els.recoveryOverlay.hidden, false);
    assert.equal(dialog.isOpen(), true);
    assert.equal(els.recoveryWords.children.length, 12);
    assert.deepEqual(
      els.recoveryWords.children.map((item) => item.children[1].textContent),
      WORDS,
    );
    assert.match(els.recoveryId.textContent, /recovery\.idLabel/);
    assert.equal(confirmationInputs(els).length, 3);
    assert.equal(document.activeElement, confirmationInputs(els)[0]);
  });
});

test("open calls only generate_recovery_phrase", async () => {
  await withDialog(async ({ dialog, invoke }) => {
    await dialog.open();
    assert.deepEqual(invoke.commands(), ["generate_recovery_phrase"]);
  });
});

test("confirm refuses to write while a requested word is empty", async () => {
  await withDialog(async ({ dialog, els, invoke }) => {
    await dialog.open();
    const inputs = confirmationInputs(els);
    inputs[0].value = "abandon";
    inputs[1].value = "";
    inputs[2].value = "accident";

    await dialog.confirm();

    assert.match(els.recoveryError.textContent, /recovery\.errConfirmMissing/);
    assert.equal(invoke.commands().includes("confirm_recovery_phrase"), false);
    assert.equal(dialog.isOpen(), true);
  });
});

test("confirm writes the phrase and closes after the right answers", async () => {
  await withDialog(async ({ dialog, els, invoke, setStatus, onEnabled }) => {
    await dialog.open();
    const inputs = confirmationInputs(els);
    inputs[0].value = "ABANDON";
    inputs[1].value = "above";
    inputs[2].value = " accident ";

    await dialog.confirm();

    assert.deepEqual(invoke.argsOf("confirm_recovery_phrase"), {
      phrase: WORDS.join(" "),
      recoveryId: RECOVERY_ID,
      indices: INDICES,
      answers: ["ABANDON", "above", "accident"],
    });
    assert.equal(dialog.isOpen(), false);
    assert.equal(els.recoveryOverlay.hidden, true);
    assert.equal(els.recoveryWords.children.length, 0);
    assert.equal(els.recoveryConfirmFields.children.length, 0);
    assert.equal(onEnabled.count(), 1);
    assert.deepEqual(onEnabled.args()[0], [RECOVERY_ID]);
    assert.deepEqual(setStatus.args()[0], ["recovery.enabled", true]);
  });
});

test("a backend rejection keeps the dialog open and shows the message", async () => {
  await withDialog(
    async ({ dialog, els }) => {
      await dialog.open();
      const inputs = confirmationInputs(els);
      inputs[0].value = "abandon";
      inputs[1].value = "above";
      inputs[2].value = "accident";

      const originalError = console.error;
      console.error = () => {};
      try {
        await dialog.confirm();
      } finally {
        console.error = originalError;
      }

      assert.equal(dialog.isOpen(), true);
      assert.match(els.recoveryError.textContent, /recovery\.errConfirm/);
      assert.match(els.recoveryError.textContent, /failed/);
    },
    {
      invokeTable: {
        confirm_recovery_phrase: () => {
          throw new Error("failed");
        },
      },
    },
  );
});

test("a forced close during confirmation does not report success", async () => {
  let release;
  const inFlight = new Promise((resolve) => {
    release = resolve;
  });

  await withDialog(
    async ({ dialog, els, onEnabled, setStatus }) => {
      await dialog.open();
      const inputs = confirmationInputs(els);
      inputs[0].value = "abandon";
      inputs[1].value = "above";
      inputs[2].value = "accident";

      const confirming = dialog.confirm();
      dialog.close({ force: true });

      assert.equal(dialog.isOpen(), false);
      assert.equal(els.recoveryWords.children.length, 0);

      release(RECOVERY_ID);
      await confirming;

      assert.equal(onEnabled.count(), 0);
      assert.equal(setStatus.count(), 0);
    },
    {
      invokeTable: {
        confirm_recovery_phrase: () => inFlight,
      },
    },
  );
});

test("close wipes the words from the DOM", async () => {
  await withDialog(async ({ dialog, els }) => {
    await dialog.open();
    assert.equal(els.recoveryWords.children.length, 12);

    dialog.close();

    assert.equal(dialog.isOpen(), false);
    assert.equal(els.recoveryWords.children.length, 0);
    assert.equal(els.recoveryConfirmFields.children.length, 0);
    assert.equal(els.recoveryId.textContent, "");
  });
});
