// Tauri injects `window.__TAURI__` into the webview. We use it instead of
// `import { invoke } from "@tauri-apps/api/core"` because the frontend is
// served as plain static files (no bundler), so bare module specifiers cannot
// be resolved by the browser.
const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

// Relative specifiers *do* work without a bundler, so the i18n layer is a
// normal ES module next to this file.
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

/** Format a Date as `YYYY-MM-DD` in local time. */
function toISODate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Parse `YYYY-MM-DD` into a local Date at midnight. */
function fromISODate(s) {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}

/** Shift an ISO date string by `days`. */
function shiftDate(iso, days) {
  const d = fromISODate(iso);
  d.setDate(d.getDate() + days);
  return toISODate(d);
}

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

/** `2026-10-23` → `2026-10-01`. */
function monthStartOf(iso) {
  return `${iso.slice(0, 7)}-01`;
}

/** Shift a `YYYY-MM-01` string by `months`, clamped to the 1st. */
function shiftMonth(monthStart, months) {
  const [y, m] = monthStart.split("-").map(Number);
  const d = new Date(y, m - 1 + months, 1);
  return toISODate(d);
}

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
  const [year, month] = calendarMonth.split("-").map(Number);
  els.calTitle.textContent = formatMonth(calendarMonth);

  // Monday-first grid: JS `getDay()` is Sunday-based, so shift by 6.
  const first = new Date(year, month - 1, 1);
  const lead = (first.getDay() + 6) % 7;
  const start = new Date(year, month - 1, 1 - lead);

  const today = toISODate(new Date());
  const withEntries = entryDateSet();

  const frag = document.createDocumentFragment();
  for (let i = 0; i < 42; i += 1) {
    const d = new Date(
      start.getFullYear(),
      start.getMonth(),
      start.getDate() + i
    );
    const iso = toISODate(d);

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

  setStatus(t("import.statusImported", { count: report.imported.length }), true);
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
  const rem = parseFloat(
    getComputedStyle(document.documentElement).fontSize
  ) || 16;
  const value = raw.endsWith("rem")
    ? parseFloat(raw) * rem
    : parseFloat(raw);

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
  updateWordCount();
  if (isCalendarOpen()) renderCalendar();
  if (visibleEntries.length > 0 || searchQuery.trim()) renderList();

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

/** Entries currently passing the search filter, newest first. */
let visibleEntries = [];
/** Index of the first rendered row, used to skip redundant re-renders. */
let renderedStart = -1;
/** Index one past the last rendered row. */
let renderedEnd = -1;

/** Recompute `visibleEntries` from `allEntries` and the search query. */
function applyFilter() {
  const q = searchQuery.trim().toLowerCase();
  visibleEntries = q
    ? allEntries.filter(
        (e) => e.date.includes(q) || (e.title || "").toLowerCase().includes(q)
      )
    : allEntries;
}

/** Build the DOM node for one entry row. */
function createRow(entry, index) {
  const li = document.createElement("li");
  li.className = "entry-item" + (entry.date === currentDate ? " active" : "");
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
    li.textContent = searchQuery.trim()
      ? t("sidebar.emptyFiltered")
      : t("sidebar.empty");
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
    setStatus(entry ? t("status.loaded") : t("status.newEntry"));
  } catch (err) {
    console.error("get_entry failed:", err);
    setStatus(t("status.loadFailed"));
  }

  els.deleteBtn.disabled = !allEntries.some((e) => e.date === date);
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

  await refreshList();

  const today = await invoke("today");
  await selectDate(today);
}

/** Re-read the settings file and refresh the lock screen state. */
async function loadSettings() {
  const settings = await invoke("get_settings");
  configured = settings.configured;
  els.diaryDir.value = settings.diaryDir ?? settings.defaultDir ?? "";
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
  renderDateLabel();
  els.title.value = "";
  els.content.value = "";

  // Show the lock screen with the path field so the user can pick a new folder.
  configured = false;
  vaultInitialized = false;
  showLockScreen();
  renderLockScreen();
  els.diaryDir.focus();
  els.diaryDir.select();
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
  await refreshVaultState();
  showLockScreen();
  renderLockScreen();
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
els.lockBtn.addEventListener("click", lockNow);
els.changeDirBtn.addEventListener("click", changeDiaryDir);

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
