import {
  computed,
  nextTick,
  onMounted,
  onBeforeUnmount,
  onUnmounted,
  provide,
  ref,
  toRefs,
  watch,
} from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-dialog'
import { GRAPH_INSPECTOR_CONTEXT } from './graphInspectorContext.js'
import {
  activityStatusClass,
  defaultRelationFor,
  displayTitle,
  entityStatuses,
  fileExtension,
  fileName,
  human,
  isOverdue,
  priorities,
  projectStatuses,
  projectTypes,
  readableDate,
  readableDateTime,
  readableDuration,
  RELATION_DEFINITIONS,
  statuses,
  titleCase,
} from './graphInspectorModel.js'

export function useGraphInspector(props, emit) {
  const {
    neighbors,
    nodes,
    error,
    activities,
    scopeIds,
    graphRevision,
    viewState,
  } = toRefs(props)
  const node = computed(() => props.documentFile.graph.node)
  const draft = computed(() => props.documentFile.graph.draft)
  const dirty = computed(() => props.documentFile.dirty)
  const saving = computed(() => props.documentFile.saveState === 'saving')
  const saved = computed(() => props.documentFile.saveState === 'saved')
  const noteEditor = ref(null)
  const titleInput = ref(null)
  const inspectorRoot = ref(null)
  const summaryInput = ref(null)
  const deliverablesInput = ref(null)
  const filesInput = ref(null)
  const growingInputs = [titleInput, summaryInput, deliverablesInput, filesInput]
  let inputResizeObserver = null
  const copiedFact = ref('')
  let copiedFactTimer = null
  const moreOpen = ref(false)
  const propertiesOpen = ref(false)
  const connectionOpen = ref(false)
  const historyOpen = ref(false)
  const historyLoading = ref(false)
  const historyError = ref('')
  const historyEntries = ref([])
  const fileHistoryAvailable = ref(false)
  const resourceError = ref('')
  const teamResourceFiles = ref([])
  const connectionRelation = ref('')
  const connectionTarget = ref('')
  const attendeeToAdd = ref('')
  let historyAvailabilityRequest = 0
  let teamResourceRequest = 0

  const projects = computed(() => props.nodes.filter(node => node.kind === 'project'))
  const people = computed(() => props.nodes.filter(node => node.kind === 'person'))
  const activeTeamPeople = computed(() => people.value.filter(person => (
    (person.teamMember || person.properties?.teamMember)
    && (person.status || person.properties?.status) === 'active'
  )))
  const projectOptions = computed(() => [
    { value: '', label: 'No project', hint: 'Remove project relation' },
    ...labelOption(draft.value.projectId, projects.value),
    ...projects.value.map(project => ({
      value: project.id,
      label: displayTitle(project),
      hint: `${human(scopeFor(project))} scope`,
    })),
  ])
  const personOptions = computed(() => [
    { value: '', label: 'Unassigned', hint: 'Remove assignee relation' },
    ...currentPersonOption(draft.value.assigneeId),
    ...activeTeamPeople.value.map(person => ({
      value: person.id,
      label: displayTitle(person),
      hint: 'Team member',
    })),
  ])
  const scopeOptions = computed(() => props.scopes.map(scope => ({
    value: scope.id,
    label: scope.kind === 'project' ? 'Project' : titleCase(scope.kind),
    hint: scope.kind === 'project' ? 'Current workspace' : '',
  })))
  const meetingAttendees = computed(() => draft.value.attendeeIds
    .map(id => relatedTarget(id))
    .filter(person => person?.kind === 'person'))
  const meetingPersonOptions = computed(() => people.value
    .filter(person => !draft.value.attendeeIds.includes(person.id))
    .map(person => ({ value: person.id, label: displayTitle(person) }))
    .sort((left, right) => left.label.localeCompare(right.label)))

  function currentPersonOption(value) {
    const current = String(value || '').trim()
    if (!current || activeTeamPeople.value.some(person => person.id === current)) return []
    const person = relatedTarget(current)
    if (person) {
      return [{ value: current, label: displayTitle(person), hint: 'Current owner' }]
    }
    return [{ value: current, label: current, hint: 'Label from the Markdown source' }]
  }

  // A legacy source value is a label, not an id. Offering it keeps the control
  // showing what the Markdown actually says instead of reading as unassigned.
  function labelOption(value, candidates) {
    const current = String(value || '').trim()
    if (!current || candidates.some(candidate => candidate.id === current)) return []
    const target = relatedTarget(current)
    return [{ value: current, label: target ? displayTitle(target) : current, hint: target ? `${human(target.kind)} entry` : 'Label from the Markdown source' }]
  }
  const relationOptions = computed(() => (
    RELATION_DEFINITIONS
      .filter(definition => (
        definition.from.includes('any') || definition.from.includes(node.value?.kind)
      ))
      .map(definition => ({
        value: definition.value,
        label: definition.label,
        hint: definition.hint,
      }))
  ))
  const activeRelationDefinition = computed(() => (
    RELATION_DEFINITIONS.find(definition => definition.value === connectionRelation.value)
  ))
  const connectionTargetOptions = computed(() => {
    const targetKinds = activeRelationDefinition.value?.to || ['any']
    return props.nodes
      .filter(candidate => (
        candidate.id !== node.value?.id
        && (targetKinds.includes('any') || targetKinds.includes(candidate.kind))
        && !draft.value.relations.some(edge => (
          edge.relation === connectionRelation.value && edge.target === candidate.id
        ))
      ))
      .map(candidate => ({
        value: candidate.id,
        label: displayTitle(candidate),
        hint: `${human(candidate.kind)} · ${scopeFor(candidate)}`,
      }))
  })
  const connectionRows = computed(() => (
    draft.value.relations
      .map((edge, index) => ({
        edge,
        index,
        target: relatedTarget(edge.target),
      }))
      .filter(connection => !(
        node.value?.kind === 'issue'
        && ['part_of', 'assigned_to'].includes(connection.edge.relation)
      ))
      .filter(connection => !(
        node.value?.kind === 'meeting'
        && ['part_of', 'attended_by'].includes(connection.edge.relation)
      ))
  ))
  const incomingConnections = computed(() => props.neighbors.filter(neighbor => (
    neighbor.direction === 'incoming'
    && neighbor.node.relations?.some(edge => edge.relation === neighbor.relation && edge.target === node.value.id)
  )))
  const canAddConnection = computed(() => (
    Boolean(connectionRelation.value && connectionTarget.value)
    && !draft.value.relations.some(edge => (
      edge.relation === connectionRelation.value && edge.target === connectionTarget.value
    ))
  ))
  const attachmentItems = computed(() => {
    const items = new Map()
    for (const item of [
      ...draftFiles(draft.value.deliverables).map(item => ({ ...item, output: true })),
      ...draftFiles(draft.value.files).map(item => ({ ...item, output: false })),
    ]) {
      const path = normalizeResourcePath(item.path)
      const previous = items.get(path)
      items.set(path, previous
        ? { ...previous, label: previous.label || item.label, output: previous.output || item.output }
        : item)
    }
    return [...items.values()]
  })
  const canAddTeamResource = computed(() => (
    node.value?.provenance?.scopeId === 'team:main'
  ))
  const canRecoverTeamResource = computed(() => (
    canAddTeamResource.value && node.value?.kind === 'resource'
  ))
  const linkedTeamResourcePaths = computed(() => {
    const linked = new Set()
    for (const candidate of props.nodes) {
      if (candidate.provenance?.scopeId !== 'team:main') continue
      const values = candidate.id === node.value?.id
        ? resourcePathsFromDraft(draft.value.files)
        : resourcePathsFromProperties(candidate.properties?.files)
      for (const path of values) linked.add(normalizeResourcePath(path))
    }
    return linked
  })
  const unlinkedResourceItems = computed(() => teamResourceFiles.value.filter(resource => (
    !linkedTeamResourcePaths.value.has(normalizeResourcePath(resource.path))
  )))
  const saveStateLabel = computed(() => {
    if (props.documentFile.saveState === 'failed') return 'Save failed'
    if (saving.value) return 'Saving…'
    if (dirty.value) return 'Unsaved'
    if (saved.value) return 'Saved'
    return ''
  })
  const saveStateClass = computed(() => ({
    'save-state-conflict': props.documentFile.saveState === 'failed',
    'save-state-dirty': dirty.value,
    'save-state-saved': saved.value && !dirty.value,
  }))
  const editableTags = computed({
    get: () => node.value?.kind === 'issue' ? draft.value.labels : draft.value.tags,
    set: value => {
      if (node.value?.kind === 'issue') draft.value.labels = value
      else draft.value.tags = value
    },
  })

  watch(
    () => [props.documentFile.id, node.value?.id, node.value?.kind],
    (next, previous) => {
      if (previous && next.every((value, index) => value === previous[index])) return
      connectionRelation.value = defaultRelationFor(node.value?.kind)
      connectionTarget.value = ''
      attendeeToAdd.value = ''
      moreOpen.value = false
      propertiesOpen.value = false
      connectionOpen.value = false
      historyOpen.value = false
      historyEntries.value = []
      historyError.value = ''
      resourceError.value = ''
      void nextTick(growAll)
    },
    { immediate: true },
  )

  watch(
    () => [draft.value.title, draft.value.summary, draft.value.deliverables, draft.value.files],
    (values, previous) => {
      values.forEach((value, index) => {
        if (value !== previous[index]) grow(growingInputs[index].value)
      })
    },
    { flush: 'post' },
  )

  watch(
    () => growingInputs.map(input => input.value),
    () => growAll(),
    { flush: 'post' },
  )

  watch(
    () => [
      node.value?.id,
      node.value?.kind,
      node.value?.provenance?.scopeId,
      node.value?.provenance?.sourcePath,
    ],
    (next, previous) => {
      if (previous && next.every((value, index) => value === previous[index])) return
      historyAvailabilityRequest += 1
      teamResourceRequest += 1
      fileHistoryAvailable.value = false
      teamResourceFiles.value = []
      if (moreOpen.value) void refreshHistoryAvailability()
      if (propertiesOpen.value) void loadTeamResources()
    },
    { immediate: true },
  )

  watch(moreOpen, open => { if (open) void refreshHistoryAvailability() })
  watch(propertiesOpen, open => { if (open) void loadTeamResources() })

  function save() {
    emit('save')
  }

  function addMeetingAttendee(id) {
    if (id && !draft.value.attendeeIds.includes(id)) {
      draft.value.attendeeIds = [...draft.value.attendeeIds, id]
      changed()
    }
    attendeeToAdd.value = ''
  }

  function removeMeetingAttendee(id) {
    draft.value.attendeeIds = draft.value.attendeeIds.filter(personId => personId !== id)
    changed()
  }

  function openRelated(id) {
    emit('openNode', id)
  }

  function relatedTarget(id) {
    return props.nodes.find(candidate => candidate.id === id)
      || props.neighbors.find(neighbor => neighbor.node.id === id)?.node
  }

  function revealReference(request) {
    noteEditor.value?.revealReference(request, props.documentFile.graph.sourceRevision)
  }

  function openSource(path) {
    if (!path) return
    emit('openFile', { path, nodeId: node.value?.id || null })
  }

  function openUrl(url) {
    if (!url) return
    emit('openUrl', url)
  }

  function openActivity(id) {
    emit('openActivity', id)
  }

  function quickCreate(kind) {
    emit('quickCreate', { kind, parent: node.value })
  }

  const lookupFacts = computed(() => {
    if (node.value?.kind !== 'person') return []
    const properties = node.value.properties || {}
    const companyId = (node.value.relations || [])
      .find(edge => edge.relation === 'works_at')?.target || ''
    const company = companyId
      ? props.nodes.find(node => node.id === companyId)?.title || 'Unavailable company'
      : ''
    return [
      ['Email', properties.email],
      ['Phone', properties.phone],
      ['Role', properties.role],
      ['Company', company],
    ]
      .filter(([, value]) => value)
      .map(([label, value]) => ({ label, value }))
  })

  function copyFact(fact) {
    try {
      navigator.clipboard?.writeText(fact.value)
    } catch {
      // Clipboard unavailable (insecure context); the fact stays visible.
    }
    copiedFact.value = fact.label
    clearTimeout(copiedFactTimer)
    copiedFactTimer = setTimeout(() => {
      copiedFact.value = ''
    }, 1200)
  }

  function changed() {
    emit('draftChange')
  }

  function updateDraft(field, value) {
    draft.value[field] = value
    changed()
  }

  function selectConnectionRelation(value) {
    connectionRelation.value = value
    connectionTarget.value = ''
  }

  function addConnection() {
    if (!canAddConnection.value) return
    draft.value.relations.push({
      relation: connectionRelation.value,
      target: connectionTarget.value,
      legacy: false,
    })
    connectionTarget.value = ''
    connectionOpen.value = false
    changed()
  }

  function removeConnection(index) {
    if (index < 0 || index >= draft.value.relations.length) return
    draft.value.relations.splice(index, 1)
    changed()
  }

  function growAll() {
    for (const input of growingInputs) grow(input.value)
  }

  // Respect each field's minimum height while it grows with its content.
  function grow(input) {
    if (!input?.isConnected || !input.clientWidth) return
    const style = getComputedStyle(input)
    // Editor content stays mounted in its narrow, hidden rail. Measuring there
    // wraps each word onto extra lines and leaves an oversized inline height.
    if (style.visibility === 'hidden') return
    input.style.height = '0px'
    const floor = Number.parseFloat(style.minHeight) || 0
    input.style.height = `${Math.max(input.scrollHeight, floor)}px`
  }

  function scopeFor(node) {
    const scopeId = node.provenance?.scopeId || node.scopeId
    const scope = props.scopes.find(candidate => candidate.id === scopeId)
    return scope?.kind || node.provenance?.scopeKind || 'visible'
  }

  function connectionTitle(connection) {
    return connection.target ? displayTitle(connection.target) : 'Unavailable entry'
  }

  function remove() {
    emit('delete', {
      id: node.value.id,
      expectedRevision: props.documentFile.graph.sourceRevision,
      title: draft.value.title,
    })
  }

  function moreAction(action) {
    moreOpen.value = false
    action()
  }

  async function toggleHistory() {
    moreOpen.value = false
    if (!fileHistoryAvailable.value) return
    historyOpen.value = !historyOpen.value
    if (!historyOpen.value || historyEntries.value.length || historyLoading.value) return
    historyLoading.value = true
    historyError.value = ''
    try {
      const entries = await invoke('git_file_history', {
        path: node.value?.provenance?.sourcePath,
        limit: 50,
      })
      historyEntries.value = Array.isArray(entries) ? entries : []
    } catch (cause) {
      historyError.value = cause instanceof Error ? cause.message : String(cause)
    } finally {
      historyLoading.value = false
    }
  }

  async function openHistoryVersion(entry) {
    const path = node.value?.provenance?.sourcePath
    if (!path || !entry?.hash) return
    if (entry.binary) {
      if (!window.confirm('Restore this file version? The current version remains in History.')) return
      try {
        await invoke('git_restore_file_version', { path, hash: entry.hash })
        historyOpen.value = false
      } catch (cause) {
        historyError.value = cause instanceof Error ? cause.message : String(cause)
      }
      return
    }
    historyOpen.value = false
    emit('openFile', {
      path,
      nodeId: node.value?.id || null,
      history: {
        hash: entry.hash,
        shortHash: entry.shortHash,
        label: entry.message,
        timestamp: entry.authoredAt,
      },
    })
  }

  async function addResourceFile() {
    if (!canAddTeamResource.value) return
    resourceError.value = ''
    try {
      const selection = await open({
        directory: false,
        multiple: false,
        title: 'Add Team resource',
      })
      const source = Array.isArray(selection) ? selection[0] : selection
      const sourcePath = typeof source === 'string' ? source : source?.path
      if (!sourcePath) return
      const path = await invoke('team_resource_import', { source: sourcePath })
      draft.value.files = [draft.value.files.trim(), path].filter(Boolean).join('\n')
      changed()
    } catch (cause) {
      resourceError.value = cause instanceof Error ? cause.message : String(cause)
    }
  }

  async function refreshHistoryAvailability() {
    const request = ++historyAvailabilityRequest
    const path = String(node.value?.provenance?.sourcePath || '').trim()
    fileHistoryAvailable.value = false
    if (!path) return
    try {
      const available = await invoke('git_file_history_available', { path })
      if (request === historyAvailabilityRequest) fileHistoryAvailable.value = Boolean(available)
    } catch {
      if (request === historyAvailabilityRequest) fileHistoryAvailable.value = false
    }
  }

  async function loadTeamResources() {
    const request = ++teamResourceRequest
    teamResourceFiles.value = []
    if (!canRecoverTeamResource.value) return
    try {
      const files = await invoke('team_resource_list')
      if (request === teamResourceRequest) {
        teamResourceFiles.value = Array.isArray(files) ? files : []
      }
    } catch (cause) {
      if (request === teamResourceRequest) {
        resourceError.value = cause instanceof Error ? cause.message : String(cause)
      }
    }
  }

  async function attachTeamResource(resource) {
    const path = normalizeResourcePath(resource?.path)
    const alreadyLinked = resourcePathsFromDraft(draft.value.files)
      .some(value => normalizeResourcePath(value) === path)
    if (!path || alreadyLinked) return
    draft.value.files = [draft.value.files.trim(), path].filter(Boolean).join('\n')
    changed()
  }

  function onKeydown(event) {
    if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
      event.preventDefault()
      save()
      return
    }
    if (event.key === 'Escape' && moreOpen.value) {
      event.preventDefault()
      event.stopPropagation()
      moreOpen.value = false
      inspectorRoot.value?.querySelector('[data-graph-control="focus-more"]')?.focus()
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      if (historyOpen.value) { historyOpen.value = false; return }
      if (connectionOpen.value) {
        connectionOpen.value = false
        void nextTick(() => inspectorRoot.value?.querySelector('[data-graph-control="entry-add-relation"]')?.focus())
        return
      }
      emit('closeRequest')
    }
  }

  function onDocumentPointerDown(event) {
    if (
      moreOpen.value
      && !inspectorRoot.value?.querySelector('[data-object-more-root]')?.contains(event.target)
    ) {
      moreOpen.value = false
    }
  }

  function onFocusIn(event) {
    if (props.viewState) props.viewState.focusNote = Boolean(event.target.closest?.('[data-graph-markdown-editor]'))
  }

  function focusEntry() {
    if (props.viewState?.focusNote) { noteEditor.value?.focus(); return }
    const target = inspectorRoot.value?.querySelector('[data-inspector-title]')
    if (target instanceof HTMLElement) target.focus({ preventScroll: true })
    else inspectorRoot.value?.focus({ preventScroll: true })
  }

  onBeforeUnmount(() => {
    inputResizeObserver?.disconnect()
    if (props.viewState) props.viewState.scrollTop = inspectorRoot.value?.querySelector('.focus-scroll')?.scrollTop || 0
  })

  onMounted(() => {
    document.addEventListener('pointerdown', onDocumentPointerDown)
    if (typeof ResizeObserver === 'function' && inspectorRoot.value) {
      let previousWidth = null
      inputResizeObserver = new ResizeObserver(([entry]) => {
        const width = entry?.contentRect.width
        if (width == null || width === previousWidth) return
        previousWidth = width
        // Ignore height-only notifications caused by sizing these fields.
        growAll()
      })
      inputResizeObserver.observe(inspectorRoot.value)
    }
    void nextTick(() => {
      const scroll = inspectorRoot.value?.querySelector('.focus-scroll')
      if (scroll && props.viewState) scroll.scrollTop = props.viewState.scrollTop
    })
  })

  onUnmounted(() => {
    document.removeEventListener('pointerdown', onDocumentPointerDown)
    clearTimeout(copiedFactTimer)
  })

  const context = {
    node,
    nodes,
    viewState,
    noteEditor,
    scopeIds,
    graphRevision,
    neighbors,
    error,
    saving,
    activities,
    titleInput,
    summaryInput,
    deliverablesInput,
    filesInput,
    dirty,
    copiedFact,
    moreOpen,
    propertiesOpen,
    connectionOpen,
    historyOpen,
    historyLoading,
    historyError,
    historyEntries,
    fileHistoryAvailable,
    resourceError,
    connectionRelation,
    connectionTarget,
    attendeeToAdd,
    draft,
    statuses,
    priorities,
    projectTypes,
    projectStatuses,
    entityStatuses,
    projectOptions,
    personOptions,
    scopeOptions,
    meetingAttendees,
    meetingPersonOptions,
    relationOptions,
    connectionTargetOptions,
    connectionRows,
    incomingConnections,
    canAddConnection,
    attachmentItems,
    canAddTeamResource,
    canRecoverTeamResource,
    unlinkedResourceItems,
    saveStateLabel,
    saveStateClass,
    editableTags,
    lookupFacts,
    emit,
    save,
    addMeetingAttendee,
    removeMeetingAttendee,
    openRelated,
    relatedTarget,
    openSource,
    openUrl,
    openActivity,
    quickCreate,
    copyFact,
    changed,
    updateDraft,
    selectConnectionRelation,
    addConnection,
    removeConnection,
    connectionTitle,
    displayTitle,
    remove,
    moreAction,
    toggleHistory,
    openHistoryVersion,
    addResourceFile,
    attachTeamResource,
    readableDate,
    readableDateTime,
    readableDuration,
    isOverdue,
    activityStatusClass,
    fileName,
    fileExtension,
    human,
    inspectorRoot,
    onKeydown,
    onFocusIn,
  }
  provide(GRAPH_INSPECTOR_CONTEXT, context)

  return {
    context,
    exposed: { focusEntry, revealReference },
  }
}

function draftFiles(value) {
  return String(value || '').split('\n').map(line => {
    const [path, ...label] = line.split('|').map(part => part.trim())
    return { path, label: label.join(' | ') }
  }).filter(item => item.path)
}

function resourcePathsFromDraft(value) {
  return String(value || '')
    .split('\n')
    .map(line => line.split('|')[0].trim())
    .filter(Boolean)
}

function resourcePathsFromProperties(values) {
  return (Array.isArray(values) ? values : [])
    .map(value => typeof value === 'string' ? value : value?.path)
    .filter(Boolean)
}

function normalizeResourcePath(value) {
  return String(value || '').trim().replaceAll('\\', '/').replace(/^\.\//, '')
}
