<template>
  <div class="ac-wrap">
    <div class="ac-toolbar">
      <div class="ac-toolbar-left">
        <span v-if="app?.icon" class="ac-toolbar-icon">{{ app.icon }}</span>
        <span class="ac-toolbar-name">{{ session.appName || app?.name || 'App' }}</span>
      </div>
      <div class="ac-toolbar-right">
        <button class="ac-toolbar-btn" @click="reload" title="Reload">
          <IconRefresh :size="13" />
        </button>
        <button class="ac-toolbar-btn" @click="markDone">Done</button>
      </div>
    </div>
    <iframe
      ref="iframeRef"
      :src="iframeSrc"
      class="ac-iframe"
      sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
      @load="onIframeLoad"
    />
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue'
import { IconRefresh } from '@tabler/icons-vue'
import { createAppBridge } from '../../apps/bridge.js'
import { doneSession } from '../../stores/panel/actions.js'

const props = defineProps({
  session: { type: Object, required: true },
  app: { type: Object, default: null },
})

const iframeRef = ref(null)
let bridge = null

const iframeSrc = computed(() => {
  const appId = props.session.appId
  const projectId = props.session.projectId || 'general'
  // Pass context as query params so the SDK can read them
  return `app://localhost/${appId}/index.html?projectId=${encodeURIComponent(projectId)}&sessionId=${encodeURIComponent(props.session.id)}`
})

function onIframeLoad() {
  // Bridge is already listening from mount
}

function reload() {
  if (iframeRef.value) {
    iframeRef.value.src = iframeSrc.value
  }
}

function markDone() {
  doneSession()
}

onMounted(() => {
  if (iframeRef.value) {
    bridge = createAppBridge(iframeRef.value, {
      appId: props.session.appId,
      projectId: props.session.projectId || 'general',
    })
    bridge.start()
  }
})

onBeforeUnmount(() => {
  bridge?.stop()
})

// If the iframe ref changes (shouldn't normally), restart the bridge
watch(iframeRef, (el) => {
  bridge?.stop()
  if (el) {
    bridge = createAppBridge(el, {
      appId: props.session.appId,
      projectId: props.session.projectId || 'general',
    })
    bridge.start()
  }
})
</script>

<style scoped>
.ac-wrap {
  flex: 1; display: flex; flex-direction: column;
  min-height: 0; overflow: hidden;
}
.ac-toolbar {
  display: flex; align-items: center; justify-content: space-between;
  height: 36px; padding: 0 12px;
  background: var(--color-surface);
  border-bottom: 1px solid var(--color-rule-light);
  flex-shrink: 0;
}
.ac-toolbar-left {
  display: flex; align-items: center; gap: 6px;
}
.ac-toolbar-icon { font-size: 14px; line-height: 1; }
.ac-toolbar-name {
  font-family: var(--font-sans); font-size: 12px; font-weight: 500;
  color: var(--color-ink-2);
}
.ac-toolbar-right {
  display: flex; align-items: center; gap: 4px;
}
.ac-toolbar-btn {
  display: inline-flex; align-items: center; gap: 4px;
  font-family: var(--font-sans); font-size: 11px; color: var(--color-ink-3);
  padding: 3px 8px; border-radius: 4px;
}
.ac-toolbar-btn:hover { background: var(--color-chrome-high); color: var(--color-ink); }

.ac-iframe {
  flex: 1; width: 100%; border: none;
  background: var(--color-surface);
}
</style>
