import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  statSync,
} from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const MODULE_PATH = fileURLToPath(import.meta.url)
const DEFAULT_REPOSITORY_ROOT = resolve(dirname(MODULE_PATH), '..')
const MACOS_ARM64_TARGET = 'aarch64-apple-darwin'
const RUNNER_ENV = 'CARGO_TARGET_AARCH64_APPLE_DARWIN_RUNNER'

function argumentValue(args, name) {
  const inline = args.find(argument => argument.startsWith(`${name}=`))
  if (inline) return inline.slice(name.length + 1)
  const index = args.indexOf(name)
  return index === -1 ? '' : (args[index + 1] ?? '')
}

function hasTauriRunner(args) {
  return args.some(argument => (
    argument === '--runner'
    || argument === '-r'
    || argument.startsWith('--runner=')
  ))
}

export function configureMacDevCommand({
  args,
  env,
  platform = process.platform,
  architecture = process.arch,
  repositoryRoot = DEFAULT_REPOSITORY_ROOT,
}) {
  if (platform !== 'darwin' || args[0] !== 'dev' || hasTauriRunner(args)) {
    return false
  }

  const requestedTarget = argumentValue(args, '--target')
  if (requestedTarget && requestedTarget !== MACOS_ARM64_TARGET) return false
  if (!requestedTarget && architecture !== 'arm64') return false

  env[RUNNER_ENV] ||= resolve(repositoryRoot, 'scripts/run-macos-dev-app')
  env.MIMIR_DEV_NODE ||= process.execPath
  return true
}

function runChecked(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' })
  if (result.error) throw result.error
  if (result.status === 0) return
  const detail = String(result.stderr || result.stdout || '').trim()
  throw new Error(`${command} exited with status ${result.status ?? 1}${detail ? `: ${detail}` : ''}`)
}

function insertPlistValue(plistPath, key, type, value) {
  const flag = type === 'boolean' ? '-bool' : '-string'
  runChecked('plutil', ['-insert', key, flag, String(value), plistPath])
}

export function prepareMacDevApp({
  binaryPath,
  repositoryRoot = DEFAULT_REPOSITORY_ROOT,
  appRoot,
  signingIdentity = process.env.APPLE_SIGNING_IDENTITY || '-',
}) {
  if (process.platform !== 'darwin') {
    throw new Error('The bundled development runner is macOS-only.')
  }

  const sourceBinary = resolve(binaryPath)
  const config = JSON.parse(readFileSync(
    resolve(repositoryRoot, 'src-tauri/tauri.conf.json'),
    'utf8',
  ))
  const resolvedAppRoot = appRoot || resolve(
    dirname(sourceBinary),
    'bundle',
    'macos',
    `${config.productName}.app`,
  )
  const contentsRoot = resolve(resolvedAppRoot, 'Contents')
  const macosRoot = resolve(contentsRoot, 'MacOS')
  const resourcesRoot = resolve(contentsRoot, 'Resources')
  const executablePath = resolve(macosRoot, 'mimir')
  const plistPath = resolve(contentsRoot, 'Info.plist')

  mkdirSync(macosRoot, { recursive: true })
  mkdirSync(resourcesRoot, { recursive: true })
  copyFileSync(sourceBinary, executablePath)
  chmodSync(executablePath, (statSync(sourceBinary).mode & 0o777) | 0o111)
  copyFileSync(resolve(repositoryRoot, 'src-tauri/Info.plist'), plistPath)
  copyFileSync(
    resolve(repositoryRoot, 'src-tauri/icons/icon.icns'),
    resolve(resourcesRoot, 'icon.icns'),
  )

  for (const resource of config.bundle.resources || []) {
    const destination = resolve(resourcesRoot, resource)
    mkdirSync(dirname(destination), { recursive: true })
    copyFileSync(resolve(repositoryRoot, 'src-tauri', resource), destination)
  }

  const plistValues = [
    ['CFBundleDevelopmentRegion', 'string', 'English'],
    ['CFBundleDisplayName', 'string', config.productName],
    ['CFBundleExecutable', 'string', basename(executablePath)],
    ['CFBundleIconFile', 'string', 'icon.icns'],
    ['CFBundleIdentifier', 'string', config.identifier],
    ['CFBundleInfoDictionaryVersion', 'string', '6.0'],
    ['CFBundleName', 'string', config.productName],
    ['CFBundlePackageType', 'string', 'APPL'],
    ['CFBundleShortVersionString', 'string', config.version],
    ['CFBundleVersion', 'string', config.version],
    ['CSResourcesFileMapped', 'boolean', true],
    ['LSMinimumSystemVersion', 'string', config.bundle.macOS.minimumSystemVersion],
    ['NSHighResolutionCapable', 'boolean', true],
  ]
  for (const [key, type, value] of plistValues) {
    insertPlistValue(plistPath, key, type, value)
  }

  runChecked('codesign', [
    '--force',
    '--deep',
    '--sign', signingIdentity,
    '--timestamp=none',
    '--entitlements', resolve(repositoryRoot, 'src-tauri/Entitlements.plist'),
    resolvedAppRoot,
  ])
  runChecked('codesign', ['--verify', '--deep', '--strict', '--verbose=2', resolvedAppRoot])

  return {
    appRoot: resolvedAppRoot,
    executablePath,
    signingIdentity,
  }
}

function main() {
  const binaryPath = process.argv[2]
  if (!binaryPath) throw new Error('The Cargo runner did not provide a debug executable.')
  const prepared = prepareMacDevApp({ binaryPath })
  const signature = prepared.signingIdentity === '-'
    ? 'an ad-hoc development signature'
    : prepared.signingIdentity
  console.error(`Prepared ${prepared.appRoot} with ${signature}.`)
  if (prepared.signingIdentity === '-') {
    console.error(
      'Set APPLE_SIGNING_IDENTITY to keep macOS audio permission stable across Rust rebuilds.',
    )
  }
}

if (process.argv[1] && resolve(process.argv[1]) === MODULE_PATH) {
  try {
    main()
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
