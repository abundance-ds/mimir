import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  argumentValue,
  gitSourceIdentity,
  macReleaseLayout,
  verifyReleaseStage,
} from './lib/release-artifacts.mjs'
import { REPOSITORY_ROOT } from './release-env.mjs'

const target = argumentValue(process.argv.slice(2), '--target') || 'aarch64-apple-darwin'
const tauriConfig = JSON.parse(
  readFileSync(resolve(REPOSITORY_ROOT, 'src-tauri/tauri.conf.json'), 'utf8'),
)
const targetRoot = target ? join('target', target) : 'target'
const layout = macReleaseLayout({
  repositoryRoot: REPOSITORY_ROOT,
  bundleRoot: resolve(REPOSITORY_ROOT, 'src-tauri', targetRoot, 'release', 'bundle'),
  productName: tauriConfig.productName,
  version: tauriConfig.version,
  target,
})
const identity = gitSourceIdentity(REPOSITORY_ROOT)
const manifest = verifyReleaseStage({
  repositoryRoot: REPOSITORY_ROOT,
  layout,
  identity,
})
console.log(
  `Release stage verified for ${manifest.source.gitCommit}: `
  + `${manifest.artifact.file} sha256:${manifest.artifact.sha256}`,
)
