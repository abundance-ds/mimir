# Mimir agent interface

Status: product decision and implementation direction

## Principle

Give agents the smallest amount of information that changes what they do.

Agents already understand shells, tools, MCP, JSON, files, and skills. Mimir
must not explain those concepts. It should expose the few Mimir-specific entry
points, then provide exact information only when the agent asks for it.

Every word in agent context has a cost. Every extra command has a cost too. The
goal is not the smallest prompt or the smallest CLI in isolation; it is the
shortest reliable path from intent to a correct action.

This leads to four rules:

1. Put only routing information in permanent agent context.
2. Put operation-specific requirements at the operation boundary.
3. Prefer one shared interface across agents over client-specific tutorials.
4. Add machinery only after it removes observed failures or round trips.

## Product model

Mimir has three agent-facing entry points:

```text
Mimir: `mimir tool <query>` · `mimir skill <query>` · `mimir doctor`
```

That is the complete global instruction. Do not add an explanation of MCP, the
tool registry, skill scopes, aliases, schemas, or client integration.

The resulting workflow is:

```text
discover an operation  -> mimir tool <query>
discover a workflow   -> mimir skill <query>
diagnose the runtime  -> mimir doctor
```

The discovery result provides the next executable command. The agent should
not need a tutorial or a complete catalog dump.

## CLI

### `mimir tool <query>`

This is the single discovery command for Mimir operations.

An exact canonical name or alias prints:

- one-sentence purpose;
- required inputs;
- optional inputs;
- constraints that cannot be inferred from the type;
- one ready-to-run `mimir call`;
- an example only when the schema is not enough.

Accept dotted and underscore names, but display one public name. Names are an
input compatibility concern, not something agents should have to reason about.

Example:

```text
knowledge_create — Create a knowledge record

Required:
  title: string

Optional:
  body: string
  scopeId: string
  redactFromContext: boolean
    Excluded from automatic context; direct reads still return it.

mimir call knowledge_create '{"title":"..."}'
```

A non-exact query returns at most five ranked names with one-line
descriptions. A single strong result expands immediately to the focused view
above. Do not make the agent search and then read when one command can safely
do both.

`mimir call <tool> --help` returns the same focused view. Help is parsed before
network access, and flags are never treated as tool names or search text.

Bulk catalog output remains available for development and diagnostics, but is
not advertised in agent context.

### `mimir call`

`mimir call` executes the operation returned by `mimir tool`.

Before a mutation, it validates the complete input and returns all validation
errors together. Invalid input must never produce a partial mutation.

Schemas should contain real constraints and defaults. Descriptions should
explain only non-obvious semantics. Do not add examples to obvious string or
boolean fields, generic output schemas that repeat readable output, or a
generic dry-run system.

Errors should preserve the useful cause. A connection refusal, timeout,
permission error, invalid URL, unknown tool, and invalid input are different
problems and must not collapse into one message.

### `mimir doctor`

`mimir doctor` is a small recovery command, not a tutorial:

```text
Mimir OK
Endpoint   reachable
Context    attached
Scopes     private, project
Tools      89
```

On failure it shows the actual cause and one useful remedy. Normal output does
not expose activity IDs, agent IDs, tokens, or full endpoint query strings.
Verbose diagnostics may include them explicitly.

The command checks only what helps isolate a failure:

- endpoint and protocol handshake;
- attached activity context;
- available graph scopes;
- registry availability.

## MCP

MCP is the transport and capability registry behind the CLI and direct editor
tools. It is not the agent documentation surface.

Frequent editor operations remain directly exposed to connected agents. The
larger registry remains available through `mimir tool` and `mimir call`.
Codex, Claude, Pi, and Gemini should receive the same Mimir contract; they
should not receive separate prose explaining how Mimir works.

The permanent instruction must not say that Mimir initially exposes only
editor tools. That is an implementation detail and does not help complete a
task.

The server and launcher still need to be correct even when those details are
invisible to the agent:

- use a Mimir-specific server ID that cannot merge with a user's unrelated
  configuration;
- add Mimir without suppressing unrelated client configuration;
- preserve activity and agent provenance when a session resumes;
- validate HTTP `Origin` on the loopback endpoint;
- use bounded timeouts and preserve network causes;
- avoid printing sensitive endpoint metadata by default;
- perform a valid protocol handshake;
- keep aliases, validation, structured errors, and revisions canonical in one
  registry.

## Skills

### What Mimir owns

A skill is a standard skill package:

```text
release-review/
├── SKILL.md
├── scripts/
└── assets/
```

Mimir discovers, stores, matches, and materializes skills. It does not
interpret the workflow or execute its scripts. The agent reads the skill and
performs the work using its normal tools and permissions.

Do not invent a Mimir-specific skill format. `SKILL.md` and its relative files
must remain usable outside Mimir.

### Skill scopes

Mimir has three writable skill scopes:

| Scope | Owner | Availability | Intended use |
|---|---|---|---|
| Catalog | Team | Every project | Shared reusable workflows |
| Personal | User | Every project | Private or experimental workflows |
| Project | Repository | That repository | Repo-specific workflows |

The catalog is the primary shared library for a 2–10 person team. It is not a
read-only marketplace. Team members can create and update catalog skills.

Opening a new project immediately provides:

```text
catalog + personal + current project
```

No skill is copied from one project to another. Mimir stores the canonical
packages and materializes a local revision snapshot when an agent needs them.
Scripts and assets therefore exist at stable relative paths without making
the cache the source of truth.

Unqualified resolution is:

```text
project -> personal -> catalog
```

The selected source is visible:

```text
release-review [catalog]
deploy-api     [project]
my-writing     [personal]
```

Scope is explicit when writing:

```bash
mimir skill add ./release-review --catalog
mimir skill add ./deploy-api --project
mimir skill add ./my-writing --personal
```

An explicit scope can resolve a collision:

```bash
mimir skill personal:release-review
```

### Skill CLI

Avoid separate match and read steps.

```bash
mimir skill <query>
```

- An exact name prints the skill.
- A task description returns the strongest matching skill.
- An ambiguous query returns at most five matches.
- A selected remote skill is materialized before its `SKILL.md` is printed, so
  referenced files are usable.

Additional commands are operational:

```bash
mimir skills
mimir skills refresh
```

`mimir skills` lists the visible merged set. `mimir skills refresh` updates the
local snapshot. Neither is a required preliminary call.

### Native discovery

Native skill discovery is the primary path. Agents should not have to remember
to query Mimir before a relevant skill can trigger.

At launch Mimir:

1. resolves catalog, personal, and current-project skills;
2. applies scope resolution;
3. materializes a read-only local snapshot of standard skill packages;
4. makes that snapshot available through the client's native skill mechanism.

The intended disclosure model is:

```text
Mimir skill store
        |
        v
visible revision snapshot
        |
        v
client-native name/description discovery
        |
        v
full SKILL.md loaded only when selected
```

`mimir skill <query>` remains the explicit fallback for native matching misses,
large catalogs, debugging, and direct user requests. Mimir remains the source
of truth; native directories are projections, not independent installations.

Client integration must follow verified client behavior. Do not assume that a
directory or refresh mechanism supported by one agent exists in another.

## Client compatibility

This section records verified behavior for the supported CLI agents. It must be
updated when an agent changes its discovery contract.

| Client | Native standard skills | Arbitrary session directory | Live refresh | Mimir integration |
|---|---|---|---|---|
| Codex | Verification pending | Verification pending | Verification pending | Verification pending |
| Claude Code | Verification pending | Verification pending | Verification pending | Verification pending |
| Pi | Verification pending | Verification pending | Verification pending | Verification pending |
| Gemini CLI | Verification pending | Verification pending | Verification pending | Verification pending |

If a client cannot consume a generated native skill snapshot without modifying
the repository or permanent user configuration, use the smallest supported
adapter. The fallback is always `mimir skill <query>`; do not fake native
support by injecting every skill body into the prompt.

## Documentation policy

The CLI should teach its own operations at the moment they are needed.

Agent context contains only the three routing commands. Human documentation
should cover installation, connection troubleshooting, trust, skill ownership,
and privacy behavior. It should not duplicate every tool schema or teach
agents generic shell and MCP concepts.

Sensitive behavior must be named precisely. A field called `sensitive` implies
more protection than context redaction provides. Prefer:

```text
redactFromContext
```

Its complete useful description is:

```text
Excluded from automatic context; direct reads still return it.
```

If `sensitive` already exists, accept it as a compatibility alias without
continuing the ambiguity in new output.

## What this replaces

The current experience encourages probing:

- exact lookup by public alias can fail;
- command-level `--help` can be interpreted as data;
- useful discovery flags are hidden;
- bulk JSON output is too large;
- validation errors arrive incrementally;
- network failures lose their cause;
- two visible naming forms make agents reason about implementation details;
- privacy behavior must be inferred from a free-form property;
- client launch and resume paths do not preserve one reliable contract.

The answer is not more global instruction. It is focused discovery, correct
parsing, complete validation, truthful errors, and just-in-time semantics.

## Acceptance test

Test the same unfamiliar task in Codex, Claude, Pi, and Gemini:

1. discover the required Mimir operation or skill;
2. execute it with valid input;
3. verify the result.

Success means:

- two useful calls for an exact or strong query;
- at most three calls for an ambiguous query;
- zero failed or partial mutations;
- no complete catalog dump;
- no client-specific tutorial;
- a relevant native skill can trigger without a preliminary Mimir CLI call;
- scripts and assets resolve from the materialized skill revision.

Measure tool calls and failures. Do not add new prompts, commands, indexes, or
client adapters unless the evaluation shows what they remove.

## Implementation order

1. Implement focused `mimir tool <query>` and route
   `mimir call <tool> --help` to it.
2. Fix help parsing, alias matching, complete validation, timeouts, and useful
   connection errors.
3. Add lean `mimir doctor`.
4. Replace current agent prose with the single routing line.
5. Implement canonical skill storage, the three scopes, and
   `mimir skill <query>`.
6. Materialize merged skill revisions and connect them to each verified native
   discovery mechanism.
7. Remove repeated Pi prompt snippets and any duplicate client tutorials.
8. Fix launcher identity, configuration merging, resume provenance, and HTTP
   origin handling.
9. Run the four-client acceptance test before adding further discovery
   machinery.

