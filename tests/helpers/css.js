// Load the stylesheet the same way the webview does: the entry file imports
// partials, and tests need the concatenated text to keep their CSS invariants.
// Native `@import` is used precisely so this stays build-free.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export function loadStylesheet(entryPath) {
  const source = readFileSync(entryPath, "utf8");
  const dir = dirname(entryPath);
  return source.replace(
    /@import\s+url\((["'])([^"']+)\1\)\s*;/g,
    (_, __, href) => readFileSync(resolve(dir, href), "utf8")
  );
}
