import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const DEFAULT_ENV_PATH = resolve(REPOSITORY_ROOT, '.env')
export const DEFAULT_UPDATER_KEY_PATH = resolve(homedir(), '.config/mimir/release/updater.key')
export const UPDATER_KEYCHAIN_SERVICE = 'rs.shoulde.mimir.updater-signing'

function parseValue(raw) {
  const value = raw.trim()
  if (value.length >= 2 && value[0] === value.at(-1)) {
    if (value[0] === '"') return JSON.parse(value)
    if (value[0] === "'") return value.slice(1, -1)
  }
  return value.replace(/\s+#.*$/, '').trim()
}

export function parseEnv(text) {
  const values = new Map()
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/s)
    if (!match) throw new Error(`invalid .env assignment: ${line.slice(0, 40)}`)
    values.set(match[1], parseValue(match[2]))
  }
  return values
}

export function loadReleaseEnv({
  env = process.env,
  path = DEFAULT_ENV_PATH,
  allowMissing = false,
} = {}) {
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    if (allowMissing && error.code === 'ENOENT') text = ''
    else throw error
  }

  for (const [key, value] of parseEnv(text)) {
    if (env[key] === undefined) env[key] = value
  }

  // The original certificate bundle came from electron-builder. Keep those
  // aliases usable while presenting Tauri with its native variable names.
  env.APPLE_CERTIFICATE ||= env.CSC_LINK
  env.APPLE_CERTIFICATE_PASSWORD ||= env.CSC_KEY_PASSWORD
  env.APPLE_PASSWORD ||= env.APPLE_APP_SPECIFIC_PASSWORD
  loadLocalUpdaterCredentials(env)
  return env
}

export const APPLE_RELEASE_KEYS = [
  'APPLE_CERTIFICATE',
  'APPLE_CERTIFICATE_PASSWORD',
  'APPLE_SIGNING_IDENTITY',
  'APPLE_ID',
  'APPLE_PASSWORD',
  'APPLE_TEAM_ID',
]

export const CONNECTION_RELEASE_KEYS = [
  'MIMIR_GOOGLE_OAUTH_CLIENT_ID',
  'MIMIR_GOOGLE_OAUTH_CLIENT_SECRET',
  'MIMIR_SLACK_CLIENT_ID',
]

export function loadLocalUpdaterCredentials(env) {
  if (!env.TAURI_SIGNING_PRIVATE_KEY && !env.TAURI_SIGNING_PRIVATE_KEY_PATH) {
    if (existsSync(DEFAULT_UPDATER_KEY_PATH)) {
      env.TAURI_SIGNING_PRIVATE_KEY_PATH = DEFAULT_UPDATER_KEY_PATH
    }
  }
  if (
    !env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD
    && process.platform === 'darwin'
    && (env.TAURI_SIGNING_PRIVATE_KEY || env.TAURI_SIGNING_PRIVATE_KEY_PATH)
  ) {
    const password = spawnSync('security', [
      'find-generic-password',
      '-a', userInfo().username,
      '-s', UPDATER_KEYCHAIN_SERVICE,
      '-w',
    ], { encoding: 'utf8' })
    if (password.status === 0) {
      env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD = password.stdout.trim()
    }
  }
  return env
}

export function requireUpdaterKeys(env) {
  if (!env.TAURI_SIGNING_PRIVATE_KEY?.trim() && !env.TAURI_SIGNING_PRIVATE_KEY_PATH?.trim()) {
    throw new Error('Updater signing is missing: TAURI_SIGNING_PRIVATE_KEY or TAURI_SIGNING_PRIVATE_KEY_PATH')
  }
  requireReleaseKeys(env, ['TAURI_SIGNING_PRIVATE_KEY_PASSWORD'], 'Updater')
}

export const WINDOWS_RELEASE_KEYS = [
  'AZURE_CODESIGN_ENDPOINT',
  'AZURE_CODESIGN_ACCOUNT',
  'AZURE_CERT_PROFILE_NAME',
  'AZURE_CODESIGN_PUBLISHER',
  'AZURE_TENANT_ID',
  'AZURE_CLIENT_ID',
  'AZURE_CLIENT_SECRET',
]

export function requireReleaseKeys(env, keys, label) {
  const missing = keys.filter(key => !env[key]?.trim())
  if (missing.length) {
    throw new Error(`${label} signing is missing: ${missing.join(', ')}`)
  }
}

export function windowsSigningConfig(env) {
  requireReleaseKeys(env, WINDOWS_RELEASE_KEYS, 'Windows')
  return {
    bundle: {
      publisher: env.AZURE_CODESIGN_PUBLISHER,
      windows: {
        signCommand: {
          cmd: 'artifact-signing-cli',
          args: [
            '-e', env.AZURE_CODESIGN_ENDPOINT,
            '-a', env.AZURE_CODESIGN_ACCOUNT,
            '-c', env.AZURE_CERT_PROFILE_NAME,
            '-d', 'Mimir',
            '%1',
          ],
        },
      },
    },
  }
}
