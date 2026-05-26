import { invoke } from '@tauri-apps/api/core'

const isTauri = () => !!window.__TAURI_INTERNALS__

// --- Library CRUD ---

export async function loadLibrary() {
  if (!isTauri()) return []
  return invoke('ref_list')
}

export async function addReference(entry) {
  if (!isTauri()) return []
  return invoke('ref_add', { entry })
}

export async function removeReference(key) {
  if (!isTauri()) return []
  return invoke('ref_remove', { key })
}

export async function updateReference(entry) {
  if (!isTauri()) return []
  return invoke('ref_update', { entry })
}

// --- Client-side search ---

export function searchReferences(library, query) {
  if (!query || !query.trim()) return library
  const q = query.toLowerCase().trim()
  return library.filter(entry => {
    const title = (entry.title || '').toLowerCase()
    const key = (entry._key || '').toLowerCase()
    const authors = (entry.author || [])
      .map(a => `${a.family || ''} ${a.given || ''}`.toLowerCase())
      .join(' ')
    return title.includes(q) || key.includes(q) || authors.includes(q)
  })
}

// --- Cited keys extraction ---

export function extractCitedKeys(markdownContent) {
  // Match [@key] and [@key1; @key2] patterns
  const matches = markdownContent.matchAll(/\[@([^\]]+)\]/g)
  const keys = new Set()
  for (const match of matches) {
    // Split on ; for multi-cite groups
    const parts = match[1].split(';')
    for (const part of parts) {
      const keyMatch = part.trim().match(/^@?(.+?)(?:\s*,.*)?$/)
      if (keyMatch) keys.add(keyMatch[1].trim())
    }
  }
  return [...keys]
}
