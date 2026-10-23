// ---------------------------------------------------------------------------
// Internationalisation
// ---------------------------------------------------------------------------
//
// The frontend is served as plain static files (no bundler), so this is a
// hand-rolled module rather than an npm package. It is deliberately small:
//
//   * two flat dictionaries, `zh-Hant` and `en`, keyed by dotted strings;
//   * `t(key, params)` for code that builds strings at runtime;
//   * `applyTranslations(root)` for markup, driven by `data-i18n*` attributes;
//   * `formatDate` / `formatMonth` / `weekdayName` so dates follow the locale
//     instead of being glued together with Chinese characters.
//
// Adding a language means adding one dictionary object and one entry to
// `LOCALES`. Nothing else in the app needs to change.

/** BCP 47 tags we ship. The first entry is the fallback. */
export const LOCALES = ["zh-Hant", "en"];

/** Human-readable name of each locale, shown in the language switch. */
const LOCALE_NAMES = {
  "zh-Hant": "繁體中文",
  en: "English",
};

/** Short label for the toggle button (always shows the *other* language). */
const LOCALE_SHORT = {
  "zh-Hant": "EN",
  en: "中",
};

const STORAGE_KEY = "fly-diary:lang";

// ---------------------------------------------------------------------------
// Dictionaries
// ---------------------------------------------------------------------------

const zhHant = {
  // --- Generic -------------------------------------------------------------
  "app.name": "Fly Diary",
  "common.cancel": "取消",
  "common.close": "關閉",
  "common.done": "完成",
  "common.delete": "刪除",
  "common.today": "今天",
  "common.untitled": "（無標題）",

  // --- Lock screen ---------------------------------------------------------
  "lock.subtitle.unlock": "請輸入密碼以解鎖日記",
  "lock.subtitle.existing": "此資料夾已有加密日記，請輸入密碼解鎖",
  "lock.subtitle.newInFolder": "此資料夾尚未建立加密日記，請設定一組密碼",
  "lock.subtitle.firstRun":
    "第一次使用：選擇日記儲存位置，並設定一組密碼來加密日記",
  "lock.pathLabel": "日記儲存資料夾",
  "lock.pathPlaceholder": "/home/user/Documents/diary",
  "lock.browse": "瀏覽…",
  "lock.browseTitle": "選擇資料夾",
  "lock.pathHint": "此路徑會寫入設定檔，之後每次啟動都從這裡讀取日記。",
  "lock.passphrase": "密碼",
  "lock.passphraseSet": "設定密碼",
  "lock.passphraseConfirm": "再次輸入密碼",
  "lock.advanced": "進階選項（金鑰派生參數）",
  "lock.advancedHint":
    "密碼會經由 Argon2id 派生主金鑰，再由主金鑰包裝日記金鑰。提高參數會讓暴力破解更困難，但解鎖也會變慢。",
  "lock.kdfMemory": "記憶體 (MiB)",
  "lock.kdfIterations": "迭代次數",
  "lock.kdfParallelism": "平行度",
  "lock.kdfReset": "恢復預設值",
  "lock.kdfEstimate": "預估解鎖時間：約 {seconds} 秒",
  "lock.submitUnlock": "解鎖",
  "lock.submitCreate": "建立加密日記",
  "lock.errNoPassphrase": "請輸入密碼",
  "lock.errTooShort": "密碼至少需要 6 個字元",
  "lock.errMismatch": "兩次輸入的密碼不一致",
  "lock.errNoDir": "請選擇日記儲存資料夾",
  "lock.errKdfNaN": "進階參數必須是數字",
  "lock.errUnlockFailed": "解鎖失敗，請再試一次",
  "lock.errPicker": "無法開啟資料夾選擇器",
  "lock.errSettings": "無法讀取設定檔",

  // --- Sidebar -------------------------------------------------------------
  "sidebar.newToday": "今天",
  "sidebar.newTodayTitle": "前往今天 (Ctrl/Cmd+T)",
  "sidebar.search": "搜尋日期或標題…",
  "sidebar.pathTitle": "日記儲存位置",
  "sidebar.import": "匯入",
  "sidebar.importTitle": "從資料夾匯入日記",
  "sidebar.settings": "設定",
  "sidebar.settingsTitle": "開啟設定",
  "sidebar.stats": "統計",
  "sidebar.statsTitle": "查看統計",
  "sidebar.changeDir": "路徑",
  "sidebar.changeDirTitle": "變更日記儲存資料夾",
  "sidebar.lock": "鎖定",
  "sidebar.lockTitle": "鎖定日記 (Ctrl/Cmd+L)",

  "settings.title": "設定",
  "settings.autoLock": "閒置自動鎖定",
  "settings.autoLockHint": "閒置超過指定時間後自動鎖定日記，需要重新輸入密碼。",
  "settings.autoLockLabel": "鎖定時間",
  "settings.autoLockNever": "永不",
  "settings.autoLockMinutes": "{n} 分鐘",
  "settings.security": "密碼與金鑰派生",
  "settings.securityHint":
    "變更密碼只會重新包裝日記金鑰，不會重新加密日記內容，因此速度很快。",
  "settings.currentPass": "目前密碼",
  "settings.newPass": "新密碼",
  "settings.newPassPlaceholder": "留空表示不變更",
  "settings.newPassConfirm": "確認新密碼",
  "settings.advanced": "進階：Argon2id 參數",
  "settings.advancedHint":
    "提高參數會讓暴力破解更困難，但解鎖也會變慢。可自動量測本機速度。",
  "settings.calibrate": "自動量測（約 1 秒）",
  "settings.calibrating": "量測中…",
  "settings.calibrated":
    "已套用：{memory} MiB / {iterations} 次 / 平行度 {parallelism}",
  "settings.vaultKdf":
    "目前參數：{memory} MiB / {iterations} 次 / 平行度 {parallelism}",
  "settings.vaultKdfLegacy": "目前使用舊版金鑰派生，解鎖一次即可升級。",
  "settings.save": "儲存",
  "settings.saved": "設定已儲存",
  "settings.errCurrentRequired": "請輸入目前密碼",
  "settings.errMismatch": "兩次輸入的新密碼不一致",
  "settings.errNoChange": "沒有需要變更的項目",
  "settings.errCalibrate": "量測失敗：{message}",
  "settings.errSave": "儲存失敗：{message}",
  "sidebar.empty": "還沒有任何日記",
  "sidebar.emptyFiltered": "沒有符合的日記",
  "sidebar.viewAll": "全部",
  "sidebar.viewAllTitle": "顯示所有日記",
  "sidebar.viewFavourites": "收藏",
  "sidebar.viewFavouritesTitle": "只顯示收藏的日記",
  "sidebar.emptyFavourites": "還沒有收藏任何日記",
  "sidebar.emptyFavouritesFiltered": "沒有符合的收藏",

  // --- Mobile shell --------------------------------------------------------
  "mobile.openEntries": "開啟日記列表",
  "mobile.more": "更多",
  "mobile.navLabel": "主要導覽",
  "mobile.navEntries": "日記",
  "mobile.navFavourites": "收藏",
  "mobile.navStats": "統計",
  "mobile.navSettings": "設定",

  // --- Statistics ----------------------------------------------------------
  "stats.title": "統計",
  "stats.total": "總篇數",
  "stats.favourites": "收藏",
  "stats.streak": "目前連續",
  "stats.longest": "最長連續",
  "stats.days": "{n} 天",
  "stats.range": "首篇 {first} · 最新 {last}",
  "stats.empty": "還沒有任何日記，開始寫下第一篇吧。",
  "stats.months": "近 12 個月",
  "stats.weekdays": "星期分布",
  "stats.monthLabel": "{month} 月",
  "stats.count": "{n} 篇",

  // --- Editor --------------------------------------------------------------
  "editor.prevDay": "前一天",
  "editor.prevDayTitle": "前一天 (Alt+←)",
  "editor.nextDay": "後一天",
  "editor.nextDayTitle": "後一天 (Alt+→)",
  "editor.pickDate": "選擇日期",
  "editor.calPrev": "上個月",
  "editor.calNext": "下個月",
  "editor.calBackToToday": "回到今天",
  "editor.deleteTitle": "刪除這一天的日記",
  "editor.favourite": "收藏",
  "editor.favouriteOn": "已收藏",
  "editor.favouriteTitle": "加入收藏 (Ctrl/Cmd+D)",
  "editor.unfavouriteTitle": "取消收藏 (Ctrl/Cmd+D)",
  "editor.titlePlaceholder": "標題",
  "editor.contentPlaceholder": "今天過得如何？",
  "editor.hint": "Markdown 格式 · AES-256-GCM 加密 · 自動儲存",
  "editor.wordCount": "{chars} 字 · {lines} 行",

  // --- Font size -----------------------------------------------------------
  "font.group": "字體大小",
  "font.smaller": "縮小字體",
  "font.smallerTitle": "縮小字體 (Ctrl/Cmd+-)",
  "font.larger": "放大字體",
  "font.largerTitle": "放大字體 (Ctrl/Cmd++)",
  "font.reset": "重設字體大小",

  // --- Language switch -----------------------------------------------------
  "lang.switch": "切換語言",
  "lang.switchTitle": "切換語言（目前：繁體中文）",

  // --- Theme switch --------------------------------------------------------
  // The button cycles system → light → dark, so the label describes what the
  // *next* click will do.
  "theme.toggle": "切換主題",
  "theme.toggleTitle": "切換主題（目前：跟隨系統）",
  "theme.system": "跟隨系統",
  "theme.light": "淺色",
  "theme.dark": "深色",
  "theme.toggleTitle.system": "切換主題（目前：跟隨系統）",
  "theme.toggleTitle.light": "切換主題（目前：淺色）",
  "theme.toggleTitle.dark": "切換主題（目前：深色）",

  // --- Status --------------------------------------------------------------
  "status.loaded": "已載入",
  "status.newEntry": "新日記",
  "status.loadFailed": "載入失敗",
  "status.saving": "儲存中…",
  "status.saved": "已儲存",
  "status.saveFailed": "儲存失敗",
  "status.favourited": "已加入收藏",
  "status.unfavourited": "已取消收藏",
  "status.favouriteFailed": "無法更新收藏狀態",
  "status.editing": "編輯中…",
  "status.deleted": "已刪除",
  "status.deleteFailed": "刪除失敗",
  "status.listFailed": "讀取失敗",

  // --- Delete confirmation -------------------------------------------------
  "delete.confirm": "確定要刪除 {date} 的日記嗎？此操作無法復原。",

  // --- Import --------------------------------------------------------------
  "import.title": "匯入日記",
  "import.statReady": "可匯入",
  "import.statConflict": "已存在",
  "import.statFailed": "失敗",
  "import.overwrite": "覆蓋已存在的日記",
  "import.scanning": "掃描中…",
  "import.progress": "匯入中…",
  "import.emptyFolder": "這個資料夾裡沒有 YYYY-MM-DD.txt 檔案",
  "import.errPicker": "無法開啟資料夾選擇器",
  "import.errScan": "掃描失敗",
  "import.errNothing": "沒有可匯入的日記",
  "import.errImport": "匯入失敗",
  "import.reportImported": "成功匯入 {count} 篇日記。",
  "import.reportSkipped": "略過 {count} 篇已存在的日記。",
  "import.reportFailed": "有 {count} 個檔案匯入失敗：",
  "import.reportNoChange": "沒有任何變更。",
  "import.statusImported": "已匯入 {count} 篇",

  // --- Dates ---------------------------------------------------------------
  "date.long": "{year} 年 {month} 月 {day} 日",
  "date.month": "{year} 年 {month} 月",
  "date.today": "今天",
  "date.yesterday": "昨天",
  "date.tomorrow": "明天",
  "date.weekday": "週{name}",
  "weekday.0": "日",
  "weekday.1": "一",
  "weekday.2": "二",
  "weekday.3": "三",
  "weekday.4": "四",
  "weekday.5": "五",
  "weekday.6": "六",
};

const en = {
  // --- Generic -------------------------------------------------------------
  "app.name": "Fly Diary",
  "common.cancel": "Cancel",
  "common.close": "Close",
  "common.done": "Done",
  "common.delete": "Delete",
  "common.today": "Today",
  "common.untitled": "(Untitled)",

  // --- Lock screen ---------------------------------------------------------
  "lock.subtitle.unlock": "Enter your passphrase to unlock the diary",
  "lock.subtitle.existing":
    "This folder already holds an encrypted diary. Enter its passphrase.",
  "lock.subtitle.newInFolder":
    "No encrypted diary here yet. Choose a passphrase to create one.",
  "lock.subtitle.firstRun":
    "First run: choose where to store the diary, then set a passphrase to encrypt it",
  "lock.pathLabel": "Diary folder",
  "lock.pathPlaceholder": "/home/user/Documents/diary",
  "lock.browse": "Browse…",
  "lock.browseTitle": "Choose a folder",
  "lock.pathHint":
    "This path is saved to the settings file and used on every launch.",
  "lock.passphrase": "Passphrase",
  "lock.passphraseSet": "Set a passphrase",
  "lock.passphraseConfirm": "Repeat passphrase",
  "lock.advanced": "Advanced (key derivation parameters)",
  "lock.advancedHint":
    "The passphrase is stretched into a master key with Argon2id, and that master key wraps the diary key. Higher values make brute force harder but unlocking slower.",
  "lock.kdfMemory": "Memory (MiB)",
  "lock.kdfIterations": "Iterations",
  "lock.kdfParallelism": "Parallelism",
  "lock.kdfReset": "Restore defaults",
  "lock.kdfEstimate": "Estimated unlock time: about {seconds}s",
  "lock.submitUnlock": "Unlock",
  "lock.submitCreate": "Create encrypted diary",
  "lock.errNoPassphrase": "Please enter a passphrase",
  "lock.errTooShort": "The passphrase must be at least 6 characters",
  "lock.errMismatch": "The two passphrases do not match",
  "lock.errNoDir": "Please choose a diary folder",
  "lock.errKdfNaN": "Advanced parameters must be numbers",
  "lock.errUnlockFailed": "Unlock failed. Please try again.",
  "lock.errPicker": "Could not open the folder picker",
  "lock.errSettings": "Could not read the settings file",

  // --- Sidebar -------------------------------------------------------------
  "sidebar.newToday": "Today",
  "sidebar.newTodayTitle": "Go to today (Ctrl/Cmd+T)",
  "sidebar.search": "Search date or title…",
  "sidebar.pathTitle": "Diary location",
  "sidebar.import": "Import",
  "sidebar.importTitle": "Import diaries from a folder",
  "sidebar.settings": "Settings",
  "sidebar.settingsTitle": "Open settings",
  "sidebar.stats": "Stats",
  "sidebar.statsTitle": "View statistics",
  "sidebar.changeDir": "Path",
  "sidebar.changeDirTitle": "Change the diary folder",
  "sidebar.lock": "Lock",
  "sidebar.lockTitle": "Lock the diary (Ctrl/Cmd+L)",

  "settings.title": "Settings",
  "settings.autoLock": "Idle auto-lock",
  "settings.autoLockHint":
    "Lock the diary after a period of inactivity, requiring the passphrase again.",
  "settings.autoLockLabel": "Lock after",
  "settings.autoLockNever": "Never",
  "settings.autoLockMinutes": "{n} minutes",
  "settings.security": "Passphrase and key derivation",
  "settings.securityHint":
    "Changing the passphrase only re-wraps the diary key; entries are not re-encrypted, so it is fast.",
  "settings.currentPass": "Current passphrase",
  "settings.newPass": "New passphrase",
  "settings.newPassPlaceholder": "Leave blank to keep it",
  "settings.newPassConfirm": "Confirm new passphrase",
  "settings.advanced": "Advanced: Argon2id parameters",
  "settings.advancedHint":
    "Higher values make brute force harder but unlocking slower. You can measure this machine automatically.",
  "settings.calibrate": "Measure automatically (~1s)",
  "settings.calibrating": "Measuring…",
  "settings.calibrated":
    "Applied: {memory} MiB / {iterations} passes / parallelism {parallelism}",
  "settings.vaultKdf":
    "Current: {memory} MiB / {iterations} passes / parallelism {parallelism}",
  "settings.vaultKdfLegacy":
    "This diary still uses the legacy derivation; unlock once to upgrade it.",
  "settings.save": "Save",
  "settings.saved": "Settings saved",
  "settings.errCurrentRequired": "Enter your current passphrase",
  "settings.errMismatch": "The new passphrases do not match",
  "settings.errNoChange": "Nothing to change",
  "settings.errCalibrate": "Measurement failed: {message}",
  "settings.errSave": "Could not save: {message}",
  "sidebar.empty": "No entries yet",
  "sidebar.emptyFiltered": "No matching entries",
  "sidebar.viewAll": "All",
  "sidebar.viewAllTitle": "Show every entry",
  "sidebar.viewFavourites": "Favourites",
  "sidebar.viewFavouritesTitle": "Show only favourites",
  "sidebar.emptyFavourites": "No favourites yet",
  "sidebar.emptyFavouritesFiltered": "No matching favourites",

  // --- Mobile shell --------------------------------------------------------
  "mobile.openEntries": "Open the entry list",
  "mobile.more": "More",
  "mobile.navLabel": "Main navigation",
  "mobile.navEntries": "Entries",
  "mobile.navFavourites": "Favourites",
  "mobile.navStats": "Stats",
  "mobile.navSettings": "Settings",

  // --- Statistics ----------------------------------------------------------
  "stats.title": "Statistics",
  "stats.total": "Entries",
  "stats.favourites": "Favourites",
  "stats.streak": "Current streak",
  "stats.longest": "Longest streak",
  "stats.days": "{n} days",
  "stats.range": "First {first} · Latest {last}",
  "stats.empty": "No entries yet — write your first one.",
  "stats.months": "Last 12 months",
  "stats.weekdays": "Weekday distribution",
  "stats.monthLabel": "{month}",
  "stats.count": "{n} entries",

  // --- Editor --------------------------------------------------------------
  "editor.prevDay": "Previous day",
  "editor.prevDayTitle": "Previous day (Alt+←)",
  "editor.nextDay": "Next day",
  "editor.nextDayTitle": "Next day (Alt+→)",
  "editor.pickDate": "Pick a date",
  "editor.calPrev": "Previous month",
  "editor.calNext": "Next month",
  "editor.calBackToToday": "Back to today",
  "editor.deleteTitle": "Delete this day's entry",
  "editor.favourite": "Favourite",
  "editor.favouriteOn": "Favourited",
  "editor.favouriteTitle": "Add to favourites (Ctrl/Cmd+D)",
  "editor.unfavouriteTitle": "Remove from favourites (Ctrl/Cmd+D)",
  "editor.titlePlaceholder": "Title",
  "editor.contentPlaceholder": "How was your day?",
  "editor.hint": "Markdown · AES-256-GCM encrypted · Autosaved",
  "editor.wordCount": "{chars} words · {lines} lines",

  // --- Font size -----------------------------------------------------------
  "font.group": "Font size",
  "font.smaller": "Smaller text",
  "font.smallerTitle": "Smaller text (Ctrl/Cmd+-)",
  "font.larger": "Larger text",
  "font.largerTitle": "Larger text (Ctrl/Cmd++)",
  "font.reset": "Reset font size",

  // --- Language switch -----------------------------------------------------
  "lang.switch": "Switch language",
  "lang.switchTitle": "Switch language (currently English)",

  // --- Theme switch --------------------------------------------------------
  "theme.toggle": "Switch theme",
  "theme.toggleTitle": "Switch theme (currently: follow system)",
  "theme.system": "Follow system",
  "theme.light": "Light",
  "theme.dark": "Dark",
  "theme.toggleTitle.system": "Switch theme (currently: follow system)",
  "theme.toggleTitle.light": "Switch theme (currently: light)",
  "theme.toggleTitle.dark": "Switch theme (currently: dark)",

  // --- Status --------------------------------------------------------------
  "status.loaded": "Loaded",
  "status.newEntry": "New entry",
  "status.loadFailed": "Load failed",
  "status.saving": "Saving…",
  "status.saved": "Saved",
  "status.saveFailed": "Save failed",
  "status.favourited": "Added to favourites",
  "status.unfavourited": "Removed from favourites",
  "status.favouriteFailed": "Could not update the favourite",
  "status.editing": "Editing…",
  "status.deleted": "Deleted",
  "status.deleteFailed": "Delete failed",
  "status.listFailed": "Could not read entries",

  // --- Delete confirmation -------------------------------------------------
  "delete.confirm": "Delete the entry for {date}? This cannot be undone.",

  // --- Import --------------------------------------------------------------
  "import.title": "Import diaries",
  "import.statReady": "Ready",
  "import.statConflict": "Existing",
  "import.statFailed": "Failed",
  "import.overwrite": "Overwrite existing entries",
  "import.scanning": "Scanning…",
  "import.progress": "Importing…",
  "import.emptyFolder": "No YYYY-MM-DD.txt files in this folder",
  "import.errPicker": "Could not open the folder picker",
  "import.errScan": "Scan failed",
  "import.errNothing": "Nothing to import",
  "import.errImport": "Import failed",
  "import.reportImported": "Imported {count} entries.",
  "import.reportSkipped": "Skipped {count} existing entries.",
  "import.reportFailed": "{count} files failed to import:",
  "import.reportNoChange": "No changes.",
  "import.statusImported": "Imported {count}",

  // --- Dates ---------------------------------------------------------------
  "date.long": "{month}/{day}/{year}",
  "date.month": "{month}/{year}",
  "date.today": "Today",
  "date.yesterday": "Yesterday",
  "date.tomorrow": "Tomorrow",
  "date.weekday": "{name}",
  "weekday.0": "Sun",
  "weekday.1": "Mon",
  "weekday.2": "Tue",
  "weekday.3": "Wed",
  "weekday.4": "Thu",
  "weekday.5": "Fri",
  "weekday.6": "Sat",
};

const DICTIONARIES = {
  "zh-Hant": zhHant,
  en,
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** Active locale tag. */
let current = "zh-Hant";

/** Listeners notified after every language change. */
const listeners = new Set();

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

/**
 * Translate `key`, substituting `{name}` placeholders from `params`.
 *
 * A missing key falls back to the other dictionary and then to the key itself,
 * so a half-finished translation degrades to readable text instead of
 * `undefined` on screen.
 */
export function t(key, params) {
  const dict = DICTIONARIES[current] || DICTIONARIES["zh-Hant"];
  let text = dict[key];
  if (text === undefined) text = zhHant[key];
  if (text === undefined) return key;
  if (!params) return text;

  return text.replace(/\{(\w+)\}/g, (match, name) =>
    Object.prototype.hasOwnProperty.call(params, name)
      ? String(params[name])
      : match
  );
}

/** The active locale tag. */
export function getLocale() {
  return current;
}

/** Human-readable name of the active locale. */
export function getLocaleName() {
  return LOCALE_NAMES[current] || current;
}

/** The locale that the toggle button would switch to. */
export function nextLocale() {
  const index = LOCALES.indexOf(current);
  return LOCALES[(index + 1) % LOCALES.length];
}

/** Short label for the toggle button, e.g. `EN` while in Chinese. */
export function nextLocaleShort() {
  return LOCALE_SHORT[nextLocale()] || nextLocale();
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

/** `2026-10-23` → `2026 年 10 月 23 日` / `10/23/2026`. */
export function formatDate(iso) {
  const [year, month, day] = iso.split("-").map(Number);
  return t("date.long", { year, month, day });
}

/** `2026-10` or `2026-10-01` → `2026 年 10 月` / `10/2026`. */
export function formatMonth(monthStart) {
  const [year, month] = monthStart.split("-").map(Number);
  return t("date.month", { year, month });
}

/** Weekday name for a `Date`'s `getDay()` value. */
export function weekdayName(dayIndex) {
  return t(`weekday.${dayIndex}`);
}

/** `2026-10-23` → `週五` / `Fri`. */
export function formatWeekday(iso) {
  const [year, month, day] = iso.split("-").map(Number);
  const index = new Date(year, month - 1, day).getDay();
  return t("date.weekday", { name: weekdayName(index) });
}

// ---------------------------------------------------------------------------
// Applying translations to markup
// ---------------------------------------------------------------------------
//
// Supported attributes:
//   data-i18n              → textContent
//   data-i18n-title        → title
//   data-i18n-placeholder  → placeholder
//   data-i18n-aria-label   → aria-label
//
// `data-i18n-attr` is not needed because the four above cover every string in
// this app; adding one is a two-line change if that ever stops being true.

const ATTR_MAP = [
  [
    "data-i18n",
    (el, text) => {
      el.textContent = text;
    },
  ],
  [
    "data-i18n-title",
    (el, text) => {
      el.title = text;
    },
  ],
  [
    "data-i18n-placeholder",
    (el, text) => {
      el.placeholder = text;
    },
  ],
  [
    "data-i18n-aria-label",
    (el, text) => {
      el.setAttribute("aria-label", text);
    },
  ],
];

/** Translate every `data-i18n*` node inside `root` (default: the document). */
export function applyTranslations(root = document) {
  for (const [attr, set] of ATTR_MAP) {
    for (const el of root.querySelectorAll(`[${attr}]`)) {
      set(el, t(el.getAttribute(attr)));
    }
  }

  // The document language drives hyphenation, spell-check and screen readers.
  document.documentElement.lang = current;
  document.title = t("app.name");
}

// ---------------------------------------------------------------------------
// Switching
// ---------------------------------------------------------------------------

/** Persist the choice. Storage may be unavailable in a locked-down webview. */
function persist(locale) {
  try {
    localStorage.setItem(STORAGE_KEY, locale);
  } catch {
    // The language just won't survive a restart.
  }
}

/**
 * Activate `locale`, re-translate the markup and notify listeners.
 *
 * Listeners are how `main.js` refreshes strings it generated itself (status
 * text, the date pill, the calendar grid, the import list). Without them those
 * would keep the old language until the next redraw.
 */
export function setLocale(locale) {
  if (!DICTIONARIES[locale] || locale === current) return;
  current = locale;
  persist(locale);
  applyTranslations();
  for (const listener of listeners) listener(current);
}

/** Switch to the next locale in `LOCALES`. */
export function toggleLocale() {
  setLocale(nextLocale());
}

/** Register a callback fired after every language change. */
export function onLocaleChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Pick the startup locale.
 *
 * Order: the saved choice, then the OS/browser preference, then `zh-Hant`.
 * Matching is done on the primary subtag so `en-US` and `en-GB` both land on
 * `en`, and `zh-TW` / `zh-HK` both land on `zh-Hant`.
 */
export function initLocale() {
  let stored = null;
  try {
    stored = localStorage.getItem(STORAGE_KEY);
  } catch {
    stored = null;
  }

  if (DICTIONARIES[stored]) {
    current = stored;
  } else {
    const preferred = (navigator.languages || [navigator.language || ""]).map(
      (tag) => String(tag).toLowerCase()
    );
    const match = preferred.find((tag) => tag.startsWith("en"));
    current = match ? "en" : "zh-Hant";
  }

  applyTranslations();
  return current;
}
