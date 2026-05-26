import { IMAGE_EXTENSIONS, ALL_FILE_EXTENSIONS, mediaTypeFromFilename, isTextType, toDataUrl, validateFileSize } from './attachments.js'

export async function pickAndReadAttachment(type) {
  const { open } = await import('@tauri-apps/plugin-dialog')
  const { invoke } = await import('@tauri-apps/api/core')

  const filters = type === 'image'
    ? [{ name: 'Images', extensions: IMAGE_EXTENSIONS }]
    : [{ name: 'Files', extensions: ALL_FILE_EXTENSIONS }]

  const selected = await open({ multiple: false, filters })
  if (!selected) return null

  const path = typeof selected === 'string' ? selected : selected.path
  const filename = path.split('/').pop()
  const mediaType = mediaTypeFromFilename(filename)
  if (!mediaType) return null

  try {
    if (isTextType(mediaType)) {
      const resp = await invoke('read_text_file', { path })
      const content = resp.content
      const size = new Blob([content]).size
      if (!validateFileSize(size)) return { error: 'File exceeds 20MB limit' }
      return { filename, mediaType, content, type: 'text', size }
    }

    const base64 = await invoke('read_binary_file', { path })
    const size = Math.ceil(base64.length * 3 / 4)
    if (!validateFileSize(size)) return { error: 'File exceeds 20MB limit' }
    const dataUrl = toDataUrl(mediaType, base64)
    return { filename, mediaType, dataUrl, size }
  } catch {
    return null
  }
}
