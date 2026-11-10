// ---------------------------------------------------------------------------
// Input modality
// ---------------------------------------------------------------------------
//
// WebKitGTK (the Tauri webview on Linux) can match `:focus-visible` after a
// pointer click, which draws the keyboard focus ring on every button. CSS
// cannot fix a pseudo-class that reports the wrong thing, so track the last
// input method here and let the focus selectors filter on it.
//
// The default is "pointer": nothing is highlighted before the user interacts.
// The first keydown switches to "keyboard", so Tab and other keyboard
// navigation still get the visible focus ring.

const POINTER_EVENTS = ["pointerdown", "mousedown", "touchstart"];

/**
 * Start tracking pointer vs keyboard input.
 *
 * `root` is the element that receives the `data-input-modality` attribute;
 * `target` is the event source. Both are injectable so the module can be tested
 * without a browser. Returns a cleanup function.
 */
export function initInputModality({
  root = document.documentElement,
  target = document,
} = {}) {
  let modality = "pointer";
  root.dataset.inputModality = modality;

  const set = (value) => {
    if (modality === value) return;
    modality = value;
    root.dataset.inputModality = value;
  };

  const onPointer = () => set("pointer");
  const onKeyboard = () => set("keyboard");

  // Capture phase, so stopping propagation in a control cannot hide the input
  // method from the focus styles. Pointer events are passive: they only read.
  const pointerOptions = { capture: true, passive: true };
  for (const type of POINTER_EVENTS) {
    target.addEventListener(type, onPointer, pointerOptions);
  }
  target.addEventListener("keydown", onKeyboard, true);

  return () => {
    for (const type of POINTER_EVENTS) {
      target.removeEventListener(type, onPointer, pointerOptions);
    }
    target.removeEventListener("keydown", onKeyboard, true);
  };
}
