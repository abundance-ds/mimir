import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
// Keep the retired name explicit in this guard. Production code must never
// hide it in string fragments to evade repository search.
const priorSlug = 'mim'
const priorDisplay = 'Mim'
const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const escapedPrior = escapeRegExp(priorSlug)

const forbidden = [
  ['previous display/slug as a complete word', new RegExp(`\\b${escapedPrior}\\b`, 'i')],
  ['previous CLI', new RegExp(`${escapedPrior}x`, 'i')],
  ['previous package name', new RegExp(`${escapedPrior}[-_]workbench`, 'i')],
  ['previous repository name', new RegExp(`${escapedPrior}-panel`, 'i')],
  ['previous data directory', new RegExp(`\\.${escapedPrior}(?=$|[/\\\\'"\\s])`, 'i')],
  ['previous environment prefix', new RegExp(`${escapedPrior.toUpperCase()}_`)],
  ['previous bundle/keychain namespace', new RegExp(`(?:rs\\.shoulde|com)\\.${escapedPrior}(?:\\.|\\b)`, 'i')],
]
const forbiddenObfuscation = [
  ['fragmented previous identity in Rust concat', /concat!\(\s*["']m["']\s*,\s*["']i["']\s*,\s*["']m["']/i],
  ['fragmented previous identity in a joined array', /\[\s*["']m["']\s*,\s*["']i["']\s*,\s*["']m["']\s*\]\.join/i],
]
const identityGuardFile = 'scripts/check-identity.mjs'

const requiredFiles = [
  'bin/mimir.mjs',
  'bin/pi-mimir-extension.ts',
  'src/apps/sdk/mimir-sdk.js',
  'src/mimir/App.vue',
  'src-tauri/src/mimir_cli.rs',
  'src-tauri/tests/mimir_cli_contract.rs',
  'src-tauri/tests/fixtures/mimir-home/v0.1.0/settings.json',
]

const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const tauriConfig = JSON.parse(fs.readFileSync(path.join(root, 'src-tauri/tauri.conf.json'), 'utf8'))
const cargoToml = fs.readFileSync(path.join(root, 'src-tauri/Cargo.toml'), 'utf8')
const failures = []

if (packageJson.name !== 'mimir') failures.push('package.json name must be "mimir"')
if (packageJson.bin?.mimir !== 'bin/mimir.mjs') {
  failures.push('package.json must expose bin/mimir.mjs as the "mimir" CLI')
}
if (tauriConfig.productName !== 'Mimir') failures.push('Tauri productName must be "Mimir"')
if (tauriConfig.identifier !== 'rs.shoulde.mimir') {
  failures.push('Tauri identifier must be "rs.shoulde.mimir"')
}
if (!/^\s*name\s*=\s*"mimir"\s*$/m.test(cargoToml)) {
  failures.push('Cargo package/lib name must be "mimir"')
}
for (const file of requiredFiles) {
  if (!fs.existsSync(path.join(root, file))) failures.push(`required Mimir path is missing: ${file}`)
}

const files = execFileSync(
  'git',
  ['ls-files', '-co', '--exclude-standard', '-z'],
  { cwd: root, encoding: 'utf8' },
).split('\0').filter(Boolean)

for (const file of files) {
  const absolute = path.join(root, file)
  if (!fs.existsSync(absolute)) continue

  for (const [label, pattern] of forbidden) {
    if (pattern.test(file)) failures.push(`${file}: path contains ${label}`)
  }

  let bytes
  try {
    bytes = fs.readFileSync(absolute)
  } catch {
    continue
  }
  if (bytes.includes(0)) continue
  const text = bytes.toString('utf8')
  if (file === identityGuardFile) continue
  for (const [label, pattern] of forbidden) {
    if (pattern.test(text)) failures.push(`${file}: content contains ${label}`)
  }
  for (const [label, pattern] of forbiddenObfuscation) {
    if (pattern.test(text)) failures.push(`${file}: content contains ${label}`)
  }
}

if (failures.length) {
  console.error(`Mimir identity check failed (${failures.length}):`)
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}

console.log(
  `Mimir identity check passed: ${files.length} repository files use the Mimir contract; `
  + `${priorDisplay} identities are absent outside this explicit guard.`,
)
