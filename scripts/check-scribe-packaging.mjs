import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const configPath = path.join(root, 'src-tauri', 'tauri.conf.json')
const infoPath = path.join(root, 'src-tauri', 'Info.plist')
const entitlementsPath = path.join(root, 'src-tauri', 'Entitlements.plist')

const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
const macOS = config?.bundle?.macOS
if (macOS?.minimumSystemVersion !== '14.2') {
  throw new Error('Scribe requires bundle.macOS.minimumSystemVersion 14.2')
}
if (macOS?.entitlements !== './Entitlements.plist') {
  throw new Error('Scribe must package src-tauri/Entitlements.plist')
}

const info = fs.readFileSync(infoPath, 'utf8')
for (const key of ['NSMicrophoneUsageDescription', 'NSAudioCaptureUsageDescription']) {
  if (!new RegExp(`<key>${key}</key>\\s*<string>[^<]+</string>`).test(info)) {
    throw new Error(`Info.plist must contain a non-empty ${key} explanation`)
  }
}

const entitlements = fs.readFileSync(entitlementsPath, 'utf8')
if (
  !/<key>com\.apple\.security\.device\.audio-input<\/key>\s*<true\s*\/>/
    .test(entitlements)
) {
  throw new Error('Entitlements.plist must enable the audio-input entitlement')
}

console.log('Scribe macOS packaging contract passed.')
