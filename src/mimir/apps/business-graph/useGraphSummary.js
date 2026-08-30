import { computed, onUnmounted, ref } from 'vue'
import { buildGraphSummaryPrompt } from './graphSummaryContext.js'
import { graphErrorMessage } from './graphErrors.js'

export function useGraphSummary({ graph, launchers, settings, diagnostic, startWork }) {
  const summaryOpen = ref(false)
  const summaryPreparing = ref(false)
  const nowSeenAt = ref(settings.businessGraphNowSeenAt || '')
  let launchGeneration = 0

  const summaryAgents = computed(() => launchers.availablePresets.filter(
    preset => preset.kind === 'agent',
  ))

  function markNowSeen(timestamp) {
    nowSeenAt.value = timestamp
    settings.set('businessGraphNowSeenAt', timestamp)
  }

  function loadNowPage(offset) {
    void graph.loadEventPage(offset).catch(cause => diagnostic(graphErrorMessage(cause)))
  }

  function closeSummary() {
    launchGeneration += 1
    summaryOpen.value = false
    summaryPreparing.value = false
  }

  async function launchSummary({ presetId, since, instructions }) {
    if (summaryPreparing.value) return
    const sinceTimestamp = startOfLocalDate(since)
    if (!sinceTimestamp) {
      diagnostic('Choose a valid start date for the change summary.')
      return
    }
    const scopeIds = [...graph.activeScopeIds]
    const generation = ++launchGeneration
    summaryPreparing.value = true
    try {
      const page = await graph.fetchEventsSince(sinceTimestamp)
      if (generation !== launchGeneration) return
      const history = buildGraphSummaryPrompt({
        events: page?.items,
        since,
        total: page?.total,
        instructions,
      })
      if (!history.includedCount) {
        throw new Error('No change events are available in the selected scopes.')
      }
      startWork({
        presetId,
        sourceType: 'business-graph-summary',
        nodeId: 'changes',
        nodeKind: 'history',
        title: `Changes since ${shortDate(since)}`,
        scopeIds,
        graphRevision: graph.status?.graphRevision || 0,
        graphEventSince: sinceTimestamp,
        graphEventCount: history.includedCount,
        graphContextShortened: history.shortened,
        graphContextBytes: history.bytes,
        prompt: history.prompt,
      })
      summaryOpen.value = false
    } catch (cause) {
      if (generation === launchGeneration) {
        diagnostic(`Could not prepare change summary: ${graphErrorMessage(cause)}`)
      }
    } finally {
      if (generation === launchGeneration) summaryPreparing.value = false
    }
  }

  onUnmounted(() => {
    launchGeneration += 1
    summaryPreparing.value = false
  })

  return {
    closeSummary,
    launchSummary,
    loadNowPage,
    markNowSeen,
    nowSeenAt,
    summaryAgents,
    summaryOpen,
    summaryPreparing,
  }
}

function startOfLocalDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''))
  if (!match) return ''
  const date = new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    0,
    0,
    0,
    0,
  )
  return Number.isNaN(date.getTime()) ? '' : date.toISOString()
}

function shortDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''))
  if (!match) return String(value || '')
  return new Intl.DateTimeFormat(undefined, {
    day: 'numeric',
    month: 'short',
  }).format(new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12))
}
