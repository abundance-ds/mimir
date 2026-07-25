import { spawn } from 'node:child_process'
import { join } from 'node:path'

const nodeOptions = [process.env.NODE_OPTIONS, '--no-experimental-webstorage']
  .filter(Boolean)
  .join(' ')
const vitest = join(process.cwd(), 'node_modules', 'vitest', 'vitest.mjs')
const child = spawn(process.execPath, [vitest, 'run', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: { ...process.env, NODE_OPTIONS: nodeOptions },
})

child.once('error', (error) => {
  console.error(error.message)
  process.exitCode = 1
})
child.once('exit', (code, signal) => {
  process.exitCode = signal ? 1 : (code ?? 1)
})
