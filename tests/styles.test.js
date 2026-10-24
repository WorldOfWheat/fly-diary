// ---------------------------------------------------------------------------
// Stylesheet invariants
// ---------------------------------------------------------------------------
//
// The DOM stub used by the other tests does not evaluate CSS, so a rule that
// makes a `hidden` element visible is invisible to them. That is exactly how
// the calendar overlay once shipped: `.calendar-overlay { display: flex }`
// outranked the UA rule `[hidden] { display: none }` (same specificity, but
// author styles win), so the overlay stayed laid out from first paint. Being
// `position: fixed; inset: 0`, it then swallowed every click in the app while
// looking completely absent.
//
// These tests read the stylesheet as text and assert the shape that keeps the
// two states mutually exclusive.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const rawCss = readFileSync(join(root, "src/styles.css"), "utf8");

/**
 * Remove `/* ... *\/` comments.
 *
 * This has to happen before parsing: the stylesheet documents the `hidden`
 * trap with snippets like `` `[hidden] { display: none }` ``, and a brace
 * inside a comment would otherwise be mistaken for the start of a rule body.
 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "");
}

const css = stripComments(rawCss);

/**
 * Split the stylesheet into top-level rules.
 *
 * Only the flat rules matter here: the selectors we care about are declared at
 * the top level, and skipping at-rule bodies keeps the parser small. Nested
 * blocks (media queries) are dropped rather than descended into.
 */
function topLevelRules(source) {
  const rules = [];
  let start = 0;

  for (let i = 0; i < source.length; i += 1) {
    if (source[i] !== "{") continue;

    const selector = source.slice(start, i).trim();
    const bodyStart = i + 1;
    let inner = 1;
    let j = bodyStart;
    for (; j < source.length; j += 1) {
      if (source[j] === "{") inner += 1;
      else if (source[j] === "}") {
        inner -= 1;
        if (inner === 0) break;
      }
    }
    rules.push({ selector, body: source.slice(bodyStart, j) });
    i = j;
    start = j + 1;
  }
  return rules;
}

/** Every declaration of `property` inside `body`, as raw values. */
function declarations(body, property) {
  const re = new RegExp(`(?:^|[;{\\s])${property}\\s*:\\s*([^;}]+)`, "g");
  const values = [];
  let match;
  while ((match = re.exec(body)) !== null) values.push(match[1].trim());
  return values;
}

const rules = topLevelRules(css);

/** The rules whose selector list mentions `selector` verbatim. */
function rulesFor(selector) {
  return rules.filter((rule) =>
    rule.selector
      .split(",")
      .map((part) => part.trim())
      .includes(selector)
  );
}

// ---------------------------------------------------------------------------
// The `hidden` trap
// ---------------------------------------------------------------------------

// Every element that is toggled with the `hidden` attribute *and* is laid out
// as a fixed, full-window layer. These are the ones where a stray `display`
// would be catastrophic rather than merely cosmetic.
const HIDDEN_OVERLAYS = [
  ".calendar-overlay",
  ".lock-screen",
  ".modal-overlay",
];

for (const selector of HIDDEN_OVERLAYS) {
  test(`${selector} does not set display on its base rule`, () => {
    const base = rulesFor(selector);
    assert.ok(base.length > 0, `no rule found for ${selector}`);

    for (const rule of base) {
      assert.deepEqual(
        declarations(rule.body, "display"),
        [],
        `${selector} must not set display directly: it outranks the UA ` +
          `[hidden] rule and keeps the hidden overlay on screen`
      );
    }
  });

  test(`${selector} lays out only when not hidden`, () => {
    const shown = rulesFor(`${selector}:not([hidden])`);
    assert.ok(shown.length > 0, `${selector}:not([hidden]) rule is missing`);
    assert.ok(
      shown.some((rule) => declarations(rule.body, "display").length > 0),
      `${selector}:not([hidden]) must set display`
    );
  });

  test(`${selector} hides with !important`, () => {
    const hidden = rulesFor(`${selector}[hidden]`);
    assert.ok(hidden.length > 0, `${selector}[hidden] rule is missing`);

    const displays = hidden.flatMap((rule) =>
      declarations(rule.body, "display")
    );
    assert.ok(displays.length > 0, `${selector}[hidden] must set display`);
    for (const value of displays) {
      assert.match(
        value,
        /^none\s*!important$/,
        `${selector}[hidden] must be "none !important", got "${value}"`
      );
    }
  });
}

// ---------------------------------------------------------------------------
// The overlay must not be clickable while hidden
// ---------------------------------------------------------------------------

test("the calendar overlay is the only fixed layer above the editor", () => {
  // A regression guard for the stacking order: the calendar must sit above the
  // dialogs (30) and the lock screen (10), or a dialog could be opened behind
  // it. It must also stay below nothing else, since it is the topmost layer.
  const calendar = rulesFor(".calendar-overlay");
  const zIndexes = calendar.flatMap((rule) =>
    declarations(rule.body, "z-index")
  );
  assert.deepEqual(zIndexes, ["40"]);
});
