import {
  computed,
  nextTick,
  onMounted,
  onUnmounted,
  provide,
  reactive,
  ref,
  toRefs,
  watch,
} from 'vue'
import { GRAPH_INSPECTOR_CONTEXT } from './graphInspectorContext.js'
import {
  buildInspectorSave,
  hydrateInspectorDraft,
} from './graphInspectorPersistence.js'
import {
  activityStatusClass,
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
  splitValues,
  statuses,
  titleCase,
} from './graphInspectorModel.js'

export function useGraphInspector(props, emit) {
  const {
    mode,
    node,
    neighbors,
    scopes,
    nodes,
    conflict,
    error,
    saving,
    activities,
    historyBack,
    historyForward,
  } = toRefs(props)
  const titleInput = ref(null)
  const inspectorRoot = ref(null)
  const summaryInput = ref(null)
  const deliverablesInput = ref(null)
  const dirty = ref(false)
  const saveBlocked = ref(false)
  const copiedFact = ref('')
  let copiedFactTimer = null
  const saved = ref(false)
  const moreOpen = ref(false)
  const connectionRelation = ref('')
  const connectionTarget = ref('')
  const attendeeToAdd = ref('')
  let autosaveTimer = null
  let savedTimer = null
  let editVersion = 0
  let currentNodeId = ''
  let pendingAction = null
  
  const draft = reactive({
    title: '',
    summary: '',
    body: '',
    tags: '',
    status: 'backlog',
    priority: 'normal',
    dueDate: '',
    remindAt: '',
    projectId: '',
    scopeId: '',
    attendeeIds: [],
    assigneeId: '',
    waitingFor: '',
    snoozeUntil: '',
    labels: '',
    deliverables: '',
    projectType: '',
    projectStatus: 'planned',
    companyRoles: '',
    entityStatus: 'active',
    teamMember: false,
    relations: [],
  })
  
  const projects = computed(() => props.nodes.filter(node => node.kind === 'project'))
  const people = computed(() => props.nodes.filter(node => node.kind === 'person'))
  const activeTeamPeople = computed(() => people.value.filter(person => (
    (person.teamMember || person.properties?.teamMember)
    && (person.status || person.properties?.status) === 'active'
  )))
  const projectOptions = computed(() => [
    { value: '', label: 'No project', hint: 'Remove project relation' },
    ...labelOption(draft.projectId, projects.value),
    ...projects.value.map(project => ({
      value: project.id,
      label: displayTitle(project),
      hint: `${human(scopeFor(project))} scope`,
    })),
  ])
  const personOptions = computed(() => [
    { value: '', label: 'Unassigned', hint: 'Remove assignee relation' },
    ...currentPersonOption(draft.assigneeId),
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
  const meetingAttendees = computed(() => draft.attendeeIds
    .map(id => people.value.find(person => person.id === id))
    .filter(Boolean))
  const meetingPersonOptions = computed(() => people.value
    .filter(person => !draft.attendeeIds.includes(person.id))
    .map(person => ({ value: person.id, label: displayTitle(person) }))
    .sort((left, right) => left.label.localeCompare(right.label)))
  
  function currentPersonOption(value) {
    const current = String(value || '').trim()
    if (!current || activeTeamPeople.value.some(person => person.id === current)) return []
    const person = people.value.find(candidate => candidate.id === current)
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
    return [{ value: current, label: current, hint: 'Label from the Markdown source' }]
  }
  const relationOptions = computed(() => (
    RELATION_DEFINITIONS
      .filter(definition => (
        definition.from.includes('any') || definition.from.includes(props.node?.kind)
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
        candidate.id !== props.node?.id
        && (targetKinds.includes('any') || targetKinds.includes(candidate.kind))
        && !draft.relations.some(edge => (
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
    draft.relations
      .map((edge, index) => ({
        edge,
        index,
        target: props.nodes.find(candidate => candidate.id === edge.target),
      }))
      .filter(connection => !(
        props.node?.kind === 'issue'
        && ['part_of', 'assigned_to'].includes(connection.edge.relation)
      ))
      .filter(connection => !(
        props.node?.kind === 'meeting'
        && ['part_of', 'attended_by'].includes(connection.edge.relation)
      ))
  ))
  const canAddConnection = computed(() => (
    Boolean(connectionRelation.value && connectionTarget.value)
    && !draft.relations.some(edge => (
      edge.relation === connectionRelation.value && edge.target === connectionTarget.value
    ))
  ))
  const deliverableItems = computed(() => (
    (props.node?.properties?.deliverables || [])
      .map(item => (
        typeof item === 'string'
          ? { path: item, label: '' }
          : { path: item?.path || '', label: item?.label || '' }
      ))
      .filter(item => item.path)
  ))
  const attentionLabel = computed(() => {
    if (draft.snoozeUntil) return `Snoozed until ${readableDate(draft.snoozeUntil)}`
    if (isOverdue(draft.dueDate)) return 'Overdue'
    return 'Clear'
  })
  const saveStateLabel = computed(() => {
    if (props.conflict) return 'Conflict'
    if (props.saving) return 'Saving…'
    if (dirty.value) return 'Unsaved'
    if (saved.value) return 'Saved'
    return ''
  })
  const saveStateClass = computed(() => ({
    'save-state-conflict': Boolean(props.conflict),
    'save-state-dirty': dirty.value && !props.conflict,
    'save-state-saved': saved.value && !dirty.value && !props.conflict,
  }))
  const editableTags = computed({
    get: () => props.node?.kind === 'issue' ? draft.labels : draft.tags,
    set: value => {
      if (props.node?.kind === 'issue') draft.labels = value
      else draft.tags = value
    },
  })
  
  watch(
    () => props.node,
    (node) => {
      if (!node) return
      if (node.id !== currentNodeId || !dirty.value) resetDraft(node)
    },
    { immediate: true },
  )
  
  watch(() => props.mode, async () => {
    moreOpen.value = false
    await nextTick()
    growAll()
  })
  
  watch(() => props.saving, (saving, wasSaving) => {
    if (saving || !wasSaving || dirty.value || !pendingAction) return
    const action = pendingAction
    pendingAction = null
    action()
  })
  
  function resetDraft(node) {
    clearTimeout(autosaveTimer)
    currentNodeId = node.id
    connectionRelation.value = hydrateInspectorDraft(draft, node)
    connectionTarget.value = ''
    attendeeToAdd.value = ''
    dirty.value = false
    saveBlocked.value = false
    saved.value = false
    editVersion = 0
    pendingAction = null
    void nextTick(growAll)
  }
  
  function save(afterSave = null) {
    if (typeof afterSave !== 'function') afterSave = null
    clearTimeout(autosaveTimer)
    if (!dirty.value || props.saving || !draft.title.trim()) return
    const version = editVersion
    const tags = splitValues(editableTags.value)
    const { payload, targetScopeId } = buildInspectorSave({
      node: props.node,
      nodes: props.nodes,
      draft,
      tags,
    })
    emit('save', payload, {
      done() {
        saveBlocked.value = false
        if (editVersion === version) {
          dirty.value = false
          saved.value = true
          clearTimeout(savedTimer)
          savedTimer = setTimeout(() => { saved.value = false }, 1600)
          const action = pendingAction
          pendingAction = null
          afterSave?.()
          action?.()
        } else {
          scheduleSave()
        }
      },
      // A rejected save must not strand the draft: drop the queued navigation so
      // the surface stays open with its error, and let the next explicit exit
      // leave without retrying the same failing write.
      failed() {
        saveBlocked.value = true
        pendingAction = null
        clearTimeout(autosaveTimer)
      },
    }, { targetScopeId })
  }
  
  function addMeetingAttendee(id) {
    if (id && !draft.attendeeIds.includes(id)) {
      draft.attendeeIds = [...draft.attendeeIds, id]
      changed()
    }
    attendeeToAdd.value = ''
  }
  
  function removeMeetingAttendee(id) {
    draft.attendeeIds = draft.attendeeIds.filter(personId => personId !== id)
    changed()
  }
  
  function requestExit(eventName) {
    moreOpen.value = false
    commitThen(() => emit(eventName))
  }
  
  function requestClose() {
    requestExit('close')
  }
  
  function requestBack() {
    requestExit('back')
  }
  
  function openRelated(id) {
    commitThen(() => emit('openNode', id))
  }
  
  function openSource(path) {
    if (!path) return
    commitThen(() => emit('openFile', { path, nodeId: props.node?.id || null }))
  }
  
  function openUrl(url) {
    if (!url) return
    commitThen(() => emit('openUrl', url))
  }
  
  function openActivity(id) {
    commitThen(() => emit('openActivity', id))
  }
  
  function quickCreate(kind) {
    commitThen(() => emit('quickCreate', { kind, parent: props.node }))
  }
  
  const lookupFacts = computed(() => {
    if (props.node?.kind !== 'person') return []
    const properties = props.node.properties || {}
    const companyId = (props.node.relations || [])
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
  
  function commitThen(action) {
    if ((!dirty.value && !props.saving) || saveBlocked.value) {
      action()
      return
    }
    pendingAction = action
    if (!props.saving) save()
  }
  
  function changed() {
    editVersion += 1
    dirty.value = true
    saved.value = false
    saveBlocked.value = false
    scheduleSave()
  }
  
  function changedAndGrow(event) {
    changed()
    grow(event.target)
  }
  
  function updateDraft(field, value) {
    draft[field] = value
    changed()
  }
  
  function selectConnectionRelation(value) {
    connectionRelation.value = value
    connectionTarget.value = ''
  }
  
  function addConnection() {
    if (!canAddConnection.value) return
    draft.relations.push({
      relation: connectionRelation.value,
      target: connectionTarget.value,
      legacy: false,
    })
    connectionTarget.value = ''
    changed()
  }
  
  function removeConnection(index) {
    if (index < 0 || index >= draft.relations.length) return
    draft.relations.splice(index, 1)
    changed()
  }
  
  function quickUpdate(field, value) {
    draft[field] = value
    changed()
    clearTimeout(autosaveTimer)
    autosaveTimer = setTimeout(save, 0)
  }
  
  function scheduleSave() {
    clearTimeout(autosaveTimer)
    autosaveTimer = setTimeout(save, 900)
  }
  
  function growAll() {
    for (const input of [titleInput.value, summaryInput.value, deliverablesInput.value]) grow(input)
  }
  
  // Peek and Focus size the same fields differently, so the floor comes from the
  // element's own min-height rather than a mode-specific constant.
  function grow(input) {
    if (!input) return
    input.style.height = '0px'
    const floor = Number.parseFloat(getComputedStyle(input).minHeight) || 0
    input.style.height = `${Math.max(input.scrollHeight, floor)}px`
  }
  
  function scopeFor(node) {
    const scopeId = node.provenance?.scopeId || node.scopeId
    const scope = props.scopes.find(candidate => candidate.id === scopeId)
    return scope?.kind || node.provenance?.scopeKind || 'visible'
  }
  
  function connectionTitle(connection) {
    return connection.target ? displayTitle(connection.target) : 'Unavailable object'
  }
  
  function remove() {
    commitThen(() => {
      emit('delete', {
        id: props.node.id,
        expectedRevision: props.node.provenance?.sourceRevision,
        title: props.node.title,
      })
    })
  }
  
  function moreAction(action) {
    moreOpen.value = false
    action()
  }
  
  function onKeydown(event) {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
      event.preventDefault()
      save()
      return
    }
    if (event.key === 'Escape' && moreOpen.value) {
      event.preventDefault()
      event.stopPropagation()
      moreOpen.value = false
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
  
  function focusEntry() {
    const selector = modeEntryControl()
    const target = inspectorRoot.value?.querySelector(selector)
    if (target instanceof HTMLElement) target.focus()
    else inspectorRoot.value?.focus()
  }
  
  function modeEntryControl() {
    return props.mode === 'focus'
      ? '[data-graph-control="focus-back"]'
      : '[data-graph-control="peek-title"]'
  }
  
  
  
  onMounted(() => {
    document.addEventListener('pointerdown', onDocumentPointerDown)
  })
  
  onUnmounted(() => {
    document.removeEventListener('pointerdown', onDocumentPointerDown)
    clearTimeout(autosaveTimer)
    clearTimeout(savedTimer)
  })

  const context = {
    node,
      neighbors,
      conflict,
      error,
      saving,
      activities,
      historyBack,
      historyForward,
      titleInput,
      summaryInput,
      deliverablesInput,
      dirty,
      copiedFact,
      moreOpen,
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
      canAddConnection,
      deliverableItems,
      attentionLabel,
      saveStateLabel,
      saveStateClass,
      editableTags,
      lookupFacts,
      emit,
      save,
      addMeetingAttendee,
      removeMeetingAttendee,
      requestExit,
      openRelated,
      openSource,
      openUrl,
      openActivity,
      quickCreate,
      copyFact,
      changed,
      changedAndGrow,
      updateDraft,
      selectConnectionRelation,
      addConnection,
      removeConnection,
      quickUpdate,
      connectionTitle,
      displayTitle,
      remove,
      moreAction,
      readableDate,
      readableDateTime,
      readableDuration,
      isOverdue,
      activityStatusClass,
      fileName,
      fileExtension,
      human,
    inspectorRoot,
    mode,
    onKeydown,
  }
  provide(GRAPH_INSPECTOR_CONTEXT, context)

  return {
    context,
    exposed: { requestClose, requestBack, commitThen, focusEntry, updateDraft },
  }
}
