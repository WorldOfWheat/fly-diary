// ---------------------------------------------------------------------------
// Input modality tests
// ---------------------------------------------------------------------------
//
// The focus ring is part of the accessibility contract, but WebKitGTK can
// report pointer focus as `:focus-visible`. These tests pin the data attribute
// that the stylesheet uses to show the ring only after keyboard input.

import test from "node:test";
import assert from "node:assert/strict";

import { initInputModality } from "../src/input-modality.js";
import { fakeElement } from "./helpers/dom.js";

function harness() {
  const root = fakeElement("html");
  const target = fakeElement("#document");
  const cleanup = initInputModality({ root, target });
  return { root, target, cleanup };
}

test("starts in pointer mode so programmatic focus has no ring", () => {
  const { root, cleanup } = harness();
  assert.equal(root.dataset.inputModality, "pointer");
  cleanup();
});

test("keydown switches to keyboard mode", () => {
  const { root, target, cleanup } = harness();

  target.emit("keydown", { key: "Tab" });
  assert.equal(root.dataset.inputModality, "keyboard");

  target.emit("keydown", { key: "Enter" });
  assert.equal(root.dataset.inputModality, "keyboard");

  cleanup();
});

test("any pointer event switches back to pointer mode", () => {
  const { root, target, cleanup } = harness();

  for (const type of ["pointerdown", "mousedown", "touchstart"]) {
    target.emit("keydown", { key: "Tab" });
    assert.equal(root.dataset.inputModality, "keyboard");

    target.emit(type, {});
    assert.equal(
      root.dataset.inputModality,
      "pointer",
      `${type} must switch back to pointer mode`
    );
  }

  cleanup();
});

test("cleanup removes every listener", () => {
  const { root, target, cleanup } = harness();

  cleanup();
  target.emit("keydown", { key: "Tab" });

  assert.equal(root.dataset.inputModality, "pointer");
});
