import test from "node:test";
import assert from "node:assert/strict";

import {
  prefersReducedMotion,
  animateOverlayExit,
  setExitAnimationsEnabled,
} from "../src/lib/motion.js";

function withWindow(value, body) {
  const previous = globalThis.window;
  globalThis.window = value;
  try {
    return body();
  } finally {
    globalThis.window = previous;
  }
}

test("prefersReducedMotion follows matchMedia", () => {
  assert.equal(
    withWindow(
      { matchMedia: () => ({ matches: true }) },
      prefersReducedMotion
    ),
    true
  );
  assert.equal(
    withWindow(
      { matchMedia: () => ({ matches: false }) },
      prefersReducedMotion
    ),
    false
  );
  assert.equal(withWindow(undefined, prefersReducedMotion), false);
});

test("animateOverlayExit is a no-op for hidden overlays", () => {
  assert.doesNotThrow(() =>
    animateOverlayExit({ hidden: true, cloneNode: () => ({}) })
  );
});

test("animateOverlayExit skips reduced motion and missing DOM support", () => {
  withWindow({ matchMedia: () => ({ matches: true }) }, () => {
    assert.doesNotThrow(() =>
      animateOverlayExit({ hidden: false, cloneNode: () => ({}) })
    );
  });
  assert.doesNotThrow(() =>
    animateOverlayExit({ hidden: false, cloneNode: () => ({}) })
  );
  assert.doesNotThrow(() => animateOverlayExit(null));
});

test("exit ghosts can be suppressed while locking", () => {
  const appended = [];
  const previousDocument = globalThis.document;
  const body = {
    appendChild(node) {
      appended.push(node);
      node.parentNode = body;
    },
    removeChild(node) {
      node.parentNode = null;
    },
  };
  globalThis.document = { body };

  const clone = {
    parentNode: null,
    firstChild: null,
    classList: { add() {} },
    removeAttribute() {},
    setAttribute() {},
    querySelectorAll: () => [],
    addEventListener() {},
  };
  const overlay = { hidden: false, cloneNode: () => clone };

  try {
    animateOverlayExit(overlay);
    assert.equal(appended.length, 1);

    setExitAnimationsEnabled(false);
    animateOverlayExit(overlay);
    assert.equal(appended.length, 1);

    setExitAnimationsEnabled(true);
    animateOverlayExit(overlay);
    assert.equal(appended.length, 2);
  } finally {
    setExitAnimationsEnabled(true);
    globalThis.document = previousDocument;
  }
});
