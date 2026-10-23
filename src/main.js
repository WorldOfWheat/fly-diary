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
import {
  toISODate,
  fromISODate,
  shiftDate,
  monthStartOf,
  shiftMonth,
  calendarGrid,
} from "./lib/dates.js";
import {
  computeStreaks,
  monthlyBuckets,
  weekdayBuckets,
  barFractions,
} from "./lib/stats.js";

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
/** Whether the app has a settings file (i.e. the diary location is known). */
let configured = false;
/** Whether the vault has been created before (first run shows confirm field). */
let vaultInitialized = false;
/** First day of the month currently shown in the calendar popup, `YYYY-MM-01`. */
let calendarMonth = "";

const AUTOSAVE_DELAY = 800;

// ---------------------------------------------------------------------------
// DOM references
// ---------------------------------------------------------------------------

const $ = (id) => document.getElementById(id);
const els = {
  // Lock screen
  lockScreen: $("lock-screen"),
  lockForm: $("lock-form"),
  langToggle: $("lang-toggle"),
  themeToggle: $("theme-toggle"),
  lockSubtitle: $("lock-subtitle"),
  lockError: $("lock-error"),
  lockSubmit: $("lock-submit"),
  passphrase: $("passphrase"),
  passphraseConfirm: $("passphrase-confirm"),
  pathField: $("path-field"),
  diaryDir: $("diary-dir"),
  browseDir: $("browse-dir"),
  advancedField: $("advanced-field"),
  kdfMemory: $("kdf-memory"),
  kdfIterations: $("kdf-iterations"),
  kdfParallelism: $("kdf-parallelism"),
  kdfEstimate: $("kdf-estimate"),
  kdfReset: $("kdf-reset"),
  // App
  app: $("app"),
  list: $("entry-list"),
  listScroll: $("entry-scroll"),
  listSpacer: $("entry-spacer"),
  search: $("search"),
  viewAll: $("view-all"),
  viewFavourites: $("view-favourites"),
  favouriteBtn: $("favourite-btn"),
  favouriteLabel: $("favourite-label"),
  datePicker: $("date-picker"),
  dateLabel: $("date-label"),
  dateMain: $("date-main"),
  dateSub: $("date-sub"),
  calendar: $("calendar"),
  calPrev: $("cal-prev"),
  calNext: $("cal-next"),
  calTitle: $("cal-title"),
  calWeekdays: $("cal-weekdays"),
  calGrid: $("cal-grid"),
  calToday: $("cal-today"),
  title: $("title"),
  content: $("content"),
  status: $("status"),
  wordCount: $("word-count"),
  fontSmaller: $("font-smaller"),
  fontLarger: $("font-larger"),
  fontReset: $("font-reset"),
  diaryPath: $("diary-path"),
  prevDay: $("prev-day"),
  nextDay: $("next-day"),
  newToday: $("new-today"),
  deleteBtn: $("delete-btn"),
  lockBtn: $("lock-btn"),
  changeDirBtn: $("change-dir-btn"),
  settingsBtn: $("settings-btn"),
  statsBtn: $("stats-btn"),
  // Statistics dialog
  statsOverlay: $("stats-overlay"),
  statsClose: $("stats-close"),
  statsDone: $("stats-done"),
  statsTotal: $("stats-total"),
  statsFavourites: $("stats-favourites"),
  statsStreak: $("stats-streak"),
  statsLongest: $("stats-longest"),
  statsRange: $("stats-range"),
  statsMonths: $("stats-months"),
  statsWeekdays: $("stats-weekdays"),
  // Settings dialog
  settingsOverlay: $("settings-overlay"),
  settingsClose: $("settings-close"),
  settingsCancel: $("settings-cancel"),
  settingsSave: $("settings-save"),
  settingsError: $("settings-error"),
  autoLockSelect: $("auto-lock-select"),
  vaultKdf: $("vault-kdf"),
  settingsCurrentPass: $("settings-current-pass"),
  settingsNewPass: $("settings-new-pass"),
  settingsNewPassConfirm: $("settings-new-pass-confirm"),
  settingsKdfMemory: $("settings-kdf-memory"),
  settingsKdfIterations: $("settings-kdf-iterations"),
  settingsKdfParallelism: $("settings-kdf-parallelism"),
  settingsCalibrate: $("settings-calibrate"),
  settingsCalibrateNote: $("settings-calibrate-note"),
  // Import dialog
  importBtn: $("import-btn"),
  importOverlay: $("import-overlay"),
  importClose: $("import-close"),
  importCancel: $("import-cancel"),
  importConfirm: $("import-confirm"),
  importDir: $("import-dir"),
  importReady: $("import-ready"),
  importConflicts: $("import-conflicts"),
  importFailed: $("import-failed"),
  importOverwriteRow: $("import-overwrite-row"),
  importOverwrite: $("import-overwrite"),
  importList: $("import-list"),
  importProgress: $("import-progress"),
  importProgressBar: $("import-progress-bar"),
  importProgressCount: $("import-progress-count"),
  importProgressTrack: document.querySelector(
    "#import-progress .import-progress-track"
  ),
  importResult: $("import-result"),
  importError: $("import-error"),
};

// ---------------------------------------------------------------------------
// Date helpers (local timezone, no UTC drift)
// ---------------------------------------------------------------------------
//
// `toISODate` / `fromISODate` / `shiftDate` / `monthStartOf` / `shiftMonth` /
// `calendarGrid` live in `lib/dates.js` so they can be unit-tested without a
// DOM. The two wrappers below stay here because they need the active locale.

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
// Calendar popup
// ---------------------------------------------------------------------------

/** Dates that already have an entry, for the little dot in the grid. */
function entryDateSet() {
  return new Set(allEntries.map((e) => e.date));
}

/** Fill the weekday header row. Monday-first, matching the grid below. */
function renderWeekdayHeaders() {
  if (!els.calWeekdays) return;
  const frag = document.createDocumentFragment();
  // `getDay()` is Sunday-based; the grid starts on Monday, so walk 1..6 then 0.
  for (let i = 1; i <= 7; i += 1) {
    const span = document.createElement("span");
    span.textContent = weekdayName(i % 7);
    frag.appendChild(span);
  }
  els.calWeekdays.replaceChildren(frag);
}

/** Build the 6×7 grid of day buttons for `calendarMonth`. */
function renderCalendar() {
  const month = Number(calendarMonth.slice(5, 7));
  els.calTitle.textContent = formatMonth(calendarMonth);

  const today = toISODate(new Date());
  const withEntries = entryDateSet();

  const frag = document.createDocumentFragment();
  for (const iso of calendarGrid(calendarMonth)) {
    const d = fromISODate(iso);

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "cal-day";
    btn.dataset.date = iso;
    btn.textContent = String(d.getDate());
    btn.setAttribute("role", "gridcell");
    btn.setAttribute("aria-label", longDateOf(iso));

    if (d.getMonth() !== month - 1) btn.classList.add("outside");
    if (iso === today) btn.classList.add("today");
    if (iso === currentDate) {
      btn.classList.add("selected");
      btn.setAttribute("aria-selected", "true");
    }
    if (withEntries.has(iso)) btn.classList.add("has-entry");

    frag.appendChild(btn);
  }
  els.calGrid.replaceChildren(frag);
}

function isCalendarOpen() {
  return !els.calendar.hidden;
}

function openCalendar() {
  // Always open on the month of the selected date.
  calendarMonth = monthStartOf(currentDate || toISODate(new Date()));
  renderCalendar();
  els.calendar.hidden = false;
  els.dateLabel.setAttribute("aria-expanded", "true");

  // Focus the selected day so arrow keys work immediately.
  const target =
    els.calGrid.querySelector(".cal-day.selected") ||
    els.calGrid.querySelector(".cal-day.today") ||
    els.calGrid.querySelector(".cal-day");
  if (target) target.focus();
}

function closeCalendar({ restoreFocus = false } = {}) {
  if (!isCalendarOpen()) return;
  els.calendar.hidden = true;
  els.dateLabel.setAttribute("aria-expanded", "false");
  if (restoreFocus) els.dateLabel.focus();
}

function toggleCalendar() {
  if (isCalendarOpen()) closeCalendar({ restoreFocus: true });
  else openCalendar();
}

/** Move the calendar view by `months` without changing the selected date. */
function stepCalendarMonth(months) {
  calendarMonth = shiftMonth(calendarMonth, months);
  renderCalendar();
}

/** Move focus to the day `days` away from the currently focused cell. */
function moveCalendarFocus(days) {
  const cells = [...els.calGrid.querySelectorAll(".cal-day")];
  const index = cells.indexOf(document.activeElement);
  if (index < 0) return;

  const next = cells[index + days];
  if (next) {
    next.focus();
    return;
  }

  // Ran off the grid: flip the month and land on the matching edge.
  stepCalendarMonth(days > 0 ? 1 : -1);
  const fresh = [...els.calGrid.querySelectorAll(".cal-day")];
  const edge = days > 0 ? fresh[0] : fresh[fresh.length - 1];
  if (edge) edge.focus();
}

/** Pick a date from the calendar and close it. */
function pickCalendarDate(iso) {
  closeCalendar({ restoreFocus: true });
  selectDate(iso);
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

/** Result of the last scan, or `null` when the dialog is closed. */
let importScan = null;
/** Whether the last import finished, so the footer switches to "close". */
let importDone = false;

/** Badge label for each import status, resolved at render time. */
const IMPORT_BADGE_KEYS = {
  ready: "import.statReady",
  conflict: "import.statConflict",
  failed: "import.statFailed",
};

/** Build one row of the import preview list. */
function createImportRow(file) {
  const row = document.createElement("div");
  row.className = `import-row ${file.status}`;
  row.setAttribute("role", "listitem");

  const date = document.createElement("span");
  date.className = "row-date";
  date.textContent = file.date || file.name;

  const title = document.createElement("span");
  title.className = "row-title" + (file.title ? "" : " empty");
  title.textContent = file.title || t("common.untitled");
  title.title = file.title || "";

  const badge = document.createElement("span");
  badge.className = "row-badge";
  const badgeKey = IMPORT_BADGE_KEYS[file.status];
  badge.textContent = badgeKey ? t(badgeKey) : file.status;

  row.append(date, title, badge);

  // Conflicts and failures explain themselves on a second line.
  if (file.reason) {
    const reason = document.createElement("span");
    reason.className = "row-reason";
    reason.textContent = file.reason;
    row.append(reason);
  }

  return row;
}

/** Render the scan result into the dialog. */
function renderImportScan(scan) {
  importScan = scan;
  importDone = false;

  els.importDir.textContent = scan.dir;
  els.importReady.textContent = String(scan.ready);
  els.importConflicts.textContent = String(scan.conflicts);
  els.importFailed.textContent = String(scan.failed);

  // The overwrite switch only makes sense when something would collide.
  els.importOverwriteRow.hidden = scan.conflicts === 0;
  els.importOverwrite.checked = false;

  els.importResult.hidden = true;
  els.importResult.replaceChildren();
  els.importError.textContent = "";
  hideImportProgress();

  if (scan.files.length === 0) {
    const empty = document.createElement("div");
    empty.className = "import-row failed";
    empty.textContent = t("import.emptyFolder");
    els.importList.replaceChildren(empty);
  } else {
    const frag = document.createDocumentFragment();
    for (const file of scan.files) frag.appendChild(createImportRow(file));
    els.importList.replaceChildren(frag);
  }

  els.importConfirm.textContent = t("sidebar.import");
  els.importConfirm.disabled = scan.ready === 0 && scan.conflicts === 0;
  els.importCancel.textContent = t("common.cancel");
}

/** Show the dialog in a loading state while the folder is scanned. */
function showImportLoading(dir) {
  importScan = null;
  importDone = false;
  els.importDir.textContent = dir;
  els.importReady.textContent = "0";
  els.importConflicts.textContent = "0";
  els.importFailed.textContent = "0";
  els.importOverwriteRow.hidden = true;
  els.importResult.hidden = true;
  els.importError.textContent = "";
  hideImportProgress();
  els.importConfirm.disabled = true;
  els.importConfirm.textContent = t("sidebar.import");
  els.importCancel.textContent = t("common.cancel");

  const loading = document.createElement("div");
  loading.className = "import-row";
  loading.textContent = t("import.scanning");
  els.importList.replaceChildren(loading);

  els.importOverlay.hidden = false;
}

/**
 * Show the progress bar at `done / total`.
 *
 * The bar is driven by the backend's `import-progress` event, which fires once
 * per finished file. `total` is clamped to at least 1 so an empty batch cannot
 * produce a division by zero.
 */
function setImportProgress(done, total) {
  const safeTotal = Math.max(total, 1);
  const percent = Math.min(100, Math.round((done / safeTotal) * 100));

  els.importProgress.hidden = false;
  els.importProgressBar.style.width = `${percent}%`;
  els.importProgressCount.textContent = `${done} / ${total}`;
  els.importProgressTrack.setAttribute("aria-valuenow", String(percent));
}

/** Hide the progress bar (before a scan, or once the report is shown). */
function hideImportProgress() {
  els.importProgress.hidden = true;
  els.importProgressBar.style.width = "0%";
  els.importProgressCount.textContent = "0 / 0";
  els.importProgressTrack.setAttribute("aria-valuenow", "0");
}

function isImportOpen() {
  return !els.importOverlay.hidden;
}

function closeImport() {
  els.importOverlay.hidden = true;
  importScan = null;
  importDone = false;
}

/** Pick a folder, scan it, and show the preview. */
async function startImport() {
  let dir;
  try {
    dir = await invoke("pick_import_dir");
  } catch (err) {
    console.error("pick_import_dir failed:", err);
    setStatus(t("import.errPicker"));
    return;
  }
  if (!dir) return;

  showImportLoading(dir);
  try {
    const scan = await invoke("scan_import", { importDir: dir });
    renderImportScan(scan);
  } catch (err) {
    console.error("scan_import failed:", err);
    els.importList.replaceChildren();
    els.importError.textContent =
      typeof err === "string" ? err : t("import.errScan");
  }
}

/** Write the confirmed dates and show the outcome in the same dialog. */
async function confirmImport() {
  if (!importScan) return;

  const overwrite = els.importOverwrite.checked;
  // Conflicts are only included when the user opted into overwriting.
  const dates = importScan.files
    .filter(
      (f) => f.status === "ready" || (overwrite && f.status === "conflict")
    )
    .map((f) => f.date)
    .filter(Boolean);

  if (dates.length === 0) {
    els.importError.textContent = t("import.errNothing");
    return;
  }

  els.importConfirm.disabled = true;
  els.importConfirm.textContent = t("import.progress");
  els.importError.textContent = "";
  setImportProgress(0, dates.length);

  // The backend imports on a thread pool and reports each finished file.
  const onProgress = (event) => {
    const { done, total } = event.payload || {};
    if (typeof done !== "number" || typeof total !== "number") return;
    setImportProgress(done, total);
  };
  let unlisten = null;
  try {
    unlisten = await listen("import-progress", onProgress);
  } catch (err) {
    // Progress is cosmetic; the import still works without it.
    console.warn("import-progress listener failed:", err);
  }

  try {
    const report = await invoke("run_import", {
      importDir: importScan.dir,
      dates,
      overwrite,
    });
    renderImportReport(report);
    await refreshList();
  } catch (err) {
    console.error("run_import failed:", err);
    els.importError.textContent =
      typeof err === "string" ? err : t("import.errImport");
    els.importConfirm.disabled = false;
    els.importConfirm.textContent = t("sidebar.import");
    hideImportProgress();
  } finally {
    if (typeof unlisten === "function") unlisten();
  }
}

/** Replace the preview with the import outcome. */
function renderImportReport(report) {
  importDone = true;

  const lines = [];
  if (report.imported.length > 0) {
    lines.push(t("import.reportImported", { count: report.imported.length }));
  }
  if (report.skipped.length > 0) {
    lines.push(t("import.reportSkipped", { count: report.skipped.length }));
  }
  if (report.failed.length > 0) {
    lines.push(t("import.reportFailed", { count: report.failed.length }));
  }
  if (lines.length === 0) {
    lines.push(t("import.reportNoChange"));
  }

  const frag = document.createDocumentFragment();
  for (const line of lines) {
    const p = document.createElement("div");
    p.className = "result-line";
    p.textContent = line;
    frag.appendChild(p);
  }
  for (const failure of report.failed) {
    const p = document.createElement("div");
    p.className = "result-fail";
    p.textContent = `${failure.name}：${failure.reason}`;
    frag.appendChild(p);
  }

  els.importResult.replaceChildren(frag);
  els.importResult.hidden = false;
  els.importList.replaceChildren();
  hideImportProgress();

  els.importConfirm.disabled = false;
  els.importConfirm.textContent = t("common.done");
  els.importCancel.textContent = t("common.close");
  els.importOverwriteRow.hidden = true;

  setStatus(
    t("import.statusImported", { count: report.imported.length }),
    true
  );
}

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
  renderLockScreen();
  renderWeekdayHeaders();
  renderDateLabel();
  renderFavouriteButton();
  applyTheme();
  updateWordCount();
  if (isCalendarOpen()) renderCalendar();
  if (visibleEntries.length > 0 || searchQuery.trim()) renderList();

  // The statistics dialog builds its labels in JS, so it has to be redrawn
  // when the language changes while it is open.
  if (isStatsOpen()) renderStats();

  // The import dialog is rebuilt from the last scan so its badges and buttons
  // follow the new language. A finished report is left alone: it is a record of
  // what happened, and re-rendering it would need the report object again.
  if (importScan && !importDone) renderImportScan(importScan);
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
  if (isCalendarOpen()) renderCalendar();

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
  if (!vaultInitialized) {
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
// Lock / unlock
// ---------------------------------------------------------------------------

function showLockScreen(message = "") {
  els.app.hidden = true;
  els.lockScreen.hidden = false;
  els.lockError.textContent = message;
  els.passphrase.value = "";
  els.passphraseConfirm.value = "";
  els.passphrase.focus();
}

// ---------------------------------------------------------------------------
// Argon2id parameters (advanced options, first run only)
// ---------------------------------------------------------------------------

/** Bounds and defaults reported by the backend. */
let kdfDefaults = null;

/** Populate the advanced panel from the backend's defaults. */
async function loadKdfDefaults() {
  try {
    kdfDefaults = await invoke("get_kdf_defaults");
  } catch (err) {
    console.error("get_kdf_defaults failed:", err);
    return;
  }
  els.kdfMemory.min = kdfDefaults.minMemoryKib / 1024;
  els.kdfMemory.max = kdfDefaults.maxMemoryKib / 1024;
  els.kdfIterations.min = kdfDefaults.minIterations;
  els.kdfIterations.max = kdfDefaults.maxIterations;
  els.kdfParallelism.min = kdfDefaults.minParallelism;
  els.kdfParallelism.max = kdfDefaults.maxParallelism;
  resetKdfFields();
}

/** Restore the recommended (OWASP) parameters. */
function resetKdfFields() {
  if (!kdfDefaults) return;
  els.kdfMemory.value = kdfDefaults.memoryKib / 1024;
  els.kdfIterations.value = kdfDefaults.iterations;
  els.kdfParallelism.value = kdfDefaults.parallelism;
  updateKdfEstimate();
}

/** Read the panel as `{ memoryKib, iterations, parallelism }`. */
function readKdfParams() {
  return {
    memoryKib: Math.round(Number(els.kdfMemory.value) * 1024),
    iterations: Math.round(Number(els.kdfIterations.value)),
    parallelism: Math.round(Number(els.kdfParallelism.value)),
  };
}

/**
 * Rough unlock-time estimate.
 *
 * Argon2id cost is dominated by `memory * iterations`; the constant is a
 * deliberately conservative guess so the label errs on the slow side.
 */
function updateKdfEstimate() {
  const { memoryKib, iterations } = readKdfParams();
  if (!Number.isFinite(memoryKib) || !Number.isFinite(iterations)) {
    els.kdfEstimate.textContent = "";
    return;
  }
  const seconds = (memoryKib / 1024) * iterations * 0.02;
  els.kdfEstimate.textContent = t("lock.kdfEstimate", {
    seconds: seconds.toFixed(2),
  });
}

/** Apply the lock screen layout for the current setup state. */
function renderLockScreen() {
  // The path field is only shown while the app has no settings file yet.
  els.pathField.hidden = configured;
  // KDF parameters can only be chosen when a new vault is being created.
  els.advancedField.hidden = vaultInitialized;

  if (vaultInitialized) {
    // A vault exists at the selected location: ask for the passphrase only.
    els.lockSubtitle.textContent = configured
      ? t("lock.subtitle.unlock")
      : t("lock.subtitle.existing");
    els.passphraseConfirm.hidden = true;
    els.passphrase.placeholder = t("lock.passphrase");
    els.passphrase.autocomplete = "current-password";
    els.lockSubmit.textContent = t("lock.submitUnlock");
  } else if (configured) {
    // Configured folder but no vault yet (e.g. an empty folder was picked).
    els.lockSubtitle.textContent = t("lock.subtitle.newInFolder");
    els.passphraseConfirm.hidden = false;
    els.passphrase.placeholder = t("lock.passphraseSet");
    els.passphrase.autocomplete = "new-password";
    els.lockSubmit.textContent = t("lock.submitCreate");
  } else {
    // First run: pick a folder, then choose a passphrase.
    els.lockSubtitle.textContent = t("lock.subtitle.firstRun");
    els.passphraseConfirm.hidden = false;
    els.passphrase.placeholder = t("lock.passphraseSet");
    els.passphrase.autocomplete = "new-password";
    els.lockSubmit.textContent = t("lock.submitCreate");
  }
}

async function enterApp() {
  els.lockScreen.hidden = true;
  els.app.hidden = false;

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

/** Re-read the settings file and refresh the lock screen state. */
async function loadSettings() {
  const settings = await invoke("get_settings");
  configured = settings.configured;
  els.diaryDir.value = settings.diaryDir ?? settings.defaultDir ?? "";
  // Keep the idle timer in sync with whatever is on disk.
  setAutoLockMinutes(settings.autoLockMinutes ?? 0);
  return settings;
}

/**
 * Check whether a directory already holds a vault.
 *
 * With no argument the configured directory is inspected; with a path the
 * given directory is inspected instead (used by the setup screen).
 */
async function detectVault(path) {
  try {
    return await invoke("vault_exists", path ? { path } : {});
  } catch (err) {
    console.error("vault_exists failed:", err);
    return false;
  }
}

/** Re-check whether the diary directory already holds a vault. */
async function refreshVaultState() {
  vaultInitialized = await detectVault();
}

/**
 * Re-detect the vault in the path currently typed on the setup screen.
 *
 * This is what makes an existing diary folder open in unlock mode instead of
 * failing with "Vault already exists".
 */
async function refreshSetupVaultState() {
  const dir = els.diaryDir.value.trim();
  if (!dir) {
    vaultInitialized = false;
    renderLockScreen();
    return;
  }
  vaultInitialized = await detectVault(dir);
  renderLockScreen();
}

async function handleUnlockSubmit(event) {
  event.preventDefault();
  els.lockError.textContent = "";

  const passphrase = els.passphrase.value;
  if (!passphrase) {
    els.lockError.textContent = t("lock.errNoPassphrase");
    return;
  }

  const creating = !vaultInitialized;
  if (creating) {
    const confirmValue = els.passphraseConfirm.value;
    if (passphrase.length < 6) {
      els.lockError.textContent = t("lock.errTooShort");
      return;
    }
    if (passphrase !== confirmValue) {
      els.lockError.textContent = t("lock.errMismatch");
      return;
    }
  }

  els.lockSubmit.disabled = true;
  try {
    if (!configured) {
      const dir = els.diaryDir.value.trim();
      if (!dir) {
        els.lockError.textContent = t("lock.errNoDir");
        return;
      }
      // Re-check right before committing: the folder may already hold a vault.
      vaultInitialized = await detectVault(dir);
      await invoke("set_diary_dir", { path: dir });
      configured = true;
    }

    if (vaultInitialized) {
      await invoke("unlock", { passphrase });
    } else {
      const kdf = readKdfParams();
      if (
        !Number.isFinite(kdf.memoryKib) ||
        !Number.isFinite(kdf.iterations) ||
        !Number.isFinite(kdf.parallelism)
      ) {
        els.lockError.textContent = t("lock.errKdfNaN");
        return;
      }
      await invoke("create_vault", { passphrase, kdf });
      vaultInitialized = true;
    }
    await enterApp();
  } catch (err) {
    console.error("unlock failed:", err);
    els.lockError.textContent =
      typeof err === "string" ? err : t("lock.errUnlockFailed");
    els.passphrase.select();
  } finally {
    els.lockSubmit.disabled = false;
  }
}

/** Open the native folder picker and store the result in the path field. */
async function browseForDir() {
  els.lockError.textContent = "";
  try {
    const picked = await invoke("pick_diary_dir");
    if (picked) {
      els.diaryDir.value = picked;
      await refreshSetupVaultState();
    }
  } catch (err) {
    console.error("pick_diary_dir failed:", err);
    els.lockError.textContent = t("lock.errPicker");
  }
}

/** Change the diary location from the sidebar (must be locked first). */
async function changeDiaryDir() {
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

  currentDate = "";
  savedTitle = "";
  savedContent = "";
  allEntries = [];
  resetList();
  closeCalendar();
  closeImport();
  closeSettings();
  renderDateLabel();
  els.title.value = "";
  els.content.value = "";

  // Show the lock screen with the path field so the user can pick a new folder.
  // `configured` is cleared so the path field is visible, but the vault state
  // is *not* forced to false: the folder the user lands on may already hold a
  // diary, in which case the form must ask for the passphrase rather than
  // offering to create a new vault.
  configured = false;
  showLockScreen();
  els.diaryDir.focus();
  els.diaryDir.select();
  await refreshSetupVaultState();
}

async function lockNow() {
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
  currentDate = "";
  savedTitle = "";
  savedContent = "";
  allEntries = [];
  resetList();
  closeCalendar();
  closeImport();
  renderDateLabel();
  els.title.value = "";
  els.content.value = "";

  // Locking must return to the *unlock* form, not the first-run setup form.
  // `configured` stays true (the settings file is still there) and the vault
  // still exists, so re-render instead of leaving the previous layout on
  // screen. Re-detect the vault so a folder that was swapped out from under
  // us is handled correctly.
  stopAutoLockTimer();
  closeSettings();
  await refreshVaultState();
  showLockScreen();
  renderLockScreen();
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
// Settings dialog
// ---------------------------------------------------------------------------

/** Whether the settings dialog is open. */
function isSettingsOpen() {
  return !els.settingsOverlay.hidden;
}

/** Fill the auto-lock dropdown from the choices the backend allows. */
function renderAutoLockChoices(choices, current) {
  els.autoLockSelect.replaceChildren();
  for (const minutes of choices) {
    const option = document.createElement("option");
    option.value = String(minutes);
    option.textContent =
      minutes === 0
        ? t("settings.autoLockNever")
        : t("settings.autoLockMinutes", { n: minutes });
    if (minutes === current) option.selected = true;
    els.autoLockSelect.append(option);
  }
}

/** Show the Argon2id parameters currently recorded in the vault. */
function renderVaultKdf(params) {
  if (!params) {
    els.vaultKdf.textContent = t("settings.vaultKdfLegacy");
    return;
  }
  els.vaultKdf.textContent = t("settings.vaultKdf", {
    memory: Math.round(params.memoryKib / 1024),
    iterations: params.iterations,
    parallelism: params.parallelism,
  });
}

/** Copy the vault's current parameters into the advanced inputs. */
function fillSettingsKdf(params) {
  if (!params) return;
  els.settingsKdfMemory.value = Math.round(params.memoryKib / 1024);
  els.settingsKdfIterations.value = params.iterations;
  els.settingsKdfParallelism.value = params.parallelism;
}

/** Read the advanced inputs as a KdfView payload. */
function readSettingsKdf() {
  return {
    memoryKib: Number(els.settingsKdfMemory.value) * 1024,
    iterations: Number(els.settingsKdfIterations.value),
    parallelism: Number(els.settingsKdfParallelism.value),
  };
}

/** Open the settings dialog and populate it from the backend. */
async function openSettings() {
  els.settingsError.textContent = "";
  els.settingsCalibrateNote.textContent = "";
  els.settingsCurrentPass.value = "";
  els.settingsNewPass.value = "";
  els.settingsNewPassConfirm.value = "";

  try {
    const settings = await invoke("get_settings");
    renderAutoLockChoices(
      settings.autoLockChoices ?? [0, 1, 5, 10, 15, 30, 60],
      settings.autoLockMinutes ?? 0
    );
    const params = await invoke("get_vault_kdf");
    renderVaultKdf(params);
    fillSettingsKdf(params);
  } catch (err) {
    console.error("settings load failed:", err);
    els.settingsError.textContent = t("settings.errSave", {
      message: typeof err === "string" ? err : String(err),
    });
  }

  els.settingsOverlay.hidden = false;
  els.settingsCurrentPass.focus();
}

/** Close the settings dialog without saving. */
function closeSettings() {
  els.settingsOverlay.hidden = true;
  els.settingsError.textContent = "";
  // Never leave a passphrase sitting in a hidden input.
  els.settingsCurrentPass.value = "";
  els.settingsNewPass.value = "";
  els.settingsNewPassConfirm.value = "";
}

// ---------------------------------------------------------------------------
// Statistics dialog
// ---------------------------------------------------------------------------
//
// Everything here is derived from `allEntries`, the metadata the sidebar
// already holds: date, title, size and the favourite flag. No extra backend
// call is needed, and nothing is cached, so locking the diary (which clears
// `allEntries`) cannot leave stale numbers on screen.

/** Whether the statistics dialog is open. */
function isStatsOpen() {
  return !els.statsOverlay.hidden;
}

/**
 * Render one bar chart.
 *
 * `items` is `[{ label, count, title }]`. Heights are relative to the tallest
 * bucket so a quiet month still shows a readable shape; an all-zero chart
 * falls back to a flat row of stubs. The maths lives in `lib/stats.js`; this
 * function only touches the DOM.
 */
function renderBarChart(container, items, extraClass) {
  container.replaceChildren();
  container.className = "stats-chart" + (extraClass ? ` ${extraClass}` : "");

  const fractions = barFractions(items.map((item) => item.count));
  items.forEach((item, index) => {
    const bar = document.createElement("div");
    bar.className = "stats-bar";
    bar.title = item.title;

    const fill = document.createElement("div");
    fill.className = "stats-bar-fill" + (item.count === 0 ? " empty" : "");
    fill.style.setProperty("--v", fractions[index]);

    const label = document.createElement("span");
    label.className = "stats-bar-label";
    label.textContent = item.label;

    bar.append(fill, label);
    container.append(bar);
  });
}

/** Fill the dialog from `allEntries`. */
function renderStats() {
  const total = allEntries.length;
  els.statsTotal.textContent = String(total);
  els.statsFavourites.textContent = String(
    allEntries.filter((e) => e.favourite).length
  );

  const { current, longest } = computeStreaks(allEntries);
  els.statsStreak.textContent = t("stats.days", { n: current });
  els.statsLongest.textContent = t("stats.days", { n: longest });

  if (total === 0) {
    els.statsRange.textContent = "";
    els.statsMonths.replaceChildren();
    els.statsWeekdays.replaceChildren();

    const empty = document.createElement("p");
    empty.className = "stats-empty";
    empty.textContent = t("stats.empty");
    els.statsMonths.append(empty);
    return;
  }

  // `allEntries` is newest first, so the last element is the oldest entry.
  els.statsRange.textContent = t("stats.range", {
    first: longDateOf(allEntries[total - 1].date),
    last: longDateOf(allEntries[0].date),
  });

  renderBarChart(
    els.statsMonths,
    monthlyBuckets(allEntries, 12).map((bucket) => ({
      label: t("stats.monthLabel", { month: bucket.month }),
      count: bucket.count,
      title: t("stats.count", { n: bucket.count }),
    }))
  );

  renderBarChart(
    els.statsWeekdays,
    weekdayBuckets(allEntries).map((count, day) => ({
      label: weekdayName(day),
      count,
      title: t("stats.count", { n: count }),
    })),
    "weekdays"
  );
}

/** Open the statistics dialog. */
function openStats() {
  renderStats();
  els.statsOverlay.hidden = false;
  els.statsDone.focus();
}

/** Close the statistics dialog. */
function closeStats() {
  els.statsOverlay.hidden = true;
}

/** Measure this machine and fill the advanced inputs with the result. */
async function calibrateKdf() {
  els.settingsError.textContent = "";
  els.settingsCalibrate.disabled = true;
  els.settingsCalibrateNote.textContent = t("settings.calibrating");
  try {
    const params = await invoke("calibrate_kdf");
    fillSettingsKdf(params);
    els.settingsCalibrateNote.textContent = t("settings.calibrated", {
      memory: Math.round(params.memoryKib / 1024),
      iterations: params.iterations,
      parallelism: params.parallelism,
    });
  } catch (err) {
    console.error("calibrate_kdf failed:", err);
    els.settingsCalibrateNote.textContent = "";
    els.settingsError.textContent = t("settings.errCalibrate", {
      message: typeof err === "string" ? err : String(err),
    });
  } finally {
    els.settingsCalibrate.disabled = false;
  }
}

/**
 * Save the dialog.
 *
 * The auto-lock preference and the passphrase/KDF change are independent: the
 * former is always written, the latter only when the user typed a current
 * passphrase. That way the dialog can be used for either purpose alone.
 */
async function saveSettings() {
  els.settingsError.textContent = "";

  const current = els.settingsCurrentPass.value;
  const next = els.settingsNewPass.value;
  const confirm = els.settingsNewPassConfirm.value;
  const wantsPassChange = current !== "" || next !== "" || confirm !== "";

  if (wantsPassChange) {
    if (!current) {
      els.settingsError.textContent = t("settings.errCurrentRequired");
      return;
    }
    if (next !== confirm) {
      els.settingsError.textContent = t("settings.errMismatch");
      return;
    }
  }

  els.settingsSave.disabled = true;
  try {
    const minutes = Number(els.autoLockSelect.value);
    await invoke("set_auto_lock", { minutes });
    setAutoLockMinutes(minutes);

    if (wantsPassChange) {
      const kdf = readSettingsKdf();
      if (
        !Number.isFinite(kdf.memoryKib) ||
        !Number.isFinite(kdf.iterations) ||
        !Number.isFinite(kdf.parallelism)
      ) {
        els.settingsError.textContent = t("lock.errKdfNaN");
        return;
      }
      await invoke("change_passphrase", {
        currentPassphrase: current,
        newPassphrase: next,
        kdf,
      });
      // The vault now records the parameters we just sent.
      renderVaultKdf(kdf);
    }

    closeSettings();
    setStatus(t("settings.saved"), true);
  } catch (err) {
    console.error("save settings failed:", err);
    els.settingsError.textContent = t("settings.errSave", {
      message: typeof err === "string" ? err : String(err),
    });
  } finally {
    els.settingsSave.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Event wiring
// ---------------------------------------------------------------------------

els.lockForm.addEventListener("submit", handleUnlockSubmit);
els.browseDir.addEventListener("click", browseForDir);
els.kdfReset.addEventListener("click", resetKdfFields);
els.kdfMemory.addEventListener("input", updateKdfEstimate);
els.kdfIterations.addEventListener("input", updateKdfEstimate);
els.kdfParallelism.addEventListener("input", updateKdfEstimate);

// Detect an existing vault as soon as the user edits the path, so a returning
// user is switched to the unlock form instead of being asked to create one.
let pathDetectTimer = null;
els.diaryDir.addEventListener("input", () => {
  if (pathDetectTimer) clearTimeout(pathDetectTimer);
  pathDetectTimer = setTimeout(() => {
    pathDetectTimer = null;
    refreshSetupVaultState();
  }, 350);
});

els.title.addEventListener("input", () => {
  if (suppressInput) return;
  scheduleSave();
});

els.content.addEventListener("input", () => {
  if (suppressInput) return;
  updateWordCount();
  scheduleSave();
});

// The native input is hidden and only mirrors the selected date, so it never
// fires `change` from user interaction. The calendar below is the real UI.
els.dateLabel.addEventListener("click", toggleCalendar);

els.calPrev.addEventListener("click", () => stepCalendarMonth(-1));
els.calNext.addEventListener("click", () => stepCalendarMonth(1));

// Clicking the month title jumps back to the month of the selected date.
els.calTitle.addEventListener("click", () => {
  calendarMonth = monthStartOf(currentDate || toISODate(new Date()));
  renderCalendar();
});

els.calToday.addEventListener("click", async () => {
  const today = await invoke("today");
  pickCalendarDate(today);
});

els.calGrid.addEventListener("click", (e) => {
  const cell = e.target.closest(".cal-day");
  if (cell) pickCalendarDate(cell.dataset.date);
});

// Arrow keys move the focus ring, PageUp/PageDown flip the month.
els.calGrid.addEventListener("keydown", (e) => {
  const moves = {
    ArrowLeft: -1,
    ArrowRight: 1,
    ArrowUp: -7,
    ArrowDown: 7,
  };
  if (e.key in moves) {
    e.preventDefault();
    moveCalendarFocus(moves[e.key]);
  } else if (e.key === "PageUp") {
    e.preventDefault();
    stepCalendarMonth(-1);
  } else if (e.key === "PageDown") {
    e.preventDefault();
    stepCalendarMonth(1);
  }
});

// Clicking anywhere outside the popup dismisses it.
document.addEventListener("mousedown", (e) => {
  if (!isCalendarOpen()) return;
  if (els.calendar.contains(e.target) || els.dateLabel.contains(e.target))
    return;
  closeCalendar();
});

els.prevDay.addEventListener("click", () =>
  selectDate(shiftDate(currentDate, -1))
);
els.nextDay.addEventListener("click", () =>
  selectDate(shiftDate(currentDate, 1))
);

els.newToday.addEventListener("click", async () => {
  const today = await invoke("today");
  await selectDate(today);
});

els.deleteBtn.addEventListener("click", deleteCurrent);
els.favouriteBtn.addEventListener("click", toggleFavourite);
els.lockBtn.addEventListener("click", lockNow);
els.changeDirBtn.addEventListener("click", changeDiaryDir);

// Settings dialog.
els.settingsBtn.addEventListener("click", openSettings);
els.settingsClose.addEventListener("click", closeSettings);
els.settingsCancel.addEventListener("click", closeSettings);
els.settingsSave.addEventListener("click", saveSettings);
els.settingsCalibrate.addEventListener("click", calibrateKdf);
els.settingsOverlay.addEventListener("mousedown", (e) => {
  if (e.target === els.settingsOverlay) closeSettings();
});

// Statistics dialog.
els.statsBtn.addEventListener("click", openStats);
els.statsClose.addEventListener("click", closeStats);
els.statsDone.addEventListener("click", closeStats);
els.statsOverlay.addEventListener("mousedown", (e) => {
  if (e.target === els.statsOverlay) closeStats();
});

// Sidebar view switch.
els.viewAll.addEventListener("click", () => setView("all"));
els.viewFavourites.addEventListener("click", () => setView("favourites"));

// Import dialog.
els.importBtn.addEventListener("click", startImport);
els.importClose.addEventListener("click", closeImport);
els.importCancel.addEventListener("click", closeImport);
els.importConfirm.addEventListener("click", () => {
  // After a run the primary button just dismisses the result.
  if (importDone) closeImport();
  else confirmImport();
});

// Clicking the backdrop (but not the dialog itself) dismisses it.
els.importOverlay.addEventListener("mousedown", (e) => {
  if (e.target === els.importOverlay) closeImport();
});

els.search.addEventListener("input", () => {
  searchQuery = els.search.value;
  // A new filter changes the row count, so reset the scroll position.
  els.listScroll.scrollTop = 0;
  renderList();
});

// Virtual scrolling: redraw the window as the user scrolls. `passive` keeps
// the scroll smooth because the handler never calls `preventDefault()`.
els.listScroll.addEventListener("scroll", () => renderVisibleRows(), {
  passive: true,
});

// The viewport height changes with the window, so the rendered window must be
// recomputed.
window.addEventListener("resize", () => renderVisibleRows(true));

// Keyboard shortcuts.
document.addEventListener("keydown", (e) => {
  const mod = e.ctrlKey || e.metaKey;

  if (e.key === "Escape" && isStatsOpen()) {
    e.preventDefault();
    closeStats();
    return;
  }

  if (e.key === "Escape" && isImportOpen()) {
    e.preventDefault();
    closeImport();
    return;
  }

  if (e.key === "Escape" && isCalendarOpen()) {
    e.preventDefault();
    closeCalendar({ restoreFocus: true });
    return;
  }

  if (mod && e.key.toLowerCase() === "l") {
    e.preventDefault();
    if (!els.app.hidden) lockNow();
  } else if (els.app.hidden) {
    return;
  } else if (mod && e.key.toLowerCase() === "s") {
    e.preventDefault();
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    saveNow();
  } else if (mod && e.key.toLowerCase() === "t") {
    e.preventDefault();
    els.newToday.click();
  } else if (mod && e.key.toLowerCase() === "d") {
    e.preventDefault();
    toggleFavourite();
  } else if (e.altKey && e.key === "ArrowLeft") {
    e.preventDefault();
    selectDate(shiftDate(currentDate, -1));
  } else if (e.altKey && e.key === "ArrowRight") {
    e.preventDefault();
    selectDate(shiftDate(currentDate, 1));
  }
});

// Save before the window closes so nothing is lost.
window.addEventListener("beforeunload", () => {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
    // Fire-and-forget; the webview may not wait, but autosave usually beats it.
    saveNow();
  }
});

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

async function init() {
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

  await loadKdfDefaults();
  try {
    await loadSettings();
    if (configured) {
      await refreshVaultState();
    } else {
      // First run: check the pre-filled default folder for an existing vault.
      await refreshSetupVaultState();
    }
  } catch (err) {
    console.error("settings load failed:", err);
    configured = false;
    vaultInitialized = false;
    els.lockError.textContent = t("lock.errSettings");
  }

  showLockScreen();
  renderLockScreen();
}

init();
