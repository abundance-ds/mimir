<template>
  <main class="as-main">
    <div class="as-scroll">
      <div class="as-center">
        <button class="as-back" @click="$emit('back')">
          <IconArrowLeft :size="14" /> Back
        </button>

        <div class="as-header">
          <span v-if="app?.icon" class="as-icon">{{ app.icon }}</span>
          <div>
            <h1 class="as-title">{{ app?.name || 'App' }}</h1>
            <p v-if="app?.description" class="as-desc">{{ app.description }}</p>
          </div>
        </div>

        <div v-if="fields.length" class="as-fields">
          <div v-for="field in fields" :key="field.id" class="as-field">
            <label class="as-label">{{ field.label }}</label>
            <p v-if="field.description" class="as-field-desc">{{ field.description }}</p>

            <input
              v-if="field.type === 'text'"
              v-model="values[field.id]"
              type="text"
              class="as-input"
              autocorrect="off"
              autocapitalize="off"
              :placeholder="field.placeholder || ''"
            />
            <input
              v-else-if="field.type === 'password'"
              v-model="values[field.id]"
              type="password"
              class="as-input"
              autocomplete="off"
              :placeholder="field.placeholder || ''"
            />
            <textarea
              v-else-if="field.type === 'textarea'"
              v-model="values[field.id]"
              class="as-textarea"
              rows="4"
              autocorrect="off"
              autocapitalize="off"
              :placeholder="field.placeholder || ''"
            />
            <div v-else-if="field.type === 'file'" class="as-file-row">
              <span class="as-file-name">{{ values[field.id] ? basename(values[field.id]) : 'No file selected' }}</span>
              <button class="as-file-btn" @click="pickFile(field.id)">Browse</button>
            </div>
            <div v-else-if="field.type === 'model'" class="as-model-row">
              <ModelPicker
                :model-id="values[field.id] || field.default || sessionStore.selectableModels[0]?.id || ''"
                :models="sessionStore.selectableModels"
                @update:model-id="(id) => values[field.id] = id"
              />
            </div>
          </div>
        </div>

        <div v-else class="as-empty">
          <p>Ready to start.</p>
        </div>

        <div class="as-actions">
          <button class="as-start" @click="start">Start</button>
        </div>
      </div>
    </div>
  </main>
</template>

<script setup>
import { reactive, computed } from 'vue'
import { IconArrowLeft } from '@tabler/icons-vue'
import ModelPicker from './ModelPicker.vue'
import { useSessionStore } from '../../stores/panel/sessions.js'
import { basename } from '../../shared/utils/path.js'

const props = defineProps({
  app: { type: Object, default: null },
  session: { type: Object, required: true },
})

const emit = defineEmits(['start', 'back'])

const sessionStore = useSessionStore()

const fields = computed(() => props.app?.setup?.fields || [])

const values = reactive({})
// Initialize values from field defaults
fields.value.forEach(f => {
  if (f.type === 'model') {
    values[f.id] = f.default || sessionStore.selectableModels[0]?.id || ''
  } else {
    values[f.id] = f.default || ''
  }
})

async function pickFile(fieldId) {
  try {
    const { open } = await import('@tauri-apps/plugin-dialog')
    const field = fields.value.find(f => f.id === fieldId)
    const opts = { multiple: false }
    if (field?.filters) opts.filters = field.filters
    const selected = await open(opts)
    if (selected) values[fieldId] = typeof selected === 'string' ? selected : selected.path
  } catch {
    // Browser fallback — no file picker available
  }
}

function start() {
  emit('start', { ...values })
}
</script>

<style scoped>
.as-main {
  flex: 1; display: flex; flex-direction: column;
  min-width: 0; background: var(--color-chrome-high);
  overflow: hidden;
}
.as-scroll {
  flex: 1; overflow-y: auto; padding: 0 40px;
}
.as-center {
  max-width: 480px; width: 100%; margin: 0 auto;
  padding-top: 60px; padding-bottom: 40px;
}
.as-back {
  display: inline-flex; align-items: center; gap: 4px;
  font-family: var(--font-sans); font-size: 12px; color: var(--color-ink-3);
  padding: 4px 8px; border-radius: 4px; margin-bottom: 24px;
}
.as-back:hover { background: var(--color-chrome); color: var(--color-ink); }

.as-header {
  display: flex; align-items: flex-start; gap: 12px; margin-bottom: 28px;
}
.as-icon { font-size: 28px; line-height: 1; }
.as-title {
  font-family: var(--font-sans); font-size: 20px; font-weight: 400;
  color: var(--color-ink); margin: 0;
}
.as-desc {
  font-family: var(--font-sans); font-size: 12.5px; color: var(--color-ink-3);
  margin: 4px 0 0;
}

.as-fields { display: flex; flex-direction: column; gap: 18px; }
.as-field { display: flex; flex-direction: column; }
.as-label {
  font-family: var(--font-sans); font-size: 12px; font-weight: 600;
  color: var(--color-ink-2); margin-bottom: 6px;
}
.as-field-desc {
  font-family: var(--font-sans); font-size: 11px; color: var(--color-ink-3);
  margin: -2px 0 6px;
}
.as-input, .as-textarea {
  font-family: var(--font-mono); font-size: 13px; color: var(--color-ink);
  background: var(--color-surface); border: 1px solid var(--color-rule);
  border-radius: 6px; padding: 8px 10px; width: 100%;
  outline: none;
}
.as-input:focus, .as-textarea:focus {
  border-color: var(--color-accent);
}
.as-textarea { resize: vertical; min-height: 80px; }

.as-file-row {
  display: flex; align-items: center; gap: 8px;
}
.as-file-name {
  font-family: var(--font-mono); font-size: 12px; color: var(--color-ink-3);
  flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.as-file-btn {
  font-family: var(--font-sans); font-size: 11.5px; color: var(--color-ink-2);
  background: var(--color-chrome); border: 1px solid var(--color-rule);
  border-radius: 4px; padding: 4px 12px; flex-shrink: 0;
}
.as-file-btn:hover { background: var(--color-chrome-high); }

.as-model-row {
  display: flex; align-items: center;
}

.as-empty {
  font-family: var(--font-sans); font-size: 13px; color: var(--color-ink-3);
  padding: 12px 0;
}

.as-actions { margin-top: 28px; display: flex; gap: 8px; }
.as-start {
  font-family: var(--font-sans); font-size: 13px; font-weight: 500;
  color: white; background: var(--color-accent);
  border-radius: 6px; padding: 8px 24px;
}
.as-start:hover { filter: brightness(1.08); }
</style>
