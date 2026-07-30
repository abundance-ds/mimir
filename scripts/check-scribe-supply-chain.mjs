import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8')
const requireText = (source, expected, label) => {
  if (!source.includes(expected)) {
    throw new Error(`${label} must contain ${JSON.stringify(expected)}`)
  }
}

const platform = read('src-tauri/src/meetings/platform.rs')
const lockfile = read('src-tauri/Cargo.lock')
const notices = read('src-tauri/vendor/THIRD_PARTY_NOTICES.md')
const anarlogNotice = read('src-tauri/vendor/anarlog/NOTICE.md')
const upstream = read('src-tauri/vendor/anarlog/UPSTREAM')
const tauriConfig = JSON.parse(read('src-tauri/tauri.conf.json'))

const revision = 'c521a4b02f422512d734391fdf08bb08c0862f68'
const modelSha = '1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b'
for (const expected of [
  `const REVISION: &str = "${revision}"`,
  'const ARTIFACT_BYTES: u64 = 487_601_967',
  `const SHA256: &str = "${modelSha}"`,
  'https://huggingface.co/ggerganov/whisper.cpp/resolve/{REVISION}/ggml-small.bin',
]) {
  requireText(platform, expected, 'managed model catalog')
}

for (const expected of [
  'name = "whisper-rs"\nversion = "0.16.0"',
  'checksum = "2088172d00f936c348d6a72f488dc2660ab3f507263a195df308a3c2383229f6"',
  'name = "whisper-rs-sys"\nversion = "0.15.0"',
  'checksum = "6986c0fe081241d391f09b9a071fbcbb59720c3563628c3c829057cf69f2a56f"',
]) {
  requireText(lockfile, expected, 'Cargo.lock')
}

for (const expected of [
  revision,
  modelSha,
  '`487601967` bytes',
  'whisper-rs` 0.16.0',
  'whisper-rs-sys` 0.15.0',
  'Embedded version: 1.8.3',
  'Copyright (c) 2022 OpenAI',
  'Copyright (c) 2023-2024 The ggml authors',
  'Copyright (c) 2023-present Fastrepl, Inc.',
]) {
  requireText(notices, expected, 'Scribe third-party notices')
}

const resources = tauriConfig?.bundle?.resources
if (!Array.isArray(resources) || !resources.includes('vendor/THIRD_PARTY_NOTICES.md')) {
  throw new Error('the desktop bundle must include vendor/THIRD_PARTY_NOTICES.md')
}

const anarlogCommit = '08aad83f0c5cef1317d74a31519ae3190d726504'
requireText(upstream, `commit=${anarlogCommit}`, 'Anarlog upstream pin')
for (const expected of [
  'src-tauri/crates/mimir-meeting-audio',
  'src-tauri/crates/mimir-meeting-detect',
  'does **not** depend on the Anarlog',
]) {
  requireText(anarlogNotice, expected, 'Anarlog extraction notice')
}
if (anarlogNotice.includes('does **not** currently contain Anarlog implementation code')) {
  throw new Error('Anarlog notice still claims that no adapted implementation exists')
}

for (const relative of [
  'src-tauri/crates/mimir-meeting-audio/src/lib.rs',
  'src-tauri/crates/mimir-meeting-audio/src/async_ring.rs',
  'src-tauri/crates/mimir-meeting-audio/src/drift.rs',
  'src-tauri/crates/mimir-meeting-audio/src/joiner.rs',
  'src-tauri/crates/mimir-meeting-audio/src/macos/mic.rs',
  'src-tauri/crates/mimir-meeting-audio/src/macos/system_audio.rs',
  'src-tauri/crates/mimir-meeting-audio/src/rt_ring.rs',
  'src-tauri/crates/mimir-meeting-detect/src/lib.rs',
  'src-tauri/crates/mimir-meeting-detect/src/macos.rs',
  'src-tauri/crates/mimir-meeting-detect/src/state.rs',
]) {
  const source = read(relative)
  requireText(source, 'Fastrepl Anarlog', relative)
  requireText(source, anarlogCommit, relative)
}

console.log('Scribe supply-chain and attribution contract passed.')
