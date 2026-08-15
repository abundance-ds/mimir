import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { REPOSITORY_ROOT } from './release-env.mjs'

export function resolveReleaseTag(argument, repositoryRoot = REPOSITORY_ROOT) {
  let tag = argument
  if (tag === undefined) {
    const packageVersion = JSON.parse(
      readFileSync(resolve(repositoryRoot, 'package.json'), 'utf8'),
    ).version
    const tauriVersion = JSON.parse(
      readFileSync(resolve(repositoryRoot, 'src-tauri/tauri.conf.json'), 'utf8'),
    ).version
    const cargoSource = readFileSync(resolve(repositoryRoot, 'src-tauri/Cargo.toml'), 'utf8')
    const cargoVersion = cargoSource.match(/^\s*version\s*=\s*"([^"]+)"/m)?.[1]
    if (!cargoVersion || packageVersion !== cargoVersion || packageVersion !== tauriVersion) {
      throw new Error('package, Cargo, and Tauri versions must match before release verification')
    }
    tag = `v${packageVersion}`
  }
  if (!/^v\d+\.\d+\.\d+$/.test(tag)) {
    throw new Error('usage: bun run release:verify [-- vX.Y.Z]')
  }
  return tag
}

async function main() {
  const tag = resolveReleaseTag(process.argv[2])
  const version = tag.slice(1)
  const expectedAssets = new Set([
    `Mimir_${version}_aarch64.dmg`,
    `Mimir_${version}_aarch64.app.tar.gz`,
    `Mimir_${version}_aarch64.app.tar.gz.sig`,
    `Mimir_${version}_aarch64.manifest.json`,
    'latest.json',
    'SBOM.spdx.json',
    'THIRD_PARTY_LICENSES.md',
    'THIRD_PARTY_NOTICES.md',
  ])

  const release = JSON.parse(execFileSync('gh', [
    'release', 'view', tag,
    '--repo', 'shoulders-ai/mimir',
    '--json', 'assets,isDraft,tagName,url',
  ], { encoding: 'utf8' }))
  if (release.isDraft) throw new Error(`${tag} is still a draft`)
  if (release.tagName !== tag) throw new Error(`release tag mismatch: ${release.tagName}`)
  const names = new Set(release.assets.map(asset => asset.name))
  if (names.size !== expectedAssets.size || [...expectedAssets].some(name => !names.has(name))) {
    throw new Error(`release assets do not match the ${tag} contract: ${[...names].join(', ')}`)
  }

  const feedUrl = 'https://github.com/shoulders-ai/mimir/releases/latest/download/latest.json'
  const feedResponse = await fetch(feedUrl, { redirect: 'follow' })
  if (!feedResponse.ok) throw new Error(`public updater feed returned HTTP ${feedResponse.status}`)
  const feed = await feedResponse.json()
  if (feed.version !== version) {
    throw new Error(`public updater feed has ${feed.version}; expected ${version}`)
  }
  const updaterUrl = `https://github.com/shoulders-ai/mimir/releases/download/${tag}/Mimir_${version}_aarch64.app.tar.gz`
  const platform = feed.platforms?.['darwin-aarch64']
  if (!platform?.signature || platform.url !== updaterUrl) {
    throw new Error('public updater feed does not identify the signed macOS arm64 archive')
  }
  const updaterResponse = await fetch(updaterUrl, { method: 'HEAD', redirect: 'follow' })
  if (!updaterResponse.ok) {
    throw new Error(`public updater archive returned HTTP ${updaterResponse.status}`)
  }

  console.log(`${tag} is published and the public signed updater feed is ready: ${release.url}`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main()
