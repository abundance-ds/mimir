/**
 * Builds a compact <workspace-meta> XML block for system prompt injection.
 * Ported from v0.2.x workspaceMeta.js with adaptations for v0.3 architecture.
 *
 * Accepts a context object with whatever data is available — no store dependencies.
 * Cap output to 3000 chars.
 */

const MAX_WORKSPACE_META_CHARS = 3000

export function buildWorkspaceMeta(context = {}) {
  const {
    openTabs,       // string[] of file paths
    activeFile,     // string path of the active file
    fileTree,       // { name, is_dir, children? }[] from list_dir
    workspacePath,  // string root path for making relative paths
    references,     // CSL-JSON array
    gitBranch,      // string branch name
    gitStatus,      // { path, status }[] from git_status
  } = context

  if (!workspacePath) return ''

  const parts = []

  // Open tabs (relative paths)
  if (openTabs?.length > 0) {
    const relative = openTabs.map(f => toRelative(f, workspacePath))
    parts.push(`Open tabs: ${relative.join(', ')}`)
  }

  // Active file
  if (activeFile) {
    parts.push(`Active file: ${toRelative(activeFile, workspacePath)}`)
  }

  // File tree (2 levels deep, max 40 entries)
  if (fileTree?.length > 0) {
    const lines = []
    walkTree(fileTree, 0, '', lines)
    if (lines.length > 0) {
      let tree = 'Workspace files:\n' + lines.join('\n')
      if (lines.length > 40) tree += '\n  ... (truncated)'
      parts.push(tree)
    }
  }

  // Reference library summary (15 most recent)
  if (references?.length > 0) {
    const count = references.length
    const recent = references.slice(0, 15)
    const lines = recent.map(r => {
      const author = r.author?.[0]?.family || 'Unknown'
      const year = r.issued?.['date-parts']?.[0]?.[0] || ''
      return `@${r._key || r.id} — ${author}${year ? ' ' + year : ''}: ${(r.title || '').slice(0, 60)}`
    })
    let section = `Reference library (${count} total):\n` + lines.join('\n')
    if (count > 15) section += `\n  ... and ${count - 15} more (search above or use edit("@library.json", ...) to add new ones)`
    parts.push(section)
  }

  // Git info
  if (gitBranch) {
    parts.push(`Branch: ${gitBranch}`)
  }

  if (gitStatus?.length > 0) {
    // Filter out .shoulders/ config noise
    const filtered = gitStatus.filter(e => !e.path.startsWith('.shoulders/'))
    if (filtered.length > 0) {
      const lines = filtered.slice(0, 20).map(e => `  ${e.status} ${e.path}`)
      let section = 'Git status:\n' + lines.join('\n')
      if (filtered.length > 20) section += `\n  ... and ${filtered.length - 20} more`
      parts.push(section)
    }
  }

  if (parts.length === 0) return ''

  let xml = `<workspace-meta>
This is auto-generated workspace context. It may or may not be relevant to the user's query.

${parts.join('\n\n')}
</workspace-meta>`

  // Hard cap
  if (xml.length > MAX_WORKSPACE_META_CHARS) {
    xml = xml.slice(0, MAX_WORKSPACE_META_CHARS - 20) + '\n</workspace-meta>'
  }

  return xml
}

/**
 * Async helper that gathers available workspace context via Tauri invokes.
 * Falls back gracefully if any source is unavailable.
 */
export async function gatherWorkspaceContext(workspacePath) {
  if (!workspacePath) return {}

  const context = { workspacePath }
  const isTauri = typeof window !== 'undefined' && !!window.__TAURI_INTERNALS__
  if (!isTauri) return context

  try {
    const { invoke } = await import('@tauri-apps/api/core')

    // File tree (top 2 levels)
    try {
      const entries = await invoke('list_dir', { path: workspacePath })
      context.fileTree = entries
    } catch {}

    // Git branch
    try {
      const statuses = await invoke('git_status', { path: workspacePath })
      context.gitStatus = statuses
    } catch {}
  } catch {}

  return context
}


// --- Helpers ---

function toRelative(filePath, workspacePath) {
  if (!filePath || !workspacePath) return filePath || ''
  return filePath.startsWith(workspacePath)
    ? filePath.slice(workspacePath.length + 1) || filePath
    : filePath
}

function walkTree(entries, depth, prefix, lines) {
  if (depth > 2 || lines.length > 40) return
  for (const entry of entries) {
    if (lines.length > 40) break
    // Skip hidden/common noise
    if (entry.name.startsWith('.') && entry.name !== '.gitignore') continue
    if (['node_modules', '__pycache__', 'dist', 'build', '.git'].includes(entry.name)) continue
    const name = entry.name + (entry.is_dir ? '/' : '')
    lines.push(prefix + name)
    if (entry.is_dir && entry.children && depth < 2) {
      walkTree(entry.children, depth + 1, prefix + '  ', lines)
    }
  }
}
