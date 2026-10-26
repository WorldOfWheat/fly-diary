// ---------------------------------------------------------------------------
// Import dialog tests
// ---------------------------------------------------------------------------
//
// The import flow is a three-step state machine: pick a folder, preview the
// scan, then write the confirmed dates and show the report. The module owns the
// scan result and the "finished" flag, so the tests drive the whole flow with a
// fake `invoke` and assert on the DOM the dialog produces.
//
// The cases worth pinning down are the ones that decide *what gets written*:
// which statuses are included, and whether conflicts are only included when the
// user ticked the overwrite box.

import test from "node:test";
import assert from "node:assert/strict";

import { createImportDialog } from "../src/import-dialog.js";
import { installDom, fakeEls, fakeT, fakeInvoke, spy } from "./helpers/dom.js";

const IMPORT_IDS = [
  "importOverlay",
  "importDir",
  "importReady",
  "importConflicts",
  "importFailed",
  "importOverwriteRow",
  "importOverwrite",
  "importList",
  "importProgress",
  "importProgressBar",
  "importProgressCount",
  "importProgressTrack",
  "importResult",
  "importError",
  "importConfirm",
  "importCancel",
];

/** A scan with one ready file, one conflict and one failure. */
const SCAN = {
  dir: "/tmp/diary",
  ready: 1,
  conflicts: 1,
  failed: 1,
  files: [
    {
      name: "2026-10-01.txt",
      date: "2026-10-01",
      title: "One",
      status: "ready",
    },
    {
      name: "2026-10-02.txt",
      date: "2026-10-02",
      title: "Two",
      status: "conflict",
      reason: "already exists",
    },
    {
      name: "notes.txt",
      date: null,
      title: "",
      status: "failed",
      reason: "no date in the name",
    },
  ],
};

/** Build an import controller plus the fakes it needs. */
function harness(overrides = {}) {
  const restore = installDom();
  const els = fakeEls(IMPORT_IDS);
  els.importOverlay.hidden = true;
  els.importOverwrite.checked = false;

  const invoke = fakeInvoke({
    pick_import_dir: "/tmp/diary",
    scan_import: SCAN,
    run_import: { imported: [], skipped: [], failed: [] },
    ...(overrides.invokeTable ?? {}),
  });

  const deps = {
    els,
    invoke,
    listen: async () => () => {},
    t: fakeT(),
    setStatus: spy(),
    refreshList: spy(async () => {}),
    ...overrides.deps,
  };

  return {
    els,
    deps,
    invoke,
    dialog: createImportDialog(deps),
    restore,
  };
}

async function withImport(body, overrides) {
  const h = harness(overrides);
  try {
    return await body(h);
  } finally {
    h.restore();
  }
}

// ---------------------------------------------------------------------------
// Open state
// ---------------------------------------------------------------------------

test("isImportOpen reflects the overlay's hidden flag", () => {
  withImport(({ dialog, els }) => {
    els.importOverlay.hidden = true;
    assert.equal(dialog.isImportOpen(), false);

    els.importOverlay.hidden = false;
    assert.equal(dialog.isImportOpen(), true);
  });
});

test("isImportDone is false until a report is rendered", () => {
  withImport(({ dialog }) => {
    assert.equal(dialog.isImportDone(), false);
  });
});

test("closeImport hides the dialog and clears the finished flag", async () => {
  await withImport(async ({ dialog, els }) => {
    dialog.renderImportScan(SCAN);
    dialog.renderImportReport({
      imported: ["2026-10-01"],
      skipped: [],
      failed: [],
    });
    assert.equal(dialog.isImportDone(), true);

    dialog.closeImport();

    assert.equal(els.importOverlay.hidden, true);
    assert.equal(dialog.isImportDone(), false);
  });
});

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

test("startImport shows a loading state, then the preview", async () => {
  await withImport(async ({ dialog, els }) => {
    await dialog.startImport();

    assert.equal(els.importOverlay.hidden, false);
    assert.equal(els.importDir.textContent, "/tmp/diary");
    assert.equal(els.importReady.textContent, "1");
    assert.equal(els.importConflicts.textContent, "1");
    assert.equal(els.importFailed.textContent, "1");
  });
});

test("startImport does nothing when the picker is cancelled", async () => {
  await withImport(
    async ({ dialog, els, invoke }) => {
      await dialog.startImport();

      assert.equal(els.importOverlay.hidden, true);
      assert.deepEqual(invoke.commands(), ["pick_import_dir"]);
    },
    { invokeTable: { pick_import_dir: null } }
  );
});

test("startImport reports a picker failure through the status line", async () => {
  await withImport(
    async ({ dialog, deps }) => {
      await dialog.startImport();

      assert.deepEqual(deps.setStatus.args(), [["import.errPicker"]]);
    },
    {
      invokeTable: {
        pick_import_dir: () => {
          throw "no dialog";
        },
      },
    }
  );
});

test("startImport reports a scan failure in the dialog", async () => {
  await withImport(
    async ({ dialog, els }) => {
      await dialog.startImport();

      assert.equal(els.importError.textContent, "disk error");
      assert.equal(els.importList.children.length, 0);
    },
    {
      invokeTable: {
        scan_import: () => {
          throw "disk error";
        },
      },
    }
  );
});

test("startImport uses a generic message for a non-string scan error", async () => {
  await withImport(
    async ({ dialog, els }) => {
      await dialog.startImport();
      assert.equal(els.importError.textContent, "import.errScan");
    },
    {
      invokeTable: {
        scan_import: () => {
          throw new Error("boom");
        },
      },
    }
  );
});

// ---------------------------------------------------------------------------
// Preview rendering
// ---------------------------------------------------------------------------

test("renderImportScan shows one row per file", async () => {
  await withImport(async ({ dialog, els }) => {
    dialog.renderImportScan(SCAN);

    const rows = els.importList.byClass("import-row");
    assert.equal(rows.length, 3);
    assert.deepEqual(
      rows.map((row) => row.className),
      ["import-row ready", "import-row conflict", "import-row failed"]
    );
  });
});

test("renderImportScan shows the date, the title and a badge", async () => {
  await withImport(async ({ dialog, els }) => {
    dialog.renderImportScan(SCAN);

    const [ready] = els.importList.byClass("import-row");
    assert.equal(ready.byClass("row-date")[0].textContent, "2026-10-01");
    assert.equal(ready.byClass("row-title")[0].textContent, "One");
    assert.equal(ready.byClass("row-badge")[0].textContent, "import.statReady");
  });
});

test("renderImportScan falls back to the file name when there is no date", async () => {
  await withImport(async ({ dialog, els }) => {
    dialog.renderImportScan(SCAN);

    const failed = els.importList.byClass("import-row failed")[0];
    assert.equal(failed.byClass("row-date")[0].textContent, "notes.txt");
  });
});

test("renderImportScan marks an untitled file and uses the untitled label", async () => {
  await withImport(async ({ dialog, els }) => {
    dialog.renderImportScan(SCAN);

    const failed = els.importList.byClass("import-row failed")[0];
    const title = failed.byClass("row-title")[0];
    assert.equal(title.textContent, "common.untitled");
    assert.ok(title.classList.contains("empty"));
  });
});

test("renderImportScan adds a reason line for conflicts and failures", async () => {
  await withImport(async ({ dialog, els }) => {
    dialog.renderImportScan(SCAN);

    const reasons = els.importList.byClass("row-reason");
    assert.deepEqual(
      reasons.map((reason) => reason.textContent),
      ["already exists", "no date in the name"]
    );
  });
});

test("renderImportScan shows the overwrite switch only when there are conflicts", async () => {
  await withImport(async ({ dialog, els }) => {
    dialog.renderImportScan(SCAN);
    assert.equal(els.importOverwriteRow.hidden, false);

    dialog.renderImportScan({ ...SCAN, conflicts: 0, files: [] });
    assert.equal(els.importOverwriteRow.hidden, true);
  });
});

test("renderImportScan resets the overwrite checkbox", async () => {
  await withImport(async ({ dialog, els }) => {
    els.importOverwrite.checked = true;
    dialog.renderImportScan(SCAN);
    assert.equal(els.importOverwrite.checked, false);
  });
});

test("renderImportScan disables Confirm when there is nothing to write", async () => {
  await withImport(async ({ dialog, els }) => {
    dialog.renderImportScan({ ...SCAN, ready: 0, conflicts: 0, files: [] });
    assert.equal(els.importConfirm.disabled, true);
  });
});

test("renderImportScan enables Confirm when a conflict could be overwritten", async () => {
  await withImport(async ({ dialog, els }) => {
    dialog.renderImportScan({ ...SCAN, ready: 0, conflicts: 1 });
    assert.equal(els.importConfirm.disabled, false);
  });
});

test("renderImportScan shows a message for an empty folder", async () => {
  await withImport(async ({ dialog, els }) => {
    dialog.renderImportScan({
      ...SCAN,
      ready: 0,
      conflicts: 0,
      failed: 0,
      files: [],
    });

    assert.equal(els.importList.children.length, 1);
    assert.equal(els.importList.children[0].textContent, "import.emptyFolder");
  });
});

test("renderImportScan clears the previous result and error", async () => {
  await withImport(async ({ dialog, els }) => {
    els.importResult.hidden = false;
    els.importError.textContent = "stale";

    dialog.renderImportScan(SCAN);

    assert.equal(els.importResult.hidden, true);
    assert.equal(els.importResult.children.length, 0);
    assert.equal(els.importError.textContent, "");
  });
});

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

test("setImportProgress shows the bar and the count", async () => {
  await withImport(async ({ dialog, els }) => {
    dialog.setImportProgress(3, 10);

    assert.equal(els.importProgress.hidden, false);
    assert.equal(els.importProgressBar.style.props.get("width"), "30%");
    assert.equal(els.importProgressCount.textContent, "3 / 10");
    assert.equal(els.importProgressTrack.getAttribute("aria-valuenow"), "30");
  });
});

test("setImportProgress clamps the percentage at 100", async () => {
  await withImport(async ({ dialog, els }) => {
    dialog.setImportProgress(12, 10);
    assert.equal(els.importProgressBar.style.props.get("width"), "100%");
  });
});

test("setImportProgress survives a zero total", async () => {
  await withImport(async ({ dialog, els }) => {
    dialog.setImportProgress(0, 0);
    assert.equal(els.importProgressBar.style.props.get("width"), "0%");
    assert.equal(els.importProgressCount.textContent, "0 / 0");
  });
});

test("hideImportProgress resets the bar", async () => {
  await withImport(async ({ dialog, els }) => {
    dialog.setImportProgress(5, 10);
    dialog.hideImportProgress();

    assert.equal(els.importProgress.hidden, true);
    assert.equal(els.importProgressBar.style.props.get("width"), "0%");
    assert.equal(els.importProgressCount.textContent, "0 / 0");
    assert.equal(els.importProgressTrack.getAttribute("aria-valuenow"), "0");
  });
});

// ---------------------------------------------------------------------------
// Confirming
// ---------------------------------------------------------------------------

test("confirmImport does nothing without a scan", async () => {
  await withImport(async ({ dialog, invoke }) => {
    await dialog.confirmImport();
    assert.deepEqual(invoke.commands(), []);
  });
});

test("confirmImport writes only the ready dates by default", async () => {
  await withImport(async ({ dialog, invoke }) => {
    dialog.renderImportScan(SCAN);
    await dialog.confirmImport();

    assert.deepEqual(invoke.argsOf("run_import"), {
      importDir: "/tmp/diary",
      dates: ["2026-10-01"],
      overwrite: false,
    });
  });
});

test("confirmImport includes conflicts when overwrite is ticked", async () => {
  await withImport(async ({ dialog, els, invoke }) => {
    dialog.renderImportScan(SCAN);
    els.importOverwrite.checked = true;

    await dialog.confirmImport();

    assert.deepEqual(invoke.argsOf("run_import").dates, [
      "2026-10-01",
      "2026-10-02",
    ]);
    assert.equal(invoke.argsOf("run_import").overwrite, true);
  });
});

test("confirmImport refuses when nothing would be written", async () => {
  await withImport(async ({ dialog, els, invoke }) => {
    dialog.renderImportScan({ ...SCAN, ready: 0, conflicts: 1, files: [] });
    await dialog.confirmImport();

    assert.equal(els.importError.textContent, "import.errNothing");
    assert.equal(invoke.commands().includes("run_import"), false);
  });
});

test("confirmImport shows progress and disables the button while running", async () => {
  await withImport(async ({ dialog, els }) => {
    dialog.renderImportScan(SCAN);
    let disabledDuring = null;
    let labelDuring = null;

    const invoke = fakeInvoke({
      run_import: () => {
        disabledDuring = els.importConfirm.disabled;
        labelDuring = els.importConfirm.textContent;
        return { imported: ["2026-10-01"], skipped: [], failed: [] };
      },
    });
    const local = createImportDialog({ ...importDeps(els), invoke });

    local.renderImportScan(SCAN);
    await local.confirmImport();

    assert.equal(disabledDuring, true);
    assert.equal(labelDuring, "import.progress");
  });
});

test("confirmImport renders the report and refreshes the list", async () => {
  await withImport(
    async ({ dialog, els, deps }) => {
      dialog.renderImportScan(SCAN);
      await dialog.confirmImport();

      assert.equal(els.importResult.hidden, false);
      assert.equal(dialog.isImportDone(), true);
      assert.equal(deps.refreshList.count(), 1);
      assert.deepEqual(deps.setStatus.args(), [
        ["import.statusImported(count=2)", true],
      ]);
    },
    {
      invokeTable: {
        run_import: {
          imported: ["2026-10-01", "2026-10-02"],
          skipped: [],
          failed: [],
        },
      },
    }
  );
});

test("confirmImport reports a failure and restores the button", async () => {
  await withImport(
    async ({ dialog, els }) => {
      dialog.renderImportScan(SCAN);
      await dialog.confirmImport();

      assert.equal(els.importError.textContent, "write failed");
      assert.equal(els.importConfirm.disabled, false);
      assert.equal(els.importConfirm.textContent, "sidebar.import");
      assert.equal(els.importProgress.hidden, true);
    },
    {
      invokeTable: {
        run_import: () => {
          throw "write failed";
        },
      },
    }
  );
});

test("confirmImport uses a generic message for a non-string import error", async () => {
  await withImport(
    async ({ dialog, els }) => {
      dialog.renderImportScan(SCAN);
      await dialog.confirmImport();
      assert.equal(els.importError.textContent, "import.errImport");
    },
    {
      invokeTable: {
        run_import: () => {
          throw new Error("boom");
        },
      },
    }
  );
});

test("confirmImport still imports when the progress listener fails", async () => {
  await withImport(
    async ({ dialog, invoke }) => {
      dialog.renderImportScan(SCAN);
      await dialog.confirmImport();

      assert.equal(invoke.commands().includes("run_import"), true);
    },
    {
      deps: {
        listen: async () => {
          throw "no event bus";
        },
      },
    }
  );
});

test("confirmImport forwards progress events to the bar", async () => {
  let handler = null;
  await withImport(
    async ({ dialog, els }) => {
      dialog.renderImportScan(SCAN);
      await dialog.confirmImport();

      // The listener was captured; fire it as the backend would.
      handler({ payload: { done: 1, total: 2 } });
      assert.equal(els.importProgressCount.textContent, "1 / 2");
    },
    {
      deps: {
        listen: async (event, fn) => {
          handler = fn;
          return () => {};
        },
      },
    }
  );
});

test("confirmImport ignores malformed progress events", async () => {
  let handler = null;
  await withImport(
    async ({ dialog, els }) => {
      dialog.renderImportScan(SCAN);
      await dialog.confirmImport();
      const before = els.importProgressCount.textContent;

      handler({ payload: { done: "1" } });
      handler({});
      handler({ payload: null });

      assert.equal(els.importProgressCount.textContent, before);
    },
    {
      deps: {
        listen: async (event, fn) => {
          handler = fn;
          return () => {};
        },
      },
    }
  );
});

test("confirmImport unsubscribes from the progress event", async () => {
  const unlisten = spy();
  await withImport(
    async ({ dialog }) => {
      dialog.renderImportScan(SCAN);
      await dialog.confirmImport();
      assert.equal(unlisten.count(), 1);
    },
    { deps: { listen: async () => unlisten } }
  );
});

// ---------------------------------------------------------------------------
// Report rendering
// ---------------------------------------------------------------------------

test("renderImportReport lists imported, skipped and failed counts", () => {
  withImport(({ dialog, els }) => {
    dialog.renderImportReport({
      imported: ["a", "b"],
      skipped: ["c"],
      failed: [{ name: "d.txt", reason: "bad" }],
    });

    const lines = els.importResult.byClass("result-line");
    assert.deepEqual(
      lines.map((line) => line.textContent),
      [
        "import.reportImported(count=2)",
        "import.reportSkipped(count=1)",
        "import.reportFailed(count=1)",
      ]
    );
  });
});

test("renderImportReport lists each failure with its reason", () => {
  withImport(({ dialog, els }) => {
    dialog.renderImportReport({
      imported: [],
      skipped: [],
      failed: [{ name: "d.txt", reason: "bad date" }],
    });

    const failures = els.importResult.byClass("result-fail");
    assert.equal(failures.length, 1);
    assert.equal(failures[0].textContent, "d.txt：bad date");
  });
});

test("renderImportReport says so when nothing changed", () => {
  withImport(({ dialog, els }) => {
    dialog.renderImportReport({ imported: [], skipped: [], failed: [] });

    const lines = els.importResult.byClass("result-line");
    assert.deepEqual(
      lines.map((line) => line.textContent),
      ["import.reportNoChange"]
    );
  });
});

test("renderImportReport switches the footer to Close", () => {
  withImport(({ dialog, els }) => {
    dialog.renderImportReport({ imported: ["a"], skipped: [], failed: [] });

    assert.equal(els.importConfirm.textContent, "common.done");
    assert.equal(els.importCancel.textContent, "common.close");
    assert.equal(els.importOverwriteRow.hidden, true);
    assert.equal(els.importList.children.length, 0);
    assert.equal(els.importProgress.hidden, true);
  });
});

// ---------------------------------------------------------------------------
// Locale refresh
// ---------------------------------------------------------------------------

test("refreshForLocale re-renders an unfinished scan", async () => {
  await withImport(async ({ dialog, els }) => {
    dialog.renderImportScan(SCAN);
    els.importDir.textContent = "stale";

    dialog.refreshForLocale();

    assert.equal(els.importDir.textContent, "/tmp/diary");
  });
});

test("refreshForLocale leaves a finished report alone", async () => {
  await withImport(async ({ dialog, els }) => {
    dialog.renderImportScan(SCAN);
    dialog.renderImportReport({ imported: ["a"], skipped: [], failed: [] });
    els.importDir.textContent = "report";

    dialog.refreshForLocale();

    assert.equal(els.importDir.textContent, "report");
  });
});

test("refreshForLocale does nothing when the dialog was never opened", () => {
  withImport(({ dialog, els }) => {
    els.importDir.textContent = "untouched";
    dialog.refreshForLocale();
    assert.equal(els.importDir.textContent, "untouched");
  });
});

/** Shared deps for the tests that build a second controller. */
function importDeps(els) {
  return {
    els,
    listen: async () => () => {},
    t: fakeT(),
    setStatus: spy(),
    refreshList: spy(async () => {}),
  };
}
