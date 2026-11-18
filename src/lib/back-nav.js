// ---------------------------------------------------------------------------
// Android back button routing
// ---------------------------------------------------------------------------
//
// The settings, stats, import, recovery, calendar and attachment-viewer
// surfaces are DOM overlays, not separate activities or routes. The WebView
// therefore has no history entry for them, and the default Android back action
// would leave the activity entirely. Leaving the activity triggers the
// suspend/pagehide lock in `main.js`, which looks like "closing settings logs
// me out".
//
// This pure helper decides what the back press should close, in the same order
// the layered UI is drawn: the attachment viewer is topmost, the recovery
// dialog can be opened above settings, and the settings overlay sits above the
// calendar. Only when nothing is open does the app fall through to `"exit"`.

/**
 * @typedef {object} BackState
 * @property {boolean} [attachmentViewer] The image lightbox is open.
 * @property {boolean} [backupImport] The encrypted tar import dialog is open.
 * @property {boolean} [recovery] The recovery-phrase dialog is open.
 * @property {boolean} [stats] The statistics dialog is open.
 * @property {boolean} [importDialog] The folder-import dialog is open.
 * @property {boolean} [settings] The settings dialog is open.
 * @property {boolean} [calendar] The month calendar is open.
 * @property {boolean} [phoneEditor] The phone layout is showing the editor.
 */

/**
 * Pick the action for one Android back press.
 *
 * @param {BackState} state
 * @returns {"closeAttachments"|"closeBackupImport"|"closeRecovery"|"closeStats"|"closeImport"|"closeSettings"|"closeCalendar"|"showList"|"exit"}
 */
export function backButtonAction(state = {}) {
  if (state.attachmentViewer) return "closeAttachments";
  if (state.backupImport) return "closeBackupImport";
  if (state.recovery) return "closeRecovery";
  if (state.stats) return "closeStats";
  if (state.importDialog) return "closeImport";
  if (state.settings) return "closeSettings";
  if (state.calendar) return "closeCalendar";
  if (state.phoneEditor) return "showList";
  return "exit";
}
