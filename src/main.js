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
import { createAutoLock } from "./lib/auto-lock.js";
import { historyItems } from "./lib/history.js";
import { highlightedSegments } from "./lib/highlight.js";
import {
  buildDisplayRows,
  rowIndexAt,
  yearsOf,
  firstRowForYear,
} from "./lib/list-rows.js";
import { prefersReducedMotion, setExitAnimationsEnabled } from "./lib/motion.js";
import { els } from "./dom.js";
import { initEventWiring } from "./wiring.js";
import { createCalendar } from "./calendar.js";
import { createImportDialog } from "./import-dialog.js";
import { createStatsDialog } from "./stats-dialog.js";
import { createSettingsDialog } from "./settings-dialog.js";
import { createRecoveryDialog } from "./recovery-dialog.js";
import { createLockScreen } from "./lock-screen.js";
import { createAttachmentGallery } from "./attachments.js";
import { createNativeFileDrop } from "./native-drop.js";
import { initInputModality } from "./input-modality.js";

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
/** Date → metadata and date → broken reason, for the review strip. */
let entriesByDate = new Map();
let brokenByDate = new Map();
/** Search filter string. */
let searchQuery = "";
/**
 * Full-text hits for `searchQuery`, or `null` while the query is empty (or the
 * backend index is not ready) and the local date/title filter is in charge.
 */
let searchResults = null;
/** Debounce timer for full-text search. */
let searchTimer = null;
/** Monotonic id so an out-of-order response can be discarded. */
let searchSeq = 0;
/** Milliseconds between the last keystroke and a backend search. */
const SEARCH_DEBOUNCE_MS = 200;
/** LocalStorage key for the "Looking back" collapsed state. */
const HISTORY_COLLAPSED_KEY = "fly-diary:history-collapsed";
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

/**
 * Milliseconds of inactivity before an autosave.
 *
 * Seeded with the backend default and replaced by the value from the settings
 * file during `init()`, so the very first keystroke already uses the user's
 * choice. `setAutosaveDelay` is the only writer.
 */
let autosaveDelay = 800;

/** Whether the Android folder-sync hooks are enabled (always false on desktop). */
let autoSyncEnabled = false;

/** Pending debounce for the post-save sync, if any. */
let syncDebounceTimer = null;

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
/** @type {ReturnType<typeof createRecoveryDialog>} */
let recoveryDialog;
/** @type {ReturnType<typeof createLockScreen>} */
let lockScreen;
/** @type {ReturnType<typeof createAttachmentGallery>} */
let attachmentGallery;
/** @type {ReturnType<typeof createNativeFileDrop>} */
let nativeFileDrop;

// ---------------------------------------------------------------------------
// Status / word count
// ---------------------------------------------------------------------------

let statusPulseTimer = null;

function setStatus(text, saved = false) {
  const changed = els.status.textContent !== text;
  els.status.textContent = text;
  els.status.classList.toggle("saved", saved);
  if (saved && changed && !prefersReducedMotion()) {
    // Restart the short confirmation pulse only when the message actually
    // changed; repeated autosaves of the same "Saved" text should not blink.
    els.status.classList.remove("is-pulsing");
    void els.status.offsetWidth;
    els.status.classList.add("is-pulsing");
    clearTimeout(statusPulseTimer);
    statusPulseTimer = setTimeout(
      () => els.status.classList.remove("is-pulsing"),
      220
    );
  }
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
 * The stylesheet is the source of truth: `.entry-row` is `height: var(--row-h)`
 * and the root font size is fluid, so the row height changes with the window.
 * We read the resolved value once at startup and again whenever the root size
 * changes (see `watchRowHeight`), instead of hard-coding a number that would
 * silently drift out of sync with the CSS.
 */
let ROW_HEIGHT = 52;
/** Height of a month separator row, measured from `--month-h`. */
let MONTH_HEIGHT = 28;
/** Extra rows rendered above and below the viewport to hide scroll seams. */
const OVERSCAN = 6;
/** Flat row model: entry rows and month separators, each with an absolute top. */
let displayRows = [];
/** Date → entry row, used for jumps without scanning the model. */
let entryRowByDate = new Map();
/** Last year chosen in the jump select. */
let selectedYear = "";
/** Set just before a filter/view render that should cross-fade. */
let animateNextList = false;

/** Read a rem-valued CSS custom property and return it in CSS pixels. */
function measureRem(property, fallback) {
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue(property)
    .trim();
  if (!raw) return fallback;

  // The tokens are authored in rem, so resolve against the root font size.
  const rem =
    parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  const value = raw.endsWith("rem") ? parseFloat(raw) * rem : parseFloat(raw);

  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Read `--row-h` from the document and return it in CSS pixels. */
function measureRowHeight() {
  return measureRem("--row-h", ROW_HEIGHT);
}

function measureMonthHeight() {
  return measureRem("--month-h", MONTH_HEIGHT);
}

/**
 * Keep the measured heights in sync with the stylesheet.
 *
 * The root font size is a `clamp()` over the viewport width, so resizing the
 * window changes both heights. When that happens the spacer and every rendered
 * row are stale, so we re-measure and redraw.
 */
function watchRowHeight() {
  const sync = () => {
    const nextRow = measureRowHeight();
    const nextMonth = measureMonthHeight();
    const rowChanged = Math.abs(nextRow - ROW_HEIGHT) >= 0.5;
    const monthChanged = Math.abs(nextMonth - MONTH_HEIGHT) >= 0.5;
    if (!rowChanged && !monthChanged) return;
    ROW_HEIGHT = nextRow;
    MONTH_HEIGHT = nextMonth;
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

  // The row and month heights are derived from the root font size, so the
  // virtual-scroll spacer and the rendered rows have to be recomputed.
  const nextRow = measureRowHeight();
  const nextMonth = measureMonthHeight();
  const rowChanged = Math.abs(nextRow - ROW_HEIGHT) >= 0.5;
  const monthChanged = Math.abs(nextMonth - MONTH_HEIGHT) >= 0.5;
  if (rowChanged || monthChanged) {
    ROW_HEIGHT = nextRow;
    MONTH_HEIGHT = nextMonth;
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
  renderHistory();
  applyTheme();
  updateWordCount();
  if (calendar.isCalendarOpen()) calendar.renderCalendar();
  attachmentGallery?.refreshForLocale();
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
// `:root[data-theme="dark"]` block in `styles/tokens.css` keys off. The attribute is
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
let themeTransitionTimer = null;

function applyTheme() {
  const resolved = resolveTheme(themeMode);
  const root = document.documentElement;
  const previous = root.dataset.theme;

  // Only animate a real switch after first paint. `previous` is empty during
  // startup, and an unchanged resolution (for example a locale refresh) should
  // not flash the whole interface.
  if (previous && previous !== resolved && !prefersReducedMotion()) {
    root.classList.add("theme-changing");
    // Flush the transition class before the palette changes so the browser
    // paints an interpolated path instead of swapping instantly.
    void root.offsetWidth;
    clearTimeout(themeTransitionTimer);
    themeTransitionTimer = setTimeout(
      () => root.classList.remove("theme-changing"),
      200
    );
  }

  root.dataset.theme = resolved;

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
 *
 * A non-empty query normally comes back from the backend as `searchResults`.
 * `null` means the index is not ready (or the query was just cleared), so the
 * cheap local date/title filter runs instead and the user still sees something
 * useful while typing.
 */
function applyFilter() {
  const q = searchQuery.trim().toLowerCase();
  if (q && searchResults !== null) {
    visibleEntries = searchResults;
    return;
  }
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

/** Cancel a pending debounced search. */
function cancelPendingSearch() {
  if (searchTimer) {
    clearTimeout(searchTimer);
    searchTimer = null;
  }
}

/**
 * Schedule a full-text search for the current query.
 *
 * The input handler already re-renders the local date/title filter, so this
 * only has to debounce the expensive request. Every request carries a sequence
 * number: typing while a search is in flight must not let the older response
 * overwrite the newer one.
 */
function scheduleSearch({ immediate = false } = {}) {
  cancelPendingSearch();
  const query = searchQuery.trim();
  if (!query) {
    searchSeq += 1;
    searchResults = null;
    renderList();
    return;
  }
  if (immediate) {
    void runSearch(query);
    return;
  }
  searchTimer = setTimeout(() => {
    searchTimer = null;
    void runSearch(query);
  }, SEARCH_DEBOUNCE_MS);
}

async function runSearch(query) {
  const seq = ++searchSeq;
  try {
    const response = await invoke("search_entries", {
      query,
      favouritesOnly: currentView === "favourites",
    });
    // A newer keystroke or a view switch invalidates this response.
    if (seq !== searchSeq || query !== searchQuery.trim()) return;
    if (!response?.ready) {
      searchResults = null;
      renderList();
      return;
    }
    searchResults = response.hits ?? [];
    renderList();
  } catch (err) {
    if (seq !== searchSeq || query !== searchQuery.trim()) return;
    console.error("search_entries failed:", err);
    searchResults = null;
    renderList();
    setStatus(t("sidebar.searchFailed"));
  }
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

/**
 * Append `text` to `container`, wrapping the UTF-16 ranges in `<mark>`.
 *
 * Ranges come from the backend as `[start, end]` pairs so the frontend never
 * has to re-implement case folding. Everything is inserted as text nodes: entry
 * content must never be interpreted as HTML.
 */
function appendHighlighted(container, text, ranges) {
  for (const segment of highlightedSegments(text, ranges)) {
    if (!segment.marked) {
      container.append(document.createTextNode(segment.text));
      continue;
    }
    const mark = document.createElement("mark");
    mark.textContent = segment.text;
    container.append(mark);
  }
}

/** Build the DOM node for one entry row. */
function createRow(entry, top) {
  const li = document.createElement("li");
  li.className = "entry-row";
  li.style.top = `${top}px`;

  // The row itself is the interactive element: a real button gives keyboard
  // users Enter/Space and screen readers an unambiguous "button" role.
  const button = document.createElement("button");
  button.type = "button";
  button.className =
    "entry-item" +
    (entry.favourite ? " favourite" : "") +
    (entry.date === currentDate ? " active" : "");
  button.dataset.date = entry.date;
  if (entry.date === currentDate) button.setAttribute("aria-current", "date");

  const dateRow = document.createElement("div");
  dateRow.className = "entry-date";
  const dateText = document.createElement("span");
  dateText.textContent = entry.date;
  const weekday = document.createElement("span");
  weekday.className = "entry-weekday";
  weekday.textContent = weekdayOf(entry.date);
  dateRow.append(dateText, weekday);

  const preview = document.createElement("div");
  if (Array.isArray(entry.matches) && typeof entry.snippet === "string") {
    preview.className = "entry-preview search-preview";
    const title = document.createElement("span");
    title.className = "search-title";
    title.textContent = entry.title || t("common.untitled");
    preview.append(title);
    if (entry.snippet) {
      preview.append(document.createTextNode(" · "));
      appendHighlighted(preview, entry.snippet, entry.matches);
    }
  } else {
    preview.className = "entry-preview" + (entry.title ? "" : " empty");
    preview.textContent = entry.title || t("common.untitled");
  }

  button.append(dateRow, preview);
  button.addEventListener("click", () => selectDate(entry.date));
  li.appendChild(button);
  return li;
}

/** Month separator: a horizontal rule with the localised month label. */
function createMonthRow(month, top = null) {
  const li = document.createElement("li");
  li.className = "entry-month" + (top === null ? " entry-month-static" : "");
  if (top !== null) li.style.top = `${top}px`;

  const label = document.createElement("span");
  label.className = "entry-month-label";
  label.textContent = formatMonth(`${month}-01`);
  li.appendChild(label);
  return li;
}

/** Render one row from the mixed entry/month display model. */
function createDisplayRow(row) {
  return row.type === "month"
    ? createMonthRow(row.month, row.top)
    : createRow(row.entry, row.top);
}

/** Visible height of the list viewport, excluding the sticky year bar. */
function listViewportHeight() {
  const barHeight =
    els.yearBar && !els.yearBar.hidden ? els.yearBar.offsetHeight : 0;
  return Math.max(0, (els.listScroll.clientHeight || 0) - barHeight);
}

/** Render only the rows that intersect the viewport. */
function renderVisibleRows(force = false) {
  const total = displayRows.length;
  if (total === 0) return;

  const viewport = listViewportHeight();
  const scrollTop = els.listScroll.scrollTop;

  let start = rowIndexAt(displayRows, scrollTop) - OVERSCAN;
  if (start < 0) start = 0;
  let end =
    rowIndexAt(displayRows, scrollTop + viewport) + 1 + OVERSCAN;
  if (end > total) end = total;

  if (!force && start === renderedStart && end === renderedEnd) return;
  renderedStart = start;
  renderedEnd = end;

  const frag = document.createDocumentFragment();
  for (let i = start; i < end; i += 1) {
    frag.appendChild(createDisplayRow(displayRows[i]));
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
  displayRows = [];
  entryRowByDate = new Map();
  hideYearJump();

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
  let month = "";
  for (const broken of rows) {
    const brokenMonth = broken.date.slice(0, 7);
    if (brokenMonth !== month) {
      frag.appendChild(createMonthRow(brokenMonth));
      month = brokenMonth;
    }

    const li = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "entry-item broken-item";
    button.dataset.date = broken.date;
    if (broken.date === currentDate) {
      button.setAttribute("aria-current", "date");
    }

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

    button.append(dateRow, preview);
    button.addEventListener("click", () => selectDate(broken.date));
    li.appendChild(button);
    frag.appendChild(li);
  }
  els.list.replaceChildren(frag);
}

function animateListSwap() {
  if (!els.list || prefersReducedMotion()) return;
  els.list.classList.remove("is-swapping");
  void els.list.offsetWidth;
  els.list.classList.add("is-swapping");
}

/** Mark the next render as a filter/view change worth animating. */
function requestListSwap() {
  animateNextList = true;
}

function finishListRender() {
  if (!animateNextList) return;
  animateNextList = false;
  animateListSwap();
}

/** Full re-render: refilter, resize the spacer, then draw the viewport. */
function renderList() {
  // The calendar marks days that already have an entry, so it has to follow
  // the list. Only redraw while it is actually open.
  if (calendar.isCalendarOpen()) calendar.renderCalendar();

  if (currentView === "broken") {
    renderBrokenList();
    finishListRender();
    return;
  }

  applyFilter();

  if (visibleEntries.length === 0) {
    els.listSpacer.style.height = "0px";
    els.list.replaceChildren();
    renderedStart = -1;
    renderedEnd = -1;
    displayRows = [];
    entryRowByDate = new Map();
    hideYearJump();
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
    finishListRender();
    return;
  }

  const model = buildDisplayRows(visibleEntries, ROW_HEIGHT, MONTH_HEIGHT);
  displayRows = model.rows;
  entryRowByDate = model.byDate;
  els.listSpacer.style.height = `${model.height}px`;
  renderYearJump();
  renderVisibleRows(true);
  finishListRender();
}

/** Drop every rendered row and forget the viewport window (used on lock). */
function resetList() {
  visibleEntries = [];
  displayRows = [];
  entryRowByDate = new Map();
  renderedStart = -1;
  renderedEnd = -1;
  els.listSpacer.style.height = "0px";
  els.list.replaceChildren();
  els.listScroll.scrollTop = 0;
  hideYearJump();
}

/** Update the active highlight without rebuilding the list. */
function highlightActive() {
  for (const item of els.list.querySelectorAll(".entry-item")) {
    const active = item.dataset.date === currentDate;
    item.classList.toggle("active", active);
    if (active) item.setAttribute("aria-current", "date");
    else item.removeAttribute("aria-current");
  }
}

/** Hide the year jump bar when there is nothing to jump through. */
function hideYearJump() {
  selectedYear = "";
  if (els.yearBar) els.yearBar.hidden = true;
  if (els.yearJump) els.yearJump.replaceChildren();
}

/** Rebuild the year options from the currently visible entries. */
function renderYearJump() {
  if (!els.yearBar || !els.yearJump) return;
  if (currentView === "broken") {
    hideYearJump();
    return;
  }
  const years = yearsOf(visibleEntries);
  if (years.length === 0) {
    hideYearJump();
    return;
  }

  const currentYear = currentDate ? currentDate.slice(0, 4) : "";
  if (!years.includes(selectedYear)) {
    selectedYear = years.includes(currentYear) ? currentYear : years[0];
  }

  const existing = [...els.yearJump.options].map((option) => option.value);
  if (existing.join("\u0000") !== years.join("\u0000")) {
    const options = years.map((year) => {
      const option = document.createElement("option");
      option.value = year;
      option.textContent = year;
      return option;
    });
    els.yearJump.replaceChildren(...options);
  }
  els.yearJump.value = selectedYear;
  els.yearBar.hidden = false;
}

/** Scroll to the first entry of `year`, keeping its month label visible. */
function jumpToYear(year) {
  if (!year) return;
  selectedYear = year;
  const hit = firstRowForYear(displayRows, year);
  if (!hit) return;
  els.listScroll.scrollTop = hit.header ? hit.header.top : hit.row.top;
  renderVisibleRows(true);
}

/** Scroll the sidebar so `date` is visible, rendering it if necessary. */
function scrollDateIntoView(date) {
  const row = entryRowByDate.get(date);
  if (!row) return;

  const header =
    row.index > 0 && displayRows[row.index - 1]?.type === "month"
      ? displayRows[row.index - 1]
      : null;
  const top = header ? header.top : row.top;
  const bottom = row.top + row.height;
  const viewTop = els.listScroll.scrollTop;
  const viewport = listViewportHeight();
  const viewBottom = viewTop + viewport;

  if (top < viewTop) {
    els.listScroll.scrollTop = top;
  } else if (bottom > viewBottom) {
    els.listScroll.scrollTop = bottom - viewport;
  }
  renderVisibleRows();
}

// ---------------------------------------------------------------------------
// Data operations
// ---------------------------------------------------------------------------

/** Rebuild the date-keyed lookup used by the review strip. */
function reindexEntries() {
  entriesByDate = new Map(allEntries.map((entry) => [entry.date, entry]));
  brokenByDate = new Map(brokenEntries.map((entry) => [entry.date, entry]));
}

/** Display title for a review card, including the broken and untitled cases. */
function historyTitle(item) {
  if (item.broken) return t("history.broken");
  return item.title || t("common.untitled");
}

/**
 * Draw the "on this day" cards for the date currently open.
 *
 * This uses only the metadata already loaded for the sidebar, so it costs no
 * IPC or decryption. The whole section is hidden when none of the three look-back
 * dates has an entry.
 */
function renderHistory() {
  if (!els.onThisDay || !els.onThisDayList) return;
  const items = currentDate
    ? historyItems(currentDate, entriesByDate, brokenByDate)
    : [];
  els.onThisDay.hidden = items.length === 0;
  if (items.length === 0) {
    els.onThisDayList.replaceChildren();
    return;
  }

  if (els.onThisDayTitle) {
    const isToday = currentDate === toISODate(new Date());
    els.onThisDayTitle.textContent = t(
      isToday ? "history.titleToday" : "history.title"
    );
  }

  const rows = items.map((item) => {
    const li = document.createElement("li");
    li.className = "on-this-day-item";

    const button = document.createElement("button");
    button.type = "button";
    button.className =
      "history-card" +
      (item.favourite ? " favourite" : "") +
      (item.broken ? " broken" : "");
    button.dataset.date = item.date;

    const offset = document.createElement("span");
    offset.className = "history-offset";
    offset.textContent = t(item.offsetKey);
    const date = document.createElement("span");
    date.className = "history-date";
    date.textContent = item.date;
    const title = document.createElement("span");
    title.className = "history-title";
    const titleText = historyTitle(item);
    title.textContent = titleText;

    button.append(offset, date, title);
    button.setAttribute(
      "aria-label",
      t("history.open", {
        offset: t(item.offsetKey),
        date: item.date,
        title: titleText,
      })
    );
    button.addEventListener("click", () => selectDate(item.date));
    li.appendChild(button);
    return li;
  });

  els.onThisDayList.replaceChildren(...rows);
}

/**
 * Restore the saved open/collapsed state of the review strip and persist it
 * when the summary is toggled. `<details>` provides the keyboard and screen
 * reader behaviour; only the preference needs wiring.
 */
function initHistoryDisclosure() {
  if (!els.onThisDay) return;
  try {
    if (localStorage.getItem(HISTORY_COLLAPSED_KEY) === "1") {
      els.onThisDay.open = false;
    }
  } catch {
    // Private mode or a locked-down webview: keep the default (open).
  }
  els.onThisDay.addEventListener("toggle", () => {
    try {
      localStorage.setItem(
        HISTORY_COLLAPSED_KEY,
        els.onThisDay.open ? "0" : "1"
      );
    } catch {
      // The state simply will not survive this session.
    }
  });
}

/**
 * Apply a broken-file list to the sidebar and its tab.
 *
 * The tab is hidden entirely when nothing is broken, so a healthy diary never
 * shows a scary red badge. `announce` is only true on the first load, so the
 * user is told once per session rather than on every autosave.
 */
function applyBrokenState(list, announce = false) {
  const previous = brokenEntries.length;
  brokenEntries = Array.isArray(list) ? list : [];
  reindexEntries();

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
  renderHistory();
}

/** Refresh the broken-file list without touching the search index. */
async function refreshBroken(announce = false) {
  try {
    applyBrokenState(await invoke("list_broken_entries"), announce);
  } catch (err) {
    console.error("list_broken_entries failed:", err);
    applyBrokenState([], announce);
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
 * `scanBroken` controls whether the vault is scanned end to end. That scan is
 * expensive: it reads, parses and decrypts *every* entry file, because a broken
 * file is by definition absent from the index and can only be found by walking
 * the directory. `scan_vault` does that work once and returns both the broken
 * list and a freshly built full-text index, so the two features never pay for
 * the same pass twice.
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
    searchResults = null;
    cancelPendingSearch();
    reindexEntries();
    renderList();
    renderHistory();
    return;
  }
  try {
    if (scanBroken) {
      const snapshot = await invoke("scan_vault");
      allEntries = snapshot?.entries ?? [];
      applyBrokenState(snapshot?.broken ?? [], false);
    } else {
      allEntries = await invoke("list_entries");
    }
    reindexEntries();
    renderHistory();
    renderList();
    // The scan may have changed an entry the user is currently searching for.
    if (scanBroken && searchQuery.trim()) {
      await runSearch(searchQuery.trim());
    }
  } catch (err) {
    console.error(scanBroken ? "scan_vault failed:" : "list_entries failed:", err);
    allEntries = [];
    reindexEntries();
    renderHistory();
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

/** A small pop on the bookmark button; the icon itself is CSS-filled. */
function popFavourite() {
  if (!els.favouriteBtn || prefersReducedMotion()) return;
  els.favouriteBtn.classList.remove("is-popping");
  void els.favouriteBtn.offsetWidth;
  els.favouriteBtn.classList.add("is-popping");
}

/**
 * Paint the active state on the three sidebar tabs.
 *
 * `aria-pressed` is the source of truth for assistive tech; the `is-active`
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
    btn.setAttribute("aria-pressed", active ? "true" : "false");
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
  requestListSwap();
  if (searchQuery.trim()) {
    // The favourites view changes which documents match, so the backend has to
    // run the query again with `favouritesOnly`.
    searchResults = null;
    renderList();
    scheduleSearch({ immediate: true });
  } else {
    renderList();
  }
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
    popFavourite();
    setStatus(stored ? t("status.favourited") : t("status.unfavourited"), true);

    // Keep the cached metadata in step so the star and the favourites view
    // update without a round trip.
    const meta = allEntries.find((e) => e.date === currentDate);
    if (meta) meta.favourite = stored;
    reindexEntries();
    renderHistory();

    // Un-favouriting while looking at the favourites page removes the row the
    // user is reading, so the list has to be rebuilt. With an active search the
    // backend index gained the new flag too, so rerun it to keep both views in
    // step.
    if (searchQuery.trim()) {
      searchResults = null;
      requestListSwap();
      renderList();
      scheduleSearch({ immediate: true });
    } else if (currentView === "favourites") {
      requestListSwap();
      renderList();
    } else {
      renderVisibleRows(true);
    }
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
  attachmentGallery?.setLocked(true);
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
  attachmentGallery?.setReadOnly();
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
  attachmentGallery?.setReadOnly();
  setStatus(t("status.editing"));
  els.content.focus();
}

/** Find the broken-file record for `date`, if there is one. */
function brokenEntryFor(date) {
  return brokenEntries.find((b) => b.date === date) || null;
}

/** Load the entry for `date` into the editor. */
// ---------------------------------------------------------------------------
// Phone layers
// ---------------------------------------------------------------------------
//
// On a phone-sized viewport the app is split into two layers: the list (date
// picker, search, entry list) and the editor. Only one is on screen at a time.
// The CSS keys off `data-layer` on `.app`; these helpers are the only writers.
// On wider viewports the attribute is ignored, so both panes stay visible.

const phoneLayout = window.matchMedia?.("(max-width: 640px)") ?? null;

/** Keep the off-screen phone layer out of the tab order immediately. */
function syncLayerInert() {
  if (!els.sidebar || !els.editor) return;
  if (!phoneLayout?.matches) {
    els.sidebar.inert = false;
    els.editor.inert = false;
    return;
  }
  const editorActive = els.app?.dataset.layer === "editor";
  els.sidebar.inert = editorActive;
  els.editor.inert = !editorActive;
}

/** Show the list layer. The editor is hidden until a date is picked. */
function showListLayer() {
  if (els.app) els.app.dataset.layer = "list";
  syncLayerInert();
}

/** Show the editor layer, filling the window on a phone. */
function showEditorLayer() {
  if (els.app) els.app.dataset.layer = "editor";
  syncLayerInert();
}

async function selectDate(date) {
  // Flush any pending save for the previous date before switching.
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
    await saveNow();
  }

  // Picking a date is the phone's "open this entry" gesture, so it moves to the
  // editor layer. On a wide viewport the attribute has no effect.
  showEditorLayer();

  // Drop the previous day's gallery immediately; the new list arrives after the
  // entry decrypts. Keeping the old images visible under the new date would be
  // worse than a brief empty strip.
  attachmentGallery?.clear();

  currentDate = date;
  els.datePicker.value = date;
  renderDateLabel();
  renderHistory();
  selectedYear = date.slice(0, 4);
  renderYearJump();

  // A known-broken file is never even read: `get_entry` would fail anyway, and
  // going straight to the locked state avoids a blank editor that looks
  // editable. Switching away and back re-enters this branch, so the lock
  // survives navigation.
  const broken = brokenEntryFor(date);
  if (broken) {
    lockEditor(date, broken.reason);
    attachmentGallery?.setLocked(true);
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
    await attachmentGallery?.load(date);
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
      attachmentGallery?.setLocked(true);
      renderList();
      scrollDateIntoView(date);
      highlightActive();
      return;
    }
    attachmentGallery?.clear();
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
    scheduleSyncAfterChange();
  } catch (err) {
    console.error("save_entry failed:", err);
    setStatus(t("status.saveFailed"));
  }
}

// ---------------------------------------------------------------------------
// Android folder sync hooks
// ---------------------------------------------------------------------------
//
// The backend owns the three-way comparison and conflict rules; the frontend
// only decides *when* to ask. A manual sync lives in the settings dialog. The
// optional automatic hooks run after unlock and, debounced, after a write.

/** Record the user's automatic-sync preference from the backend. */
function setSyncAutoEnabled(enabled) {
  autoSyncEnabled = Boolean(enabled);
  if (!autoSyncEnabled && syncDebounceTimer) {
    clearTimeout(syncDebounceTimer);
    syncDebounceTimer = null;
  }
}

/**
 * Apply a sync report to the visible state.
 *
 * Pulling an entry deletes the local index and makes the search index stale,
 * so this rescans rather than using the cheap `list_entries` path. If the entry
 * currently on screen was pulled, it is reloaded so the editor cannot keep
 * showing (and later overwrite) the old copy.
 */
async function afterSyncReport(report) {
  const pulled = report?.pulled ?? [];
  const conflicts = report?.conflicts ?? [];
  if (pulled.length > 0 || conflicts.length > 0) {
    await refreshList({ scanBroken: true });
  }
  if (currentDate && pulled.includes(`${currentDate}.xml`)) {
    await selectDate(currentDate);
  }
  if (conflicts.length > 0) {
    setStatus(t("sync.conflictCount", { n: conflicts.length }));
  }
}

/** Sync on unlock when the user enabled the automatic hooks. */
async function autoSyncOnUnlock() {
  if (!autoSyncEnabled) return;
  try {
    setStatus(t("sync.running"));
    const report = await invoke("sync_now");
    const pushed = report?.pushed?.length ?? 0;
    const pulled = report?.pulled?.length ?? 0;
    const conflicts = report?.conflicts?.length ?? 0;
    if (conflicts > 0) {
      setStatus(t("sync.conflictCount", { n: conflicts }));
    } else if (pushed || pulled) {
      setStatus(t("sync.result", { pushed, pulled, conflicts }), true);
    }
    await afterSyncReport(report);
  } catch (err) {
    // A failed automatic sync must not block the diary; the manual button in
    // settings shows the same error with the user watching.
    console.error("auto sync failed:", err);
    setStatus(t("sync.failed", { message: String(err) }));
  }
}

/**
 * Debounced sync after a local write.
 *
 * Autosave can fire every few seconds; waiting a couple of seconds batches a
 * paragraph into one SAF round trip instead of syncing each keystroke burst.
 */
function scheduleSyncAfterChange() {
  if (!autoSyncEnabled) return;
  if (syncDebounceTimer) clearTimeout(syncDebounceTimer);
  syncDebounceTimer = setTimeout(async () => {
    syncDebounceTimer = null;
    try {
      const report = await invoke("sync_now");
      await afterSyncReport(report);
    } catch (err) {
      console.error("auto sync failed:", err);
    }
  }, 2500);
}

/** Flush a pending autosave without locking, used before a manual sync. */
async function flushPendingSave() {
  if (!saveTimer) return;
  clearTimeout(saveTimer);
  saveTimer = null;
  await saveNow();
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
  }, autosaveDelay);
}

/**
 * Apply a new autosave delay.
 *
 * A timer that is already pending keeps its old deadline: re-arming it here
 * would push the write further away every time the user opens the settings
 * dialog, which is the opposite of what a shorter delay is for.
 */
function setAutosaveDelay(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value <= 0) return;
  autosaveDelay = value;
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
    // The entry is gone, but the date is still selected. Reloading shows an
    // empty gallery (and lets the user add images to a fresh entry) instead of
    // leaving a cleared, hidden section behind.
    await attachmentGallery?.load(currentDate);
    setStatus(t("status.deleted"));
    els.deleteBtn.disabled = true;
    els.favouriteBtn.disabled = true;
    currentFavourite = false;
    renderFavouriteButton();
    await refreshList();
    scheduleSyncAfterChange();
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
      await attachmentGallery?.load(date);
    }
    setStatus(t("broken.deleted"));
    await refreshList();
    // The broken list may now be empty, in which case `refreshBroken` has
    // already switched the sidebar back to "all".
    if (currentView === "broken") renderList();
    syncHeaderActions();
    scheduleSyncAfterChange();
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
  cancelUnlockTransition();
  currentDate = "";
  savedTitle = "";
  savedContent = "";
  allEntries = [];
  brokenEntries = [];
  reindexEntries();
  // Drop the decrypted result metadata before the backend clears its index, so
  // no title or snippet survives on the lock screen.
  searchResults = null;
  cancelPendingSearch();
  searchSeq += 1;
  renderHistory();
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
  attachmentGallery?.clear();
  if (currentView === "broken") {
    currentView = "all";
    syncViewTabs("all");
  }
}

/**
 * Flush the pending autosave, then lock the session.
 *
 * The write has to happen *before* `invoke("lock")`, otherwise the last
 * keystrokes would be lost when the key is dropped.
 */
async function lockAndFlush() {
  // No fading overlay ghosts above the lock screen: their z-index is higher
  // than the lock layer, and even a title or thumbnail must not linger there.
  setExitAnimationsEnabled(false);
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
    await saveNow();
  }
  try {
    await invoke("lock");
  } catch (err) {
    console.error("lock failed:", err);
    // The session is still unlocked, so animation is safe again.
    setExitAnimationsEnabled(true);
  }
}

// ---------------------------------------------------------------------------
// Idle auto-lock
// ---------------------------------------------------------------------------

/** Idle timer; the injected callback locks through the lock-screen controller. */
const autoLock = createAutoLock({
  // `lockScreen` is created later in this module; the callback resolves it when
  // the timer actually fires.
  lock: () => lockScreen.lockNow(),
  isUnlocked: () => !els.app.hidden,
});

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
 * Called on every activity event, so it must stay cheap. It first checks the
 * wall-clock deadline: if the webview throttled the timeout while backgrounded
 * or the machine slept, the first event after waking locks instead of silently
 * extending the session.
 */
function resetAutoLockTimer() {
  if (autoLock.expireIfDue()) return;
  autoLock.reset();
}

/** Stop the countdown, e.g. while the app is locked or the setting is off. */
function stopAutoLockTimer() {
  autoLock.stop();
}

/** Apply a new auto-lock duration and re-arm the timer. */
function setAutoLockMinutes(minutes) {
  autoLock.setMinutes(minutes);
}

/**
 * Lock on OS suspend, app backgrounding, or resume.
 *
 * Tauri emits `tauri://suspended` / `tauri://resumed` on platforms that support
 * it; `visibilitychange` covers webview backgrounding, including Android. Going
 * through `lockNow()` saves first, so a pending keystroke is not lost.
 */
function initSuspendLock() {
  const lockIfUnlocked = () => {
    if (!els.app.hidden) lockScreen.lockNow();
  };
  listen("tauri://suspended", lockIfUnlocked);
  listen("tauri://resumed", lockIfUnlocked);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") lockIfUnlocked();
    // Timers can be suspended while hidden; check the deadline as soon as the
    // webview is visible again.
    else resetAutoLockTimer();
  });
  window.addEventListener("pagehide", lockIfUnlocked);
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

/**
 * Attach images the OS dropped as filesystem paths.
 *
 * Native drag-drop reports paths instead of `File` objects. A normal read-only
 * entry unlocks on an explicit drop, matching paste and the HTML5 drop path; a
 * broken entry stays locked because its contents are unknown.
 */
function dropAttachmentPaths(paths) {
  if (!Array.isArray(paths) || paths.length === 0) return;
  if (!currentDate || lockedDate || readOnlyEntry) {
    setStatus(
      t(
        lockedDate
          ? "broken.lockedStatus"
          : readOnlyEntry
            ? "attachments.blocked"
            : "attachments.noDate"
      )
    );
    return;
  }
  attachmentGallery.addPaths(paths);
}

/**
 * Fallback for WebKitGTK, which may omit clipboard images from `paste`.
 *
 * Reads the clipboard natively, but refuses to touch a read-only or locked
 * entry. Editing state only changes through the explicit unlock button.
 */
async function pasteImageFromClipboard(expectImage = false) {
  if (!currentDate || lockedDate || readOnlyEntry) {
    if (expectImage) {
      setStatus(
        t(
          lockedDate
            ? "broken.lockedStatus"
            : readOnlyEntry
              ? "attachments.blocked"
              : "attachments.noDate"
        )
      );
    }
    return;
  }

  if (expectImage) setStatus(t("attachments.clipboardReading"));

  // Copying a file in a file manager puts paths on the clipboard; reading that
  // is much faster than asking the OS to negotiate a bitmap.
  const paths = await attachmentGallery.clipboardPaths();
  if (paths.length > 0 && (await attachmentGallery.addPaths(paths))) {
    return;
  }

  // The file list may be stale (for example a browser's temporary file), so a
  // failed path read falls through to the bitmap reader.
  const file = await attachmentGallery.clipboardImage();
  if (!file) {
    if (expectImage) {
      setStatus(
        attachmentGallery.clipboardError()
          ? t("attachments.clipboardFailed")
          : t("attachments.clipboardEmpty")
      );
    }
    return;
  }

  await attachmentGallery.addFiles([file]);
}

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
    setAutosaveDelay,
    // The vault-wide actions live in the settings dialog now. They are passed
    // as thunks because `importDialog`, `recoveryDialog` and `lockScreen` are
    // built below.
    openImport: () => importDialog.startImport(),
    openStats: () => statsDialog.openStats(),
    changeDiaryDir: () => lockScreen.changeDiaryDir(),
    openRecovery: () => recoveryDialog.open(),
    flushSave: flushPendingSave,
    flushAndLock: lockAndFlush,
    afterRestore: () => lockScreen.lockNow(),
    afterSync: afterSyncReport,
    setSyncAutoEnabled,
  });

  recoveryDialog = createRecoveryDialog({
    els,
    invoke,
    t,
    setStatus,
    onEnabled: () => settingsDialog.refreshRecoveryStatus(),
  });

  attachmentGallery = createAttachmentGallery({
    els,
    invoke,
    t,
    setStatus,
    canEdit: () => Boolean(currentDate) && !readOnlyEntry && !lockedDate,
    isLocked: () => Boolean(lockedDate),
    flushText: saveNow,
    refreshList,
    onEntryChanged: syncHeaderActions,
    onSyncNeeded: scheduleSyncAfterChange,
  });

  nativeFileDrop = createNativeFileDrop({
    getCurrentWebview: () => window.__TAURI__?.webview?.getCurrentWebview?.(),
    editor: els.editor,
    canDrop: () => attachmentGallery.canEdit(),
    onDrop: dropAttachmentPaths,
  });

  lockScreen = createLockScreen({
    els,
    invoke,
    t,
    setAutoLockMinutes,
    setAutosaveDelay,
    enterApp,
    resetAutoLockTimer,
    stopAutoLockTimer,
    refreshList,
    selectDate,
    resetEditorState,
    closeCalendar: () => calendar.closeCalendar(),
    closeImport: () => importDialog.closeImport(),
    closeSettings: () => settingsDialog.closeSettings(),
    closeRecovery: (options) => recoveryDialog.close(options),
    renderDateLabel,
    lockAndFlush,
  });
}

// ---------------------------------------------------------------------------
// Unlock hand-off
// ---------------------------------------------------------------------------

/** Must match the `lock-screen-leave` animation in lock.css. */
const UNLOCK_TRANSITION_MS = 260;
/** Bumped to cancel a transition when the app locks again mid-animation. */
let unlockTransitionToken = 0;

/** Abort a pending unlock animation, leaving the layers in a safe state. */
function cancelUnlockTransition() {
  unlockTransitionToken += 1;
  els.app?.classList.remove("is-entering");
  els.lockScreen?.classList.remove("is-leaving");
}

/**
 * Fade the lock screen out and the diary in.
 *
 * Resolves `true` when the lock layer is hidden, or `false` when a lock or a
 * second enter interrupted the hand-off. The data scan runs in parallel, so
 * the animation does not delay the first paint of the diary.
 */
function playUnlockTransition() {
  const token = ++unlockTransitionToken;
  setExitAnimationsEnabled(true);

  if (prefersReducedMotion()) {
    els.app.classList.remove("is-entering");
    els.lockScreen.classList.remove("is-leaving");
    els.lockScreen.hidden = true;
    return Promise.resolve(true);
  }

  els.lockScreen.classList.add("is-leaving");
  // Force a style flush so the app's entry animation starts from the `from`
  // frame even though `hidden` was just removed in the same task.
  void els.app.offsetWidth;
  els.app.classList.add("is-entering");

  return new Promise((resolve) => {
    setTimeout(() => {
      if (token !== unlockTransitionToken) {
        resolve(false);
        return;
      }
      els.lockScreen.hidden = true;
      els.lockScreen.classList.remove("is-leaving");
      els.app.classList.remove("is-entering");
      resolve(true);
    }, UNLOCK_TRANSITION_MS);
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
  els.app.hidden = false;

  // Kick the cross-fade off first; the scan below runs underneath it.
  const transition = playUnlockTransition();

  // On a phone the first screen is the list: the user picks a date or searches,
  // and only then does the editor take over. On a wide viewport this attribute
  // is ignored and both panes are visible.
  showListLayer();

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
  // Pull anything the external folder gained while the app was closed before
  // the user starts editing. A failure only surfaces in the status bar.
  await autoSyncOnUnlock();
  if (brokenEntries.length > 0) {
    setStatus(t("broken.notify", { n: brokenEntries.length }));
  }

  // If the user locked the diary while that scan was running, stop here rather
  // than pulling focus back into an app that is already behind the lock screen.
  if (!(await transition)) return;
  if (!els.lockScreen.hidden || els.app.hidden) return;

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
    showRecoveryForm: lockScreen.showRecoveryForm,
    hideRecoveryForm: lockScreen.hideRecoveryForm,
    handleRecoverySubmit: lockScreen.handleRecoverySubmit,
    lockNow: lockScreen.lockNow,
    // Editor
    scheduleSave,
    updateWordCount,
    selectDate,
    showListLayer,
    // Attachments
    pickAttachment: attachmentGallery.pickFile,
    canAttachImages: attachmentGallery.canEdit,
    onAttachmentBlocked: () => {
      // Read-only is a deliberate gate: an image paste/drop must not silently
      // unlock the entry. The user has to press "解鎖編輯" explicitly.
      setStatus(
        t(
          lockedDate
            ? "broken.lockedStatus"
            : readOnlyEntry
              ? "attachments.blocked"
              : "attachments.noDate"
        )
      );
    },
    addAttachmentFiles: attachmentGallery.addFiles,
    pasteImageFromClipboard,
    handleAttachmentClick: attachmentGallery.handleClick,
    attachmentDragStart: attachmentGallery.handleDragStart,
    attachmentDragOver: attachmentGallery.handleDragOver,
    attachmentDrop: attachmentGallery.handleDrop,
    attachmentDragEnd: attachmentGallery.handleDragEnd,
    isAttachmentViewerOpen: attachmentGallery.isViewerOpen,
    closeAttachmentViewer: attachmentGallery.closeViewer,
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
    // Android folder sync (the section is hidden on desktop).
    pickSyncDir: settingsDialog.pickSyncDir,
    syncNow: settingsDialog.syncNow,
    unbindSyncDir: settingsDialog.unbindSyncDir,
    setSyncAuto: settingsDialog.setSyncAuto,
    resolveSyncConflict: settingsDialog.resolveSyncConflict,
    // Recovery phrase: create/show-once dialog and removal.
    openRecovery: settingsDialog.openRecovery,
    removeRecovery: settingsDialog.removeRecovery,
    closeRecovery: recoveryDialog.close,
    continueRecovery: recoveryDialog.continueToConfirm,
    confirmRecovery: recoveryDialog.confirm,
    isRecoveryOpen: recoveryDialog.isOpen,
    // The vault-wide actions hosted by the settings dialog.
    openImportFromSettings: settingsDialog.openImport,
    openStatsFromSettings: settingsDialog.openStats,
    changeDiaryDirFromSettings: settingsDialog.changeDiaryDir,
    // Statistics
    closeStats: statsDialog.closeStats,
    isStatsOpen: statsDialog.isStatsOpen,
    // Import
    closeImport: importDialog.closeImport,
    confirmImport: importDialog.confirmImport,
    isImportOpen: importDialog.isImportOpen,
    isImportDone: importDialog.isImportDone,
    // Sidebar
    setView,
    setSearchQuery: (query) => {
      searchQuery = query;
      // Show the local date/title filter at once; the debounced backend query
      // replaces it with full-text hits when it returns.
      searchResults = null;
      // The wiring calls `renderList()` immediately after this, so the next
      // render is the filter swap worth cross-fading.
      requestListSwap();
      scheduleSearch();
    },
    renderList,
    renderVisibleRows,
    jumpToYear,
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
  // Focus rings follow the last input method. Do this before any controller
  // can move focus, so the lock screen's initial focus is not ringed.
  initInputModality();

  // Controllers first: the wiring below hands out their methods, so they have
  // to exist before any listener is attached.
  createControllers();

  // Listeners next: the lock screen is interactive as soon as it is shown, and
  // the wiring only reads state lazily through the callbacks, so it is safe to
  // attach before the settings have loaded.
  wireEvents();

  // Native drag-drop is the reliable source of dropped file paths. The HTML5
  // handlers remain as a fallback for webviews that still populate File objects.
  nativeFileDrop.start().catch((err) => {
    console.error("native drag-drop failed:", err);
  });

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
  initHistoryDisclosure();
  if (phoneLayout) {
    if (typeof phoneLayout.addEventListener === "function") {
      phoneLayout.addEventListener("change", syncLayerInert);
    } else if (typeof phoneLayout.addListener === "function") {
      phoneLayout.addListener(syncLayerInert);
    }
  }
  syncLayerInert();

  // Idle auto-lock listens globally; the duration arrives with the settings.
  initAutoLock();
  initSuspendLock();

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

  // Android folder sync is optional and absent on desktop; the flag only
  // controls the post-unlock/post-save hooks.
  invoke("get_sync_status")
    .then((status) => setSyncAutoEnabled(Boolean(status?.autoSync)))
    .catch(() => setSyncAutoEnabled(false));

  lockScreen.showLockScreen();
  lockScreen.renderLockScreen();
}

init();
