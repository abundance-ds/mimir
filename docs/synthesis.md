# Synthesis — the app we are building

Target state distilled from mim-panel-editor (speed, clarity, focus) and mim-os (layout, agent sessions, apps). Supersedes the product framing in README.md and extends mim-panel-roadmap.md. For the user + 2-3 teammates. No ceremony: no Teams, no permission review, no trust model, no telemetry, no trace stream.

## Core idea

No general-purpose built-in chat. CLI agents (claude, codex, pi) are the primary intelligence. The app is the environment they work in: terminals to run them, an editor they control through MCP, files, apps, and routines that spawn them on a schedule. Native model use is deliberately concentrated in the editor's inline agent and ghost completion.

The product is lean at the surface, not weak underneath. The UI stays small and calm while the local MCP kernel becomes broad, direct, and excellent.

## Product laws

1. **Activities are the universal execution UI.** Terminals, CLI agents, TUIs, apps, and routine runs share one lifecycle and one place in the sidebar. New execution systems do not earn new permanent navigation concepts.
2. **MCP is the universal capability layer.** Editor, comments, files, shell, web, apps, routines, and future integrations expose tools through one discoverable registry shared by agents, apps, and `mimx`.
3. **The Editor is the stable review surface.** Changing Activity never unexpectedly replaces or unmounts the document being reviewed.
4. **Files is a review inbox.** Agentic work makes "what changed most recently?" the primary file-navigation question. Last-edited-first is the default, backed by search and quick-open.
5. **Capabilities extend the kernel, not the chrome.** New power should normally arrive as an MCP tool, app, routine, launcher preset, or Activity rather than a core panel or settings section.
6. **Trusted and hackable beats administered.** This is for one person and a few teammates. No permission-review, trust, audit, marketplace, or organisation-management ceremony.

## Shape

Three panes:

```
+----------+----------------------+--------------------+
| Sidebar  | Activity pane        | Editor             |
| (vert.   | terminal / CLI agent | markdown, tabs,    |
|  list)   | / TUI / app          | inline AI, ghost   |
+----------+----------------------+--------------------+
```

- **Sidebar** = vertical tabs (the mim-os Navigator pattern, chat removed). Top section: launchers — preconfigured CLI agent presets, plain terminal, Files, Apps. Below: running and persisted Activities with status.
- **Activity pane** shows the selected activity. An activity is a terminal, a CLI agent session, some other TUI, or an app instance.
- **Editor** is the existing editor core, preserved and refined while unwanted domain features are removed.

### Collapse model — port perfectly, HIGH PRIORITY

Foundational interaction pattern from mim-os: panes never disappear, they collapse into vertical strips. This must be ported faithfully, not approximated. Source of truth: mim-os `docs/workbench-layout.md` plus `ShellSidebar.vue`, `WorkbenchShell.vue`, `workbenchStore.paneLayout`, and the constants in `services/workbench/entries.ts`. Pane mapping: mim-os Navigator / Work / Artifact = our Sidebar / Activity pane / Editor.

- The sidebar collapses to a permanent 52px icon rail. Same component in both states, never unmounted. Icons and monograms sit on the same 12px left gutter expanded and collapsed, so nothing shifts on toggle. Cmd+B flips it. Rail cap height mirrors the expanded chrome + workspace row, so every row keeps an identical y in both states.
- On the rail, stable destinations (launchers, Files, Apps) show their icon; dynamic instances (activities) show a 1-2 char monogram derived from their title with a status-dot overlay, in the same order as the expanded tray, full title via native hover tooltip.
- Activity pane and Editor collapse to 44px rails that show title/meta and restore on click. Railed panes stay mounted — no state loss.
- Invariants: at least one pane always expanded; never two content rails at once (collapsing one restores its sibling); the first expanded pane header owns the restore controls for rails to its left; if everything is railed, recover to an expanded activity pane.
- Chrome: edge-to-edge, no canvas moat, no rounding on panes or rails. The collapsed rail is a flush chrome-high slab that melts into the neighbouring pane header — one continuous L of chrome wrapping the pane. Depth comes from the chrome → chrome-high → surface gradient and 1px hairline dividers. Resize handles are 6px with a persistent hairline that lifts to accent on hover. On macOS the expand button bridges past the traffic lights (14px inset, aligned to the lights' 20px grid).
- All pane headers share one grammar: Previous, Next, Expand/Restore, Collapse-to-rail.

## Kernel systems

1. **Terminal activities.** Rust PTY (`pty.rs`) + xterm surface, restructured from horizontal tabs inside `TerminalPanel.vue` to one activity per sidebar entry.
2. **CLI agent sessions.** Quick-launch presets (agent binary + preconfigured flags, defined in a hackable config file). Status tracking ported as a concept from mim-os `agentStatus`: working / done / needs input. Agent sessions persist scrollback across restarts and resume where the CLI supports it; plain terminals are ephemeral. `mimx` on PATH inside every spawned terminal.
3. **MCP tool server + mimx.** The expansive capability spine, already live (`tool_server.rs`, port 17532; `bin/mimx.mjs`). It grows into a dynamic, discoverable registry for editor, comments, files, shell, web, apps, routines, and future integrations such as Slack, Granola, and email. Mim-launched agents connect automatically; apps can both call and contribute tools; `mimx` remains the direct CLI over the same actions. Port the excellent registry, discovery, dynamic app-tool, and agent-connection ideas from mim-os without its permission, audit, trace, trust-review, or settings ceremony. Issues and knowledge graph leave the core and return as apps or tools.
4. **Editor.** Markdown, CodeMirror 6. Keeps: inline AI (Cmd+K), ghost autocomplete, diff / proposal review, comments, and the in-editor live markdown preview (`codemirror/livePreview.js` — Typora-style rendering inside the document). Comments are load-bearing for team interaction; the UI is an open question (see below). The Rust AI slice (`ai.rs`, `ai_proxy.rs`, `ai_keys.rs`, `ai_models.rs`) survives solely to power ghost + inline AI.
5. **Files activity.** Better than mim-os: last-edited-first listing, Rust-fast content search (`file_search.rs`), full keyboard navigation (arrows + return to open), and a global Cmd+P quick-open jump.
6. **Apps.** Anything goes. An app is a sidebar entry that opens in the activity pane (iframe/webview) or does whatever it wants: own Tauri window, spawned processes, bundled binaries or Rust helpers. No manifest ceremony, no permission gate — apps talk straight to the MCP tool server (thin JS SDK as convenience only). Team-internal, hackable by design.
7. **Routines.** Schedule-only. File-defined standing prompts (cron expression + agent preset + prompt). Each firing spawns a headless CLI agent run (e.g. `claude -p`) that appears in the sidebar as a normal activity with status and scrollback. File-watch / webhook / Slack triggers only if a real need appears.
8. **Settings.** Minimal: theme, fonts, editor prefs, launcher presets, API key for ghost/inline.

## Kill list

From this repo (prune):

- Panel chat UI and chat-only orchestration (`chatTransport`, `recovery`, `systemPrompt`, `workspaceMeta`, chat stores and prompting). Retain and consolidate the minimal provider transport, model selection, context escaping, usage normalization, and error handling currently shared by inline AI and ghost (`sdkAdapter`, `bridgeFetch`, `context`, `errors`, `modelControls`).
- Board/kanban, skills system (CLI agents bring their own skills), old apps platform (replaced), web portal, telemetry, `appUpdater`
- Citations/references: `references.rs`, `bibtexParser`, `citationFormatter`, `codemirror/citations.js`, refs sidebar
- DOCX pipeline: reader, writer, `annotateDocx`, `docx_worker.rs`, .NET sidecar
- Export: `export/docx.js`, `export/pdf.js`, `typst_export.rs`, `complianceReport.js`
- Audit + usage ledger: `audit.rs`, `usage.rs`, `services/audit.js`
- Already-dead files: `RewriteOverlay.vue`, `rewrite.js`, `codemirror/references.js`, dead Rust commands
- Preview pane + outline (confirmed): `PreviewPane.vue`, `SidebarOutline.vue`, `codemirror/outline`, plus their companions (`useScrollSync`, `useDeferredMarkdownPreview`). The in-editor live markdown preview (`codemirror/livePreview.js`) stays — it is a kernel editor feature, not part of this prune.

Never port from mim-os:

- Teams, permission gate / trust review, trace stream, telemetry, subagents, Slack listener, Google integrations (later as MCP tools if needed), export pipelines, DOCX review, local file history, workspace contract ceremony, release matrix / auto-update

## Open questions

1. **Comments UI.** Storage is fixed: the existing inline pseudo-XML `<comment>` and `<reply>` annotations inside Markdown remain the canonical model. The open question is presentation only: rail (this repo) vs GitHub-style inline threads with collapse/expand. Leaning inline; prototype approved — build it with excellent micro-interactions (minimize/expand discussions) before committing either way.
2. **MCP tool catalog.** Which integration tools (Slack, Granola, email, web search) and when. The existing `searchWeb` tool (OpenAlex/CrossRef/arXiv) stays until reviewed.
3. **App SDK contract.** Probably: apps hit the MCP HTTP server directly; a thin injected SDK for convenience. Decide when building the first app.
4. **Naming / storage rename.** Per roadmap guardrail: one coordinated pass (`~/.mim`, `mim:` keys, `mim://` events) only after pruning stabilises.

## Build order

1. Prune (kill list above), keeping the app runnable after every pass.
2. Layout foundation, HIGH PRIORITY: perfect port of the mim-os collapse model (see Shape) with the sidebar restructured to the vertical activity model. This lands before any other surface work — every later system mounts into it.
3. Agent sessions: presets, status, persisted scrollback.
4. Files activity + Cmd+P.
5. Apps: launcher + iframe host + escape hatches.
6. Routines: scheduler + headless runs as activities.
7. Comments UX rework (inline-threads prototype can run in parallel any time; it only touches the editor).
