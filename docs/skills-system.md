# Skills System

File-based expertise packages that extend the AI with domain-specific instructions.

## What Skills Are

A skill is a folder in `~/.shoulders-v3/skills/` containing a single `SKILL.md` file. The file has YAML frontmatter (metadata) and a markdown body (the prompt the AI receives). Skills follow the [agentskills.io](https://agentskills.io) standard.

Skills are different from Apps. Skills are prompt instructions (the agent reads guidance). Apps are standalone UI tools (the agent writes code, the user runs it). See [apps-system.md](apps-system.md).

## SKILL.md Format

```
---
name: peer-review            # required
description: Multi-agent...  # required
maxSteps: 10                 # optional, default 8
maxOutputTokens: 8000        # optional, default 1800
---

<skill name="peer-review">
Your prompt instructions here. The AI receives this body
when the skill is activated.
</skill>
```

Convention: wrap the prompt body in `<skill name="...">...</skill>` tags.

Frontmatter parsing: `parseFrontmatter()` in `src/services/skills/loader.js`. Numeric fields (`maxSteps`, `maxOutputTokens`) are coerced to numbers.

## Progressive Disclosure

Not all skill prompts are injected at once. The system uses two tiers:

1. **Catalog** -- `systemPrompt.js` injects an `<available-skills>` block into the system prompt listing each skill's `name` and `description` only.
2. **Full prompt** -- loaded on demand when the AI reads `@skills/{id}/SKILL.md` via the `@` path handler, or when a user pre-selects a skill.

This keeps the base system prompt small while letting the AI discover and activate skills as needed.

## Activation Modes

| Mode | Trigger | Mechanism |
|------|---------|-----------|
| Explicit (pre-selected) | User picks a skill in NewChat dropdown or via `@` mention | Full prompt injected in system message before first send |
| Implicit (AI-initiated) | AI reads catalog, decides task matches a skill description | AI reads `@skills/{id}/SKILL.md` to load full instructions |
| Mid-conversation | User types `@skill-name` in ChatView composer | Skill attached to session, prompt injected on next send |

## Bundled Skills

Three skills are seeded on first launch via `src/services/skills/bundled.js`:

| ID | Purpose | maxSteps | maxOutputTokens |
|----|---------|----------|-----------------|
| `app-builder` | Builds standalone HTML+JS+CSS apps in native desktop windows | 12 | 16000 |
| `peer-review` | Multi-agent academic manuscript review with 5 evaluation dimensions | 10 | 8000 |
| `shoulders` | App manual and contextual help placeholder | (default) | (default) |

Seeding logic: `seedDefaultSkills()` in `loader.js`, called from `persistence.js` on first mount.

## User Management

Settings > Tools > Skills section (`ToolsSection.vue`):

- **List** with enable/disable toggles (writes to `disabledSkills` in settings store)
- **Import Folder** -- copies a folder containing `SKILL.md`
- **Import File** -- copies a `.md` file, creates folder, renames to `SKILL.md`
- **Create New** -- generates template `SKILL.md`, opens in Editor
- **Remove** -- deletes skill folder from disk

## Per-Project Overrides

Project Home > Permissions > Skill access (`ProjectHome.vue`):

- Per-project disable toggles for individual skills
- Merges with global `disabledSkills` (union of both sets)
- Override indicator dot when project config differs from global defaults

## Config Resolution

When a skill sets `maxSteps` or `maxOutputTokens`, those values override the defaults:

```
resolveSkillConfig(session, field):
  1. If session has a skill with metadata[field] set -> use it
  2. If session has a projectId -> use project defaults (12 / 16000)
  3. Otherwise -> use base defaults (8 / 1800)
```

Implementation: `resolveSkillConfig()` in `src/stores/panel/chat.js`.

## Session Persistence

The `session.skill` field is persisted in `snapshotSession()` and restored on load, so a skill-attached session survives app restart.

## Architecture

| Component | File |
|-----------|------|
| Loader (discover, import, create, remove, seed) | `src/services/skills/loader.js` |
| Bundled defaults | `src/services/skills/bundled.js` |
| Pinia store | `src/stores/panel/skills.js` |
| `@skills/` path handler | `src/services/ai/tools/pathHandlers.js` |
| System prompt catalog | `src/services/ai/systemPrompt.js` |
| Config resolution | `src/stores/panel/chat.js` (`resolveSkillConfig`) |
| NewChat UI | `src/panel/components/NewChat.vue` |
| ChatView `@` attachment | `src/panel/components/ChatView.vue` |
| Settings UI | `src/shared/ui/settings/ToolsSection.vue` |
| Project overrides | `src/panel/components/ProjectHome.vue` |
| Seeding + persistence | `src/stores/panel/persistence.js` |
| Settings key | `disabledSkills` in `src/stores/settings.js` |

## Future / Not Yet Implemented

- Project-scoped skills (`.shoulders/skills/`)
- Skill versioning
- Install from URL
- AI-assisted skill creation
