// ---------------------------------------------------------------------------
// Mobile shell
// ---------------------------------------------------------------------------
//
// The desktop layout is a two-column grid: a permanent sidebar next to the
// editor. A phone does not have the width for that, so the same markup is
// re-arranged into a Material-style single-column shell:
//
//   ┌───────────────────────────┐
//   │ top app bar   ☰   date  ⋮ │  ← `#mobile-bar`
//   ├───────────────────────────┤
//   │                           │
//   │        editor             │  ← `main.editor`
//   │                     (+)   │  ← `#mobile-fab`
//   ├───────────────────────────┤
//   │  ☰     ★     📊     ⚙     │  ← `#mobile-nav`
//   └───────────────────────────┘
//
// The sidebar becomes a navigation drawer that slides in from the left over a
// scrim, and the three dialogs become bottom sheets.
//
// Everything here is *additive*: the desktop markup and behaviour are
// untouched, and every listener is attached to an element that only exists in
// the mobile shell. The CSS decides whether the shell is visible, so this
// module only has to keep the open/closed state in sync.
//
// The module is a factory (`createMobileShell(deps)`) like the other
// controllers, so it can be unit-tested against the shared DOM stub without a
// live webview.

/**
 * Width, in CSS pixels, at or below which the mobile shell takes over.
 *
 * Must match the `@media (max-width: 720px)` block in `styles.css`. It is
 * duplicated here because the drawer has to know whether it is allowed to be
 * open — a drawer left open while the window grows back to desktop would
 * otherwise keep the scrim up.
 */
export const MOBILE_BREAKPOINT = 720;

/** Media query used to detect the mobile shell. */
const MOBILE_QUERY = `(max-width: ${MOBILE_BREAKPOINT}px)`;

/**
 * Create the mobile shell controller.
 *
 * @param {object} deps
 * @param {object} deps.els            The shared element table from `dom.js`.
 * @param {Function} deps.openCalendar Opens the date picker (the top bar's
 *                                     date button is a second entry point).
 * @param {Function} deps.closeCalendar Closes the date picker.
 * @param {Function} deps.isCalendarOpen Whether the date picker is showing.
 * @param {Function} [deps.onDrawerChange] Called with `true`/`false` whenever
 *                                     the drawer opens or closes.
 */
export function createMobileShell(deps) {
  const { els } = deps;

  /** True while the navigation drawer is open. */
  let drawerOpen = false;

  /**
   * True while the mobile shell is the active layout.
   *
   * `matchMedia` is missing in the test stub and in very old webviews, so the
   * fallback is "not mobile": the desktop layout is the safe default because
   * it needs no extra state.
   */
  function isMobile() {
    if (typeof window === "undefined" || !window.matchMedia) return false;
    return window.matchMedia(MOBILE_QUERY).matches;
  }

  /** Reflect the drawer state onto the DOM. */
  function renderDrawer() {
    if (els.app) els.app.classList.toggle("drawer-open", drawerOpen);
    if (els.drawerScrim) els.drawerScrim.hidden = !drawerOpen;
    if (els.drawerToggle) {
      els.drawerToggle.setAttribute("aria-expanded", drawerOpen ? "true" : "false");
    }
    // The drawer is a modal surface while open: the rest of the page must not
    // scroll behind it.
    if (els.sidebar) els.sidebar.setAttribute("aria-hidden", drawerOpen ? "false" : "true");
    if (typeof deps.onDrawerChange === "function") deps.onDrawerChange(drawerOpen);
  }

  /** Open the navigation drawer. No-op on the desktop layout. */
  function openDrawer() {
    if (!isMobile() || drawerOpen) return;
    drawerOpen = true;
    renderDrawer();
  }

  /** Close the navigation drawer. */
  function closeDrawer() {
    if (!drawerOpen) return;
    drawerOpen = false;
    renderDrawer();
  }

  /** Toggle the drawer from the hamburger button. */
  function toggleDrawer() {
    if (drawerOpen) closeDrawer();
    else openDrawer();
  }

  /** Whether the drawer is currently open (used by the Escape handler). */
  function isDrawerOpen() {
    return drawerOpen;
  }

  /**
   * Close the drawer when the layout grows past the breakpoint.
   *
   * Without this, rotating a tablet to landscape would leave the scrim up over
   * a desktop layout that has no hamburger button to dismiss it.
   */
  function handleResize() {
    if (drawerOpen && !isMobile()) closeDrawer();
  }

  /**
   * The top bar's date button opens the same calendar as the editor's date
   * pill. On mobile the pill is still there, but the top bar is the primary
   * target, so both routes have to work.
   */
  function openDatePicker() {
    closeDrawer();
    if (typeof deps.openCalendar === "function") deps.openCalendar();
  }

  /**
   * Bottom navigation: each tab either switches the sidebar view or opens a
   * dialog. The "entries" tab opens the drawer, because the entry list is the
   * drawer's content.
   */
  function selectNavTab(tab) {
    switch (tab) {
      case "entries":
        openDrawer();
        break;
      case "favourites":
        closeDrawer();
        if (els.viewFavourites) els.viewFavourites.click();
        break;
      case "stats":
        closeDrawer();
        if (els.statsBtn) els.statsBtn.click();
        break;
      case "settings":
        closeDrawer();
        if (els.settingsBtn) els.settingsBtn.click();
        break;
      default:
        break;
    }
  }

  /** Highlight the tab that matches the current sidebar view. */
  function renderNavTabs(view) {
    if (!els.mobileNav) return;
    // Iterate the children rather than querying `[data-nav-tab]`: the tabs are
    // the only children of the nav, and this keeps the module free of selector
    // support (the test stub only understands `.class` and `tag`).
    for (const btn of els.mobileNav.children ?? []) {
      const tab = btn.dataset ? btn.dataset.navTab : undefined;
      if (!tab) continue;
      const active = tab === "favourites" ? view === "favourites" : false;
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-selected", active ? "true" : "false");
    }
  }

  /**
   * Close the drawer when a row is picked, so the editor is visible straight
   * away instead of behind the scrim.
   */
  function handleEntryPicked() {
    closeDrawer();
  }

  /**
   * Escape closes the drawer before anything else. Returns `true` when it
   * handled the key, so the caller can stop looking for other handlers.
   */
  function handleEscape() {
    if (!drawerOpen) return false;
    closeDrawer();
    return true;
  }

  /**
   * Keep the top bar's date label in sync with the editor.
   *
   * The editor already renders `#date-main`; the top bar shows the same text
   * so the user can see which day they are on without scrolling up.
   */
  function renderDateLabel(text) {
    if (els.mobileDateLabel) els.mobileDateLabel.textContent = text;
  }

  /** Show or hide the shell (the lock screen hides it entirely). */
  function setVisible(visible) {
    if (els.mobileBar) els.mobileBar.hidden = !visible;
    if (els.mobileNav) els.mobileNav.hidden = !visible;
    if (els.mobileFab) els.mobileFab.hidden = !visible;
    if (!visible) closeDrawer();
  }

  return {
    isMobile,
    isDrawerOpen,
    openDrawer,
    closeDrawer,
    toggleDrawer,
    handleResize,
    openDatePicker,
    selectNavTab,
    renderNavTabs,
    handleEntryPicked,
    handleEscape,
    renderDateLabel,
    setVisible,
  };
}
