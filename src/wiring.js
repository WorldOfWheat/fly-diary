// ---------------------------------------------------------------------------
// Event wiring
// ---------------------------------------------------------------------------
//
// Every `addEventListener` call in the app lives here, so `main.js` stays a
// collection of behaviour instead of a pile of top-level statements.
//
// The module owns no state and imports nothing from `main.js`: it receives a
// `deps` object holding the callbacks and the few values it needs. That keeps
// it importable from a test with plain fakes, and it means the wiring can be
// inspected in one place when a shortcut stops working.
//
// `deps` shape (all functions unless noted):
//
//   els                 — the lookup table from `dom.js`
//   handleUnlockSubmit  — (event) => void
//   browseForDir        — () => void
//   openWorkspacePicker — () => void
//   cancelWorkspacePicker — () => void
//   resetKdfFields      — () => void
//   updateKdfEstimate   — () => void
//   refreshSetupVaultState — () => void
//   scheduleSave        — () => void
//   updateWordCount     — () => void
//   toggleCalendar      — () => void
//   stepCalendarMonth   — (months: number) => void
//   stepCalendarYear    — (years: number) => void
//   pickCalendarDate    — (iso: string) => void
//   moveCalendarFocus   — (days: number) => void
//   isCalendarOpen      — () => boolean
//   closeCalendar       — (options?: { restoreFocus?: boolean }) => void
//   selectDate          — (iso: string) => void
//   deleteCurrent       — () => void
//   toggleFavourite     — () => void
//   lockNow             — () => void
//   changeDiaryDir      — () => void
//   openSettings        — () => void
//   closeSettings       — () => void
//   saveSettings        — () => void
//   calibrateKdf        — () => void
//   openStats           — () => void
//   closeStats          — () => void
//   isStatsOpen         — () => boolean
//   setView             — (view: "all" | "favourites") => void
//   startImport         — () => void
//   closeImport         — () => void
//   confirmImport       — () => void
//   isImportOpen        — () => boolean
//   isImportDone        — () => boolean
//   setSearchQuery      — (query: string) => void
//   renderList          — () => void
//   renderVisibleRows   — (force?: boolean) => void
//   saveNow             — () => void
//   hasPendingSave      — () => boolean
//   clearPendingSave    — () => void
//   today               — () => Promise<string>
//   shiftDate           — (iso: string, days: number) => string
//   getCurrentDate      — () => string
//   monthStartOf        — (iso: string) => string
//   toISODate           — (date: Date) => string
//   setCalendarMonth    — (monthStart: string) => void
//   renderCalendar      — () => void
//   isInputSuppressed   — () => boolean

/**
 * Wire every DOM listener the app needs.
 *
 * Call once, after `init()` has resolved the initial state. Returns a cleanup
 * function that removes the listeners again; the app never uses it, but tests
 * do, and it makes the module honest about what it owns.
 */
export function initEventWiring(deps) {
  const { els } = deps;
  const cleanups = [];

  /** `addEventListener` that records how to undo itself. */
  const on = (target, type, handler, options) => {
    target.addEventListener(type, handler, options);
    cleanups.push(() => target.removeEventListener(type, handler, options));
  };

  // -------------------------------------------------------------------------
  // Lock screen
  // -------------------------------------------------------------------------

  on(els.lockForm, "submit", deps.handleUnlockSubmit);
  on(els.browseDir, "click", deps.browseForDir);
  on(els.switchWorkspace, "click", deps.openWorkspacePicker);
  on(els.cancelWorkspace, "click", deps.cancelWorkspacePicker);
  on(els.kdfReset, "click", deps.resetKdfFields);
  on(els.kdfMemory, "input", deps.updateKdfEstimate);
  on(els.kdfIterations, "input", deps.updateKdfEstimate);
  on(els.kdfParallelism, "input", deps.updateKdfEstimate);

  // Detect an existing vault as soon as the user edits the path, so a
  // returning user is switched to the unlock form instead of being asked to
  // create one.
  let pathDetectTimer = null;
  on(els.diaryDir, "input", () => {
    if (pathDetectTimer) clearTimeout(pathDetectTimer);
    pathDetectTimer = setTimeout(() => {
      pathDetectTimer = null;
      deps.refreshSetupVaultState();
    }, 350);
  });
  cleanups.push(() => {
    if (pathDetectTimer) clearTimeout(pathDetectTimer);
  });

  // -------------------------------------------------------------------------
  // Editor
  // -------------------------------------------------------------------------

  on(els.title, "input", () => {
    if (deps.isInputSuppressed()) return;
    deps.scheduleSave();
  });

  on(els.content, "input", () => {
    if (deps.isInputSuppressed()) return;
    deps.updateWordCount();
    deps.scheduleSave();
  });

  // The native input is hidden and only mirrors the selected date, so it never
  // fires `change` from user interaction. The calendar below is the real UI.
  on(els.dateLabel, "click", deps.toggleCalendar);

  on(els.prevDay, "click", () =>
    deps.selectDate(deps.shiftDate(deps.getCurrentDate(), -1))
  );
  on(els.nextDay, "click", () =>
    deps.selectDate(deps.shiftDate(deps.getCurrentDate(), 1))
  );

  on(els.newToday, "click", async () => {
    const today = await deps.today();
    await deps.selectDate(today);
  });

  on(els.deleteBtn, "click", deps.deleteCurrent);
  on(els.favouriteBtn, "click", deps.toggleFavourite);

  // The banner only exists for a locked entry, so its buttons are optional.
  if (els.brokenExportBtn) {
    on(els.brokenExportBtn, "click", () => deps.exportBrokenFile());
  }
  if (els.brokenDeleteBtn) {
    on(els.brokenDeleteBtn, "click", () => deps.deleteCurrent());
  }
  on(els.lockBtn, "click", deps.lockNow);
  on(els.changeDirBtn, "click", deps.changeDiaryDir);

  // -------------------------------------------------------------------------
  // Calendar overlay
  // -------------------------------------------------------------------------

  on(els.calPrev, "click", () => deps.stepCalendarMonth(-1));
  on(els.calNext, "click", () => deps.stepCalendarMonth(1));

  // The outer pair jumps a whole year. Optional so a stripped-down markup
  // without the year stepper still wires up.
  if (els.calPrevYear) {
    on(els.calPrevYear, "click", () => deps.stepCalendarYear(-1));
  }
  if (els.calNextYear) {
    on(els.calNextYear, "click", () => deps.stepCalendarYear(1));
  }

  // Clicking the month label jumps back to the month of the selected date.
  on(els.calMonth, "click", () => {
    deps.setCalendarMonth(
      deps.monthStartOf(deps.getCurrentDate() || deps.toISODate(new Date()))
    );
    deps.renderCalendar();
  });

  // The overlay covers the whole window, so it needs its own ways out: the
  // close button and a click on the backdrop around the panel.
  on(els.calClose, "click", () => deps.closeCalendar({ restoreFocus: true }));
  on(els.calendarBackdrop, "click", () =>
    deps.closeCalendar({ restoreFocus: true })
  );

  on(els.calToday, "click", async () => {
    const today = await deps.today();
    deps.pickCalendarDate(today);
  });

  on(els.calGrid, "click", (e) => {
    const cell = e.target.closest(".cal-day");
    if (cell) deps.pickCalendarDate(cell.dataset.date);
  });

  // Arrow keys move the focus ring, PageUp/PageDown flip the month.
  on(els.calGrid, "keydown", (e) => {
    const moves = {
      ArrowLeft: -1,
      ArrowRight: 1,
      ArrowUp: -7,
      ArrowDown: 7,
    };
    if (e.key in moves) {
      e.preventDefault();
      deps.moveCalendarFocus(moves[e.key]);
    } else if (e.key === "PageUp") {
      e.preventDefault();
      deps.stepCalendarMonth(-1);
    } else if (e.key === "PageDown") {
      e.preventDefault();
      deps.stepCalendarMonth(1);
    }
  });

  // Clicking anywhere outside the overlay dismisses it. The overlay covers the
  // window, so this only fires for the date pill itself, which toggles.
  on(document, "mousedown", (e) => {
    if (!deps.isCalendarOpen()) return;
    if (els.calendar.contains(e.target) || els.dateLabel.contains(e.target))
      return;
    deps.closeCalendar();
  });

  // -------------------------------------------------------------------------
  // Dialogs
  // -------------------------------------------------------------------------

  // Settings dialog.
  on(els.settingsBtn, "click", deps.openSettings);
  on(els.settingsClose, "click", deps.closeSettings);
  on(els.settingsCancel, "click", deps.closeSettings);
  on(els.settingsSave, "click", deps.saveSettings);
  on(els.settingsCalibrate, "click", deps.calibrateKdf);
  on(els.settingsOverlay, "mousedown", (e) => {
    if (e.target === els.settingsOverlay) deps.closeSettings();
  });

  // Statistics dialog.
  on(els.statsBtn, "click", deps.openStats);
  on(els.statsClose, "click", deps.closeStats);
  on(els.statsDone, "click", deps.closeStats);
  on(els.statsOverlay, "mousedown", (e) => {
    if (e.target === els.statsOverlay) deps.closeStats();
  });

  // Import dialog.
  on(els.importBtn, "click", deps.startImport);
  on(els.importClose, "click", deps.closeImport);
  on(els.importCancel, "click", deps.closeImport);
  on(els.importConfirm, "click", () => {
    // After a run the primary button just dismisses the result.
    if (deps.isImportDone()) deps.closeImport();
    else deps.confirmImport();
  });

  // Clicking the backdrop (but not the dialog itself) dismisses it.
  on(els.importOverlay, "mousedown", (e) => {
    if (e.target === els.importOverlay) deps.closeImport();
  });

  // -------------------------------------------------------------------------
  // Sidebar
  // -------------------------------------------------------------------------

  on(els.viewAll, "click", () => deps.setView("all"));
  on(els.viewFavourites, "click", () => deps.setView("favourites"));
  if (els.viewBroken) {
    on(els.viewBroken, "click", () => deps.setView("broken"));
  }

  on(els.search, "input", () => {
    deps.setSearchQuery(els.search.value);
    // A new filter changes the row count, so reset the scroll position.
    els.listScroll.scrollTop = 0;
    deps.renderList();
  });

  // Virtual scrolling: redraw the window as the user scrolls. `passive` keeps
  // the scroll smooth because the handler never calls `preventDefault()`.
  on(els.listScroll, "scroll", () => deps.renderVisibleRows(), {
    passive: true,
  });

  // The viewport height changes with the window, so the rendered window must be
  // recomputed.
  on(window, "resize", () => deps.renderVisibleRows(true));

  // -------------------------------------------------------------------------
  // Keyboard shortcuts
  // -------------------------------------------------------------------------

  on(document, "keydown", (e) => {
    const mod = e.ctrlKey || e.metaKey;

    if (e.key === "Escape" && deps.isStatsOpen()) {
      e.preventDefault();
      deps.closeStats();
      return;
    }

    if (e.key === "Escape" && deps.isImportOpen()) {
      e.preventDefault();
      deps.closeImport();
      return;
    }

    if (e.key === "Escape" && deps.isCalendarOpen()) {
      e.preventDefault();
      deps.closeCalendar({ restoreFocus: true });
      return;
    }

    if (mod && e.key.toLowerCase() === "l") {
      e.preventDefault();
      if (!els.app.hidden) deps.lockNow();
    } else if (els.app.hidden) {
      return;
    } else if (mod && e.key.toLowerCase() === "s") {
      e.preventDefault();
      if (deps.hasPendingSave()) deps.clearPendingSave();
      deps.saveNow();
    } else if (mod && e.key.toLowerCase() === "t") {
      e.preventDefault();
      els.newToday.click();
    } else if (mod && e.key.toLowerCase() === "d") {
      e.preventDefault();
      deps.toggleFavourite();
    } else if (e.altKey && e.key === "ArrowLeft") {
      e.preventDefault();
      deps.selectDate(deps.shiftDate(deps.getCurrentDate(), -1));
    } else if (e.altKey && e.key === "ArrowRight") {
      e.preventDefault();
      deps.selectDate(deps.shiftDate(deps.getCurrentDate(), 1));
    }
  });

  // Save before the window closes so nothing is lost.
  on(window, "beforeunload", () => {
    if (deps.hasPendingSave()) {
      deps.clearPendingSave();
      // Fire-and-forget; the webview may not wait, but autosave usually beats
      // it.
      deps.saveNow();
    }
  });

  return () => {
    for (const undo of cleanups) undo();
  };
}
