import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import {
  detectAgents,
  loadLauncherConfig,
  saveLauncherConfig,
} from '../services/launchers.js'

export const useLaunchersStore = defineStore('launchers', () => {
  const agents = ref([])
  const presets = ref([])
  const configPath = ref('')
  const diagnostic = ref('')
  const error = ref('')
  const loading = ref(false)
  const ready = ref(false)

  const decoratedPresets = computed(() => presets.value.map((preset) => {
    if (preset.kind !== 'agent') return { ...preset, available: true, unavailableReason: '' }
    if (String(preset.binary || '').trim()) {
      return {
        ...preset,
        available: true,
        unavailableReason: '',
        detectedAgent: null,
      }
    }
    const agent = agents.value.find((candidate) => candidate.id === preset.agentId)
    const available = Boolean(agent?.installed && agent?.binaryPath)
    return {
      ...preset,
      available,
      unavailableReason: available
        ? ''
        : agent?.diagnostic || `${preset.title} is not installed.`,
      detectedAgent: agent || null,
    }
  }))
  const availablePresets = computed(() => decoratedPresets.value.filter((preset) => preset.available))
  const unavailablePresets = computed(() => decoratedPresets.value.filter((preset) => !preset.available))

  async function load() {
    loading.value = true
    error.value = ''
    try {
      const [detected, config] = await Promise.all([
        detectAgents(),
        loadLauncherConfig(),
      ])
      agents.value = detected
      presets.value = config.presets || []
      configPath.value = config.path || ''
      diagnostic.value = config.diagnostic || ''
    } catch (cause) {
      agents.value = []
      presets.value = []
      error.value = cause instanceof Error ? cause.message : String(cause)
    } finally {
      loading.value = false
      ready.value = true
    }
  }

  async function save(nextPresets) {
    await saveLauncherConfig(nextPresets)
    presets.value = structuredClone(nextPresets)
  }

  function byId(id) {
    return decoratedPresets.value.find((preset) => preset.id === id) || null
  }

  return {
    agents,
    presets,
    configPath,
    diagnostic,
    error,
    loading,
    ready,
    decoratedPresets,
    availablePresets,
    unavailablePresets,
    load,
    save,
    byId,
  }
})
