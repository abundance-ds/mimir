# Gotchas

Non-obvious constraints and bugs. Keep this short, concrete, and source-linked.

## CSS / Tailwind

### Button reset must be in `@layer base`

`base.css` resets `button { border: none; background: none; }`. This MUST be inside `@layer base { }`. Tailwind v4 generates utilities inside `@layer utilities`. Unlayered CSS always beats layered CSS — so an unlayered button reset silently kills `bg-*`, `border-*`, etc. on every `<button>`. Source: `src/shared/styles/base.css:29`.

## Docs

### Root Markdown files are ignored by default

`.gitignore` ignores `*.md` because root docs/plans were treated as local notes. The tracked documentation system is under `docs/`; `.gitignore` explicitly unignores `README.md` and `docs/*.md`.

## Toolbar / Formatting

### Toolbar buttons must use `@mousedown.prevent` to keep CM6 focus

Clicking a toolbar button (EditorToolbar) triggers a `mousedown` event that moves focus to the button element. This collapses the CM6 selection and loses the cursor position, so the formatting command operates on the wrong range (or no range at all). All toolbar buttons must use `@mousedown.prevent` to prevent the default focus-steal behavior. The `format()` method in EditorSurface also calls `view.focus()` after executing the command as a safety net.

Source: `src/editor/components/workspace/EditorToolbar.vue`, `src/editor/components/workspace/EditorSurface.vue`.

## Themes

### Native window background is not theme-reactive

`src/shared/windowChrome.js` hardcodes `EDITOR_WINDOW_BACKGROUND` and `PANEL_WINDOW_BACKGROUND` for Tauri's native `backgroundColor` option. These are set at window creation time, before CSS loads. Changing theme does not update the native window background — only the CSS surfaces. The brief flash between native paint and CSS paint may show the wrong color in dark themes. Fix requires reading the theme setting in Rust before creating the webview.

## AI

### Guard Vue `inject()` in shared composables (resolved)

This gotcha was resolved by the Pinia migration — `useSettingsStore` (in `src/stores/settings.js`) is a Pinia store accessed directly, not via provide/inject. However, the pattern still matters for any future composables that use `inject()`: services can call shared composables outside component setup, and calling `inject()` there logs Vue warnings. Any future composable that supports service use must call `inject()` only when `hasInjectionContext()` is true, then fall back to a module singleton.

Source: `src/stores/settings.js`, `src/services/ai/ghost.js`.

### `~/.shoulders-v3` is the v0.3 data root

v0.3 uses `~/.shoulders-v3` as its centralized data root (config, projects, references). All project data lives here; workspace folders get only a `.shoulders.json` marker. Before production replacement, migrate/promote intentionally to `~/.shoulders` and archive the old root.

Source: `src-tauri/src/ai_models.rs`.

### `.env` and plaintext API key fallbacks are debug-only

Key resolution reads repo `.env` and `~/.shoulders-v3/keys.env` only in debug builds. Production uses OS keychain or process env and refuses plaintext key storage if keychain write fails.

Source: `src-tauri/src/ai_keys.rs`.

### Panel chat uses AI SDK provider adapters through Rust transport

Do not replace this with hand-written provider tool/stream formats unless explicitly decided. AI SDK owns provider protocol; Rust owns real auth, host validation, streaming HTTP, and cancellation.

Source: `src/services/ai/sdkAdapter.js`, `src/services/ai/bridgeFetch.js`, `src-tauri/src/ai_proxy.rs`.

### Never pass real keys to AI SDK provider constructors

`sdkAdapter.js` passes a dummy key. `ai_proxy.rs` strips/overwrites provider auth headers before upstream requests. Real keys must remain in Rust/keychain/env.

Source: `src/services/ai/sdkAdapter.js`, `src-tauri/src/ai_proxy.rs`.

### Stream listeners must exist before invoking Rust

Fast provider errors can emit before the renderer subscribes. `bridgeFetch.js` registers chunk/done/error listeners before `ai_proxy_stream`; preserve that order.

Source: `src/services/ai/bridgeFetch.js`.

### Chat instances must live outside Vue's reactive system

AI SDK's `Chat` class (from `@ai-sdk/vue`) stores messages, status, and error in internal Vue `ref()` values (`VueChatState`). If you store a Chat instance on a reactive object (e.g. inside `sessions.value[]`), Vue's Proxy interferes with the Chat's internal reactivity and computeds that read Chat state never re-evaluate when messages change.

Neither `markRaw` nor reactive tick counters reliably fix this. The only pattern that works is the v0.2.x approach:

1. Store Chat instances in a **plain `Map` at module scope** — completely outside Vue/Pinia reactivity.
2. Add a `_chatVersion` ref counter. Bump it when Chats are created or destroyed.
3. Expose `getChatInstance(sessionId)` that reads `void _chatVersion.value` (creating a reactive dependency) then returns from the Map.
4. In computeds, access `chat.state.messagesRef.value`, `chat.state.statusRef.value`, `chat.state.errorRef.value` **directly** — these are Vue `ref()` values and ARE reactive when read in a computed scope.
5. Use `watch(() => chat.state.statusRef.value, ...)` for lifecycle events (save on stream complete, etc.).

The key insight: the Chat's internal refs work fine for reactivity — the problem is Vue's Proxy wrapping the Chat instance and breaking the `this` context of getters. Keeping Chat in a plain Map avoids the Proxy entirely.

Source: `src/stores/panel/chat.js` and `src/stores/panel/helpers.js`, proven in `~/Desktop/hugin-munin/src/stores/chat.js`.

### Do not await `chat.sendMessage()` in the store

`Chat.sendMessage()` from `@ai-sdk/vue` resolves only after the entire stream completes. If you `await` it in the store's `sendMessage`, the view won't update until the full response arrives. Call it without `await` — the user message appears immediately via the messagesRef reactivity, and the streaming response renders progressively.

Source: `src/stores/panel/chat.js`.

### AI SDK `sendMessage` is async even for text-only messages

`AbstractChat.sendMessage()` does `await convertFileListToFileUIParts(message.files)` even when `files` is undefined. This means the user message push happens one microtask after the call starts, not synchronously. Design code accordingly — don't assume messages are available in the same synchronous frame.

Source: `node_modules/ai/dist/index.mjs`, `AbstractChat.sendMessage()`.

### AI SDK parts array reference is reused across message updates

The AI SDK shallow-clones message objects (`{ ...message }`) when updating, but may reuse the same `parts` array reference with mutated contents. Vue's computed caching uses reference equality, so intermediate computeds that cache based on the parts array reference may not update. Read `props.message.parts` directly in templates, not through intermediate computeds.

Source: learned from `~/Desktop/hugin-munin/src/components/ChatMessage.vue` line 315.

### AI SDK tools: use `inputSchema`, NEVER `parameters`

The AI SDK `tool()` function accepts `inputSchema` for defining tool input. Do NOT use `parameters` — it silently produces a schema missing `input_schema.type`, and Anthropic returns 400: `"input_schema.type: Field required"`. This has caused repeated bugs.

```javascript
// WRONG — breaks with Anthropic
tool({ description: '...', parameters: z.object({ ... }), execute: ... })

// CORRECT
tool({ description: '...', inputSchema: z.object({ ... }), execute: ... })
```

Empty `z.object({})` schemas also break for the same reason — add at least one optional field.

Source: `src/services/ai/tools/`, `src/services/ai/inlineTransport.js`.

### Panel tool writes must stay proposal-based

The `edit` and `create` tools on project paths record proposals and never write directly (in normal/strict approval mode). `@issues/`, `@knowledge/`, `@apps/`, `@skills/` paths bypass proposals.

Source: `src/services/ai/tools/edit.js`, `src/services/ai/tools/create.js`, `src/panel/components/ProposalActionBar.vue`.

### Ghost control text must not be inserted

Ghost UI hints live in widgets, not inside suggestion strings. Accepting a suggestion must insert only the suggestion text.

Source: `src/editor/ghost.js`.

### Escape document content in AI prompts

Ghost and rewrite prompts use XML-like tags (`<prefix>`, `<selection>`, etc.) to structure the prompt. Raw document content is escaped via `escapePromptXml()` from `context.js` to prevent prompt injection from documents containing `<`, `>`, or `&`.

Source: `src/services/ai/context.js`, `src/services/ai/ghost.js`, `src/services/ai/rewrite.js`.

### `mapAiError` returns structured errors with `kind`

`errors.js` exports `mapAiError(error)` → `{ message, kind }`. Kinds: `auth`, `network`, `provider`, `limit`, `unknown`. `chatTransport.js` wraps errors with this before they reach the Chat instance's `onError`. The old `describeAiError` is a deprecated alias.

Source: `src/services/ai/errors.js`, `src/services/ai/chatTransport.js`.

### Stream sessions auto-cleanup on completion

`ai_proxy.rs` removes sessions from the HashMap on every exit path (error, abort, normal completion). `ai_cleanup` is still safe to call (no-op if already removed). This prevents the session leak that occurred when the frontend failed to call `ai_cleanup`.

Source: `src-tauri/src/ai_proxy.rs`.

### `search_web` does not persist results

The `search_web` tool returns academic metadata (OpenAlex, CrossRef, arXiv) but does NOT import results into the reference library. Use `edit("@library.json", ...)` to persist a reference after searching. In browser dev mode (`bun run dev`), reference writes via `@library.json` may not persist because `window.__TAURI_INTERNALS__` is absent.

Source: `src/services/ai/tools/searchWeb.js`.

### Filter empty model suggestions

Model responses can contain whitespace-only suggestions. Filter them before updating CodeMirror, or cycling shows blank entries.

Source: `src/services/ai/ghost.js`, `src/editor/ghost.js`.

### Lazy-loaded docx symbols are undefined at module scope

`src/services/export/docx.js` lazy-loads the `docx` package via `await import('docx')`. Module-scope constants cannot reference symbols like `convertInchesToTwip` or `HeadingLevel` because they are undefined until `ensureDocx()` runs. Use string keys and resolve at call time inside functions that run after the lazy import.

Source: `src/services/export/docx.js`.

### mammoth dynamic import in reader.js

mammoth must be imported via `await import('mammoth')` (dynamic), not a static top-level import. Static import breaks vitest because Vite's import analysis tries to resolve it before mocks run. The vitest config has `server.deps.inline: ['mammoth']` to handle resolution. The dynamic import is still code-split by Vite for production.

Source: `src/services/docx/reader.js`, `vitest.config.js`.

### Sidecar path resolution uses CARGO_MANIFEST_DIR

The docx-worker sidecar binary is found via `env!("CARGO_MANIFEST_DIR")/binaries/` at compile time, NOT via Tauri's shell plugin sidecar API. The shell plugin's `app.shell().sidecar()` had path resolution issues in dev mode ("No such file or directory"). Using `std::process::Command` directly with the compile-time path works reliably.

Source: `src-tauri/src/docx_worker.rs`.

### .NET sidecar exits with code 1 on error but still writes JSON to stdout

The docx-worker binary writes its JSON response to stdout regardless of success/failure, but uses exit code 1 for errors. The Rust wrapper reads stdout regardless of exit code to capture the structured error response.

Source: `src-tauri/src/docx_worker.rs`.

### Tool module split: 5 modules, not one file

Tools are split across `document.js`, `references.js`, `research.js`, `project.js`, `docxReview.js` under `src/services/ai/tools/`. `index.js` is a slim assembler that imports and merges them. `helpers.js` provides shared utilities. When adding a new tool, add it to the appropriate module — `index.js` imports all modules automatically.

Source: `src/services/ai/tools/index.js`.

## Panel

### Panel and Editor share localStorage

Same Tauri origin means both windows read/write the same `shoulders:` keys. The Panel reads `shoulders:doc` for prototype document access. This works but is fragile — avoid relying on cross-window localStorage for anything beyond prototyping.

Source: `src/panel/App.vue`, `src/editor/App.vue`.

### Model "Auto" resolves at send time

`resolveConcreteModel()` picks the best available model based on configured API keys. If no keys are configured, chat can't send. The resolved model is not persisted — re-sending in a restored session may pick a different model if keys changed.

Source: `src/services/ai/modelControls.js`.

### Proposal coordinator is runtime-only

Rust owns proposal lifecycle while the app is running, but the coordinator is still runtime memory. Panel mirrors proposal state into `sessions[].proposals` for rendering and persistence. Session restore pushes pending proposals back into Rust via `push_proposals`.

Source: `src-tauri/src/lib.rs`, `src/stores/panel/chat.js`, `src/stores/panel/persistence.js`.

### Editor proposal review must report back to Rust

Editor diff state is derived UI state, not proposal authority. Any proposal-backed editor accept/reject path must invoke `proposal_respond` so Rust can finalize coordinator state and then broadcast it back to the Panel. This includes DiffBar accept/reject and CodeMirror's all-chunks-resolved callback.

Source: `src-tauri/src/lib.rs`, `src/editor/composables/useDiffReview.js`, `src/editor/composables/useProposalBridge.js`.

## Audit

### `audit.db` is separate from `usage.db`

The audit log lives in `~/.shoulders-v3/audit.db`, not in `usage.db`. This is intentional: usage analytics and compliance audit have independent lifecycles. The audit DB may be exported to clients or auditors; the usage DB stays local. Do not merge them.

Source: `src-tauri/src/audit.rs`, `src-tauri/src/usage.rs`.

### Audit logging is fire-and-forget

`logAudit()` calls are never awaited by callers. The function is async internally (Tauri invoke) but callers treat it as a side effect. This ensures audit logging never blocks or slows the UI. If the write fails, it logs a console warning and moves on.

Source: `src/services/audit.js`, `src/services/ai/tools/gate.js`.

## Forms / Text Input

### `autocorrect` and `autocapitalize` must be set per-element

WKWebView (Tauri on macOS) does not inherit `autocorrect="off"` or `autocapitalize="off"` from `<html>` or `<form>` ancestors, despite the HTML spec. Every `<input>` and `<textarea>` must carry its own attributes. Skip `type="password"` and `type="number"` (immune).

Source: `index.html` (does not work), all `<input>`/`<textarea>` in `src/`.

## Tauri / Runtime

### Devtools are debug-only

`src-tauri/src/lib.rs` opens devtools only under `debug_assertions`. Keep release checks clean with `cargo check --release`.

### Stale Vite on port 1420 causes misleading behavior

Tauri loads `http://127.0.0.1:1420` from `src-tauri/tauri.conf.json`. Keep Vite `strictPort: true`; otherwise a new `bun run dev` can move to `1421+` while Tauri still loads the old app on `1420`. Check with:

```bash
lsof -nP -iTCP:1420 -sTCP:LISTEN
pkill -f "vite --host 127.0.0.1"
```

### Multi-window APIs need explicit capabilities

If browser fallback works but Tauri throws a Vue native-handler warning or permission error when opening/closing windows, check `src-tauri/capabilities/default.json`.

Current expected labels:

- `main` (Panel — primary window)
- `editor-*` (Editor windows, opened on demand)

Needed permissions include creating webview windows, closing windows, and focusing windows.

### Window chrome uses native overlay controls

Editor and Panel headers reserve space for native macOS traffic-light controls. Do not draw fake red/yellow/green controls in Vue while Tauri windows are decorated, or macOS will show a second plain titlebar above the app header. Main window chrome is configured in `src-tauri/tauri.conf.json`; dynamic windows use `src/shared/windowChrome.js`. Use `data-tauri-drag-region` on draggable header areas for Windows/Linux drag support, keep interactive controls as no-drag buttons, and keep `core:window:allow-start-dragging` in `src-tauri/capabilities/default.json`.

Overlay-titlebar windows should also set a non-black `backgroundColor` and explicit `html/body/#app` margin resets. Otherwise the native webview backing or default page margin can show as a dark frame around the app.

For exact traffic-light positioning, open `/?chromeCalibrate=1` or `/?view=editor&chromeCalibrate=1`. This shows outline-only guide circles and crosshairs at the configured native control coordinates. Do not leave filled placeholder dots in production chrome.

### Panel/editor windows are route-selected

`src/main.js` decides which Vue root to mount:

- `/` -> `src/panel/App.vue` (default — Panel is the primary window)
- `/?view=editor` -> `src/editor/App.vue`
- `/?view=editor&new=1&window=<label>` -> `src/editor/App.vue` with empty unsaved editor state

Do not add a second Vite entry unless there is a clear reason.

## Prototype State

### `shoulders:` localStorage keys are prototype state

localStorage uses `shoulders:` prefix keys for prototype persistence. Do not treat these as final persistence schema.

### `?new=1` editor windows should not write `shoulders:doc`

New editor windows opened from the agents panel are intended to be empty, unsaved, in-memory documents until native Save As exists.

## Tab Strip Layout

### TransitionGroup wrapper div breaks tab flex sizing

Don't nest TransitionGroup inside a flex scroll container — its wrapper div becomes an intermediary that sizes to content, not available space. Tabs must be direct flex children of the constrained container. Put layout classes on TransitionGroup's `tag` div itself.

Source: `src/editor/components/workspace/TabStrip.vue`.

## Tab Dragging

### HTML5 DnD is incompatible with Tauri drag regions

`-webkit-app-region: drag` on any ancestor element swallows HTML5 `dragover`/`drop` events, even from children with `-webkit-app-region: no-drag`. Tab dragging uses pointer events (`pointerdown`/`pointermove`/`pointerup`) instead. See `TabStrip.vue`.

### Source tab must collapse during drag, not just hide

Setting `opacity: 0` on the dragged tab leaves it occupying space in the flex layout, creating a mysterious blank area. The `.tab-dragging` class must collapse width to zero (`flex: 0 0 0; width: 0; min-width: 0; padding: 0; overflow: hidden`). The ghost clone is the sole visual representation. The `.tab-drop-gap` margin on the collapsed source tab still works correctly to create the "home position" gap.

### New windows from tab transfer must skip session restore

`createEditorWindowWithFile` stores transfer data in `localStorage` under `shoulders:tab-transfer:{label}`. On mount, the new window must check for this key BEFORE calling `loadSession()`. If present, skip session restore — otherwise the window loads all session files plus the transferred one.

Source: `src/editor/App.vue` onMounted.

### JS screenX/screenY unreliable for window positioning on multi-monitor

WebKit's `e.screenX`/`e.screenY` can differ from the OS coordinate system, especially on secondary monitors. Use the Rust `get_cursor_position` command (which calls `NSEvent::mouseLocation()` on macOS) for accurate window placement and native ghost positioning. The ghost window computes an offset between JS and OS coordinates once on creation and applies it to all subsequent moves.

Source: `src-tauri/src/lib.rs` (`get_cursor_position`), `TabStrip.vue` native ghost logic.

### Tauri `emit()` vs `emit_to()` for cross-window events

`window.emit(event, payload)` broadcasts to ALL listeners across all windows. `app.emit_to(&label, event, payload)` targets a specific window. On the JS side, `listen()` from `@tauri-apps/api/event` is global; use `getCurrentWindow().listen()` to only receive events targeted at this window.

## Settings

### Settings persistence uses explicit `set()`, not watchers

The settings store exposes a `set(key, value)` method as the only path that triggers a debounced save. Direct ref writes (e.g. from `load()`) update the value but never persist. This avoids the class of bugs where Vue watcher timing (sync vs async flush, microtask ordering) causes `load()` to trigger `save()`, creating cross-window ping-pong that overwrites user changes.

All settings section components must use `settings.set('key', value)` for writes. Reads use `settings.key` directly (Pinia auto-unwraps).

The Rust `settings_changed` command emits only to other windows (not the caller) to avoid self-echo. See the `emit()` vs `emit_to()` gotcha under Tab Dragging.

Source: `src/stores/settings.js`, `src-tauri/src/lib.rs` (`settings_changed`).

## Distribution / Build

### macOS-only window APIs on Windows/Linux

`title_bar_style()`, `hidden_title()`, `traffic_light_position()`, and `RunEvent::Opened` are macOS-only Tauri APIs. They do not exist on Windows or Linux. Any new window creation code must guard these with `#[cfg(target_os = "macos")]` or the CI build will fail on non-macOS runners.

Source: `src-tauri/src/lib.rs`, `src-tauri/src/file_open.rs`, `src-tauri/src/apps.rs`.

### Git LFS checkout in CI

GitHub Actions checkout must use `lfs: true` or sidecar binaries won't be present in `src-tauri/binaries/`. Without it, LFS pointer files are checked out instead of the actual binaries, and `tauri build` fails silently or produces a broken bundle.

Source: `.github/workflows/build.yml`, `.gitattributes`.

### Updater signing keypair is shared with v0.2.x

The Tauri updater keypair at `~/.tauri/shoulders.key` is the same one used by v0.2.x. The public key is embedded in `src-tauri/tauri.conf.json` → `plugins.updater.pubkey`. Do NOT regenerate — existing installs would reject updates signed with a different key.

Source: `src-tauri/tauri.conf.json`, `~/.tauri/shoulders.key`.

### `createUpdaterArtifacts` required for auto-updates

`bundle.createUpdaterArtifacts: true` in `tauri.conf.json` is required for CI to produce `latest.json` + `.sig` files. Without it, the updater endpoint has nothing to serve and clients silently report "up to date."

Source: `src-tauri/tauri.conf.json`.

### Unreachable updater endpoint is a silent no-op

If `v3.shoulde.rs/api/updates/latest.json` returns 404 or is down, the app silently reports "up to date." It does not error, block startup, or show warnings. This is by design (Tauri updater behavior).

Source: `src/services/appUpdater.js`.

### Version must match across 3 files

`package.json`, `src-tauri/tauri.conf.json`, and `src-tauri/Cargo.toml` must all have the same version string. Mismatch causes the updater to misidentify the current version and potentially skip or re-apply updates.

### Profile resources are gitignored build artifacts

`src-tauri/resources/{profile.json, bundled-skills/, bundled-apps/}` are staged by `scripts/prepare-profile.sh` and gitignored. They must exist before `tauri build` for bundled resources to be included. In dev mode (`bun tauri dev`), missing resources are handled gracefully — the app falls back to seeding all default skills.

Source: `.gitignore`, `src/stores/panel/persistence.js`.

## Inline Comment Tags (CM6)

### Four layers required — `changeFilter` is the key

Hiding inline `<comment>` tags in CM6 requires four cooperating primitives: `Decoration.replace` (visual), `atomicRanges` (cursor skip), `changeFilter` (edit protection), and `keymap` handlers (backspace/delete redirect). Using `transactionFilter` alone for protection does not work — it produces garbled text and broken undo. `changeFilter` is the CM6-recommended primitive for readonly ranges (confirmed by Marijn Haverbeke on discuss.codemirror.net). Source: `src/editor/codemirror/comments.js`.

### Programmatic mutations must annotate with `commentMutation`

All `view.dispatch()` calls that intentionally modify comment tags (addReply, resolve, updateText, delete, clearAll) must include `annotations: commentMutation.of(true)`. Without it, the `changeFilter` blocks the edit silently — the mutation appears to do nothing. Source: `src/editor/App.vue` (comment mutation functions).

### Ghost cursor positions at tag boundaries

Each hidden tag boundary creates two cursor positions at the same visual location — one before the tag, one after. This causes a single "dead" arrow-key press at each boundary. Inherent to CM6's flat-string model; no known fix without switching to ProseMirror's structured document model.

## Needs Sprint Owner Details

- File persistence gotchas once native file open/save lands.
- Citation autocomplete replacement edge cases once local reference indexing lands.
- Export pipeline gotchas once Typst/HTML export writes files.
