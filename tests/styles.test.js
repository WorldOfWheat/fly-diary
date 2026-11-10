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
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadStylesheet } from "./helpers/css.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const rawCss = loadStylesheet(join(root, "src/styles.css"));

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

/**
 * The rules declared inside the `@media (<condition>)` block, or `null` when
 * no such block exists. The block is located by its condition text and its
 * body is parsed with the same flat parser, so the media query's own selector
 * (`@media (max-width: 640px)`) is not mistaken for a rule.
 */
function mediaBlock(condition) {
  const marker = `@media (${condition})`;
  const at = css.indexOf(marker);
  if (at === -1) return null;

  const open = css.indexOf("{", at + marker.length);
  if (open === -1) return null;

  let depth = 1;
  let i = open + 1;
  for (; i < css.length; i += 1) {
    if (css[i] === "{") depth += 1;
    else if (css[i] === "}") {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  return topLevelRules(css.slice(open + 1, i));
}

/** The rules whose selector list mentions `selector` verbatim. */
function rulesFor(selector, source = rules) {
  return source.filter((rule) =>
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
  ".attachment-viewer",
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

test("the calendar overlay sits above the dialogs", () => {
  // A regression guard for the stacking order: the calendar must sit above the
  // dialogs (30) and the lock screen (10), or a dialog could be opened behind
  // it.
  const calendar = rulesFor(".calendar-overlay");
  const zIndexes = calendar.flatMap((rule) =>
    declarations(rule.body, "z-index")
  );
  assert.deepEqual(zIndexes, ["40"]);
});

test("the attachment viewer sits above the calendar", () => {
  // The lightbox is the topmost layer; otherwise Escape/click handling and the
  // visual stack disagree.
  const viewer = rulesFor(".attachment-viewer");
  const zIndexes = viewer.flatMap((rule) => declarations(rule.body, "z-index"));
  assert.deepEqual(zIndexes, ["50"]);
});

// ---------------------------------------------------------------------------
// The broken-entry banner
// ---------------------------------------------------------------------------
//
// The banner is a normal in-flow block, so unlike the overlays it *may* set
// `display`. It still has to lose to the `hidden` attribute, otherwise the
// "this file cannot be decrypted" warning would show on every healthy entry.

test("the broken banner hides when the hidden attribute is set", () => {
  const hidden = rulesFor(".broken-banner[hidden]");
  assert.ok(hidden.length > 0, ".broken-banner[hidden] rule is missing");

  const displays = hidden.flatMap((rule) => declarations(rule.body, "display"));
  assert.ok(displays.length > 0, ".broken-banner[hidden] must set display");
  for (const value of displays) {
    assert.match(
      value,
      /^none\s*!important$/,
      `.broken-banner[hidden] must be "none !important", got "${value}"`
    );
  }
});

test("the broken banner is laid out as a flex row", () => {
  const base = rulesFor(".broken-banner");
  assert.ok(base.length > 0, "no rule found for .broken-banner");
  assert.ok(
    base.some((rule) => declarations(rule.body, "display").includes("flex")),
    ".broken-banner must be a flex row"
  );
});

test("the broken tab badge is hidden while it is empty", () => {
  // The badge carries the broken-file count. An empty pill would otherwise sit
  // next to the tab label on a healthy vault.
  const empty = rulesFor(".view-badge:empty");
  assert.ok(empty.length > 0, ".view-badge:empty rule is missing");
  assert.ok(
    empty.some((rule) => declarations(rule.body, "display").includes("none")),
    ".view-badge:empty must be display: none"
  );
});

test("the app splits into two layers on a phone viewport", () => {
  // On a phone the list and the editor are two full-window layers, not two
  // columns. `data-layer` on `.app` picks which one is visible; the back button
  // is the only way out of the editor.
  const phone = mediaBlock("max-width: 640px");
  assert.ok(phone, "no max-width: 640px media block found");

  const listLayer = rulesFor('.app[data-layer="list"] .editor', phone);
  assert.ok(listLayer.length > 0, "the list layer must hide the editor");
  assert.ok(
    listLayer.some((rule) =>
      declarations(rule.body, "display").includes("none")
    ),
    '.app[data-layer="list"] .editor must be display: none'
  );

  const editorLayer = rulesFor('.app[data-layer="editor"] .sidebar', phone);
  assert.ok(editorLayer.length > 0, "the editor layer must hide the sidebar");
  assert.ok(
    editorLayer.some((rule) =>
      declarations(rule.body, "display").includes("none")
    ),
    '.app[data-layer="editor"] .sidebar must be display: none'
  );

  const back = rulesFor(".btn-back", phone);
  assert.ok(back.length > 0, ".btn-back rule is missing from the phone block");
  assert.ok(
    back.some((rule) =>
      declarations(rule.body, "display").includes("inline-flex")
    ),
    ".btn-back must be shown on a phone viewport"
  );
});

test("the editor status cluster shrinks and wraps on a phone viewport", () => {
  // The status text, unlock, favourite and delete buttons sit in one row. On a
  // phone that row is wider than the window, so the cluster must be allowed to
  // shrink and wrap rather than pushing the delete button off the edge.
  const phone = mediaBlock("max-width: 640px");
  assert.ok(phone, "no max-width: 640px media block found");

  const status = rulesFor(".status", phone);
  assert.ok(status.length > 0, ".status rule is missing from the phone block");
  assert.ok(
    status.some((rule) => declarations(rule.body, "flex-wrap").includes("wrap")),
    ".status must wrap on a phone viewport"
  );
  assert.ok(
    status.some((rule) =>
      declarations(rule.body, "flex").some((value) => value.startsWith("1 1"))
    ),
    ".status must be allowed to shrink on a phone viewport"
  );

  const text = rulesFor(".status-text", phone);
  assert.ok(text.length > 0, ".status-text rule is missing from the phone block");
  assert.ok(
    text.some((rule) => declarations(rule.body, "min-width").includes("0")),
    ".status-text must be able to shrink below its content width"
  );
  assert.ok(
    text.some((rule) => declarations(rule.body, "text-overflow").includes("ellipsis")),
    ".status-text must truncate rather than overflow"
  );
});

test("the back button is hidden on a wide viewport", () => {
  // Both panes are visible at once above the phone breakpoint, so there is
  // nothing to go back to.
  const base = rulesFor(".btn-back");
  assert.ok(base.length > 0, "no base rule found for .btn-back");
  assert.ok(
    base.some((rule) => declarations(rule.body, "display").includes("none")),
    ".btn-back must be display: none by default"
  );
});

test("the lock header stacks into one column on a phone viewport", () => {
  // The header is a three-column grid on the desktop: title centred, theme and
  // language switches pinned to the right. On a phone that squeezes the title
  // and jams the switches into the corner, so the header becomes a single
  // centred column with the switches on their own line.
  const phone = mediaBlock("max-width: 640px");
  assert.ok(phone, "no max-width: 640px media block found");

  const head = rulesFor(".lock-head", phone);
  assert.ok(head.length > 0, ".lock-head rule is missing from the phone block");
  assert.ok(
    head.some((rule) =>
      declarations(rule.body, "grid-template-columns").some((value) =>
        value.startsWith("minmax(0, 1fr)")
      )
    ),
    ".lock-head must collapse to a single column on a phone viewport"
  );

  const actions = rulesFor(".lock-actions", phone);
  assert.ok(
    actions.length > 0,
    ".lock-actions rule is missing from the phone block"
  );
  assert.ok(
    actions.some((rule) =>
      declarations(rule.body, "grid-column").includes("1")
    ),
    ".lock-actions must move to the single column on a phone viewport"
  );
  assert.ok(
    actions.some((rule) =>
      declarations(rule.body, "justify-self").includes("center")
    ),
    ".lock-actions must be centred on a phone viewport"
  );
});

test("the workspace row collapses to a single button on a phone viewport", () => {
  // The lock screen shows the current diary folder plus a "switch workspace"
  // button. On a phone-sized viewport there is no room for both, so the path
  // text is dropped and the button takes the whole row. The path stays
  // reachable through the button's tooltip.
  const phone = mediaBlock("max-width: 640px");
  assert.ok(phone, "no max-width: 640px media block found");

  const path = rulesFor(".lock-workspace-path", phone);
  assert.ok(
    path.length > 0,
    ".lock-workspace-path rule is missing from the phone block"
  );
  assert.ok(
    path.some((rule) => declarations(rule.body, "display").includes("none")),
    ".lock-workspace-path must be display: none on a phone viewport"
  );

  const button = rulesFor(".lock-workspace .btn-browse", phone);
  assert.ok(
    button.length > 0,
    ".lock-workspace .btn-browse rule is missing from the phone block"
  );
  assert.ok(
    button.some((rule) => declarations(rule.body, "flex").includes("1")),
    ".lock-workspace .btn-browse must fill the row on a phone viewport"
  );
});

test("a locked editor dims its inputs", () => {
  // The lock is enforced in JS, but the user needs to see that typing will not
  // be saved. Both the title and the body must pick up the locked styling.
  for (const selector of [
    ".editor.is-locked .title-input",
    ".editor.is-locked #content",
  ]) {
    const locked = rulesFor(selector);
    assert.ok(locked.length > 0, `no rule found for ${selector}`);
  }
});
