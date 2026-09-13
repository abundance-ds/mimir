import { computed, nextTick, ref, watch } from 'vue'
import { graphErrorMessage } from './graphErrors.js'
import { isClosedIssue, workProjectId } from './workRow.js'

export function useGraphMutations({ graph, boardIssues, diagnostic, echoToolCall, restoreGraphFocus, openNode = () => {} }) {
  const createOpen = ref(false)
  const createError = ref('')
  const createKind = ref('issue')
  const createStatus = ref('backlog')
  const createProject = ref('')
  const createRelations = ref([])
  const creating = ref(false)
  const saving = ref(false)
  const saveError = ref('')
  const deleteOpen = ref(false)
  const deleteRequest = ref(null)
  const deleting = ref(false)
  const deleteError = ref('')
  const undoError = ref('')
  const closedIssueUndo = ref(null)
  const closedIssueUndoError = ref('')
  const undoingClosedIssues = ref(false)

  function offerClosedUndo(entries) {
    if (!entries.length) return
    closedIssueUndo.value = { entries }
    closedIssueUndoError.value = ''
  }

  function dismissClosedIssueUndo() {
    if (undoingClosedIssues.value) return
    closedIssueUndo.value = null
    closedIssueUndoError.value = ''
  }

  async function undoClosedIssues() {
    if (!closedIssueUndo.value || undoingClosedIssues.value) return
    const request = closedIssueUndo.value
    undoingClosedIssues.value = true
    closedIssueUndoError.value = ''
    const failed = []
    const failures = []
    try {
      for (const entry of request.entries) {
        try {
          // Use the revision returned by closing, never the latest revision:
          // Undo must not overwrite an edit made since the issue was closed.
          await graph.update(entry.patch)
          echoToolCall('issues.move', { id: entry.patch.id, status: entry.status || 'backlog' })
        } catch (cause) {
          failed.push(entry)
          failures.push(`${entry.title}: ${graphErrorMessage(cause)}`)
        }
      }
      if (closedIssueUndo.value === request) {
        closedIssueUndo.value = failed.length ? { entries: failed } : null
        closedIssueUndoError.value = failures.join('; ')
      }
      if (failures.length) diagnostic(`Could not undo: ${failures.join('; ')}`)
    } finally {
      undoingClosedIssues.value = false
    }
  }

  const deleteTitle = computed(() => (
    `Move “${deleteRequest.value?.title || deleteRequest.value?.id || 'this object'}” to Trash?`
  ))
  const deleteCopy = computed(() => (
    'The Markdown source leaves the active graph and moves to Trash. Its relationships disappear from projections until restored.'
  ))

  watch(() => graph.selectedNode, () => {
    saveError.value = ''
  })

  function openCreate(
    kind = defaultKind(graph.section),
    status = 'backlog',
    projectId = null,
    relations = [],
  ) {
    createError.value = ''
    createKind.value = kind
    createStatus.value = status
    createProject.value = projectId === null && kind === 'issue'
      ? graph.workspaceProjectId
      : String(projectId || '')
    createRelations.value = relations
    createOpen.value = true
  }

  async function createNode(create, controls) {
    creating.value = true
    createError.value = ''
    try {
      const projectId = create.kind === 'issue' ? createProject.value : ''
      const relations = uniqueRelations([
        ...createRelations.value,
        ...(projectId ? [{ relation: 'part_of', target: projectId, legacy: false }] : []),
      ])
      const created = await graph.create({
        ...create,
        relations,
        ...(projectId ? {
          properties: { ...create.properties, legacyProject: projectId },
        } : {}),
      })
      if (controls.another) controls.reset()
      else {
        createOpen.value = false
        if (created?.id) openNode(created.id)
      }
      echoToolCall(
        create.kind === 'issue' ? 'issues.create' : 'graph.create',
        create.kind === 'issue'
          ? { title: create.title }
          : { kind: create.kind, title: create.title },
      )
    } catch (cause) {
      createError.value = graphErrorMessage(cause)
      diagnostic(createError.value)
    } finally {
      creating.value = false
    }
  }

  function openRelatedCreate({ kind, parent }) {
    if (kind === 'decision' && parent.kind === 'project') {
      openCreate('decision', 'backlog', '', [
        { relation: 'part_of', target: parent.id, legacy: false },
      ])
      return
    }
    if (kind !== 'issue') return
    const projectId = parent.relations?.find(edge => edge.relation === 'part_of')?.target
      || parent.properties?.legacyProject
      || ''
    openCreate('issue', 'plan', projectId, [
      { relation: 'related_to', target: parent.id, legacy: false },
    ])
  }

  async function saveNode(patch, controls, options = {}) {
    saving.value = true
    saveError.value = ''
    try {
      validateIssueEntityRelations(graph, patch)
      const before = graph.nodes.find(node => node.id === patch.id)
      const updated = await graph.update(patch)
      offerClosedUndo(closedUndoEntries(before, updated, patch))
      const currentScopeId = updated.provenance?.scopeId || updated.scopeId || ''
      const targetScopeId = String(options.targetScopeId || '').trim()
      if (targetScopeId && targetScopeId !== currentScopeId) {
        await graph.moveScope(
          updated.id,
          targetScopeId,
          updated.provenance?.sourceRevision || updated.sourceRevision,
        )
      }
      controls.done()
    } catch (cause) {
      saveError.value = graphErrorMessage(cause)
      diagnostic(saveError.value)
      controls.failed?.()
    } finally {
      saving.value = false
    }
  }

  function deleteNode(request) {
    deleteRequest.value = request
    deleteError.value = ''
    deleteOpen.value = true
  }

  async function confirmDelete() {
    if (!deleteRequest.value || deleting.value) return
    const deletedId = deleteRequest.value.id
    deleting.value = true
    deleteError.value = ''
    try {
      await graph.remove(deletedId)
      echoToolCall('graph.delete', { id: deletedId })
      undoError.value = ''
      deleteOpen.value = false
      deleteRequest.value = null
      await nextTick()
      restoreGraphFocus(deletedId)
    } catch (cause) {
      deleteError.value = graphErrorMessage(cause)
      diagnostic(deleteError.value)
    } finally {
      deleting.value = false
    }
  }

  function closeDeleteDialog() {
    if (deleting.value) return
    deleteOpen.value = false
    deleteError.value = ''
    deleteRequest.value = null
  }

  async function undoDelete() {
    undoError.value = ''
    try {
      const restored = await graph.undoDelete()
      if (restored?.id) openNode(restored.id)
      echoToolCall('graph.restore', { undoToken: '‹token›' })
    } catch (cause) {
      undoError.value = graphErrorMessage(cause)
      diagnostic(`Could not restore graph item: ${undoError.value}`)
    }
  }

  async function moveIssue({ issue, status, projectId = null }) {
    try {
      const patch = issueMovePatch(issue, status, projectId)
      const updated = await graph.update(patch)
      offerClosedUndo(closedUndoEntries(issue, updated, patch))
      if (status !== undefined) echoToolCall('issues.move', { id: issue.id, status })
      else echoToolCall('issues.update', { id: issue.id, project: projectId || '' })
    } catch (cause) {
      diagnostic(graphErrorMessage(cause))
    }
  }

  async function patchIssue({ issue, setProperties = {}, removeProperties = [] }) {
    try {
      const patch = {
        id: issue.id,
        expectedRevision: issue.sourceRevision,
        setProperties,
        removeProperties,
      }
      const updated = await graph.update(patch)
      offerClosedUndo(closedUndoEntries(issue, updated, patch))
      const { rank, ...visible } = setProperties
      if (Object.keys(visible).length) echoToolCall('issues.update', { id: issue.id, ...visible })
      else if (removeProperties.length) echoToolCall('graph.update', { id: issue.id, removeProperties })
    } catch (cause) {
      diagnostic(graphErrorMessage(cause))
    }
  }

  async function bulkPatchIssues({ issues, setProperties = {}, removeProperties = [] }) {
    const failures = []
    const undoEntries = []
    for (const issue of issues) {
      try {
        const patch = {
          id: issue.id,
          expectedRevision: issue.sourceRevision,
          setProperties,
          removeProperties,
        }
        const updated = await graph.update(patch)
        undoEntries.push(...closedUndoEntries(issue, updated, patch))
        if (setProperties.status !== undefined) echoToolCall('issues.move', { id: issue.id, status: setProperties.status })
      } catch (cause) {
        failures.push(`${issue.title || issue.id}: ${graphErrorMessage(cause)}`)
      }
    }
    reportBulkFailures('Bulk update', failures, diagnostic)
    offerClosedUndo(undoEntries)
  }

  async function bulkMoveIssues({ issues, columnId, groupBy }) {
    if (groupBy !== 'project') {
      await bulkPatchIssues({ issues, setProperties: { status: columnId } })
      return
    }
    for (const issue of issues) {
      await moveIssue({ issue, projectId: columnId === '__unassigned__' ? '' : columnId })
    }
  }

  async function reorderIssue({ issue, columnId, beforeId, groupBy }) {
    const projectIds = groupBy === 'project'
      ? new Set(graph.projects.map(project => project.id))
      : null
    const columnFor = candidate => groupBy === 'project'
      ? workProjectId(candidate, projectIds)
      : (candidate.status || 'backlog')
    const changesColumn = columnFor(issue) !== columnId
    const target = boardIssues.value.filter(candidate => (
      candidate.id !== issue.id && columnFor(candidate) === columnId
    ))
    const beforeIndex = beforeId ? target.findIndex(candidate => candidate.id === beforeId) : -1
    target.splice(beforeIndex >= 0 ? beforeIndex : target.length, 0, issue)

    const failures = []
    for (const [index, candidate] of target.entries()) {
      const patch = reorderPatch(candidate, issue.id, columnId, groupBy, index, changesColumn)
      try {
        const updated = await graph.update(patch)
        if (candidate.id === issue.id && changesColumn) {
          offerClosedUndo(closedUndoEntries(issue, updated, patch))
          echoToolCall(
            groupBy === 'project' ? 'issues.update' : 'issues.move',
            groupBy === 'project'
              ? { id: issue.id, project: columnId === '__unassigned__' ? '' : columnId }
              : { id: issue.id, status: columnId },
          )
        }
      } catch (cause) {
        failures.push(`${candidate.title || candidate.id}: ${graphErrorMessage(cause)}`)
      }
    }
    reportBulkFailures('Reorder', failures, diagnostic)
  }

  function createFromBoard({ columnId, groupBy }) {
    if (groupBy === 'project') {
      openCreate('issue', 'backlog', columnId === '__unassigned__' ? '' : columnId)
    } else {
      openCreate('issue', columnId)
    }
  }

  return {
    bulkMoveIssues,
    bulkPatchIssues,
    closeDeleteDialog,
    confirmDelete,
    createError,
    createFromBoard,
    createKind,
    createNode,
    createOpen,
    createStatus,
    creating,
    deleteCopy,
    deleteError,
    deleteNode,
    deleteOpen,
    deleteTitle,
    deleting,
    moveIssue,
    openCreate,
    openRelatedCreate,
    patchIssue,
    reorderIssue,
    saveError,
    saveNode,
    saving,
    undoDelete,
    undoError,
    closedIssueUndo,
    closedIssueUndoError,
    undoingClosedIssues,
    undoClosedIssues,
    dismissClosedIssueUndo,
  }
}

function closedUndoEntries(issue, updated, patch) {
  if (issue?.kind !== 'issue' || isClosedIssue(issue)
    || !isClosedIssue({ status: patch.setProperties?.status })) return []
  const revision = updated.provenance?.sourceRevision || updated.sourceRevision
  if (!revision) return []
  const setProperties = {}
  const removeProperties = []
  for (const key of ['status', ...(patch.setProperties.rank !== undefined ? ['rank'] : [])]) {
    if (issue[key] === undefined || issue[key] === null || issue[key] === '') removeProperties.push(key)
    else setProperties[key] = issue[key]
  }
  return [{
    title: issue.title || 'Issue',
    status: issue.status,
    patch: { id: issue.id, expectedRevision: revision, setProperties, removeProperties },
  }]
}

function uniqueRelations(relations) {
  return relations.filter((edge, index, items) => (
    items.findIndex(candidate => (
      candidate.relation === edge.relation && candidate.target === edge.target
    )) === index
  ))
}

function validateIssueEntityRelations(graph, patch) {
  if (graph.selectedNode?.kind !== 'issue' || !Array.isArray(patch.relations)) return
  const stored = new Set((graph.selectedNode.relations || [])
    .map(edge => `${edge.relation}::${edge.target}`))
  for (const [relation, expectedKind, label] of [
    ['part_of', 'project', 'Project'],
    ['assigned_to', 'person', 'Assignee'],
  ]) {
    const targetId = patch.relations.find(edge => edge.relation === relation)?.target
    if (!targetId || stored.has(`${relation}::${targetId}`)) continue
    const target = graph.nodes.find(node => node.id === targetId)
    if (!target || target.kind !== expectedKind) {
      throw new Error(`${label} must resolve to a visible ${expectedKind} node, not “${targetId}”.`)
    }
  }
}

function issueMovePatch(issue, status, projectId) {
  const patch = { id: issue.id, expectedRevision: issue.sourceRevision }
  if (status !== undefined) {
    patch.setProperties = { status }
    return patch
  }
  const targetProject = projectId ?? ''
  patch.relations = [
    ...(issue.relations || []).filter(edge => edge.relation !== 'part_of'),
    ...(targetProject ? [{ relation: 'part_of', target: targetProject, legacy: false }] : []),
  ]
  patch.setProperties = targetProject ? { legacyProject: targetProject } : {}
  patch.removeProperties = targetProject ? [] : ['legacyProject']
  return patch
}

function reorderPatch(candidate, movedId, columnId, groupBy, index, changesColumn) {
  const patch = {
    id: candidate.id,
    expectedRevision: candidate.sourceRevision,
    setProperties: { rank: (index + 1) * 1000 },
  }
  // A reorder within a column changes rank only. In particular, do not erase
  // unresolved project references just because they render under No project.
  if (candidate.id !== movedId || !changesColumn) return patch
  if (groupBy !== 'project') {
    patch.setProperties.status = columnId
    return patch
  }
  const projectId = columnId === '__unassigned__' ? '' : columnId
  patch.relations = [
    ...(candidate.relations || []).filter(edge => edge.relation !== 'part_of'),
    ...(projectId ? [{ relation: 'part_of', target: projectId, legacy: false }] : []),
  ]
  if (projectId) patch.setProperties.legacyProject = projectId
  else patch.removeProperties = ['legacyProject']
  return patch
}

function reportBulkFailures(action, failures, diagnostic) {
  if (!failures.length) return
  diagnostic(`${action} completed with ${failures.length} conflict${failures.length === 1 ? '' : 's'}: ${failures.join('; ')}`)
}

function defaultKind(section) {
  return {
    work: 'issue',
    all: 'note',
  }[section]
}
