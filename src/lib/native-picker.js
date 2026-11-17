// ---------------------------------------------------------------------------
// Native picker guard
// ---------------------------------------------------------------------------
//
// The HTML file picker and Android's SAF folder picker move the webview to the
// background. The suspend-lock listeners must not treat that as the user
// leaving the diary, or returning from a picker lands on the lock screen.
//
// A picker is bounded: `suppresses()` stops suppressing after `maxOpenMs` in
// case the picker never reports that it closed. A short grace period after
// `end()` also covers the `tauri://resumed` event that can arrive around the
// same time as the visible `visibilitychange`.

export const MAX_NATIVE_PICKER_MS = 2 * 60 * 1000;
export const NATIVE_PICKER_RETURN_GRACE_MS = 2000;

export function createNativePickerGuard({
  now = () => Date.now(),
  maxOpenMs = MAX_NATIVE_PICKER_MS,
  graceMs = NATIVE_PICKER_RETURN_GRACE_MS,
} = {}) {
  let open = false;
  let openedAt = 0;
  let closedAt = 0;

  function begin() {
    open = true;
    openedAt = now();
  }

  function end() {
    if (!open) return;
    open = false;
    closedAt = now();
  }

  function isOpen() {
    return open;
  }

  function suppresses(time = now()) {
    if (open) return time - openedAt < maxOpenMs;
    return closedAt !== 0 && time - closedAt < graceMs;
  }

  function reset() {
    open = false;
    openedAt = 0;
    closedAt = 0;
  }

  return { begin, end, isOpen, suppresses, reset };
}

export const nativePickerGuard = createNativePickerGuard();
