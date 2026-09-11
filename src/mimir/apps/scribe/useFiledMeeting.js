import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { listenForGraphChanges } from '../../../services/businessGraph.js'
import { loadFiledMeeting, resolveMeetingSummary, summaryHash } from '../../../services/filedMeeting.js'

export function useFiledMeeting({ meeting, ready }) {
  const node = ref(null)
  const loading = ref(false)
  const saving = ref(false)
  const error = ref('')
  const draftHash = ref('')
  let generation = 0
  let unlisten = null
  let disposed = false

  const context = computed(() => node.value ? {
    projectResolved: true,
    projectId: node.value.relations?.find(edge => edge.relation === 'part_of')?.target || null,
    peopleIds: (node.value.relations || []).filter(edge => edge.relation === 'attended_by').map(edge => edge.target),
    scopeId: node.value.provenance?.scopeId || node.value.scopeId || null,
  } : null)
  const hasDraft = computed(() => {
    if (!node.value || !meeting.value?.summary || !draftHash.value) return false
    const filedHash = node.value.properties?.sourceSummaryHash
    return filedHash ? filedHash !== draftHash.value : node.value.body !== meeting.value.summary
  })

  async function reload() {
    const current = meeting.value
    const run = ++generation
    if (!ready() || !current?.graphNodeId) { loading.value = false; return }
    loading.value = !node.value
    error.value = ''
    try {
      const loaded = await loadFiledMeeting(current)
      if (run === generation && !disposed) node.value = loaded
    } catch (cause) {
      if (run === generation && !disposed) error.value = String(cause?.message || cause)
    } finally {
      if (run === generation && !disposed) loading.value = false
    }
  }

  async function resolve(summary, replace) {
    if (!node.value || saving.value) return false
    const id = node.value.id
    generation++
    saving.value = true
    error.value = ''
    try {
      const updated = await resolveMeetingSummary(node.value, summary, replace)
      if (node.value?.id === id) node.value = updated
      return true
    } catch (cause) {
      if (node.value?.id === id) error.value = String(cause?.message || cause)
      return false
    } finally {
      saving.value = false
    }
  }

  watch(() => meeting.value?.graphNodeId, () => {
    node.value = null
    error.value = ''
    void reload()
  })
  watch(ready, () => { void reload() })
  watch([() => meeting.value?.id, () => meeting.value?.summary], async ([id, summary], previous, onCleanup) => {
    let current = true
    onCleanup(() => { current = false })
    if (id !== previous?.[0]) draftHash.value = ''
    const hash = await summaryHash(summary)
    if (current) draftHash.value = hash
  }, { immediate: true })
  onMounted(async () => {
    try {
      unlisten = await listenForGraphChanges(() => { if (!saving.value) void reload() })
      if (disposed) unlisten()
      else await reload()
    } catch (cause) {
      if (!disposed) error.value = String(cause?.message || cause)
    }
  })
  onUnmounted(() => { disposed = true; generation++; unlisten?.() })

  return { node, context, loading, saving, error, hasDraft, reload, resolve }
}
