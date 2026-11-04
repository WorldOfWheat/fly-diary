// ---------------------------------------------------------------------------
// Native drag-drop tests
// ---------------------------------------------------------------------------
//
// The module turns Tauri's native drag events into the same `.is-dragover`
// affordance as the HTML5 path and forwards dropped paths to the gallery.

import test from "node:test";
import assert from "node:assert/strict";

import { createNativeFileDrop } from "../src/native-drop.js";
import { fakeElement, spy } from "./helpers/dom.js";

function harness({ canDrop = () => true, webview = true } = {}) {
  const editor = fakeElement("main");
  editor.getBoundingClientRect = () => ({
    left: 100,
    top: 50,
    right: 500,
    bottom: 400,
  });

  let handler = null;
  const fakeWebview = {
    onDragDropEvent: async (fn) => {
      handler = fn;
      return async () => {
        handler = null;
      };
    },
  };

  const onDrop = spy();
  const drop = createNativeFileDrop({
    getCurrentWebview: () => (webview ? fakeWebview : undefined),
    editor,
    canDrop,
    onDrop,
    devicePixelRatio: () => 1,
  });

  return {
    editor,
    drop,
    onDrop,
    emit: (payload) => handler?.({ payload }),
    hasHandler: () => Boolean(handler),
  };
}

test("start returns false when there is no Tauri webview", async () => {
  const h = harness({ webview: false });
  assert.equal(await h.drop.start(), false);
  assert.equal(h.hasHandler(), false);
});

test("hovering over the editor shows the drop state, leaving hides it", async () => {
  const h = harness();
  assert.equal(await h.drop.start(), true);

  h.emit({ type: "over", position: { x: 200, y: 100 } });
  assert.equal(h.editor.classList.contains("is-dragover"), true);
  assert.equal(h.drop.isDragging(), true);

  h.emit({ type: "over", position: { x: 10, y: 10 } });
  assert.equal(h.editor.classList.contains("is-dragover"), false);

  h.emit({ type: "over", position: { x: 200, y: 100 } });
  h.emit({ type: "leave" });
  assert.equal(h.editor.classList.contains("is-dragover"), false);
});

test("dropping over the editor forwards the native file paths", async () => {
  const h = harness();
  await h.drop.start();

  h.emit({ type: "over", position: { x: 200, y: 100 } });
  h.emit({
    type: "drop",
    paths: ["/tmp/one.png", "/tmp/two.jpg"],
    position: { x: 200, y: 100 },
  });

  assert.deepEqual(h.onDrop.args(), [[["/tmp/one.png", "/tmp/two.jpg"]]]);
  assert.equal(h.editor.classList.contains("is-dragover"), false);
});

test("dropping outside the editor is ignored", async () => {
  const h = harness();
  await h.drop.start();

  h.emit({ type: "drop", paths: ["/tmp/one.png"], position: { x: 10, y: 10 } });

  assert.equal(h.onDrop.count(), 0);
});

test("a read-only entry does not show the drop affordance", async () => {
  const h = harness({ canDrop: () => false });
  await h.drop.start();

  h.emit({ type: "over", position: { x: 200, y: 100 } });

  assert.equal(h.editor.classList.contains("is-dragover"), false);
});

test("stop removes the native listener and the drop state", async () => {
  const h = harness();
  await h.drop.start();
  h.emit({ type: "over", position: { x: 200, y: 100 } });

  await h.drop.stop();

  assert.equal(h.hasHandler(), false);
  assert.equal(h.editor.classList.contains("is-dragover"), false);
});
