import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { projectIssues } from '../../../services/businessGraphProject.js'
import { graphLinkTargets } from '../../../services/businessGraph.js'
import { projectAttention } from './projectAttention.js'
import { graphLinkId } from '../../../editor/codemirror/graphLinkSyntax.js'

export function useProjectAttention(props) {
  const issues = ref([]), owners = ref(new Map()), loading = ref(false), loadError = ref(''), ownerError = ref(''), now = ref(new Date())
  const orderedIds = ref([])
  let generation = 0, ownerGeneration = 0, clock
  const attention = computed(() => projectAttention(issues.value, now.value))
  const rows = computed(() => {
    const byId = new Map(attention.value.map(issue => [issue.id, issue]))
    const retained = orderedIds.value.filter(id => byId.has(id))
    const ids = [...retained, ...attention.value.filter(issue => !retained.includes(issue.id)).map(issue => issue.id)]
    return ids.slice(0, 5).map(id => byId.get(id))
  })
  watch(rows, value => {
    const ids = value.map(issue => issue.id)
    if (ids.join('\0') !== orderedIds.value.join('\0')) orderedIds.value = ids
  })
  async function load() {
    const request = ++generation
    const current = () => request === generation
    loading.value = true
    loadError.value = ''
    ownerError.value = ''
    now.value = new Date()
    try {
      const result = await projectIssues(props.project.id, props.scopeIds, current)
      if (!current() || !result) return
      issues.value = result.items
    } catch (cause) {
      if (current()) loadError.value = cause instanceof Error ? cause.message : 'Project work could not be loaded.'
    } finally { if (current()) loading.value = false }
  }
  watch(() => [props.project.id, props.graphRevision, props.scopeIds.join('\0')], (next, previous) => {
    if (!previous || next[0] !== previous[0] || next[2] !== previous[2]) {
      issues.value = []; owners.value = new Map(); orderedIds.value = []
    }
    void load()
  }, { immediate: true })
  // Resolve only the visible owners, including tasks that become due or leave
  // snooze while this page stays open. Cancel lookups on scope/Project changes.
  watch(() => [rows.value.map(issue => issue.assigneeId || '').join('\0'), props.project.id, props.scopeIds.join('\0'), loading.value], async () => {
    const request = ++ownerGeneration
    if (loading.value) return
    const assignees = [...new Set(rows.value.map(issue => issue.assigneeId).filter(Boolean))]
    const ids = assignees.filter(id => graphLinkId(`mimir://graph/${id}`))
    const names = new Map(assignees.filter(id => !ids.includes(id)).map(name => [name, name]))
    try {
      const targets = ids.length ? await graphLinkTargets(ids, { scopeIds: props.scopeIds }) : []
      if (request !== ownerGeneration) return
      for (const owner of targets || []) if (owner.status === 'resolved') names.set(owner.id, owner.title)
      owners.value = names
      ownerError.value = ''
    } catch {
      if (request === ownerGeneration) ownerError.value = 'Task owners could not be loaded.'
    }
  })
  const updateClock = () => { now.value = new Date() }
  onMounted(() => {
    clock = setInterval(updateClock, 60_000)
    window.addEventListener('focus', updateClock)
  })
  onUnmounted(() => { generation++; ownerGeneration++; clearInterval(clock); window.removeEventListener('focus', updateClock) })
  return { rows, total: computed(() => attention.value.length), owners, loading, error: computed(() => loadError.value || ownerError.value), load }
}
