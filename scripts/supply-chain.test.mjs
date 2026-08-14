import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  assertAllowedLicense,
  assertCompleteInventory,
  assertLicensePolicy,
  evaluateLicense,
  parseBunLock,
  parseCargoLock,
  sha256,
} from './lib/supply-chain.mjs'

const repositoryRoot = new URL('../', import.meta.url)

const policy = {
  allowedLicenses: ['Apache-2.0', 'ISC', 'MIT'],
  allowedExceptions: ['LLVM-exception'],
  deniedLicensePrefixes: ['AGPL-', 'GPL-', 'LGPL-'],
  firstParty: [],
  overrides: {},
  vendorComponents: [],
}

test('license policy accepts a permitted choice and rejects denied or unknown-only expressions', () => {
  assert.equal(evaluateLicense('(MIT OR GPL-3.0-only) AND ISC', policy).allowed, true)
  assert.deepEqual(evaluateLicense('GPL-3.0-only', policy), {
    allowed: false,
    unknown: [],
    denied: ['GPL-3.0-only'],
  })
  assert.deepEqual(evaluateLicense('Mystery-1.0', policy), {
    allowed: false,
    unknown: ['Mystery-1.0'],
    denied: [],
  })
  assert.throws(
    () => assertAllowedLicense({
      id: 'npm:ambiguous@1.0.0',
      license: 'MIT OR Mystery-1.0',
    }, policy),
    /unknown: Mystery-1.0/,
  )
})

test('lock parsers retain every exact Cargo and aliased Bun identity', () => {
  assert.deepEqual(parseCargoLock(`
[[package]]
name = "one"
version = "1.2.3"
source = "registry+https://example.invalid"
checksum = "abc"
`), [{
    ecosystem: 'cargo',
    name: 'one',
    version: '1.2.3',
    source: 'registry+https://example.invalid',
    checksum: 'abc',
  }])
  assert.deepEqual(parseBunLock(`
  "packages": {
    "one": ["one@1.0.0", "", {}, "sha512-YQ=="],
    "one-alias": ["one@1.0.0", "", {}, ""],
  }
`), [{
    ecosystem: 'npm',
    lockKey: 'one',
    name: 'one',
    version: '1.0.0',
    integrity: 'sha512-YQ==',
  }, {
    ecosystem: 'npm',
    lockKey: 'one-alias',
    name: 'one',
    version: '1.0.0',
    integrity: '',
  }])
})

test('complete-inventory check fails closed when a lock identity is absent', () => {
  const cargoLock = `
[[package]]
name = "locked"
version = "1.0.0"
`
  const bunLock = `
  "packages": {
    "web": ["web@2.0.0", "", {}, ""],
  }
`
  const document = {
    spdxVersion: 'SPDX-2.3',
    packages: [{
      licenseDeclared: 'MIT',
      annotations: [{
        annotationType: 'OTHER',
        comment: 'mimir-component-id:cargo:locked@1.0.0',
      }],
    }],
  }
  assert.throws(
    () => assertCompleteInventory(document, cargoLock, bunLock, policy),
    /npm SBOM drift; missing \[npm:web@2.0.0\]/,
  )
})

test('license policy refuses broad, stale, or unevidenced overrides', () => {
  assert.throws(() => assertLicensePolicy({
    ...policy,
    overrides: {
      'npm:package@*': {
        license: 'MIT',
        evidence: 'https://example.invalid/license',
        reason: 'A broad override must never pass policy review.',
      },
    },
  }, new Set(['npm:package@1.0.0'])), /must be exact and versioned/)
  assert.throws(() => assertLicensePolicy({
    ...policy,
    overrides: {
      'npm:package@1.0.0': {
        license: 'MIT',
        evidence: '',
        reason: 'metadata missing',
      },
    },
  }, new Set(['npm:package@1.0.0'])), /substantive reason and public HTTPS evidence/)
})

test('bundled Commit Mono matches its reviewed asset and license policy', async () => {
  const policySource = await readFile(
    new URL('src-tauri/vendor/license-policy.json', repositoryRoot),
    'utf8',
  )
  const repositoryPolicy = JSON.parse(policySource)
  const component = repositoryPolicy.vendorComponents.find(
    candidate => candidate.id === 'vendor:commit-mono@1.143',
  )
  assert.ok(component, 'Commit Mono must remain in the reviewed vendor inventory')
  assert.equal(component.license, 'OFL-1.1')

  const font = await readFile(
    new URL('public/fonts/CommitMonoV143-VF.woff2', repositoryRoot),
  )
  assert.equal(sha256(font), component.sha256)

  const license = await readFile(
    new URL('public/fonts/CommitMono-LICENSE.txt', repositoryRoot),
    'utf8',
  )
  assert.match(license, /SIL OPEN FONT LICENSE Version 1\.1/u)

  const fontCss = await readFile(
    new URL('src/shared/styles/fonts.css', repositoryRoot),
    'utf8',
  )
  assert.match(fontCss, /url\('\/fonts\/CommitMonoV143-VF\.woff2'\)/u)
})
