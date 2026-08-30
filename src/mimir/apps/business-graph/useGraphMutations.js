import { computed, nextTick, ref, watch } from 'vue'
import { graphErrorMessage } from './graphErrors.js'

export function useGraphMutations({ graph, boardIssues, diagnostic, echoToolCall, restoreGraphFocus }) {
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
      await graph.create({
        ...create,
        relations,
        ...(projectId ? {
          properties: { ...create.properties, legacyProject: projectId },
        } : {}),
      })
      if (controls.another) controls.reset()
      else createOpen.value = false
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
      const updated = await graph.update(patch)
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
      await graph.undoDelete()
      echoToolCall('graph.restore', { undoToken: '‹token›' })
    } catch (cause) {
      undoError.value = graphErrorMessage(cause)
      diagnostic(`Could not restore graph item: ${undoError.value}`)
    }
  }

  async function moveIssue({ issue, status, projectId = null }) {
    try {
      const patch = issueMovePatch(issue, status, projectId)
      await graph.update(patch)
      if (status !== undefined) echoToolCall('issues.move', { id: issue.id, status })
      else echoToolCall('issues.update', { id: issue.id, project: projectId || '' })
    } catch (cause) {
      diagnostic(graphErrorMessage(cause))
    }
  }

  async function patchIssue({ issue, setProperties = {}, removeProperties = [] }) {
    try {
      await graph.update({
        id: issue.id,
        expectedRevision: issue.sourceRevision,
        setProperties,
        removeProperties,
      })
      const { rank, ...visible } = setProperties
      if (Object.keys(visible).length) echoToolCall('issues.update', { id: issue.id, ...visible })
      else if (removeProperties.length) echoToolCall('graph.update', { id: issue.id, removeProperties })
    } catch (cause) {
      diagnostic(graphErrorMessage(cause))
    }
  }

  async function bulkPatchIssues({ issues, setProperties = {}, removeProperties = [] }) {
    const failures = []
    for (const issue of issues) {
      try {
        await graph.update({
          id: issue.id,
          expectedRevision: issue.sourceRevision,
          setProperties,
          removeProperties,
        })
      } catch (cause) {
        failures.push(`${issue.title || issue.id}: ${graphErrorMessage(cause)}`)
      }
    }
    reportBulkFailures('Bulk update', failures, diagnostic)
  }

  async function bulkMoveIssues({ issues, columnId, groupBy }) {
    for (const issue of issues) {
      await moveIssue(groupBy === 'project'
        ? { issue, projectId: columnId === '__unassigned__' ? '' : columnId }
        : { issue, status: columnId })
    }
  }

  async function reorderIssue({ issue, columnId, beforeId, groupBy }) {
    const target = boardIssues.value.filter(candidate => (
      candidate.id !== issue.id
      && (groupBy === 'project'
        ? (candidate.projectId || '__unassigned__') === columnId
        : (candidate.status || 'backlog') === columnId)
    ))
    const beforeIndex = beforeId ? target.findIndex(candidate => candidate.id === beforeId) : -1
    target.splice(beforeIndex >= 0 ? beforeIndex : target.length, 0, issue)

    const failures = []
    for (const [index, candidate] of target.entries()) {
      const patch = reorderPatch(candidate, issue.id, columnId, groupBy, index)
      try {
        await graph.update(patch)
        if (candidate.id === issue.id) {
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
  }
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

function reorderPatch(candidate, movedId, columnId, groupBy, index) {
  const patch = {
    id: candidate.id,
    expectedRevision: candidate.sourceRevision,
    setProperties: { rank: (index + 1) * 1000 },
  }
  if (candidate.id !== movedId) return patch
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
    projects: 'project',
    knowledge: 'note',
    all: 'note',
  }[section]
}
