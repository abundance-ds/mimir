<template>
  <div class="app-view">
    <AppSetup
      v-if="session.appStatus === 'setup'"
      :app="app"
      :session="session"
      @start="onStart"
      @back="onBack"
    />
    <AppCustom
      v-else-if="isCustomUI"
      :session="session"
      :app="app"
    />
    <AppStandard
      v-else
      :session="session"
      :app="app"
      @cancel="cancelApp"
    />
  </div>
</template>

<script setup>
import { computed, onMounted } from 'vue'
import { createAppHandle } from '../../apps/runner.js'
import { useAppStore } from '../../stores/panel/apps.js'
import { useSessionStore } from '../../stores/panel/sessions.js'
import { useProjectStore } from '../../stores/panel/projects.js'
import { plainProject } from '../../stores/panel/helpers.js'
import { schedulePersist } from '../../stores/panel/persistence.js'
import AppSetup from './AppSetup.vue'
import AppStandard from './AppStandard.vue'
import AppCustom from './AppCustom.vue'

const props = defineProps({
  session: { type: Object, required: true },
})

const appStore = useAppStore()
const sessionStore = useSessionStore()

const app = computed(() => appStore.getApp(props.session.appId))

onMounted(() => {
  if (props.session.appStatus === 'ready' && !_cancelMap.has(props.session.id)) {
    startApp(props.session.appInputs || {})
  }
})

const isCustomUI = computed(() => {
  return app.value?.ui === 'custom' && props.session.appStatus !== 'setup'
})

function resolveDocxPath(inputs) {
  if (inputs.document && typeof inputs.document === 'string' && inputs.document.endsWith('.docx')) return inputs.document
  for (const v of Object.values(inputs)) {
    if (typeof v === 'string' && v.endsWith('.docx')) return v
  }
  return null
}

const _cancelMap = new Map()

function startApp(inputs) {
  const session = props.session
  const appManifest = app.value
  if (_cancelMap.has(session.id)) return
  if (!appManifest || appManifest.ui !== 'standard') {
    session.appStatus = 'failed'
    session.appError = 'App not found or unsupported UI type'
    session.updatedAt = new Date().toISOString()
    schedulePersist()
    return
  }

  session.appStatus = 'running'
  session.updatedAt = new Date().toISOString()

  const projStore = useProjectStore()
  const project = projStore.projects.find(p => p.id === session.projectId) || null

  const handle = createAppHandle(appManifest, {
    onProgress(event) {
      session.appEvents = [...(session.appEvents || []), event]
      session.updatedAt = new Date().toISOString()
    },
    onComplete(summary) {
      session.appStatus = 'completed'
      session.appResult = summary.result
      session.appEvents = summary.events
      if (summary.usage) session.usage = { ...session.usage, ...summary.usage }
      session.appCompletedAt = new Date().toISOString()
      session.updatedAt = new Date().toISOString()
      _cancelMap.delete(session.id)
      schedulePersist()
    },
    onError(summary) {
      session.appStatus = summary.status
      session.appError = summary.error
      session.appEvents = summary.events
      session.appCompletedAt = new Date().toISOString()
      session.updatedAt = new Date().toISOString()
      _cancelMap.delete(session.id)
      schedulePersist()
    },
  }, { project: plainProject(project), inputs, docxPath: resolveDocxPath(inputs) })

  _cancelMap.set(session.id, () => handle.cancel())
  handle.start()
}

function onStart(inputs) {
  const session = props.session
  const fields = app.value?.setup?.fields || []
  const safeInputs = { ...inputs }
  for (const f of fields) {
    if (f.type === 'password') delete safeInputs[f.id]
  }
  session.appInputs = safeInputs
  session.appStatus = 'running'
  session.appStartedAt = new Date().toISOString()
  session.updatedAt = new Date().toISOString()
  schedulePersist()
  startApp(inputs)
}

function cancelApp() {
  const fn = _cancelMap.get(props.session.id)
  if (fn) {
    fn()
    _cancelMap.delete(props.session.id)
  }
}

function onBack() {
  // Remove the session and go back to NewChat
  sessionStore.removeSession(props.session.id)
}
</script>

<style scoped>
.app-view {
  flex: 1;
  display: flex;
  min-height: 0;
  overflow: hidden;
}
</style>
