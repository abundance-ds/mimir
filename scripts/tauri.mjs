import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  argumentValue,
  assertCleanReleaseSource,
  assertUnchangedReleaseSource,
  gitSourceIdentity,
  macReleaseLayout,
  prepareReleaseOutput,
  stageRelease,
} from './lib/release-artifacts.mjs'
import {
  APPLE_RELEASE_KEYS,
  REPOSITORY_ROOT,
  loadReleaseEnv,
  requireReleaseKeys,
} from './release-env.mjs'

const args = process.argv.slice(2)
const env = loadReleaseEnv({ allowMissing: true })
const isRelease = args[0] === 'build' || args[0] === 'bundle'
const target = argumentValue(args, '--target')
const isMacBuild = isRelease && (target.includes('apple-darwin') || (!target && process.platform === 'darwin'))
const isWindowsRelease = isRelease && (
  target.includes('windows')
  || target.includes('pc-windows')
  || (!target && process.platform === 'win32')
)
const tauriConfig = JSON.parse(
  readFileSync(resolve(REPOSITORY_ROOT, 'src-tauri/tauri.conf.json'), 'utf8'),
)
let macRelease

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

async function notarizeMacRelease(layout) {
  const app = layout.app
  if (!existsSync(layout.dmg)) {
    throw new Error(`Tauri did not produce the exact expected DMG: ${layout.dmg}`)
  }
  await run('xcrun', [
    'notarytool', 'submit', layout.dmg,
    '--apple-id', env.APPLE_ID,
    '--password', env.APPLE_PASSWORD,
    '--team-id', env.APPLE_TEAM_ID,
    '--wait', '--timeout', '30m',
  ])
  await run('xcrun', ['stapler', 'staple', layout.dmg])
  await run('xcrun', ['stapler', 'validate', layout.dmg])
  if (existsSync(app)) {
    await run('xcrun', ['stapler', 'staple', app])
    await run('xcrun', ['stapler', 'validate', app])
  }
}

async function main() {
  if (isWindowsRelease) {
    throw new Error('Windows releases are parked; see docs/building.md for the retained restoration path')
  }
  if (isMacBuild && !requestedDmg()) {
    throw new Error('signed macOS releases must include the exact versioned DMG artifact')
  }
  const tauriEnv = { ...env }
  if (isMacBuild) {
    const identity = gitSourceIdentity(REPOSITORY_ROOT)
    assertCleanReleaseSource(identity)
    macRelease = {
      identity,
      layout: macReleaseLayout({
        repositoryRoot: REPOSITORY_ROOT,
        bundleRoot: releaseBundleRoot(),
        productName: tauriConfig.productName,
        version: tauriConfig.version,
        target,
      }),
    }
    prepareReleaseOutput(macRelease.layout)
    // Tauri's signing path is sound, but its integrated notarization transport
    // can time out before upload. Package first, then use Apple's notarytool.
    delete tauriEnv.APPLE_ID
    delete tauriEnv.APPLE_PASSWORD
    delete tauriEnv.APPLE_TEAM_ID
  }
  await run(process.execPath, [cli, ...args], { env: tauriEnv })
  if (isMacBuild) {
    await notarizeMacRelease(macRelease.layout)
    const after = gitSourceIdentity(REPOSITORY_ROOT)
    assertUnchangedReleaseSource(macRelease.identity, after)
    const manifest = stageRelease({
      repositoryRoot: REPOSITORY_ROOT,
      layout: macRelease.layout,
      identity: after,
      productName: tauriConfig.productName,
      version: tauriConfig.version,
    })
    console.log(
      `Release staged from ${after.commit} with SHA-256 ${manifest.artifact.sha256}: `
      + macRelease.layout.stage,
    )
  }
}

main().catch(error => {
  console.error(error.message)
  process.exitCode = 1
})
