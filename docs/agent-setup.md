# Agent setup

Mimir detects Codex, Claude, Pi, and Gemini from the login-shell `PATH`.
Installed, enabled presets appear as launchers; unavailable clients keep their
diagnostic in Settings > CLI tools.

## Presets

Presets live in `~/.mimir/launchers.json`:

```json
{
  "version": 1,
  "presets": [
    {
      "id": "codex",
      "title": "Codex",
      "kind": "agent",
      "agentId": "codex",
      "enabled": true,
      "args": [],
      "env": {},
      "cwd": { "mode": "workspace" }
    }
  ]
}
```

`agentId` is `codex`, `claude`, `pi`, or `gemini`. An optional `binary`
overrides detection. Terminal presets use the platform shell unless `binary` is
set.

`cwd` is `workspace`, `home`, or an absolute `custom` path. Every `args` value
is one argv entry; no shell command is reconstructed. `env` is merged into the
child environment.

Existing version-1 files are preserved rather than rewritten when new built-in
agents appear. Add Gemini once in Settings if an older file does not contain
its preset.

## Connection

Every launched Activity receives:

- an activity-scoped `MIMIR_MCP_URL`;
- `MIMIR_ACTIVITY_ID` and `MIMIR_AGENT_ID`;
- `~/.mimir/bin` on `PATH`.

Mimir adds one product-owned connection unless the preset already supplies it:

| Client | Connection |
|---|---|
| Codex | `mcp_servers.mimir_workbench.url` one-run override |
| Claude Code | additional inline `mimir_workbench` HTTP definition |
| Pi | `~/.mimir/pi/mimir-tools.ts` extension |
| Gemini CLI | owned `mimir_workbench` stdio-proxy settings entry |

Unrelated client configuration is preserved. The Gemini entry reads the
launch's environment variable, so settings never store an activity ID. A
collision with an unrelated entry using the same product-owned name is an
error, not an overwrite.

Pi performs the MCP handshake, dynamically registers the lean tool set, and
adds the one-line Mimir instruction once. The shared instruction asks every
supported CLI agent to call the scoped `mimir_title` tool on its first
substantive turn. This call can improve Mimir's provider-neutral local title
fallback, but title creation does not depend on the call. `/mimir-refresh`
rediscovers the currently exposed set.

Continuations retain the Activity's recorded launch policy, including model,
permission, and tool flags, while refreshing the launcher executable and
activity-scoped MCP provenance. They pass the exact recorded provider session
id; Mimir never uses latest/last/implicit continue for History resume. Routine
launches also receive scoped provenance.

## Skills

Before launch, Mimir resolves catalog, personal, and current-project skills
into retained read-only revisions:

- Codex and Gemini discover catalog/personal links in `~/.agents/skills`;
- Claude receives a generated `.claude/skills` snapshot through `--add-dir`;
- Pi receives shared links plus repeated `--skill <SKILL.md>` project paths.

Codex and Gemini currently have no clean per-launch project-skill root.
Project skills use `mimir skill <query>` there; Mimir does not modify the repo
or replace the client's home directory.

See [Agent interface](agent-interface.md) for scope and compatibility
decisions.

## Resolution boundary

Opening/reloading CLI Settings refreshes detection. Ordinary launches reuse the
cached result. Terminal presets and presets with an exact custom binary do not
run unrelated client probes.

`launcher_resolve` validates the preset, chooses command/cwd, prepares skills,
and returns exact argv/env. `activityRuntime` then applies run or resume
identity before spawn.

Files that must agree:

- `src-tauri/src/launchers.rs`
- `src/stores/activityRuntime.js`
- `src/services/launchers.js`
- `bin/mimir.mjs`
- `bin/mimir-skills.mjs`
- `bin/pi-mimir-extension.ts`
- `src-tauri/src/mimir_cli.rs`

## CLI

See [agent-interface.md](agent-interface.md) for the full CLI discovery
surface and tool catalog.
