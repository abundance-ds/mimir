import {
  createGraphNode,
  openBusinessGraph,
  queryGraph,
} from './businessGraph.js'

export async function loadMeetingGraphCatalog(workspacePath) {
  const status = await openBusinessGraph(workspacePath)
  const scopes = Array.isArray(status?.scopes) ? status.scopes : []
  const page = await queryGraph({
    scopeIds: scopes.map(scope => scope.id),
    kinds: ['project', 'person', 'company'],
    limit: 500,
  })
  const nodes = Array.isArray(page?.items) ? page.items : []
  return {
    scopes,
    projects: nodes.filter(node => node.kind === 'project'),
    people: nodes.filter(node => node.kind === 'person'),
    companies: nodes.filter(node => node.kind === 'company'),
  }
}

export async function createMeetingGraphEntity({ kind, title, scopeId, companyId = '' }) {
  const normalizedKind = String(kind || '').trim()
  const normalizedTitle = String(title || '').trim()
  if (!['project', 'person'].includes(normalizedKind)) {
    throw new Error('Meeting context can create only a Project or Person.')
  }
  if (!normalizedTitle) throw new Error(`Enter a ${normalizedKind} name.`)
  return createGraphNode({
    kind: normalizedKind,
    scopeId: String(scopeId || '').trim(),
    title: normalizedTitle,
    summary: '',
    body: '',
    tags: [],
    relations: normalizedKind === 'person' && String(companyId || '').trim()
      ? [{ relation: 'works_at', target: String(companyId).trim(), legacy: false }]
      : [],
    properties: normalizedKind === 'project'
      ? { projectStatus: 'planned' }
      : { status: 'active', teamMember: false },
  })
}

export function preferredMeetingGraphScope(scopes = []) {
  return scopes.find(scope => scope.kind === 'team')?.id
    || scopes.find(scope => scope.kind === 'project')?.id
    || scopes.find(scope => scope.kind === 'private')?.id
    || ''
}
