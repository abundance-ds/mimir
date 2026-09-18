import { queryGraph } from './businessGraph.js'

// Project views must not inherit the table's filters or its first-page limit.
export async function projectIssues(projectId, scopeIds, current = () => true) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const items = []
    let revision = null
    while (current()) {
      const result = await queryGraph({ projectIds: [projectId], kinds: ['issue'], scopeIds,
        order: { sortBy: 'title', direction: 'asc' }, offset: items.length, limit: 500 })
      if (!current()) return null
      if (!Array.isArray(result?.items)) throw new Error('Project work could not be loaded.')
      if (revision !== null && result.graphRevision !== revision) break
      revision = result.graphRevision ?? null
      items.push(...result.items)
      if (result.items.length < 500 || items.length >= result.total) {
        return { items: [...new Map(items.filter(item => item.kind === 'issue' && (item.projectId === projectId
          || item.relations?.some(edge => edge.relation === 'part_of' && edge.target === projectId))).map(item => [item.id, item])).values()], revision }
      }
    }
    if (!current()) return null
  }
  throw new Error('Project work changed while loading. Try again.')
}
