import { nextTick, ref, watch } from 'vue'
import { openExternalUrl } from '../../../services/externalLinks.js'
import { resolveProjectFile } from '../../../services/workspaceConfig.js'
import { graphErrorMessage } from './graphErrors.js'

export function useGraphNavigation({
  graph,
  root,
  workspaceSurface,
  appHeader,
  workspacePath,
  diagnostic,
  openFileResult,
}) {
  const focusMode = ref(false)
  let focusReturnElement = null
  let focusReturnNodeId = ''
  let entryFocusPending = false

  watch(() => graph.selectedNode, node => {
    if (!node) focusMode.value = false
  })

  function openNode(id) {
    rememberFocusOrigin(id)
    const open = async () => {
      focusMode.value = false
      try {
        await graph.openNode(id)
        await nextTick()
        if (!focusWithinGraph()) workspaceSurface.value?.focusInspectorEntry()
      } catch (cause) {
        diagnostic(graphErrorMessage(cause))
      }
    }
    if (!(graph.selectedNode?.id && graph.selectedNode.id !== id && commitThen(open))) open()
  }

  async function openRelatedNode(id) {
    try {
      await graph.openNode(id)
      await nextTick()
      workspaceSurface.value?.focusInspectorEntry()
    } catch (cause) {
      diagnostic(graphErrorMessage(cause))
    }
  }

  function closeObject() {
    if (workspaceSurface.value?.requestClose) workspaceSurface.value.requestClose()
    else graph.closeInspector()
  }

  async function finalizeObjectClose() {
    const selectedId = graph.selectedNode?.id || focusReturnNodeId
    focusMode.value = false
    graph.closeInspector()
    await nextTick()
    restoreGraphFocus(selectedId)
  }

  async function enterFocus() {
    if (!graph.selectedNode) return
    focusMode.value = true
    await nextTick()
    workspaceSurface.value?.focusInspectorEntry()
  }

  async function returnToPeek() {
    focusMode.value = false
    await nextTick()
    workspaceSurface.value?.focusInspectorEntry()
  }

  function restoreGraphFocus(preferredNodeId = '', { allowFirst = true } = {}) {
    if (focusReturnElement?.isConnected) {
      focusReturnElement.focus()
      clearFocusOrigin()
      return
    }
    const nodeId = preferredNodeId || focusReturnNodeId
    if (nodeId && workspaceSurface.value?.focusNode?.(nodeId)) {
      clearFocusOrigin()
      return
    }
    const candidates = [...(root.value?.querySelectorAll(
      '[data-board-card], [data-timeline-node], [data-graph-node]',
    ) || [])]
    const nodeTarget = candidates.find(candidate => (
      candidate.dataset.boardCard === nodeId
      || candidate.dataset.timelineNode === nodeId
      || candidate.dataset.graphNode === nodeId
    ))
    if (nodeTarget instanceof HTMLElement) {
      nodeTarget.focus()
      clearFocusOrigin()
      return
    }
    if (allowFirst) {
      if (workspaceSurface.value?.focusListEdge?.('first')) {
        clearFocusOrigin()
        return
      }
      if (candidates[0] instanceof HTMLElement) candidates[0].focus()
      else appHeader.value?.focusSearch()
    }
    clearFocusOrigin()
  }

  function focusEntry() {
    if (focusWithinGraph()) return
    if (graph.loading) {
      entryFocusPending = true
      root.value?.focus()
      return
    }
    applyEntryFocus()
  }

  watch(() => graph.loading, async loading => {
    if (loading || !entryFocusPending) return
    entryFocusPending = false
    await nextTick()
    if (document.activeElement === root.value) applyEntryFocus()
  })

  function navigateObjectHistory(direction) {
    const navigate = () => void performHistoryNavigation(direction)
    if (!commitThen(navigate)) navigate()
  }

  function setSection(section) {
    const change = () => {
      focusMode.value = false
      if (graph.selectedNode) graph.closeInspector({ restore: false })
      graph.setSection(section)
    }
    if (!commitThen(change)) change()
  }

  function setView(view) {
    const change = () => {
      focusMode.value = false
      if (graph.selectedNode) graph.closeInspector({ restore: false })
      graph.setView(view)
    }
    if (!commitThen(change)) change()
  }

  function toggleScope(scopeId) {
    const change = () => {
      void graph.toggleScope(scopeId).catch(cause => diagnostic(graphErrorMessage(cause)))
    }
    if (!commitThen(change)) change()
  }

  async function openFile(request) {
    const path = typeof request === 'string' ? request : request?.path
    if (!path) return
    if (path.startsWith('/') || path.startsWith('~') || /^[A-Za-z]:[\\/]/.test(path)) {
      openFileResult(typeof request === 'object' ? { ...request, path } : path)
      return
    }
    const projectId = projectIdForNode(typeof request === 'object' ? request?.nodeId : null)
    const sourceNode = typeof request === 'object' && request?.nodeId
      ? graph.nodes.find(node => node.id === request.nodeId)
      : null
    let resolved = null
    try {
      resolved = await resolveProjectFile({
        projectId,
        scopeId: sourceNode?.provenance?.scopeId || '',
        relativePath: path,
        fallbackWorkspace: workspacePath(),
      })
    } catch (cause) {
      diagnostic(graphErrorMessage(cause))
      return
    }
    if (resolved) {
      openFileResult(typeof request === 'object' ? { ...request, path: resolved } : resolved)
      return
    }
    const project = projectId ? graph.nodes.find(node => node.id === projectId) : null
    diagnostic(project
      ? `${path} could not be opened. It is not in the current workspace or in a local folder of project ${project.title || projectId}.`
      : `${path} could not be opened. It is not in the current workspace.`)
  }

  async function openUrl(url) {
    try {
      await openExternalUrl(url)
    } catch (cause) {
      diagnostic(graphErrorMessage(cause))
    }
  }

  function refresh() {
    const reload = () => {
      void graph.refresh().catch(cause => diagnostic(graphErrorMessage(cause)))
    }
    if (!commitThen(reload)) reload()
  }

  function commitThen(action) {
    return workspaceSurface.value?.commitThen(action) || false
  }

  function rememberFocusOrigin(nodeId = '') {
    const active = document.activeElement
    if (active instanceof HTMLElement && root.value?.contains(active)) focusReturnElement = active
    focusReturnNodeId = nodeId || focusReturnNodeId
  }

  function focusWithinGraph() {
    const active = document.activeElement
    return active instanceof HTMLElement && root.value?.contains(active)
  }

  function clearFocusOrigin() {
    focusReturnElement = null
    focusReturnNodeId = ''
  }

  function applyEntryFocus() {
    if (focusMode.value) workspaceSurface.value?.focusInspectorEntry()
    else restoreGraphFocus(graph.selectedNode?.id || '')
  }

  async function performHistoryNavigation(direction) {
    try {
      await graph.navigateHistory(direction)
      await nextTick()
      workspaceSurface.value?.focusInspectorEntry()
    } catch (cause) {
      diagnostic(graphErrorMessage(cause))
    }
  }

  function projectIdForNode(nodeId) {
    const node = nodeId ? graph.nodes.find(candidate => candidate.id === nodeId) : null
    if (!node) return null
    if (node.kind === 'project') return node.id
    const edge = (node.relations || []).find(candidate => (
      candidate.relation === 'part_of'
      && graph.nodes.some(target => target.id === candidate.target && target.kind === 'project')
    ))
    return edge?.target || node.projectId || null
  }

  return {
    closeObject,
    enterFocus,
    finalizeObjectClose,
    focusEntry,
    focusMode,
    navigateObjectHistory,
    openFile,
    openNode,
    openRelatedNode,
    openUrl,
    refresh,
    restoreGraphFocus,
    returnToPeek,
    setSection,
    setView,
    toggleScope,
  }
}
