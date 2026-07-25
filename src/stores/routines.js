import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import {
  createRoutineDefinition,
  duplicateRoutineDefinition,
  listenToRoutineEvents,
  loadRoutineCatalog,
  revealRoutineDefinition,
  reloadRoutineCatalog,
  runRoutineNow,
  trashRoutineDefinition,
  updateRoutineDefinition,
} from '../services/routines.js'
import { stopActivity } from '../services/activities.js'

export const useRoutinesStore = defineStore('routines', () => {
  const directory = ref('')
  const statePath = ref('')
  const revision = ref(0)
  const routines = ref([])
  const diagnostics = ref([])
  const lastTick = ref(null)
  const selectedId = ref('')
  const loading = ref(false)
  const reloading = ref(false)
  const loaded = ref(false)
  const error = ref('')
  const pendingRuns = ref({})
  const pendingChanges = ref({})
  const pendingStops = ref({})
  const runErrors = ref({})
  let unlisten = null
  let initializing = null

  const selectedRoutine = computed(() => (
    routines.value.find((routine) => routine.id === selectedId.value)
      || routines.value[0]
      || null
  ))
  const runningCount = computed(() => (
    routines.value.reduce((count, routine) => count + routine.runningActivityIds.length, 0)
  ))
  const enabledCount = computed(() => (
    routines.value.filter((routine) => routine.enabled && routine.available).length
  ))

  async function initialize() {
    if (loaded.value) return
    if (initializing) return initializing
    initializing = (async () => {
      error.value = ''
      try {
        if (!unlisten) unlisten = await listenToRoutineEvents(onChanged)
        await load()
      } catch (cause) {
        error.value = message(cause)
        throw cause
      } finally {
        initializing = null
      }
    })()
    return initializing
  }

  async function load() {
    if (loading.value) return
    loading.value = true
    error.value = ''
    try {
      applyCatalog(await loadRoutineCatalog())
      loaded.value = true
    } catch (cause) {
      error.value = message(cause)
      throw cause
    } finally {
      loading.value = false
    }
  }

  async function reload() {
    if (reloading.value) return
    reloading.value = true
    error.value = ''
    try {
      applyCatalog(await reloadRoutineCatalog())
      loaded.value = true
    } catch (cause) {
      error.value = message(cause)
      throw cause
    } finally {
      reloading.value = false
    }
  }

  async function runNow(id) {
    const routine = routines.value.find((entry) => entry.id === id)
    if (!routine) throw new Error(`Routine '${id}' is no longer available.`)
    if (!routine.available) {
      throw new Error(routine.diagnostic || `Launcher preset '${routine.preset}' is unavailable.`)
    }
    if (pendingRuns.value[id]) return null

    pendingRuns.value = { ...pendingRuns.value, [id]: true }
    runErrors.value = withoutKey(runErrors.value, id)
    try {
      const result = await runRoutineNow(id)
      if (result.activity?.id) {
        replaceRoutine(id, {
          ...routine,
          runningActivityIds: [...new Set([...routine.runningActivityIds, result.activity.id])],
          lastError: null,
        })
      }
      return result
    } catch (cause) {
      runErrors.value = { ...runErrors.value, [id]: message(cause) }
      throw cause
    } finally {
      pendingRuns.value = withoutKey(pendingRuns.value, id)
    }
  }

  async function create(definition) {
    const id = String(definition?.id || '').trim()
    return change(`create:${id}`, async () => {
      applyCatalog(await createRoutineDefinition(definition))
      selectedId.value = id
      return selectedRoutine.value
    })
  }

  async function update(id, definition) {
    const routine = requireRoutine(id)
    return change(id, async () => {
      applyCatalog(await updateRoutineDefinition(id, routine.sourceRevision, definition))
      selectedId.value = id
      return selectedRoutine.value
    })
  }

  async function duplicate(id, newId, title) {
    const routine = requireRoutine(id)
    return change(id, async () => {
      applyCatalog(await duplicateRoutineDefinition(
        id,
        routine.sourceRevision,
        newId,
        title,
      ))
      selectedId.value = newId
      return selectedRoutine.value
    })
  }

  async function trash(id) {
    const routine = requireRoutine(id)
    return change(id, async () => {
      applyCatalog(await trashRoutineDefinition(id, routine.sourceRevision))
      return routine
    })
  }

  async function stopRuns(id) {
    const routine = requireRoutine(id)
    if (!routine.runningActivityIds.length || pendingStops.value[id]) return 0
    pendingStops.value = { ...pendingStops.value, [id]: true }
    try {
      const ids = [...routine.runningActivityIds]
      await Promise.all(ids.map((activityId) => stopActivity(activityId)))
      const current = requireRoutine(id)
      replaceRoutine(id, {
        ...current,
        runningActivityIds: current.runningActivityIds.filter((activityId) => !ids.includes(activityId)),
      })
      return ids.length
    } finally {
      pendingStops.value = withoutKey(pendingStops.value, id)
    }
  }

  function reveal(id = null) {
    if (id != null) requireRoutine(id)
    return revealRoutineDefinition(id)
  }

  function select(id) {
    if (routines.value.some((routine) => routine.id === id)) selectedId.value = id
  }

  function moveSelection(delta) {
    if (!routines.value.length) return
    const current = Math.max(
      0,
      routines.value.findIndex((routine) => routine.id === selectedRoutine.value?.id),
    )
    const index = (current + delta + routines.value.length) % routines.value.length
    selectedId.value = routines.value[index].id
  }

  function selectEdge(edge) {
    const routine = edge === 'end' ? routines.value.at(-1) : routines.value[0]
    if (routine) selectedId.value = routine.id
  }

  function applyCatalog(catalog) {
    directory.value = catalog.directory
    statePath.value = catalog.statePath
    revision.value = catalog.revision
    routines.value = catalog.routines
    diagnostics.value = catalog.diagnostics
    lastTick.value = catalog.lastTick
    runErrors.value = Object.fromEntries(
      Object.entries(runErrors.value).filter(([id]) => routines.value.some((routine) => routine.id === id)),
    )
    if (!routines.value.some((routine) => routine.id === selectedId.value)) {
      selectedId.value = routines.value[0]?.id || ''
    }
  }

  function onChanged(event) {
    if (event?.catalog) applyCatalog(event.catalog)
    if (event?.tick) lastTick.value = event.tick
    loaded.value = true
    error.value = ''
  }

  function replaceRoutine(id, routine) {
    routines.value = routines.value.map((entry) => entry.id === id ? routine : entry)
  }

  function requireRoutine(id) {
    const routine = routines.value.find((entry) => entry.id === id)
    if (!routine) throw new Error(`Routine '${id}' is no longer available.`)
    return routine
  }

  async function change(key, operation) {
    if (pendingChanges.value[key]) return null
    pendingChanges.value = { ...pendingChanges.value, [key]: true }
    error.value = ''
    try {
      return await operation()
    } catch (cause) {
      error.value = message(cause)
      throw cause
    } finally {
      pendingChanges.value = withoutKey(pendingChanges.value, key)
    }
  }

  function dispose() {
    unlisten?.()
    unlisten = null
    initializing = null
    loaded.value = false
  }

  return {
    directory,
    statePath,
    revision,
    routines,
    diagnostics,
    lastTick,
    selectedId,
    loading,
    reloading,
    loaded,
    error,
    pendingRuns,
    pendingChanges,
    pendingStops,
    runErrors,
    selectedRoutine,
    runningCount,
    enabledCount,
    initialize,
    load,
    reload,
    runNow,
    create,
    update,
    duplicate,
    trash,
    stopRuns,
    reveal,
    select,
    moveSelection,
    selectEdge,
    applyCatalog,
    dispose,
  }
})

function withoutKey(record, key) {
  const next = { ...record }
  delete next[key]
  return next
}

function message(error) {
  return error instanceof Error ? error.message : String(error || 'Routine runtime failed.')
}
