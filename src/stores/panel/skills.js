import { ref, computed } from 'vue'
import { defineStore } from 'pinia'
import { useSettingsStore } from '../settings.js'

const _promptCache = new Map()

export const useSkillsStore = defineStore('panelSkills', () => {
  const skills = ref([])

  async function refreshSkills() {
    try {
      const { discoverSkills } = await import('../../services/skills/loader')
      skills.value = await discoverSkills()
      _promptCache.clear()
    } catch { skills.value = [] }
  }

  async function getSkillPrompt(id) {
    if (_promptCache.has(id)) return _promptCache.get(id)
    const { readSkillPrompt } = await import('../../services/skills/loader')
    const prompt = await readSkillPrompt(id)
    _promptCache.set(id, prompt)
    return prompt
  }

  function getSkillMeta(id) {
    return skills.value.find(s => s.id === id)
  }

  async function importSkill() {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog')
      const selected = await open({ directory: true, title: 'Select skill folder' })
      if (!selected) return

      const { importSkillFromFolder } = await import('../../services/skills/loader')
      await importSkillFromFolder(selected)
      await refreshSkills()
    } catch (err) {
      console.error('[skills] Import failed:', err)
    }
  }

  async function importSkillFile() {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog')
      const selected = await open({
        title: 'Select SKILL.md file',
        filters: [{ name: 'Markdown', extensions: ['md'] }],
      })
      if (!selected) return

      const { importSkillFromFile } = await import('../../services/skills/loader')
      await importSkillFromFile(selected)
      await refreshSkills()
    } catch (err) {
      console.error('[skills] Import file failed:', err)
    }
  }

  async function createSkill(skillId) {
    const id = skillId || `skill-${Date.now()}`
    const { createSkillTemplate } = await import('../../services/skills/loader')
    const path = await createSkillTemplate(id)
    await refreshSkills()
    return path
  }

  async function removeSkill(id) {
    try {
      const { removeSkill: doRemove } = await import('../../services/skills/loader')
      await doRemove(id)
      await refreshSkills()
    } catch (err) {
      console.error('[skills] Remove failed:', err)
    }
  }

  const enabledSkills = computed(() => {
    const disabled = useSettingsStore().disabledSkills || []
    return skills.value.filter(s => !disabled.includes(s.id))
  })

  return {
    skills,
    refreshSkills,
    getSkillPrompt,
    getSkillMeta,
    importSkill,
    importSkillFile,
    createSkill,
    removeSkill,
    enabledSkills,
  }
})
