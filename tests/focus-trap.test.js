// ---------------------------------------------------------------------------
// Focus trap
// ---------------------------------------------------------------------------
//
// Modals must keep Tab inside themselves. These tests drive the handler with a
// tiny fake container rather than a browser, matching the rest of the suite.

import test from "node:test";
import assert from "node:assert/strict";

import { createFocusTrap } from "../src/focus-trap.js";
import { fakeElement, installDom } from "./helpers/dom.js";

function harness() {
  const overlay = fakeElement("div");
  const first = fakeElement("button");
  first.type = "button";
  const middle = fakeElement("input");
  middle.type = "text";
  const last = fakeElement("button");
  last.type = "button";
  overlay.append(first, middle, last);

  const trap = createFocusTrap(overlay);
  return { overlay, first, middle, last, trap };
}

function tabEvent(shiftKey = false) {
  let prevented = false;
  return {
    key: "Tab",
    shiftKey,
    preventDefault() {
      prevented = true;
    },
    get prevented() {
      return prevented;
    },
  };
}

test("Tab from the last control wraps to the first", () => {
  const restore = installDom();
  try {
    const { overlay, first, last, trap } = harness();
    trap.activate();
    last.focus();

    const event = tabEvent();
    overlay.emit("keydown", event);

    assert.equal(document.activeElement, first);
    assert.equal(event.prevented, true);
    trap.deactivate();
  } finally {
    restore();
  }
});

test("Shift+Tab from the first control wraps to the last", () => {
  const restore = installDom();
  try {
    const { overlay, first, last, trap } = harness();
    trap.activate();
    first.focus();

    const event = tabEvent(true);
    overlay.emit("keydown", event);

    assert.equal(document.activeElement, last);
    assert.equal(event.prevented, true);
    trap.deactivate();
  } finally {
    restore();
  }
});

test("Tab from outside the dialog enters at the first control", () => {
  const restore = installDom();
  try {
    const { overlay, first, trap } = harness();
    trap.activate();
    document.activeElement = null;

    const event = tabEvent();
    overlay.emit("keydown", event);

    assert.equal(document.activeElement, first);
    trap.deactivate();
  } finally {
    restore();
  }
});

test("deactivate restores the element that had focus before opening", () => {
  const restore = installDom();
  try {
    const trigger = fakeElement("button");
    trigger.type = "button";
    trigger.focus();

    const { first, trap } = harness();
    trap.activate();
    first.focus();
    trap.deactivate();

    assert.equal(document.activeElement, trigger);
  } finally {
    restore();
  }
});
