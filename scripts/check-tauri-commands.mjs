// Drift check: the renderer test mock's Tauri command allowlist
// (VALID_TAURI_COMMANDS in src/test/setup.js) must match the commands
// actually registered in src-tauri/src/lib.rs generate_handler![...].
// Drift here has caused real issues (see docs/issues.md): tests pass
// against commands that no longer exist, or reject commands that do.
//
// Usage: node scripts/check-tauri-commands.mjs   (exit 1 on drift)

import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const setupPath = path.join(root, 'src/test/setup.js')
const libPath = path.join(root, 'src-tauri/src/lib.rs')

// --- Known exceptions (TEMPORARY DEBT — remove entries as they are fixed).
// The check fails if an entry here stops being a real mismatch, so this
// list cannot silently rot.

// Commands present in the setup.js mock allowlist but NOT registered in Rust.
const KNOWN_MOCK_ONLY = new Map([
  // Still invoked by src/editor/composables/useDocumentBridge.js but never
  // registered in lib.rs; the invoke fails silently at runtime. The real fix
  // (registering the command or dropping the invoke) belongs to the editor
  // bridge owner; the mock entry keeps editor tests from tripping the
  // unknown-command guard until then.
  ['document_context_send', 'ghost: invoked by useDocumentBridge.js, no Rust command'],
])

// Commands registered in Rust but missing from the setup.js mock allowlist.
const KNOWN_RUST_ONLY = new Map([])

// --- Extraction ---

/** Return the text between the opening bracket at `start` (index of '[')
 *  and its matching ']' in `source`. */
function bracketBody(source, start, label) {
  let depth = 0
  for (let i = start; i < source.length; i++) {
    const ch = source[i]
    if (ch === '[') depth++
    else if (ch === ']') {
      depth--
      if (depth === 0) return source.slice(start + 1, i)
    }
  }
  throw new Error(`unbalanced brackets while parsing ${label}`)
}

function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

function mockCommands() {
  const source = fs.readFileSync(setupPath, 'utf8')
  const match = source.match(/VALID_TAURI_COMMANDS\s*=\s*new\s+Set\s*\(\s*\[/)
  if (!match) throw new Error(`VALID_TAURI_COMMANDS Set literal not found in ${setupPath}`)
  const body = stripComments(
    bracketBody(source, match.index + match[0].length - 1, 'VALID_TAURI_COMMANDS'),
  )
  const names = new Set()
  for (const m of body.matchAll(/'([^'\\]+)'|"([^"\\]+)"|`([^`\\]+)`/g)) {
    names.add(m[1] ?? m[2] ?? m[3])
  }
  if (names.size === 0) throw new Error(`no commands extracted from ${setupPath}`)
  return names
}

function registeredCommands() {
  const source = fs.readFileSync(libPath, 'utf8')
  const names = new Set()
  let found = false
  for (const m of source.matchAll(/generate_handler!\s*\[/g)) {
    found = true
    const body = stripComments(bracketBody(source, m.index + m[0].length - 1, 'generate_handler!'))
    for (const raw of body.split(',')) {
      const entry = raw.trim()
      if (!entry) continue
      // Entries may be module paths (business_graph::runtime::graph_open);
      // the command name is the last path segment.
      const name = entry.split('::').pop().trim()
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        throw new Error(`unparseable generate_handler! entry in ${libPath}: '${entry}'`)
      }
      names.add(name)
    }
  }
  if (!found) throw new Error(`generate_handler![...] not found in ${libPath}`)
  if (names.size === 0) throw new Error(`no commands extracted from ${libPath}`)
  return names
}

// --- Comparison ---

let mock, registered
try {
  mock = mockCommands()
  registered = registeredCommands()
} catch (error) {
  console.error(`check-tauri-commands: ${error.message}`)
  process.exit(1)
}

const mockOnly = [...mock].filter((name) => !registered.has(name)).sort()
const rustOnly = [...registered].filter((name) => !mock.has(name)).sort()
const failures = []

for (const name of mockOnly) {
  if (!KNOWN_MOCK_ONLY.has(name)) {
    failures.push(
      `'${name}' is in the setup.js mock allowlist but not registered in lib.rs `
      + `(remove it from VALID_TAURI_COMMANDS, or register the command)`,
    )
  }
}
for (const name of rustOnly) {
  if (!KNOWN_RUST_ONLY.has(name)) {
    failures.push(
      `'${name}' is registered in lib.rs but missing from the setup.js mock allowlist `
      + `(add it to VALID_TAURI_COMMANDS)`,
    )
  }
}
// Stale exceptions: listed debt that is no longer a mismatch must be removed
// here so this list stays an honest record.
for (const name of KNOWN_MOCK_ONLY.keys()) {
  if (!mockOnly.includes(name)) {
    failures.push(`stale exception '${name}' (KNOWN_MOCK_ONLY): no longer a mismatch — remove it from scripts/check-tauri-commands.mjs`)
  }
}
for (const name of KNOWN_RUST_ONLY.keys()) {
  if (!rustOnly.includes(name)) {
    failures.push(`stale exception '${name}' (KNOWN_RUST_ONLY): no longer a mismatch — remove it from scripts/check-tauri-commands.mjs`)
  }
}

const tolerated = [
  ...mockOnly.filter((name) => KNOWN_MOCK_ONLY.has(name)).map((name) => `mock-only '${name}' — ${KNOWN_MOCK_ONLY.get(name)}`),
  ...rustOnly.filter((name) => KNOWN_RUST_ONLY.has(name)).map((name) => `rust-only '${name}' — ${KNOWN_RUST_ONLY.get(name)}`),
]

if (failures.length) {
  console.error(`Tauri command drift check failed (${failures.length}):`)
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}

console.log(
  `Tauri command drift check passed: ${registered.size} registered commands, `
  + `${mock.size} mocked.`,
)
if (tolerated.length) {
  console.log(`Known exceptions tolerated (${tolerated.length}) — temporary debt:`)
  for (const line of tolerated) console.log(`- ${line}`)
}
