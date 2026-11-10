// ---------------------------------------------------------------------------
// Recovery phrase dialog tests
// ---------------------------------------------------------------------------
//
// The dialog has one critical invariant: the backend must not be asked to write
// `recovery.xml` until the three requested words have been re-typed in the
// separate confirmation window. The phrase display is cleared before that
// window opens, so the answers cannot be read off the screen.

import test from "node:test";
import assert from "node:assert/strict";

import { createRecoveryDialog } from "../src/recovery-dialog.js";
import { resetWordlistCache } from "../src/word-input.js";
import { installDom, fakeEls, fakeT, fakeInvoke, spy } from "./helpers/dom.js";

const RECOVERY_IDS = [
  "recoveryOverlay",
  "recoveryError",
  "recoveryId",
  "recoveryWords",
  "recoveryContinueBtn",
  "recoveryCancel",
  "recoveryClose",
  "recoveryConfirmOverlay",
  "recoveryConfirmFields",
  "recoveryConfirmError",
  "recoveryConfirmSubmit",
  "recoveryConfirmCancel",
  "recoveryConfirmClose",
];

const WORDS =
  "abandon ability able about above absent absorb abstract absurd abuse access accident".split(
    " ",
  );
const INDICES = [0, 4, 11];
const RECOVERY_ID = WORDS.join(" ");

function harness(overrides = {}) {
  resetWordlistCache();
  const restore = installDom();
  const els = fakeEls(RECOVERY_IDS);
  els.recoveryOverlay.hidden = true;
  els.recoveryConfirmOverlay.hidden = true;

  const invoke = fakeInvoke({
    generate_recovery_phrase: {
      // A copy, because `close()` wipes the array it was handed.
      words: [...WORDS],
      indices: INDICES,
      recoveryId: RECOVERY_ID,
    },
    get_bip39_words: WORDS,
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

test("open renders the phrase and its BIP39 id, but not the confirmation window", async () => {
  await withDialog(async ({ dialog, els }) => {
    await dialog.open();

    assert.equal(els.recoveryOverlay.hidden, false);
    assert.equal(els.recoveryConfirmOverlay.hidden, true);
    assert.equal(dialog.isOpen(), true);
    assert.equal(els.recoveryWords.children.length, 12);
    assert.deepEqual(
      els.recoveryWords.children.map((item) => item.children[1].textContent),
      WORDS,
    );
    assert.match(els.recoveryId.textContent, /recovery\.idLabel/);
    assert.match(els.recoveryId.textContent, new RegExp(RECOVERY_ID));
    assert.equal(confirmationInputs(els).length, 0);
    assert.equal(document.activeElement, els.recoveryContinueBtn);
  });
});

test("open calls only generate_recovery_phrase", async () => {
  await withDialog(async ({ dialog, invoke }) => {
    await dialog.open();
    assert.deepEqual(invoke.commands(), ["generate_recovery_phrase"]);
  });
});

test("continue opens a separate confirmation window and removes the phrase", async () => {
  await withDialog(async ({ dialog, els }) => {
    await dialog.open();
    await dialog.continueToConfirm();

    assert.equal(els.recoveryOverlay.hidden, true);
    assert.equal(els.recoveryConfirmOverlay.hidden, false);
    assert.equal(els.recoveryWords.children.length, 0);
    assert.equal(confirmationInputs(els).length, 3);
    assert.equal(document.activeElement, confirmationInputs(els)[0]);
    assert.equal(dialog.isOpen(), true);
  });
});

test("confirmation suggests BIP39 words by prefix", async () => {
  await withDialog(async ({ dialog, els }) => {
    await dialog.open();
    await dialog.continueToConfirm();

    const input = confirmationInputs(els)[0];
    input.value = "ab";
    input.emit("input");

    const list = els.recoveryConfirmFields.findAll(
      (child) => child.tagName === "UL",
    )[0];
    assert.equal(list.hidden, false);
    assert.ok(list.children.length > 0);
    assert.match(list.children[0].textContent, /^ab/);

    const option = list.children[0];
    option.emit("mousedown", { preventDefault() {} });
    assert.equal(input.value, option.textContent);
    assert.equal(list.hidden, true);
  });
});

test("confirm refuses to write while a requested word is empty", async () => {
  await withDialog(async ({ dialog, els, invoke }) => {
    await dialog.open();
    await dialog.continueToConfirm();
    const inputs = confirmationInputs(els);
    inputs[0].value = "abandon";
    inputs[1].value = "";
    inputs[2].value = "accident";

    await dialog.confirm();

    assert.match(
      els.recoveryConfirmError.textContent,
      /recovery\.errConfirmMissing/,
    );
    assert.equal(invoke.commands().includes("confirm_recovery_phrase"), false);
    assert.equal(dialog.isOpen(), true);
  });
});

test("confirm writes the phrase and closes after the right answers", async () => {
  await withDialog(async ({ dialog, els, invoke, setStatus, onEnabled }) => {
    await dialog.open();
    await dialog.continueToConfirm();
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
    assert.equal(els.recoveryConfirmOverlay.hidden, true);
    assert.equal(els.recoveryWords.children.length, 0);
    assert.equal(els.recoveryConfirmFields.children.length, 0);
    assert.equal(onEnabled.count(), 1);
    assert.deepEqual(onEnabled.args()[0], [RECOVERY_ID]);
    assert.deepEqual(setStatus.args()[0], ["recovery.enabled", true]);
  });
});

test("a backend rejection keeps the confirmation window open and shows the message", async () => {
  await withDialog(
    async ({ dialog, els }) => {
      await dialog.open();
      await dialog.continueToConfirm();
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
      assert.equal(els.recoveryConfirmOverlay.hidden, false);
      assert.match(els.recoveryConfirmError.textContent, /recovery\.errConfirm/);
      assert.match(els.recoveryConfirmError.textContent, /failed/);
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
      await dialog.continueToConfirm();
      const inputs = confirmationInputs(els);
      inputs[0].value = "abandon";
      inputs[1].value = "above";
      inputs[2].value = "accident";

      const confirming = dialog.confirm();
      dialog.close({ force: true });

      assert.equal(dialog.isOpen(), false);
      assert.equal(els.recoveryWords.children.length, 0);
      assert.equal(els.recoveryConfirmFields.children.length, 0);

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

test("close wipes the words and both windows", async () => {
  await withDialog(async ({ dialog, els }) => {
    await dialog.open();
    await dialog.continueToConfirm();
    assert.equal(confirmationInputs(els).length, 3);

    dialog.close();

    assert.equal(dialog.isOpen(), false);
    assert.equal(els.recoveryOverlay.hidden, true);
    assert.equal(els.recoveryConfirmOverlay.hidden, true);
    assert.equal(els.recoveryWords.children.length, 0);
    assert.equal(els.recoveryConfirmFields.children.length, 0);
    assert.equal(els.recoveryId.textContent, "");
  });
});
