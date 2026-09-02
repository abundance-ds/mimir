import assert from 'node:assert/strict'
import test from 'node:test'
import {
  APPLE_RELEASE_KEYS,
  CONNECTION_RELEASE_KEYS,
  WINDOWS_RELEASE_KEYS,
  loadReleaseEnv,
  parseEnv,
  requireReleaseKeys,
  requireUpdaterKeys,
  stripPersonalSlackTokens,
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

test('requires only the Google client for release packaging', () => {
  assert.deepEqual(CONNECTION_RELEASE_KEYS, [
    'MIMIR_GOOGLE_OAUTH_CLIENT_ID',
    'MIMIR_GOOGLE_OAUTH_CLIENT_SECRET',
  ])
})

test('strips personal Slack tokens before Tauri runs', () => {
  const env = {
    SLACK_TOKEN: 'personal',
    SLACK_ACCESS_TOKEN: 'access',
    SLACK_USER_TOKEN: 'user',
    SLACK_BOT_TOKEN: 'bot',
    MIMIR_SLACK_TOKEN: 'mimir',
    MIMIR_GOOGLE_OAUTH_CLIENT_ID: 'google',
  }
  stripPersonalSlackTokens(env)
  assert.deepEqual(env, {
    MIMIR_GOOGLE_OAUTH_CLIENT_ID: 'google',
  })
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

test('updater signing accepts a secret value or a local key path and requires a password', () => {
  assert.doesNotThrow(() => requireUpdaterKeys({
    TAURI_SIGNING_PRIVATE_KEY: 'private',
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD: 'password',
  }))
  assert.doesNotThrow(() => requireUpdaterKeys({
    TAURI_SIGNING_PRIVATE_KEY_PATH: '/private/updater.key',
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD: 'password',
  }))
  assert.throws(
    () => requireUpdaterKeys({ TAURI_SIGNING_PRIVATE_KEY: 'private' }),
    /TAURI_SIGNING_PRIVATE_KEY_PASSWORD/,
  )
})
