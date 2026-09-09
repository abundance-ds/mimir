// Claude's native Edit requires the target path, not a symbolic link.
// This run-local hook retains a user's fileSuggestion command when present.
import { spawnSync } from 'node:child_process'
import { readFileSync, lstatSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export function suggestions(input, environment = process.env, cwd = process.cwd()) {
  const query = String(JSON.parse(input || '{}').query || '').replace(/^@/, '').toLowerCase()
  const target = environment.MIMIR_SCRATCHPAD_PATH || join(homedir(), '.mimir/scratchpad.md')
  const shared = 'scratchpad.md'.includes(query) || target.toLowerCase().includes(query)
    ? [target] : []
  const forward = environment.MIMIR_CLAUDE_FILE_SUGGESTION
  let paths
  if (forward) {
    const result = spawnSync(forward, { shell: true, cwd, env: environment, input, encoding: 'utf8', timeout: 1500, maxBuffer: 2 * 1024 * 1024 })
    paths = (result.stdout || '').split('\n')
  } else {
    const result = spawnSync('rg', ['--files', '--hidden', '--follow', '-g', '!.git', '-g', '!node_modules'], {
      cwd, env: environment, encoding: 'utf8', timeout: 1500, maxBuffer: 8 * 1024 * 1024,
    })
    const fallback = result.error ? spawnSync('git', ['ls-files', '-co', '--exclude-standard'], {
      cwd, encoding: 'utf8', timeout: 1500, maxBuffer: 8 * 1024 * 1024,
    }).stdout : result.stdout
    paths = (fallback || '').split('\n').filter(path => path.toLowerCase().includes(query))
  }
  function ownedLink(path) {
    try { const file = resolve(cwd, path); return lstatSync(file).isSymbolicLink() && realpathSync(file) === realpathSync(target) }
    catch { return false }
  }
  return [...new Set([...shared, ...paths.filter(path => path && path !== target && !ownedLink(path))])].slice(0, 100)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.stdout.write(suggestions(readFileSync(0, 'utf8')).join('\n') + '\n') }
  catch { /* An invalid completion request must not disrupt terminal input. */ }
}
