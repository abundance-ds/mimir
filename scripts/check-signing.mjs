import { spawnSync } from 'node:child_process'
import { statSync } from 'node:fs'
import {
  APPLE_RELEASE_KEYS,
  DEFAULT_ENV_PATH,
  WINDOWS_RELEASE_KEYS,
  loadReleaseEnv,
  requireReleaseKeys,
  requireUpdaterKeys,
  windowsSigningConfig,
} from './release-env.mjs'

const env = loadReleaseEnv()
requireReleaseKeys(env, APPLE_RELEASE_KEYS, 'Apple')
requireUpdaterKeys(env)
const parkedWindowsValues = WINDOWS_RELEASE_KEYS.filter(key => env[key]?.trim())
if (parkedWindowsValues.length && parkedWindowsValues.length !== WINDOWS_RELEASE_KEYS.length) {
  requireReleaseKeys(env, WINDOWS_RELEASE_KEYS, 'Parked Windows')
}
if (parkedWindowsValues.length) windowsSigningConfig(env)

if ((statSync(DEFAULT_ENV_PATH).mode & 0o077) !== 0) {
  throw new Error('.env must not be readable or writable by group/others')
}
if (env.APPLE_CERTIFICATE !== env.CSC_LINK) {
  throw new Error('APPLE_CERTIFICATE and CSC_LINK do not identify the same certificate')
}
if (env.APPLE_CERTIFICATE_PASSWORD !== env.CSC_KEY_PASSWORD) {
  throw new Error('APPLE_CERTIFICATE_PASSWORD and CSC_KEY_PASSWORD do not match')
}
if (env.APPLE_PASSWORD !== env.APPLE_APP_SPECIFIC_PASSWORD) {
  throw new Error('APPLE_PASSWORD and APPLE_APP_SPECIFIC_PASSWORD do not match')
}

if (process.platform === 'darwin') {
  const identities = spawnSync('security', ['find-identity', '-v', '-p', 'codesigning'], {
    encoding: 'utf8',
  })
  if (identities.status !== 0 || !identities.stdout.includes(env.APPLE_SIGNING_IDENTITY)) {
    throw new Error('the configured Apple signing identity is not available in the login keychain')
  }
}

console.log('Apple signing and notarization inputs are complete.')
console.log('Tauri updater signing inputs are complete.')
if (parkedWindowsValues.length) {
  console.log('Parked Windows signing inputs remain complete in local recovery storage.')
}
console.log('.env permissions and legacy-to-Tauri aliases are correct.')
