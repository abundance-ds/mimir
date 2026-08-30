import {
  defaultRelationFor,
  labelColor,
  localDateTime,
  normalizedLabels,
  relationTarget,
  sameValues,
  splitValues,
  utcDateTime,
} from './graphInspectorModel.js'

export function hydrateInspectorDraft(draft, node) {
  draft.title = node.title || ''
  draft.summary = node.summary || ''
  draft.body = node.body || ''
  draft.tags = (node.tags || []).join(', ')
  draft.status = node.properties?.status || 'backlog'
  draft.priority = node.properties?.priority || 'normal'
  draft.dueDate = node.properties?.dueDate || ''
  draft.remindAt = localDateTime(node.properties?.remindAt)
  draft.projectId = relationTarget(node, 'part_of') || node.properties?.legacyProject || ''
  draft.scopeId = node.provenance?.scopeId || node.scopeId || ''
  draft.attendeeIds = (node.relations || [])
    .filter(edge => edge.relation === 'attended_by')
    .map(edge => edge.target)
  draft.assigneeId = relationTarget(node, 'assigned_to') || node.properties?.legacyAssignee || ''
  draft.waitingFor = node.properties?.waitingFor || ''
  draft.snoozeUntil = node.properties?.snoozeUntil || ''
  draft.labels = (node.properties?.labels || [])
    .map(label => typeof label === 'string' ? label : label.name)
    .filter(Boolean)
    .join(', ')
  draft.deliverables = (node.properties?.deliverables || [])
    .map(item => (
      typeof item === 'string'
        ? item
        : `${item.path}${item.label ? ` | ${item.label}` : ''}`
    ))
    .join('\n')
  draft.projectType = node.properties?.projectType || ''
  draft.projectStatus = node.properties?.projectStatus || (
    node.kind === 'project' ? node.properties?.status || 'planned' : 'planned'
  )
  draft.companyRoles = (node.properties?.roles || []).join(', ')
  draft.entityStatus = node.properties?.status || 'active'
  draft.teamMember = Boolean(node.properties?.teamMember)
  draft.relations = (node.relations || []).map(edge => ({ ...edge }))

  return defaultRelationFor(node.kind)
}

export function buildInspectorSave({ node, nodes, draft, tags }) {
  const setProperties = {}
  const removeProperties = []
  if (node.kind === 'issue') {
    setProperties.status = draft.status
    setProperties.priority = draft.priority
    for (const [key, value] of [
      ['dueDate', draft.dueDate],
      ['remindAt', utcDateTime(draft.remindAt)],
      ['waitingFor', draft.waitingFor.trim()],
      ['snoozeUntil', draft.snoozeUntil],
      ['legacyProject', draft.projectId.trim()],
      ['legacyAssignee', draft.assigneeId.trim()],
    ]) {
      if (value) setProperties[key] = value
      else removeProperties.push(key)
    }
    const existingLabels = normalizedLabels(node.properties?.labels)
    const existingNames = existingLabels.map(label => label.name)
    if (!sameValues(tags, existingNames)) {
      const labelsByName = new Map(
        existingLabels.map(label => [label.name.toLowerCase(), label]),
      )
      setProperties.labels = tags.map(name => ({
        name,
        color: labelsByName.get(name.toLowerCase())?.color || labelColor(name),
      }))
    }
    setProperties.deliverables = draft.deliverables
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean)
      .map(line => {
        const [path, ...label] = line.split('|').map(value => value.trim())
        return { path, ...(label.join(' | ') ? { label: label.join(' | ') } : {}) }
      })
  } else if (node.kind === 'project') {
    if (draft.projectType) setProperties.projectType = draft.projectType
    else removeProperties.push('projectType')
    setProperties.projectStatus = draft.projectStatus
    removeProperties.push('status')
  } else if (node.kind === 'company') {
    setProperties.roles = splitValues(draft.companyRoles)
    setProperties.status = draft.entityStatus
  } else if (node.kind === 'person') {
    setProperties.status = draft.entityStatus
    setProperties.teamMember = draft.teamMember
  }

  const relations = buildRelations(node, nodes, draft)
  return {
    payload: {
      id: node.id,
      expectedRevision: node.provenance?.sourceRevision,
      title: draft.title.trim(),
      summary: node.kind === 'issue' ? undefined : draft.summary.trim(),
      body: draft.body,
      tags,
      relations,
      setProperties,
      removeProperties,
    },
    targetScopeId: node.kind === 'meeting' ? draft.scopeId : '',
  }
}

function buildRelations(node, nodes, draft) {
  if (node.kind === 'issue') {
    return [
      ...draft.relations.filter(edge => !['part_of', 'assigned_to'].includes(edge.relation)),
      ...entityRelation(node, nodes, 'part_of', draft.projectId, 'project'),
      ...entityRelation(node, nodes, 'assigned_to', draft.assigneeId, 'person'),
    ]
  }
  if (node.kind === 'meeting') {
    return [
      ...draft.relations.filter(edge => !['part_of', 'attended_by'].includes(edge.relation)),
      ...entityRelation(node, nodes, 'part_of', draft.projectId, 'project'),
      ...draft.attendeeIds.flatMap(id => (
        entityRelation(node, nodes, 'attended_by', id, 'person')
      )),
    ]
  }
  return draft.relations.map(edge => ({ ...edge }))
}

// A legacy label must stay a label until it resolves to a graph object.
function entityRelation(node, nodes, relation, value, expectedKind) {
  const target = String(value || '').trim()
  if (!target) return []
  const resolves = nodes.some(candidate => (
    candidate.id === target && candidate.kind === expectedKind
  ))
  const stored = (node.relations || []).some(edge => (
    edge.relation === relation && edge.target === target
  ))
  return resolves || stored ? [{ relation, target, legacy: false }] : []
}
