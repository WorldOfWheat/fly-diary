// ---------------------------------------------------------------------------
// Idle auto-lock timer
// ---------------------------------------------------------------------------
//
// Kept independent of the DOM and of the lock-screen controller so the timer
// itself can be tested. `main.js` injects the actual lock callback, which is
// important: a bare `lockNow()` in the timeout would throw and silently leave
// the diary unlocked.

/**
 * @param {object} options
 * @param {() => void} options.lock Called once the idle period expires.
 * @param {() => boolean} [options.isUnlocked] Whether the timer should arm.
 * @param {(fn: () => void, ms: number) => unknown} [options.setTimer]
 * @param {(timer: unknown) => void} [options.clearTimer]
 */
export function createAutoLock({
  lock,
  isUnlocked = () => true,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  now = () => Date.now(),
}) {
  let minutes = 0;
  let timer = null;
  /** Wall-clock deadline, used when the webview throttles background timers. */
  let deadline = null;

  function stop() {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
    deadline = null;
  }

  function reset() {
    stop();
    if (!minutes || !isUnlocked()) return;
    const delay = minutes * 60 * 1000;
    deadline = now() + delay;
    timer = setTimer(() => {
      timer = null;
      deadline = null;
      lock();
    }, delay);
  }

  /**
   * Lock now if the deadline already passed while the timer was throttled or
   * the machine was asleep. Returns true when it locked.
   */
  function expireIfDue() {
    if (deadline === null || now() < deadline) return false;
    stop();
    lock();
    return true;
  }

  function setMinutes(next) {
    minutes = Number(next) || 0;
    reset();
  }

  function getMinutes() {
    return minutes;
  }

  return { reset, stop, setMinutes, getMinutes, expireIfDue };
}
