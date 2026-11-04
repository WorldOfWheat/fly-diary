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
//   canAttachImages     — () => boolean
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
function clipboardImages(clipboardData) {
  const files = [];
  const items = clipboardData?.items;
  if (items) {
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];
      if (item.kind !== "file") continue;
      const file = item.getAsFile?.();
      const type = item.type || file?.type || "";
      if (!type.startsWith("image/")) continue;
      if (file) files.push(file);
    }
  }
  const fallback = clipboardData?.files;
  if (files.length === 0 && fallback) {
    for (let i = 0; i < fallback.length; i += 1) {
      const file = fallback[i];
      if (file.type?.startsWith("image/")) files.push(file);
    }
  }
  return files;
}

function droppedFiles(dataTransfer) {
  const files = [];
  const list = dataTransfer?.files;
  if (!list) return files;
  for (let i = 0; i < list.length; i += 1) files.push(list[i]);
  return files;
}

/**
 * True for anything that looks like an operating-system file drag.
 *
 * Linux/WebKitGTK often advertises `text/uri-list` instead of `Files`, and may
 * only populate `dataTransfer.files` on the drop event. If we do not prevent
 * the default on `dragover`/`drop`, the webview navigates to the dropped file
 * and shows the image instead of letting the app handle it.
 */
function isFileDrag(dataTransfer) {
  if (!dataTransfer) return false;
  if ((dataTransfer.files?.length ?? 0) > 0) return true;
  const items = dataTransfer.items;
  if (items) {
    for (let i = 0; i < items.length; i += 1) {
      if (items[i]?.kind === "file") return true;
    }
  }
  const types = Array.from(dataTransfer.types ?? []);
  return types.includes("Files") || types.includes("text/uri-list");
}

export function initEventWiring(deps) {
  const { els } = deps;
  const cleanups = [];

  /** `addEventListener` that records how to undo itself. */
  const on = (target, type, handler, options) => {
    target.addEventListener(type, handler, options);
    cleanups.push(() => target.removeEventListener(type, handler, options));
  };

  // -------------------------------------------------------------------------
  // Stop the webview from navigating to dropped files
  // -------------------------------------------------------------------------
  //
  // With Tauri's native drag-drop handler disabled, a file dropped on the page
  // is handled by the webview itself. Unless both `dragover` and `drop` call
  // `preventDefault`, WebKitGTK opens the image (file:// navigation) instead of
  // letting the editor receive it. Guard at document level so dropping outside
  // the editor cannot navigate away either.
  const guardFileNavigation = (event) => {
    if (!isFileDrag(event.dataTransfer)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    if (event.type === "drop") {
      els.editor?.classList?.remove("is-dragover");
    }
  };
  on(document, "dragenter", guardFileNavigation, true);
  on(document, "dragover", guardFileNavigation, true);
  on(document, "drop", guardFileNavigation, true);

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

  // -------------------------------------------------------------------------
  // Image attachments
  // -------------------------------------------------------------------------

  if (els.attachmentAdd) on(els.attachmentAdd, "click", deps.pickAttachment);
  if (els.attachmentInput) {
    on(els.attachmentInput, "change", (event) =>
      deps.addAttachmentFiles(event.target.files)
    );
  }
  if (els.attachmentList) {
    on(els.attachmentList, "click", deps.handleAttachmentClick);
    on(els.attachmentList, "dragstart", deps.attachmentDragStart);
    on(els.attachmentList, "dragover", deps.attachmentDragOver);
    on(els.attachmentList, "drop", deps.attachmentDrop);
    on(els.attachmentList, "dragend", deps.attachmentDragEnd);
  }
  if (els.attachmentViewerClose) {
    on(els.attachmentViewerClose, "click", deps.closeAttachmentViewer);
  }
  if (els.attachmentViewerBackdrop) {
    on(els.attachmentViewerBackdrop, "click", deps.closeAttachmentViewer);
  }

  // Pasting or dropping an image anywhere in the editor attaches it to the
  // current day. Text paste and the gallery's internal reorder drag are left
  // alone: only real image files are intercepted.
  if (els.editor) {
    on(els.editor, "paste", (event) => {
      const files = clipboardImages(event.clipboardData);
      if (files.length === 0) return;
      // Only an image paste belongs to this feature. Text paste must keep
      // working normally, including in a read-only entry.
      event.preventDefault();
      if (!deps.canAttachImages?.()) {
        deps.onAttachmentBlocked?.(files);
        return;
      }
      deps.addAttachmentFiles(files);
    });

    on(els.editor, "dragover", (event) => {
      if (!isFileDrag(event.dataTransfer)) return;
      event.preventDefault();
      if (!deps.canAttachImages?.()) {
        if (event.dataTransfer) event.dataTransfer.dropEffect = "none";
        return;
      }
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
      els.editor.classList?.add("is-dragover");
    });

    on(els.editor, "dragleave", (event) => {
      if (els.editor.contains?.(event.relatedTarget)) return;
      els.editor.classList?.remove("is-dragover");
    });

    on(els.editor, "drop", (event) => {
      // Prevent the default first. If this is a `text/uri-list` drag without
      // File objects, there is nothing to attach yet, but the webview must not
      // navigate to the dropped file.
      if (!isFileDrag(event.dataTransfer)) return;
      event.preventDefault();
      els.editor.classList?.remove("is-dragover");

      const files = droppedFiles(event.dataTransfer);
      if (files.length === 0) return;
      if (!deps.canAttachImages?.()) {
        deps.onAttachmentBlocked?.(files);
        return;
      }
      deps.addAttachmentFiles(files);
    });
  }

  // The native input is hidden and only mirrors the selected date, so it never
  // fires `change` from user interaction. The calendar below is the real UI.
  on(els.dateLabel, "click", deps.toggleCalendar);

  // Phone layout only: the back button returns from the editor layer to the
  // list layer. Optional so an older DOM still wires up.
  if (els.backToList) on(els.backToList, "click", deps.showListLayer);

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
  // The header's unlock button is the only way out of the read-only state, so it
  // is wired here rather than inside `main.js`'s own event setup.
  if (els.editBtn) on(els.editBtn, "click", deps.unlockEntryForEditing);

  // The banner only exists for a locked entry, so its buttons are optional.
  if (els.brokenExportBtn) {
    on(els.brokenExportBtn, "click", () => deps.exportBrokenFile());
  }
  if (els.brokenDeleteBtn) {
    on(els.brokenDeleteBtn, "click", () => deps.deleteCurrent());
  }
  on(els.lockBtn, "click", deps.lockNow);

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

  // The vault-wide actions hosted by the settings dialog. Each one closes the
  // dialog before handing over, so only one overlay is ever on screen.
  on(els.settingsImportBtn, "click", deps.openImportFromSettings);
  on(els.settingsStatsBtn, "click", deps.openStatsFromSettings);
  on(els.settingsChangeDirBtn, "click", deps.changeDiaryDirFromSettings);

  // Statistics dialog.
  on(els.statsClose, "click", deps.closeStats);
  on(els.statsDone, "click", deps.closeStats);
  on(els.statsOverlay, "mousedown", (e) => {
    if (e.target === els.statsOverlay) deps.closeStats();
  });

  // Import dialog.
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

    // Undo/redo inside the editor. The native Edit menu now forwards these to
    // the webview, but the menu is not present on every platform build, and a
    // menu accelerator never reaches JS at all. Handling the chord here keeps
    // the behaviour identical everywhere, and only when the editor has focus —
    // elsewhere the browser default is the right thing.
    if (mod && !e.altKey && e.key.toLowerCase() === "z") {
      const field = e.target;
      const inEditor = field === els.title || field === els.content;
      if (inEditor && !field.disabled) {
        e.preventDefault();
        // Ctrl+Shift+Z is the conventional redo on Linux and macOS; Ctrl+Y is
        // handled by the webview itself on Windows.
        document.execCommand(e.shiftKey ? "redo" : "undo");
      }
      return;
    }

    // The lightbox is the topmost surface, so Escape closes it before any
    // dialog or the calendar.
    if (e.key === "Escape" && deps.isAttachmentViewerOpen?.()) {
      e.preventDefault();
      deps.closeAttachmentViewer();
      return;
    }

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
