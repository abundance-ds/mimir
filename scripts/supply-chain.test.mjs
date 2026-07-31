import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assertAllowedLicense,
  assertCompleteInventory,
  assertLicensePolicy,
  evaluateLicense,
  parseBunLock,
  parseCargoLock,
} from './lib/supply-chain.mjs'

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
