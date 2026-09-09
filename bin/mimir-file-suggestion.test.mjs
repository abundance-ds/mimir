import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { suggestions } from './mimir-file-suggestion.mjs'

test('Scratchpad completes to its target and normal project files remain available', () => {
  const root = mkdtempSync(join(tmpdir(), 'mimir-suggestion-'))
  try {
    writeFileSync(join(root, 'email.md'), 'Hello')
    const env = { ...process.env, MIMIR_SCRATCHPAD_PATH: '/test/.mimir/scratchpad.md' }
    assert.equal(suggestions('{"query":"scratchpad"}', env, root)[0], env.MIMIR_SCRATCHPAD_PATH)
    assert.deepEqual(suggestions('{"query":"email"}', env, root), ['email.md'])
    env.MIMIR_CLAUDE_FILE_SUGGESTION = "printf 'custom.md\\n'"
    assert.deepEqual(suggestions('{"query":"scratchpad"}', env, root), [env.MIMIR_SCRATCHPAD_PATH, 'custom.md'])
  } finally { rmSync(root, { recursive: true, force: true }) }
})
