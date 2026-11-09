// ---------------------------------------------------------------------------
// Attachment gallery tests
// ---------------------------------------------------------------------------
//
// The gallery is a controller: it owns ordering, uploads, lazy image loading and
// the lightbox, but it does not compute crypto or touch the filesystem. These
// tests drive it with the minimal DOM stub and a fake `invoke` table.

import test from "node:test";
import assert from "node:assert/strict";

import {
  attachmentDataUrl,
  clipboardImageFromBrowser,
  createAttachmentGallery,
  imageTypeForFile,
  MAX_INPUT_BYTES,
  prepareImageFile,
  targetDimensions,
} from "../src/attachments.js";
import {
  fakeElement,
  fakeEls,
  fakeInvoke,
  fakeT,
  installDom,
  spy,
} from "./helpers/dom.js";

const ELEMENTS = [
  "attachments",
  "attachmentList",
  "attachmentEmpty",
  "attachmentAdd",
  "attachmentInput",
  "attachmentStatus",
  "attachmentViewer",
  "attachmentViewerImage",
  "attachmentViewerClose",
  "attachmentViewerBackdrop",
];

function setup({ invokeTable = {}, canEdit = true, locked = false } = {}) {
  const restore = installDom();
  const els = fakeEls(ELEMENTS);
  els.attachments.hidden = true;
  els.attachmentViewer.hidden = true;

  const invoke = fakeInvoke(invokeTable);
  const t = fakeT();
  const setStatus = spy();
  const refreshList = spy(async () => {});
  const flushText = spy(async () => {});
  const gallery = createAttachmentGallery({
    els,
    invoke,
    t,
    setStatus,
    confirm: () => true,
    canEdit: () => canEdit,
    isLocked: () => locked,
    flushText,
    refreshList,
  });

  return {
    els,
    invoke,
    t,
    setStatus,
    refreshList,
    flushText,
    gallery,
    restore,
  };
}

/** Let the gallery's fire-and-forget image loads settle. */
async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

test("targetDimensions keeps the aspect ratio and never upscales", () => {
  assert.deepEqual(targetDimensions(2000, 1000), { width: 1000, height: 500 });
  assert.deepEqual(targetDimensions(1000, 2000), { width: 500, height: 1000 });
  assert.deepEqual(targetDimensions(800, 600), { width: 800, height: 600 });
  assert.deepEqual(targetDimensions(0, 600), { width: 0, height: 0 });
});

test("imageTypeForFile infers MIME from the name when the OS omits it", () => {
  assert.equal(imageTypeForFile({ type: "", name: "photo.PNG" }), "image/png");
  assert.equal(imageTypeForFile({ type: "", name: "photo.jpeg" }), "image/jpeg");
  assert.equal(imageTypeForFile({ type: "", name: "photo.webp" }), "image/webp");
  assert.equal(imageTypeForFile({ type: "", name: "photo.bmp" }), "image/bmp");
  assert.equal(imageTypeForFile({ type: "", name: "photo.tiff" }), "image/tiff");
  assert.equal(imageTypeForFile({ type: "text/plain", name: "notes.txt" }), "text/plain");
  assert.equal(imageTypeForFile({ type: "image/gif", name: "x.bin" }), "image/gif");
});

test("attachmentDataUrl produces a usable data URL", () => {
  assert.equal(
    attachmentDataUrl("image/webp", "YWJj"),
    "data:image/webp;base64,YWJj"
  );
});

test("load renders the manifest order and decrypts each image lazily", async () => {
  const first = {
    id: "a".repeat(32),
    mime: "image/webp",
    width: 1000,
    height: 500,
    size: 10,
    missing: false,
  };
  const second = {
    id: "b".repeat(32),
    mime: "image/jpeg",
    width: 500,
    height: 1000,
    size: 10,
    missing: false,
  };
  const ctx = setup({
    invokeTable: {
      list_attachments: [first, second],
      get_attachment: (args) => ({
        id: args.id,
        mime: args.id === first.id ? "image/webp" : "image/jpeg",
        data: "ZGF0YQ==",
      }),
    },
  });

  try {
    await ctx.gallery.load("2026-10-23");
    await flush();

    assert.equal(ctx.els.attachmentList.children.length, 2);
    assert.equal(ctx.els.attachmentList.children[0].dataset.attachmentId, first.id);
    assert.equal(ctx.els.attachmentList.children[1].dataset.attachmentId, second.id);
    assert.equal(ctx.els.attachmentEmpty.hidden, true);
    assert.equal(ctx.els.attachments.hidden, false);
    assert.equal(ctx.els.attachmentAdd.hidden, false);
    assert.equal(ctx.invoke.argsOf("list_attachments").date, "2026-10-23");
    assert.equal(ctx.invoke.calls.filter((c) => c.command === "get_attachment").length, 2);

    const image = ctx.els.attachmentList.children[0].children[0].children[0];
    assert.equal(image.src, "data:image/webp;base64,ZGF0YQ==");
  } finally {
    ctx.restore();
  }
});

test("moving an image persists the new order", async () => {
  const a = { id: "a".repeat(32), mime: "image/webp", width: 0, height: 0, size: 1, missing: false };
  const b = { id: "b".repeat(32), mime: "image/webp", width: 0, height: 0, size: 1, missing: false };
  const ctx = setup({
    invokeTable: {
      list_attachments: [a, b],
      get_attachment: { mime: "image/webp", data: "eA==" },
      reorder_attachments: null,
    },
  });

  try {
    await ctx.gallery.load("2026-10-23");
    await ctx.gallery.move(b.id, -1);
    assert.deepEqual(ctx.gallery.ids(), [b.id, a.id]);
    assert.deepEqual(ctx.invoke.argsOf("reorder_attachments").ids, [b.id, a.id]);
    assert.equal(ctx.els.attachmentList.children[0].dataset.attachmentId, b.id);
  } finally {
    ctx.restore();
  }
});

test("a failed reorder restores the previous order", async () => {
  const a = { id: "a".repeat(32), mime: "image/webp", width: 0, height: 0, size: 1, missing: false };
  const b = { id: "b".repeat(32), mime: "image/webp", width: 0, height: 0, size: 1, missing: false };
  const ctx = setup({
    invokeTable: {
      list_attachments: [a, b],
      get_attachment: { mime: "image/webp", data: "eA==" },
      reorder_attachments: () => {
        throw new Error("disk full");
      },
    },
  });

  try {
    await ctx.gallery.load("2026-10-23");
    await ctx.gallery.move(b.id, -1);
    assert.deepEqual(ctx.gallery.ids(), [a.id, b.id]);
  } finally {
    ctx.restore();
  }
});

test("adding files flushes text, uploads, and refreshes the sidebar", async () => {
  const saved = {
    id: "c".repeat(32),
    mime: "image/webp",
    width: 1000,
    height: 500,
    size: 12,
    missing: false,
  };
  const ctx = setup({
    invokeTable: {
      list_attachments: [],
      save_attachment: saved,
      get_attachment: { mime: "image/webp", data: "eA==" },
    },
  });
  ctx.gallery = createAttachmentGallery({
    els: ctx.els,
    invoke: ctx.invoke,
    t: ctx.t,
    setStatus: ctx.setStatus,
    confirm: () => true,
    canEdit: () => true,
    isLocked: () => false,
    flushText: ctx.flushText,
    refreshList: ctx.refreshList,
    prepareFile: async () => ({
      mime: "image/webp",
      data: "eA==",
      width: 1000,
      height: 500,
    }),
  });

  try {
    await ctx.gallery.load("2026-10-23");
    await ctx.gallery.addFiles([{ type: "image/png", size: 12 }]);

    assert.equal(ctx.flushText.count(), 1);
    assert.equal(ctx.invoke.argsOf("save_attachment").date, "2026-10-23");
    assert.equal(ctx.invoke.argsOf("save_attachment").width, 1000);
    assert.equal(ctx.invoke.argsOf("save_attachment").height, 500);
    assert.equal(ctx.invoke.calls.filter((c) => c.command === "save_attachment").length, 1);
    assert.equal(ctx.refreshList.count(), 1);
    assert.deepEqual(ctx.gallery.ids(), [saved.id]);
    // The thumbnail uses the bytes we just compressed, not a second decrypt.
    const image = ctx.els.attachmentList.children[0].children[0].children[0];
    assert.equal(image.src, "data:image/webp;base64,eA==");
    assert.equal(
      ctx.invoke.calls.filter((c) => c.command === "get_attachment").length,
      0
    );
  } finally {
    ctx.restore();
  }
});

test("addPaths reads native drop paths before running the normal upload pipeline", async () => {
  const saved = {
    id: "d".repeat(32),
    mime: "image/png",
    width: 10,
    height: 10,
    size: 9,
    missing: false,
  };
  const ctx = setup({
    invokeTable: {
      read_dropped_images: [
        { name: "drop.png", data: Buffer.from("png-bytes").toString("base64") },
      ],
      list_attachments: [],
      save_attachment: saved,
    },
  });
  const prepareFile = spy(async () => ({
    mime: "image/png",
    data: "eA==",
    width: 10,
    height: 10,
  }));
  ctx.gallery = createAttachmentGallery({
    els: ctx.els,
    invoke: ctx.invoke,
    t: ctx.t,
    setStatus: ctx.setStatus,
    confirm: () => true,
    canEdit: () => true,
    isLocked: () => false,
    flushText: ctx.flushText,
    refreshList: ctx.refreshList,
    prepareFile,
  });

  try {
    await ctx.gallery.load("2026-10-23");
    await ctx.gallery.addPaths(["/tmp/drop.png"]);

    assert.deepEqual(ctx.invoke.argsOf("read_dropped_images"), {
      paths: ["/tmp/drop.png"],
    });
    assert.equal(ctx.invoke.argsOf("save_attachment").mime, "image/png");
    assert.equal(prepareFile.args()[0][0].name, "drop.png");
    assert.equal(prepareFile.args()[0][0].type, "image/png");
    assert.deepEqual(ctx.gallery.ids(), [saved.id]);
  } finally {
    ctx.restore();
  }
});

test("addPaths reports a failure when the dropped paths cannot be read", async () => {
  const ctx = setup({
    invokeTable: {
      list_attachments: [],
      read_dropped_images: () => {
        throw new Error("missing file");
      },
    },
  });

  try {
    await ctx.gallery.load("2026-10-23");
    await ctx.gallery.addPaths(["/tmp/gone.png"]);

    assert.equal(ctx.invoke.commands().includes("save_attachment"), false);
    assert.equal(ctx.setStatus.count(), 1);
    assert.match(ctx.setStatus.args()[0][0], /attachments\.failed/);
  } finally {
    ctx.restore();
  }
});

test("clipboardPaths returns image files copied in a file manager", async () => {
  const ctx = setup({
    invokeTable: {
      list_attachments: [],
      read_clipboard_paths: ["/tmp/photo.png", "/tmp/photo.webp"],
    },
  });

  try {
    await ctx.gallery.load("2026-10-23");
    assert.deepEqual(await ctx.gallery.clipboardPaths(), [
      "/tmp/photo.png",
      "/tmp/photo.webp",
    ]);
  } finally {
    ctx.restore();
  }
});

test("clipboardImage asks the backend and wraps the bytes in a File", async () => {
  const ctx = setup({
    invokeTable: {
      list_attachments: [],
      read_clipboard_image: {
        name: "clipboard.png",
        data: Buffer.from("png-bytes").toString("base64"),
      },
    },
  });

  try {
    await ctx.gallery.load("2026-10-23");
    const file = await ctx.gallery.clipboardImage();

    assert.equal(file.name, "clipboard.png");
    assert.equal(file.type, "image/png");
    assert.equal(Buffer.from(await file.arrayBuffer()).toString(), "png-bytes");
  } finally {
    ctx.restore();
  }
});

test("clipboardImage falls back to the browser Clipboard API", async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      userAgent: "Mozilla/5.0",
      clipboard: {
        read: async () => [
          {
            types: ["text/plain", "image/png"],
            getType: async () => new Blob(["browser-png"], { type: "image/png" }),
          },
        ],
      },
    },
  });

  const ctx = setup({
    invokeTable: { list_attachments: [], read_clipboard_image: null },
  });

  try {
    await ctx.gallery.load("2026-10-23");
    const file = await ctx.gallery.clipboardImage();
    assert.equal(file.type, "image/png");
    assert.equal(Buffer.from(await file.arrayBuffer()).toString(), "browser-png");
  } finally {
    ctx.restore();
    if (previous) Object.defineProperty(globalThis, "navigator", previous);
    else delete globalThis.navigator;
  }
});

test("mobile clipboard reads the browser API before the desktop command", async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      userAgent: "Mozilla/5.0 (Linux; Android 15)",
      clipboard: {
        read: async () => [
          {
            types: ["image/png"],
            getType: async () => new Blob(["android-png"], { type: "image/png" }),
          },
        ],
      },
    },
  });

  const ctx = setup({
    invokeTable: {
      list_attachments: [],
      read_clipboard_image: () => {
        throw new Error("native command should not run on mobile");
      },
    },
  });

  try {
    await ctx.gallery.load("2026-10-23");
    const file = await ctx.gallery.clipboardImage();
    assert.equal(Buffer.from(await file.arrayBuffer()).toString(), "android-png");
    assert.equal(
      ctx.invoke.calls.filter((call) => call.command === "read_clipboard_image").length,
      0
    );
  } finally {
    ctx.restore();
    if (previous) Object.defineProperty(globalThis, "navigator", previous);
    else delete globalThis.navigator;
  }
});

test("clipboardImageFromBrowser returns null without the Clipboard API", async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { userAgent: "Mozilla/5.0" },
  });
  try {
    assert.equal(await clipboardImageFromBrowser(), null);
  } finally {
    if (previous) Object.defineProperty(globalThis, "navigator", previous);
    else delete globalThis.navigator;
  }
});

test("clipboardError records a native clipboard failure", async () => {
  const ctx = setup({
    invokeTable: {
      list_attachments: [],
      read_clipboard_image: () => {
        throw new Error("image too large");
      },
    },
  });

  try {
    await ctx.gallery.load("2026-10-23");
    assert.equal(await ctx.gallery.clipboardImage(), null);
    assert.match(ctx.gallery.clipboardError(), /image too large/);
  } finally {
    ctx.restore();
  }
});

test("clipboardImage returns null when the clipboard holds no image", async () => {
  const ctx = setup({
    invokeTable: { list_attachments: [], read_clipboard_image: null },
  });

  try {
    await ctx.gallery.load("2026-10-23");
    assert.equal(await ctx.gallery.clipboardImage(), null);
  } finally {
    ctx.restore();
  }
});

test("read-only entries hide all editing controls", async () => {
  const ctx = setup({
    canEdit: false,
    invokeTable: {
      list_attachments: [
        { id: "a".repeat(32), mime: "image/webp", width: 0, height: 0, size: 1, missing: false },
      ],
      get_attachment: { mime: "image/webp", data: "eA==" },
    },
  });

  try {
    await ctx.gallery.load("2026-10-23");
    assert.equal(ctx.els.attachmentAdd.hidden, true);
    const row = ctx.els.attachmentList.children[0];
    assert.equal(row.children.length, 1); // frame only, no controls
  } finally {
    ctx.restore();
  }
});

test("a locked entry clears and hides the gallery", async () => {
  const ctx = setup({
    locked: true,
    invokeTable: {
      list_attachments: () => {
        throw new Error("should not be called");
      },
    },
  });

  try {
    await ctx.gallery.load("2026-10-23");
    assert.equal(ctx.els.attachments.hidden, true);
    assert.equal(ctx.els.attachmentList.children.length, 0);
    assert.equal(ctx.invoke.calls.length, 0);
  } finally {
    ctx.restore();
  }
});

test("a missing image is marked broken without a decrypt call", async () => {
  const ctx = setup({
    invokeTable: {
      list_attachments: [
        { id: "a".repeat(32), mime: "image/webp", width: 0, height: 0, size: 0, missing: true },
      ],
    },
  });

  try {
    await ctx.gallery.load("2026-10-23");
    await flush();
    const frame = ctx.els.attachmentList.children[0].children[0];
    assert.ok(frame.classList.contains("is-broken"));
    assert.equal(ctx.invoke.calls.filter((c) => c.command === "get_attachment").length, 0);
  } finally {
    ctx.restore();
  }
});

test("clicking remove deletes the image and updates the strip", async () => {
  const item = {
    id: "a".repeat(32),
    mime: "image/webp",
    width: 0,
    height: 0,
    size: 1,
    missing: false,
  };
  const ctx = setup({
    invokeTable: {
      list_attachments: [item],
      get_attachment: { mime: "image/webp", data: "eA==" },
      delete_attachment: null,
    },
  });

  try {
    await ctx.gallery.load("2026-10-23");
    const row = ctx.els.attachmentList.children[0];
    const controls = row.children[1];
    const remove = controls.children[2];
    await ctx.gallery.remove(remove.parentNode.parentNode.dataset.attachmentId);

    assert.equal(ctx.invoke.argsOf("delete_attachment").id, item.id);
    assert.equal(ctx.els.attachmentList.children.length, 0);
    assert.equal(ctx.els.attachmentEmpty.hidden, false);
  } finally {
    ctx.restore();
  }
});

test("the lightbox opens, loads the image, and closes again", async () => {
  const item = {
    id: "a".repeat(32),
    mime: "image/webp",
    width: 0,
    height: 0,
    size: 1,
    missing: false,
  };
  const ctx = setup({
    invokeTable: {
      list_attachments: [item],
      get_attachment: { mime: "image/webp", data: "eA==" },
    },
  });

  try {
    await ctx.gallery.load("2026-10-23");
    await ctx.gallery.openViewer(item.id);
    assert.equal(ctx.els.attachmentViewer.hidden, false);
    assert.equal(ctx.els.attachmentViewerImage.src, "data:image/webp;base64,eA==");
    assert.equal(ctx.gallery.isViewerOpen(), true);

    ctx.gallery.closeViewer();
    assert.equal(ctx.els.attachmentViewer.hidden, true);
    assert.equal(ctx.gallery.isViewerOpen(), false);
  } finally {
    ctx.restore();
  }
});

test("prepareImageFile rejects SVG and oversized inputs before decoding", async () => {
  await assert.rejects(
    prepareImageFile({ type: "image/svg+xml", size: 10 }),
    /raster/
  );
  await assert.rejects(
    prepareImageFile({ type: "image/png", size: MAX_INPUT_BYTES + 1 }),
    /too large/
  );
});

test("handleClick dispatches arrow and remove actions", async () => {
  const ctx = setup({
    invokeTable: {
      list_attachments: [
        { id: "a".repeat(32), mime: "image/webp", width: 0, height: 0, size: 1, missing: false },
        { id: "b".repeat(32), mime: "image/webp", width: 0, height: 0, size: 1, missing: false },
      ],
      get_attachment: { mime: "image/webp", data: "eA==" },
      reorder_attachments: null,
    },
  });

  try {
    await ctx.gallery.load("2026-10-23");
    const row = ctx.els.attachmentList.children[1];
    const left = row.children[1].children[0];
    await ctx.gallery.handleClick({ target: left });
    // handleClick does not await move(); let the reorder land.
    await flush();
    assert.deepEqual(ctx.gallery.ids(), [
      "b".repeat(32),
      "a".repeat(32),
    ]);
  } finally {
    ctx.restore();
  }
});
