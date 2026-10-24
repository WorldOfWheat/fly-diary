// ---------------------------------------------------------------------------
// Event wiring tests
// ---------------------------------------------------------------------------
//
// `wiring.js` exists so the listeners can be exercised without a webview. These
// tests build a fake `els` table whose entries record their listeners, then
// dispatch synthetic events and assert which callback fired.
//
// The point is not to re-test `main.js` behaviour but to pin down the dispatch
// rules that are easy to break silently: which shortcut wins when two could
// apply, and that a shortcut does nothing while the app is still locked.

import test from "node:test";
import assert from "node:assert/strict";

import { initEventWiring } from "../src/wiring.js";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/**
 * A minimal event target that remembers its listeners.
 *
 * `dispatch` calls every listener registered for the type with a plain object,
 * which is enough because the handlers only read `key`, the modifier flags,
 * `target` and call `preventDefault()`.
 */
function fakeTarget(extra = {}) {
  const listeners = new Map();

  return {
    listeners,
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(handler);
    },
    removeEventListener(type, handler) {
      const list = listeners.get(type);
      if (!list) return;
      const index = list.indexOf(handler);
      if (index !== -1) list.splice(index, 1);
    },
    /** Fire every listener for `type`; returns the event object. */
    dispatch(type, event = {}) {
      const payload = {
        type,
        key: "",
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        shiftKey: false,
        target: null,
        defaultPrevented: false,
        preventDefault() {
          this.defaultPrevented = true;
        },
        ...event,
      };
      for (const handler of listeners.get(type) ?? []) handler(payload);
      return payload;
    },
    /** Number of listeners currently attached for `type`. */
    count(type) {
      return (listeners.get(type) ?? []).length;
    },
    ...extra,
  };
}

/** Every element id `wiring.js` touches, so the fake table is complete. */
const ELEMENT_IDS = [
  "lockForm",
  "browseDir",
  "switchWorkspace",
  "cancelWorkspace",
  "kdfReset",
  "kdfMemory",
  "kdfIterations",
  "kdfParallelism",
  "diaryDir",
  "title",
  "content",
  "dateLabel",
  "prevDay",
  "nextDay",
  "newToday",
  "deleteBtn",
  "favouriteBtn",
  "lockBtn",
  "changeDirBtn",
  "calPrev",
  "calNext",
  "calMonth",
  "calClose",
  "calToday",
  "calGrid",
  "calendar",
  "calendarBackdrop",
  "settingsBtn",
  "settingsClose",
  "settingsCancel",
  "settingsSave",
  "settingsCalibrate",
  "settingsOverlay",
  "statsBtn",
  "statsClose",
  "statsDone",
  "statsOverlay",
  "importBtn",
  "importClose",
  "importCancel",
  "importConfirm",
  "importOverlay",
  "viewAll",
  "viewFavourites",
  "viewBroken",
  "brokenExportBtn",
  "brokenDeleteBtn",
  "search",
  "listScroll",
];

/**
 * Build the fake `els` table plus the globals `wiring.js` binds to.
 *
 * `window` and `document` are replaced on `globalThis` for the duration of a
 * test and restored by `restore()`.
 */
function harness(overrides = {}) {
  const els = {};
  for (const id of ELEMENT_IDS) els[id] = fakeTarget();

  // Elements the wiring reads beyond event handling.
  els.app = fakeTarget({ hidden: false });
  els.search.value = "";
  els.listScroll.scrollTop = 0;
  els.calendar.contains = () => false;
  els.dateLabel.contains = () => false;

  // Ctrl+T forwards to a real click, so the button needs a `click()` method
  // that dispatches through the same listener table.
  els.newToday.click = () => els.newToday.dispatch("click");

  const calls = [];
  /** Record a call and return a canned value. */
  const spy =
    (name, value) =>
    (...args) => {
      calls.push({ name, args });
      return value;
    };

  const deps = {
    els,
    handleUnlockSubmit: spy("handleUnlockSubmit"),
    browseForDir: spy("browseForDir"),
    openWorkspacePicker: spy("openWorkspacePicker"),
    cancelWorkspacePicker: spy("cancelWorkspacePicker"),
    resetKdfFields: spy("resetKdfFields"),
    updateKdfEstimate: spy("updateKdfEstimate"),
    refreshSetupVaultState: spy("refreshSetupVaultState"),
    scheduleSave: spy("scheduleSave"),
    updateWordCount: spy("updateWordCount"),
    toggleCalendar: spy("toggleCalendar"),
    stepCalendarMonth: spy("stepCalendarMonth"),
    pickCalendarDate: spy("pickCalendarDate"),
    moveCalendarFocus: spy("moveCalendarFocus"),
    isCalendarOpen: () => false,
    closeCalendar: spy("closeCalendar"),
    selectDate: spy("selectDate"),
    deleteCurrent: spy("deleteCurrent"),
    toggleFavourite: spy("toggleFavourite"),
    lockNow: spy("lockNow"),
    changeDiaryDir: spy("changeDiaryDir"),
    openSettings: spy("openSettings"),
    closeSettings: spy("closeSettings"),
    saveSettings: spy("saveSettings"),
    calibrateKdf: spy("calibrateKdf"),
    openStats: spy("openStats"),
    closeStats: spy("closeStats"),
    isStatsOpen: () => false,
    setView: spy("setView"),
    exportBrokenFile: spy("exportBrokenFile"),
    startImport: spy("startImport"),
    closeImport: spy("closeImport"),
    confirmImport: spy("confirmImport"),
    isImportOpen: () => false,
    isImportDone: () => false,
    setSearchQuery: spy("setSearchQuery"),
    renderList: spy("renderList"),
    renderVisibleRows: spy("renderVisibleRows"),
    saveNow: spy("saveNow"),
    hasPendingSave: () => false,
    clearPendingSave: spy("clearPendingSave"),
    today: async () => "2026-10-23",
    shiftDate: (iso, days) => `${iso}${days > 0 ? "+" : ""}${days}`,
    getCurrentDate: () => "2026-10-23",
    monthStartOf: (iso) => `${iso.slice(0, 7)}-01`,
    toISODate: () => "2026-10-23",
    setCalendarMonth: spy("setCalendarMonth"),
    renderCalendar: spy("renderCalendar"),
    isInputSuppressed: () => false,
    ...overrides,
  };

  const windowTarget = fakeTarget();
  const documentTarget = fakeTarget();

  const previous = {
    window: globalThis.window,
    document: globalThis.document,
  };
  globalThis.window = windowTarget;
  globalThis.document = documentTarget;

  const cleanup = initEventWiring(deps);

  return {
    els,
    deps,
    calls,
    window: windowTarget,
    document: documentTarget,
    /** Names of the callbacks invoked so far, in order. */
    names: () => calls.map((call) => call.name),
    /** Arguments of the first call to `name`, or `undefined`. */
    argsOf: (name) => calls.find((call) => call.name === name)?.args,
    cleanup,
    restore() {
      cleanup();
      globalThis.window = previous.window;
      globalThis.document = previous.document;
    },
  };
}

/** Run `body` with a fresh harness, always restoring the globals. */
function withHarness(body, overrides) {
  const h = harness(overrides);
  try {
    return body(h);
  } finally {
    h.restore();
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

test("every element in the table gets at least one listener", () => {
  // `calendar` is only ever queried with `contains()`, never bound, so it is
  // the one entry that legitimately has no listener of its own.
  const readOnly = new Set(["calendar"]);

  withHarness((h) => {
    for (const id of ELEMENT_IDS) {
      const total = [...h.els[id].listeners.values()].reduce(
        (sum, list) => sum + list.length,
        0
      );
      if (readOnly.has(id)) {
        assert.equal(total, 0, `els.${id} should not be bound`);
      } else {
        assert.ok(total > 0, `expected a listener on els.${id}`);
      }
    }
  });
});

test("the global keydown and beforeunload listeners are attached", () => {
  withHarness((h) => {
    assert.equal(h.document.count("keydown"), 1);
    assert.equal(h.document.count("mousedown"), 1);
    assert.equal(h.window.count("beforeunload"), 1);
    assert.equal(h.window.count("resize"), 1);
  });
});

test("cleanup removes every listener it added", () => {
  const h = harness();
  try {
    h.cleanup();
    assert.equal(h.document.count("keydown"), 0);
    assert.equal(h.document.count("mousedown"), 0);
    assert.equal(h.window.count("beforeunload"), 0);
    assert.equal(h.window.count("resize"), 0);
    for (const id of ELEMENT_IDS) {
      const total = [...h.els[id].listeners.values()].reduce(
        (sum, list) => sum + list.length,
        0
      );
      assert.equal(total, 0, `expected els.${id} to be unwired`);
    }
  } finally {
    h.restore();
  }
});

// ---------------------------------------------------------------------------
// Keyboard shortcuts
// ---------------------------------------------------------------------------

test("Ctrl+S saves and clears the pending timer first", () => {
  withHarness((h) => {
    h.deps.hasPendingSave = () => true;
    const event = h.document.dispatch("keydown", { key: "s", ctrlKey: true });

    assert.equal(event.defaultPrevented, true);
    assert.deepEqual(h.names(), ["clearPendingSave", "saveNow"]);
  });
});

test("Ctrl+S without a pending save only saves", () => {
  withHarness((h) => {
    h.document.dispatch("keydown", { key: "s", ctrlKey: true });
    assert.deepEqual(h.names(), ["saveNow"]);
  });
});

test("Cmd+S is treated as Ctrl+S", () => {
  withHarness((h) => {
    h.document.dispatch("keydown", { key: "S", metaKey: true });
    assert.deepEqual(h.names(), ["saveNow"]);
  });
});

test("Ctrl+L locks only when the app is visible", () => {
  withHarness((h) => {
    h.document.dispatch("keydown", { key: "l", ctrlKey: true });
    assert.deepEqual(h.names(), ["lockNow"]);
  });

  withHarness((h) => {
    h.els.app.hidden = true;
    h.document.dispatch("keydown", { key: "l", ctrlKey: true });
    assert.deepEqual(h.names(), []);
  });
});

test("Ctrl+T clicks the new-today button", () => {
  withHarness((h) => {
    h.document.dispatch("keydown", { key: "t", ctrlKey: true });
    assert.equal(h.els.newToday.count("click"), 1);
    // The click handler is async; it awaits `today()` before selecting.
    assert.deepEqual(h.names(), []);
  });
});

test("Ctrl+D toggles the favourite flag", () => {
  withHarness((h) => {
    h.document.dispatch("keydown", { key: "d", ctrlKey: true });
    assert.deepEqual(h.names(), ["toggleFavourite"]);
  });
});

test("Alt+Arrow steps the date by one day in each direction", () => {
  withHarness((h) => {
    h.document.dispatch("keydown", { key: "ArrowLeft", altKey: true });
    assert.deepEqual(h.argsOf("selectDate"), ["2026-10-23-1"]);
  });

  withHarness((h) => {
    h.document.dispatch("keydown", { key: "ArrowRight", altKey: true });
    assert.deepEqual(h.argsOf("selectDate"), ["2026-10-23+1"]);
  });
});

test("shortcuts other than Ctrl+L are ignored while the app is locked", () => {
  withHarness((h) => {
    h.els.app.hidden = true;
    for (const key of ["s", "t", "d"]) {
      h.document.dispatch("keydown", { key, ctrlKey: true });
    }
    h.document.dispatch("keydown", { key: "ArrowLeft", altKey: true });
    assert.deepEqual(h.names(), []);
  });
});

test("an unbound key does nothing", () => {
  withHarness((h) => {
    const event = h.document.dispatch("keydown", { key: "q", ctrlKey: true });
    assert.equal(event.defaultPrevented, false);
    assert.deepEqual(h.names(), []);
  });
});

// ---------------------------------------------------------------------------
// Escape closes the topmost layer
// ---------------------------------------------------------------------------

test("Escape closes the statistics dialog before anything else", () => {
  withHarness(
    (h) => {
      const event = h.document.dispatch("keydown", { key: "Escape" });
      assert.equal(event.defaultPrevented, true);
      assert.deepEqual(h.names(), ["closeStats"]);
    },
    {
      isStatsOpen: () => true,
      isImportOpen: () => true,
      isCalendarOpen: () => true,
    }
  );
});

test("Escape closes the import dialog when statistics is closed", () => {
  withHarness(
    (h) => {
      h.document.dispatch("keydown", { key: "Escape" });
      assert.deepEqual(h.names(), ["closeImport"]);
    },
    { isImportOpen: () => true, isCalendarOpen: () => true }
  );
});

test("Escape closes the calendar and restores focus", () => {
  withHarness(
    (h) => {
      h.document.dispatch("keydown", { key: "Escape" });
      assert.deepEqual(h.names(), ["closeCalendar"]);
      assert.deepEqual(h.argsOf("closeCalendar"), [{ restoreFocus: true }]);
    },
    { isCalendarOpen: () => true }
  );
});

test("Escape with nothing open is left to the browser", () => {
  withHarness((h) => {
    const event = h.document.dispatch("keydown", { key: "Escape" });
    assert.equal(event.defaultPrevented, false);
    assert.deepEqual(h.names(), []);
  });
});

// ---------------------------------------------------------------------------
// Editor input
// ---------------------------------------------------------------------------

test("typing in the content updates the word count and schedules a save", () => {
  withHarness((h) => {
    h.els.content.dispatch("input");
    assert.deepEqual(h.names(), ["updateWordCount", "scheduleSave"]);
  });
});

test("typing in the title only schedules a save", () => {
  withHarness((h) => {
    h.els.title.dispatch("input");
    assert.deepEqual(h.names(), ["scheduleSave"]);
  });
});

test("input is ignored while the editor is being repopulated", () => {
  withHarness(
    (h) => {
      h.els.title.dispatch("input");
      h.els.content.dispatch("input");
      assert.deepEqual(h.names(), []);
    },
    { isInputSuppressed: () => true }
  );
});

test("the day arrows shift the current date", () => {
  withHarness((h) => {
    h.els.prevDay.dispatch("click");
    assert.deepEqual(h.argsOf("selectDate"), ["2026-10-23-1"]);
  });

  withHarness((h) => {
    h.els.nextDay.dispatch("click");
    assert.deepEqual(h.argsOf("selectDate"), ["2026-10-23+1"]);
  });
});

// ---------------------------------------------------------------------------
// Calendar popup
// ---------------------------------------------------------------------------

test("calendar arrow keys move the focus ring by the right number of days", () => {
  const cases = [
    ["ArrowLeft", -1],
    ["ArrowRight", 1],
    ["ArrowUp", -7],
    ["ArrowDown", 7],
  ];

  for (const [key, days] of cases) {
    withHarness((h) => {
      const event = h.els.calGrid.dispatch("keydown", { key });
      assert.equal(event.defaultPrevented, true, `${key} should be handled`);
      assert.deepEqual(h.argsOf("moveCalendarFocus"), [days], key);
    });
  }
});

test("PageUp and PageDown flip the calendar month", () => {
  withHarness((h) => {
    h.els.calGrid.dispatch("keydown", { key: "PageUp" });
    assert.deepEqual(h.argsOf("stepCalendarMonth"), [-1]);
  });

  withHarness((h) => {
    h.els.calGrid.dispatch("keydown", { key: "PageDown" });
    assert.deepEqual(h.argsOf("stepCalendarMonth"), [1]);
  });
});

test("clicking a day cell picks that date", () => {
  withHarness((h) => {
    const cell = { dataset: { date: "2026-10-05" } };
    h.els.calGrid.dispatch("click", {
      target: {
        closest: (selector) => (selector === ".cal-day" ? cell : null),
      },
    });
    assert.deepEqual(h.argsOf("pickCalendarDate"), ["2026-10-05"]);
  });
});

test("clicking the grid background picks nothing", () => {
  withHarness((h) => {
    h.els.calGrid.dispatch("click", { target: { closest: () => null } });
    assert.deepEqual(h.names(), []);
  });
});

test("the close button dismisses the overlay and restores focus", () => {
  withHarness((h) => {
    h.els.calClose.dispatch("click");
    assert.deepEqual(h.argsOf("closeCalendar"), [{ restoreFocus: true }]);
  });
});

test("clicking the backdrop dismisses the overlay", () => {
  withHarness((h) => {
    h.els.calendarBackdrop.dispatch("click");
    assert.deepEqual(h.argsOf("closeCalendar"), [{ restoreFocus: true }]);
  });
});

test("the month label jumps back to the selected month", () => {
  withHarness((h) => {
    h.els.calMonth.dispatch("click");
    assert.deepEqual(h.argsOf("setCalendarMonth"), ["2026-10-01"]);
    assert.deepEqual(h.names(), ["setCalendarMonth", "renderCalendar"]);
  });
});

test("an outside mousedown closes the calendar, an inside one does not", () => {
  withHarness(
    (h) => {
      h.document.dispatch("mousedown", { target: {} });
      assert.deepEqual(h.names(), ["closeCalendar"]);
    },
    { isCalendarOpen: () => true }
  );

  withHarness(
    (h) => {
      h.els.calendar.contains = () => true;
      h.document.dispatch("mousedown", { target: {} });
      assert.deepEqual(h.names(), []);
    },
    { isCalendarOpen: () => true }
  );
});

test("an outside mousedown is ignored when the calendar is closed", () => {
  withHarness((h) => {
    h.document.dispatch("mousedown", { target: {} });
    assert.deepEqual(h.names(), []);
  });
});

// ---------------------------------------------------------------------------
// Dialogs
// ---------------------------------------------------------------------------

test("the import primary button confirms, then dismisses after a run", () => {
  withHarness((h) => {
    h.els.importConfirm.dispatch("click");
    assert.deepEqual(h.names(), ["confirmImport"]);
  });

  withHarness(
    (h) => {
      h.els.importConfirm.dispatch("click");
      assert.deepEqual(h.names(), ["closeImport"]);
    },
    { isImportDone: () => true }
  );
});

test("a backdrop mousedown closes the dialog but a click inside does not", () => {
  withHarness((h) => {
    h.els.settingsOverlay.dispatch("mousedown", {
      target: h.els.settingsOverlay,
    });
    assert.deepEqual(h.names(), ["closeSettings"]);
  });

  withHarness((h) => {
    h.els.settingsOverlay.dispatch("mousedown", { target: {} });
    assert.deepEqual(h.names(), []);
  });
});

test("the statistics and import backdrops dismiss their dialogs", () => {
  withHarness((h) => {
    h.els.statsOverlay.dispatch("mousedown", { target: h.els.statsOverlay });
    assert.deepEqual(h.names(), ["closeStats"]);
  });

  withHarness((h) => {
    h.els.importOverlay.dispatch("mousedown", { target: h.els.importOverlay });
    assert.deepEqual(h.names(), ["closeImport"]);
  });
});

// ---------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------

test("the search box resets the scroll position and re-renders", () => {
  withHarness((h) => {
    h.els.search.value = "trip";
    h.els.listScroll.scrollTop = 400;
    h.els.search.dispatch("input");

    assert.deepEqual(h.argsOf("setSearchQuery"), ["trip"]);
    assert.equal(h.els.listScroll.scrollTop, 0);
    assert.deepEqual(h.names(), ["setSearchQuery", "renderList"]);
  });
});

test("scrolling redraws the visible window without forcing a re-measure", () => {
  withHarness((h) => {
    h.els.listScroll.dispatch("scroll");
    assert.deepEqual(h.argsOf("renderVisibleRows"), []);
  });
});

test("resizing forces a re-measure", () => {
  withHarness((h) => {
    h.window.dispatch("resize");
    assert.deepEqual(h.argsOf("renderVisibleRows"), [true]);
  });
});

test("the view switch buttons select the matching view", () => {
  withHarness((h) => {
    h.els.viewAll.dispatch("click");
    assert.deepEqual(h.argsOf("setView"), ["all"]);
  });

  withHarness((h) => {
    h.els.viewFavourites.dispatch("click");
    assert.deepEqual(h.argsOf("setView"), ["favourites"]);
  });
});

// ---------------------------------------------------------------------------
// Unload
// ---------------------------------------------------------------------------

test("beforeunload flushes a pending save", () => {
  withHarness((h) => {
    h.deps.hasPendingSave = () => true;
    h.window.dispatch("beforeunload");
    assert.deepEqual(h.names(), ["clearPendingSave", "saveNow"]);
  });
});

test("beforeunload does nothing when there is no pending save", () => {
  withHarness((h) => {
    h.window.dispatch("beforeunload");
    assert.deepEqual(h.names(), []);
  });
});

// ---------------------------------------------------------------------------
// Async handlers
// ---------------------------------------------------------------------------

test("the new-today button selects the date the backend reports", async () => {
  const h = harness();
  try {
    h.els.newToday.dispatch("click");
    // The handler awaits `today()` before selecting, so let the microtask run.
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(h.argsOf("selectDate"), ["2026-10-23"]);
  } finally {
    h.restore();
  }
});

test("the calendar today button picks the backend date", async () => {
  const h = harness();
  try {
    h.els.calToday.dispatch("click");
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(h.argsOf("pickCalendarDate"), ["2026-10-23"]);
  } finally {
    h.restore();
  }
});

test("clicking the calendar month label jumps to the selected month", () => {
  withHarness((h) => {
    h.els.calMonth.dispatch("click");
    assert.deepEqual(h.argsOf("setCalendarMonth"), ["2026-10-01"]);
    assert.deepEqual(h.names(), ["setCalendarMonth", "renderCalendar"]);
  });
});

test("the calendar month label falls back to today when no date is selected", () => {
  withHarness(
    (h) => {
      h.els.calMonth.dispatch("click");
      assert.deepEqual(h.argsOf("setCalendarMonth"), ["2026-10-01"]);
    },
    { getCurrentDate: () => "" }
  );
});

// ---------------------------------------------------------------------------
// Path detection debounce
// ---------------------------------------------------------------------------

test("editing the diary path re-checks the vault once, after a pause", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });

  withHarness((h) => {
    // Three keystrokes in quick succession must collapse into one check.
    h.els.diaryDir.dispatch("input");
    h.els.diaryDir.dispatch("input");
    h.els.diaryDir.dispatch("input");
    assert.deepEqual(h.names(), [], "nothing runs before the pause");

    t.mock.timers.tick(349);
    assert.deepEqual(h.names(), [], "still waiting at 349ms");

    t.mock.timers.tick(1);
    assert.deepEqual(h.names(), ["refreshSetupVaultState"]);
  });
});

test("cleanup cancels a pending path check", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });

  const h = harness();
  try {
    h.els.diaryDir.dispatch("input");
    h.cleanup();
    t.mock.timers.tick(500);
    assert.deepEqual(h.names(), []);
  } finally {
    h.restore();
  }
});

// ---------------------------------------------------------------------------
// Workspace switching
// ---------------------------------------------------------------------------

test("the switch-workspace button opens the picker", () => {
  withHarness((h) => {
    h.els.switchWorkspace.dispatch("click");
    assert.deepEqual(h.names(), ["openWorkspacePicker"]);
  });
});

test("the cancel-workspace button closes the picker", () => {
  withHarness((h) => {
    h.els.cancelWorkspace.dispatch("click");
    assert.deepEqual(h.names(), ["cancelWorkspacePicker"]);
  });
});

// ---------------------------------------------------------------------------
// Broken entries
// ---------------------------------------------------------------------------
//
// A file that fails to decrypt is never loaded into the editor. The sidebar
// grows a third tab for them, and the banner above the editor offers the only
// two actions that are safe on such a file: export a copy, or delete it. The
// wiring must not let either button fall through to the normal save path.

test("the broken tab switches to the broken view", () => {
  withHarness((h) => {
    h.els.viewBroken.dispatch("click");
    assert.deepEqual(h.names(), ["setView"]);
    assert.deepEqual(h.argsOf("setView"), ["broken"]);
  });
});

test("the broken banner export button exports the current entry", () => {
  withHarness((h) => {
    h.els.brokenExportBtn.dispatch("click");
    assert.deepEqual(h.names(), ["exportBrokenFile"]);
  });
});

test("the broken banner delete button goes through the delete flow", () => {
  withHarness((h) => {
    h.els.brokenDeleteBtn.dispatch("click");
    assert.deepEqual(h.names(), ["deleteCurrent"]);
  });
});

test("the broken banner buttons never reach the save path", () => {
  withHarness((h) => {
    h.els.brokenExportBtn.dispatch("click");
    h.els.brokenDeleteBtn.dispatch("click");
    assert.ok(
      !h.names().includes("saveNow"),
      "a broken entry must never be written back"
    );
    assert.ok(
      !h.names().includes("scheduleSave"),
      "a broken entry must never schedule an autosave"
    );
  });
});

test("the broken tab is optional so an older DOM still wires up", () => {
  // `wiring.js` guards the new bindings with `if (els.viewBroken)`. Dropping
  // the element must not throw, and must not register a stray listener.
  const h = harness();
  try {
    delete h.els.viewBroken;
    delete h.els.brokenExportBtn;
    delete h.els.brokenDeleteBtn;
    h.cleanup();
    assert.deepEqual(h.names(), []);
  } finally {
    h.restore();
  }
});
