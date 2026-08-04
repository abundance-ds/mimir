import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  configureMacDevCommand,
  prepareMacDevApp,
} from './prepare-macos-dev-app.mjs'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

test('macOS Tauri development uses the arm64 app-bundle runner', () => {
  const args = ['dev']
  const env = {}

  assert.equal(configureMacDevCommand({
    args,
    env,
    platform: 'darwin',
    architecture: 'arm64',
    repositoryRoot,
  }), true)
  assert.deepEqual(args, ['dev'])
  assert.equal(
    env.CARGO_TARGET_AARCH64_APPLE_DARWIN_RUNNER,
    resolve(repositoryRoot, 'scripts/run-macos-dev-app'),
  )
  assert.notEqual(statSync(env.CARGO_TARGET_AARCH64_APPLE_DARWIN_RUNNER).mode & 0o111, 0)
  assert.equal(env.MIMIR_DEV_NODE, process.execPath)
})

test('non-development and custom-runner commands remain unchanged', () => {
  for (const args of [['build'], ['dev', '--runner', 'custom-cargo']]) {
    const original = [...args]
    const env = {}
    assert.equal(configureMacDevCommand({
      args,
      env,
      platform: 'darwin',
      architecture: 'arm64',
      repositoryRoot,
    }), false)
    assert.deepEqual(args, original)
    assert.deepEqual(env, {})
  }
})

test('the development app has the Mimir identity and audio purpose strings', {
  skip: process.platform !== 'darwin',
}, () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'mimir-dev-app-'))
  try {
    const appRoot = join(temporaryRoot, 'Mimir.app')
    const prepared = prepareMacDevApp({
      binaryPath: '/usr/bin/true',
      repositoryRoot,
      appRoot,
      signingIdentity: '-',
    })
    const plistPath = join(appRoot, 'Contents', 'Info.plist')
    assert.equal(
      execFileSync('plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', plistPath], {
        encoding: 'utf8',
      }).trim(),
      'rs.shoulde.mimir',
    )
    const plist = readFileSync(plistPath, 'utf8')
    assert.match(plist, /NSMicrophoneUsageDescription/u)
    assert.match(plist, /NSAudioCaptureUsageDescription/u)
    execFileSync('codesign', ['--verify', '--deep', '--strict', prepared.appRoot])
    assert.equal(prepared.executablePath, join(appRoot, 'Contents', 'MacOS', 'mimir'))
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true })
  }
})
