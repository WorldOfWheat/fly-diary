// Tauri injects `window.__TAURI__` into the webview. We use it instead of
// `import { invoke } from "@tauri-apps/api/core"` because the frontend is
// served as plain static files (no bundler), so bare module specifiers cannot
// be resolved by the browser.
const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

// Relative specifiers *do* work without a bundler, so the i18n layer and the
// pure helpers under `lib/` are normal ES modules next to this file.
import {
  t,
  initLocale,
  toggleLocale,
  onLocaleChange,
  nextLocaleShort,
  formatDate,
  formatMonth,
  formatWeekday,
  weekdayName,
} from "./i18n.js";
import { toISODate, shiftDate, monthStartOf } from "./lib/dates.js";
import { els } from "./dom.js";
import { initEventWiring } from "./wiring.js";
import { createCalendar } from "./calendar.js";
import { createImportDialog } from "./import-dialog.js";
import { createStatsDialog } from "./stats-dialog.js";
import { createSettingsDialog } from "./settings-dialog.js";
import { createLockScreen } from "./lock-screen.js";
import { createMobileShell } from "./mobile.js";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** Currently selected date, `YYYY-MM-DD`. */
let currentDate = "";
/** Title last loaded from / saved to disk. */
let savedTitle = "";
/** Content last loaded from / saved to disk, used to detect dirty state. */
let savedContent = "";
/** Debounce timer for autosave. */
let saveTimer = null;
/** All entry metadata, newest first. */
let allEntries = [];
/** Search filter string. */
let searchQuery = "";
/**
 * Which sidebar view is showing: `"all"` or `"favourites"`.
 *
 * Both views read the same `allEntries` array; the favourites view is just an
 * extra filter, so switching never needs a second fetch or a second list.
 */
let currentView = "all";
/** Whether the entry currently open in the editor is a favourite. */
let currentFavourite = false;
/** Set while a favourite toggle is in flight, to ignore double clicks. */
let favouriteBusy = false;
/** Guard so programmatic input updates don't trigger autosave. */
let suppressInput = false;

const AUTOSAVE_DELAY = 800;

// ---------------------------------------------------------------------------
// DOM references
// ---------------------------------------------------------------------------
//
// `els` lives in `dom.js` so this file only holds behaviour. The lookup table
// is a plain object with no side effects, which keeps it importable from tests.

// ---------------------------------------------------------------------------
// Date helpers (local timezone, no UTC drift)
// ---------------------------------------------------------------------------
//
// `toISODate` / `shiftDate` / `monthStartOf` live in `lib/dates.js` so they can
// be unit-tested without a DOM. The two wrappers below stay here because they
// need the active locale.

/** `2026-10-23` → `週五` / `Fri`. */
function weekdayOf(iso) {
  return formatWeekday(iso);
}

/** `2026-10-23` → `2026 年 10 月 23 日` / `10/23/2026`. */
function longDateOf(iso) {
  return formatDate(iso);
}

/** Relative label for the header subtitle: today / yesterday / tomorrow / weekday. */
function relativeDayOf(iso) {
  const today = toISODate(new Date());
  if (iso === today) return t("date.today");
  if (iso === shiftDate(today, -1)) return t("date.yesterday");
  if (iso === shiftDate(today, 1)) return t("date.tomorrow");
  return weekdayOf(iso);
}

/** Refresh the visible date pill, in the editor and in the mobile top bar. */
function renderDateLabel() {
  if (!currentDate) {
    els.dateMain.textContent = "—";
    els.dateSub.textContent = "";
    if (mobile) mobile.renderDateLabel("—");
    return;
  }
  els.dateMain.textContent = longDateOf(currentDate);
  els.dateSub.textContent = relativeDayOf(currentDate);
  if (mobile) mobile.renderDateLabel(longDateOf(currentDate));
}

// ---------------------------------------------------------------------------
// Feature controllers
// ---------------------------------------------------------------------------
//
// The calendar, the import dialog, the settings dialog, the statistics dialog
// and the lock screen each live in their own module. They are created here so
// that `main.js` stays the single place that owns the editor state and the
// backend session, while the modules stay testable in isolation.
//
// The controllers are created lazily inside `init()` (see `createControllers`)
// because several of them need callbacks that are defined further down.

/** @type {ReturnType<typeof createCalendar>} */
let calendar;
/** @type {ReturnType<typeof createImportDialog>} */
let importDialog;
/** @type {ReturnType<typeof createStatsDialog>} */
let statsDialog;
/** @type {ReturnType<typeof createSettingsDialog>} */
let settingsDialog;
/** @type {ReturnType<typeof createLockScreen>} */
let lockScreen;
/** @type {ReturnType<typeof createMobileShell>} */
let mobile;

// ---------------------------------------------------------------------------
// Status / word count
// ---------------------------------------------------------------------------

function setStatus(text, saved = false) {
  els.status.textContent = text;
  els.status.classList.toggle("saved", saved);
}

function updateWordCount() {
  const text = els.content.value;
  const chars = text.replace(/\s/g, "").length;
  const lines = text ? text.split("\n").length : 0;
  els.wordCount.textContent = t("editor.wordCount", { chars, lines });
}

// ---------------------------------------------------------------------------
// Rendering (virtual scrolling)
// ---------------------------------------------------------------------------
//
// A diary with thousands of entries would otherwise create thousands of DOM
// nodes on every keystroke-triggered refresh. Instead the spacer is sized to
// the full list height and only the rows inside the viewport (plus a small
// overscan) are rendered, absolutely positioned at `index * ROW_HEIGHT`.

/**
 * Height of one row in CSS pixels.
 *
 * The stylesheet is the source of truth: `.entry-item` is `height: var(--row-h)`
 * and the root font size is fluid, so the row height changes with the window.
 * We read the resolved value once at startup and again whenever the root size
 * changes (see `watchRowHeight`), instead of hard-coding a number that would
 * silently drift out of sync with the CSS.
 */
let ROW_HEIGHT = 52;
/** Extra rows rendered above and below the viewport to hide scroll seams. */
const OVERSCAN = 6;

/** Read `--row-h` from the document and return it in CSS pixels. */
function measureRowHeight() {
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue("--row-h")
    .trim();
  if (!raw) return ROW_HEIGHT;

  // `--row-h` is authored in rem, so resolve it against the root font size.
  const rem =
    parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  const value = raw.endsWith("rem") ? parseFloat(raw) * rem : parseFloat(raw);

  return Number.isFinite(value) && value > 0 ? value : ROW_HEIGHT;
}

/**
 * Keep `ROW_HEIGHT` in sync with the stylesheet.
 *
 * The root font size is a `clamp()` over the viewport width, so resizing the
 * window changes the row height. When that happens the spacer and every
 * rendered row are stale, so we re-measure and redraw.
 */
function watchRowHeight() {
  const sync = () => {
    const next = measureRowHeight();
    if (Math.abs(next - ROW_HEIGHT) < 0.5) return;
    ROW_HEIGHT = next;
    if (visibleEntries.length > 0) renderList();
  };

  sync();
  window.addEventListener("resize", sync);
}

// ---------------------------------------------------------------------------
// Font size
// ---------------------------------------------------------------------------

/**
 * The whole UI is sized in `rem`, so the user's font preference is a single
 * multiplier on the root font size. `--font-scale` is applied by the
 * stylesheet; here we only own the value, the persistence and the label.
 */
const FONT_SCALE_KEY = "fly-diary:font-scale";
const FONT_SCALE_MIN = 0.8;
const FONT_SCALE_MAX = 1.6;
const FONT_SCALE_STEP = 0.1;

/** Current multiplier, always within [FONT_SCALE_MIN, FONT_SCALE_MAX]. */
let fontScale = 1;

/** Clamp and round to one decimal so repeated steps never drift. */
function clampFontScale(value) {
  const clamped = Math.min(FONT_SCALE_MAX, Math.max(FONT_SCALE_MIN, value));
  return Math.round(clamped * 10) / 10;
}

/** Apply `fontScale` to the document and refresh the control's label. */
function applyFontScale() {
  document.documentElement.style.setProperty("--font-scale", String(fontScale));

  if (els.fontReset) {
    els.fontReset.textContent = `${Math.round(fontScale * 100)}%`;
    els.fontReset.title = t("font.reset");
  }
  if (els.fontSmaller) {
    els.fontSmaller.disabled = fontScale <= FONT_SCALE_MIN;
  }
  if (els.fontLarger) {
    els.fontLarger.disabled = fontScale >= FONT_SCALE_MAX;
  }

  // The row height is derived from the root font size, so the virtual-scroll
  // spacer and the rendered rows have to be recomputed.
  const next = measureRowHeight();
  if (Math.abs(next - ROW_HEIGHT) >= 0.5) {
    ROW_HEIGHT = next;
    if (visibleEntries.length > 0) renderList();
  }
}

/** Change the scale by `delta` steps and persist the result. */
function stepFontScale(delta) {
  const next = clampFontScale(fontScale + delta);
  if (next === fontScale) return;
  fontScale = next;
  applyFontScale();
  try {
    localStorage.setItem(FONT_SCALE_KEY, String(fontScale));
  } catch {
    // Private mode or a locked-down webview: the setting just won't persist.
  }
}

/** Restore the scale saved by a previous session, if any. */
function loadFontScale() {
  let stored = null;
  try {
    stored = localStorage.getItem(FONT_SCALE_KEY);
  } catch {
    stored = null;
  }

  const parsed = stored === null ? NaN : Number.parseFloat(stored);
  fontScale = Number.isFinite(parsed) ? clampFontScale(parsed) : 1;
  applyFontScale();
}

/** Reset to 100% and forget the stored preference. */
function resetFontScale() {
  if (fontScale === 1) return;
  fontScale = 1;
  applyFontScale();
  try {
    localStorage.removeItem(FONT_SCALE_KEY);
  } catch {
    // Ignore: nothing to clean up if storage is unavailable.
  }
}

/** Wire the footer buttons and the keyboard shortcuts. */
function initFontScale() {
  loadFontScale();

  els.fontSmaller?.addEventListener("click", () =>
    stepFontScale(-FONT_SCALE_STEP)
  );
  els.fontLarger?.addEventListener("click", () =>
    stepFontScale(FONT_SCALE_STEP)
  );
  els.fontReset?.addEventListener("click", resetFontScale);

  // Ctrl/Cmd +/-/0. These are the same chords browsers use for page zoom, so
  // we take them over deliberately: in a desktop webview page zoom would scale
  // the chrome too and fight the fluid layout.
  window.addEventListener("keydown", (event) => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;

    if (event.key === "=" || event.key === "+") {
      event.preventDefault();
      stepFontScale(FONT_SCALE_STEP);
    } else if (event.key === "-" || event.key === "_") {
      event.preventDefault();
      stepFontScale(-FONT_SCALE_STEP);
    } else if (event.key === "0") {
      event.preventDefault();
      resetFontScale();
    }
  });
}

// ---------------------------------------------------------------------------
// Language
// ---------------------------------------------------------------------------
//
// `i18n.js` owns the dictionaries and translates the static markup. Everything
// this file builds at runtime — the date pill, the calendar grid, the status
// line, the import list — has to be redrawn when the language changes, which
// is what `refreshForLocale` does.

/** Update the toggle button's label and tooltip for the active language. */
function renderLangToggle() {
  if (!els.langToggle) return;
  els.langToggle.textContent = nextLocaleShort();
  els.langToggle.title = t("lang.switchTitle");
  els.langToggle.setAttribute("aria-label", t("lang.switch"));
}

/**
 * Redraw every string this module generated itself.
 *
 * Called once at startup and again after each language switch. It is safe to
 * call while locked: the app section is hidden, so the redraws are cheap and
 * invisible, and the lock screen is re-rendered from `renderLockScreen`.
 */
function refreshForLocale() {
  renderLangToggle();
  lockScreen.renderLockScreen();
  calendar.renderWeekdayHeaders();
  renderDateLabel();
  renderFavouriteButton();
  applyTheme();
  updateWordCount();
  if (calendar.isCalendarOpen()) calendar.renderCalendar();
  if (visibleEntries.length > 0 || searchQuery.trim()) renderList();

  // The statistics dialog builds its labels in JS, so it has to be redrawn
  // when the language changes while it is open.
  if (statsDialog.isStatsOpen()) statsDialog.renderStats();

  // The import dialog is rebuilt from the last scan so its badges and buttons
  // follow the new language. A finished report is left alone: it is a record of
  // what happened, and re-rendering it would need the report object again.
  importDialog.refreshForLocale();
}

/** Wire the language toggle. */
function initLocaleSwitch() {
  initLocale();
  renderLangToggle();

  els.langToggle?.addEventListener("click", () => {
    toggleLocale();
  });

  // `i18n.js` has already re-translated the markup by the time this fires.
  onLocaleChange(() => refreshForLocale());
}

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------
//
// Three states, cycled by the lock-screen button:
//
//   "system" — follow `prefers-color-scheme`, and keep following it live
//   "light"  — always light, whatever the OS says
//   "dark"   — always dark
//
// The resolved theme is written to `<html data-theme="...">`, which is what the
// `:root[data-theme="dark"]` block in `styles.css` keys off. The attribute is
// used rather than a bare media query so an explicit choice can override the
// system setting.

const THEME_KEY = "fly-diary:theme";
const THEME_MODES = ["system", "light", "dark"];

/** One of `THEME_MODES`. */
let themeMode = "system";

/** The OS preference, kept current by the media-query listener. */
const darkQuery =
  typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-color-scheme: dark)")
    : null;

/** Which theme a mode resolves to right now. */
function resolveTheme(mode) {
  if (mode === "light" || mode === "dark") return mode;
  return darkQuery?.matches ? "dark" : "light";
}

/** Paint the resolved theme and refresh the button's icon and tooltip. */
function applyTheme() {
  const resolved = resolveTheme(themeMode);
  document.documentElement.dataset.theme = resolved;

  if (!els.themeToggle) return;
  els.themeToggle.dataset.themeMode = themeMode;
  // `aria-pressed` is not meaningful for a three-state cycle, so the button
  // reports its state through the label instead.
  els.themeToggle.setAttribute("aria-label", t("theme.toggle"));
  els.themeToggle.title = t(`theme.toggleTitle.${themeMode}`);
}

/** Advance to the next mode, persist it, and repaint. */
function cycleTheme() {
  const index = THEME_MODES.indexOf(themeMode);
  themeMode = THEME_MODES[(index + 1) % THEME_MODES.length];
  applyTheme();
  try {
    localStorage.setItem(THEME_KEY, themeMode);
  } catch {
    // Private mode or a locked-down webview: the choice just won't persist.
  }
}

/** Restore the saved mode, defaulting to following the system. */
function loadTheme() {
  let stored = null;
  try {
    stored = localStorage.getItem(THEME_KEY);
  } catch {
    stored = null;
  }
  themeMode = THEME_MODES.includes(stored) ? stored : "system";
  applyTheme();
}

/** Wire the toggle and the live system-preference listener. */
function initTheme() {
  loadTheme();

  els.themeToggle?.addEventListener("click", cycleTheme);

  // Only matters while the mode is "system", but listening unconditionally
  // keeps the handler simple: `applyTheme` re-resolves from scratch.
  const onSystemChange = () => {
    if (themeMode === "system") applyTheme();
  };
  if (darkQuery) {
    if (typeof darkQuery.addEventListener === "function") {
      darkQuery.addEventListener("change", onSystemChange);
    } else if (typeof darkQuery.addListener === "function") {
      // Older WebKit builds only ship the deprecated API.
      darkQuery.addListener(onSystemChange);
    }
  }
}

/** Entries currently passing the search filter, newest first. */
let visibleEntries = [];
/** Index of the first rendered row, used to skip redundant re-renders. */
let renderedStart = -1;
/** Index one past the last rendered row. */
let renderedEnd = -1;

/**
 * Recompute `visibleEntries` from `allEntries`, the active view and the search
 * query.
 *
 * The view filter runs first: the favourites page is a subset of the same
 * list, and searching inside it should only ever narrow that subset.
 */
function applyFilter() {
  const q = searchQuery.trim().toLowerCase();
  const base =
    currentView === "favourites"
      ? allEntries.filter((e) => e.favourite)
      : allEntries;
  visibleEntries = q
    ? base.filter(
        (e) => e.date.includes(q) || (e.title || "").toLowerCase().includes(q)
      )
    : base;
}

/** Build the DOM node for one entry row. */
function createRow(entry, index) {
  const li = document.createElement("li");
  li.className =
    "entry-item" +
    (entry.favourite ? " favourite" : "") +
    (entry.date === currentDate ? " active" : "");
  li.dataset.date = entry.date;
  li.style.top = `${index * ROW_HEIGHT}px`;

  const dateRow = document.createElement("div");
  dateRow.className = "entry-date";
  const dateText = document.createElement("span");
  dateText.textContent = entry.date;
  const weekday = document.createElement("span");
  weekday.className = "entry-weekday";
  weekday.textContent = weekdayOf(entry.date);
  dateRow.append(dateText, weekday);

  const preview = document.createElement("div");
  preview.className = "entry-preview" + (entry.title ? "" : " empty");
  preview.textContent = entry.title || t("common.untitled");

  li.append(dateRow, preview);
  li.addEventListener("click", () => selectDate(entry.date));
  return li;
}

/** Render only the rows that intersect the viewport. */
function renderVisibleRows(force = false) {
  const total = visibleEntries.length;
  const viewport = els.listScroll.clientHeight || 0;
  const scrollTop = els.listScroll.scrollTop;

  let start = Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN;
  if (start < 0) start = 0;
  let end = Math.ceil((scrollTop + viewport) / ROW_HEIGHT) + OVERSCAN;
  if (end > total) end = total;

  if (!force && start === renderedStart && end === renderedEnd) return;
  renderedStart = start;
  renderedEnd = end;

  const frag = document.createDocumentFragment();
  for (let i = start; i < end; i += 1) {
    frag.appendChild(createRow(visibleEntries[i], i));
  }
  els.list.replaceChildren(frag);
}

/** Full re-render: refilter, resize the spacer, then draw the viewport. */
function renderList() {
  applyFilter();

  // The calendar marks days that already have an entry, so it has to follow
  // the list. Only redraw while it is actually open.
  if (calendar.isCalendarOpen()) calendar.renderCalendar();

  if (visibleEntries.length === 0) {
    els.listSpacer.style.height = "0px";
    els.list.replaceChildren();
    renderedStart = -1;
    renderedEnd = -1;
    const li = document.createElement("li");
    li.className = "list-empty";
    if (searchQuery.trim()) {
      li.textContent =
        currentView === "favourites"
          ? t("sidebar.emptyFavouritesFiltered")
          : t("sidebar.emptyFiltered");
    } else {
      li.textContent =
        currentView === "favourites"
          ? t("sidebar.emptyFavourites")
          : t("sidebar.empty");
    }
    els.list.appendChild(li);
    return;
  }

  els.listSpacer.style.height = `${visibleEntries.length * ROW_HEIGHT}px`;
  renderVisibleRows(true);
}

/** Drop every rendered row and forget the viewport window (used on lock). */
function resetList() {
  visibleEntries = [];
  renderedStart = -1;
  renderedEnd = -1;
  els.listSpacer.style.height = "0px";
  els.list.replaceChildren();
  els.listScroll.scrollTop = 0;
}

/** Update the active highlight without rebuilding the list. */
function highlightActive() {
  for (const li of els.list.querySelectorAll(".entry-item")) {
    li.classList.toggle("active", li.dataset.date === currentDate);
  }
}

/** Scroll the sidebar so `date` is visible, rendering it if necessary. */
function scrollDateIntoView(date) {
  const index = visibleEntries.findIndex((e) => e.date === date);
  if (index < 0) return;

  const top = index * ROW_HEIGHT;
  const bottom = top + ROW_HEIGHT;
  const viewTop = els.listScroll.scrollTop;
  const viewBottom = viewTop + els.listScroll.clientHeight;

  if (top < viewTop) {
    els.listScroll.scrollTop = top;
  } else if (bottom > viewBottom) {
    els.listScroll.scrollTop = bottom - els.listScroll.clientHeight;
  }
  renderVisibleRows();
}

// ---------------------------------------------------------------------------
// Data operations
// ---------------------------------------------------------------------------

async function refreshList() {
  // Titles are encrypted, so listing only works while unlocked. Never leave
  // stale titles on screen after the key has been dropped.
  if (!lockScreen.isVaultInitialized()) {
    allEntries = [];
    renderList();
    return;
  }
  try {
    allEntries = await invoke("list_entries");
    renderList();
  } catch (err) {
    console.error("list_entries failed:", err);
    allEntries = [];
    renderList();
    setStatus(t("status.listFailed"));
  }
}

// ---------------------------------------------------------------------------
// Favourites
// ---------------------------------------------------------------------------

/**
 * Reflect `currentFavourite` on the bookmark button.
 *
 * `aria-pressed` is the single source of truth for the visual state (the CSS
 * fills the star from it), so the label and the tooltip are the only things
 * that need updating here.
 */
function renderFavouriteButton() {
  if (!els.favouriteBtn) return;
  els.favouriteBtn.setAttribute(
    "aria-pressed",
    currentFavourite ? "true" : "false"
  );
  els.favouriteBtn.title = currentFavourite
    ? t("editor.unfavouriteTitle")
    : t("editor.favouriteTitle");
  if (els.favouriteLabel) {
    els.favouriteLabel.textContent = currentFavourite
      ? t("editor.favouriteOn")
      : t("editor.favourite");
  }
}

/** Switch the sidebar between the "all" and "favourites" views. */
function setView(view) {
  if (view !== "all" && view !== "favourites") return;
  if (currentView === view) return;
  currentView = view;

  for (const [name, btn] of [
    ["all", els.viewAll],
    ["favourites", els.viewFavourites],
  ]) {
    if (!btn) continue;
    const active = name === view;
    btn.classList.toggle("is-active", active);
    btn.setAttribute("aria-selected", active ? "true" : "false");
  }

  // Keep the mobile bottom navigation in step with the sidebar tabs.
  if (mobile) mobile.renderNavTabs(view);

  // The row count changes, so the old scroll offset is meaningless.
  els.listScroll.scrollTop = 0;
  renderList();
}

/** Toggle the bookmark on the entry currently open in the editor. */
async function toggleFavourite() {
  if (!currentDate || favouriteBusy) return;
  // Nothing to bookmark until the entry exists on disk.
  if (!allEntries.some((e) => e.date === currentDate)) {
    setStatus(t("status.favouriteFailed"));
    return;
  }

  const next = !currentFavourite;
  favouriteBusy = true;
  els.favouriteBtn.disabled = true;
  try {
    const stored = await invoke("set_favourite", {
      date: currentDate,
      favourite: next,
    });
    currentFavourite = stored;
    renderFavouriteButton();
    setStatus(stored ? t("status.favourited") : t("status.unfavourited"), true);

    // Keep the cached metadata in step so the star and the favourites view
    // update without a round trip.
    const meta = allEntries.find((e) => e.date === currentDate);
    if (meta) meta.favourite = stored;

    // Un-favouriting while looking at the favourites page removes the row the
    // user is reading, so the list has to be rebuilt.
    if (currentView === "favourites") renderList();
    else renderVisibleRows(true);
  } catch (err) {
    console.error("set_favourite failed:", err);
    setStatus(t("status.favouriteFailed"));
  } finally {
    favouriteBusy = false;
    els.favouriteBtn.disabled = false;
  }
}

/** Load the entry for `date` into the editor. */
async function selectDate(date) {
  // Flush any pending save for the previous date before switching.
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
    await saveNow();
  }

  currentDate = date;
  els.datePicker.value = date;
  renderDateLabel();

  try {
    const entry = await invoke("get_entry", { date });
    const title = entry ? entry.title : "";
    const content = entry ? entry.content : "";
    suppressInput = true;
    els.title.value = title;
    els.content.value = content;
    suppressInput = false;
    savedTitle = title;
    savedContent = content;
    currentFavourite = entry ? Boolean(entry.favourite) : false;
    renderFavouriteButton();
    setStatus(entry ? t("status.loaded") : t("status.newEntry"));
  } catch (err) {
    console.error("get_entry failed:", err);
    setStatus(t("status.loadFailed"));
  }

  els.deleteBtn.disabled = !allEntries.some((e) => e.date === date);
  // A brand-new date has nothing to bookmark yet.
  els.favouriteBtn.disabled = els.deleteBtn.disabled;
  updateWordCount();
  scrollDateIntoView(date);
  highlightActive();
  els.content.focus();
}

/** Persist the current editor content immediately. */
async function saveNow() {
  if (!currentDate) return;
  const title = els.title.value;
  const content = els.content.value;
  if (title === savedTitle && content === savedContent) {
    setStatus(t("status.saved"), true);
    return;
  }

  setStatus(t("status.saving"));
  try {
    await invoke("save_entry", { date: currentDate, title, content });
    savedTitle = title;
    savedContent = content;
    setStatus(t("status.saved"), true);
    await refreshList();
    els.deleteBtn.disabled = content.trim() === "" && title.trim() === "";
  } catch (err) {
    console.error("save_entry failed:", err);
    setStatus(t("status.saveFailed"));
  }
}

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  setStatus(t("status.editing"));
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    await saveNow();
  }, AUTOSAVE_DELAY);
}

async function deleteCurrent() {
  if (!currentDate) return;
  const hasData =
    els.content.value.trim() !== "" || els.title.value.trim() !== "";
  if (hasData && !confirm(t("delete.confirm", { date: currentDate }))) {
    return;
  }

  try {
    await invoke("delete_entry", { date: currentDate });
    suppressInput = true;
    els.title.value = "";
    els.content.value = "";
    suppressInput = false;
    savedTitle = "";
    savedContent = "";
    updateWordCount();
    setStatus(t("status.deleted"));
    els.deleteBtn.disabled = true;
    els.favouriteBtn.disabled = true;
    currentFavourite = false;
    renderFavouriteButton();
    await refreshList();
  } catch (err) {
    console.error("delete_entry failed:", err);
    setStatus(t("status.deleteFailed"));
  }
}
// ---------------------------------------------------------------------------
// Editor reset / lock helpers
// ---------------------------------------------------------------------------
//
// `changeDiaryDir` and `lockNow` live in `lock-screen.js`, but they need to
// drop the editor state and flush the pending save before the session key is
// wiped. Those two operations are injected as callbacks so the lock screen
// module never touches the editor state directly.

/**
 * Drop everything the editor is holding.
 *
 * Called after the session key is gone, so nothing here may touch the backend.
 */
function resetEditorState() {
  currentDate = "";
  savedTitle = "";
  savedContent = "";
  allEntries = [];
  resetList();
  els.title.value = "";
  els.content.value = "";
}

/**
 * Flush the pending autosave, then lock the session.
 *
 * The write has to happen *before* `invoke("lock")`, otherwise the last
 * keystrokes would be lost when the key is dropped.
 */
async function lockAndFlush() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
    await saveNow();
  }
  try {
    await invoke("lock");
  } catch (err) {
    console.error("lock failed:", err);
  }
}

// ---------------------------------------------------------------------------
// Idle auto-lock
// ---------------------------------------------------------------------------

/** Idle minutes before locking; `0` disables auto-lock. */
let autoLockMinutes = 0;
/** Pending idle timer, or `null` when auto-lock is off or the app is locked. */
let autoLockTimer = null;

/** Events that count as "the user is still here". */
const ACTIVITY_EVENTS = [
  "mousemove",
  "mousedown",
  "keydown",
  "wheel",
  "touchstart",
  "focusin",
];

/**
 * Restart the idle countdown.
 *
 * Called on every activity event, so it must stay cheap: it only clears and
 * re-arms a single timeout. Throttling is unnecessary because `setTimeout`
 * itself is O(1) and the events are already coalesced by the browser.
 */
function resetAutoLockTimer() {
  if (autoLockTimer) {
    clearTimeout(autoLockTimer);
    autoLockTimer = null;
  }
  if (!autoLockMinutes || els.app.hidden) return;
  autoLockTimer = setTimeout(() => {
    autoLockTimer = null;
    // A pending keystroke must reach the disk before the key is dropped.
    lockNow();
  }, autoLockMinutes * 60 * 1000);
}

/** Stop the countdown, e.g. while the app is locked or the setting is off. */
function stopAutoLockTimer() {
  if (autoLockTimer) {
    clearTimeout(autoLockTimer);
    autoLockTimer = null;
  }
}

/** Apply a new auto-lock duration and re-arm the timer. */
function setAutoLockMinutes(minutes) {
  autoLockMinutes = Number(minutes) || 0;
  resetAutoLockTimer();
}

/** Wire the global activity listeners once, at startup. */
function initAutoLock() {
  for (const name of ACTIVITY_EVENTS) {
    // Capture phase so activity inside the editor counts even if a handler
    // stops propagation. `passive` keeps scrolling smooth.
    document.addEventListener(name, resetAutoLockTimer, {
      capture: true,
      passive: true,
    });
  }
  // Coming back to the window is activity too.
  window.addEventListener("focus", resetAutoLockTimer);
}

// ---------------------------------------------------------------------------
// Controller construction
// ---------------------------------------------------------------------------
//
// Every controller is created here, after all the callbacks it needs are
// defined. The order matters only in that `lockScreen` is built last: it is the
// one that closes over the other controllers.

function createControllers() {
  calendar = createCalendar({
    els,
    getCurrentDate: () => currentDate,
    selectDate,
    getEntries: () => allEntries,
    formatMonth,
    formatDate,
    weekdayName,
    t,
  });

  importDialog = createImportDialog({
    els,
    invoke,
    listen,
    t,
    setStatus,
    refreshList,
  });

  statsDialog = createStatsDialog({
    els,
    getEntries: () => allEntries,
    t,
    formatDate,
    weekdayName,
  });

  settingsDialog = createSettingsDialog({
    els,
    invoke,
    t,
    setStatus,
    setAutoLockMinutes,
  });

  // The mobile shell is built before the lock screen because `enterApp` and
  // `renderDateLabel` reach for it, and it only needs the calendar.
  mobile = createMobileShell({
    els,
    openCalendar: () => calendar.openCalendar(),
    closeCalendar: () => calendar.closeCalendar(),
    isCalendarOpen: () => calendar.isCalendarOpen(),
  });

  lockScreen = createLockScreen({
    els,
    invoke,
    t,
    setAutoLockMinutes,
    enterApp,
    resetAutoLockTimer,
    stopAutoLockTimer,
    refreshList,
    selectDate,
    resetEditorState,
    closeCalendar: () => calendar.closeCalendar(),
    closeImport: () => importDialog.closeImport(),
    closeSettings: () => settingsDialog.closeSettings(),
    renderDateLabel,
    lockAndFlush,
  });
}

/**
 * Enter the diary after a successful unlock.
 *
 * Lives here rather than in `lock-screen.js` because it is the hand-off point
 * between the lock screen and the editor: it reveals the app, then lets the
 * editor pick today's entry.
 */
async function enterApp() {
  els.lockScreen.hidden = true;
  els.app.hidden = false;
  // The mobile chrome is hidden by CSS on the desktop layout, so revealing it
  // here is harmless there and necessary here.
  if (mobile) mobile.setVisible(true);

  try {
    const path = await invoke("diary_path");
    els.diaryPath.textContent = path;
    els.diaryPath.title = path;
  } catch (err) {
    console.error("diary_path failed:", err);
  }

  // Start the idle countdown as soon as the diary is visible. The duration was
  // read from the settings file during `init()`.
  resetAutoLockTimer();

  await refreshList();

  const today = await invoke("today");
  await selectDate(today);
}

// ---------------------------------------------------------------------------
// Event wiring
// ---------------------------------------------------------------------------
//
// Every listener lives in `wiring.js`; this file only supplies the callbacks.
// Keeping the wiring out of the module body is what makes `main.js` importable
// from a test without a live webview.

/** Clear the pending autosave timer, if any. */
function clearPendingSave() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
}

/** Wire every listener once the initial state is known. */
function wireEvents() {
  initEventWiring({
    els,
    // Mobile shell (drawer, bottom navigation, FAB)
    mobile,
    // Lock screen
    handleUnlockSubmit: lockScreen.handleUnlockSubmit,
    browseForDir: lockScreen.browseForDir,
    resetKdfFields: lockScreen.resetKdfFields,
    updateKdfEstimate: lockScreen.updateKdfEstimate,
    refreshSetupVaultState: lockScreen.refreshSetupVaultState,
    lockNow: lockScreen.lockNow,
    changeDiaryDir: lockScreen.changeDiaryDir,
    // Editor
    scheduleSave,
    updateWordCount,
    selectDate,
    deleteCurrent,
    toggleFavourite,
    saveNow,
    hasPendingSave: () => saveTimer !== null,
    clearPendingSave,
    isInputSuppressed: () => suppressInput,
    // Calendar
    toggleCalendar: calendar.toggleCalendar,
    stepCalendarMonth: calendar.stepCalendarMonth,
    pickCalendarDate: calendar.pickCalendarDate,
    moveCalendarFocus: calendar.moveCalendarFocus,
    isCalendarOpen: calendar.isCalendarOpen,
    closeCalendar: calendar.closeCalendar,
    setCalendarMonth: calendar.setCalendarMonth,
    renderCalendar: calendar.renderCalendar,
    // Settings
    openSettings: settingsDialog.openSettings,
    closeSettings: settingsDialog.closeSettings,
    saveSettings: settingsDialog.saveSettings,
    calibrateKdf: settingsDialog.calibrateKdf,
    // Statistics
    openStats: statsDialog.openStats,
    closeStats: statsDialog.closeStats,
    isStatsOpen: statsDialog.isStatsOpen,
    // Import
    startImport: importDialog.startImport,
    closeImport: importDialog.closeImport,
    confirmImport: importDialog.confirmImport,
    isImportOpen: importDialog.isImportOpen,
    isImportDone: importDialog.isImportDone,
    // Sidebar
    setView,
    setSearchQuery: (query) => {
      searchQuery = query;
    },
    renderList,
    renderVisibleRows,
    // Date helpers
    today: () => invoke("today"),
    shiftDate,
    getCurrentDate: () => currentDate,
    monthStartOf,
    toISODate,
  });
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

async function init() {
  // Controllers first: the wiring below hands out their methods, so they have
  // to exist before any listener is attached.
  createControllers();

  // Listeners next: the lock screen is interactive as soon as it is shown, and
  // the wiring only reads state lazily through the callbacks, so it is safe to
  // attach before the settings have loaded.
  wireEvents();

  // Pick the language first: every other render below reads translated
  // strings, so the dictionaries have to be active before anything is drawn.
  initLocaleSwitch();

  // The row height is derived from the fluid root font size, so it has to be
  // measured before the first list render and re-measured on resize.
  watchRowHeight();

  // Restore the user's font size before anything is drawn, so the first paint
  // is already at the right scale.
  initFontScale();

  // Same for the theme: resolve it before the first paint so the app never
  // flashes light before switching to dark.
  initTheme();

  // Idle auto-lock listens globally; the duration arrives with the settings.
  initAutoLock();

  // The bookmark button starts disabled: no entry is open yet.
  renderFavouriteButton();
  els.favouriteBtn.disabled = true;

  // The weekday header never changes, so it is filled once.
  calendar.renderWeekdayHeaders();

  await lockScreen.loadKdfDefaults();
  try {
    await lockScreen.loadSettings();
    if (lockScreen.isConfigured()) {
      await lockScreen.refreshVaultState();
    } else {
      // First run: check the pre-filled default folder for an existing vault.
      await lockScreen.refreshSetupVaultState();
    }
  } catch (err) {
    console.error("settings load failed:", err);
    lockScreen.setConfigured(false);
    lockScreen.setVaultInitialized(false);
    els.lockError.textContent = t("lock.errSettings");
  }

  lockScreen.showLockScreen();
  lockScreen.renderLockScreen();
}

init();
