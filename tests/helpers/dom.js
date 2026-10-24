// ---------------------------------------------------------------------------
// Minimal DOM stub for the controller tests
// ---------------------------------------------------------------------------
//
// `matches(el, ".cal-day.selected")` — every compound part must hold.
//
// Only `.class` and `tag` parts are understood; anything else throws, so a
// selector the stub cannot honour fails loudly rather than matching nothing.
// A compound selector like `.cal-day.selected` is split into its parts first.
function matches(el, selector) {
  const parts = selector.trim().match(/[.#]?[\w-]+/g) ?? [];
  if (parts.length === 0) throw new Error(`unsupported selector: ${selector}`);
  return parts.every((part) => {
    if (part.startsWith(".")) return el.classList.contains(part.slice(1));
    if (part.startsWith("#")) return el.id === part.slice(1);
    return el.tagName === part.toUpperCase();
  });
}
//
// The feature controllers (`calendar.js`, `import-dialog.js`, `stats-dialog.js`,
// `settings-dialog.js`, `lock-screen.js`) only touch a small slice of the DOM:
// they create elements, set text, toggle classes, append children and move
// focus. This stub implements exactly that slice so the modules can be driven
// from `node --test` without a browser or jsdom.
//
// It is deliberately *not* a general-purpose DOM. Anything the modules do not
// use is left out, which keeps the stub small enough to read in one sitting and
// makes an accidental new DOM dependency fail loudly instead of silently
// working.

/**
 * A fake element.
 *
 * `children` is a real array, so assertions can inspect the rendered tree
 * directly instead of going through `querySelector`.
 */
export function fakeElement(tagName = "div") {
  const classes = new Set();
  const attributes = new Map();

  const el = {
    tagName: tagName.toUpperCase(),
    children: [],
    parentNode: null,
    textContent: "",
    value: "",
    title: "",
    type: "",
    hidden: false,
    disabled: false,
    checked: false,
    selected: false,
    placeholder: "",
    autocomplete: "",
    min: "",
    max: "",
    dataset: {},
    // `style` records both `setProperty("--v", …)` and plain assignments
    // (`style.width = "30%"`), because the modules use both forms.
    style: new Proxy(
      {
        props: new Map(),
        setProperty(name, value) {
          this.props.set(name, value);
        },
      },
      {
        set(target, name, value) {
          if (name === "props" || name === "setProperty") {
            target[name] = value;
            return true;
          }
          target.props.set(name, value);
          return true;
        },
      }
    ),
    classList: {
      add(...names) {
        for (const name of names) classes.add(name);
      },
      remove(...names) {
        for (const name of names) classes.delete(name);
      },
      contains(name) {
        return classes.has(name);
      },
      toggle(name, force) {
        const on = force === undefined ? !classes.has(name) : force;
        if (on) classes.add(name);
        else classes.delete(name);
        return on;
      },
    },
    /** The class list as a sorted array, for assertions. */
    get classes() {
      return [...classes].sort();
    },
    set className(value) {
      classes.clear();
      for (const name of String(value).split(/\s+/)) {
        if (name) classes.add(name);
      }
    },
    get className() {
      return [...classes].join(" ");
    },
    setAttribute(name, value) {
      attributes.set(name, String(value));
    },
    getAttribute(name) {
      return attributes.has(name) ? attributes.get(name) : null;
    },
    removeAttribute(name) {
      attributes.delete(name);
    },
    hasAttribute(name) {
      return attributes.has(name);
    },
    /** Every attribute, for assertions. */
    get attributes() {
      return Object.fromEntries(attributes);
    },
    append(...nodes) {
      for (const node of nodes) {
        if (node && node.__isFragment) {
          el.append(...node.children);
          node.children = [];
          continue;
        }
        node.parentNode = el;
        el.children.push(node);
      }
    },
    /** Single-node form, used by the modules when building rows. */
    appendChild(node) {
      el.append(node);
      return node;
    },
    replaceChildren(...nodes) {
      el.children = [];
      el.append(...nodes);
    },
    /** Flattened text of this element and its descendants. */
    get text() {
      return (
        el.textContent + el.children.map((child) => child.text ?? "").join("")
      );
    },
    focus() {
      document.activeElement = el;
    },
    select() {
      el.selectedText = true;
    },
    click() {
      el.clicked = (el.clicked ?? 0) + 1;
    },
    /** Depth-first search for a descendant matching `predicate`. */
    find(predicate) {
      for (const child of el.children) {
        if (predicate(child)) return child;
        const nested = child.find?.(predicate);
        if (nested) return nested;
      }
      return null;
    },
    /** Every descendant matching `predicate`, in document order. */
    findAll(predicate) {
      const found = [];
      for (const child of el.children) {
        if (predicate(child)) found.push(child);
        found.push(...(child.findAll?.(predicate) ?? []));
      }
      return found;
    },
    /**
     * Descendants carrying every class in `className`.
     *
     * The argument is a space-separated class list (`"import-row failed"`), not
     * a selector, so a bare word is a class name rather than a tag name.
     */
    byClass(className) {
      const wanted = className.split(/\s+/).filter(Boolean);
      return el.findAll((child) =>
        wanted.every((name) => child.classList?.contains(name))
      );
    },
    /**
     * Minimal selector support: `.class` and `tag` only.
     *
     * That is all the controllers use (`".cal-day.selected"`, `".cal-day"`), and
     * keeping it narrow means an unsupported selector throws instead of quietly
     * matching nothing.
     */
    querySelectorAll(selector) {
      return el.findAll((child) => matches(child, selector));
    },
    querySelector(selector) {
      return el.querySelectorAll(selector)[0] ?? null;
    },
  };

  return el;
}

/** A fake document fragment: `append` splices its children into the parent. */
export function fakeFragment() {
  const frag = fakeElement("#fragment");
  frag.__isFragment = true;
  return frag;
}

/**
 * Install the DOM globals the controllers read.
 *
 * Returns a `restore()` that puts the previous globals back. `activeElement`
 * starts as `null` and is updated by `focus()`.
 */
export function installDom() {
  const previous = {
    document: globalThis.document,
    window: globalThis.window,
  };

  const document = {
    activeElement: null,
    // The calendar overlay locks background scrolling by toggling a class on
    // `<body>`, so the stub needs one.
    body: fakeElement("body"),
    createElement: (tagName) => fakeElement(tagName),
    createDocumentFragment: () => fakeFragment(),
    querySelector: () => null,
    querySelectorAll: () => [],
  };

  globalThis.document = document;
  globalThis.window = globalThis.window ?? {};

  return () => {
    globalThis.document = previous.document;
    globalThis.window = previous.window;
  };
}

/**
 * Build an `els` table from a list of ids.
 *
 * Every entry is a fresh fake element, so a test can assert on any of them
 * without knowing which ones the module under test happens to touch.
 */
export function fakeEls(ids) {
  const els = {};
  for (const id of ids) els[id] = fakeElement("div");
  return els;
}

/**
 * A `t()` stub that returns a readable, assertable string.
 *
 * `t("stats.days", { n: 3 })` becomes `"stats.days(n=3)"`, so a test can check
 * both the key and the parameters without depending on the real dictionaries.
 */
export function fakeT() {
  return (key, params) => {
    if (!params) return key;
    const args = Object.entries(params)
      .map(([name, value]) => `${name}=${value}`)
      .join(",");
    return `${key}(${args})`;
  };
}

/**
 * A recording spy.
 *
 * `spy()` records calls; `spy(value)` also returns `value`; `spy(fn)` calls
 * `fn` and records its result. `calls` holds `{ args, result }`.
 */
export function spy(impl) {
  const calls = [];
  const fn = (...args) => {
    const result = typeof impl === "function" ? impl(...args) : impl;
    calls.push({ args, result });
    return result;
  };
  fn.calls = calls;
  fn.args = () => calls.map((call) => call.args);
  fn.count = () => calls.length;
  return fn;
}

/**
 * An `invoke` stub backed by a command table.
 *
 * Each entry is either a value or a function of the args. Unknown commands
 * throw, so a test that forgets to stub a command fails with a clear message
 * instead of silently returning `undefined`.
 */
export function fakeInvoke(table = {}) {
  const calls = [];
  const invoke = async (command, args) => {
    calls.push({ command, args });
    if (!(command in table)) {
      throw new Error(`unexpected invoke: ${command}`);
    }
    const entry = table[command];
    return typeof entry === "function" ? entry(args) : entry;
  };
  invoke.calls = calls;
  invoke.commands = () => calls.map((call) => call.command);
  invoke.argsOf = (command) =>
    calls.find((call) => call.command === command)?.args;
  return invoke;
}
