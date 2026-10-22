import { invoke } from "@tauri-apps/api/core";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** Currently selected date, `YYYY-MM-DD`. */
let currentDate = "";
/** Content last loaded from / saved to disk, used to detect dirty state. */
let savedContent = "";
/** Debounce timer for autosave. */
let saveTimer = null;
/** All entry metadata, newest first. */
let allEntries = [];
/** Search filter string. */
let searchQuery = "";
/** Guard so programmatic textarea updates don't trigger autosave. */
let suppressInput = false;

const AUTOSAVE_DELAY = 800;

// ---------------------------------------------------------------------------
// DOM references
// ---------------------------------------------------------------------------

const $ = (id) => document.getElementById(id);
const els = {
  list: $("entry-list"),
  search: $("search"),
  datePicker: $("date-picker"),
  content: $("content"),
  status: $("status"),
  wordCount: $("word-count"),
  diaryPath: $("diary-path"),
  prevDay: $("prev-day"),
  nextDay: $("next-day"),
  newToday: $("new-today"),
  deleteBtn: $("delete-btn"),
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
        (e) =>
          e.date.includes(q) || (e.preview || "").toLowerCase().includes(q),
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
    preview.className = "entry-preview" + (entry.preview ? "" : " empty");
    preview.textContent = entry.preview || "（空白）";

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
  try {
    allEntries = await invoke("list_entries");
    renderList();
  } catch (err) {
    console.error("list_entries failed:", err);
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
    const content = entry ? entry.content : "";
    suppressInput = true;
    els.content.value = content;
    suppressInput = false;
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
  const content = els.content.value;
  if (content === savedContent) {
    setStatus("已儲存", true);
    return;
  }

  setStatus("儲存中…");
  try {
    await invoke("save_entry", { date: currentDate, content });
    savedContent = content;
    setStatus("已儲存", true);
    await refreshList();
    els.deleteBtn.disabled = content.trim() === "";
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
  const hasContent = els.content.value.trim() !== "";
  if (
    hasContent &&
    !confirm(`確定要刪除 ${currentDate} 的日記嗎？此操作無法復原。`)
  ) {
    return;
  }

  try {
    await invoke("delete_entry", { date: currentDate });
    suppressInput = true;
    els.content.value = "";
    suppressInput = false;
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
// Event wiring
// ---------------------------------------------------------------------------

els.content.addEventListener("input", () => {
  if (suppressInput) return;
  updateWordCount();
  scheduleSave();
});

els.datePicker.addEventListener("change", () => {
  if (els.datePicker.value) selectDate(els.datePicker.value);
});

els.prevDay.addEventListener("click", () =>
  selectDate(shiftDate(currentDate, -1)),
);
els.nextDay.addEventListener("click", () =>
  selectDate(shiftDate(currentDate, 1)),
);

els.newToday.addEventListener("click", async () => {
  const today = await invoke("today");
  await selectDate(today);
});

els.deleteBtn.addEventListener("click", deleteCurrent);

els.search.addEventListener("input", () => {
  searchQuery = els.search.value;
  renderList();
});

// Keyboard shortcuts.
document.addEventListener("keydown", (e) => {
  const mod = e.ctrlKey || e.metaKey;

  if (mod && e.key.toLowerCase() === "s") {
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

init();
