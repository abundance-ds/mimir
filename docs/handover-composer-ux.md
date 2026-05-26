# Handover: Panel Composer UX Refactor

## What was done

A Don Norman-inspired UX refactor of the Panel's Composer (chat input) and surrounding elements. The work addressed 12+ issues across consistency, visibility, affordances, and progressive disclosure.

## Motivation

The Composer had accumulated UX debt: two divergent input implementations (NewChat used `<input>`, ChatView used `<textarea>`), stale branding ("Ask Shoulders Panel..."), redundant status chrome, opaque picker labels, no token usage visibility, and no inline access to the AI approval mode. The refactor unifies the experience and adds progressive disclosure for power-user information.

## Changes by area

### Composer component (`src/panel/components/Composer.vue`)
- **Unified**: Both NewChat and ChatView now import the same Composer component
- **Slot**: Added `#prepend` named slot (used by NewChat for skill chips)
- **Exposes**: `focus()` method and `draft` ref (used by NewChat for `@` autocomplete)
- **Props added**: `contextPercent`, `contextTokens`, `contextWindow`, `showUsageIndicators`
- **Removed**: Status line (`.composer-status`, status dot, all animations), standalone cost label
- **Added**: ContextDonut (with cost in tooltip), fallback cost text for old sessions
- **Changed**: Placeholder → "Ask anything. Use @ to mention skills or files", bottom padding reduced from 16px to 4px

### NewChat (`src/panel/components/NewChat.vue`)
- **Rewritten**: Now uses shared `<Composer>` component instead of inline markup
- **Removed**: All scrollable lists (skills sections, workflows sections, recents)
- **Added**: Compact "Skills ▾" dropdown trigger below-right of composer (shows skills + workflows)
- **Layout**: Single-viewport centered hero (overflow: hidden, no scroll)
- **Kept**: `@` autocomplete dropdown, project picker, skill chip via `#prepend` slot
- **Draft watching**: Uses `composerRef.value?.draft` (exposed ref) for `@` search

### ChatView (`src/panel/components/ChatView.vue`)
- **Removed**: Dead empty state code (unreachable — `showChat` requires messages > 0)
- **Added**: Below-composer row with project name (read-only) and approval mode picker
- **Added**: Context donut props wired (contextPercent, contextTokens, contextWindow, showUsageIndicators)
- **Approval mode**: Inline dropdown (strict/normal/auto) — reads from project override or global settings, writes back to same

### ModelPicker (`src/panel/components/ModelPicker.vue`)
- **Icons**: Colored provider icons replace text section headers. Trigger shows `[icon] Model Name [▾]`
- **Dropdown**: Flat list with inline provider icons per row, subtle group separators
- **"Default"**: Auto model renamed from "Auto" to "Default", dropdown shows resolved model name in parentheses
- **Icons location**: `src/shared/icons/IconProviderAnthropic.vue` (fill `#D97757`), `IconProviderGoogle.vue` (Gemini gradient), `IconProviderOpenAI.vue` (`currentColor`)

### ControlPicker (`src/panel/components/ControlPicker.vue`)
- **Removed**: "Control:" kicker label from trigger. Just shows the value + chevron now.

### ContextDonut (`src/panel/components/ContextDonut.vue`) — NEW
- Small SVG donut (16px) showing context window fill %
- Color thresholds: <60% ink-4, 60-85% accent, >85% rem
- Styled hover tooltip (instant, CSS-only): "Context: 24k / 200k (12%)" + "Cost: $0.42"
- Props: `percent`, `size`, `tokenCount`, `contextWindow`, `costLabel`

### Session tracking
- **`lastInputTokens`** field added to session objects — stores the most recent API call's input token count (= current context window usage)
- Set in `onUsage` callback (`src/stores/panel/chat.js`)
- Initialized in `createSession` (`src/stores/panel/sessions.js`)
- Persisted in `snapshotSession` (`src/stores/panel/persistence.js`)
- Old sessions without `lastInputTokens` show fallback cost text instead of donut

### Model controls (`src/services/ai/modelControls.js`)
- Auto model entry: `name` and `displayName` changed from "Auto" to "Default"

## Files modified (complete list)

| File | Type |
|------|------|
| `src/panel/components/Composer.vue` | Major edit |
| `src/panel/components/Composer.test.js` | Updated |
| `src/panel/components/ChatView.vue` | Major edit |
| `src/panel/components/ChatView.test.js` | Updated |
| `src/panel/components/NewChat.vue` | Rewritten |
| `src/panel/components/NewChat.test.js` | Rewritten |
| `src/panel/components/ModelPicker.vue` | Major edit |
| `src/panel/components/ControlPicker.vue` | Minor edit |
| `src/panel/components/ContextDonut.vue` | New file |
| `src/panel/components/ContextDonut.test.js` | New file |
| `src/shared/icons/IconProviderAnthropic.vue` | New file |
| `src/shared/icons/IconProviderOpenAI.vue` | New file |
| `src/shared/icons/IconProviderGoogle.vue` | New file |
| `src/stores/panel/chat.js` | Minor edit (onUsage) |
| `src/stores/panel/sessions.js` | Minor edit (createSession) |
| `src/stores/panel/persistence.js` | Minor edit (snapshotSession) |
| `src/services/ai/modelControls.js` | Minor edit (Auto → Default) |
| `README.md` | Updated counts/descriptions |
| `docs/_MAP.md` | Updated references |

## What is NOT done (deferred)

### Phase 4: Functional `+` attach button
The `+` button in the Composer is still hardcoded `disabled`. The spec is written in the plan file (`~/.claude/plans/dapper-hugging-starfish.md`, Phase 4 section). Key requirements:
- Menu on click: File from project, Image, Skill
- Attachments as chips above textarea (use `#prepend` slot)
- Image: base64 encode, vision content part, format/size validation
- File: read at send time, not attach time
- Model must support vision for image option
- Drag-and-drop (future)
- Dependencies: `read_binary_file` exists, vision content parts need verification in AI SDK bridge

### Phase 5: Polish items
- `prefers-reduced-motion` media queries on animations (sidebar dots, etc.)
- Keyboard navigation (arrow keys) in ModelPicker and ControlPicker dropdowns
- Brief loading pulse on send button in NewChat context (250ms)

### Other observations from the UX review not yet addressed
- No visible focus indicators (`:focus-visible`) on picker triggers for keyboard users
- Mobile sidebar has no visible hamburger indicator (relies on header toggle)
- Picker dropdowns may overflow on very narrow viewports (usePopover should handle but unverified)

## Architecture notes for continuing work

### Composer slot pattern
The `#prepend` slot renders inside `.composer` above the textarea. NewChat uses it for skill chips. Phase 4 (attach button) should use it for file/image chips. The slot is simple — just a named slot with no slot props.

### Draft exposure
Composer exposes `draft` (a `ref`) via `defineExpose`. NewChat accesses it as `composerRef.value?.draft` to watch for `@` character. This is reactive through Vue 3's component ref system. If you need the draft elsewhere, it's available this way.

### Approval mode resolution
The effective approval mode is resolved in a specific order:
1. Project-level override (`project.approvalMode`) if set and not 'default'
2. Global setting (`settingsStore.aiApprovalMode`) otherwise
The ChatView inline picker writes to the project if one exists, otherwise to global settings. This matches `resolveApprovalMode()` in `src/stores/panel/chat.js` (line ~444).

### Context donut data flow
```
chat.js onUsage → session.lastInputTokens = usage.inputTokens
                                    ↓
ChatView computed: contextPercent = lastInputTokens / model.contextWindow
                                    ↓
Composer prop: contextPercent → ContextDonut prop: percent
```

For old sessions: `lastInputTokens` is 0 → `contextPercent` is 0 → donut hidden → fallback cost text shown instead.

### Provider icon convention
Icons are Vue SFCs in `src/shared/icons/` matching the Tabler icon API (`size` prop, default 14). Anthropic uses fixed fill color, Google uses a gradient with unique IDs per instance, OpenAI uses `currentColor`. Map provider strings to components via `providerIconMap` in ModelPicker.

## Plan file
Full detailed plan with rationale: `~/.claude/plans/dapper-hugging-starfish.md`

## Test commands
```bash
bun run test          # ~710+ tests, ~5s
bun run build         # Frontend build, ~7s
bun run tauri dev     # Full app with native window
```

## Visual verification checklist
- [ ] NewChat: centered hero, "What should we work on?", Skills dropdown works
- [ ] NewChat: project picker below-left, skills below-right
- [ ] NewChat → send message → transitions to ChatView cleanly
- [ ] ChatView: composer pinned at bottom, messages scroll above
- [ ] ChatView: project name + approval mode below composer
- [ ] ChatView: approval mode dropdown opens upward, changes persist
- [ ] ChatView: send a message → donut appears with context %, hover shows tooltip
- [ ] ChatView: cost in tooltip matches session cost
- [ ] ModelPicker: colored provider icons in trigger and dropdown
- [ ] ModelPicker: "Default" shown for auto model, resolved name in dropdown
- [ ] ControlPicker: no "Control:" label, just value + chevron
- [ ] Old session: no donut, but cost shown as plain text
- [ ] All themes: icons and donut colors work (parchment, glacier, slate, monokai)
