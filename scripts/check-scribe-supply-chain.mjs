import fs from 'node:fs'
import path from 'node:path'
import {
  assertCompleteInventory,
  assertLicensePolicy,
  componentAnnotation,
  renderLicenseInventory,
  sha256,
} from './lib/supply-chain.mjs'

const root = process.cwd()
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8')
const requireText = (source, expected, label) => {
  if (!source.includes(expected)) {
    throw new Error(`${label} must contain ${JSON.stringify(expected)}`)
  }
}

const platform = read('src-tauri/src/meetings/platform.rs')
const models = JSON.parse(read('src-tauri/resources/meeting-models.json'))
const lockfile = read('src-tauri/Cargo.lock')
const bunLock = read('bun.lock')
const notices = read('src-tauri/vendor/THIRD_PARTY_NOTICES.md')
const licenseInventory = read('src-tauri/vendor/THIRD_PARTY_LICENSES.md')
const policySource = read('src-tauri/vendor/license-policy.json')
const policy = JSON.parse(policySource)
const sbom = JSON.parse(read('src-tauri/vendor/SBOM.spdx.json'))
assertLicensePolicy(
  policy,
  new Set(sbom.packages.map(componentAnnotation).filter(Boolean)),
)
const anarlogNotice = read('src-tauri/vendor/anarlog/NOTICE.md')
const upstream = read('src-tauri/vendor/anarlog/UPSTREAM')
const tauriConfig = JSON.parse(read('src-tauri/tauri.conf.json'))

requireText(platform, '../../resources/meeting-models.json', 'managed model catalog')
if (!Array.isArray(models) || models.length === 0) throw new Error('Managed model catalog is empty')
const modelIds = new Set()
for (const model of models) {
  if (!/^[a-z0-9_-]+$/.test(model.id) || modelIds.has(model.id)
    || !/^[a-f0-9]{40}$/.test(model.revision)
    || !/^ggml-[a-z0-9._-]+\.bin$/.test(model.file)
    || !/^[a-f0-9]{64}$/.test(model.sha256)
    || !Number.isSafeInteger(model.bytes) || model.bytes <= 0) {
    throw new Error(`Invalid immutable model catalog entry: ${model.id}`)
  }
  modelIds.add(model.id)
  const id = `model:${model.file}@${model.revision}`
  const component = policy.vendorComponents.find(entry => entry.id === id)
  const location = `https://huggingface.co/ggerganov/whisper.cpp/resolve/${model.revision}/${model.file}`
  if (!component || component.sha256 !== model.sha256
    || component.downloadLocation !== location || component.license !== 'MIT') {
    throw new Error(`Model license inventory does not match the catalog: ${model.id}`)
  }
  requireText(notices,
    `| \`${model.file}\` | \`${model.revision}\` | \`${model.bytes}\` | \`${model.sha256}\` |`,
    'Scribe model notices')
}
if (policy.vendorComponents.filter(entry => entry.id.startsWith('model:')).length !== models.length) {
  throw new Error('Model license inventory contains entries outside the catalog')
}

for (const expected of [
  'name = "whisper-rs"\nversion = "0.16.0"',
  'checksum = "2088172d00f936c348d6a72f488dc2660ab3f507263a195df308a3c2383229f6"',
  'name = "whisper-rs-sys"\nversion = "0.15.0"',
  'checksum = "6986c0fe081241d391f09b9a071fbcbb59720c3563628c3c829057cf69f2a56f"',
]) {
  requireText(lockfile, expected, 'Cargo.lock')
}

for (const expected of [
  'whisper-rs` 0.16.0',
  'whisper-rs-sys` 0.15.0',
  'Embedded version: 1.8.3',
  'Copyright (c) 2022 OpenAI',
  'Copyright (c) 2023-2024 The ggml authors',
  'Copyright (c) 2023-present Fastrepl, Inc.',
]) {
  requireText(notices, expected, 'Scribe third-party notices')
}

const resources = tauriConfig?.bundle?.resources
for (const resource of [
  'vendor/THIRD_PARTY_NOTICES.md',
  'vendor/THIRD_PARTY_LICENSES.md',
  'vendor/SBOM.spdx.json',
]) {
  if (!Array.isArray(resources) || !resources.includes(resource)) {
    throw new Error(`the desktop bundle must include ${resource}`)
  }
}

assertCompleteInventory(sbom, lockfile, bunLock, policy)
const lockDigest = sha256(`${lockfile}\0${bunLock}\0${policySource}`)
if (sbom.documentNamespace !== `https://com.abundanceds.mimir/sbom/${lockDigest}`) {
  throw new Error('SPDX SBOM is stale for the current lockfiles or license policy')
}
if (!sbom.annotations?.some(annotation => (
  annotation.comment === `mimir-lock-digest:sha256:${lockDigest}`
))) {
  throw new Error('SPDX SBOM must carry the current lock digest annotation')
}
if (renderLicenseInventory(sbom) !== licenseInventory) {
  throw new Error('THIRD_PARTY_LICENSES.md is stale for the committed SPDX SBOM')
}
const expectedVendor = new Set(policy.vendorComponents.map(component => component.id))
const actualVendor = new Set(
  sbom.packages.map(componentAnnotation).filter(id => id.startsWith('vendor:') || id.startsWith('model:')),
)
if (
  expectedVendor.size !== actualVendor.size
  || [...expectedVendor].some(id => !actualVendor.has(id))
) {
  throw new Error('SPDX SBOM vendor/model components are stale for license-policy.json')
}

const anarlogCommit = '08aad83f0c5cef1317d74a31519ae3190d726504'
requireText(upstream, `commit=${anarlogCommit}`, 'Anarlog upstream pin')
for (const expected of [
  'src-tauri/crates/mimir-meeting-audio',
  'src-tauri/crates/mimir-meeting-detect',
  'does **not** depend on the Anarlog',
]) {
  requireText(anarlogNotice, expected, 'Anarlog extraction notice')
}
if (anarlogNotice.includes('does **not** currently contain Anarlog implementation code')) {
  throw new Error('Anarlog notice still claims that no adapted implementation exists')
}

for (const relative of [
  'src-tauri/crates/mimir-meeting-audio/src/lib.rs',
  'src-tauri/crates/mimir-meeting-audio/src/async_ring.rs',
  'src-tauri/crates/mimir-meeting-audio/src/drift.rs',
  'src-tauri/crates/mimir-meeting-audio/src/joiner.rs',
  'src-tauri/crates/mimir-meeting-audio/src/macos/mic.rs',
  'src-tauri/crates/mimir-meeting-audio/src/macos/system_audio.rs',
  'src-tauri/crates/mimir-meeting-audio/src/rt_ring.rs',
  'src-tauri/crates/mimir-meeting-detect/src/lib.rs',
  'src-tauri/crates/mimir-meeting-detect/src/macos.rs',
  'src-tauri/crates/mimir-meeting-detect/src/state.rs',
]) {
  const source = read(relative)
  requireText(source, 'Fastrepl Anarlog', relative)
  requireText(source, anarlogCommit, relative)
}

console.log(
  `Scribe supply-chain contract passed: ${sbom.packages.length} locked/reviewed components, `
  + 'complete SPDX and human-readable license inventory packaged.',
)
