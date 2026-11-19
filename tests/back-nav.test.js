// ---------------------------------------------------------------------------
// Android back-button routing
// ---------------------------------------------------------------------------
//
// Android back must close the topmost DOM overlay rather than leaving the
// activity: leaving fires pagehide/visibilitychange and locks the diary, which
// made "exit settings" look like a logout.

import test from "node:test";
import assert from "node:assert/strict";

import { backButtonAction } from "../src/lib/back-nav.js";

test("back closes the attachment viewer before any other surface", () => {
  assert.equal(
    backButtonAction({
      attachmentViewer: true,
      recovery: true,
      settings: true,
      calendar: true,
    }),
    "closeAttachments"
  );
});

test("back closes the tar-import dialog above settings", () => {
  assert.equal(
    backButtonAction({ backupImport: true, recovery: true, settings: true }),
    "closeBackupImport"
  );
});

test("back closes the recovery dialog above settings", () => {
  assert.equal(
    backButtonAction({ recovery: true, settings: true, calendar: true }),
    "closeRecovery"
  );
});

test("back follows the dialog stack down to settings", () => {
  assert.equal(
    backButtonAction({ stats: true, importDialog: true, settings: true }),
    "closeStats"
  );
  assert.equal(
    backButtonAction({ importDialog: true, settings: true }),
    "closeImport"
  );
  assert.equal(backButtonAction({ settings: true }), "closeSettings");
});

test("back closes the calendar before leaving the editor layer", () => {
  assert.equal(
    backButtonAction({ calendar: true, phoneEditor: true }),
    "closeCalendar"
  );
  assert.equal(backButtonAction({ phoneEditor: true }), "showList");
});

test("back exits only when there is nothing left to close", () => {
  assert.equal(backButtonAction(), "exit");
  assert.equal(backButtonAction({ phoneEditor: false }), "exit");
});
