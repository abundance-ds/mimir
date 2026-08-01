import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const cli = resolve(root, 'node_modules/@tauri-apps/cli/tauri.js')
const app = resolve(root, 'src-tauri/target/debug/bundle/macos/Mimir.app')
const entitlements = resolve(root, 'src-tauri/Entitlements.plist')

if (process.platform !== 'darwin') {
  throw new Error('The Scribe audio smoke app is macOS-only.')
}

function run(command, args) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (signal) reject(new Error(`${command} stopped by ${signal}`))
      else if (code !== 0) reject(new Error(`${command} exited with status ${code ?? 1}`))
      else resolveRun()
    })
  })
}

await run(process.execPath, [cli, 'build', '--debug', '--bundles', 'app', '--no-sign'])
if (!existsSync(app)) throw new Error(`Tauri did not create ${app}`)
await run('codesign', [
  '--force',
  '--deep',
  '--sign', '-',
  '--timestamp=none',
  '--entitlements', entitlements,
  app,
])
await run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app])

console.log(`Local Scribe smoke app: ${app}`)
console.log(`Launch with: open ${JSON.stringify(app)}`)
