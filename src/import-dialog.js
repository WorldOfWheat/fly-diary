// ---------------------------------------------------------------------------
// Import dialog
// ---------------------------------------------------------------------------
//
// Importing a folder of plain-text diaries is a three-step flow: pick a folder,
// preview what the scan found, then write the confirmed dates. The dialog stays
// open across all three steps and turns into a result view at the end.
//
// The module owns the scan result and the "finished" flag; everything else is
// injected, so the whole flow can be driven from a test with a fake `invoke`.
//
// `deps` shape:
//
//   els         — the lookup table from `dom.js`
//   invoke      — (command: string, args?: object) => Promise<any>
//   listen      — (event: string, handler: Function) => Promise<Function>
//   t           — (key: string, params?: object) => string
//   setStatus   — (text: string, saved?: boolean) => void
//   refreshList — () => Promise<void>

/** Badge label for each import status, resolved at render time. */
const IMPORT_BADGE_KEYS = {
  ready: "import.statReady",
  conflict: "import.statConflict",
  failed: "import.statFailed",
};

/**
 * Create the import dialog controller.
 *
 * Returns the functions `main.js` and `wiring.js` need. The scan result and the
 * finished flag live in the closure.
 */
export function createImportDialog(deps) {
  const { els } = deps;

  /** Result of the last scan, or `null` when the dialog is closed. */
  let importScan = null;
  /** Whether the last import finished, so the footer switches to "close". */
  let importDone = false;

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
    title.textContent = file.title || deps.t("common.untitled");
    title.title = file.title || "";

    const badge = document.createElement("span");
    badge.className = "row-badge";
    const badgeKey = IMPORT_BADGE_KEYS[file.status];
    badge.textContent = badgeKey ? deps.t(badgeKey) : file.status;

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
      empty.textContent = deps.t("import.emptyFolder");
      els.importList.replaceChildren(empty);
    } else {
      const frag = document.createDocumentFragment();
      for (const file of scan.files) frag.appendChild(createImportRow(file));
      els.importList.replaceChildren(frag);
    }

    els.importConfirm.textContent = deps.t("sidebar.import");
    els.importConfirm.disabled = scan.ready === 0 && scan.conflicts === 0;
    els.importCancel.textContent = deps.t("common.cancel");
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
    els.importConfirm.textContent = deps.t("sidebar.import");
    els.importCancel.textContent = deps.t("common.cancel");

    const loading = document.createElement("div");
    loading.className = "import-row";
    loading.textContent = deps.t("import.scanning");
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

  function isImportDone() {
    return importDone;
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
      dir = await deps.invoke("pick_import_dir");
    } catch (err) {
      console.error("pick_import_dir failed:", err);
      deps.setStatus(deps.t("import.errPicker"));
      return;
    }
    if (!dir) return;

    showImportLoading(dir);
    try {
      const scan = await deps.invoke("scan_import", { importDir: dir });
      renderImportScan(scan);
    } catch (err) {
      console.error("scan_import failed:", err);
      els.importList.replaceChildren();
      els.importError.textContent =
        typeof err === "string" ? err : deps.t("import.errScan");
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
      els.importError.textContent = deps.t("import.errNothing");
      return;
    }

    els.importConfirm.disabled = true;
    els.importConfirm.textContent = deps.t("import.progress");
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
      unlisten = await deps.listen("import-progress", onProgress);
    } catch (err) {
      // Progress is cosmetic; the import still works without it.
      console.warn("import-progress listener failed:", err);
    }

    try {
      const report = await deps.invoke("run_import", {
        importDir: importScan.dir,
        dates,
        overwrite,
      });
      renderImportReport(report);
      await deps.refreshList();
    } catch (err) {
      console.error("run_import failed:", err);
      els.importError.textContent =
        typeof err === "string" ? err : deps.t("import.errImport");
      els.importConfirm.disabled = false;
      els.importConfirm.textContent = deps.t("sidebar.import");
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
      lines.push(
        deps.t("import.reportImported", { count: report.imported.length })
      );
    }
    if (report.skipped.length > 0) {
      lines.push(
        deps.t("import.reportSkipped", { count: report.skipped.length })
      );
    }
    if (report.failed.length > 0) {
      lines.push(deps.t("import.reportFailed", { count: report.failed.length }));
    }
    if (lines.length === 0) {
      lines.push(deps.t("import.reportNoChange"));
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
    els.importConfirm.textContent = deps.t("common.done");
    els.importCancel.textContent = deps.t("common.close");
    els.importOverwriteRow.hidden = true;

    deps.setStatus(
      deps.t("import.statusImported", { count: report.imported.length }),
      true
    );
  }

  /**
   * Redraw the dialog after a language switch.
   *
   * Only an unfinished scan is rebuilt: a finished report is a record of what
   * happened, and re-rendering it would need the report object again.
   */
  function refreshForLocale() {
    if (importScan && !importDone) renderImportScan(importScan);
  }

  return {
    startImport,
    confirmImport,
    closeImport,
    isImportOpen,
    isImportDone,
    renderImportScan,
    renderImportReport,
    setImportProgress,
    hideImportProgress,
    refreshForLocale,
  };
}
