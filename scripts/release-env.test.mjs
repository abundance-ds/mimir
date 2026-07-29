import assert from 'node:assert/strict'
import test from 'node:test'
import {
  APPLE_RELEASE_KEYS,
  WINDOWS_RELEASE_KEYS,
  loadReleaseEnv,
  parseEnv,
  requireReleaseKeys,
  windowsSigningConfig,
} from './release-env.mjs'

test('parses dotenv and shell-export assignments with last value winning', () => {
  const values = parseEnv(`
    # comment
    export NAME="first"
    SINGLE='two'
    PLAIN=three # comment
    NAME="last"
  `)
  assert.deepEqual(Object.fromEntries(values), {
    NAME: 'last',
    SINGLE: 'two',
    PLAIN: 'three',
  })
})

test('loads legacy Apple aliases without replacing explicit environment values', () => {
  const env = {
    APPLE_PASSWORD: 'explicit',
    CSC_LINK: 'certificate',
    CSC_KEY_PASSWORD: 'certificate-password',
    APPLE_APP_SPECIFIC_PASSWORD: 'legacy-password',
  }
  loadReleaseEnv({ env, path: '/missing', allowMissing: true })
  assert.equal(env.APPLE_CERTIFICATE, 'certificate')
  assert.equal(env.APPLE_CERTIFICATE_PASSWORD, 'certificate-password')
  assert.equal(env.APPLE_PASSWORD, 'explicit')
})

test('retains a credential-safe Windows signing recipe while the platform is parked', () => {
  const env = Object.fromEntries([...APPLE_RELEASE_KEYS, ...WINDOWS_RELEASE_KEYS].map(key => [key, key]))
  requireReleaseKeys(env, APPLE_RELEASE_KEYS, 'Apple')
  const config = windowsSigningConfig(env)
  const serialized = JSON.stringify(config)
  assert.match(serialized, /artifact-signing-cli/)
  assert.match(serialized, /AZURE_CODESIGN_ENDPOINT/)
  assert.doesNotMatch(serialized, /AZURE_CLIENT_SECRET/)
  assert.doesNotMatch(serialized, /AZURE_TENANT_ID/)
})
