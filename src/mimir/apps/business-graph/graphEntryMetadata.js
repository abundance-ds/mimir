export const NO_PROJECT = '__unassigned__'
const labels = { issue: 'Task', person: 'Person', timesheet: 'Time sheet' }
export function graphKindLabel(kind) {
  return labels[kind] || String(kind || 'Entry').replaceAll('-', ' ').replace(/^./, c => c.toUpperCase())
}
export function entryProjects(node, projects) {
  if (node.kind === 'project') return [node]
  const targets = (node.relations || []).filter(edge => edge.relation === 'part_of').map(edge => edge.target)
  if (!targets.length && node.projectId) targets.push(node.projectId)
  return projects.filter(project => targets.includes(project.id))
    .sort((a, b) => a.title.localeCompare(b.title))
}
