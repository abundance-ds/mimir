import { computed, ref } from 'vue'
import { canMoveActivityWorkspace } from '../activityWorkspace.js'

export function useActivityWorkspaceMove({ activities, activityRuntime, launchers, openWorkspace, selectActivity, reconcileWorkspaces }) {
  const activityId = ref('')
  const activity = computed(() => activities.byId(activityId.value) || null)
  const busy = ref(false)
  const error = ref('')

  function show(id) {
    if (busy.value || !canMoveActivityWorkspace(activities.byId(id))) return
    activityId.value = id
    error.value = ''
    void reconcileWorkspaces()
  }
  function cancel() {
    if (!busy.value) activityId.value = ''
  }
  async function move(path) {
    if (busy.value || !activity.value) return
    const original = activity.value
    busy.value = true
    error.value = ''
    try {
      const presetId = original.source?.presetId || original.source?.launcherId
      const preset = launchers.byId(presetId)
      if (!preset) throw new Error('The launcher preset is no longer available.')
      const moved = await activityRuntime.moveToWorkspace(preset, original.id, path, {
        beforeStop: () => openWorkspace(path, { activate: false }),
      })
      if (!moved) return
      activityId.value = ''
      selectActivity(moved.id)
    } catch (cause) {
      error.value = `Session could not be moved: ${cause instanceof Error ? cause.message : String(cause)}`
    } finally {
      busy.value = false
    }
  }
  return { activity, busy, error, show, cancel, move }
}
