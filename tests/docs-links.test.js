// ---------------------------------------------------------------------------
// Documentation links
// ---------------------------------------------------------------------------
//
// README is intentionally a landing page; the details live in docs/. Keep the
// two navigable: a broken relative link is invisible in review but obvious to
// a reader, and an unlinked document is effectively lost.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const docsDir = resolve(root, "docs");

function withoutFencedCode(markdown) {
  return markdown.replace(/```[\s\S]*?```/g, "");
}

function markdownLinks(markdown) {
  const links = [];
  const pattern = /!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  for (const match of withoutFencedCode(markdown).matchAll(pattern)) {
    links.push(match[1]);
  }
  return links;
}

function localTarget(fromFile, link) {
  if (/^(https?:|mailto:|tel:|#)/.test(link)) return null;
  const pathPart = link.split("#")[0];
  if (!pathPart) return null;
  return resolve(dirname(fromFile), decodeURIComponent(pathPart));
}

function docsFiles() {
  return readdirSync(docsDir).filter((name) => name.endsWith(".md"));
}

test("relative links in README and docs resolve to files", () => {
  const files = [
    resolve(root, "README.md"),
    ...docsFiles().map((name) => resolve(docsDir, name)),
  ];
  const missing = [];

  for (const file of files) {
    for (const link of markdownLinks(readFileSync(file, "utf8"))) {
      const target = localTarget(file, link);
      if (target && !existsSync(target)) {
        missing.push(`${relative(root, file)} -> ${link}`);
      }
    }
  }

  assert.deepEqual(missing, []);
});

test("every document is reachable from README or the docs index", () => {
  const incoming = new Set();
  for (const file of [resolve(root, "README.md"), resolve(docsDir, "README.md")]) {
    for (const link of markdownLinks(readFileSync(file, "utf8"))) {
      const target = localTarget(file, link);
      if (target) incoming.add(target);
    }
  }

  const orphaned = docsFiles()
    .filter((name) => name !== "README.md")
    .map((name) => resolve(docsDir, name))
    .filter((file) => !incoming.has(file))
    .map((file) => relative(root, file));

  assert.deepEqual(orphaned, []);
});
