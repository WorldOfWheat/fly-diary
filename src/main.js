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
 * Which sidebar view is showing: `"all"`, `"favourites"` or `"broken"`.
 *
 * The first two read the same `allEntries` array; the favourites view is just an
 * extra filter, so switching never needs a second fetch or a second list. The
 * broken view is different: it reads `brokenEntries`, which comes from a
 * separate command and is rendered without virtual scrolling.
 */
let currentView = "all";
/**
 * Entry files that exist on disk but cannot be decrypted.
 *
 * Kept apart from `allEntries` on purpose: a broken file has no readable title,
 * and the backend never puts it in the index, so the two lists cannot overlap.
 */
let brokenEntries = [];
/**
 * Date whose entry file is undecryptable, or `""` when the editor is writable.
 *
 * While this is set the editor is read-only and autosave is suppressed, so a
 * blank editor can never overwrite a file we failed to read. It is cleared only
 * by deleting the file (or by locking the app).
 */
let lockedDate = "";
/**
 * Whether the entry on screen is open in read-only mode.
 *
 * Distinct from `lockedDate` on purpose. `lockedDate` means "this file cannot be
 * decrypted" — a failure state that only deleting the file can clear. This flag
 * means "this entry is fine, but the user has not asked to edit it yet": an entry
 * that already has content opens read-only so a stray keystroke cannot rewrite a
 * finished page, and clicking the unlock button in the header clears the flag.
 *
 * The two are mutually exclusive in practice — a broken file never reaches the
 * read-only path, because `selectDate` returns from the broken branch first.
 */
let readOnlyEntry = false;
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

/** Refresh the visible date pill. */
function renderDateLabel() {
  if (!currentDate) {
    els.dateMain.textContent = "—";
    els.dateSub.textContent = "";
    return;
  }
  els.dateMain.textContent = longDateOf(currentDate);
  els.dateSub.textContent = relativeDayOf(currentDate);
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

/** Broken rows matching the current search, newest first. */
function filteredBroken() {
  const q = searchQuery.trim().toLowerCase();
  if (!q) return brokenEntries;
  return brokenEntries.filter((b) => b.date.includes(q));
}

/** Human-readable explanation for a `BrokenReason` from the backend. */
function brokenReasonText(reason) {
  const key = `broken.reason.${reason}`;
  const text = t(key);
  // `t()` returns the key itself when it is missing, which would leak
  // `broken.reason.…` into the UI. Fall back to the generic message instead.
  return text === key ? t("broken.bannerBody") : text;
}

/** `1234` → `1.2 KB`. Small helper so the broken rows show a useful size. */
function formatBytes(bytes) {
  if (!bytes) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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

/**
 * Render the broken-files view.
 *
 * Deliberately not virtualised: the list is normally empty or a handful of
 * rows, and a plain list keeps the "export / delete" buttons simple. The spacer
 * is collapsed so the scroll container does not reserve phantom height.
 */
function renderBrokenList() {
  const rows = filteredBroken();
  els.listSpacer.style.height = "0px";
  renderedStart = -1;
  renderedEnd = -1;

  if (rows.length === 0) {
    els.list.replaceChildren();
    const li = document.createElement("li");
    li.className = "list-empty";
    li.textContent = searchQuery.trim()
      ? t("sidebar.emptyFiltered")
      : t("sidebar.emptyBroken");
    els.list.appendChild(li);
    return;
  }

  const frag = document.createDocumentFragment();
  for (const broken of rows) {
    const li = document.createElement("li");
    li.className = "entry-item broken-item";
    li.dataset.date = broken.date;
    li.style.position = "static";
    li.style.height = "auto";

    const dateRow = document.createElement("div");
    dateRow.className = "entry-date";
    const dateText = document.createElement("span");
    dateText.textContent = broken.date;
    const weekday = document.createElement("span");
    weekday.className = "entry-weekday";
    weekday.textContent = weekdayOf(broken.date);
    dateRow.append(dateText, weekday);

    const preview = document.createElement("div");
    preview.className = "entry-preview";
    preview.textContent = `${brokenReasonText(broken.reason)} · ${formatBytes(
      broken.size
    )}`;

    li.append(dateRow, preview);
    li.addEventListener("click", () => selectDate(broken.date));
    frag.appendChild(li);
  }
  els.list.replaceChildren(frag);
}

/** Full re-render: refilter, resize the spacer, then draw the viewport. */
function renderList() {
  // The calendar marks days that already have an entry, so it has to follow
  // the list. Only redraw while it is actually open.
  if (calendar.isCalendarOpen()) calendar.renderCalendar();

  if (currentView === "broken") {
    renderBrokenList();
    return;
  }

  applyFilter();

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

/**
 * Refresh the broken-file list and the sidebar tab that advertises it.
 *
 * The tab is hidden entirely when nothing is broken, so a healthy diary never
 * shows a scary red badge. `announce` is only true on the first load, so the
 * user is told once per session rather than on every autosave.
 */
async function refreshBroken(announce = false) {
  const previous = brokenEntries.length;
  try {
    brokenEntries = await invoke("list_broken_entries");
  } catch (err) {
    console.error("list_broken_entries failed:", err);
    brokenEntries = [];
  }

  if (els.brokenCount) {
    els.brokenCount.textContent = brokenEntries.length
      ? String(brokenEntries.length)
      : "";
  }
  if (els.viewBroken) {
    els.viewBroken.hidden = brokenEntries.length === 0;
  }

  // The broken view can empty out from under the user (they deleted the last
  // file), so fall back to "all" rather than showing a hidden tab.
  if (currentView === "broken" && brokenEntries.length === 0) {
    setView("all");
  }

  if (announce && brokenEntries.length > previous) {
    setStatus(t("broken.notify", { n: brokenEntries.length }));
  }
}

/**
 * Rewrite every entry that predates the current on-disk format.
 *
 * Called right after unlocking and deliberately not awaited by the caller: the
 * diary is already usable, and a large vault would otherwise keep the user
 * waiting. The backend reports progress through `upgrade-progress` events, which
 * are shown in the status bar; the final report is summarised once the run ends.
 *
 * Failures are *not* added to the broken list: an entry that could not be
 * upgraded is still perfectly readable in its old format, so it is not broken.
 */
async function upgradeEntries() {
  let unlisten = null;
  try {
    unlisten = await listen("upgrade-progress", (event) => {
      const { done, total } = event.payload ?? {};
      if (typeof done === "number" && typeof total === "number") {
        setStatus(t("upgrade.progress", { done, total }));
      }
    });
  } catch (err) {
    // Progress is cosmetic; the upgrade still works without it.
    console.warn("upgrade-progress listener failed:", err);
  }

  try {
    const report = await invoke("upgrade_entries");
    const upgraded = report?.upgraded?.length ?? 0;
    const failed = report?.failed?.length ?? 0;
    if (failed > 0) {
      setStatus(t("upgrade.partial", { upgraded, failed }));
    } else if (upgraded > 0) {
      setStatus(t("upgrade.done", { n: upgraded }), true);
    }
  } catch (err) {
    console.error("upgrade_entries failed:", err);
    setStatus(t("upgrade.failed", { message: String(err) }));
  } finally {
    if (typeof unlisten === "function") unlisten();
  }
}

/**
 * Reload the sidebar from disk.
 *
 * `scanBroken` controls whether the broken-file list is refreshed too. That
 * refresh is expensive: `list_broken_entries` reads, parses and decrypts *every*
 * entry file in the vault, because a broken file is by definition absent from
 * the index and can only be found by walking the directory.
 *
 * Saving cannot create a broken file — the app just wrote it with the key it
 * holds — so the autosave path passes `false` and skips the scan entirely. The
 * scan still runs on unlock, when the user opens the broken view, and whenever
 * an entry fails to read.
 */
async function refreshList({ scanBroken = true } = {}) {
  // Titles are encrypted, so listing only works while unlocked. Never leave
  // stale titles on screen after the key has been dropped.
  if (!lockScreen.isVaultInitialized()) {
    allEntries = [];
    brokenEntries = [];
    renderList();
    return;
  }
  try {
    allEntries = await invoke("list_entries");
    if (scanBroken) await refreshBroken();
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

/**
 * Paint the active state on the three sidebar tabs.
 *
 * `aria-selected` is the source of truth for assistive tech; the `is-active`
 * class is what the stylesheet keys off. Both have to move together, which is
 * why this lives in one place instead of being repeated at each call site.
 */
function syncViewTabs(view) {
  for (const [name, btn] of [
    ["all", els.viewAll],
    ["favourites", els.viewFavourites],
    ["broken", els.viewBroken],
  ]) {
    if (!btn) continue;
    const active = name === view;
    btn.classList.toggle("is-active", active);
    btn.setAttribute("aria-selected", active ? "true" : "false");
  }
}

/** Switch the sidebar between the "all", "favourites" and "broken" views. */
function setView(view) {
  if (view !== "all" && view !== "favourites" && view !== "broken") return;
  // The broken tab is hidden when there is nothing to show, so refuse to switch
  // to it rather than displaying an empty view with no way back.
  if (view === "broken" && brokenEntries.length === 0) return;
  if (currentView === view) return;
  currentView = view;

  syncViewTabs(view);

  // The row count changes, so the old scroll offset is meaningless.
  els.listScroll.scrollTop = 0;
  renderList();
}

/**
 * Enable or disable the two header actions for the current date.
 *
 * Both depend on the same fact — whether an entry file exists for this date —
 * so they are set together. The favourite button is disabled on a brand-new
 * date because `set_favourite` is a no-op for a missing file: it returns
 * `Ok(false)` rather than creating one, so the star would silently do nothing.
 *
 * Called from `selectDate` after loading, and from `saveNow` after a write,
 * which is the moment a new entry starts existing.
 */
function syncHeaderActions() {
  const exists = allEntries.some((e) => e.date === currentDate);
  els.deleteBtn.disabled = !exists;
  els.favouriteBtn.disabled = !exists;
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

/**
 * Blank the editor without triggering autosave.
 *
 * `suppressInput` is what stops the `input` listener from scheduling a write,
 * and it must be cleared again on every path — a stuck `true` would silently
 * disable autosave for the rest of the session. Keeping the pair in one place
 * is the point of this helper.
 */
function clearEditorFields() {
  suppressInput = true;
  els.title.value = "";
  els.content.value = "";
  suppressInput = false;
  savedTitle = "";
  savedContent = "";
}

/**
 * Put the editor into read-only mode for `date`.
 *
 * The fields are disabled rather than merely ignored so the browser cannot
 * accept a keystroke that would never be saved. `lockedDate` is the flag the
 * save path checks, so even a programmatic `saveNow()` cannot write.
 */
function lockEditor(date, reason) {
  lockedDate = date;
  clearEditorFields();
  els.title.disabled = true;
  els.content.disabled = true;
  if (els.editor) els.editor.classList.add("is-locked");
  if (els.brokenBanner) els.brokenBanner.hidden = false;
  if (els.brokenBannerReason) {
    els.brokenBannerReason.textContent = reason
      ? brokenReasonText(reason)
      : t("broken.bannerBody");
  }
  els.deleteBtn.disabled = false;
  els.favouriteBtn.disabled = true;
  currentFavourite = false;
  renderFavouriteButton();
  updateWordCount();
  setStatus(t("broken.lockedStatus"));
}

/** Return the editor to its normal, writable state. */
function unlockEditor() {
  lockedDate = "";
  els.title.disabled = false;
  els.content.disabled = false;
  if (els.editor) els.editor.classList.remove("is-locked");
  if (els.brokenBanner) els.brokenBanner.hidden = true;
}

/**
 * Show an existing entry without letting it be edited yet.
 *
 * `readOnly` rather than `disabled`: the text stays selectable and scrollable, so
 * the user can read and copy from the entry, and the caret cannot land in it. The
 * unlock button in the header is the only way out, which makes "I opened a
 * finished page" and "I am editing it" two visibly different states.
 *
 * The fields keep their content — unlike `lockEditor`, nothing is blanked, because
 * there is nothing wrong with this file.
 */
function lockEntryForReading() {
  readOnlyEntry = true;
  els.title.readOnly = true;
  els.content.readOnly = true;
  if (els.editor) els.editor.classList.add("is-readonly");
  if (els.editBtn) els.editBtn.hidden = false;
  setStatus(t("status.readOnly"));
}

/** Swap the read-only entry into its writable state and put the caret in it. */
function unlockEntryForEditing() {
  if (!readOnlyEntry) return;
  readOnlyEntry = false;
  els.title.readOnly = false;
  els.content.readOnly = false;
  if (els.editor) els.editor.classList.remove("is-readonly");
  if (els.editBtn) els.editBtn.hidden = true;
  setStatus(t("status.editing"));
  els.content.focus();
}

/** Find the broken-file record for `date`, if there is one. */
function brokenEntryFor(date) {
  return brokenEntries.find((b) => b.date === date) || null;
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

  // A known-broken file is never even read: `get_entry` would fail anyway, and
  // going straight to the locked state avoids a blank editor that looks
  // editable. Switching away and back re-enters this branch, so the lock
  // survives navigation.
  const broken = brokenEntryFor(date);
  if (broken) {
    lockEditor(date, broken.reason);
    scrollDateIntoView(date);
    highlightActive();
    return;
  }

  unlockEditor();
  // Every load starts writable; the read-only gate is re-applied below only if
  // this particular entry turns out to have content. Without this reset, moving
  // from a locked entry to a brand-new date would leave the new date locked too.
  readOnlyEntry = false;
  els.title.readOnly = false;
  els.content.readOnly = false;
  if (els.editor) els.editor.classList.remove("is-readonly");
  if (els.editBtn) els.editBtn.hidden = true;

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
    // An entry that already has something in it opens read-only: the user asked
    // to read it, not to change it. A blank date stays editable so a new entry
    // can be typed straight away.
    if (title.trim() !== "" || content.trim() !== "") {
      lockEntryForReading();
    } else {
      setStatus(t("status.newEntry"));
    }
  } catch (err) {
    // The file exists but could not be decrypted. Lock the editor so the blank
    // fields cannot be autosaved over the file we just failed to read, and
    // refresh the broken list so the sidebar shows it too.
    console.error("get_entry failed:", err);
    await refreshBroken();
    const nowBroken = brokenEntryFor(date);
    if (nowBroken) {
      lockEditor(date, nowBroken.reason);
      renderList();
      scrollDateIntoView(date);
      highlightActive();
      return;
    }
    setStatus(t("status.loadFailed"));
  }

  syncHeaderActions();
  updateWordCount();
  scrollDateIntoView(date);
  highlightActive();
  // Focusing a read-only field would put a caret in text the user cannot change,
  // which reads as "editable but broken". The unlock button takes the focus
  // instead, so Enter or Space opens the entry for editing.
  if (readOnlyEntry) {
    if (els.editBtn) els.editBtn.focus();
  } else {
    els.content.focus();
  }
}

/** Persist the current editor content immediately. */
async function saveNow() {
  if (!currentDate) return;
  // Never write to a file we could not read: the editor is blank, so saving
  // would replace the undecryptable bytes with an empty entry.
  if (lockedDate) return;
  // A read-only entry has not been touched, so there is nothing to write. This
  // also covers the flush that `selectDate` performs when navigating away.
  if (readOnlyEntry) return;
  const title = els.title.value;
  const content = els.content.value;
  if (title === savedTitle && content === savedContent) {
    setStatus(t("status.saved"), true);
    // Nothing was written, but the header may still be stale — for example when
    // this is the flush that follows a save which already created the entry.
    syncHeaderActions();
    return;
  }

  setStatus(t("status.saving"));
  try {
    await invoke("save_entry", { date: currentDate, title, content });
    savedTitle = title;
    savedContent = content;
    setStatus(t("status.saved"), true);
    // Skip the broken-file scan: this save just wrote the file itself, so it
    // cannot have produced an unreadable one. Rescanning the whole vault here
    // is what made autosave stutter on a large diary.
    await refreshList({ scanBroken: false });
    // The entry exists on disk now, so both header actions become usable. The
    // favourite button in particular starts disabled on a brand-new date (there
    // is nothing to bookmark yet) and used to stay that way until the user
    // navigated away and back, because only `selectDate` ever re-enabled it.
    syncHeaderActions();
  } catch (err) {
    console.error("save_entry failed:", err);
    setStatus(t("status.saveFailed"));
  }
}

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  // A locked entry has nothing to save, and showing "editing" would suggest
  // otherwise.
  if (lockedDate) return;
  // Same for a read-only entry: the fields cannot produce an `input` event, but
  // a stray programmatic call should not flip the status to "editing" either.
  if (readOnlyEntry) return;
  setStatus(t("status.editing"));
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    await saveNow();
  }, AUTOSAVE_DELAY);
}

async function deleteCurrent() {
  if (!currentDate) return;

  // A locked entry is always confirmed, even though the editor looks empty:
  // the file on disk is not empty, and deleting it is irreversible.
  if (lockedDate) {
    if (!confirm(t("broken.deleteConfirm", { date: currentDate }))) return;
    await deleteBrokenFile(currentDate);
    return;
  }

  const hasData =
    els.content.value.trim() !== "" || els.title.value.trim() !== "";
  if (hasData && !confirm(t("delete.confirm", { date: currentDate }))) {
    return;
  }

  try {
    await invoke("delete_entry", { date: currentDate });
    clearEditorFields();
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
// Broken entries
// ---------------------------------------------------------------------------

/**
 * Copy the broken file somewhere the user picks.
 *
 * The backend copies the bytes verbatim, so whatever is in the file survives
 * even though the app cannot parse it. After a successful export the user is
 * asked whether to delete the original — never deleted automatically.
 */
async function exportBrokenFile(date) {
  try {
    const dest = await invoke("export_broken_entry", { date });
    if (!dest) return; // The user cancelled the save dialog.
    setStatus(t("broken.exported", { path: dest }), true);
    if (confirm(t("broken.deleteConfirmAfterExport", { date }))) {
      await deleteBrokenFile(date);
    }
  } catch (err) {
    console.error("export_broken_entry failed:", err);
    setStatus(t("broken.exportFailed", { message: String(err) }));
  }
}

/** Delete a broken file and leave the editor in a clean state. */
async function deleteBrokenFile(date) {
  try {
    await invoke("delete_entry", { date });
    if (lockedDate === date) {
      unlockEditor();
      clearEditorFields();
      updateWordCount();
    }
    setStatus(t("broken.deleted"));
    await refreshList();
    // The broken list may now be empty, in which case `refreshBroken` has
    // already switched the sidebar back to "all".
    if (currentView === "broken") renderList();
    syncHeaderActions();
  } catch (err) {
    console.error("delete_entry failed:", err);
    setStatus(t("broken.deleteFailed", { message: String(err) }));
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
  brokenEntries = [];
  unlockEditor();
  // The read-only gate belongs to the entry that was open, so it goes with it.
  readOnlyEntry = false;
  els.title.readOnly = false;
  els.content.readOnly = false;
  if (els.editor) els.editor.classList.remove("is-readonly");
  if (els.editBtn) els.editBtn.hidden = true;
  resetList();
  els.title.value = "";
  els.content.value = "";
  if (els.brokenCount) els.brokenCount.textContent = "";
  if (els.viewBroken) els.viewBroken.hidden = true;
  if (currentView === "broken") {
    currentView = "all";
    syncViewTabs("all");
  }
}

/**
 * Turn screenshot / screen-recording protection on or off.
 *
 * The window starts protected (`contentProtected: true` in `tauri.conf.json`),
 * so this only ever needs to *relax* it — while the workspace picker is open,
 * where the user may legitimately want to share their screen — and then restore
 * it. Failures are logged, never surfaced: on Linux the backend call is a no-op
 * and the app must keep working.
 */
async function setScreenshotProtection(protected_) {
  try {
    await invoke("set_screenshot_protection", { protected: protected_ });
  } catch (err) {
    console.error("set_screenshot_protection failed:", err);
  }
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
    setScreenshotProtection,
  });
}

/**
 * Enter the diary after a successful unlock.
 *
 * Lives here rather than in `lock-screen.js` because it is the hand-off point
 * between the lock screen and the editor: it reveals the app, then lets the
 * editor pick today's entry. The lock screen calls it through `deps.enterApp`,
 * so this is the single implementation of the unlock hand-off.
 */
async function enterApp() {
  els.lockScreen.hidden = true;
  els.app.hidden = false;

  // The window is created with `contentProtected: true`, so the lock screen is
  // covered too. Re-assert it here in case the workspace picker turned it off.
  setScreenshotProtection(true);

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

  // The first load is the one place that must scan: files may have been edited
  // or moved while the app was closed. `announce` tells the user once, on entry,
  // if anything failed to decrypt; the tab badge stays visible afterwards.
  await refreshList();
  if (brokenEntries.length > 0) {
    setStatus(t("broken.notify", { n: brokenEntries.length }));
  }

  const today = await invoke("today");
  await selectDate(today);

  // Rewrite any entry that predates the current on-disk format. Deliberately
  // not awaited: the diary is already usable, and a large vault would otherwise
  // keep the user staring at the editor for seconds. The run is idempotent, so
  // an interrupted one simply resumes on the next unlock.
  upgradeEntries();
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
    // Lock screen
    handleUnlockSubmit: lockScreen.handleUnlockSubmit,
    browseForDir: lockScreen.browseForDir,
    openWorkspacePicker: lockScreen.openWorkspacePicker,
    cancelWorkspacePicker: lockScreen.cancelWorkspacePicker,
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
    unlockEntryForEditing,
    saveNow,
    exportBrokenFile: () => exportBrokenFile(currentDate),
    hasPendingSave: () => saveTimer !== null,
    clearPendingSave,
    isInputSuppressed: () => suppressInput,
    // Calendar
    toggleCalendar: calendar.toggleCalendar,
    stepCalendarMonth: calendar.stepCalendarMonth,
    stepCalendarYear: calendar.stepCalendarYear,
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
