// ---------------------------------------------------------------------------
// Accessibility invariants
// ---------------------------------------------------------------------------
//
// These are static checks for the mistakes that are easy to reintroduce and
// invisible to the interaction tests: an input without an accessible name, an
// error message that is not announced, or a contrast token drifting below the
// WCAG AA threshold.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadStylesheet } from "./helpers/css.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(join(root, "src/index.html"), "utf8");
const css = loadStylesheet(join(root, "src/styles.css"));

function cssBlock(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{`));
  assert.ok(match, `missing CSS block: ${selector}`);
  const open = css.indexOf("{", match.index);
  const close = css.indexOf("}", open);
  return css.slice(open + 1, close);
}

function cssVar(block, name) {
  const match = block.match(new RegExp(`${name}\\s*:\\s*(#[0-9a-fA-F]{3,8})`));
  assert.ok(match, `missing ${name}`);
  return match[1];
}

function luminance(hex) {
  const value = hex.length === 4
    ? hex.slice(1).split("").map((c) => c + c).join("")
    : hex.slice(1);
  const channels = [0, 2, 4].map((i) => parseInt(value.slice(i, i + 2), 16) / 255);
  const linear = channels.map((c) =>
    c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  );
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function contrast(a, b) {
  const first = luminance(a);
  const second = luminance(b);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

test("every visible form control has an accessible name", () => {
  const labels = [...html.matchAll(/<label\b[^>]*>([\s\S]*?)<\/label>/g)].map(
    (match) => match[1]
  );
  const controls = [...html.matchAll(/<(input|textarea|select)\b[^>]*>/g)].map(
    (match) => match[0]
  );
  const unnamed = [];

  for (const tag of controls) {
    const id = tag.match(/\bid="([^"]+)"/)?.[1];
    const type = tag.match(/\btype="([^"]+)"/)?.[1];
    const hidden =
      type === "hidden" ||
      /\bhidden\b/.test(tag) ||
      /\baria-hidden="true"/.test(tag) ||
      /\btabindex="-1"/.test(tag);
    if (hidden || !id) continue;

    const labelled =
      new RegExp(`\\bfor="${id}"`).test(html) ||
      /\baria-label=/.test(tag) ||
      /\baria-labelledby=/.test(tag) ||
      labels.some((block) => block.includes(`id="${id}"`));
    if (!labelled) unnamed.push(id);
  }

  assert.deepEqual(unnamed, []);
});

test("error messages are live regions", () => {
  for (const id of ["lock-error", "import-error", "settings-error"]) {
    assert.match(
      html,
      new RegExp(`id="${id}"[^>]*role="alert"`),
      `${id} must be a role="alert" live region`
    );
  }
});

test("the sidebar view switch uses pressed buttons, not a fake tablist", () => {
  assert.doesNotMatch(html, /role="tab(list)?"/);
  assert.match(html, /id="view-all"[^>]*aria-pressed="true"/);
  assert.match(html, /id="view-favourites"[^>]*aria-pressed="false"/);
});

test("light and dark text tokens meet WCAG AA contrast", () => {
  const light = cssBlock(":root");
  const dark = cssBlock(':root[data-theme="dark"]');

  for (const [name, block] of [
    ["light", light],
    ["dark", dark],
  ]) {
    const muted = cssVar(block, "--text-muted");
    for (const surface of ["--bg", "--panel", "--sidebar-bg"]) {
      const ratio = contrast(muted, cssVar(block, surface));
      assert.ok(
        ratio >= 4.5,
        `${name} ${muted} on ${surface} is ${ratio.toFixed(2)}:1, need 4.5:1`
      );
    }
  }
});

test("form-control borders meet the 3:1 non-text contrast threshold", () => {
  const light = cssBlock(":root");
  const dark = cssBlock(':root[data-theme="dark"]');

  for (const [name, block] of [
    ["light", light],
    ["dark", dark],
  ]) {
    const border = cssVar(block, "--border-strong");
    for (const surface of ["--bg", "--panel"]) {
      const ratio = contrast(border, cssVar(block, surface));
      assert.ok(
        ratio >= 3,
        `${name} ${border} on ${surface} is ${ratio.toFixed(2)}:1, need 3:1`
      );
    }
  }
});

test("secondary text on favourite rows does not rely on the muted token", () => {
  assert.match(
    css,
    /\.entry-item\.favourite \.entry-preview\s*\{[^}]*color:\s*var\(--text\)/
  );
  assert.doesNotMatch(css, /\.entry-preview\.empty\s*\{[^}]*opacity:\s*0\.6/);
});

test("the textarea and placeholder styles keep text and focus visible", () => {
  assert.match(
    css,
    /html\[data-input-modality="keyboard"\] textarea:focus/
  );
  assert.match(
    css,
    /html\[data-input-modality="keyboard"\] #content:focus/
  );
  assert.match(css, /::placeholder\s*\{[^}]*opacity:\s*1/);
  assert.doesNotMatch(css, /#content::placeholder\s*\{[^}]*opacity:\s*0\./);
});

test("small icon controls meet the 24px WCAG 2.2 target size", () => {
  for (const selector of [".attachment-control", ".modal-close"]) {
    const block = cssBlock(selector);
    assert.match(block, /(?:width|min-width):\s*(?:1\.75rem|2\.\d+rem)/, selector);
    assert.match(block, /(?:height|min-height):\s*(?:1\.75rem|2\.\d+rem)/, selector);
  }
});
