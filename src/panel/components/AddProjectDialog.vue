<template>
  <Teleport to="body">
    <div class="dialog-overlay" @click.self="$emit('close')">
      <div class="dialog-box">
        <div class="dialog-header">
          <span class="dialog-title">{{ dialogTitle }}</span>
          <button class="dialog-close" @click="$emit('close')">
            <IconX :size="14" />
          </button>
        </div>

        <div class="dialog-body">
          <div v-if="mode === 'new'">
            <div class="field-row">
              <label class="field-label">Parent directory</label>
              <div class="field-browse">
                <span class="field-path" :class="{ empty: !parentPath }">{{ parentPath || 'No directory selected' }}</span>
                <button class="browse-btn" @click="pickParent">Browse</button>
              </div>
            </div>
            <div class="field-row">
              <label class="field-label">Folder name</label>
              <input
                v-model="newFolderName"
                class="field-input"
                placeholder="my-research-paper"
                autocorrect="off"
                autocapitalize="off"
              />
            </div>
          </div>

          <div v-else>
            <div class="field-row">
              <label class="field-label">Repository URL</label>
              <input
                v-model="cloneUrl"
                class="field-input"
                placeholder="https://github.com/user/repo.git"
                autocorrect="off"
                autocapitalize="off"
              />
            </div>
            <div class="field-row">
              <label class="field-label">Clone into</label>
              <div class="field-browse">
                <span class="field-path" :class="{ empty: !cloneParentPath }">{{ cloneParentPath || 'Select parent directory' }}</span>
                <button class="browse-btn" @click="pickCloneParent">Browse</button>
              </div>
            </div>
            <div class="field-row">
              <label class="field-label">Folder name</label>
              <input
                v-model="cloneFolderName"
                class="field-input"
                placeholder="repo-name"
                autocorrect="off"
                autocapitalize="off"
              />
            </div>
            <div class="field-row">
              <label class="field-label">Access token <span style="color: var(--color-ink-3); font-weight: 400">(optional, for private repos)</span></label>
              <input v-model="cloneToken" type="password" class="field-input" placeholder="ghp_..." />
            </div>
          </div>

          <p v-if="errorMessage" class="dialog-error">{{ errorMessage }}</p>
        </div>

        <div class="dialog-footer">
          <button class="btn-cancel" @click="$emit('close')">Cancel</button>
          <button class="btn-create" :disabled="!canCreate || creating" @click="create">
            {{ createLabel }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { linkFolderAsProject } from '../../stores/panel/actions.js'
import { IconX } from '@tabler/icons-vue'

const isTauri = typeof window !== 'undefined' && !!window.__TAURI_INTERNALS__

const props = defineProps({
  mode: { type: String, default: 'new' },
})
const emit = defineEmits(['close', 'created'])

// New Folder state
const parentPath = ref('')
const newFolderName = ref('')

// Clone Repo state
const cloneUrl = ref('')
const cloneParentPath = ref('')
const cloneFolderName = ref('')
const cloneToken = ref('')

watch(cloneUrl, (url) => {
  if (!url) return
  const match = url.match(/\/([^\/]+?)(?:\.git)?$/)
  if (match) cloneFolderName.value = match[1]
})

const errorMessage = ref('')
const creating = ref(false)

const mode = computed(() => props.mode === 'clone' ? 'clone' : 'new')
const dialogTitle = computed(() => mode.value === 'clone' ? 'Clone Repository' : 'New Folder')

const canCreate = computed(() => {
  if (mode.value === 'new') return Boolean(parentPath.value && newFolderName.value.trim())
  return Boolean(cloneUrl.value.trim() && cloneParentPath.value && cloneFolderName.value.trim())
})

const createLabel = computed(() => {
  if (creating.value) {
    return mode.value === 'clone' ? 'Cloning...' : 'Creating...'
  }
  return mode.value === 'clone' ? 'Clone Repository' : 'Create Folder'
})

async function pickParent() {
  if (!isTauri) return
  try {
    const { open } = await import('@tauri-apps/plugin-dialog')
    const selected = await open({ directory: true, multiple: false, title: 'Select parent directory' })
    if (!selected) return
    parentPath.value = typeof selected === 'string' ? selected : selected
    errorMessage.value = ''
  } catch (e) {
    errorMessage.value = String(e)
  }
}

async function pickCloneParent() {
  if (!isTauri) return
  try {
    const { open } = await import('@tauri-apps/plugin-dialog')
    const selected = await open({ directory: true, multiple: false, title: 'Select clone destination' })
    if (!selected) return
    cloneParentPath.value = typeof selected === 'string' ? selected : selected
    errorMessage.value = ''
  } catch (e) {
    errorMessage.value = String(e)
  }
}

async function create() {
  if (!canCreate.value || creating.value) return
  creating.value = true
  errorMessage.value = ''

  try {
    if (mode.value === 'new') {
      const fullPath = `${parentPath.value}/${newFolderName.value.trim()}`
      // Check if dir already exists
      if (isTauri) {
        const { invoke } = await import('@tauri-apps/api/core')
        const exists = await invoke('path_exists', { path: fullPath })
        if (exists) {
          errorMessage.value = 'A folder with this name already exists.'
          creating.value = false
          return
        }
        await invoke('create_dir', { path: fullPath })
      }
      await linkFolderAsProject({ name: newFolderName.value.trim(), workspacePath: fullPath })
    } else {
      const fullPath = `${cloneParentPath.value}/${cloneFolderName.value.trim()}`
      if (isTauri) {
        const { invoke } = await import('@tauri-apps/api/core')
        const exists = await invoke('path_exists', { path: fullPath })
        if (exists) {
          errorMessage.value = 'A folder with this name already exists at this location.'
          creating.value = false
          return
        }
        // Clone the repository
        if (cloneToken.value.trim()) {
          await invoke('git_clone_authenticated', {
            url: cloneUrl.value.trim(),
            targetDir: fullPath,
            token: cloneToken.value.trim()
          })
        } else {
          await invoke('git_clone', {
            url: cloneUrl.value.trim(),
            targetDir: fullPath
          })
        }
      }
      await linkFolderAsProject({ name: cloneFolderName.value.trim(), workspacePath: fullPath })
    }
    emit('created')
    emit('close')
  } catch (e) {
    errorMessage.value = String(e)
  } finally {
    creating.value = false
  }
}

function onKeyDown(e) {
  if (e.key === 'Escape') emit('close')
}
onMounted(() => document.addEventListener('keydown', onKeyDown))
onUnmounted(() => document.removeEventListener('keydown', onKeyDown))
</script>

<style scoped>
.dialog-overlay {
  position: fixed; inset: 0; z-index: 100;
  background: rgba(0,0,0,0.4);
  display: flex; align-items: center; justify-content: center;
}
.dialog-box {
  width: 420px; background: var(--color-surface);
  border: 1px solid var(--color-rule); border-radius: 10px;
  display: flex; flex-direction: column;
  box-shadow: 0 8px 30px rgba(0,0,0,.18);
}
.dialog-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 14px 16px 0;
}
.dialog-title {
  font-family: var(--font-sans); font-size: 13px; font-weight: 600; color: var(--color-ink);
}
.dialog-close {
  width: 24px; height: 24px; border-radius: 4px;
  display: flex; align-items: center; justify-content: center;
  color: var(--color-ink-3);
}
.dialog-close:hover { background: var(--color-chrome-high); color: var(--color-ink); }

.dialog-body { padding: 16px; }

.field-row { margin-bottom: 12px; }
.field-label {
  display: block; font-family: var(--font-sans); font-size: 11px;
  color: var(--color-ink-3); margin-bottom: 4px;
}
.field-browse {
  display: flex; align-items: center; gap: 8px;
}
.field-path {
  flex: 1; font-family: var(--font-mono); font-size: 11px; color: var(--color-ink-2);
  background: var(--color-surface); border: 1px solid var(--color-rule-light); border-radius: 4px;
  padding: 6px 10px; min-height: 30px; display: flex; align-items: center;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  direction: rtl; text-align: left;
}
.field-path.empty { color: var(--color-ink-3); font-style: italic; direction: ltr; }
.browse-btn {
  font-family: var(--font-sans); font-size: 11px; font-weight: 500;
  color: var(--color-ink-2); border: 1px solid var(--color-rule); border-radius: 4px;
  padding: 0 10px; height: 30px; white-space: nowrap; flex-shrink: 0;
}
.browse-btn:hover { background: var(--color-chrome-high); color: var(--color-ink); }

.field-input {
  width: 100%; font-family: var(--font-mono); font-size: 12px; color: var(--color-ink);
  background: var(--color-surface); border: 1px solid var(--color-rule-light); border-radius: 4px;
  padding: 6px 10px; height: 30px; outline: none;
}
.field-input:focus { border-color: var(--color-accent); }
.field-input::placeholder { color: var(--color-ink-3); }

.dialog-error {
  font-family: var(--font-sans); font-size: 11px; color: var(--color-accent);
  margin: 0; padding: 4px 0 0;
}

.dialog-footer {
  display: flex; justify-content: flex-end; gap: 8px;
  padding: 0 16px 14px;
}
.btn-cancel {
  font-family: var(--font-sans); font-size: 11px; font-weight: 500;
  color: var(--color-ink-2); padding: 0 12px; height: 30px; border-radius: 4px;
}
.btn-cancel:hover { background: var(--color-chrome-high); }
.btn-create {
  font-family: var(--font-sans); font-size: 11px; font-weight: 600;
  color: var(--color-accent-ink); background: var(--color-accent); padding: 0 14px; height: 30px; border-radius: 4px;
}
.btn-create:hover { opacity: 0.9; }
.btn-create:disabled { opacity: 0.4; pointer-events: none; }
</style>
