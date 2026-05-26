const MAX_FILE_SIZE = 20 * 1024 * 1024

const MEDIA_TYPE_MAP = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  pdf: 'application/pdf',
  md: 'text/markdown',
  txt: 'text/plain',
  csv: 'text/csv',
  json: 'application/json',
  yaml: 'text/yaml',
  yml: 'text/yaml',
  xml: 'text/xml',
}

export const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp']
export const PDF_EXTENSIONS = ['pdf']
export const TEXT_EXTENSIONS = ['md', 'txt', 'csv', 'json', 'yaml', 'yml', 'xml']
export const ALL_FILE_EXTENSIONS = [...IMAGE_EXTENSIONS, ...PDF_EXTENSIONS, ...TEXT_EXTENSIONS]

export function mediaTypeFromFilename(name) {
  if (!name) return null
  const ext = name.split('.').pop()?.toLowerCase()
  return MEDIA_TYPE_MAP[ext] || null
}

export function isImageType(mediaType) {
  return typeof mediaType === 'string' && mediaType.startsWith('image/')
}

export function isPdfType(mediaType) {
  return mediaType === 'application/pdf'
}

export function isTextType(mediaType) {
  return typeof mediaType === 'string' && (mediaType.startsWith('text/') || mediaType === 'application/json')
}

export function toDataUrl(mediaType, base64) {
  return `data:${mediaType};base64,${base64}`
}

export function toFileUIParts(attachments) {
  if (!attachments || !Array.isArray(attachments)) return []
  return attachments.map((att) => ({
    type: 'file',
    mediaType: att.mediaType,
    filename: att.filename,
    url: att.dataUrl,
  }))
}

export function validateFileSize(size) {
  return size <= MAX_FILE_SIZE
}

export function isAttachmentPlaceholder(part) {
  return part != null && part._attachmentPlaceholder === true
}
