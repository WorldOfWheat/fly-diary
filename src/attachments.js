// ---------------------------------------------------------------------------
// Image attachments
// ---------------------------------------------------------------------------
//
// The text editor stays a plain `<textarea>`; images live in a gallery below
// it. The backend stores one encrypted file per image and an encrypted XML
// manifest that holds the display order, so this module never has to touch the
// diary entry format.
//
// `deps` shape:
//
//   els          — the lookup table from `dom.js`
//   invoke       — Tauri invoke
//   t            — i18n lookup
//   setStatus    — global status-line writer
//   confirm      — optional confirm() replacement (tests)
//   canEdit      — () => whether images may be added/removed/reordered
//   isLocked     — () => whether the entry file is undecryptable
//   flushText    — async () => flush the pending autosave before uploading
//   refreshList  — async ({ scanBroken }) => refresh the sidebar
//   onEntryChanged — refresh header actions after the first image creates an entry
//   prepareFile  — optional (file) => { mime, data, width, height } for tests

/** Longest edge of the stored image, in pixels. */
export const MAX_LONG_EDGE = 1000;
/** WebP quality used for the stored image. */
export const WEBP_QUALITY = 0.8;
/** Largest input file accepted before decoding. */
export const MAX_INPUT_BYTES = 64 * 1024 * 1024;
/** Images compressed concurrently before they are saved in selection order. */
const ATTACHMENT_PREPARE_CONCURRENCY = 3;

// Keeps an unloaded thumbnail visually empty instead of making the browser
// render the `alt` text as an "IMAGE" placeholder.
const TRANSPARENT_PIXEL =
  "data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=";

/** Reject a promise after `ms` so a broken clipboard backend cannot hang the UI. */
function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out`)),
      ms
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

/** Scale `width`/`height` so the longest edge is at most `maxEdge`. */
export function targetDimensions(width, height, maxEdge = MAX_LONG_EDGE) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return { width: 0, height: 0 };
  }
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** Build a data URL from the base64 the backend returns. */
export function attachmentDataUrl(mime, base64) {
  return `data:${mime || "application/octet-stream"};base64,${base64}`;
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    if (typeof canvas.toBlob === "function") {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error("Image encoding returned no data"));
      }, type, quality);
      return;
    }
    if (typeof canvas.convertToBlob === "function") {
      canvas
        .convertToBlob({ type, quality })
        .then(resolve, reject);
      return;
    }
    reject(new Error("This webview cannot encode images"));
  });
}

function blobToBase64(blob) {
  return blob.arrayBuffer().then((buffer) => {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  });
}

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** Wrap base64 image bytes in a `File` so the normal upload path can read them. */
function imageFileFromBase64(item) {
  const name = item?.name || "image";
  return new File([base64ToBytes(item.data)], name, {
    type: imageTypeForFile({ name }),
  });
}

function prefersBrowserClipboard() {
  return /Android|iPhone|iPad|iPod/i.test(globalThis.navigator?.userAgent || "");
}

function fileFromClipboardBlob(blob, type) {
  const extension = (type.split("/")[1] || "png").split("+")[0];
  return new File([blob], `clipboard.${extension}`, { type });
}

/**
 * Read an image through the Async Clipboard API.
 *
 * This is the fallback for mobile and other WebViews where the native
 * `read_clipboard_image` command is unavailable. It needs a user gesture, so
 * callers invoke it directly from the paste handler (or a button).
 */
export async function clipboardImageFromBrowser() {
  const clipboard = globalThis.navigator?.clipboard;
  if (typeof clipboard?.read !== "function") return null;
  try {
    const items = await withTimeout(
      clipboard.read(),
      5000,
      "navigator.clipboard.read"
    );
    for (const item of items) {
      const type = (item.types || []).find((candidate) =>
        candidate.startsWith("image/")
      );
      if (!type) continue;
      const blob = await item.getType(type);
      if (blob) return fileFromClipboardBlob(blob, type);
    }
  } catch (err) {
    console.error("navigator.clipboard.read failed:", err);
  }
  return null;
}

/** Best-effort MIME for files from Linux drag/drop, where `type` is often empty. */
export function imageTypeForFile(file) {
  if (file?.type?.startsWith("image/")) return file.type;
  const name = String(file?.name || "").toLowerCase();
  if (name.endsWith(".png")) return "image/png";
  if (name.endsWith(".jpg") || name.endsWith(".jpeg")) return "image/jpeg";
  if (name.endsWith(".webp")) return "image/webp";
  if (name.endsWith(".gif")) return "image/gif";
  if (name.endsWith(".bmp")) return "image/bmp";
  if (name.endsWith(".tif") || name.endsWith(".tiff")) return "image/tiff";
  if (name.endsWith(".avif")) return "image/avif";
  return file?.type || "";
}

/** Decode a file into something drawable, honouring EXIF orientation. */
async function decodeImage(file) {
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(file, { imageOrientation: "from-image" });
    } catch {
      try {
        return await createImageBitmap(file);
      } catch {
        // Fall through to the <img> path; older WebKit builds lack options.
      }
    }
  }

  if (typeof Image !== "function" || typeof URL?.createObjectURL !== "function") {
    throw new Error("This webview cannot decode images");
  }

  const url = URL.createObjectURL(file);
  try {
    return await new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("Could not decode this image"));
      image.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Decode, resize to `MAX_LONG_EDGE`, and encode as WebP (or a fallback). */
export async function prepareImageFile(file) {
  const type = imageTypeForFile(file);
  if (!type.startsWith("image/") || type === "image/svg+xml") {
    throw new Error("Only raster images are supported");
  }
  if (file.size > MAX_INPUT_BYTES) {
    throw new Error("Image is too large");
  }

  const source = await decodeImage(file);
  try {
    const width = source.width;
    const height = source.height;
    const target = targetDimensions(width, height);
    if (!target.width || !target.height) {
      throw new Error("Image has no usable dimensions");
    }

    const canvas = document.createElement("canvas");
    canvas.width = target.width;
    canvas.height = target.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Could not create a drawing context");
    context.drawImage(source, 0, 0, target.width, target.height);

    let blob = await canvasToBlob(canvas, "image/webp", WEBP_QUALITY);
    if (blob.type !== "image/webp") {
      // WebKit builds that cannot encode WebP fall back to PNG for sources
      // that may have transparency, and to JPEG otherwise. JPEG needs a white
      // backdrop or transparent areas turn black.
      if (file.type === "image/png" || file.type === "image/webp") {
        const png = await canvasToBlob(canvas, "image/png");
        if (png.type === "image/png") blob = png;
      }
      if (blob.type !== "image/png") {
        const fallback = document.createElement("canvas");
        fallback.width = target.width;
        fallback.height = target.height;
        const fallbackContext = fallback.getContext("2d");
        if (!fallbackContext) throw new Error("Could not create a drawing context");
        fallbackContext.fillStyle = "#ffffff";
        fallbackContext.fillRect(0, 0, target.width, target.height);
        fallbackContext.drawImage(canvas, 0, 0);
        blob = await canvasToBlob(fallback, "image/jpeg", 0.85);
      }
    }

    return {
      mime: blob.type,
      data: await blobToBase64(blob),
      width: target.width,
      height: target.height,
    };
  } finally {
    source.close?.();
  }
}

/**
 * Create the attachment gallery controller.
 */
export function createAttachmentGallery(deps) {
  const { els } = deps;
  const confirm = deps.confirm || ((message) => globalThis.confirm?.(message));

  /** Metadata in display order. */
  let items = [];
  /** Date whose gallery is loaded. */
  let currentDate = "";
  /** In-flight upload/delete/reorder operation. */
  let busy = false;
  /** Monotonic token so a slow `list_attachments` cannot overwrite a newer date. */
  let loadToken = 0;
  /** Decrypted image data URLs, keyed by id. */
  const imageCache = new Map();
  /** Image elements from the last render, so async loads can fill them in. */
  let imageNodes = new Map();
  /** Ids with an in-flight decrypt, to de-duplicate observer callbacks. */
  const loadingIds = new Set();
  /** Lazily decrypts images as the horizontal strip scrolls. */
  let observer = null;
  /** Last native clipboard read error, if any. */
  let clipboardErrorText = "";
  /** Id being dragged, if any. */
  let draggedId = null;

  const has = (name) => Boolean(els[name]);

  function editable() {
    return Boolean(currentDate) && deps.canEdit() && !busy;
  }

  function setLocalStatus(text) {
    if (has("attachmentStatus")) els.attachmentStatus.textContent = text || "";
  }

  function itemElement(target) {
    let node = target;
    while (node && node !== els.attachmentList) {
      if (node.dataset?.attachmentId) return node;
      node = node.parentNode;
    }
    return null;
  }

  function itemId(target) {
    return itemElement(target)?.dataset.attachmentId || null;
  }

  function markBroken(frame, node, broken) {
    frame?.classList.add("is-broken");
    frame?.setAttribute?.("aria-label", deps.t("attachments.broken"));
    if (node) {
      node.alt = "";
      node.src = TRANSPARENT_PIXEL;
    }
    if (broken) broken.hidden = false;
  }

  function resetImageLoading() {
    observer?.disconnect();
    observer = null;
    loadingIds.clear();
  }

  function ensureObserver() {
    if (typeof IntersectionObserver !== "function" || !els.attachmentList) {
      return null;
    }
    if (!observer) {
      observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            const id = entry.target?.dataset?.attachmentId;
            observer?.unobserve(entry.target);
            if (!id) continue;
            const item = items.find((candidate) => candidate.id === id);
            if (item) loadImage(item);
          }
        },
        { root: els.attachmentList, rootMargin: "300px" }
      );
    }
    return observer;
  }

  async function loadImage(item) {
    const token = loadToken;
    let node = imageNodes.get(item.id);
    let frame = node?.parentNode;
    let broken = frame?.querySelector?.(".attachment-broken");
    if (!node) return;

    if (item.missing) {
      markBroken(frame, node, broken);
      return;
    }

    const cached = imageCache.get(item.id);
    if (cached) {
      node.src = cached;
      return;
    }
    if (loadingIds.has(item.id)) return;
    loadingIds.add(item.id);

    try {
      const data = await deps.invoke("get_attachment", {
        date: currentDate,
        id: item.id,
      });
      if (token !== loadToken) return;
      const url = attachmentDataUrl(data.mime, data.data);
      imageCache.set(item.id, url);

      // A render may have replaced the DOM while the decrypt was running.
      node = imageNodes.get(item.id);
      frame = node?.parentNode;
      broken = frame?.querySelector?.(".attachment-broken");
      if (node) node.src = url;
    } catch (err) {
      if (token !== loadToken) return;
      console.error("get_attachment failed:", err);
      node = imageNodes.get(item.id);
      frame = node?.parentNode;
      broken = frame?.querySelector?.(".attachment-broken");
      if (node) markBroken(frame, node, broken);
    } finally {
      loadingIds.delete(item.id);
    }
  }

  function render() {
    if (!has("attachmentList")) return;

    const locked = deps.isLocked();
    if (has("attachments")) {
      els.attachments.hidden = !currentDate || locked;
    }

    imageNodes = new Map();
    observer?.disconnect();
    const lazyObserver = ensureObserver();
    const fragment = document.createDocumentFragment();
    items.forEach((item, index) => {
      const row = document.createElement("div");
      row.className = "attachment-item";
      row.dataset.attachmentId = item.id;
      row.dataset.index = String(index);
      row.draggable = editable();
      row.setAttribute("role", "listitem");

      const frame = document.createElement("button");
      frame.type = "button";
      frame.className = "attachment-frame";
      frame.setAttribute(
        "aria-label",
        item.missing
          ? deps.t("attachments.broken")
          : deps.t("attachments.viewerLabel", { n: index + 1 })
      );
      if (item.missing) frame.classList.add("is-broken");

      const image = document.createElement("img");
      image.className = "attachment-thumb";
      // The frame button carries the accessible label, so the thumbnail is
      // decorative. An empty alt also avoids the "IMAGE" text browsers show
      // before a src is available.
      image.alt = "";
      image.draggable = false;
      image.src = TRANSPARENT_PIXEL;
      const cached = imageCache.get(item.id);
      if (cached) image.src = cached;

      const broken = document.createElement("span");
      broken.className = "attachment-broken";
      broken.textContent = "!";
      broken.title = deps.t("attachments.broken");
      broken.hidden = !item.missing;

      frame.append(image, broken);
      row.append(frame);
      imageNodes.set(item.id, image);

      if (editable()) {
        const controls = document.createElement("div");
        controls.className = "attachment-controls";

        const left = document.createElement("button");
        left.className = "attachment-control";
        left.type = "button";
        left.dataset.action = "left";
        left.textContent = "‹";
        left.title = deps.t("attachments.moveLeft");
        left.setAttribute("aria-label", deps.t("attachments.moveLeft"));

        const right = document.createElement("button");
        right.className = "attachment-control";
        right.type = "button";
        right.dataset.action = "right";
        right.textContent = "›";
        right.title = deps.t("attachments.moveRight");
        right.setAttribute("aria-label", deps.t("attachments.moveRight"));

        const remove = document.createElement("button");
        remove.className = "attachment-control attachment-remove";
        remove.type = "button";
        remove.dataset.action = "remove";
        remove.textContent = "×";
        remove.title = deps.t("attachments.remove");
        remove.setAttribute("aria-label", deps.t("attachments.remove"));

        controls.append(left, right, remove);
        row.append(controls);
      }

      fragment.append(row);
    });

    els.attachmentList.replaceChildren(fragment);
    if (has("attachmentEmpty")) els.attachmentEmpty.hidden = items.length > 0;
    if (has("attachmentAdd")) {
      els.attachmentAdd.hidden = !editable();
      els.attachmentAdd.disabled = !editable();
    }
    // Paste stays available in a read-only entry: pasting is an explicit edit
    // gesture and main.js unlocks the entry before uploading. Only a broken
    // entry (whole section hidden) or an in-flight operation disables it.
    if (has("attachmentPaste")) els.attachmentPaste.disabled = busy;
    if (has("attachmentInput")) els.attachmentInput.disabled = !editable();

    // Decrypt lazily as the strip scrolls, but eager-load the first screenful
    // so a normal day's gallery never shows blank frames while waiting for the
    // observer. WebViews without IntersectionObserver load everything.
    const eagerLimit = 12;
    let eager = 0;
    for (const item of items) {
      if (item.missing || imageCache.has(item.id)) continue;
      const node = imageNodes.get(item.id);
      if (lazyObserver && node && eager >= eagerLimit) {
        lazyObserver.observe(node);
      } else {
        eager += 1;
        loadImage(item);
      }
    }
  }

  /** Load the gallery for `date`, replacing whatever was on screen. */
  async function load(date) {
    currentDate = date || "";
    items = [];
    imageCache.clear();
    loadToken += 1;
    resetImageLoading();
    closeViewer();
    render();
    setLocalStatus("");

    if (!currentDate || deps.isLocked()) return;

    const token = loadToken;
    try {
      const found = await deps.invoke("list_attachments", { date: currentDate });
      if (token !== loadToken) return;
      items = Array.isArray(found) ? found : [];
      render();
    } catch (err) {
      if (token !== loadToken) return;
      console.error("list_attachments failed:", err);
      setLocalStatus(deps.t("attachments.loadFailed"));
    }
  }

  function clear() {
    loadToken += 1;
    currentDate = "";
    items = [];
    imageCache.clear();
    imageNodes = new Map();
    resetImageLoading();
    draggedId = null;
    busy = false;
    closeViewer();
    render();
    setLocalStatus("");
  }

  function setLocked(locked) {
    if (locked) {
      // Keep `currentDate`: the date label and the locked editor still refer to
      // this day. Only the images and their controls are cleared.
      loadToken += 1;
      items = [];
      imageCache.clear();
      imageNodes = new Map();
      resetImageLoading();
      draggedId = null;
      busy = false;
      closeViewer();
      render();
      if (has("attachments")) els.attachments.hidden = true;
      setLocalStatus("");
    } else {
      render();
    }
  }

  function setReadOnly() {
    render();
  }

  function refreshForLocale() {
    render();
  }

  function pickFile() {
    if (!editable() || !has("attachmentInput")) return;
    els.attachmentInput.value = "";
    els.attachmentInput.click();
  }

  async function prepareOne(file) {
    const prepare = deps.prepareFile || prepareImageFile;
    const prepared = await prepare(file);
    if (!prepared || !prepared.data || !prepared.mime) {
      throw new Error("Image preparation failed");
    }
    return prepared;
  }

  async function savePrepared(prepared, date) {
    const meta = await deps.invoke("save_attachment", {
      date,
      mime: prepared.mime,
      data: prepared.data,
      width: prepared.width || 0,
      height: prepared.height || 0,
    });
    return {
      meta,
      // The compressed bytes are already in memory. Reuse them for the
      // thumbnail instead of asking the backend to decrypt what we just wrote.
      previewUrl: attachmentDataUrl(prepared.mime, prepared.data),
    };
  }

  /**
   * Add every selected file, reporting per-file failures.
   *
   * Image decoding/resizing/encoding is the expensive part and happens in the
   * webview, so a small chunk is prepared in parallel. Saves stay sequential:
   * the backend serialises manifest writes anyway, and keeping the save order
   * means the new images are appended in the order the user selected them.
   */
  async function addFiles(fileList) {
    if (!editable()) return 0;
    const files = Array.from(fileList || []);
    if (files.length === 0) return 0;

    const date = currentDate;
    const total = files.length;
    busy = true;
    render();
    let done = 0;
    let failed = 0;
    const showProgress = () =>
      setLocalStatus(deps.t("attachments.uploading", { done, total }));
    showProgress();
    deps.setStatus?.(deps.t("attachments.uploading", { done, total }));

    try {
      await deps.flushText?.();
      for (let start = 0; start < total; start += ATTACHMENT_PREPARE_CONCURRENCY) {
        if (currentDate !== date) break;
        const chunk = files.slice(start, start + ATTACHMENT_PREPARE_CONCURRENCY);
        const prepared = await Promise.all(
          chunk.map(async (file) => {
            try {
              return { prepared: await prepareOne(file) };
            } catch (err) {
              console.error("prepare attachment failed:", err);
              return { error: err };
            }
          })
        );

        for (const result of prepared) {
          if (currentDate !== date) break;
          if (result.error) {
            failed += 1;
            showProgress();
            continue;
          }
          try {
            const { meta, previewUrl } = await savePrepared(result.prepared, date);
            if (currentDate === date) {
              imageCache.set(meta.id, previewUrl);
              items.push(meta);
              render();
            }
            done += 1;
          } catch (err) {
            console.error("save_attachment failed:", err);
            failed += 1;
          }
          showProgress();
        }
      }
    } finally {
      busy = false;
      render();
    }

    if (done > 0) {
      await deps.refreshList?.({ scanBroken: false });
      // Adding the first image to a blank date creates the entry on the
      // backend. The header's delete/favourite buttons depend on that fact.
      deps.onEntryChanged?.();
      deps.setStatus?.(deps.t("attachments.saved", { n: done }), true);
    }
    if (failed > 0) {
      deps.setStatus?.(deps.t("attachments.failed", { n: failed }));
    }
    setLocalStatus("");
    return done;
  }

  /**
   * Add images the OS dropped as filesystem paths.
   *
   * Native drag-drop hands the webview paths, not `File` objects (and on Linux
   * `dataTransfer.files` is often empty). The backend reads the bytes; wrapping
   * them in `File` objects here means the drop goes through exactly the same
   * resize/EXIF-stripping/encrypt path as the file picker.
   */
  async function addPaths(paths) {
    if (!editable()) return false;
    const list = Array.from(paths || []);
    if (list.length === 0) return false;

    let dropped;
    try {
      dropped = await deps.invoke("read_dropped_images", { paths: list });
    } catch (err) {
      console.error("read_dropped_images failed:", err);
      deps.setStatus?.(deps.t("attachments.failed", { n: list.length }));
      return false;
    }

    const files = [];
    for (const item of dropped || []) {
      try {
        files.push(imageFileFromBase64(item));
      } catch (err) {
        console.error("Could not read a dropped image:", err);
      }
    }

    if (files.length === 0) {
      deps.setStatus?.(deps.t("attachments.failed", { n: list.length }));
      return false;
    }
    return (await addFiles(files)) > 0;
  }

  /**
   * Read an image from the OS clipboard and wrap it as a `File`.
   *
   * Returns `null` when the clipboard has no image, which is the normal case
   * for text paste. The caller decides whether a read-only entry should be
   * unlocked, so no upload happens here.
   */
  async function nativeClipboardImage() {
    let image;
    try {
      image = await withTimeout(
        deps.invoke("read_clipboard_image"),
        5000,
        "read_clipboard_image"
      );
    } catch (err) {
      console.error("read_clipboard_image failed:", err);
      clipboardErrorText = err?.message || String(err);
      return null;
    }
    if (!image) return null;
    try {
      return imageFileFromBase64(image);
    } catch (err) {
      console.error("Could not read the clipboard image:", err);
      return null;
    }
  }

  /** Copied image files (file manager), not a clipboard bitmap. */
  async function clipboardPaths() {
    if (!currentDate) return [];
    try {
      const paths = await withTimeout(
        deps.invoke("read_clipboard_paths"),
        3000,
        "read_clipboard_paths"
      );
      return Array.isArray(paths) ? paths : [];
    } catch (err) {
      console.error("read_clipboard_paths failed:", err);
      return [];
    }
  }

  async function clipboardImage() {
    clipboardErrorText = "";
    if (!currentDate) return null;

    // On mobile the native command is desktop-only, and the Clipboard API
    // needs the transient user activation from the paste event; try it first.
    if (prefersBrowserClipboard()) {
      const browserImage = await clipboardImageFromBrowser();
      if (browserImage) return browserImage;
      return nativeClipboardImage();
    }

    const nativeImage = await nativeClipboardImage();
    if (nativeImage) return nativeImage;
    return clipboardImageFromBrowser();
  }

  async function persistOrder(previous) {
    try {
      await deps.invoke("reorder_attachments", {
        date: currentDate,
        ids: items.map((item) => item.id),
      });
      deps.setStatus?.(deps.t("attachments.reordered"), true);
    } catch (err) {
      console.error("reorder_attachments failed:", err);
      items = previous;
      render();
      deps.setStatus?.(deps.t("attachments.reorderFailed"));
    }
  }

  async function moveTo(id, targetIndex) {
    if (!editable()) return;
    const from = items.findIndex((item) => item.id === id);
    if (from < 0) return;
    const to = Math.max(0, Math.min(items.length - 1, targetIndex));
    if (to === from) return;
    const previous = items.slice();
    const [moved] = items.splice(from, 1);
    items.splice(to, 0, moved);
    render();
    await persistOrder(previous);
  }

  function move(id, delta) {
    const index = items.findIndex((item) => item.id === id);
    if (index < 0) return;
    return moveTo(id, index + delta);
  }

  async function remove(id) {
    if (!editable()) return;
    const item = items.find((candidate) => candidate.id === id);
    if (!item) return;
    if (!confirm(deps.t("attachments.deleteConfirm"))) return;

    busy = true;
    render();
    try {
      await deps.invoke("delete_attachment", { date: currentDate, id });
      items = items.filter((candidate) => candidate.id !== id);
      imageCache.delete(id);
      deps.setStatus?.(deps.t("attachments.deleted"), true);
    } catch (err) {
      console.error("delete_attachment failed:", err);
      deps.setStatus?.(deps.t("attachments.deleteFailed"));
    } finally {
      busy = false;
      render();
    }
  }

  function handleClick(event) {
    const id = itemId(event.target);
    if (!id) return;
    const action = event.target?.dataset?.action;
    if (action === "remove") {
      remove(id);
    } else if (action === "left") {
      move(id, -1);
    } else if (action === "right") {
      move(id, 1);
    } else {
      openViewer(id);
    }
  }

  function handleDragStart(event) {
    if (!editable()) return;
    const id = itemId(event.target);
    if (!id) return;
    draggedId = id;
    event.dataTransfer?.setData?.("text/plain", id);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
  }

  function handleDragOver(event) {
    if (!draggedId || !editable()) return;
    event.preventDefault?.();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
  }

  async function handleDrop(event) {
    if (!draggedId || !editable()) return;
    event.preventDefault?.();
    const targetId = itemId(event.target);
    const dragged = draggedId;
    draggedId = null;
    if (!targetId || targetId === dragged) return;
    const targetIndex = items.findIndex((item) => item.id === targetId);
    if (targetIndex < 0) return;
    await moveTo(dragged, targetIndex);
  }

  function handleDragEnd() {
    draggedId = null;
  }

  async function openViewer(id) {
    if (!has("attachmentViewer")) return;
    const item = items.find((candidate) => candidate.id === id);
    if (!item || item.missing) return;
    let url = imageCache.get(id);
    if (!url) {
      try {
        const data = await deps.invoke("get_attachment", {
          date: currentDate,
          id,
        });
        url = attachmentDataUrl(data.mime, data.data);
        imageCache.set(id, url);
        const node = imageNodes.get(id);
        if (node) node.src = url;
      } catch (err) {
        console.error("get_attachment failed:", err);
        return;
      }
    }
    els.attachmentViewer.hidden = false;
    els.attachmentViewerImage.src = url;
    els.attachmentViewerImage.alt = deps.t("attachments.viewerAlt");
    els.attachmentViewerClose?.focus?.();
  }

  function closeViewer() {
    if (!has("attachmentViewer")) return;
    els.attachmentViewer.hidden = true;
    if (els.attachmentViewerImage) els.attachmentViewerImage.src = "";
  }

  function isViewerOpen() {
    return has("attachmentViewer") ? !els.attachmentViewer.hidden : false;
  }

  return {
    load,
    clear,
    setLocked,
    setReadOnly,
    refreshForLocale,
    pickFile,
    canEdit: () => editable(),
    addFiles,
    addPaths,
    clipboardPaths,
    clipboardImage,
    clipboardError: () => clipboardErrorText,
    remove,
    move,
    moveTo,
    handleClick,
    handleDragStart,
    handleDragOver,
    handleDrop,
    handleDragEnd,
    openViewer,
    closeViewer,
    isViewerOpen,
    /** Test-only view of the current order. */
    ids: () => items.map((item) => item.id),
  };
}
