import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { REPOSITORY_ROOT } from './release-env.mjs'

const bump = process.argv[2] || 'patch'
const allowedBumps = new Set(['patch', 'minor', 'major'])
if (!allowedBumps.has(bump) && !/^\d+\.\d+\.\d+$/.test(bump)) {
  throw new Error('usage: bun run release:create -- patch|minor|major|X.Y.Z')
}

const git = args => run('git', args).trim()
if (git(['branch', '--show-current']) !== 'main') {
  throw new Error('release creation requires the main branch')
}
if (git(['status', '--porcelain=v1', '--untracked-files=all'])) {
  throw new Error('release creation requires a clean working tree')
}

run('git', ['fetch', '--quiet', 'origin', 'main'])
if (git(['rev-parse', 'HEAD']) !== git(['rev-parse', 'origin/main'])) {
  throw new Error('main must match origin/main before release creation')
}

const repository = JSON.parse(run('gh', [
  'repo', 'view', 'abundance-ds/mimir', '--json', 'visibility',
]))
if (repository.visibility !== 'PUBLIC') {
  throw new Error('abundance-ds/mimir must be public so installed apps can read the update feed')
}
const releaseSecrets = new Set(JSON.parse(run('gh', [
  'secret', 'list', '--repo', 'abundance-ds/mimir', '--json', 'name',
])).map(secret => secret.name))
for (const secret of [
  'APPLE_CERTIFICATE',
  'APPLE_CERTIFICATE_PASSWORD',
  'APPLE_SIGNING_IDENTITY',
  'APPLE_ID',
  'APPLE_PASSWORD',
  'APPLE_TEAM_ID',
  'MIMIR_GOOGLE_OAUTH_CLIENT_ID',
  'MIMIR_GOOGLE_OAUTH_CLIENT_SECRET',
  'TAURI_SIGNING_PRIVATE_KEY',
  'TAURI_SIGNING_PRIVATE_KEY_PASSWORD',
]) {
  if (!releaseSecrets.has(secret)) throw new Error(`GitHub release secret is missing: ${secret}`)
}

const packagePath = resolve(REPOSITORY_ROOT, 'package.json')
const cargoPath = resolve(REPOSITORY_ROOT, 'src-tauri/Cargo.toml')
const tauriPath = resolve(REPOSITORY_ROOT, 'src-tauri/tauri.conf.json')
const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'))
const tauriJson = JSON.parse(readFileSync(tauriPath, 'utf8'))
const cargoSource = readFileSync(cargoPath, 'utf8')
const cargoVersion = cargoSource.match(/^version = "([^"]+)"/m)?.[1]
if (!cargoVersion || packageJson.version !== cargoVersion || packageJson.version !== tauriJson.version) {
  throw new Error('package, Cargo, and Tauri versions must match before a release bump')
}

const nextVersion = allowedBumps.has(bump) ? incrementVersion(packageJson.version, bump) : bump
if (compareVersions(nextVersion, packageJson.version) <= 0) {
  throw new Error(`release version ${nextVersion} must be newer than ${packageJson.version}`)
}
const tag = `v${nextVersion}`
if (git(['tag', '--list', tag])) throw new Error(`Git tag ${tag} already exists`)
try {
  run('gh', ['release', 'view', tag, '--repo', 'abundance-ds/mimir'])
  throw new Error(`GitHub Release ${tag} already exists`)
} catch (error) {
  if (!String(error.message).includes('release not found')) throw error
}

packageJson.version = nextVersion
tauriJson.version = nextVersion
writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`)
writeFileSync(tauriPath, `${JSON.stringify(tauriJson, null, 2)}\n`)
writeFileSync(
  cargoPath,
  cargoSource.replace(/^version = "[^"]+"/m, `version = "${nextVersion}"`),
)

run('cargo', [
  'metadata',
  '--manifest-path', 'src-tauri/Cargo.toml',
  '--format-version', '1',
], { stdio: 'ignore' })
run('bun', ['install', '--frozen-lockfile'])
run('bun', ['run', 'docs:check'])
run('bun', ['run', 'check:identity'])
run('bun', ['run', 'check:commands'])
run('bun', ['run', 'test'])
run('bun', ['run', 'build'])

run('git', ['add',
  'package.json',
  'src-tauri/Cargo.toml',
  'src-tauri/Cargo.lock',
  'src-tauri/tauri.conf.json',
])
run('git', ['commit', '-m', `release: prepare ${tag}`])
run('git', ['tag', '-a', tag, '-m', `Mimir ${nextVersion}`])
run('git', ['push', '--atomic', 'origin', 'main', tag])

console.log(`Release ${tag} started. Watch it with:`)
console.log(`  gh run list --workflow build.yml --branch ${tag}`)
console.log(`After it succeeds, verify it with:`)
console.log('  bun run release:verify')

function run(command, args, options = {}) {
  try {
    return execFileSync(command, args, {
      cwd: REPOSITORY_ROOT,
      encoding: 'utf8',
      stdio: options.stdio || ['ignore', 'pipe', 'pipe'],
    }) || ''
  } catch (error) {
    const detail = error.stderr?.toString().trim() || error.stdout?.toString().trim() || error.message
    throw new Error(`${command} ${args.join(' ')} failed: ${detail}`)
  }
}

function incrementVersion(version, kind) {
  const parts = version.split('.').map(Number)
  if (parts.length !== 3 || parts.some(part => !Number.isInteger(part) || part < 0)) {
    throw new Error(`unsupported version: ${version}`)
  }
  if (kind === 'major') return `${parts[0] + 1}.0.0`
  if (kind === 'minor') return `${parts[0]}.${parts[1] + 1}.0`
  return `${parts[0]}.${parts[1]}.${parts[2] + 1}`
}

function compareVersions(left, right) {
  const a = left.split('.').map(Number)
  const b = right.split('.').map(Number)
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index]
  }
  return 0
}
