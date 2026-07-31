import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, join, resolve } from 'node:path'

const RELEASE_INPUTS = [
  'bun.lock',
  'src-tauri/Cargo.lock',
  'src-tauri/vendor/license-policy.json',
  'src-tauri/vendor/SBOM.spdx.json',
  'src-tauri/vendor/THIRD_PARTY_LICENSES.md',
  'src-tauri/vendor/THIRD_PARTY_NOTICES.md',
]

export function argumentValue(args, name) {
  const inline = args.find(argument => argument.startsWith(`${name}=`))
  if (inline) return inline.slice(name.length + 1)
  const index = args.indexOf(name)
  return index === -1 ? '' : (args[index + 1] ?? '')
}

export function macReleaseLayout({
  repositoryRoot,
  bundleRoot,
  productName,
  version,
  target = '',
  hostArch = process.arch,
}) {
  if (target && target !== 'aarch64-apple-darwin') {
    throw new Error('Mimir Scribe release artifacts are supported only for macOS arm64')
  }
  const architecture = target.startsWith('aarch64-')
    ? 'aarch64'
    : hostArch === 'arm64'
      ? 'aarch64'
      : 'x64'
  if (architecture !== 'aarch64') {
    throw new Error('Mimir Scribe release artifacts are supported only for macOS arm64')
  }
  const stem = `${productName.replaceAll(' ', '_')}_${version}_${architecture}`
  return {
    target: target || 'aarch64-apple-darwin',
    artifactName: `${stem}.dmg`,
    manifestName: `${stem}.manifest.json`,
    dmg: resolve(bundleRoot, 'dmg', `${stem}.dmg`),
    app: resolve(bundleRoot, 'macos', `${productName}.app`),
    stage: resolve(repositoryRoot, 'src-tauri', 'target', 'release-artifacts'),
  }
}

export function gitSourceIdentity(repositoryRoot) {
  const git = args => execFileSync('git', args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
  }).trim()
  return {
    commit: git(['rev-parse', 'HEAD']),
    tree: git(['rev-parse', 'HEAD^{tree}']),
    commitTime: new Date(git(['show', '-s', '--format=%cI', 'HEAD'])).toISOString(),
    status: git(['status', '--porcelain=v1', '--untracked-files=all']),
  }
}

export function assertCleanReleaseSource(identity) {
  if (identity.status) {
    throw new Error(
      `refusing to sign an uncommitted source tree:\n${identity.status}`,
    )
  }
}

export function assertUnchangedReleaseSource(before, after) {
  assertCleanReleaseSource(after)
  if (before.commit !== after.commit || before.tree !== after.tree) {
    throw new Error(
      `release source changed during packaging (${before.commit} -> ${after.commit})`,
    )
  }
}

export function prepareReleaseOutput(layout) {
  assertSafeStage(layout.stage)
  rmSync(layout.stage, { recursive: true, force: true })
  mkdirSync(layout.stage, { recursive: true })
  // Remove only the exact artifact expected from this invocation. A successful
  // wrapper run must recreate it; stale sibling DMGs are never candidates.
  rmSync(layout.dmg, { force: true })
}

export function stageRelease({
  repositoryRoot,
  layout,
  identity,
  productName,
  version,
}) {
  if (!existsSync(layout.dmg)) {
    throw new Error(`Tauri did not produce the expected release artifact: ${layout.dmg}`)
  }
  assertSafeStage(layout.stage)
  const stagedArtifact = resolve(layout.stage, layout.artifactName)
  copyFileSync(layout.dmg, stagedArtifact)

  const releaseFiles = RELEASE_INPUTS.slice(3).map(relative => {
    const source = resolve(repositoryRoot, relative)
    const destination = resolve(layout.stage, basename(relative))
    copyFileSync(source, destination)
    return fileRecord(destination)
  })
  const manifest = {
    schemaVersion: 1,
    product: productName,
    version,
    target: layout.target,
    source: {
      gitCommit: identity.commit,
      gitTree: identity.tree,
      commitTime: identity.commitTime,
      dirty: false,
    },
    artifact: fileRecord(stagedArtifact),
    materials: RELEASE_INPUTS.slice(0, 3).map(relative => ({
      path: relative,
      ...fileRecord(resolve(repositoryRoot, relative), false),
    })),
    releaseFiles,
    createdAt: new Date().toISOString(),
  }
  writeFileSync(
    resolve(layout.stage, layout.manifestName),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { mode: 0o644 },
  )

  assertExpectedStageEntries(layout)
  if (fileRecord(layout.dmg).sha256 !== manifest.artifact.sha256) {
    throw new Error('staged artifact digest differs from the notarized source artifact')
  }
  return manifest
}

export function verifyReleaseStage({ repositoryRoot, layout, identity }) {
  assertCleanReleaseSource(identity)
  const manifestPath = resolve(layout.stage, layout.manifestName)
  if (!existsSync(manifestPath)) {
    throw new Error(`release manifest is missing: ${layout.manifestName}`)
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (
    manifest.schemaVersion !== 1
    || manifest.source?.gitCommit !== identity.commit
    || manifest.source?.gitTree !== identity.tree
    || manifest.source?.dirty !== false
  ) {
    throw new Error('release manifest does not identify the current clean Git source')
  }
  const stagedArtifact = resolve(layout.stage, layout.artifactName)
  assertFileRecord(manifest.artifact, fileRecord(stagedArtifact), 'release artifact')

  const expectedMaterials = new Map(RELEASE_INPUTS.slice(0, 3).map(relative => [
    relative,
    fileRecord(resolve(repositoryRoot, relative), false),
  ]))
  if (manifest.materials?.length !== expectedMaterials.size) {
    throw new Error('release manifest material inventory is incomplete')
  }
  for (const material of manifest.materials) {
    const expected = expectedMaterials.get(material.path)
    if (!expected) throw new Error(`release manifest contains an unexpected material: ${material.path}`)
    assertFileRecord(material, expected, `release material ${material.path}`)
  }

  const expectedFiles = RELEASE_INPUTS.slice(3).map(relative => (
    fileRecord(resolve(layout.stage, basename(relative)))
  ))
  if (manifest.releaseFiles?.length !== expectedFiles.length) {
    throw new Error('release manifest packaged-file inventory is incomplete')
  }
  for (const expected of expectedFiles) {
    const recorded = manifest.releaseFiles.find(item => item.file === expected.file)
    assertFileRecord(recorded, expected, `release file ${expected.file}`)
  }
  assertExpectedStageEntries(layout)
  return manifest
}

export function fileRecord(path, includeName = true) {
  const contents = readFileSync(path)
  return {
    ...(includeName ? { file: basename(path) } : {}),
    bytes: statSync(path).size,
    sha256: createHash('sha256').update(contents).digest('hex'),
  }
}

function assertFileRecord(actual, expected, label) {
  if (
    !actual
    || actual.file !== expected.file
    || actual.bytes !== expected.bytes
    || actual.sha256 !== expected.sha256
  ) {
    throw new Error(`${label} does not match its release manifest digest`)
  }
}

function assertExpectedStageEntries(layout) {
  const entries = readdirSync(layout.stage).sort()
  const expected = [
    'SBOM.spdx.json',
    'THIRD_PARTY_LICENSES.md',
    'THIRD_PARTY_NOTICES.md',
    layout.artifactName,
    layout.manifestName,
  ].sort()
  if (JSON.stringify(entries) !== JSON.stringify(expected)) {
    throw new Error(`release staging contains unexpected files: ${entries.join(', ')}`)
  }
}

function assertSafeStage(stage) {
  const normalized = resolve(stage)
  if (!normalized.endsWith(join('src-tauri', 'target', 'release-artifacts'))) {
    throw new Error(`unsafe release staging path: ${stage}`)
  }
}
