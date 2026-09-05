import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  assertAllowedLicense,
  assertLicensePolicy,
  canonicalLicense,
  componentId,
  parseBunLock,
  renderLicenseInventory,
  sha256,
} from './lib/supply-chain.mjs'

const root = resolve(import.meta.dirname, '..')
const read = relative => readFileSync(resolve(root, relative), 'utf8')
const cargoLock = read('src-tauri/Cargo.lock')
const bunLock = read('bun.lock')
const policySource = read('src-tauri/vendor/license-policy.json')
const policy = JSON.parse(policySource)
const cargoMetadata = JSON.parse(execFileSync('cargo', [
  'metadata',
  '--locked',
  '--format-version', '1',
  '--manifest-path', 'src-tauri/Cargo.toml',
], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }))

const npmEntries = mergeNpmEntries(parseBunLock(bunLock))
const npmMetadata = await mapLimit(npmEntries, 12, loadNpmMetadata)
const components = [
  ...cargoMetadata.packages.map(cargoComponent),
  ...npmMetadata.map(npmComponent),
  ...policy.vendorComponents.map(vendorComponent),
]
assertLicensePolicy(policy, new Set(components.map(component => component.id)))
for (const component of components) {
  component.license = assertAllowedLicense(component, policy)
}

const lockDigest = sha256(`${cargoLock}\0${bunLock}\0${policySource}`)
const created = deterministicCreationTime()
const packages = components
  .sort((left, right) => left.id.localeCompare(right.id))
  .map(component => spdxPackage(component, created))
const document = {
  spdxVersion: 'SPDX-2.3',
  dataLicense: 'CC0-1.0',
  SPDXID: 'SPDXRef-DOCUMENT',
  name: 'Mimir complete locked dependency inventory',
  documentNamespace: `https://com.abundanceds.mimir/sbom/${lockDigest}`,
  creationInfo: {
    created,
    creators: ['Tool: scripts/generate-supply-chain.mjs'],
    comment: 'Generated deterministically from the latest committed Cargo lock, Bun lock, and license policy inputs.',
  },
  packages,
  relationships: packages.map(component => ({
    spdxElementId: 'SPDXRef-DOCUMENT',
    relationshipType: 'DESCRIBES',
    relatedSpdxElement: component.SPDXID,
  })),
  annotations: [{
    annotationDate: created,
    annotationType: 'OTHER',
    annotator: 'Tool: scripts/generate-supply-chain.mjs',
    comment: `mimir-lock-digest:sha256:${lockDigest}`,
  }],
}

writeFileSync(
  resolve(root, 'src-tauri/vendor/SBOM.spdx.json'),
  `${JSON.stringify(document, null, 2)}\n`,
)
writeFileSync(
  resolve(root, 'src-tauri/vendor/THIRD_PARTY_LICENSES.md'),
  renderLicenseInventory(document),
)
console.log(
  `Generated SPDX SBOM and license inventory for ${cargoMetadata.packages.length} Cargo, `
  + `${npmMetadata.length} npm, and ${policy.vendorComponents.length} vendor components.`,
)

function cargoComponent(pkg) {
  const id = `cargo:${pkg.name}@${pkg.version}`
  const checksum = cargoChecksum(pkg)
  return {
    id,
    name: pkg.name,
    version: pkg.version,
    ecosystem: 'cargo',
    license: pkg.license ?? '',
    downloadLocation: pkg.source?.startsWith('registry+https://github.com/rust-lang/crates.io-index')
      ? `https://crates.io/api/v1/crates/${encodeURIComponent(pkg.name)}/${encodeURIComponent(pkg.version)}/download`
      : pkg.source?.replace(/^registry\+/, '') ?? 'NOASSERTION',
    checksum,
    purl: `pkg:cargo/${encodeURIComponent(pkg.name)}@${encodeURIComponent(pkg.version)}`,
  }
}

function cargoChecksum(pkg) {
  const source = pkg.source ?? ''
  if (!source.startsWith('registry+')) return ''
  const block = cargoLock.split(/^\[\[package\]\]\s*$/m).find(candidate => (
    candidate.includes(`name = "${pkg.name}"`)
    && candidate.includes(`version = "${pkg.version}"`)
    && candidate.includes(`source = "${source}"`)
  ))
  return block?.match(/^checksum = "([^"]+)"/m)?.[1] ?? ''
}

function mergeNpmEntries(entries) {
  const merged = new Map()
  for (const entry of entries) {
    const id = componentId(entry)
    const current = merged.get(id) ?? { ...entry, lockKeys: [], integrities: [] }
    current.lockKeys.push(entry.lockKey)
    if (entry.integrity) current.integrities.push(entry.integrity)
    merged.set(id, current)
  }
  return [...merged.values()].map(entry => ({
    ...entry,
    lockKeys: [...new Set(entry.lockKeys)].sort(),
    integrities: [...new Set(entry.integrities)].sort(),
  }))
}

async function loadNpmMetadata(entry) {
  const endpoint = `https://registry.npmjs.org/${entry.name.replace('/', '%2F')}/${encodeURIComponent(entry.version)}`
  const response = await fetch(endpoint, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) throw new Error(`npm metadata ${entry.name}@${entry.version}: HTTP ${response.status}`)
  return { entry, metadata: await response.json() }
}

function npmComponent({ entry, metadata }) {
  const integrity = entry.integrities[0] || metadata.dist?.integrity || ''
  return {
    id: componentId(entry),
    name: entry.name,
    version: entry.version,
    ecosystem: 'npm',
    license: licenseString(metadata.license ?? metadata.licenses),
    downloadLocation: metadata.dist?.tarball ?? `https://registry.npmjs.org/${entry.name}`,
    checksum: integrityToSha512(integrity),
    purl: `pkg:npm/${encodeURIComponent(entry.name)}@${encodeURIComponent(entry.version)}`,
    comment: `bun.lock keys: ${entry.lockKeys.join(', ')}`,
  }
}

function vendorComponent(component) {
  return {
    ...component,
    ecosystem: 'vendor',
    checksum: component.sha256 ?? '',
  }
}

function licenseString(value) {
  if (typeof value === 'string') return canonicalLicense(value)
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return canonicalLicense(value.type)
  }
  if (!Array.isArray(value)) return ''
  return canonicalLicense(value.map(item => (
    typeof item === 'string' ? item : item?.type
  )).filter(Boolean).join(' OR '))
}

function integrityToSha512(integrity) {
  if (!integrity.startsWith('sha512-')) return ''
  return Buffer.from(integrity.slice('sha512-'.length), 'base64').toString('hex')
}

function spdxPackage(component, created) {
  const SPDXID = `SPDXRef-Package-${createHash('sha256').update(component.id).digest('hex').slice(0, 24)}`
  return {
    name: component.name,
    SPDXID,
    versionInfo: component.version,
    downloadLocation: component.downloadLocation || 'NOASSERTION',
    filesAnalyzed: false,
    licenseConcluded: component.license,
    licenseDeclared: component.license,
    copyrightText: 'NOASSERTION',
    ...(component.checksum ? {
      checksums: [{
        algorithm: component.ecosystem === 'npm' ? 'SHA512' : 'SHA256',
        checksumValue: component.checksum,
      }],
    } : {}),
    externalRefs: component.purl ? [{
      referenceCategory: 'PACKAGE-MANAGER',
      referenceType: 'purl',
      referenceLocator: component.purl,
    }] : [],
    annotations: [{
      annotationDate: created,
      annotationType: 'OTHER',
      annotator: 'Tool: scripts/generate-supply-chain.mjs',
      comment: `mimir-component-id:${component.id}`,
    }, ...(component.comment ? [{
      annotationDate: created,
      annotationType: 'OTHER',
      annotator: 'Tool: scripts/generate-supply-chain.mjs',
      comment: component.comment,
    }] : [])],
  }
}

function deterministicCreationTime() {
  const value = execFileSync('git', [
    'log', '-1', '--format=%cI', '--',
    'src-tauri/Cargo.lock',
    'bun.lock',
    'src-tauri/vendor/license-policy.json',
  ], { cwd: root, encoding: 'utf8' }).trim()
  return new Date(value || 0).toISOString().replace('.000Z', 'Z')
}

async function mapLimit(values, limit, operation) {
  const results = new Array(values.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (next < values.length) {
      const index = next
      next += 1
      results[index] = await operation(values[index])
    }
  }))
  return results
}
