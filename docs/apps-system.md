# Apps System

Apps are developer-built programs that run inside mim terminal. They provide deterministic or semi-deterministic automation with a UI — unlike Skills, which augment the autonomous AI agent.

An app is installed globally at `~/.mim/apps/{appId}/`. Launching it creates an **app session** scoped to a project. App sessions appear in the sidebar alongside chat sessions and inherit the same lifecycle: status indicators, archive/done, persistence.

## Two UI Modes

| | Standard UI | Custom UI |
|---|---|---|
| Developer writes | `index.js` exporting `run(ctx)` | `index.html` + CSS + JS |
| mim terminal provides | Progress timeline (setup → steps → result) | Thin toolbar + iframe host |
| Runtime API | `ctx.*` (passed to `run()`) | `window.mim.*` (auto-injected SDK) |
| AI model access | Yes (`ctx.model.generate()`) | No |
| DOCX access | Yes (`ctx.docx.*`) | No |
| Progress reporting | Yes (`ctx.progress.*`) | No |
| Persistent data | Yes (`ctx.data.*`) | Yes (`mim.data.*`) |
| File system I/O | Read from app dir (`ctx.files.*`) | Full read/write (`mim.fs.*`) |
| External HTTP | Yes (`ctx.http.fetch()`) | Yes (`mim.http.fetch()`) |
| Native dialogs | No | Yes (`mim.ui.*`) |
| Use case | Multi-step AI processes | Interactive tools and SPAs |

## App Structure

```
~/.mim/apps/{appId}/
├── manifest.json          # required
├── index.js               # required for standard UI (exports run)
├── index.html             # required for custom UI (entry point)
├── style.css              # optional
├── app.js                 # optional
├── knowledge/             # optional — bundled reference data
│   ├── category-a/
│   │   ├── 00-foundation.md
│   │   ├── 01-topic.md
│   │   └── ...
│   └── category-b/
│       └── ...
├── agents/                # optional — sub-modules for standard UI
├── lib/                   # optional — shared utilities
├── prompts/               # optional — prompt templates
└── data/                  # auto-managed by runtime
    └── {projectId}/       # data scoped per project
        └── {key}.json
```

## Manifest

```json
{
  "id": "my-app",
  "name": "My App",
  "description": "What this app does",
  "icon": "📊",
  "ui": "standard",
  "permissions": ["model", "data", "docx", "knowledge"],
  "setup": {
    "fields": [
      { "id": "document", "type": "file", "label": "Document", "filters": [{ "name": "Word", "extensions": ["docx"] }] },
      { "id": "model", "type": "model", "label": "Model", "default": "claude-sonnet-4-6" },
      { "id": "notes", "type": "textarea", "label": "Instructions", "placeholder": "..." }
    ]
  }
}
```

| Field | Type | Default | Description |
|---|---|---|---|
| `id` | string | required | URL-safe slug: `[a-z0-9-]`, max 60 chars |
| `version` | string | `null` | Semver string (e.g. `"2.0.0"`). Used by seeder to update existing installs |
| `name` | string | required | Display name in UI |
| `description` | string | `""` | Shown in NewChat grid and setup screen |
| `icon` | string | `""` | Emoji shown in UI |
| `ui` | string | `"custom"` | `"standard"` or `"custom"` |
| `permissions` | string[] | `[]` | Declared capabilities. `http:` entries are enforced at runtime (see HTTP proxy). |
| `setup` | object | `null` | Setup form configuration |
| `setup.fields` | array | `[]` | Form fields shown before app starts |

### Setup field types

| Type | Renders as | Value |
|---|---|---|
| `text` | Single-line input | String |
| `password` | Masked single-line input | String (not persisted to disk) |
| `textarea` | Multi-line input | String |
| `file` | Browse button + filename display | File path string |
| `model` | Model picker dropdown (same as Composer) | Model ID string |

File fields accept an optional `filters` array for the native dialog: `[{ "name": "Word Documents", "extensions": ["docx"] }]`.

Model fields accept a `default` value (model ID). Defaults to `"auto"` (user's configured model).

### DOCX path flow

When a setup field of type `file` contains a `.docx` path, the runtime automatically wires it into `ctx.docx.*`. The app code calls `ctx.docx.connected()` and `ctx.docx.read()` without needing to know which field holds the path. The path is resolved from `inputs` by checking `inputs.document` first, then scanning all string inputs for `.docx` suffixes.

## Standard-UI Apps

Standard-UI apps export a `run(ctx)` function. mim terminal loads the module, calls `run()`, and displays progress in a timeline view.

### Entry point

```javascript
// index.js
export async function run(ctx) {
  ctx.progress.step('Processing')
  // ... do work ...
  ctx.progress.done('Complete')
  return { result: 'data' }
}
```

### Runtime API — `ctx`

#### ctx.inputs

Frozen object containing setup field values. Keys match `setup.fields[].id` from the manifest.

```javascript
const notes = ctx.inputs.notes || ''
const filePath = ctx.inputs.file || null
```

#### ctx.project

Current project context. `null` if launched without a project.

```javascript
ctx.project.id            // project ID
ctx.project.name          // display name
ctx.project.workspacePath // filesystem path (if linked to a folder)
```

#### ctx.model

AI generation via the Vercel AI SDK. Uses the user's configured model and API keys.

```javascript
const result = await ctx.model.generate({
  model: null,             // model ID override (null = user's default)
  system: 'You are...',    // system prompt
  prompt: 'Analyze this',  // single-turn prompt (or use messages)
  messages: [],             // multi-turn messages array
  tools: {},                // tool definitions (see below)
  maxSteps: 8,              // max tool-use steps (1-25)
  maxOutputTokens: 4096,    // output token limit
  temperature: 0.3,         // sampling temperature
})

// result.text — the model's text response
// result.steps — array of step objects (if tools were used)
```

**Tool definitions** use JSON Schema `parameters` + `execute`:

```javascript
const tools = {
  lookup_data: {
    description: 'Look up a value in the dataset',
    parameters: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'The lookup key' },
      },
      required: ['key'],
    },
    execute: async ({ key }) => {
      return { value: dataset[key] || null }
    },
  },
}

const result = await ctx.model.generate({
  system: 'You are a data analyst.',
  prompt: 'Find the total for Q3.',
  tools,
  maxSteps: 5,
})
```

#### ctx.data

Persistent key-value store, scoped per app per project. Data survives across sessions.

```javascript
await ctx.data.save('results', { items: [...], updatedAt: new Date().toISOString() })
const results = await ctx.data.load('results')  // → object or null
await ctx.data.delete('results')
const keys = await ctx.data.keys()              // → string[]
```

Storage: `~/.mim/apps/{appId}/data/{projectId}/{key}.json`

#### ctx.docx

Read and annotate Word documents. Requires the user to have a DOCX file connected in the Panel.

```javascript
if (!ctx.docx.connected()) throw new Error('No DOCX file connected')

const doc = await ctx.docx.read()
// doc.markdown — document content as markdown
// doc.text — same as markdown

// Comments are batched for performance
await ctx.docx.comment('exact text from document', 'Review comment here')
await ctx.docx.comment('another quote', 'Another comment', 'Reviewer Name')

// Flush writes all batched comments to the DOCX file at once
const result = await ctx.docx.flushComments()
// result.outputPath — path to the annotated copy
```

The optional third parameter sets the comment author in the DOCX (defaults to `'mim'`).

#### ctx.knowledge

Read bundled reference files from the app's `knowledge/` directory.

```javascript
// Load a single file
const foundation = await ctx.knowledge.load('causal-inference/00-foundation.md')

// Load all files in a category
const chapters = await ctx.knowledge.loadAll('causal-inference')
// → [{ name: '01-topic.md', content: '...' }, ...]
```

#### ctx.progress

Report execution progress to the timeline UI. These are the only way to communicate with the user during execution.

```javascript
ctx.progress.step('Reading document')  // new named step in timeline
ctx.progress.log('Found 12 sections')  // log line under current step
ctx.progress.done('Review complete')   // marks execution complete, shows summary
```

The `done()` summary is rendered as markdown in the result view (headings, bold, lists, code all formatted). It supports the full report structure used by docx-review.

The `run()` return value goes into `session.appResult`. Include an `annotatedPath` field to show a prominent "Annotated file created" banner:

```javascript
return { report: summary, annotatedPath: '/path/to/output.docx', commentCount: 42 }
```

A "Save report" button appears when a `done()` summary exists, letting users save the report as a `.md` file.

#### ctx.http

External HTTP requests, proxied through the Rust backend. Bypasses CORS restrictions that block browser `fetch()` from the webview.

```javascript
const resp = await ctx.http.fetch('https://api.github.com/repos/owner/repo', {
  method: 'GET',
  headers: { 'Authorization': 'Bearer ' + token },
  timeout: 10000,
})
// resp.status  — HTTP status code
// resp.ok      — true if status 200-299
// resp.headers — response headers object
// resp.body    — response body as string
// resp.json()  — parse body as JSON
```

Requires `"http:domain"` in the manifest `permissions` array. The domain entry allows that domain and all subdomains (e.g. `"http:github.com"` allows `api.github.com`). Use `"http:*"` only when the target domain is user-configured at runtime.

> **CORS limitation**: Browser `fetch()` cannot make authenticated cross-origin requests from the webview. Always use `ctx.http.fetch()` for external API calls.

#### ctx.abort

Cancellation support. Check periodically in long-running operations.

```javascript
ctx.abort.throwIfAborted()   // throws Error('App aborted') if cancelled
ctx.abort.aborted            // boolean
ctx.abort.signal             // AbortSignal (pass to fetch, etc.)
```

#### ctx.files

Read files from the app's own directory (not the user's filesystem).

```javascript
const config = await ctx.files.readJson('config.json')
const template = await ctx.files.read('prompts/review.txt')
const exists = await ctx.files.exists('agents/reviewer.js')
```

#### ctx.usage

Cumulative token usage across all `ctx.model.generate()` calls.

```javascript
const usage = ctx.usage
// { inputTokens, outputTokens, totalTokens, estimatedCost, ... }
```

## Custom-UI Apps

Custom-UI apps provide their own HTML interface. mim terminal loads `index.html` in an iframe inside the Panel, with the SDK and theme CSS auto-injected.

### Entry point

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>My App</title>
  <link rel="stylesheet" href="style.css">
  <!-- SDK and theme are injected here automatically -->
</head>
<body>
  <div id="app"></div>
  <script src="app.js"></script>
</body>
</html>
```

### SDK — `window.mim`

Auto-injected into every custom-UI app. No imports needed. Available immediately when the script runs.

#### mim.app

```javascript
mim.app.id          // app's slug ID
mim.app.projectId   // current project ID
mim.app.sessionId   // current session ID
```

#### mim.data

Same persistent key-value store as the standard-UI runtime. Scoped per app per project.

```javascript
await mim.data.save('notes', { text: '...', savedAt: new Date().toISOString() })
const notes = await mim.data.load('notes')  // → object or null
await mim.data.delete('notes')
const keys = await mim.data.keys()           // → string[]
```

#### mim.ui

Native desktop dialogs. These open real OS dialogs, not browser alerts.

```javascript
await mim.ui.alert('Operation complete')

const confirmed = await mim.ui.confirm('Delete all entries?')
// → true (Yes) or false (No)

const path = await mim.ui.openFile({
  filters: [{ name: 'CSV', extensions: ['csv'] }],
  multiple: false,
})
// → file path string or null

const savePath = await mim.ui.saveFile({
  defaultPath: 'export.csv',
  filters: [{ name: 'CSV', extensions: ['csv'] }],
})
// → file path string or null
```

#### mim.fs

Full filesystem read/write access.

```javascript
const content = await mim.fs.readText('/path/to/file.csv')
await mim.fs.writeText('/path/to/output.json', JSON.stringify(data))
const exists = await mim.fs.exists('/path/to/check')
```

#### mim.http

External HTTP requests, proxied through the Rust backend. Bypasses CORS restrictions.

```javascript
const resp = await mim.http.fetch('https://api.example.com/data', {
  method: 'POST',
  headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
  body: JSON.stringify({ query: 'test' }),
  timeout: 15000,
})
if (!resp.ok) throw new Error('HTTP ' + resp.status)
const data = resp.json()
```

Same permission model as `ctx.http.fetch()`: requires `"http:domain"` in the manifest. The domain entry covers subdomains (e.g. `"http:example.com"` allows `api.example.com`). Use `"http:*"` only when domains are user-configured.

> **CORS limitation**: Browser `fetch()` cannot make authenticated cross-origin requests from the webview. Always use `mim.http.fetch()` for external API calls in custom-UI apps.

### Theme

The SDK injects `theme-base.css` with CSS custom properties matching the active mim terminal theme:

```
--color-ink          main text
--color-ink-2        secondary text
--color-ink-3        tertiary/muted text
--color-ink-4        disabled text
--color-chrome       panel background
--color-chrome-mid   mid-tone background
--color-chrome-high  light background
--color-surface      card/input background
--color-accent       primary action color
--color-accent-soft  accent at 8% opacity
--color-accent-ink   text on accent background
--color-rule         border color
--color-rule-light   subtle border
--font-sans          system sans-serif
--font-serif         Lora/Georgia
--font-mono          monospace
--radius             border-radius (6px)
```

Pre-styled elements: `button`, `input`, `select`, `textarea`, `table`, `th`, `td`.
Utility classes: `.card`, `.drop-zone` (with `.drag-over`), `.text-sm`, `.text-lg`, `.text-muted`.

### iframe Architecture

Custom-UI apps render in an iframe inside the Panel. The iframe is sandboxed with `allow-scripts allow-same-origin allow-popups allow-forms`.

The SDK communicates with mim terminal via a postMessage bridge:
1. SDK sends `{ type: 'mim:invoke', id, command, args }` to parent
2. Parent validates against a command whitelist and proxies to Tauri
3. Parent sends `{ type: 'mim:result', id, result }` (or `error`) back
4. SDK resolves/rejects the promise

Whitelisted commands: `app_data_load`, `app_data_save`, `app_data_delete`, `app_data_keys`, `app_http_request`, `read_text_file`, `write_text_file`, `path_exists`, `plugin:dialog|message`, `plugin:dialog|open`, `plugin:dialog|save`.

For data commands, the bridge injects `appId` and `projectId` server-side — the iframe cannot forge app identity.

The SDK also works in standalone Tauri windows (auto-detects `window.parent !== window`), using direct Tauri invoke instead of postMessage.

## Session Lifecycle

1. User clicks an app in the NewChat grid
2. An app session is created (`type: 'app'`, `appStatus: 'setup'` or `'running'`)
3. Session appears in the sidebar with the app name as its label
4. If the manifest has `setup.fields`: the setup form is shown first
5. User clicks Start → session transitions to `'running'`
6. Standard UI: the runner loads `index.js` and executes `run(ctx)`. Progress timeline updates live.
7. Custom UI: the iframe loads `index.html`. The app is live until the user navigates away.
8. On completion: `appStatus` → `'completed'`, results shown, re-run available
9. User clicks Done → session is archived (Cmd+Shift+D or toolbar button)

Status indicators in the sidebar match chat sessions: working, error, completed, time.

Multiple instances of the same app can run in parallel, in different projects.

## Patterns

### Multi-agent review (docx-review)

The production pattern for document review apps. See `~/.mim/apps/docx-review/` for the reference implementation.

```
docx-review/
├── manifest.json         # ui: "standard", permissions: model, docx, knowledge
├── index.js              # orchestrator: read doc → run agents in parallel → insert comments → compile report
├── agents/
│   ├── methodsReviewer.js    # config: causal inference focus, knowledge: causal-inference
│   ├── reportingReviewer.js  # config: epi methods focus, knowledge: epi-methods
│   ├── editorialReviewer.js  # config: writing quality, no knowledge dependency
│   ├── referenceChecker.js   # config: citation audit, hasSummary: true
│   └── reportWriter.js       # compile findings into structured report
├── lib/
│   ├── createReviewAgent.js  # shared factory: tool definition, validation, progress, trace capture
│   ├── guidanceLoader.js     # lazy-loads knowledge chapters as AI tools
│   └── validateAnchors.js    # verifies comment anchors match document text
└── knowledge/
    ├── causal-inference/     # 9 chapters on causal methods
    └── epi-methods/          # 9 chapters on epidemiological methods
```

Key techniques:
- **Shared agent factory**: `createReviewAgent()` eliminates duplication — each agent is ~20 lines of config (system prompt, knowledge categories, label)
- **Parallel agents**: `Promise.allSettled()` runs 4 review agents concurrently
- **Retry with timeout**: each agent gets 2 attempts with a 10-minute timeout
- **Knowledge as AI tools**: `createGuidanceTool()` gives agents a `getGuidance` tool to browse and load knowledge chapters on demand (lazy loading, with a character budget)
- **Structured tool output**: agents call `submit_review` with typed comment objects (text_snippet, content, severity)
- **Anchor validation**: `validateAnchors()` verifies comment snippets are exact quotes from the document
- **Concise comment style**: factory appends strict style instructions — "state the issue, suggest the fix, one to two sentences"
- **Reviewer as DOCX author**: each reviewer's short label (e.g., "Methods", "Editorial") is set as the comment author in the DOCX, not embedded in the comment text
- **Batched DOCX writes**: comments are collected, deduplicated (by snippet+content), then flushed to the DOCX in one batch
- **Model passthrough**: orchestrator reads `ctx.inputs.model` and passes it to all agents (null = user's configured default)
- **Live progress from tools**: agent tool `execute` functions call `ctx.progress.log()` for incremental timeline updates during long agent runs
- **Per-agent trace data**: factory captures activity (duration, severity counts, anchor stats, tool calls, usage) in `appResult.trace` for audit/export
- **Annotated path in result**: `run()` returns `{ annotatedPath }` for the file banner in AppStandard

### Persistent data app

```javascript
// index.js — standard UI with data persistence
export async function run(ctx) {
  ctx.progress.step('Loading history')
  const history = await ctx.data.load('history') || []

  ctx.progress.step('Processing')
  const newEntry = { date: new Date().toISOString(), input: ctx.inputs.notes }
  history.push(newEntry)
  await ctx.data.save('history', history)

  ctx.progress.done(`${history.length} entries recorded`)
  return { entryCount: history.length }
}
```

### Custom-UI with persistence

```html
<!-- index.html -->
<body>
  <textarea id="editor"></textarea>
  <button onclick="save()">Save</button>
  <script>
    async function load() {
      const data = await mim.data.load('doc')
      if (data) document.getElementById('editor').value = data.text
    }
    async function save() {
      const text = document.getElementById('editor').value
      await mim.data.save('doc', { text, at: new Date().toISOString() })
    }
    load()
  </script>
</body>
```

### File processor with progress

```javascript
export async function run(ctx) {
  const filePath = ctx.inputs.file
  if (!filePath) throw new Error('No file selected')

  ctx.progress.step('Reading file')
  // Use fs for the user's file (not ctx.files, which reads from the app dir)
  // For standard-UI apps, file paths from setup fields can be read via the project workspace
  ctx.progress.log(`Processing: ${filePath.split('/').pop()}`)

  ctx.progress.step('Analyzing')
  const result = await ctx.model.generate({
    system: 'You are a data analyst.',
    prompt: `Analyze this data and provide a summary.`,
  })

  ctx.progress.done(result.text)
  return { summary: result.text }
}
```

## Versioning and Updates

Apps can declare a `version` field in `manifest.json` (semver string, e.g. `"2.0.0"`). The seeder uses this to decide whether to update an existing app on launch:

| Scenario | Behavior |
|---|---|
| App dir doesn't exist | Install (copy all files) |
| App dir exists, bundled version > installed version | Overwrite files (preserves `data/` directory) |
| App dir exists, same or lower bundled version | Skip |
| App dir exists with no version, bundled has a version | Overwrite (installed treated as `0.0.0`) |
| Bundled manifest has no version | Never overwrite (backward compatible) |

Bump the `version` field in `manifest.json` whenever you ship changes to an app. The seeder handles the rest — users on existing installs get the update on next launch.

The seeder also creates subdirectories for nested file paths (e.g., `agents/reviewer.js` creates the `agents/` directory automatically).

## Discovery and MRU

Apps are discovered by scanning `~/.mim/apps/` on Panel mount. The NewChat screen shows the 3 most recently used apps as cards, with a "Show all" overlay for the full list. MRU order is persisted in user settings.

To install a new app: create a directory in `~/.mim/apps/` with a valid `manifest.json`. The app appears in the NewChat grid on next Panel mount or page reload.

## File Map

| File | What |
|---|---|
| `src-tauri/src/apps.rs` | Rust: protocol handler, 9 commands, manifest struct |
| `src-tauri/src/lib.rs` | Rust: `app://` protocol registration, command registration |
| `src/apps/runner.js` | App execution handle (start, cancel, promise) |
| `src/apps/runtime.js` | Standard-UI runtime: ctx.* API (model, data, docx, knowledge, progress, abort, files) |
| `src/apps/bridge.js` | Parent-side postMessage proxy for custom-UI iframe |
| `src/apps/sdk/mim-sdk.js` | Custom-UI SDK: dual-mode (iframe postMessage / standalone Tauri invoke) |
| `src/apps/sdk/theme-base.css` | Theme tokens + reset injected into custom-UI apps |
| `src/stores/panel/apps.js` | Pinia store: global discovery, MRU tracking |
| `src/stores/panel/actions.js` | `launchApp()` action: creates session, tracks MRU |
| `src/stores/panel/sessions.js` | Session model: `type: 'app'` with app-specific fields |
| `src/stores/panel/helpers.js` | `isAppSession()`, app status in `sessionStatusKind()` |
| `src/stores/panel/persistence.js` | App session snapshot/restore |
| `src/panel/components/AppView.vue` | Top-level router: setup → standard / custom |
| `src/panel/components/AppSetup.vue` | Manifest-driven setup form |
| `src/panel/components/AppStandard.vue` | Progress timeline for standard-UI apps |
| `src/panel/components/AppCustom.vue` | iframe host + toolbar for custom-UI apps |
| `src/panel/components/NewChat.vue` | App grid (3 MRU cards + show-all overlay) |
| `src/panel/App.vue` | Panel routing: AppView for app/workflow sessions |
| `src/services/skills/bundled.js` | App Builder skill prompt (for AI-created apps) |

## Debugging Custom-UI Apps

**Clearing app data**: `mim.data` persists across reloads. Bad state (failed lookups, stale IDs) sticks until explicitly cleared. To reset: delete `~/.mim/apps/{appId}/data/` and re-launch the app.

**Encoding**: `mim.fs.readText(path)` reads as UTF-8. For Latin-1/ISO-8859-1 files (e.g. GLS Bank .supa exports), use `mim.fs.readText(path, 'latin1')` — this reads binary via `read_binary_file` and decodes in JS. Try UTF-8 first, fall back to latin1 on failure.

**HTTP proxy**: `mim.http.fetch()` proxies through Rust. Response shape: `resp.body` is a string, `resp.json()` parses it. The proxy may behave differently from direct `curl`/`fetch` — always `console.log` the raw response when debugging API integrations.

## Known Limitations

- Custom-UI apps cannot call `ctx.model.generate()` — AI access is standard-UI only
- Theme does not live-sync to already-open app iframes when the user changes themes
- No hot reload — after updating app files, the user must re-launch
- App permissions in the manifest are declarative only — not enforced at runtime — except `http:` entries, which are checked on every proxied request
- The SDK `openFile`/`saveFile` argument shape may vary across platforms
- No app marketplace or sharing mechanism
