// ---------------------------------------------------------------------------
// Modal focus containment
// ---------------------------------------------------------------------------
//
// A modal dialog must keep keyboard focus inside itself until it closes. The
// dialogs already declare `aria-modal="true"` and restore focus on some paths,
// but without a Tab handler focus can walk into the obscured app behind them.
//
// The helper deliberately does not focus anything on `activate`: each dialog
// knows which control should receive the initial focus (passphrase, Done,
// close button), and the existing tests assert those choices. `activate` only
// remembers where focus came from; `deactivate` sends it back.

const FOCUSABLE_TAGS = new Set([
  "BUTTON",
  "INPUT",
  "SELECT",
  "TEXTAREA",
  "SUMMARY",
  "A",
]);

function isVisible(element) {
  if (element.hidden) return false;
  if (typeof element.getClientRects === "function") {
    return element.getClientRects().length > 0;
  }
  return true;
}

function isFocusable(element) {
  if (!isVisible(element) || element.disabled) return false;
  if (element.getAttribute?.("tabindex") === "-1") return false;
  if (element.tagName === "INPUT" && element.type === "hidden") return false;
  if (element.tagName === "A") {
    return Boolean(element.getAttribute?.("href"));
  }
  return FOCUSABLE_TAGS.has(element.tagName);
}

function focusableElements(container) {
  const found = [];
  const visit = (node) => {
    for (const child of node.children ?? []) {
      if (isFocusable(child)) found.push(child);
      visit(child);
    }
  };
  visit(container);
  return found;
}

function isInside(container, element) {
  if (!element) return false;
  if (element === container) return true;
  if (typeof container.contains === "function") {
    return container.contains(element);
  }
  let node = element.parentNode;
  while (node) {
    if (node === container) return true;
    node = node.parentNode;
  }
  return false;
}

export function createFocusTrap(container) {
  let previous = null;
  let active = false;

  function onKeydown(event) {
    if (event.key !== "Tab") return;

    const items = focusableElements(container);
    if (items.length === 0) {
      event.preventDefault();
      return;
    }

    const first = items[0];
    const last = items[items.length - 1];
    const current = document.activeElement;

    if (event.shiftKey) {
      if (current === first || !isInside(container, current)) {
        event.preventDefault();
        last.focus();
      }
      return;
    }

    if (current === last || !isInside(container, current)) {
      event.preventDefault();
      first.focus();
    }
  }

  return {
    activate() {
      if (active) return;
      previous = document.activeElement;
      container.addEventListener("keydown", onKeydown);
      active = true;
    },
    deactivate({ restore = true } = {}) {
      if (!active) return;
      container.removeEventListener("keydown", onKeydown);
      active = false;
      if (
        restore &&
        previous &&
        isVisible(previous) &&
        typeof previous.focus === "function"
      ) {
        previous.focus();
      }
      previous = null;
    },
  };
}
