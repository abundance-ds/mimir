const HFU_RE = /<hfu[^>]*>[\s\S]*?<\/hfu>/g

export function stripHfu(text) {
  if (!text || typeof text !== 'string') return text || ''
  return text.replace(HFU_RE, '').trim()
}

export function wrapHfu(content) {
  return `<hfu content-hidden-from-user>${content}</hfu>`
}
