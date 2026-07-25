import { spawn } from 'node:child_process'
import { join } from 'node:path'

const disableRegisterDeprecation = '--disable-warning=DEP0205'
const nodeOptions = [process.env.NODE_OPTIONS, disableRegisterDeprecation].filter(Boolean).join(' ')
const vite = join(process.cwd(), 'node_modules', 'vite', 'bin', 'vite.js')
const child = spawn(process.execPath, [vite, 'build', ...process.argv.slice(2)], {
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
