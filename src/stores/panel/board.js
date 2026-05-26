import { ref, computed } from 'vue'
import { defineStore } from 'pinia'
import { COLUMN_STATUSES, STATUS_LABELS } from '../../services/board/loader.js'
import { useProjectStore } from './projects.js'
import { schedulePersist } from './persistence.js'
import { usePanelUIStore } from './ui.js'

function priorityWeight(p) {
  return { urgent: 4, high: 3, normal: 2, low: 1 }[p] || 0
}

export const useBoardStore = defineStore('panelBoard', () => {
  const entries = ref([])
  const loading = ref(false)
  const activeProjectId = ref('')
  const workspaceFolder = ref('')
  const viewMode = ref('chat')
  const noteSearch = ref('')
  const issueSearch = ref('')
  const noteTagFilter = ref('')
  const selectedEntryId = ref('')
  const hiddenStatuses = ref(new Set())


  const issues = computed(() => entries.value.filter(e => e.meta.type === 'issue'))
  const knowledge = computed(() => entries.value.filter(e => e.meta.type === 'knowledge'))

  const columns = computed(() =>
    COLUMN_STATUSES.map(status => ({
      status,
      label: STATUS_LABELS[status],
      entries: issues.value
        .filter(e => e.meta.status === status)
        .filter(e => {
          if (!issueSearch.value) return true
          const q = issueSearch.value.toLowerCase()
          return e.meta.title?.toLowerCase().includes(q) || e.body?.toLowerCase().includes(q)
        })
        .sort((a, b) => priorityWeight(b.meta.priority) - priorityWeight(a.meta.priority)),
    })),
  )

  const filteredKnowledge = computed(() => {
    let result = knowledge.value
    if (noteTagFilter.value) {
      result = result.filter(n => (n.meta.tags || []).includes(noteTagFilter.value))
    }
    if (noteSearch.value) {
      const q = noteSearch.value.toLowerCase()
      result = result.filter(n =>
        n.meta.title?.toLowerCase().includes(q) ||
        n.body?.toLowerCase().includes(q),
      )
    }
    return result.sort((a, b) => new Date(b.meta.updated) - new Date(a.meta.updated))
  })

  const allTags = computed(() => {
    const set = new Set()
    entries.value.forEach(e => (e.meta.tags || []).forEach(t => set.add(t)))
    return [...set].sort()
  })

  const selectedEntry = computed(() =>
    selectedEntryId.value ? entries.value.find(e => e.id === selectedEntryId.value) || null : null,
  )

  const boardSummary = computed(() => {
    const byStatus = {}
    for (const col of columns.value) byStatus[col.status] = col.entries.length
    return {
      issueCount: issues.value.length,
      knowledgeCount: knowledge.value.length,
      byStatus,
    }
  })

  async function loadBoard(projectId) {
    if (loading.value) return
    loading.value = true
    activeProjectId.value = projectId
    workspaceFolder.value = ''
    const proj = useProjectStore().projects.find(p => p.id === projectId)
    hiddenStatuses.value = new Set(proj?.hiddenColumns || [])
    try {
      const { discoverEntries } = await import('../../services/board/loader.js')
      entries.value = await discoverEntries(projectId)
    } catch (err) {
      console.warn('[board] loadBoard failed:', err)
      entries.value = []
    } finally {
      loading.value = false
    }
  }

  async function loadBoardFromFolder(folderPath) {
    if (loading.value) return
    if (!folderPath) { entries.value = []; return }
    loading.value = true
    workspaceFolder.value = folderPath
    activeProjectId.value = ''
    try {
      const { discoverEntriesFromFolder } = await import('../../services/board/loader.js')
      entries.value = await discoverEntriesFromFolder(`${folderPath}/.mim`)
    } catch (err) {
      console.warn('[board] loadBoardFromFolder failed:', err)
      entries.value = []
    } finally {
      loading.value = false
    }
  }

  function isFolderMode() {
    return Boolean(workspaceFolder.value)
  }

  async function reloadBoard() {
    if (isFolderMode()) await loadBoardFromFolder(workspaceFolder.value)
    else if (activeProjectId.value) await loadBoard(activeProjectId.value)
  }

  async function createEntry(type, meta, body = '') {
    if (!activeProjectId.value && !isFolderMode()) return null
    if (isFolderMode()) {
      const { writeEntryToFolder } = await import('../../services/board/loader.js')
      const id = await writeEntryToFolder(`${workspaceFolder.value}/.mim`, null, { ...meta, type }, body)
      await reloadBoard()
      return id
    }
    const { writeEntry: write } = await import('../../services/board/loader.js')
    const id = await write(activeProjectId.value, null, { ...meta, type }, body)
    await reloadBoard()
    return id
  }

  async function updateEntry(entryId, meta, body) {
    if (!activeProjectId.value && !isFolderMode()) return
    if (isFolderMode()) {
      const { writeEntryToFolder } = await import('../../services/board/loader.js')
      await writeEntryToFolder(`${workspaceFolder.value}/.mim`, entryId, meta, body)
      await reloadBoard()
      return
    }
    const { writeEntry: write } = await import('../../services/board/loader.js')
    await write(activeProjectId.value, entryId, meta, body)
    await reloadBoard()
  }

  async function removeEntry(entryId) {
    if (!activeProjectId.value && !isFolderMode()) return
    const entry = entries.value.find(e => e.id === entryId)
    if (!entry) return
    if (isFolderMode()) {
      const { deleteEntryFromFolder } = await import('../../services/board/loader.js')
      await deleteEntryFromFolder(`${workspaceFolder.value}/.mim`, entryId, entry.meta.type)
    } else {
      const { deleteEntry: del } = await import('../../services/board/loader.js')
      await del(activeProjectId.value, entryId, entry.meta.type)
    }
    entries.value = entries.value.filter(e => e.id !== entryId)
    if (selectedEntryId.value === entryId) selectedEntryId.value = ''
  }

  async function moveIssue(entryId, newStatus) {
    const entry = entries.value.find(e => e.id === entryId)
    if (!entry || entry.meta.type !== 'issue') return
    const oldStatus = entry.meta.status
    entry.meta.status = newStatus
    entry.meta.updated = new Date().toISOString()

    try {
      if (isFolderMode()) {
        const { moveEntryInFolder } = await import('../../services/board/loader.js')
        await moveEntryInFolder(`${workspaceFolder.value}/.mim`, entryId, newStatus)
      } else {
        const { moveEntry: move } = await import('../../services/board/loader.js')
        await move(activeProjectId.value, entryId, newStatus)
      }
    } catch (err) {
      entry.meta.status = oldStatus
      console.warn('[board] moveIssue failed:', err)
    }
  }

  function selectEntry(entryId) {
    selectedEntryId.value = entryId
    if (entryId) {
      usePanelUIStore().pushProjectNav(viewMode.value, entryId)
    }
  }

  function clearSelection() {
    selectedEntryId.value = ''
  }

  function toggleColumnHidden(status) {
    const next = new Set(hiddenStatuses.value)
    if (next.has(status)) next.delete(status)
    else next.add(status)
    hiddenStatuses.value = next
    const proj = useProjectStore().projects.find(p => p.id === activeProjectId.value)
    if (proj) {
      proj.hiddenColumns = [...next]
      schedulePersist()
    }
  }


  function buildBoardContext() {
    if (entries.value.length === 0) return ''

    const summary = boardSummary.value
    const lines = ['<board-context>']

    lines.push(`Project board: ${summary.issueCount} issues, ${summary.knowledgeCount} knowledge entries.`)

    if (summary.issueCount > 0) {
      const statusLine = COLUMN_STATUSES
        .map(s => `${summary.byStatus[s] || 0} ${STATUS_LABELS[s].toLowerCase()}`)
        .join(', ')
      lines.push(`Issue breakdown: ${statusLine}.`)

      const overdue = issues.value.filter(i => {
        if (!i.meta.dueDate || i.meta.status === 'done') return false
        return new Date(i.meta.dueDate + 'T00:00:00') < new Date(new Date().toDateString())
      })
      if (overdue.length) {
        lines.push(`OVERDUE (${overdue.length}):`)
        for (const i of overdue) {
          lines.push(`- "${i.meta.title}" — due ${i.meta.dueDate}, ${i.meta.status}`)
        }
      }

      const activeIssues = issues.value
        .filter(i => i.meta.status !== 'done')
        .slice(0, 10)
      if (activeIssues.length) {
        lines.push('Active issues:')
        for (const i of activeIssues) {
          const due = i.meta.dueDate ? `, due ${i.meta.dueDate}` : ''
          lines.push(`- @issues/${i.id}.md "${i.meta.title}" — ${i.meta.status}, ${i.meta.priority} priority${due}`)
        }
      }
    }

    if (summary.knowledgeCount > 0) {
      const recentKnowledge = knowledge.value.slice(0, 5)
      lines.push('Knowledge base entries:')
      for (const n of recentKnowledge) {
        lines.push(`- @knowledge/${n.id}.md "${n.meta.title || '(untitled)'}"`)
      }
    }

    const tags = allTags.value
    if (tags.length) {
      lines.push(`Tags: ${tags.join(', ')}`)
    }

    lines.push('Issues live at @issues/, knowledge at @knowledge/. Use read, edit, create, list, show to manage them.')
    lines.push('</board-context>')

    return lines.join('\n')
  }

  return {
    entries,
    loading,
    activeProjectId,
    viewMode,
    noteSearch,
    issueSearch,
    noteTagFilter,
    selectedEntryId,
    hiddenStatuses,

    issues,
    knowledge,
    columns,
    filteredKnowledge,
    allTags,
    selectedEntry,
    boardSummary,
    loadBoard,
    loadBoardFromFolder,
    workspaceFolder,
    createEntry,
    updateEntry,
    removeEntry,
    moveIssue,
    selectEntry,
    clearSelection,
    toggleColumnHidden,

    buildBoardContext,
  }
})
