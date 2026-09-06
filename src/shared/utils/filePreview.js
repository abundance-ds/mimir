const IMAGE_TYPES = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
  webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml',
}

export function imageMimeType(path) {
  return IMAGE_TYPES[String(path || '').split('.').at(-1).toLowerCase()] || ''
}

export function isSvgPath(path) {
  return imageMimeType(path) === 'image/svg+xml'
}

// Used when a trusted Editor route opens a file outside the workspace inspector.
export function fallbackOpenEntry(path) {
  const name = String(path).split(/[\\/]/).at(-1)
  const extension = name.includes('.') ? name.split('.').at(-1).toLowerCase() : ''
  const openBehavior = extension === 'pdf'
    ? 'pdf'
    : EXTERNAL_EXTENSIONS.has(extension) ? 'external' : 'text'
  return { path, name, isDirectory: false, textReadable: openBehavior === 'text', openBehavior }
}

const EXTERNAL_EXTENSIONS = new Set([
  '7z', 'avi', 'bmp', 'db', 'dll', 'dylib', 'eot', 'exe', 'gif', 'gz', 'ico',
  'jar', 'jpeg', 'jpg', 'mkv', 'mov', 'mp3', 'mp4', 'otf', 'png', 'rar', 'so',
  'sqlite', 'sqlite3', 'tar', 'tif', 'tiff', 'ttf', 'wav', 'wasm', 'webp', 'woff',
  'woff2', 'zip',
])
