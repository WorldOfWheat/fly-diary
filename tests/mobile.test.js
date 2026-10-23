// ---------------------------------------------------------------------------
// Mobile shell tests
// ---------------------------------------------------------------------------
//
// `mobile.js` is a pure state machine over a handful of elements: the drawer
// opens and closes, the bottom navigation forwards to the existing buttons,
// and the top bar mirrors the editor's date. None of that needs a real
// webview, so the tests drive it through the shared DOM stub.

import test from "node:test";
import assert from "node:assert/strict";

import { createMobileShell, MOBILE_BREAKPOINT } from "../src/mobile.js";
import { fakeElement, spy } from "./helpers/dom.js";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/**
 * Build the element table the shell expects.
 *
 * `matchMedia` is installed on `globalThis.window` for the duration of the
 * test and restored afterwards, because `isMobile()` reads it on every call.
 */
function harness({ mobile = true, overrides = {} } = {}) {
  const els = {
    app: fakeElement("div"),
    sidebar: fakeElement("aside"),
    drawerToggle: fakeElement("button"),
    drawerScrim: fakeElement("div"),
    mobileBar: fakeElement("header"),
    mobileDate: fakeElement("button"),
    mobileDateLabel: fakeElement("span"),
    mobileMore: fakeElement("button"),
    mobileFab: fakeElement("button"),
    mobileNav: fakeElement("nav"),
    viewFavourites: fakeElement("button"),
    statsBtn: fakeElement("button"),
    settingsBtn: fakeElement("button"),
    ...overrides,
  };

  const previousWindow = globalThis.window;
  globalThis.window = {
    matchMedia: (query) => ({
      matches: mobile && query === `(max-width: ${MOBILE_BREAKPOINT}px)`,
      media: query,
    }),
  };

  const deps = {
    els,
    openCalendar: spy(),
    closeCalendar: spy(),
    isCalendarOpen: spy(false),
  };

  const shell = createMobileShell(deps);

  return {
    els,
    deps,
    shell,
    restore() {
      globalThis.window = previousWindow;
    },
  };
}

/** Run `body` with a fresh harness and always restore the globals. */
function withHarness(options, body) {
  const h = harness(options);
  try {
    return body(h);
  } finally {
    h.restore();
  }
}

/** Add a bottom-navigation button to the fake nav element. */
function addNavTab(nav, tab) {
  const btn = fakeElement("button");
  btn.dataset.navTab = tab;
  nav.append(btn);
  return btn;
}

// ---------------------------------------------------------------------------
// Breakpoint detection
// ---------------------------------------------------------------------------

test("isMobile is true below the breakpoint", () => {
  withHarness({ mobile: true }, ({ shell }) => {
    assert.equal(shell.isMobile(), true);
  });
});

test("isMobile is false above the breakpoint", () => {
  withHarness({ mobile: false }, ({ shell }) => {
    assert.equal(shell.isMobile(), false);
  });
});

test("isMobile is false when matchMedia is unavailable", () => {
  const previous = globalThis.window;
  globalThis.window = {};
  try {
    const shell = createMobileShell({ els: {} });
    assert.equal(shell.isMobile(), false);
  } finally {
    globalThis.window = previous;
  }
});

test("the breakpoint matches the stylesheet", () => {
  // `styles.css` uses `@media (max-width: 720px)`; the drawer would open on a
  // layout with no hamburger button if the two drifted apart.
  assert.equal(MOBILE_BREAKPOINT, 720);
});

// ---------------------------------------------------------------------------
// Drawer
// ---------------------------------------------------------------------------

test("the drawer starts closed", () => {
  withHarness({}, ({ shell, els }) => {
    assert.equal(shell.isDrawerOpen(), false);
    assert.equal(els.app.classList.contains("drawer-open"), false);
    // The stub's `hidden` defaults to `false`, so only the state is asserted
    // here; `closeDrawer` is what writes the attribute.
    assert.equal(els.drawerToggle.getAttribute("aria-expanded"), null);
  });
});

test("openDrawer marks the app and reveals the scrim", () => {
  withHarness({}, ({ shell, els }) => {
    shell.openDrawer();

    assert.equal(shell.isDrawerOpen(), true);
    assert.equal(els.app.classList.contains("drawer-open"), true);
    assert.equal(els.drawerScrim.hidden, false);
    assert.equal(els.drawerToggle.getAttribute("aria-expanded"), "true");
  });
});

test("openDrawer is a no-op on the desktop layout", () => {
  withHarness({ mobile: false }, ({ shell, els }) => {
    shell.openDrawer();

    assert.equal(shell.isDrawerOpen(), false);
    assert.equal(els.app.classList.contains("drawer-open"), false);
  });
});

test("closeDrawer hides the scrim and resets aria-expanded", () => {
  withHarness({}, ({ shell, els }) => {
    shell.openDrawer();
    shell.closeDrawer();

    assert.equal(shell.isDrawerOpen(), false);
    assert.equal(els.app.classList.contains("drawer-open"), false);
    assert.equal(els.drawerScrim.hidden, true);
    assert.equal(els.drawerToggle.getAttribute("aria-expanded"), "false");
  });
});

test("closeDrawer on a closed drawer does nothing", () => {
  withHarness({}, ({ shell, els }) => {
    // The stub's `hidden` starts as `false`, so the observable contract is the
    // state flag rather than the attribute.
    shell.closeDrawer();
    assert.equal(shell.isDrawerOpen(), false);
    assert.equal(els.app.classList.contains("drawer-open"), false);
  });
});

test("toggleDrawer flips the state", () => {
  withHarness({}, ({ shell }) => {
    shell.toggleDrawer();
    assert.equal(shell.isDrawerOpen(), true);

    shell.toggleDrawer();
    assert.equal(shell.isDrawerOpen(), false);
  });
});

test("the sidebar is marked hidden from assistive tech while closed", () => {
  withHarness({}, ({ shell, els }) => {
    shell.openDrawer();
    assert.equal(els.sidebar.getAttribute("aria-hidden"), "false");

    shell.closeDrawer();
    assert.equal(els.sidebar.getAttribute("aria-hidden"), "true");
  });
});

test("onDrawerChange is told about every transition", () => {
  const seen = [];
  const h = harness();
  try {
    const shell = createMobileShell({
      els: h.els,
      onDrawerChange: (open) => seen.push(open),
    });

    shell.openDrawer();
    shell.closeDrawer();

    assert.deepEqual(seen, [true, false]);
  } finally {
    h.restore();
  }
});

test("handleResize closes the drawer once the layout is no longer mobile", () => {
  const h = harness({ mobile: true });
  try {
    h.shell.openDrawer();
    assert.equal(h.shell.isDrawerOpen(), true);

    // Simulate the window growing past the breakpoint.
    globalThis.window.matchMedia = () => ({ matches: false });
    h.shell.handleResize();

    assert.equal(h.shell.isDrawerOpen(), false);
  } finally {
    h.restore();
  }
});

test("handleResize leaves an open drawer alone while still mobile", () => {
  withHarness({ mobile: true }, ({ shell }) => {
    shell.openDrawer();
    shell.handleResize();
    assert.equal(shell.isDrawerOpen(), true);
  });
});

test("handleEscape closes an open drawer and reports that it did", () => {
  withHarness({}, ({ shell }) => {
    shell.openDrawer();

    assert.equal(shell.handleEscape(), true);
    assert.equal(shell.isDrawerOpen(), false);
  });
});

test("handleEscape reports false when the drawer is closed", () => {
  withHarness({}, ({ shell }) => {
    assert.equal(shell.handleEscape(), false);
  });
});

// ---------------------------------------------------------------------------
// Top app bar
// ---------------------------------------------------------------------------

test("openDatePicker closes the drawer then opens the calendar", () => {
  withHarness({}, ({ shell, deps }) => {
    shell.openDrawer();
    shell.openDatePicker();

    assert.equal(shell.isDrawerOpen(), false);
    assert.equal(deps.openCalendar.count(), 1);
  });
});

test("renderDateLabel mirrors the date into the top bar", () => {
  withHarness({}, ({ shell, els }) => {
    shell.renderDateLabel("2026年10月23日");
    assert.equal(els.mobileDateLabel.textContent, "2026年10月23日");
  });
});

test("renderDateLabel tolerates a missing label element", () => {
  withHarness({ overrides: { mobileDateLabel: null } }, ({ shell }) => {
    assert.doesNotThrow(() => shell.renderDateLabel("2026-10-23"));
  });
});

// ---------------------------------------------------------------------------
// Bottom navigation
// ---------------------------------------------------------------------------

test("the entries tab opens the drawer", () => {
  withHarness({}, ({ shell }) => {
    shell.selectNavTab("entries");
    assert.equal(shell.isDrawerOpen(), true);
  });
});

test("the favourites tab closes the drawer and clicks the sidebar tab", () => {
  withHarness({}, ({ shell, els }) => {
    shell.openDrawer();
    shell.selectNavTab("favourites");

    assert.equal(shell.isDrawerOpen(), false);
    assert.equal(els.viewFavourites.clicked, 1);
  });
});

test("the stats tab opens the statistics dialog", () => {
  withHarness({}, ({ shell, els }) => {
    shell.selectNavTab("stats");
    assert.equal(els.statsBtn.clicked, 1);
  });
});

test("the settings tab opens the settings dialog", () => {
  withHarness({}, ({ shell, els }) => {
    shell.selectNavTab("settings");
    assert.equal(els.settingsBtn.clicked, 1);
  });
});

test("an unknown tab is ignored", () => {
  withHarness({}, ({ shell, els }) => {
    shell.selectNavTab("nope");

    assert.equal(shell.isDrawerOpen(), false);
    assert.equal(els.statsBtn.clicked, undefined);
    assert.equal(els.settingsBtn.clicked, undefined);
  });
});

test("renderNavTabs marks the favourites tab active", () => {
  withHarness({}, ({ shell, els }) => {
    const all = addNavTab(els.mobileNav, "entries");
    const fav = addNavTab(els.mobileNav, "favourites");

    shell.renderNavTabs("favourites");

    assert.equal(fav.classList.contains("is-active"), true);
    assert.equal(fav.getAttribute("aria-selected"), "true");
    assert.equal(all.classList.contains("is-active"), false);
    assert.equal(all.getAttribute("aria-selected"), "false");
  });
});

test("renderNavTabs clears the active state for the all view", () => {
  withHarness({}, ({ shell, els }) => {
    const fav = addNavTab(els.mobileNav, "favourites");

    shell.renderNavTabs("favourites");
    shell.renderNavTabs("all");

    assert.equal(fav.classList.contains("is-active"), false);
    assert.equal(fav.getAttribute("aria-selected"), "false");
  });
});

test("renderNavTabs tolerates a missing nav element", () => {
  withHarness({ overrides: { mobileNav: null } }, ({ shell }) => {
    assert.doesNotThrow(() => shell.renderNavTabs("all"));
  });
});

// ---------------------------------------------------------------------------
// Entry selection
// ---------------------------------------------------------------------------

test("picking an entry closes the drawer", () => {
  withHarness({}, ({ shell }) => {
    shell.openDrawer();
    shell.handleEntryPicked();
    assert.equal(shell.isDrawerOpen(), false);
  });
});

// ---------------------------------------------------------------------------
// Visibility
// ---------------------------------------------------------------------------

test("setVisible reveals the mobile chrome", () => {
  withHarness({}, ({ shell, els }) => {
    shell.setVisible(true);

    assert.equal(els.mobileBar.hidden, false);
    assert.equal(els.mobileNav.hidden, false);
    assert.equal(els.mobileFab.hidden, false);
  });
});

test("setVisible hides the chrome and closes the drawer", () => {
  withHarness({}, ({ shell, els }) => {
    shell.setVisible(true);
    shell.openDrawer();
    shell.setVisible(false);

    assert.equal(els.mobileBar.hidden, true);
    assert.equal(els.mobileNav.hidden, true);
    assert.equal(els.mobileFab.hidden, true);
    assert.equal(shell.isDrawerOpen(), false);
  });
});

test("setVisible tolerates missing elements", () => {
  withHarness(
    { overrides: { mobileBar: null, mobileNav: null, mobileFab: null } },
    ({ shell }) => {
      assert.doesNotThrow(() => shell.setVisible(true));
    }
  );
});
