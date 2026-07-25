# Cross-Window Proposal Bridge

Audience: coding agents. Purpose: understand how AI edit proposals flow from Panel to Editor.

## Architecture

The Panel AI generates file edit proposals via the `edit` and `create` tools. These tools return `{ status: 'pending_review' }` immediately and emit a proposal via `context.onProposal()`. The proposal is registered with the Rust proposal coordinator, mirrored into Panel session state for rendering/persistence, and broadcast to Editor windows for optional diff review.

Rust owns the runtime proposal lifecycle. Panel and Editor are clients: they call `proposal_apply`, `proposal_reject`, or `proposal_respond`, and Rust broadcasts proposal state back to both surfaces.

```txt
Panel: AI tool returns pending_review, emits onProposal
  -> Panel invokes proposal_create
  -> Rust stores proposal and broadcasts mim://proposals-state
  -> Panel mirrors proposal into sessions[].proposals
  -> Editor receives pending proposal list via mim://proposals-changed

Panel: user clicks Accept in ProposalActionBar
  -> invoke('proposal_apply', { id })
  -> Rust sets status applying
  -> Rust resolves target owner
     -> direct file path: validate/apply/write/notify
     -> active dirty editor buffer or @editor: delegate via mim://proposal-apply
     -> inactive dirty editor buffer: conflict
  -> Rust broadcasts final status

Panel: user clicks Review in ProposalActionBar
  -> invoke('diff_open', { path, original, modified })
  -> Rust emits 'mim://diff-open' to editor windows
  -> Editor opens diff view (accept/reject from DiffBar)
  -> Editor invokes 'proposal_respond'
  -> Panel receives 'mim://proposal-result'
  -> Panel updates proposal status
```

## Proposal Lifecycle

```txt
pending -> applying -> accepted
       \          \-> stale
       \          \-> conflict
       \          \-> failed
       \-> accepted
       \-> rejected
       \-> stale
       \-> conflict
       \-> failed
```

- `pending`: tool returned `pending_review`, proposal shown in Panel chat
- `applying`: Panel accept is in progress
- `accepted`: user accepted in Panel or Editor, or Rust detected the proposal was already applied
- `rejected`: user rejected in Panel or Editor
- `stale`: target text no longer exists and replacement is not already present
- `conflict`: proposal cannot be applied unambiguously, including ambiguous target text, existing create target with different content, or inactive dirty editor owner
- `failed`: apply failed for infrastructure or I/O reasons

## Proposal Data Shape

Created by `edit` tool (targeting `@editor`):

```js
{
  id: 'proposal_1715..._a3f2x',   // unique ID
  targetText: '...',               // text to find in document
  replacement: '...',              // text to insert
  rationale: '...',                // optional explanation
  createdAt: '2026-05-11T...',
  status: 'proposed',
}
```

Enriched by Panel chat store (`onProposal` in `src/stores/panel/chat.js`):

```js
{
  ...proposal,
  threadId: session.id,
  status: 'pending',
  path: 'current-document.md',
  failReason: undefined,          // set on failure
}
```

## Text Matching

Proposals use text matching, not character positions. `findTargetText(docText, targetText)` in `textMatch.js`:

1. Exact `indexOf` (common case — document unchanged since proposal)
2. Typographic regex fallback via `buildTypographicRegex` (handles LLM curly quotes, em-dashes, ellipsis normalization)
3. Returns `{ from, to }` or `null`

If the document has been edited and the target text no longer exists, the match fails and the Panel shows a "not found" error with a retry button.

## Rust Proposal Coordinator

All in `src-tauri/src/lib.rs`.

`proposal_create(app, state, proposal)`:
- Upserts a proposal into the coordinator store
- Broadcasts `mim://proposals-state` to Panel and pending `mim://proposals-changed` to Editor windows
- Called by `onProposal()` in `src/stores/panel/chat.js`

`proposal_apply(app, state, id)`:
- Sets proposal status to `applying`
- Resolves target ownership from the editor registry
- Applies directly for closed files and clean open files
- Delegates to the owning editor window for active dirty buffers and `@editor`/document proposals
- Marks stale/conflict/failed centrally and broadcasts state/result

`proposal_reject(app, state, id)`:
- Sets proposal status to `rejected`
- Broadcasts state/result

`proposal_respond(app, state, result)`:
- Completes delegated editor-buffer applies
- Maps `applied -> accepted`, `not-found -> stale`, `conflict -> conflict`, `rejected -> rejected`
- Broadcasts state and forwards `mim://proposal-result` for Panel compatibility

`proposal_register_editor(state, window_label, documents)`:
- Editors publish open document ownership: `{ path, dirty, active }`
- Dirty inactive matching files become conflicts rather than direct writes

`proposal_list(state)`:
- Returns the current coordinator proposal list

`diff_open(app, payload)`:
- Emits `mim://diff-open` to editor windows
- Supports single-file payload (`{ id, path, original, modified, ... }`) and batch payload (`{ batch: true, files: [...] }`)
- Used by `reviewProposal()` (single file) and `openBatchReview()` (batch) in Panel

Legacy compatibility:

`push_proposals(app, state, proposals)`:
- Upserts/restores pending proposals from persisted Panel sessions
- Broadcasts state after sync

`get_proposals_for_path(state, path)`:
- Returns pending proposals matching `path` or `absolutePath`
- Called by Editor `App.vue` on tab switch (`checkProposalsForFile`)

Panel sync (`syncProposalsToRust` in `src/stores/panel/sessions.js`):
- Kept for session restore/backward compatibility
- New runtime proposals are created through `proposal_create`

Editor auto-diff (`src/editor/App.vue`):
- Listens for `mim://proposals-changed` — when proposals match the active file, stashes `reviews` on the file object and activates diff via `activateDiffFromReviews()`
- Watches `activeFileIndex` — queries Rust via `get_proposals_for_path` on tab switch
- When proposals are cleared from Rust (e.g. all accepted/rejected), auto-deactivates diff

Per-file review state:
- Files store a `reviews` array: `{ proposalId, sessionId, targetText, replacement, path, type }`
- Survives tab switches. Cleared on accept/reject or when Rust proposals no longer match

Important: Panel `sessions[].proposals` is now a mirror used for rendering and persistence. Runtime apply/reject decisions go through the Rust coordinator.

## JS Files

`src/shared/proposalEvents.js`
- Event name constants: `PROPOSAL_APPLY_EVENT`, `PROPOSAL_RESULT_EVENT`, `DIFF_OPEN_EVENT`
- Imported by both windows to prevent drift

`src/services/ai/tools/create.js` / `src/services/ai/tools/edit.js`
- `create` and `edit` tools. Return `{ status: 'pending_review' }` immediately, emit proposal via `context.onProposal()`

`src/stores/panel/chat.js`
- Enriches proposals with `threadId`, mirrors them into Panel state, and invokes `proposal_create`

`src/stores/panel/persistence.js`
- Listens for `mim://proposals-state` and upserts coordinator proposals into Panel session state
- Listens for `mim://proposal-result` for backward-compatible status updates

`src/panel/components/ChatView.vue`
- `applyProposal(proposal)`: invokes `proposal_apply`; it does not write proposal edits directly
- `rejectProposal(proposal)`: invokes `proposal_reject`
- `reviewProposal(proposal)`: invokes `diff_open` to open diff in Editor

`src/panel/components/ProposalActionBar.vue`
- Action bar exposes pending proposal commands: Reject All, Accept All, Review in Editor

`src/editor/App.vue`
- Registers open editor ownership through `proposal_register_editor`
- Listens for `mim://proposals-changed` and activates auto-diff for matching pending proposals

`src/editor/composables/useProposalBridge.js`
- Listens for `mim://diff-open` and activates diff view in Editor
- Listens for delegated `mim://proposal-apply` requests and responds via `proposal_respond`
- Handles four payload shapes: batch (array of files), file-edit review (targetText+replacement), legacy (pre-computed original/modified), single-file compute
- Normalizes proposal diff metadata to `reviewMeta.ids`
- Exports `computeDiffFromReview(review, fileContent)` — applies a single review to file content, returns `{ original, modified }` or null
- Exports `computeCompoundDiff(reviews, fileContent)` — applies multiple non-overlapping reviews to a single file
- `stashFileReviews(review)` callback persists review data on file objects for tab-switch survival
- Skips setup when `!window.__TAURI_INTERNALS__` (browser dev mode)
- Wired in `src/editor/App.vue`

`src/editor/composables/useDiffReview.js`
- Handles editor diff accept/reject for single, batch, inline-AI, and history review modes
- Proposal diff accept/reject and CodeMirror all-chunks-resolved paths invoke `proposal_respond`
- `proposalIdsFromReviewMeta()` accepts both legacy `{ id }` and normalized `{ ids }` metadata

`src/services/ai/tools/textMatch.js`
- `findTargetText(docText, targetText)`: exact match then typographic regex fallback

`src/services/ai/tools/edit.js`
- `edit` tool handles `@editor` target (open document proposals)

## Diff Review System

When the user clicks "Review" (single file) or "Review in Editor" (batch), the Panel opens a diff view in the Editor window. The diff system is independent of the proposal bridge — it can show any before/after text pair.

### Diff Store

`src/stores/diff.js` — Pinia store managing all diff UI state.

- `mode`: `'single'` or `'batch'`
- Single-file state: `originalContent`, `modifiedContent`, `filePath`, `proposalIds`, `reviewMeta`
- Batch state: `files` array — `{ path, original, modified, proposalId, status: 'pending'|'accepted'|'rejected' }`
- View controls: `viewMode` (`original`/`diff`/`result`), `layout` (`unified`/`split`), chunk navigation (`chunkCount`, `currentChunk`, `nextChunk`, `prevChunk`)
- Per-file actions: `acceptFile(path)`, `rejectFile(path)`, `resetFile(path)`, `acceptAllFiles()`, `rejectAllFiles()`
- Computed: `isBatch`, `pendingFiles`, `resolvedCount`, `allResolved`, `hasChunks`

### Line Delta Utility

`src/shared/lineDelta.js`:
- `computeLineDelta(originalText, modifiedText)` — LCS-based diff returning `{ added, removed }` line counts. Used by ProposalActionBar and BatchFileDiff for `+N / -M` display.
- `disambiguateFilenames(paths)` — produces minimal unique display names for a list of paths. Used by BatchDiffView.

### CM6 Merge Engine

`src/editor/codemirror/merge.js` — wraps `@codemirror/merge` (^6.12.1) with project-specific plugins.

- `createUnifiedDiffView({ parent, originalContent, modifiedContent, collapse, onAllResolved, onChunkCountChange })` — unified merge view via compartment with accept/revert controls, undo support (`invertedEffects`), and a `chunkWatcherPlugin` that fires callbacks on chunk count changes
- `createSplitDiffView(...)` — side-by-side `MergeView` with custom accept/reject buttons, `sideBySideChunkWatcher`, undo/redo via keyboard
- `createReadOnlyView({ parent, content })` — non-editable view for "Original" / "Result" modes
- `getUnifiedChunks(view)`, `getSplitChunks(mv)` — accessors for current chunk list
- Shared extensions: theme, syntax highlighting, markdown language, line numbers, line wrapping, history

### Components

`src/editor/components/workspace/DiffBar.vue`:
- Single-file mode: Original/Diff/Result toggle + Unified/Split layout toggle + chunk navigation (prev/next + "N of M") + Accept All / Reject All buttons
- Batch mode: file count + status dots (per file, colored by status) + prev/next pending navigation + resolved/total counter + global Accept All / Reject All

`src/editor/components/workspace/DiffView.vue`:
- Single-file diff renderer. Creates unified or split view via `merge.js` based on `diff.viewMode` and `diff.layout`. When CodeMirror reports all chunks resolved, `useDiffReview` applies the resolved content and responds to any linked proposal IDs.

`src/editor/components/workspace/BatchDiffView.vue`:
- Renders a scrollable list of `BatchFileDiff` components, one per file. Uses `disambiguateFilenames` for display names. Handles per-file accept/reject/reset.

`src/editor/components/workspace/BatchFileDiff.vue`:
- Single file within a batch: sticky header with filename + `+N / -M` delta + Accept/Reject/Undo buttons. Embeds a unified diff view. Visual states: pending, accepted (green), rejected (dimmed).

`src/panel/components/ProposalActionBar.vue`:
- Bottom-anchored action bar, shown only when pending proposals exist
- Actions: Reject All, Accept All, Review in Editor (emits `review` -> triggers `openBatchReview`)

### Diff CSS

`src/shared/styles/diff.css` — 273 lines of styling for merge views, chunk highlights, accept/reject buttons, batch file sections, and status colors.

### Wiring in App.vue

`src/editor/App.vue`:
- DiffBar replaces EditorToolbar when `diffStore.active` (single-file) or when `reviewTabActive` (batch)
- DiffView renders for single-file mode; BatchDiffView renders for batch mode when review tab is active
- Escape key closes diff (`diffStore.deactivate()`)
- Batch diff adds a "Review" tab to the tab strip via `displayTabs` computed. `reviewTabActive` ref controls whether the review tab or a normal file tab is shown. Closing the review tab deactivates batch diff.

### Panel Triggers

`src/panel/components/ChatView.vue`:

`reviewProposal(proposal)`:
- Opens/focuses editor window via `openOrFocusEditorWindow()`
- For file-edit proposals: reads current file content via `read_text_file`, computes modified via `findTargetText`, sends full payload
- For document proposals: sends `targetText` / `replacement` for editor-side computation
- `sendDiffOpen(invoke, payload)` retries up to 15 times (200ms apart) until `diff_open` reports `delivered`

`openBatchReview()`:
- Collects all `pending` proposals, opens editor, sends batch payload via `diff_open`
- For proposals with `absolutePath`: reads current file content from disk via `read_text_file`, computes modified content, sends precomputed `original`/`modified` in the payload
- Editor batch handler passes through precomputed diffs when present, falls back to document-based computation for proposals without them
- Payload: `{ batch: true, sessionId, files: [{ id, path, original, modified, ... }] }`

Proposal response handlers (`onDiffRejectAll`, `respondToDiffReview`, `onBatchAllResolved`) use `await Promise.allSettled()` to ensure all responses complete before proceeding.

### Tests

- `src/stores/diff.test.js` — diff store unit tests
- `src/editor/composables/useDiffReview.test.js` — proposal response regression tests for editor accept and CM6 chunk resolution
- `src/panel/components/ChatView.test.js` — Panel proposal apply regression tests
- `src/shared/lineDelta.test.js` — LCS delta + disambiguate tests
- `src/editor/components/workspace/DiffBar.test.js` — DiffBar smoke tests

## Edge Cases

| Case | Handling |
|------|----------|
| Editor not open | `proposal_apply` writes closed file targets directly from Rust |
| Active dirty editor buffer | `proposal_apply` delegates to owning editor window via `mim://proposal-apply` |
| Inactive dirty editor buffer | `proposal_apply` marks `conflict`; it does not write over unsaved editor state |
| Target text changed | direct apply marks `stale` unless the replacement is already present exactly once |
| Ambiguous target text | direct apply marks `conflict` |
| Multiple proposals | Each independent by `id` |
| Browser dev mode | Proposals stay Panel-local (no Tauri invoke) |
| Review without editor | Review button is a no-op if no editor window exists |

## Tauri Permissions

No changes needed. `core:event:default` (in `src-tauri/capabilities/default.json`) already includes `allow-emit`, `allow-emit-to`, `allow-listen`, `allow-unlisten` for all window labels.

## Future Work

- **Replace localStorage bridge**: The `mim:doc` prototype bridge (editor -> panel for `read` tool) should eventually use Tauri events. Separate concern from proposal bridge.
- **Policy/audit**: Proposal apply could go through a policy gate before writing.
