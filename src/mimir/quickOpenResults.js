const DEFAULT_GROUP_LIMIT = 5
const FILE_SCOPE_LIMIT = 100

const TYPED_SCOPES = {
  'p:': 'projects',
  'f:': 'files',
  'h:': 'history',
  'n:': 'new-activity',
  't:': 'tools',
  'c:': 'chats',
}

const LEGACY_SCOPES = {
  '/': 'files',
  '@': 'history',
  '+': 'new-activity',
}

export function parseQuickOpenQuery(value) {
  const query = String(value || '')
  const trimmedStart = query.trimStart()
  const typedPrefix = trimmedStart.slice(0, 2).toLocaleLowerCase()
  const typedScope = TYPED_SCOPES[typedPrefix]
  const legacyScope = LEGACY_SCOPES[trimmedStart[0]]
  const scope = typedScope || legacyScope || 'all'
  const prefixLength = typedScope ? 2 : legacyScope ? 1 : 0
  return {
    scope,
    term: (scope === 'all' ? query : trimmedStart.slice(prefixLength)).trim(),
  }
}

export function buildQuickOpenResults({
  query = '',
  tools = [],
  chats = [],
  projects = [],
  currentProjectPath = '',
  newActivity = [],
  history = [],
  files = [],
  historySnippets = new Map(),
  newActivityView = false,
}) {
  if (newActivityView) {
    const normalized = String(query || '').trim().toLocaleLowerCase()
    return withOptionIds(matchingRows(newActivity.map(newActivityResult), normalized))
  }

  const { scope, term } = parseQuickOpenQuery(query)
  const normalized = term.toLocaleLowerCase()
  const searching = Boolean(normalized)
  const results = []

  if (scope === 'all') {
    if (!searching) results.push(newActivityEnterResult(newActivity))
    else results.push(...mixedMatches(newActivity.map(newActivityResult), normalized))
  } else if (scope === 'new-activity') {
    results.push(...matchingRows(newActivity.map(newActivityResult), normalized))
  }

  if (scope === 'all' || scope === 'tools') {
    const matches = matchingRows(tools.map(toolResult), normalized)
    results.push(...(scope === 'all' ? matches.slice(0, DEFAULT_GROUP_LIMIT) : matches))
  }

  if (scope === 'all' || scope === 'projects') {
    const rows = projects
      .filter(project => (
        project?.path
        && !samePath(project.path, currentProjectPath)
        && project.current !== true
      ))
      .map(projectResult)
    const matches = matchingRows(rows, normalized)
    results.push(...(scope === 'all' ? matches.slice(0, DEFAULT_GROUP_LIMIT) : matches))
    if (scope === 'projects' && !searching) {
      results.push(openProjectResult(), createProjectResult())
    }
  }

  if (scope === 'all' || scope === 'files') {
    const limit = scope === 'files' ? FILE_SCOPE_LIMIT : DEFAULT_GROUP_LIMIT
    results.push(...matchingRows(files.map(fileResult), normalized).slice(0, limit))
  }

  if ((scope === 'all' && searching) || scope === 'chats') {
    const matches = matchingRows(chats.map(chatResult), normalized)
    results.push(...(scope === 'all' ? matches.slice(0, DEFAULT_GROUP_LIMIT) : matches))
  }

  if (scope === 'all' || scope === 'history') {
    const lastLocal = history.find(isLocalHistory)
    if (!searching && scope === 'all' && lastLocal) {
      results.push(reopenLastResult(lastLocal))
    } else if (searching || scope === 'history') {
      const matches = historyResults(history, normalized, historySnippets)
      results.push(...(scope === 'all' ? matches.slice(0, DEFAULT_GROUP_LIMIT) : matches))
    }
  }

  return withOptionIds(results)
}

function withOptionIds(results) {
  return results.map((result, index) => ({
    ...result,
    optionId: `quick-open-option-${index}`,
  }))
}

function matchingRows(rows, term) {
  if (!term) return rows
  return rows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => row.searchText.includes(term))
    .sort((left, right) => (
      matchRank(left.row, term) - matchRank(right.row, term)
      || left.index - right.index
    ))
    .map(({ row }) => row)
}

function mixedMatches(rows, term) {
  return matchingRows(rows, term).slice(0, DEFAULT_GROUP_LIMIT)
}

function matchRank(row, term) {
  const title = String(row.title || '').toLocaleLowerCase()
  if (title === term) return 0
  if (title.startsWith(term)) return 1
  if (title.split(/\s+/).some(part => part.startsWith(term))) return 2
  return 3
}

function toolResult(tool) {
  return result({
    key: `tool:${tool.id}`,
    type: 'tool',
    group: 'Tools',
    title: tool.title,
    meta: 'Open tool',
    verb: 'Open',
    icon: tool.icon,
    targetId: tool.id,
    search: [tool.title],
  })
}

function chatResult(chat) {
  const direct = chat.kind === 'direct'
  return result({
    key: `chat:${chat.id}`,
    type: 'chat',
    group: 'Chats',
    title: direct ? (chat.title || chat.id) : chat.id,
    meta: direct ? 'Direct message' : (chat.topic || 'Channel'),
    verb: 'Open',
    icon: direct ? 'chat-direct' : 'chat-channel',
    target: chat.id,
    search: [chat.id, chat.title, chat.topic],
  })
}

function projectResult(project) {
  return result({
    key: `project:${project.path}`,
    type: 'project',
    group: 'Projects',
    title: project.name || basename(project.path),
    meta: parentPath(project.path),
    verb: 'Switch',
    icon: 'project',
    path: project.path,
    search: [project.name, project.path],
  })
}

function openProjectResult() {
  return result({
    key: 'project:open',
    type: 'project-open',
    group: 'Project actions',
    title: 'Open project…',
    meta: 'Choose an existing folder',
    verb: 'Open',
    icon: 'project-open',
    search: ['open project folder'],
  })
}

function createProjectResult() {
  return result({
    key: 'project:create',
    type: 'project-create',
    group: 'Project actions',
    title: 'Create project…',
    meta: 'Create an empty folder',
    verb: 'Create',
    icon: 'project-create',
    search: ['create new project folder'],
  })
}

function newActivityResult(launcher) {
  return result({
    key: `new:${launcher.id}`,
    type: 'new-activity',
    group: 'New activity',
    title: launcher.title,
    meta: 'Start new',
    verb: 'Start',
    icon: launcher.icon,
    targetId: launcher.id,
    search: [launcher.title],
  })
}

function newActivityEnterResult(launchers) {
  return result({
    key: 'new:enter',
    type: 'new-activity-enter',
    group: 'New activity',
    title: 'Start new activity',
    meta: `${launchers.length} ${launchers.length === 1 ? 'source' : 'sources'}`,
    verb: 'Enter',
    icon: 'new-activity',
    search: [],
  })
}

function reopenLastResult(activity) {
  const provider = activityProvider(activity)
  return result({
    key: `history-reopen:${activity.id}`,
    type: 'history',
    group: 'History',
    title: 'Reopen last closed activity',
    meta: joinMeta(historyDisplayTitle(activity), provider),
    verb: historyVerb(activity),
    icon: providerIcon(provider, activity.kind),
    activityId: activity.id,
    search: [],
  })
}

// Browsing (no term) stays in the current project; a term searches every
// project, current-project matches first.
function historyResults(history, term, snippets) {
  const rows = matchingRows(history.map(activity => historyRow(activity, snippets)), term)
  const local = rows.filter(row => row.inWorkspace)
  if (!term) return local
  return [...local, ...rows.filter(row => !row.inWorkspace)]
}

function historyRow(activity, snippets) {
  const provider = activityProvider(activity)
  const local = isLocalHistory(activity)
  const workspace = basename(activity.workspacePath)
  const workspacePath = String(activity.workspacePath || '')
  const snippet = snippets.get(activity.id) || ''
  // Other-project rows carry the project as a visible chip, not meta text.
  const project = local ? '' : workspace
  return result({
    key: `history:${activity.id}`,
    type: 'history',
    group: 'History',
    title: historyDisplayTitle(activity, { includeWorkspace: !project }),
    project,
    meta: joinMeta(
      provider,
      formatActivityTime(activity.archivedAt || activity.updatedAt),
      humanStatus(activity.status),
    ),
    detail: workspacePath,
    snippet,
    verb: historyVerb(activity),
    icon: providerIcon(provider, activity.kind),
    activityId: activity.id,
    inWorkspace: local,
    search: [
      activity.title,
      provider,
      workspace,
      workspacePath,
      activity.id,
      activity.status,
      activity.createdAt,
      activity.archivedAt,
      snippet,
    ],
  })
}

function isLocalHistory(activity) {
  return activity?.inCurrentWorkspace !== false
}

function historyVerb(activity) {
  const available = activity?.resumeAvailable
    ?? Boolean(activity?.session?.cliSessionId)
  return available ? 'Resume' : 'Restore transcript'
}

function fileResult(file) {
  return result({
    key: `file:${file.path}`,
    type: 'file',
    group: 'Files',
    title: file.name,
    meta: file.relativePath || file.path,
    verb: 'Open in Editor',
    icon: 'file',
    path: file.path,
    search: [file.name, file.relativePath, file.path],
  })
}

function result({ search = [], ...value }) {
  return {
    ...value,
    searchText: search.filter(Boolean).join(' ').toLocaleLowerCase(),
  }
}

export function historyDisplayTitle(activity, { includeWorkspace = true } = {}) {
  if (!isGenericProviderTitle(activity)) return activity.title
  const time = formatActivityTime(activity.createdAt || activity.updatedAt)
  if (!includeWorkspace) return time || 'Previous activity'
  const workspace = basename(activity.workspacePath) || 'Previous activity'
  return `${workspace} · ${time}`
}

function isGenericProviderTitle(activity) {
  const title = String(activity?.title || '').trim().toLocaleLowerCase()
  const provider = activityProvider(activity).toLocaleLowerCase()
  return !title || title === provider || [
    'codex',
    'claude',
    'claude code',
    'pi',
    'gemini',
    'terminal',
  ].includes(title)
}

export function activityProvider(activity) {
  const source = String(
    activity?.source?.presetId
    || activity?.source?.launcherId
    || activity?.source?.agentId
    || '',
  ).toLocaleLowerCase()
  if (source.includes('codex')) return 'Codex'
  if (source.includes('claude')) return 'Claude'
  if (source === 'pi' || source.includes('pi-')) return 'Pi'
  if (source.includes('gemini')) return 'Gemini'
  if (activity?.kind === 'terminal') return 'Terminal'
  if (activity?.kind === 'routine') return 'Routine'
  if (activity?.kind === 'app') return 'App'
  return 'Agent'
}

function providerIcon(provider, kind) {
  return {
    Codex: 'codex',
    Claude: 'claude',
    Pi: 'pi',
    Gemini: 'gemini',
    Terminal: 'terminal',
    Routine: 'routines',
    App: 'apps',
  }[provider] || (kind === 'terminal' ? 'terminal' : 'agent')
}

function humanStatus(status) {
  return String(status || '').replaceAll('-', ' ')
}

function formatActivityTime(value) {
  const date = new Date(value || '')
  if (Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

function basename(path) {
  return String(path || '').replaceAll('\\', '/').split('/').filter(Boolean).at(-1) || ''
}

function parentPath(path) {
  const normalized = String(path || '').replaceAll('\\', '/').replace(/\/+$/, '')
  const name = basename(normalized)
  return normalized.slice(0, Math.max(0, normalized.length - name.length)).replace(/\/$/, '') || '/'
}

function samePath(left, right) {
  const normalize = value => String(value || '').replaceAll('\\', '/').replace(/\/+$/, '')
  return Boolean(left && right) && normalize(left) === normalize(right)
}

function joinMeta(...parts) {
  return parts.filter(Boolean).join(' · ')
}
