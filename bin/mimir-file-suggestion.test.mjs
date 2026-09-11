import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { suggestions } from './mimir-file-suggestion.mjs'
import { fileURLToPath } from 'node:url'

const helper = fileURLToPath(new URL('./mimir-file-suggestion.mjs', import.meta.url))
const quote = value => `'${value.replaceAll("'", "'\\''")}'`

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'mimir suggestion '))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const project = join(root, 'project')
  mkdirSync(project)
  const target = join(root, 'scratchpad.md')
  writeFileSync(target, 'Shared text')
  const env = { ...process.env, MIMIR_SCRATCHPAD_PATH: target }
  delete env.MIMIR_CLAUDE_FILE_SUGGESTION
  return { root, project, target, env }
}

test('Scratchpad completes to its target and normal project files remain available', () => {
  const root = mkdtempSync(join(tmpdir(), 'mimir-suggestion-'))
  try {
    writeFileSync(join(root, 'email.md'), 'Hello')
    assert.equal(spawnSync('git', ['init'], { cwd: root }).status, 0)
    const env = { ...process.env, MIMIR_SCRATCHPAD_PATH: '/test/.mimir/scratchpad.md' }
    delete env.MIMIR_CLAUDE_FILE_SUGGESTION
    assert.equal(suggestions('{"query":"scratchpad"}', env, root)[0], env.MIMIR_SCRATCHPAD_PATH)
    assert.deepEqual(suggestions('{"query":"email"}', env, root), ['email.md'])
    env.MIMIR_CLAUDE_FILE_SUGGESTION = "printf 'custom.md\\n'"
    assert.deepEqual(suggestions('{"query":"scratchpad"}', env, root), [env.MIMIR_SCRATCHPAD_PATH, 'custom.md'])
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('the executable helper deduplicates its alias but keeps an unrelated scratchpad file', t => {
  const { project, target, env } = fixture(t)
  assert.equal(spawnSync('git', ['init'], { cwd: project }).status, 0)
  symlinkSync(target, join(project, 'scratchpad.md'))
  mkdirSync(join(project, 'notes'))
  writeFileSync(join(project, 'notes/scratchpad.md'), 'Project text')
  const result = spawnSync(process.execPath, [helper], { cwd: project, env, input: '{"query":"scratchpad"}', encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(result.stdout.trim().split('\n'), [target, 'notes/scratchpad.md'])
})

test('forwards query text through stdin to an existing suggestion command', t => {
  const { root, project, env } = fixture(t)
  const forward = join(root, 'custom hook.mjs')
  writeFileSync(forward, "import {readFileSync} from 'node:fs'; process.stdout.write(JSON.parse(readFileSync(0, 'utf8')).query + '\\n')")
  env.MIMIR_CLAUDE_FILE_SUGGESTION = `${quote(process.execPath)} ${quote(forward)}`
  const query = '$(touch should-not-exist); quoted "text"'
  assert.deepEqual(suggestions(JSON.stringify({ query }), env, project), [query])
})

test('uses Git file suggestions when rg is unavailable', t => {
  const { root, project, env } = fixture(t)
  assert.equal(spawnSync('git', ['init'], { cwd: project }).status, 0)
  writeFileSync(join(project, 'email.md'), 'Hello')
  const git = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim()
  const bin = join(root, 'bin')
  mkdirSync(bin)
  symlinkSync(git, join(bin, 'git'))
  env.PATH = bin
  assert.deepEqual(suggestions('{"query":"email"}', env, project), ['email.md'])
})

test('invalid input exits quietly so completion can continue', t => {
  const { project, env } = fixture(t)
  const result = spawnSync(process.execPath, [helper], { cwd: project, env, input: '{bad json', encoding: 'utf8' })
  assert.equal(result.status, 0)
  assert.equal(result.stdout, '')
  assert.equal(result.stderr, '')
})
