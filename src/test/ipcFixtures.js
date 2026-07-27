// Golden IPC fixtures shared with the Rust test suite.
//
// The files under src-tauri/tests/fixtures/ipc/ are serialized by the real
// Rust response types and pinned by the golden test in
// src-tauri/src/ipc_fixtures.rs (`ipc_fixtures_match_serialization`).
// Renderer tests that mock `invoke` should load these instead of hand-writing
// Rust payload shapes, so a serde rename on either side fails a test rather
// than silently drifting. Regenerate after intentional shape changes with:
//   UPDATE_IPC_FIXTURES=1 cargo test --manifest-path src-tauri/Cargo.toml ipc_fixtures
//
// Node APIs are available inside Vitest test files even though the test
// environment is happy-dom.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const FIXTURES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../src-tauri/tests/fixtures/ipc',
)

/** Load the golden response payload for a Tauri command (fresh copy per call). */
export function loadIpcFixture(name) {
  const path = join(FIXTURES_DIR, `${name}.json`)
  let raw
  try {
    raw = readFileSync(path, 'utf8')
  } catch (cause) {
    throw new Error(
      `No golden IPC fixture for '${name}' (${path}). Add a builder in `
      + 'src-tauri/src/ipc_fixtures.rs and regenerate with UPDATE_IPC_FIXTURES=1.',
      { cause },
    )
  }
  return JSON.parse(raw)
}

/**
 * Load an object-shaped fixture with test-specific fields shallow-merged on
 * top. For array fixtures use `loadIpcFixture` and adjust entries directly.
 */
export function ipcFixture(name, overrides = {}) {
  const value = loadIpcFixture(name)
  if (Array.isArray(value) || value === null || typeof value !== 'object') {
    throw new Error(`ipcFixture('${name}') overrides need an object payload; use loadIpcFixture instead.`)
  }
  return { ...value, ...overrides }
}
