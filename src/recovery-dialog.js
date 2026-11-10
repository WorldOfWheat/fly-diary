// ---------------------------------------------------------------------------
// Recovery phrase dialog
// ---------------------------------------------------------------------------
//
// Two jobs:
//
// 1. Show a freshly generated BIP39 phrase exactly once, as unselectable
//    tiles. There is deliberately no copy button: the user is meant to write
//    the words down, and the CSS/event guard in `wiring.js` blocks selection
//    and the clipboard.
// 2. Ask for three specific positions from the phrase before the backend is
//    allowed to persist `recovery.xml`. The backend repeats that check, so a
//    frontend bug cannot silently enable a phrase the user never confirmed.
//
// The phrase is held only in this module and in the DOM while the dialog is
// open. `close()` wipes both; the immutable JS strings themselves are subject to
// the same garbage-collection limits as every other plaintext string in the
// webview.

import { createFocusTrap } from "./focus-trap.js";

/**
 * Create the recovery dialog controller.
 *
 * `deps` shape:
 *
 *   els      — the lookup table from `dom.js`
 *   invoke   — (command: string, args?: object) => Promise<any>
 *   t        — (key: string, params?: object) => string
 *   setStatus — (text: string, saved?: boolean) => void
 *   onEnabled — (recoveryId: string) => void
 */
export function createRecoveryDialog(deps) {
  const { els } = deps;
  const focusTrap = createFocusTrap(els.recoveryOverlay);

  /** The phrase currently on screen, or null when the dialog is closed. */
  let pending = null;

  /** True while the backend is generating or writing; closing is blocked. */
  let busy = false;

  function isOpen() {
    return !els.recoveryOverlay.hidden;
  }

  function showError(message) {
    els.recoveryError.textContent = message;
  }

  function setBusy(value) {
    busy = value;
    els.recoveryConfirmBtn.disabled = value;
    if (els.recoveryCancel) els.recoveryCancel.disabled = value;
    if (els.recoveryClose) els.recoveryClose.disabled = value;
  }

  /** Remove the words from the DOM and drop the in-memory copy. */
  function clearPhrase() {
    if (pending) {
      pending.words.fill("");
      pending.words = [];
      pending.indices = [];
      pending.recoveryId = "";
    }
    pending = null;
    if (els.recoveryWords) els.recoveryWords.replaceChildren();
    if (els.recoveryConfirmFields) els.recoveryConfirmFields.replaceChildren();
    if (els.recoveryId) els.recoveryId.textContent = "";
    if (els.recoveryError) els.recoveryError.textContent = "";
  }

  /** Render the numbered word tiles. */
  function renderWords(words) {
    els.recoveryWords.replaceChildren();
    words.forEach((word, index) => {
      const item = document.createElement("li");
      item.className = "recovery-word";
      item.setAttribute(
        "aria-label",
        deps.t("recovery.wordLabel", { n: index + 1, word }),
      );

      const number = document.createElement("span");
      number.className = "recovery-word-index";
      number.textContent = String(index + 1).padStart(2, "0");
      number.setAttribute("aria-hidden", "true");

      const text = document.createElement("span");
      text.className = "recovery-word-text";
      text.textContent = word;

      item.append(number, text);
      els.recoveryWords.append(item);
    });
  }

  /** Render one input per position the user must re-type. */
  function renderConfirmation(indices) {
    els.recoveryConfirmFields.replaceChildren();
    const inputs = [];
    for (const index of indices) {
      const label = document.createElement("label");
      label.className = "recovery-confirm-field";
      label.setAttribute("for", `recovery-word-${index}`);

      const caption = document.createElement("span");
      caption.className = "recovery-confirm-label";
      caption.textContent = deps.t("recovery.confirmWord", { n: index + 1 });

      const input = document.createElement("input");
      input.id = `recovery-word-${index}`;
      input.className = "settings-input";
      input.type = "text";
      input.autocomplete = "off";
      input.autocapitalize = "off";
      input.spellcheck = false;
      input.dataset.index = String(index);
      input.setAttribute("aria-label", caption.textContent);

      label.append(caption, input);
      els.recoveryConfirmFields.append(label);
      inputs.push(input);
    }
    return inputs;
  }

  /**
   * Generate a phrase and open the dialog.
   *
   * Nothing is persisted here. If the user cancels or the app dies before the
   * confirmation step, no recovery file is written and the next attempt
   * produces a fresh phrase.
   */
  async function open() {
    if (isOpen()) return;
    els.recoveryError.textContent = "";
    els.recoveryOverlay.hidden = false;
    focusTrap.activate();
    setBusy(true);

    try {
      const data = await deps.invoke("generate_recovery_phrase");
      if (!isOpen()) return;

      pending = {
        words: data.words,
        indices: data.indices,
        recoveryId: data.recoveryId,
        inputs: [],
      };
      els.recoveryId.textContent = deps.t("recovery.idLabel", {
        id: data.recoveryId,
      });
      renderWords(data.words);
      pending.inputs = renderConfirmation(data.indices);
      pending.inputs[0]?.focus();
    } catch (err) {
      console.error("generate_recovery_phrase failed:", err);
      showError(
        deps.t("recovery.errGenerate", {
          message: typeof err === "string" ? err : String(err),
        })
      );
    } finally {
      setBusy(false);
    }
  }

  /** Verify the requested words and persist the recovery wrapping. */
  async function confirm() {
    if (!pending) return;
    showError("");

    const answers = pending.inputs.map((input) => input.value.trim());
    if (answers.some((answer) => answer === "")) {
      showError(deps.t("recovery.errConfirmMissing"));
      pending.inputs.find((input) => input.value.trim() === "")?.focus();
      return;
    }

    // Capture everything the in-flight call needs. A forced close (auto-lock)
    // clears `pending` while the backend is working, and the UI must not show a
    // success state for a dialog that is no longer on screen.
    const current = pending;
    const phrase = current.words.join(" ");
    const recoveryId = current.recoveryId;
    const indices = current.indices;

    setBusy(true);
    try {
      await deps.invoke("confirm_recovery_phrase", {
        phrase,
        recoveryId,
        indices,
        answers,
      });
      setBusy(false);
      if (!isOpen() || pending !== current) return;
      close();
      deps.onEnabled?.(recoveryId);
      deps.setStatus(deps.t("recovery.enabled"), true);
    } catch (err) {
      console.error("confirm_recovery_phrase failed:", err);
      showError(
        deps.t("recovery.errConfirm", {
          message: typeof err === "string" ? err : String(err),
        })
      );
    } finally {
      setBusy(false);
    }
  }

  /**
   * Close without saving anything.
   *
   * Ignored while a backend call is in flight, unless `force` is set. Locking
   * passes `force` so an auto-lock cannot leave the one-time phrase on screen.
   */
  function close({ force = false } = {}) {
    if (!isOpen()) return;
    if (busy && !force) return;
    els.recoveryOverlay.hidden = true;
    focusTrap.deactivate();
    clearPhrase();
  }

  return {
    isOpen,
    open,
    confirm,
    close,
  };
}
