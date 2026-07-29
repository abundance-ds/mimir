import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  APPLE_RELEASE_KEYS,
  REPOSITORY_ROOT,
  loadReleaseEnv,
  requireReleaseKeys,
} from './release-env.mjs'

const args = process.argv.slice(2)
const env = loadReleaseEnv({ allowMissing: true })
const isRelease = args[0] === 'build' || args[0] === 'bundle'
const targetIndex = args.indexOf('--target')
const target = targetIndex === -1 ? '' : (args[targetIndex + 1] ?? '')
const isMacBuild = isRelease && (target.includes('apple-darwin') || (!target && process.platform === 'darwin'))
const isWindowsRelease = isRelease && (
  target.includes('windows')
  || target.includes('pc-windows')
  || (!target && process.platform === 'win32')
)

if (isMacBuild) {
  requireReleaseKeys(env, APPLE_RELEASE_KEYS, 'Apple')
}

const cli = resolve(REPOSITORY_ROOT, 'node_modules/@tauri-apps/cli/tauri.js')

function run(command, commandArgs, options = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, commandArgs, {
      cwd: REPOSITORY_ROOT,
      env,
      stdio: 'inherit',
      ...options,
    })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (signal) reject(new Error(`${command} stopped by ${signal}`))
      else if (code !== 0) reject(new Error(`${command} exited with status ${code ?? 1}`))
      else resolveRun()
    })
  })
}

function releaseBundleRoot() {
  const targetRoot = target ? join('target', target) : 'target'
  return resolve(REPOSITORY_ROOT, 'src-tauri', targetRoot, 'release', 'bundle')
}

function requestedDmg() {
  const inline = args.find(argument => argument.startsWith('--bundles='))
  if (inline) return inline.slice('--bundles='.length).split(',').includes('dmg')
  const bundlesIndex = args.indexOf('--bundles')
  if (bundlesIndex === -1) return true
  return (args[bundlesIndex + 1] ?? '').split(',').includes('dmg')
}

function newestDmg(directory) {
  const candidates = readdirSync(directory)
    .filter(name => name.endsWith('.dmg'))
    .map(name => resolve(directory, name))
    .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs)
  if (!candidates.length) throw new Error(`no DMG was produced in ${directory}`)
  return candidates[0]
}

async function notarizeMacRelease() {
  const bundleRoot = releaseBundleRoot()
  const app = resolve(bundleRoot, 'macos', 'Mimir.app')
  let submission
  let temporary

  if (requestedDmg()) {
    submission = newestDmg(resolve(bundleRoot, 'dmg'))
  } else {
    temporary = mkdtempSync(join(tmpdir(), 'mimir-notary-'))
    submission = resolve(temporary, 'Mimir.zip')
    await run('ditto', ['-c', '-k', '--keepParent', app, submission])
  }

  try {
    await run('xcrun', [
      'notarytool', 'submit', submission,
      '--apple-id', env.APPLE_ID,
      '--password', env.APPLE_PASSWORD,
      '--team-id', env.APPLE_TEAM_ID,
      '--wait', '--timeout', '30m',
    ])
    if (submission.endsWith('.dmg')) {
      await run('xcrun', ['stapler', 'staple', submission])
      await run('xcrun', ['stapler', 'validate', submission])
    }
    if (existsSync(app)) {
      await run('xcrun', ['stapler', 'staple', app])
      await run('xcrun', ['stapler', 'validate', app])
    }
  } finally {
    if (temporary) rmSync(temporary, { recursive: true, force: true })
  }
}

async function main() {
  if (isWindowsRelease) {
    throw new Error('Windows releases are parked; see docs/building.md for the retained restoration path')
  }
  const tauriEnv = { ...env }
  if (isMacBuild) {
    // Tauri's signing path is sound, but its integrated notarization transport
    // can time out before upload. Package first, then use Apple's notarytool.
    delete tauriEnv.APPLE_ID
    delete tauriEnv.APPLE_PASSWORD
    delete tauriEnv.APPLE_TEAM_ID
  }
  await run(process.execPath, [cli, ...args], { env: tauriEnv })
  if (isMacBuild) await notarizeMacRelease()
}

main().catch(error => {
  console.error(error.message)
  process.exitCode = 1
})
