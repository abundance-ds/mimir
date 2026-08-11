import { execFileSync } from 'node:child_process'

const tag = process.argv[2]
if (!/^v\d+\.\d+\.\d+$/.test(tag || '')) {
  throw new Error('usage: bun run release:verify -- vX.Y.Z')
}

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
