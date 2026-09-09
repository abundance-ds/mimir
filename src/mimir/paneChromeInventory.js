/**
 * Every pane-level bar in the workbench, with the pane chrome kind it must
 * use. `PaneChrome.test.js` reads each file, finds the element that carries
 * `marker`, and fails when the element sizes or colours itself.
 *
 * Kinds (src/shared/styles/pane-chrome.css):
 *   pane-header        40 px, chrome, rule below. Row 1: pane and editor headers.
 *   pane-bar           36 px, chrome-high, rule below. Row 2: whatever a pane shows first.
 *   pane-subbar        28 px, chrome-high, rule-light below. Row 3: ledgers, view filters.
 *   pane-footer        26 px, chrome, rule above, mono 10 px. Status footers.
 *   pane-footer-input  min 36 px, chrome-high, rule above. Composer and dispatch bars.
 *
 * Kinds follow the row, not the role, so bars in neighbouring panes align.
 *
 * `cssClass` names the element's own scoped class; that block must not set
 * height, min-height, or background. `pending` marks a bar that is not yet
 * migrated; the test skips it.
 */
export const PANE_CHROME_KINDS = Object.freeze([
  'pane-header',
  'pane-bar',
  'pane-subbar',
  'pane-footer',
  'pane-footer-input',
])

export const PANE_CHROME_INVENTORY = Object.freeze([
  { file: 'mimir/components/WorkbenchSidebar.vue', marker: 'data-sidebar-header', kind: 'pane-header' },
  { file: 'mimir/components/PaneFrame.vue', marker: 'data-pane-header', kind: 'pane-header' },
  { file: 'editor/components/shell/AppHeader.vue', marker: 'data-editor-header', kind: 'pane-header' },

  { file: 'mimir/components/RailRestore.vue', marker: 'data-rail-header', kind: 'pane-header' },
  { file: 'mimir/components/RailRestore.vue', marker: 'data-rail-footer', kind: 'pane-footer' },
  { file: 'mimir/components/WorkbenchSidebar.vue', marker: 'data-sidebar-footer', kind: 'pane-footer' },

  { file: 'mimir/apps/business-graph/GraphAppHeader.vue', marker: 'data-graph-topbar', kind: 'pane-bar', cssClass: 'graph-topbar' },
  { file: 'mimir/apps/business-graph/GraphViewbar.vue', marker: 'data-graph-viewbar', kind: 'pane-subbar', cssClass: 'graph-viewbar' },
  { file: 'mimir/apps/business-graph/DispatchBar.vue', marker: 'data-graph-dispatch', kind: 'pane-footer-input', cssClass: 'dispatch-bar' },

  { file: 'editor/components/workspace/EditorToolbar.vue', marker: 'data-editor-toolbar', kind: 'pane-bar', cssClass: 'editor-toolbar' },
  { file: 'editor/components/workspace/ScratchpadBar.vue', marker: 'data-scratchpad-toolbar', kind: 'pane-bar' },
  { file: 'editor/components/shell/AppFooter.vue', marker: 'data-editor-footer', kind: 'pane-footer', cssClass: 'app-footer' },
  { file: 'editor/components/workspace/ImagePreview.vue', marker: 'data-image-toolbar', kind: 'pane-bar' },
  { file: 'editor/components/workspace/PdfPreview.vue', marker: 'data-pdf-toolbar', kind: 'pane-bar' },
  { file: 'mimir/components/FileHistoryPanel.vue', marker: 'data-file-history-toolbar', kind: 'pane-bar' },

  { file: 'mimir/activities/FilesActivity.vue', marker: 'data-files-toolbar', kind: 'pane-bar' },
  { file: 'mimir/activities/FilesActivity.vue', marker: 'data-files-ledger-status', kind: 'pane-subbar' },
  { file: 'mimir/activities/FilesActivity.vue', marker: 'data-files-ledger-columns', kind: 'pane-subbar' },
  { file: 'mimir/activities/FilesActivity.vue', marker: 'data-files-footer', kind: 'pane-footer' },

  { file: 'mimir/activities/RoutinesActivity.vue', marker: 'data-routines-footer', kind: 'pane-footer' },
  { file: 'mimir/apps/TrackerApp.vue', marker: 'data-tracker-rangebar', kind: 'pane-bar' },
  { file: 'mimir/apps/TodayApp.vue', marker: 'data-today-statusbar', kind: 'pane-footer' },
  { file: 'mimir/apps/ScribeApp.vue', marker: 'data-scribe-ledger', kind: 'pane-bar', cssClass: 'scribe-transport' },
  { file: 'mimir/apps/ScribeApp.vue', marker: 'data-scribe-detail-header', kind: 'pane-bar', cssClass: 'scribe-bar' },
  { file: 'mimir/apps/scribe/ScribeSettings.vue', marker: 'data-scribe-settings-header', kind: 'pane-bar' },
  { file: 'mimir/apps/EmbeddedAppHost.vue', marker: 'data-embedded-app-toolbar', kind: 'pane-bar' },
  { file: 'mimir/apps/LaunchPlanHost.vue', marker: 'data-launch-plan-header', kind: 'pane-bar' },
  { file: 'mimir/apps/LaunchPlanHost.vue', marker: 'data-launch-plan-footer', kind: 'pane-footer' },

  { file: 'mimir/activities/ChatActivity.vue', marker: 'data-chat-composer', kind: 'pane-footer-input' },
])

/** Surfaces that once drew their own identity header; they must not again. */
export const PANE_CHROME_NO_OWN_HEADER = Object.freeze([
  'mimir/activities/RoutinesActivity.vue',
  'mimir/apps/TrackerApp.vue',
])
