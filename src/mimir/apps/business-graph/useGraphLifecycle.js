import { onUnmounted, watch } from 'vue'
import { graphErrorMessage } from './graphErrors.js'

export function useGraphLifecycle({ graph, meetings, settings, active, workspacePath, diagnostic }) {
  let startInFlight = false
  let queuedStart = null
  let disposed = false

  function mountsRoots(workspace, teamRoot) {
    return Boolean(graph.status)
      && graph.projectRoot === workspace
      && graph.teamRoot === teamRoot
  }

  function startGraph(workspace, teamRoot) {
    if (disposed) return
    if (startInFlight) {
      queuedStart = { workspace, teamRoot }
      return
    }
    if (mountsRoots(workspace, teamRoot)) return
    startInFlight = true
    void graph.start(workspace, teamRoot)
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
        if (queued) startGraph(queued.workspace, queued.teamRoot)
      })
  }

  watch(
    [active, workspacePath, () => settings.mimirTeamFolder],
    ([isActive, workspace, teamFolder]) => {
      const projectRoot = String(workspace || '').trim()
      const teamRoot = String(teamFolder || '').trim()
      if (!isActive) return
      void meetings.initialize().catch(cause => diagnostic(graphErrorMessage(cause)))
      if (!projectRoot || mountsRoots(projectRoot, teamRoot)) return
      startGraph(projectRoot, teamRoot)
    },
    { immediate: true },
  )

  onUnmounted(() => {
    disposed = true
    queuedStart = null
    graph.stop()
  })
}
