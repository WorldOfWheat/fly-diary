import test from "node:test";
import assert from "node:assert/strict";

import { createAutoLock } from "../src/lib/auto-lock.js";

function harness({ unlocked = true } = {}) {
  let scheduled = null;
  const cleared = [];
  let locks = 0;
  let clock = 1_000;
  const isUnlocked =
    typeof unlocked === "function" ? unlocked : () => unlocked;

  const autoLock = createAutoLock({
    lock: () => {
      locks += 1;
    },
    isUnlocked,
    setTimer: (fn, ms) => {
      scheduled = { fn, ms, id: Symbol("timer") };
      return scheduled.id;
    },
    clearTimer: (id) => {
      cleared.push(id);
      if (scheduled?.id === id) scheduled = null;
    },
    now: () => clock,
  });

  return {
    autoLock,
    get scheduled() {
      return scheduled;
    },
    cleared,
    get locks() {
      return locks;
    },
    advance(ms) {
      clock += ms;
    },
    fire() {
      const timer = scheduled;
      scheduled = null;
      timer.fn();
    },
    /** Simulate a webview that suspended the timer while backgrounded. */
    suppress() {
      scheduled = null;
    },
  };
}

test("arming the timer schedules the configured number of minutes", () => {
  const h = harness();

  h.autoLock.setMinutes(1);
  assert.equal(h.scheduled.ms, 60_000);

  h.autoLock.setMinutes(30);
  assert.equal(h.scheduled.ms, 30 * 60_000);
  assert.equal(h.autoLock.getMinutes(), 30);
});

test("the timeout locks through the injected callback", () => {
  const h = harness();

  h.autoLock.setMinutes(5);
  h.fire();

  assert.equal(h.locks, 1);
});

test("zero disables the timer", () => {
  const h = harness();

  h.autoLock.setMinutes(5);
  const previous = h.scheduled.id;
  h.autoLock.setMinutes(0);

  assert.equal(h.autoLock.getMinutes(), 0);
  assert.equal(h.scheduled, null);
  assert.deepEqual(h.cleared, [previous]);
});

test("a locked app does not schedule a timer", () => {
  const h = harness({ unlocked: false });

  h.autoLock.setMinutes(5);

  assert.equal(h.scheduled, null);
});

test("resetting replaces the previous timeout", () => {
  const h = harness();

  h.autoLock.setMinutes(5);
  const first = h.scheduled.id;
  h.autoLock.reset();

  assert.deepEqual(h.cleared, [first]);
  assert.notEqual(h.scheduled.id, first);
});

test("stopping clears a pending timeout", () => {
  const h = harness();

  h.autoLock.setMinutes(5);
  const id = h.scheduled.id;
  h.autoLock.stop();

  assert.deepEqual(h.cleared, [id]);
  assert.equal(h.scheduled, null);
});

test("non-numeric durations fall back to off", () => {
  const h = harness();

  h.autoLock.setMinutes("nope");

  assert.equal(h.autoLock.getMinutes(), 0);
  assert.equal(h.scheduled, null);
});

test("a throttled timer locks on the first check after its deadline", () => {
  const h = harness();

  h.autoLock.setMinutes(1);
  assert.equal(h.autoLock.expireIfDue(), false);

  // The webview suppressed the timeout while it was in the background.
  h.advance(60_000);

  assert.equal(h.autoLock.expireIfDue(), true);
  assert.equal(h.locks, 1);
  // A second activity event does not lock twice.
  assert.equal(h.autoLock.expireIfDue(), false);
  assert.equal(h.locks, 1);
});

test("resuming before the deadline re-arms the remaining time", () => {
  const h = harness();

  h.autoLock.setMinutes(5);
  h.advance(2 * 60_000);
  h.suppress();

  assert.equal(h.autoLock.resume(), false);
  // 3 minutes left, not a fresh 5-minute interval.
  assert.equal(h.scheduled.ms, 3 * 60_000);
  assert.equal(h.locks, 0);
});

test("resuming after the deadline locks immediately", () => {
  const h = harness();

  h.autoLock.setMinutes(5);
  h.advance(5 * 60_000);
  h.suppress();

  assert.equal(h.autoLock.resume(), true);
  assert.equal(h.locks, 1);
  assert.equal(h.scheduled, null);
});

test("resuming with a live timer keeps the original deadline", () => {
  const h = harness();

  h.autoLock.setMinutes(5);
  const id = h.scheduled.id;
  h.advance(60_000);

  assert.equal(h.autoLock.resume(), false);
  assert.notEqual(h.scheduled.id, id);
  assert.equal(h.scheduled.ms, 4 * 60_000);
  assert.deepEqual(h.cleared, [id]);
  assert.equal(h.locks, 0);
});

test("resume does nothing when auto-lock is off", () => {
  const h = harness();

  h.autoLock.setMinutes(0);

  assert.equal(h.autoLock.resume(), false);
  assert.equal(h.scheduled, null);
  assert.equal(h.locks, 0);
});

test("resume does nothing while the app is locked", () => {
  let unlocked = true;
  const h = harness({ unlocked: () => unlocked });
  h.autoLock.setMinutes(5);
  unlocked = false;

  assert.equal(h.autoLock.resume(), false);
  assert.equal(h.locks, 0);
});

test("expireIfDue does nothing when auto-lock is off", () => {
  const h = harness();

  h.autoLock.setMinutes(0);
  h.advance(24 * 60 * 60_000);

  assert.equal(h.autoLock.expireIfDue(), false);
  assert.equal(h.locks, 0);
});
