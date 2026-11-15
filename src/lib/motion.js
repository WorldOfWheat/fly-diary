// ---------------------------------------------------------------------------
// Motion helpers
// ---------------------------------------------------------------------------
//
// Shared by the main editor and the overlay controllers. Everything is
// opt-out under `prefers-reduced-motion` and uses only opacity/transform so a
// 140 ms exit never triggers layout.

/** Whether overlay exit ghosts are allowed right now. */
let exitAnimationsEnabled = true;

/**
 * Disable exit ghosts while locking.
 *
 * A fading clone sits above the lock screen by z-index; even a title or image
 * ghost must not survive into the locked state. The next unlock re-enables it.
 */
export function setExitAnimationsEnabled(enabled) {
  exitAnimationsEnabled = enabled;
}

/** Whether the OS or browser asked for reduced motion. */
export function prefersReducedMotion() {
  return (
    typeof globalThis.window?.matchMedia === "function" &&
    globalThis.window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * Leave a fading ghost of an overlay behind for ~140 ms.
 *
 * The real overlay is hidden synchronously by its controller, so focus traps and
 * state teardown behave exactly as before; the inert clone only exists to give
 * the eye an exit frame. Call this *before* setting `hidden`.
 *
 * `redactInputs` clears form values in the clone (settings passphrases).
 * `backdropOnly` drops the panel entirely; used for the recovery-phrase dialog,
 * whose words must never be duplicated in the DOM.
 */
export function animateOverlayExit(
  el,
  { redactInputs = false, backdropOnly = false } = {}
) {
  if (!el || el.hidden || !exitAnimationsEnabled || prefersReducedMotion()) {
    return;
  }
  if (
    typeof el.cloneNode !== "function" ||
    !globalThis.document?.body ||
    typeof globalThis.document.body.appendChild !== "function"
  ) {
    return;
  }

  const clone = el.cloneNode(true);
  if (!clone?.classList?.add) return;

  clone.removeAttribute("id");
  clone
    .querySelectorAll?.("[id]")
    ?.forEach((node) => node.removeAttribute("id"));
  clone.setAttribute("aria-hidden", "true");
  clone.setAttribute("inert", "");
  clone.inert = true;

  // Cloning does not copy scroll offsets; without this a long dialog would
  // visibly jump to the top while its ghost fades.
  const sourceNodes = [el, ...(el.querySelectorAll?.("*") ?? [])];
  const cloneNodes = [clone, ...(clone.querySelectorAll?.("*") ?? [])];
  for (let index = 0; index < sourceNodes.length; index += 1) {
    if (sourceNodes[index].scrollTop) {
      cloneNodes[index].scrollTop = sourceNodes[index].scrollTop;
    }
  }

  if (backdropOnly) {
    while (clone.firstChild) clone.removeChild(clone.firstChild);
  } else if (redactInputs) {
    clone.querySelectorAll?.("input, textarea")?.forEach((field) => {
      field.value = "";
      field.removeAttribute("value");
    });
  }

  clone
    .querySelectorAll?.("button, input, select, textarea, a")
    ?.forEach((node) => {
      if ("disabled" in node) node.disabled = true;
      node.setAttribute("tabindex", "-1");
    });

  clone.classList.add("overlay-exit");
  globalThis.document.body.appendChild(clone);

  const remove = () => {
    if (clone.parentNode) clone.parentNode.removeChild(clone);
  };
  clone.addEventListener?.("animationend", remove, { once: true });
  // Fallback for WebViews that skip animation events while backgrounded.
  setTimeout(remove, 300);
}
