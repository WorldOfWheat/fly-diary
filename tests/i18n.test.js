import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

// `i18n.js` keeps the active locale in module state, so every test that
// switches language would leak into the next one. The module is therefore
// re-imported fresh for each test that needs a known starting point.
//
// `setLocale` calls `applyTranslations()`, which needs a DOM, so the globals it
// reads are stubbed before the import.

/** Minimal DOM stub: enough for `applyTranslations` to run. */
function stubDom() {
  const previous = {
    document: globalThis.document,
    localStorage: globalThis.localStorage,
  };
  globalThis.document = {
    documentElement: { lang: "" },
    title: "",
    querySelectorAll: () => [],
  };
  globalThis.localStorage = {
    store: new Map(),
    getItem(key) {
      return this.store.has(key) ? this.store.get(key) : null;
    },
    setItem(key, value) {
      this.store.set(key, String(value));
    },
    removeItem(key) {
      this.store.delete(key);
    },
  };
  return () => {
    globalThis.document = previous.document;
    globalThis.localStorage = previous.localStorage;
  };
}

/** Import a pristine copy of `i18n.js` with a DOM stub already in place. */
async function freshI18n() {
  const restore = stubDom();
  const mod = await import(`../src/i18n.js?fresh=${Math.random()}`);
  return { mod, restore };
}

test("LOCALES lists the shipped languages with the fallback first", async () => {
  const { mod, restore } = await freshI18n();
  try {
    assert.deepEqual(mod.LOCALES, ["zh-Hant", "en"]);
  } finally {
    restore();
  }
});

test("t() returns the key itself when it is missing everywhere", async () => {
  const { mod, restore } = await freshI18n();
  try {
    assert.equal(mod.t("this.key.does.not.exist"), "this.key.does.not.exist");
  } finally {
    restore();
  }
});

test("t() substitutes {name} placeholders", async () => {
  const { mod, restore } = await freshI18n();
  try {
    const text = mod.t("stats.days", { n: 7 });
    assert.ok(text.includes("7"), `expected 7 in ${text}`);
    assert.ok(!text.includes("{n}"), `placeholder left in ${text}`);
  } finally {
    restore();
  }
});

test("t() leaves unknown placeholders untouched", async () => {
  const { mod, restore } = await freshI18n();
  try {
    const text = mod.t("stats.days", { other: 1 });
    assert.ok(text.includes("{n}"), `expected {n} to survive, got ${text}`);
  } finally {
    restore();
  }
});

test("t() without params returns the raw string", async () => {
  const { mod, restore } = await freshI18n();
  try {
    assert.equal(mod.t("stats.title"), "統計");
  } finally {
    restore();
  }
});

test("t() handles a numeric zero parameter", async () => {
  const { mod, restore } = await freshI18n();
  try {
    const text = mod.t("stats.days", { n: 0 });
    assert.ok(text.includes("0"), `expected 0 in ${text}`);
  } finally {
    restore();
  }
});

test("getLocale starts on the fallback locale", async () => {
  const { mod, restore } = await freshI18n();
  try {
    assert.equal(mod.getLocale(), "zh-Hant");
  } finally {
    restore();
  }
});

test("getLocaleName is human readable", async () => {
  const { mod, restore } = await freshI18n();
  try {
    assert.equal(mod.getLocaleName(), "繁體中文");
  } finally {
    restore();
  }
});

test("nextLocale cycles through LOCALES", async () => {
  const { mod, restore } = await freshI18n();
  try {
    assert.equal(mod.nextLocale(), "en");
  } finally {
    restore();
  }
});

test("nextLocaleShort shows the other language", async () => {
  const { mod, restore } = await freshI18n();
  try {
    // The label is keyed by the *current* locale and names the other one:
    // in Chinese the button reads "中", in English it reads "EN".
    assert.equal(mod.nextLocaleShort(), "中");
    mod.setLocale("en");
    assert.equal(mod.nextLocaleShort(), "EN");
  } finally {
    restore();
  }
});

test("setLocale switches the active dictionary", async () => {
  const { mod, restore } = await freshI18n();
  try {
    mod.setLocale("en");
    assert.equal(mod.getLocale(), "en");
    assert.equal(mod.t("stats.title"), "Statistics");
    assert.equal(mod.getLocaleName(), "English");
    assert.equal(mod.nextLocale(), "zh-Hant");
    assert.equal(mod.nextLocaleShort(), "EN");
  } finally {
    restore();
  }
});

test("setLocale ignores an unknown locale", async () => {
  const { mod, restore } = await freshI18n();
  try {
    mod.setLocale("en");
    mod.setLocale("klingon");
    assert.equal(mod.getLocale(), "en");
  } finally {
    restore();
  }
});

test("setLocale is a no-op for the current locale", async () => {
  const { mod, restore } = await freshI18n();
  try {
    let calls = 0;
    const off = mod.onLocaleChange(() => {
      calls += 1;
    });
    mod.setLocale("zh-Hant");
    assert.equal(calls, 0);
    off();
  } finally {
    restore();
  }
});

test("setLocale persists the choice", async () => {
  const { mod, restore } = await freshI18n();
  try {
    mod.setLocale("en");
    assert.equal(globalThis.localStorage.getItem("fly-diary:lang"), "en");
  } finally {
    restore();
  }
});

test("setLocale notifies listeners and unsubscribe stops them", async () => {
  const { mod, restore } = await freshI18n();
  try {
    const seen = [];
    const off = mod.onLocaleChange((locale) => seen.push(locale));
    mod.setLocale("en");
    mod.setLocale("zh-Hant");
    off();
    mod.setLocale("en");
    assert.deepEqual(seen, ["en", "zh-Hant"]);
  } finally {
    restore();
  }
});

test("toggleLocale flips between the two languages", async () => {
  const { mod, restore } = await freshI18n();
  try {
    mod.setLocale("zh-Hant");
    mod.toggleLocale();
    assert.equal(mod.getLocale(), "en");
    mod.toggleLocale();
    assert.equal(mod.getLocale(), "zh-Hant");
  } finally {
    restore();
  }
});

test("setLocale survives a throwing localStorage", async () => {
  const { mod, restore } = await freshI18n();
  globalThis.localStorage = {
    getItem() {
      throw new Error("denied");
    },
    setItem() {
      throw new Error("denied");
    },
    removeItem() {
      throw new Error("denied");
    },
  };
  try {
    assert.doesNotThrow(() => mod.setLocale("en"));
    assert.equal(mod.getLocale(), "en");
  } finally {
    restore();
  }
});

test("formatDate follows the active locale", async () => {
  const { mod, restore } = await freshI18n();
  try {
    mod.setLocale("zh-Hant");
    assert.equal(mod.formatDate("2026-10-23"), "2026 年 10 月 23 日");
    mod.setLocale("en");
    assert.equal(mod.formatDate("2026-10-23"), "10/23/2026");
  } finally {
    restore();
  }
});

test("formatMonth follows the active locale", async () => {
  const { mod, restore } = await freshI18n();
  try {
    mod.setLocale("zh-Hant");
    assert.equal(mod.formatMonth("2026-10-01"), "2026 年 10 月");
    mod.setLocale("en");
    assert.equal(mod.formatMonth("2026-10-01"), "10/2026");
  } finally {
    restore();
  }
});

test("weekdayName maps 0..6 to the bare day names", async () => {
  const { mod, restore } = await freshI18n();
  try {
    // `weekday.N` holds only the day name; the `週` prefix belongs to
    // `date.weekday`, which `formatWeekday` applies.
    mod.setLocale("zh-Hant");
    assert.equal(mod.weekdayName(0), "日");
    assert.equal(mod.weekdayName(6), "六");
    mod.setLocale("en");
    assert.equal(mod.weekdayName(0), "Sun");
    assert.equal(mod.weekdayName(6), "Sat");
  } finally {
    restore();
  }
});

test("formatWeekday resolves the day of an ISO date", async () => {
  const { mod, restore } = await freshI18n();
  try {
    mod.setLocale("en");
    // 2026-10-23 is a Friday.
    assert.equal(mod.formatWeekday("2026-10-23"), "Fri");
    assert.equal(mod.formatWeekday("2026-10-25"), "Sun");
  } finally {
    restore();
  }
});

test("formatWeekday prefixes the day with 週 in Chinese", async () => {
  const { mod, restore } = await freshI18n();
  try {
    mod.setLocale("zh-Hant");
    assert.equal(mod.formatWeekday("2026-10-23"), "週五");
    assert.equal(mod.formatWeekday("2026-10-25"), "週日");
  } finally {
    restore();
  }
});

test("applyTranslations fills data-i18n attributes and the document lang", async () => {
  const { mod, restore } = await freshI18n();

  /** A fake element that records the attributes `applyTranslations` writes. */
  function fakeNode(attrs) {
    return {
      attrs: { ...attrs },
      textContent: "",
      title: "",
      placeholder: "",
      getAttribute(name) {
        return this.attrs[name] ?? null;
      },
      setAttribute(name, value) {
        this.attrs[name] = value;
      },
    };
  }

  const textNode = fakeNode({ "data-i18n": "stats.title" });
  const titleNode = fakeNode({ "data-i18n-title": "editor.prevDayTitle" });
  const ariaNode = fakeNode({ "data-i18n-aria-label": "font.group" });
  const all = [textNode, titleNode, ariaNode];

  globalThis.document.querySelectorAll = (selector) => {
    const attr = selector.slice(1, -1); // "[data-i18n]" -> "data-i18n"
    return all.filter((node) => attr in node.attrs);
  };

  try {
    mod.setLocale("en");
    assert.equal(globalThis.document.documentElement.lang, "en");
    assert.equal(globalThis.document.title, mod.t("app.name"));
    assert.equal(textNode.textContent, "Statistics");
    assert.equal(titleNode.title, mod.t("editor.prevDayTitle"));
    assert.equal(ariaNode.attrs["aria-label"], mod.t("font.group"));
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// Dictionary integrity
// ---------------------------------------------------------------------------
//
// These read the source rather than the module, because the dictionaries are
// module-private. They are the guard that keeps a half-finished translation
// from shipping.

const source = readFileSync(join(root, "src/i18n.js"), "utf8");

/** Extract the keys of one dictionary literal by brace matching. */
function dictionaryKeys(name) {
  const start = source.indexOf(`const ${name} = {`);
  assert.ok(start >= 0, `dictionary ${name} not found`);
  const open = source.indexOf("{", start);
  let depth = 0;
  let end = -1;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  assert.ok(end > open, `dictionary ${name} is not closed`);

  const body = source.slice(open + 1, end);
  const keys = [];
  const re = /^\s*"([^"]+)":/gm;
  let match;
  while ((match = re.exec(body)) !== null) keys.push(match[1]);
  return keys;
}

test("both dictionaries define the same keys", () => {
  const zh = new Set(dictionaryKeys("zhHant"));
  const en = new Set(dictionaryKeys("en"));
  const missingInEn = [...zh].filter((k) => !en.has(k));
  const missingInZh = [...en].filter((k) => !zh.has(k));
  assert.deepEqual(missingInEn, [], "keys missing from en");
  assert.deepEqual(missingInZh, [], "keys missing from zhHant");
});

test("no dictionary has duplicate keys", () => {
  for (const name of ["zhHant", "en"]) {
    const keys = dictionaryKeys(name);
    const dupes = keys.filter((k, i) => keys.indexOf(k) !== i);
    assert.deepEqual([...new Set(dupes)], [], `duplicate keys in ${name}`);
  }
});

test("every dictionary value is a non-empty string", () => {
  for (const name of ["zhHant", "en"]) {
    const start = source.indexOf(`const ${name} = {`);
    const open = source.indexOf("{", start);
    let depth = 0;
    let end = -1;
    for (let i = open; i < source.length; i += 1) {
      if (source[i] === "{") depth += 1;
      else if (source[i] === "}") {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    const body = source.slice(open + 1, end);
    const re = /^\s*"([^"]+)":\s*"((?:[^"\\]|\\.)*)",?\s*$/gm;
    let match;
    let count = 0;
    while ((match = re.exec(body)) !== null) {
      count += 1;
      assert.ok(match[2].length > 0, `empty value for ${name}.${match[1]}`);
    }
    assert.ok(count > 100, `expected many keys in ${name}, parsed ${count}`);
  }
});

test("every data-i18n key used in index.html exists", () => {
  const html = readFileSync(join(root, "src/index.html"), "utf8");
  const zh = new Set(dictionaryKeys("zhHant"));
  const re = /data-i18n(?:-title|-placeholder|-aria-label)?="([^"]+)"/g;
  const missing = [];
  let match;
  while ((match = re.exec(html)) !== null) {
    if (!zh.has(match[1])) missing.push(match[1]);
  }
  assert.deepEqual([...new Set(missing)], [], "unknown data-i18n keys");
});

test("every t() key used in main.js exists", () => {
  const js = readFileSync(join(root, "src/main.js"), "utf8");
  const zh = new Set(dictionaryKeys("zhHant"));
  // Only literal keys; template keys are checked by the dynamic-key test below.
  const re = /\bt\("([a-zA-Z][\w.]*)"/g;
  const missing = [];
  let match;
  while ((match = re.exec(js)) !== null) {
    if (!zh.has(match[1])) missing.push(match[1]);
  }
  assert.deepEqual([...new Set(missing)], [], "unknown t() keys");
});

test("dynamic t() keys resolve for every index they can take", async () => {
  const { mod, restore } = await freshI18n();
  try {
    mod.setLocale("zh-Hant");
    for (let day = 0; day < 7; day += 1) {
      assert.notEqual(mod.t(`weekday.${day}`), `weekday.${day}`);
    }
    for (const mode of ["system", "light", "dark"]) {
      assert.notEqual(
        mod.t(`theme.toggleTitle.${mode}`),
        `theme.toggleTitle.${mode}`
      );
    }
  } finally {
    restore();
  }
});
