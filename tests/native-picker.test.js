import test from "node:test";
import assert from "node:assert/strict";

import {
  createNativePickerGuard,
  MAX_NATIVE_PICKER_MS,
  NATIVE_PICKER_RETURN_GRACE_MS,
} from "../src/lib/native-picker.js";

function fakeClock(start = 1000) {
  let value = start;
  return {
    now: () => value,
    advance(ms) {
      value += ms;
    },
  };
}

test("a picker suppresses the suspend lock while it is open", () => {
  const clock = fakeClock();
  const guard = createNativePickerGuard({ now: clock.now });

  guard.begin();

  assert.equal(guard.isOpen(), true);
  assert.equal(guard.suppresses(), true);
});

test("closing a picker keeps a short grace period for resumed events", () => {
  const clock = fakeClock();
  const guard = createNativePickerGuard({ now: clock.now });

  guard.begin();
  clock.advance(500);
  guard.end();

  assert.equal(guard.isOpen(), false);
  assert.equal(guard.suppresses(), true);

  clock.advance(NATIVE_PICKER_RETURN_GRACE_MS);
  assert.equal(guard.suppresses(), false);
});

test("a picker that never closes stops suppressing after the maximum", () => {
  const clock = fakeClock();
  const guard = createNativePickerGuard({ now: clock.now });

  guard.begin();
  clock.advance(MAX_NATIVE_PICKER_MS);

  assert.equal(guard.isOpen(), true);
  assert.equal(guard.suppresses(), false);
});

test("ending a picker that was never open is a no-op", () => {
  const clock = fakeClock();
  const guard = createNativePickerGuard({ now: clock.now });

  guard.end();

  assert.equal(guard.isOpen(), false);
  assert.equal(guard.suppresses(), false);
});

test("reset clears both the open and the grace state", () => {
  const clock = fakeClock();
  const guard = createNativePickerGuard({ now: clock.now });

  guard.begin();
  guard.end();
  assert.equal(guard.suppresses(), true);

  guard.reset();

  assert.equal(guard.isOpen(), false);
  assert.equal(guard.suppresses(), false);
});
