// ---------------------------------------------------------------------------
// Recovery phrase dialog
// ---------------------------------------------------------------------------
//
// Three jobs:
//
// 1. Show a freshly generated BIP39 phrase exactly once, as unselectable
//    tiles. There is deliberately no copy button: the user is meant to write
//    the words down, and the CSS/event guard in `wiring.js` blocks selection
//    and the clipboard.
// 2. Move to a separate confirmation window. The phrase is removed from the DOM
//    first, so the user has to use the paper copy instead of reading the words
//    while typing them.
// 3. Ask for three specific positions, with prefix suggestions from the same
//    BIP39 wordlist the backend validates against. The backend repeats the
//    answer check, so a frontend bug cannot silently enable a phrase the user
//    never confirmed.
//
// The phrase is held only in this module and in the DOM while the dialog is
// open. `close()` wipes both; the immutable JS strings themselves are subject to
// the same garbage-collection limits as every other plaintext string in the
// webview.

import { createFocusTrap } from "./focus-trap.js";
import {
  createWordFields,
  loadBip39Words,
} from "./word-input.js";

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
  const phraseTrap = createFocusTrap(els.recoveryOverlay);
  const confirmTrap = createFocusTrap(els.recoveryConfirmOverlay);

  /** The phrase currently on screen, or null when the dialog is closed. */
  let pending = null;
  /** `"phrase"`, `"confirm"`, or null when closed. */
  let stage = null;
  /** True while the backend is generating or writing; closing is blocked. */
  let busy = false;

  function isOpen() {
    return stage !== null;
  }

  function showPhraseError(message) {
    if (els.recoveryError) els.recoveryError.textContent = message;
  }

  function showConfirmError(message) {
    if (els.recoveryConfirmError) {
      els.recoveryConfirmError.textContent = message;
    }
  }

  function setBusy(value) {
    busy = value;
    for (const button of [
      els.recoveryContinueBtn,
      els.recoveryCancel,
      els.recoveryClose,
      els.recoveryConfirmSubmit,
      els.recoveryConfirmCancel,
      els.recoveryConfirmClose,
    ]) {
      if (button) button.disabled = value;
    }
    for (const field of pending?.fields ?? []) {
      field.input.disabled = value;
    }
  }

  /** Remove the words from the DOM and drop the in-memory copy. */
  function clearPhrase() {
    if (pending) {
      pending.words.fill("");
      pending.words = [];
      pending.indices = [];
      pending.recoveryId = "";
      pending.fields = [];
    }
    pending = null;
    if (els.recoveryWords) els.recoveryWords.replaceChildren();
    if (els.recoveryConfirmFields) {
      els.recoveryConfirmFields.replaceChildren();
    }
    if (els.recoveryId) els.recoveryId.textContent = "";
    showPhraseError("");
    showConfirmError("");
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

  /**
   * Generate a phrase and open the one-time display window.
   *
   * Nothing is persisted here. If the user cancels or the app dies before the
   * confirmation step, no recovery file is written and the next attempt
   * produces a fresh phrase.
   */
  async function open() {
    if (isOpen()) return;
    stage = "phrase";
    showPhraseError("");
    showConfirmError("");
    els.recoveryOverlay.hidden = false;
    els.recoveryConfirmOverlay.hidden = true;
    phraseTrap.activate();
    setBusy(true);

    try {
      const data = await deps.invoke("generate_recovery_phrase");
      if (stage !== "phrase") return;

      pending = {
        words: data.words,
        indices: data.indices,
        recoveryId: data.recoveryId,
        fields: [],
      };
      els.recoveryId.textContent = deps.t("recovery.idLabel", {
        id: data.recoveryId,
      });
      renderWords(data.words);
      els.recoveryContinueBtn?.focus?.();
    } catch (err) {
      console.error("generate_recovery_phrase failed:", err);
      showPhraseError(
        deps.t("recovery.errGenerate", {
          message: typeof err === "string" ? err : String(err),
        })
      );
    } finally {
      setBusy(false);
    }
  }

  /**
   * Leave the phrase display and open the separate confirmation window.
   *
   * Clearing `recoveryWords` is intentional: the confirmation is meant to prove
   * the words were written down, not read off the screen.
   */
  async function continueToConfirm() {
    if (stage !== "phrase" || !pending || busy) return;

    stage = "confirm";
    els.recoveryOverlay.hidden = true;
    phraseTrap.deactivate({ restore: false });
    if (els.recoveryWords) els.recoveryWords.replaceChildren();
    els.recoveryConfirmOverlay.hidden = false;
    confirmTrap.activate();
    showConfirmError("");
    setBusy(true);

    try {
      const words = await loadBip39Words(deps.invoke);
      if (stage !== "confirm" || !pending) return;

      const entries = pending.indices.map((index) => ({
        index,
        label: deps.t("recovery.confirmWord", { n: index + 1 }),
      }));
      const focusNext = (field) => {
        const position = pending.fields.indexOf(field);
        const next = pending.fields[position + 1];
        if (next) next.focus();
        else els.recoveryConfirmSubmit?.focus?.();
      };
      pending.fields = createWordFields(els.recoveryConfirmFields, entries, {
        words,
        t: deps.t,
        idPrefix: "recovery-confirm-word",
        onSelect: focusNext,
        onAdvance: focusNext,
      });
      pending.fields[0]?.focus();
    } finally {
      setBusy(false);
    }
  }

  /** Verify the requested words and persist the recovery wrapping. */
  async function confirm() {
    if (stage !== "confirm" || !pending) return;
    showConfirmError("");

    const answers = pending.fields.map((field) => field.input.value.trim());
    if (answers.some((answer) => answer === "")) {
      showConfirmError(deps.t("recovery.errConfirmMissing"));
      pending.fields.find((field) => field.input.value.trim() === "")?.focus();
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
      showConfirmError(
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
    stage = null;
    els.recoveryOverlay.hidden = true;
    els.recoveryConfirmOverlay.hidden = true;
    phraseTrap.deactivate({ restore: false });
    confirmTrap.deactivate();
    clearPhrase();
  }

  return {
    isOpen,
    open,
    continueToConfirm,
    confirm,
    close,
  };
}
