import assert from 'node:assert/strict'
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import test from 'node:test'
import {
  argumentValue,
  assertUnchangedReleaseSource,
  macReleaseLayout,
  prepareReleaseOutput,
  stageRelease,
  verifyReleaseStage,
} from './lib/release-artifacts.mjs'

test('mac release layout selects one exact arm64 artifact and rejects other architectures', () => {
  assert.equal(argumentValue(['build', '--target', 'aarch64-apple-darwin'], '--target'), 'aarch64-apple-darwin')
  assert.equal(argumentValue(['build', '--target=aarch64-apple-darwin'], '--target'), 'aarch64-apple-darwin')
  const layout = macReleaseLayout({
    repositoryRoot: '/work/mimir',
    bundleRoot: '/work/mimir/src-tauri/target/aarch64-apple-darwin/release/bundle',
    productName: 'Mimir',
    version: '0.1.0',
    target: 'aarch64-apple-darwin',
  })
  assert.equal(layout.artifactName, 'Mimir_0.1.0_aarch64.dmg')
  assert.equal(
    layout.dmg,
    '/work/mimir/src-tauri/target/aarch64-apple-darwin/release/bundle/dmg/Mimir_0.1.0_aarch64.dmg',
  )
  assert.throws(() => macReleaseLayout({
    repositoryRoot: '/work/mimir',
    bundleRoot: '/work/bundle',
    productName: 'Mimir',
    version: '0.1.0',
    target: 'x86_64-apple-darwin',
  }), /only for macOS arm64/)
})

test('source identity must remain clean and unchanged across packaging', () => {
  const source = {
    commit: 'a'.repeat(40),
    tree: 'b'.repeat(40),
    commitTime: '2026-07-31T00:00:00.000Z',
    status: '',
  }
  assert.doesNotThrow(() => assertUnchangedReleaseSource(source, { ...source }))
  assert.throws(
    () => assertUnchangedReleaseSource(source, { ...source, status: ' M README.md' }),
    /uncommitted source tree/,
  )
  assert.throws(
    () => assertUnchangedReleaseSource(source, { ...source, commit: 'c'.repeat(40) }),
    /source changed/,
  )
})

test('release staging contains only the exact artifact, manifest, SBOM, inventory, and notices', () => {
  const temporary = mkdtempSync(resolve(tmpdir(), 'mimir-release-test.'))
  try {
    const repositoryRoot = resolve(temporary, 'repo')
    const bundleRoot = resolve(repositoryRoot, 'src-tauri/target/aarch64-apple-darwin/release/bundle')
    const layout = macReleaseLayout({
      repositoryRoot,
      bundleRoot,
      productName: 'Mimir',
      version: '0.1.0',
      target: 'aarch64-apple-darwin',
    })
    mkdirSync(resolve(bundleRoot, 'dmg'), { recursive: true })
    for (const relative of [
      'bun.lock',
      'src-tauri/Cargo.lock',
      'src-tauri/vendor/license-policy.json',
      'src-tauri/vendor/SBOM.spdx.json',
      'src-tauri/vendor/THIRD_PARTY_LICENSES.md',
      'src-tauri/vendor/THIRD_PARTY_NOTICES.md',
    ]) {
      const path = resolve(repositoryRoot, relative)
      mkdirSync(resolve(path, '..'), { recursive: true })
      writeFileSync(path, relative)
    }
    const staleSibling = resolve(bundleRoot, 'dmg/Mimir_0.0.9_aarch64.dmg')
    writeFileSync(layout.dmg, 'stale expected artifact')
    writeFileSync(staleSibling, 'newer-looking but unrelated artifact')
    prepareReleaseOutput(layout)
    assert.equal(existsSync(layout.dmg), false)
    assert.equal(existsSync(staleSibling), true)
    writeFileSync(layout.dmg, 'signed-notarized-dmg')
    const manifest = stageRelease({
      repositoryRoot,
      layout,
      identity: {
        commit: 'a'.repeat(40),
        tree: 'b'.repeat(40),
        commitTime: '2026-07-31T00:00:00.000Z',
      },
      productName: 'Mimir',
      version: '0.1.0',
    })
    assert.equal(manifest.source.gitCommit, 'a'.repeat(40))
    assert.equal(manifest.artifact.file, 'Mimir_0.1.0_aarch64.dmg')
    assert.equal(manifest.artifact.sha256.length, 64)
    const serialized = readFileSync(
      resolve(layout.stage, 'Mimir_0.1.0_aarch64.manifest.json'),
      'utf8',
    )
    assert.equal(serialized.includes(temporary), false)
    assert.doesNotThrow(() => verifyReleaseStage({
      repositoryRoot,
      layout,
      identity: {
        commit: 'a'.repeat(40),
        tree: 'b'.repeat(40),
      },
    }))
    writeFileSync(resolve(layout.stage, 'SBOM.spdx.json'), 'tampered')
    assert.throws(() => verifyReleaseStage({
      repositoryRoot,
      layout,
      identity: {
        commit: 'a'.repeat(40),
        tree: 'b'.repeat(40),
      },
    }), /release file SBOM.spdx.json does not match/)
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
})
