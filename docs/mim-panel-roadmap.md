# Mim Panel Roadmap

Mim Panel is a terminal-first side project forked from mim terminal. The product shape is a multi-tab terminal beside the existing editor, plus a thin `mimx` control API for Codex, Claude Code, and other terminal agents.

## Current Baseline

- Default app route mounts `src/mim/MimPanel.vue`.
- Old panel remains available at `?view=panel` for fallback while pruning.
- Editor is reused whole via `src/editor/App.vue`.
- Terminal is reused via `src/panel/components/TerminalPanel.vue` with side-dock support.
- `mimx` CLI calls the local MCP endpoint and editor-control tools.

## Guardrails

- Keep the app runnable after every pruning pass.
- Prefer zombie code over missing hidden dependencies until the terminal/editor/control loop is stable.
- Do not rename `mim://` events, `mim:` localStorage keys, or `~/.mim` paths piecemeal. Migrate them only as a coordinated pass.
- Keep `mimx` as the ground-truth control surface; MCP wraps the same actions.

## Next Milestones

1. Verify the Tauri shell end to end:
   - terminal spawns a real PTY
   - editor opens/saves files
   - `mimx active`, `mimx tabs`, `mimx content`, and `mimx save` work

2. Improve terminal ergonomics:
   - add Codex and Claude terminal profiles
   - ensure `mimx` is on PATH inside spawned terminals
   - persist terminal tab layout if useful

3. Harden editor-control API:
   - line/offset reveal behavior
   - full document replacement
   - selection replacement
   - conflict behavior for unsaved user edits

4. Add optional MCP setup docs:
   - Claude Code config
   - Codex CLI usage
   - direct `mimx` examples

5. Prune one subsystem at a time:
   - chat UI
   - board/project home
   - apps/workflows runtime
   - references/citations if not needed
   - DOCX/export if not needed
   - audit/usage ledger
   - AI provider/model registry

6. Rename storage/protocols only after pruning:
   - `~/.mim`
   - `mim:` localStorage keys
   - `mim://` events
   - Rust package/library names if still worthwhile
