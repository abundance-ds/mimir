# mim terminal

Part of mim, the AI-native OS for companies.

## Product Context

**mim terminal** is a two-surface desktop tool for research teams:

- The **Editor** (Where you *plan* and *review* work) is a Markdown editor (citations, inline AI, comments, diff review, export). 
- The **Panel** (Where you *direct* work) is an agent orchestrator (streaming AI chat, tool use, file proposals, context-window donut, unified composer, inline approval mode picker). 

Together they replace the Word + ChatGPT copy-paste loop and enable non-technical teams to use ultra capable agentic workflows.

Desktop-only. Local-first. File-based. Built with Tauri v2 + Vue 3 + CodeMirror 6.

**Audience**: teams of research consultants in HEOR, RWE, health economics, biotech, and pharma.

The website lives in [shoulders-ai/mim-web](https://github.com/shoulders-ai/mim-web), the minimal Nuxt site for `mim.shoulde.rs`. It presents mim OS, links to current release downloads, and keeps the invite-only surface intentionally sparse.


## Product Philosophy

mim terminal is part of the enabling infrastructure research teams need to adopt AI-native workflows. It is supposed to be a home for agentic workflows and integrations, for creating plans and reviewing artefacts. At the same time, it is supposed to remain lean, simple, light and easily hackable.

mim terminal is built in response to fundamental hypotheses about the changing nature of research and research-adjacebt work:

1 AI won't be a feature, but the medium, integrated as an intelligence layer across organisations.

2 Work will shift from *execution*-heavy, to *planning* and *reviewing***. Previously, an implicit tenative plan and could be fleshed out during long and iterative stretches of execution. With AI, execution collapses. Now, more effort and thought needs to go into planning (looking ahead, understanding objectives, ideally writing down success criteria and tests) and reviewing. 

3 Users will interface with various sync and async AI systems (e.g. autonomous general-purpose agents vs semi-deterministic task specific workflows; high-token vs low-token vs no-token, etc).

4 Users will need to become proficient in steering AI systems, but product design must make AI superpowers more accessible and legible.

5 At the moment, no one knows what the best interfaces for AI systems look like. It is likely malleable, more bespoke and custom to the users and the task than previous software. Adaptability and agility will be key during this period.

6 Software "code" is written and reviewed by AI. Engineers will become managers and system architects. Everyone else will be empowered to build software.

7 A main barrier remain legacy formats and systems built for humans. During the transition to a more agent-accessible environments, pragmatic solutions need to be found. Ultimately, processes will become AI-native.


## Approach and values

- **Radical focus on UX**: Apply Don Norman's extreme focus on correct UX.
- **Demonstrate Craft**: Take inspiration from brands such as Braun, Stripe, Linear, and Nothing, but transform it into a more optimistic, humanist design concept. 
- **Design Principles**: Follow the system outlined in [docs/design-system.md](docs/design-system.md)



## Voice & Copy

- Declarative. Descriptive, not promotional.
  - No "AI-powered," no "AI-assisted." Describe what the product does or the objectives it achieves.
- Unpretentious but technically accurate. Assumes intelligence.
- No "AI-powered"; no "–"; no ":"; no "It is not [small thing], it is [big thing].

| Should feel | Should not feel |
|---|---|
| Capable | Flashy |
| Precise | Sterile |
| Accessible | Cozy |
| Professional | Corporate |
| Fast | Rushed |
| Designed | Decorative |

## Naming

- **mim terminal** = product.
- Primary window (label `main`): the Panel. Opens on launch.
- Editor windows (labels `editor-*`): opened on demand.
- Internal package/Cargo names are `mim-terminal`. localStorage keys use `mim:` prefix.

## Coding Conventions


**TDD.** Tests are co-located: `foo.js` tested by `foo.test.js` in the same directory. Write the test file first with failing tests that describe the contract, then implement until they pass.

**Testing rules.** Mock only at system boundaries (Tauri invoke, `@ai-sdk/vue`). Use real Pinia stores. No snapshot tests. Run: `bun run test`.

**Styles.** Tailwind v4 with design tokens in `src/shared/styles/app.css`. Use utility classes (`text-ink-3`, `bg-chrome-mid`, `border-rule-light`), not `var()` in templates. Reserve `<style>` blocks for: `@keyframes`, vendor-prefixed properties, `:deep()` selectors for CM6/markdown content.

**IMPORTANT**: USE TAILWIND! EVEN IF THE COMPONENT ALREADY HAS SOME 

**Interaction.** Native desktop cursor conventions: no `cursor: pointer` on any control (arrow cursor everywhere). Pointer cursor is only for `<a>` hyperlinks. Every clickable element must have a `hover:bg-*` background change as its affordance. See `docs/design-system.md` §7 for the full interaction contract.

**State.** Vue 3 Composition API. Pinia setup stores. Strongly prefer using stores directly over emits or prop drilling — if a store exists for the data, import it in the child component. Props/emits are for truly local parent→child contracts only. Import `useSettingsStore()` directly — no provide/inject. Settings store is shared across windows.

**File I/O.** All file access goes through Tauri invoke wrappers. Never use Node fs or browser File API.

**Docs.** When changing a subsystem, update the relevant doc and `docs/_MAP.md`. Docs describe current state, not history. Git tracks what was deleted. Never put counts that change over time into docs (number of tests, line counts, number of tools/stores/models/components). These go stale immediately and create maintenance noise.

**AI-native coding.** AI *owns* the code and the docs. Humans do not read the docs. It is for AI agentic self-organisation only.

**Ownership.** Every coding agent is responsible for the entire repo, not just their current task. "Pre-existing" and "out of scope" are not excuses to leave broken or suboptimal code untouched. If you encounter an issue — stale docs, missing tests, dead code, a bug — fix it if small, or log it in `docs/issues.md` if it requires a separate effort. Act as if you are CTO: nothing is someone else's problem.

**AI tools.** When defining tools with the Vercel AI SDK `tool()` function, ALWAYS use `inputSchema` — NEVER `parameters`. Using `parameters` silently breaks Anthropic (400 error: `input_schema.type: Field required`). See `docs/gotchas.md`.

**No screenshots.** Never attempt to take screenshots via `screencapture`, `osascript`, or any other tool. When verifying UI changes, describe exactly what needs checking and ask the user to confirm visually.

**No backward compatibility.** Zero users, zero deployments. Never write migration code, backward-compat shims, version checks, or legacy fallbacks. Just change it. This includes data formats, settings keys, API shapes, file structures — everything. If something changes, old data is dead.


## Quick Start

```bash
bun install
bun run build
cargo check --manifest-path src-tauri/Cargo.toml
bun run test
bun run tauri dev
```

If Tauri opens stale code, check for a leftover Vite server on port 1420: `lsof -nP -iTCP:1420 -sTCP:LISTEN`

## AI Key Setup

Debug builds: Rust key resolver reads `.env` in repo root, then `~/.mim/keys.env` as fallback. Production uses OS keychain.

## Navigation

- Start at [docs/_MAP.md](docs/_MAP.md) for file paths and system lookup. 
- Read [docs/gotchas.md](docs/gotchas.md) for non-obvious constraints.
- Whenever you work on frontend / UI, check [docs/design-system.md](docs/design-system.md)
