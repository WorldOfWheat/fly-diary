// ---------------------------------------------------------------------------
// Native file drop
// ---------------------------------------------------------------------------
//
// Tauri's native drag-drop handler is the reliable way to receive OS file
// drags. WebKitGTK often leaves `dataTransfer.files` empty (offering only
// `text/uri-list`), so an HTML5 drop handler can show the drop outline and then
// find nothing to upload. Native events always carry filesystem paths.
//
// This module only decides *where* the drag is and forwards the paths. Reading
// the files and updating the gallery stays with the caller, which keeps the
// module testable without a live webview.
//
// `deps` shape:
//
//   getCurrentWebview — () => Tauri webview, or undefined outside Tauri
//   editor            — element that accepts drops
//   canDrop           — () => whether the current entry may receive images
//   onDrop            — (paths: string[]) => void
//   devicePixelRatio  — optional () => number (tests)

export function createNativeFileDrop(deps) {
  const { editor, getCurrentWebview, canDrop, onDrop } = deps;
  const dpr = deps.devicePixelRatio || (() => globalThis.devicePixelRatio || 1);

  let unlisten = null;
  let dragging = false;

  function setDragging(on) {
    if (dragging === on) return;
    dragging = on;
    if (!editor?.classList) return;
    if (on) editor.classList.add("is-dragover");
    else editor.classList.remove("is-dragover");
  }

  function overEditor(position) {
    if (!position) return false;
    const rect = editor?.getBoundingClientRect?.();
    if (!rect) return false;
    const scale = dpr() || 1;
    const x = position.x / scale;
    const y = position.y / scale;
    return (
      x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom
    );
  }

  function handle(event) {
    const payload = event?.payload || {};
    switch (payload.type) {
      case "enter":
      case "over":
        setDragging(Boolean(canDrop?.()) && overEditor(payload.position));
        break;
      case "drop": {
        const inside = overEditor(payload.position);
        setDragging(false);
        if (inside && Array.isArray(payload.paths) && payload.paths.length > 0) {
          onDrop?.(payload.paths);
        }
        break;
      }
      case "leave":
        setDragging(false);
        break;
      default:
        break;
    }
  }

  /** Subscribe to native drag-drop events. Returns false when unavailable. */
  async function start() {
    if (unlisten) return true;
    let webview;
    try {
      webview = getCurrentWebview?.();
    } catch {
      return false;
    }
    if (typeof webview?.onDragDropEvent !== "function") return false;

    unlisten = await webview.onDragDropEvent(handle);
    return true;
  }

  async function stop() {
    setDragging(false);
    const off = unlisten;
    unlisten = null;
    if (off) await off();
  }

  return {
    start,
    stop,
    isDragging: () => dragging,
  };
}
