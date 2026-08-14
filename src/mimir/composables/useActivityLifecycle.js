import { ref, watch } from 'vue'
import { runRoutineNow } from '../../services/routines.js'

export function useActivityLifecycle({
  activities,
  activityRuntime,
  launchers,
  workbench,
  workspacePath,
  diagnostic,
  coreActivityIds,
  isStableActivity = () => false,
  getSidebarActivities,
  openCoreActivity,
  selectActivity,
  openActivityRecord,
}) {
  const closingActivityIds = ref(new Set())
  const finalizingClosures = new Set()

  const stopStatusWatch = watch(
    () => activities.records.map(activity => `${activity.id}:${activity.status}`).join('|'),
    () => {
      for (const id of closingActivityIds.value) {
        const activity = activities.byId(id)
        if (activity && !isLiveActivity(activity)) void finalizeClosedActivity(activity)
      }
    },
  )

  async function stopActivity(id) {
    try {
      await activityRuntime.stop(id)
    } catch (cause) {
      diagnostic.value = `Activity could not be stopped: ${errorMessage(cause)}`
    }
  }

  async function renameActivity({ id, title }) {
    try {
      await activityRuntime.rename(id, title)
    } catch (cause) {
      diagnostic.value = `Activity could not be renamed: ${errorMessage(cause)}`
    }
  }

  async function archiveActivity(id) {
    try {
      await activityRuntime.setArchived(id, true)
      if (workbench.activeActivityId === id) openCoreActivity('files')
    } catch (cause) {
      diagnostic.value = `Activity could not be archived: ${errorMessage(cause)}`
    }
  }

  async function archiveActivities(ids) {
    for (const id of ids) await archiveActivity(id)
  }

  async function clearActivities(ids) {
    for (const id of ids) await clearActivity(id)
  }

  async function closeActivities(ids) {
    for (const id of ids) await closeActivity(id)
  }

  async function restoreActivity(id) {
    const activity = activities.byId(id)
    if (!activity) {
      diagnostic.value = `Activity could not be resumed: '${id}' is no longer available.`
      return
    }

    const preset = continuationPreset(activity, launchers)
    if (preset) {
      try {
        // Native respawn replaces only ended PTY sessions and clears
        // archivedAt as part of the same durable record update. If resolution
        // or spawning fails, the original History entry remains archived.
        const resumed = await activityRuntime.resumePreset(preset, {
          ...activity,
          workspacePath: activity.workspacePath || workspacePath.value,
        })
        unmarkClosing(id)
        selectActivity(resumed?.id || id)
      } catch (cause) {
        diagnostic.value = `${activity.title || 'Activity'} could not resume: ${errorMessage(cause)}`
      }
      return
    }

    try {
      const restored = await activityRuntime.setArchived(id, false)
      unmarkClosing(id)
      selectActivity(restored?.id || id)
      if (
        ['agent', 'routine'].includes(activity.kind)
        && !activity.source?.appId
        && activity.host?.type === 'pty'
        && activity.host?.resumeStrategy
        && activity.host.resumeStrategy !== 'none'
      ) {
        diagnostic.value = activity.session?.cliSessionId
          ? 'Transcript restored. Resume is unavailable because its launcher preset is missing.'
          : 'Transcript restored. Resume is unavailable because this legacy Activity has no exact provider session id; Run again starts a new session.'
      }
    } catch (cause) {
      diagnostic.value = `Activity could not be restored: ${errorMessage(cause)}`
    }
  }

  async function clearActivity(id) {
    try {
      const wasActive = workbench.activeActivityId === id
      await activityRuntime.clear(id)
      if (wasActive) openCoreActivity('files')
    } catch (cause) {
      diagnostic.value = `Activity could not be cleared: ${errorMessage(cause)}`
    }
  }

  async function closeActivity(id = workbench.activeActivityId) {
    const activity = activities.byId(id)
    if (!activity || coreActivityIds.has(activity.id) || isStableActivity(activity)) {
      if (workbench.paneLayout.activity.state === 'expanded') {
        workbench.setPaneState('activity', 'rail')
      }
      return false
    }
    if (closingActivityIds.value.has(activity.id)) return true

    const currentOrder = getSidebarActivities().map(item => item.id)
    closingActivityIds.value = new Set([...closingActivityIds.value, activity.id])
    moveAfterClosing(activity.id, currentOrder)

    if (!isLiveActivity(activity)) {
      await finalizeClosedActivity(activity)
      return true
    }

    try {
      await activityRuntime.close(activity.id)
      return true
    } catch (cause) {
      unmarkClosing(activity.id)
      diagnostic.value = `Activity could not be closed: ${errorMessage(cause)}`
      return false
    }
  }

  function moveAfterClosing(id, currentOrder) {
    if (workbench.activeActivityId !== id) return
    const index = currentOrder.indexOf(id)
    const remaining = currentOrder.filter(activityId => activityId !== id)
    const nextId = remaining[Math.min(Math.max(index, 0), remaining.length - 1)]
    if (nextId) {
      selectActivity(nextId)
      return
    }
    workbench.openActivity('files')
    workbench.setPaneState('activity', 'rail')
  }

  async function finalizeClosedActivity(activity) {
    if (finalizingClosures.has(activity.id)) return
    finalizingClosures.add(activity.id)
    try {
      if (isArchivableActivity(activity)) {
        await activityRuntime.setArchived(activity.id, true)
      } else {
        await activityRuntime.clear(activity.id)
      }
      unmarkClosing(activity.id)
    } catch (cause) {
      unmarkClosing(activity.id)
      diagnostic.value = `Activity could not be closed: ${errorMessage(cause)}`
    } finally {
      finalizingClosures.delete(activity.id)
    }
  }

  function unmarkClosing(id) {
    const next = new Set(closingActivityIds.value)
    next.delete(id)
    closingActivityIds.value = next
  }

  async function restartActivity(payload) {
    const activity = payload?.activity
    if (activity?.kind === 'routine' && activity.source?.routineId) {
      try {
        const result = await runRoutineNow(activity.source.routineId)
        openActivityRecord(result.activity)
      } catch (cause) {
        diagnostic.value = `${activity.title || 'Routine'} could not restart: ${errorMessage(cause)}`
      }
      return
    }

    const presetId = activity?.source?.presetId || activity?.source?.launcherId
    const preset = presetId ? launchers.byId(presetId) : null
    try {
      if (activity?.kind === 'agent' && !activity.source?.appId) {
        if (!preset) throw new Error('its launcher preset is missing')
        if (activity.host?.resumeStrategy && activity.host?.type === 'pty') {
          // Resume continues the same Activity row; only agents without a
          // continuation strategy start over as a fresh Activity.
          await activityRuntime.resumePreset(preset, {
            ...activity,
            workspacePath: activity.workspacePath || workspacePath.value,
          })
          return
        }
        await activityRuntime.launchPreset(
          preset,
          activity.workspacePath || workspacePath.value,
          {
            kind: activity.kind,
            title: activity.title,
          },
        )
        return
      }
      if (activity?.host?.type !== 'pty' || !activity.launch?.command) {
        throw new Error('its original command is unavailable')
      }
      await activityRuntime.launchCommand({
        title: activity.title,
        command: activity.launch.command,
        args: activity.launch.args || [],
        cwd: activity.launch.cwd || activity.workspacePath || workspacePath.value,
        env: activity.launch.env || {},
        kind: activity.kind || 'terminal',
        retention: activity.retention || 'durable',
        source: activity.source || {},
        workspacePath: activity.workspacePath || workspacePath.value,
      })
    } catch (cause) {
      diagnostic.value = `${activity?.title || 'Activity'} could not restart: ${errorMessage(cause)}`
    }
  }

  function dispose() {
    stopStatusWatch()
  }

  return {
    archiveActivities,
    archiveActivity,
    clearActivities,
    clearActivity,
    closeActivities,
    closeActivity,
    closingActivityIds,
    dispose,
    renameActivity,
    restartActivity,
    restoreActivity,
    stopActivity,
  }
}

export function isLiveActivity(activity) {
  return activity?.host?.type === 'pty'
    && ['ready', 'starting', 'working', 'needs-input', 'idle'].includes(activity?.status)
}

export function isArchivableActivity(activity) {
  return activity?.retention === 'durable'
    || (activity?.kind === 'terminal' && activity?.host?.type === 'pty')
}

function continuationPreset(activity, launchers) {
  if (
    !['agent', 'routine'].includes(activity?.kind)
    || activity?.source?.appId
    || activity?.host?.type !== 'pty'
    || !activity?.host?.resumeStrategy
    || activity.host.resumeStrategy === 'none'
    || !activity.session?.cliSessionId
  ) {
    return null
  }
  const presetId = activity.source?.presetId || activity.source?.launcherId
  return presetId ? launchers.byId(presetId) : null
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error || 'Unknown failure')
}
