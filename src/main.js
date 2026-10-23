// Tauri injects `window.__TAURI__` into the webview. We use it instead of
// `import { invoke } from "@tauri-apps/api/core"` because the frontend is
// served as plain static files (no bundler), so bare module specifiers cannot
// be resolved by the browser.
const { invoke } = window.__TAURI__.core;

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

const AUTOSAVE_DELAY = 800;

// ---------------------------------------------------------------------------
// DOM references
// ---------------------------------------------------------------------------

const $ = (id) => document.getElementById(id);
const els = {
  // Lock screen
  lockScreen: $("lock-screen"),
  lockForm: $("lock-form"),
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
  search: $("search"),
  datePicker: $("date-picker"),
  title: $("title"),
  content: $("content"),
  status: $("status"),
  wordCount: $("word-count"),
  diaryPath: $("diary-path"),
  prevDay: $("prev-day"),
  nextDay: $("next-day"),
  newToday: $("new-today"),
  deleteBtn: $("delete-btn"),
  lockBtn: $("lock-btn"),
  changeDirBtn: $("change-dir-btn"),
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

const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];

function weekdayOf(iso) {
  return `週${WEEKDAYS[fromISODate(iso).getDay()]}`;
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
  els.wordCount.textContent = `${chars} 字 · ${lines} 行`;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderList() {
  const q = searchQuery.trim().toLowerCase();
  const filtered = q
    ? allEntries.filter(
        (e) => e.date.includes(q) || (e.title || "").toLowerCase().includes(q)
      )
    : allEntries;

  els.list.innerHTML = "";

  if (filtered.length === 0) {
    const li = document.createElement("li");
    li.className = "list-empty";
    li.textContent = q ? "沒有符合的日記" : "還沒有任何日記";
    els.list.appendChild(li);
    return;
  }

  for (const entry of filtered) {
    const li = document.createElement("li");
    li.className = "entry-item" + (entry.date === currentDate ? " active" : "");
    li.dataset.date = entry.date;

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
    preview.textContent = entry.title || "（無標題）";

    li.append(dateRow, preview);
    li.addEventListener("click", () => selectDate(entry.date));
    els.list.appendChild(li);
  }
}

function highlightActive() {
  for (const li of els.list.querySelectorAll(".entry-item")) {
    li.classList.toggle("active", li.dataset.date === currentDate);
  }
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
    setStatus("讀取失敗");
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
    setStatus(entry ? "已載入" : "新日記");
  } catch (err) {
    console.error("get_entry failed:", err);
    setStatus("載入失敗");
  }

  els.deleteBtn.disabled = !allEntries.some((e) => e.date === date);
  updateWordCount();
  highlightActive();
  els.content.focus();
}

/** Persist the current editor content immediately. */
async function saveNow() {
  if (!currentDate) return;
  const title = els.title.value;
  const content = els.content.value;
  if (title === savedTitle && content === savedContent) {
    setStatus("已儲存", true);
    return;
  }

  setStatus("儲存中…");
  try {
    await invoke("save_entry", { date: currentDate, title, content });
    savedTitle = title;
    savedContent = content;
    setStatus("已儲存", true);
    await refreshList();
    els.deleteBtn.disabled = content.trim() === "" && title.trim() === "";
  } catch (err) {
    console.error("save_entry failed:", err);
    setStatus("儲存失敗");
  }
}

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  setStatus("編輯中…");
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    await saveNow();
  }, AUTOSAVE_DELAY);
}

async function deleteCurrent() {
  if (!currentDate) return;
  const hasData =
    els.content.value.trim() !== "" || els.title.value.trim() !== "";
  if (
    hasData &&
    !confirm(`確定要刪除 ${currentDate} 的日記嗎？此操作無法復原。`)
  ) {
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
    setStatus("已刪除");
    els.deleteBtn.disabled = true;
    await refreshList();
  } catch (err) {
    console.error("delete_entry failed:", err);
    setStatus("刪除失敗");
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
  els.kdfEstimate.textContent = `預估解鎖時間：約 ${seconds.toFixed(2)} 秒`;
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
      ? "請輸入密碼以解鎖日記"
      : "此資料夾已有加密日記，請輸入密碼解鎖";
    els.passphraseConfirm.hidden = true;
    els.passphrase.placeholder = "密碼";
    els.passphrase.autocomplete = "current-password";
    els.lockSubmit.textContent = "解鎖";
  } else if (configured) {
    // Configured folder but no vault yet (e.g. an empty folder was picked).
    els.lockSubtitle.textContent = "此資料夾尚未建立加密日記，請設定一組密碼";
    els.passphraseConfirm.hidden = false;
    els.passphrase.placeholder = "設定密碼";
    els.passphrase.autocomplete = "new-password";
    els.lockSubmit.textContent = "建立加密日記";
  } else {
    // First run: pick a folder, then choose a passphrase.
    els.lockSubtitle.textContent =
      "第一次使用：選擇日記儲存位置，並設定一組密碼來加密日記";
    els.passphraseConfirm.hidden = false;
    els.passphrase.placeholder = "設定密碼";
    els.passphrase.autocomplete = "new-password";
    els.lockSubmit.textContent = "建立加密日記";
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
    els.lockError.textContent = "請輸入密碼";
    return;
  }

  const creating = !vaultInitialized;
  if (creating) {
    const confirmValue = els.passphraseConfirm.value;
    if (passphrase.length < 6) {
      els.lockError.textContent = "密碼至少需要 6 個字元";
      return;
    }
    if (passphrase !== confirmValue) {
      els.lockError.textContent = "兩次輸入的密碼不一致";
      return;
    }
  }

  els.lockSubmit.disabled = true;
  try {
    if (!configured) {
      const dir = els.diaryDir.value.trim();
      if (!dir) {
        els.lockError.textContent = "請選擇日記儲存資料夾";
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
        els.lockError.textContent = "進階參數必須是數字";
        return;
      }
      await invoke("create_vault", { passphrase, kdf });
      vaultInitialized = true;
    }
    await enterApp();
  } catch (err) {
    console.error("unlock failed:", err);
    els.lockError.textContent =
      typeof err === "string" ? err : "解鎖失敗，請再試一次";
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
    els.lockError.textContent = "無法開啟資料夾選擇器";
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
  els.list.innerHTML = "";
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
  els.list.innerHTML = "";
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

els.datePicker.addEventListener("change", () => {
  if (els.datePicker.value) selectDate(els.datePicker.value);
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

els.search.addEventListener("input", () => {
  searchQuery = els.search.value;
  renderList();
});

// Keyboard shortcuts.
document.addEventListener("keydown", (e) => {
  const mod = e.ctrlKey || e.metaKey;

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
    els.lockError.textContent = "無法讀取設定檔";
  }

  showLockScreen();
  renderLockScreen();
}

init();
