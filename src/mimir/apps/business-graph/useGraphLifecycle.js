import { onUnmounted, watch } from 'vue'
import { graphErrorMessage } from './graphErrors.js'

export function useGraphLifecycle({ graph, meetings, active, workspacePath, diagnostic }) {
  let startInFlight = false
  let queuedStart = null
  let disposed = false

  function mountsWorkspace(workspace) {
    return Boolean(graph.status)
      && graph.projectRoot === workspace
  }

  function startGraph(workspace) {
    if (disposed) return
    if (startInFlight) {
      queuedStart = workspace
      return
    }
    if (mountsWorkspace(workspace)) return
    startInFlight = true
    void graph.start(workspace)
      .catch(cause => {
        if (!disposed) diagnostic(graphErrorMessage(cause))
      })
      .finally(() => {
        startInFlight = false
        if (disposed) {
          queuedStart = null
          graph.stop()
          return
        }
        const queued = queuedStart
        queuedStart = null
        if (queued) startGraph(queued)
      })
  }

  watch(
    [active, workspacePath],
    ([isActive, workspace]) => {
      const projectRoot = String(workspace || '').trim()
      if (!isActive) return
      void meetings.initialize().catch(cause => diagnostic(graphErrorMessage(cause)))
      if (!projectRoot || mountsWorkspace(projectRoot)) return
      startGraph(projectRoot)
    },
    { immediate: true },
  )

  onUnmounted(() => {
    disposed = true
    queuedStart = null
    graph.stop()
  })
}
