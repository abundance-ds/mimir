import { getDataDir } from '../../dataDir.js'
import { issuesDir, ensureIssuesDir, knowledgeDir, ensureKnowledgeDir, parseBoardEntry, validateIssueMeta } from '../../board/loader.js'

async function resolveByTitle(dir, relativePath) {
  const needle = relativePath.replace(/\.md$/, '').toLowerCase()
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    const listing = await invoke('list_dir', { path: dir })
    for (const item of listing) {
      if (item.is_dir || !item.name.endsWith('.md')) continue
      try {
        const { content } = await invoke('read_text_file', { path: item.path })
        const { meta } = parseBoardEntry(content)
        if (meta.title && meta.title.toLowerCase() === needle) return item.path
      } catch { /* skip unreadable */ }
    }
  } catch { /* dir doesn't exist */ }
  return null
}

async function reloadBoard(context) {
  const { useBoardStore } = await import('../../../stores/panel/board.js')
  useBoardStore().loadBoard(context.projectId)
}

const handlers = {
  '@issues/': {
    bypassProposals: true,

    async resolve(relativePath, context) {
      const dir = await issuesDir(context.projectId)
      const direct = `${dir}/${relativePath}`
      try {
        const { invoke } = await import('@tauri-apps/api/core')
        await invoke('read_text_file', { path: direct })
        return direct
      } catch {
        return await resolveByTitle(dir, relativePath) || direct
      }
    },

    validate(content) {
      try {
        const { meta } = parseBoardEntry(content)
        if (meta.type && meta.type !== 'issue') return { error: 'Entries at @issues/ must have type: issue' }
        const { valid, errors } = validateIssueMeta({ ...meta, type: 'issue' })
        if (!valid) return { error: errors.join(', ') }
        return { ok: true }
      } catch (e) {
        return { error: e.message }
      }
    },

    async ensureDir(context) {
      await ensureIssuesDir(context.projectId)
    },

    afterWrite: reloadBoard,
  },

  '@knowledge/': {
    bypassProposals: true,

    async resolve(relativePath, context) {
      const dir = await knowledgeDir(context.projectId)
      const direct = `${dir}/${relativePath}`
      try {
        const { invoke } = await import('@tauri-apps/api/core')
        await invoke('read_text_file', { path: direct })
        return direct
      } catch {
        return await resolveByTitle(dir, relativePath) || direct
      }
    },

    validate(content) {
      try {
        const { meta } = parseBoardEntry(content)
        if (meta.type && meta.type !== 'knowledge') return { error: 'Entries at @knowledge/ must have type: knowledge' }
        return { ok: true }
      } catch (e) {
        return { error: e.message }
      }
    },

    async ensureDir(context) {
      await ensureKnowledgeDir(context.projectId)
    },

    afterWrite: reloadBoard,
  },

  '@apps/': {
    bypassProposals: true,

    async resolve(relativePath) {
      return `${await getDataDir()}/apps/${relativePath}`
    },

    validate(content, filename) {
      if (filename === 'manifest.json') {
        try {
          const parsed = JSON.parse(content)
          if (!parsed.name) return { error: 'manifest.json must have a "name" field' }
        } catch (e) {
          return { error: `Invalid JSON: ${e.message}` }
        }
      }
      return { ok: true }
    },

    afterWrite() {
      window.dispatchEvent(new CustomEvent('mim:apps-changed'))
    },
  },

  '@skills/': {
    bypassProposals: true,

    async resolve(relativePath) {
      return `${await getDataDir()}/skills/${relativePath}`
    },

    async afterWrite() {
      const { useSkillsStore } = await import('../../../stores/panel/skills.js')
      const store = useSkillsStore()
      if (store.refreshSkills) store.refreshSkills()
      else if (store.discover) store.discover()
    },
  },

  '@editor/': {
    virtual: true,
    async resolve(relativePath) {
      return { virtual: true, subpath: relativePath || '' }
    },
  },

  '@library.json': {
    bypassProposals: true,

    async resolve() {
      const { invoke } = await import('@tauri-apps/api/core')
      const dir = await invoke('ref_dir')
      return `${dir}/library.json`
    },
  },
}

const prefixes = Object.keys(handlers).sort((a, b) => b.length - a.length)

export function isAtPath(path) {
  if (!path || typeof path !== 'string') return false
  if (path === '@editor' || path === '@library.json') return true
  return prefixes.some(p => path.startsWith(p))
}

export async function resolveAtPath(path, context = {}) {
  if (!path || typeof path !== 'string') return null

  if (path === '@editor') {
    const handler = handlers['@editor/']
    return { virtual: true, subpath: '', handler, relative: '' }
  }

  if (path === '@library.json') {
    const handler = handlers['@library.json']
    const absolutePath = await handler.resolve()
    return { absolutePath, handler, relative: '' }
  }

  const prefix = prefixes.find(p => path.startsWith(p))
  if (!prefix) return null

  const relative = path.slice(prefix.length)

  if (relative.includes('..')) {
    return { error: 'Invalid path: traversal not allowed' }
  }

  if ((prefix === '@issues/' || prefix === '@knowledge/') && !context.projectId) {
    return { error: 'No project selected' }
  }

  const handler = handlers[prefix]

  if (handler.virtual) {
    const resolved = await handler.resolve(relative, context)
    return { ...resolved, handler, relative }
  }

  const absolutePath = await handler.resolve(relative, context)
  return { absolutePath, handler, relative }
}
