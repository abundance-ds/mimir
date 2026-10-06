<template>
  <Teleport to="body">
    <div v-if="activity" class="move-overlay" @click.self="cancel">
      <form ref="dialog" class="move-dialog" role="dialog" aria-modal="true"
        aria-labelledby="move-activity-title" aria-describedby="move-activity-copy"
        @submit.prevent="submit" @keydown.esc.prevent.stop="cancel" @keydown.tab="trapFocus">
        <header class="border-b border-rule px-4 py-3">
          <h2 id="move-activity-title" class="text-[13px] font-semibold">Move to workspace</h2>
          <p class="mt-1 truncate text-[11px] text-ink-3">{{ activity.title }}</p>
        </header>
        <div class="space-y-3 p-4">
          <p id="move-activity-copy" class="text-[11px] text-ink-2">
            {{ live ? 'This stops the running session and resumes the conversation in the selected folder.' : 'Resume this conversation in the selected folder.' }}
            Project files stay in their current folders.
          </p>
          <label class="block text-[11px] text-ink-3">
            Destination workspace
            <GraphSelect v-model="destination" class="mt-1 w-full" variant="field"
              aria-label="Destination workspace" placeholder="Select a workspace…"
              :options="options" :disabled="busy || choosing" searchable
              search-placeholder="Find a workspace" />
          </label>
          <p v-if="destination" class="break-all font-mono text-[10px] text-ink-3">{{ destination }}</p>
          <button type="button" class="move-button" :disabled="busy || choosing" @click="chooseFolder">Choose folder…</button>
          <p v-if="error || folderError" role="alert" class="text-[11px] text-rem">{{ error || folderError }}</p>
          <p v-if="busy" role="status" class="text-[11px] text-ink-3">Moving session…</p>
        </div>
        <footer class="flex justify-end gap-2 border-t border-rule px-4 py-3">
          <button type="button" class="move-button" :disabled="busy || choosing" @click="cancel">Cancel</button>
          <button type="submit" class="move-button bg-accent text-accent-ink" :disabled="busy || choosing || !destination">
            {{ live ? 'Stop and move' : 'Move and resume' }}
          </button>
        </footer>
      </form>
    </div>
  </Teleport>
</template>

<script setup>
import { computed, nextTick, ref, watch } from 'vue'
import { open } from '@tauri-apps/plugin-dialog'
import GraphSelect from '../apps/business-graph/GraphSelect.vue'
import { normalizedWorkspacePath } from '../activityWorkspace.js'
import { isLiveActivity } from '../composables/useActivityLifecycle.js'

const props = defineProps({
  activity: { type: Object, default: null },
  recentWorkspaces: { type: Array, default: () => [] },
  busy: Boolean,
  error: { type: String, default: '' },
})
const emit = defineEmits(['cancel', 'move'])
const dialog = ref(null)
const destination = ref('')
const chosenFolder = ref('')
const choosing = ref(false)
const folderError = ref('')
const live = computed(() => isLiveActivity(props.activity)
  || Boolean(props.activity?.session && !props.activity.session.exit && props.activity.status !== 'interrupted'))
const options = computed(() => {
  const current = normalizedWorkspacePath(props.activity?.workspacePath)
  const seen = new Set([current])
  return [
    ...(chosenFolder.value ? [{ path: chosenFolder.value }] : []),
    ...props.recentWorkspaces,
  ].filter(workspace => {
    const path = normalizedWorkspacePath(workspace.path)
    if (!path || seen.has(path)) return false
    seen.add(path)
    return true
  }).map(workspace => ({
    value: workspace.path,
    label: `${workspace.name || workspace.path.split('/').filter(Boolean).at(-1)}${workspace.missing ? ' — not found' : ''}`,
    description: workspace.path,
    disabled: Boolean(workspace.missing),
  }))
})
let previousFocus
watch(() => props.activity?.id, async id => {
  if (!id) {
    await nextTick()
    if (previousFocus?.isConnected) previousFocus.focus()
    return
  }
  previousFocus = document.activeElement
  destination.value = ''
  chosenFolder.value = ''
  folderError.value = ''
  await nextTick()
  dialog.value?.querySelector('[role="combobox"]')?.focus()
}, { immediate: true })

async function chooseFolder() {
  choosing.value = true
  folderError.value = ''
  try {
    const selection = await open({ directory: true, multiple: false, title: 'Move to workspace' })
    if (!selection) return
    const path = Array.isArray(selection) ? selection[0] : selection
    if (normalizedWorkspacePath(path) === normalizedWorkspacePath(props.activity?.workspacePath)) {
      folderError.value = 'Select a different workspace folder.'
      return
    }
    chosenFolder.value = path
    destination.value = path
  } catch (cause) {
    folderError.value = `Folder selection failed: ${cause instanceof Error ? cause.message : String(cause)}`
  } finally {
    choosing.value = false
  }
}
function cancel() {
  if (!props.busy && !choosing.value) emit('cancel')
}
function submit() {
  if (!props.busy && !choosing.value && destination.value) emit('move', destination.value)
}
function trapFocus(event) {
  const fields = [...(dialog.value?.querySelectorAll('button:not(:disabled), input:not(:disabled)') || [])]
  if (!fields.length) { event.preventDefault(); return }
  const first = fields[0], last = fields.at(-1)
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
}
</script>

<style scoped>
.move-overlay { position: fixed; inset: 0; z-index: 160; display: grid; place-items: center; padding: 16px; background: color-mix(in srgb, var(--color-ink) 30%, transparent); }
.move-dialog { width: min(440px, 100%); max-height: calc(100vh - 32px); overflow-y: auto; border: 1px solid var(--color-rule); background: var(--color-surface); color: var(--color-ink); }
.move-button { padding: 5px 10px; border: 1px solid var(--color-rule); font-size: 11px; }
.move-button:hover:not(:disabled) { background: var(--color-chrome-mid); }
.move-button[type=submit]:hover:not(:disabled) { background: var(--color-accent); opacity: .9; }
.move-button:focus-visible { outline: 1px solid var(--color-accent); outline-offset: 2px; }
.move-button:disabled { opacity: .45; }
</style>
