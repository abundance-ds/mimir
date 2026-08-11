<template>
  <Teleport to="body">
    <Transition name="update-toast">
      <aside
        v-if="visible"
        class="update-toast"
        :class="{ 'update-toast-error': updates.phase === UPDATE_PHASE.ERROR }"
        aria-label="Application update"
      >
        <div class="update-toast-icon" aria-hidden="true">
          <component
            :is="icon"
            :size="15"
            :stroke-width="1.8"
            :class="{ 'update-toast-spinner': updates.busy }"
          />
        </div>

        <div
          class="update-toast-content"
          :role="updates.phase === UPDATE_PHASE.ERROR ? 'alert' : 'status'"
          :aria-live="updates.phase === UPDATE_PHASE.ERROR ? 'assertive' : 'polite'"
          aria-atomic="true"
        >
          <div class="update-toast-title">{{ title }}</div>
          <div class="update-toast-copy">{{ copy }}</div>
          <div v-if="showsProgress" class="update-toast-progress" aria-hidden="true">
            <span
              :class="{ 'update-toast-progress-scan': updates.progress === null }"
              :style="updates.progress === null ? undefined : { width: `${updates.progress}%` }"
            />
          </div>
        </div>

        <button
          v-if="action"
          type="button"
          class="update-toast-action"
          :disabled="action.disabled"
          @click="action.run"
        >
          {{ action.label }}
        </button>

        <button
          v-if="!updates.busy"
          type="button"
          class="update-toast-dismiss"
          aria-label="Dismiss update message"
          @click="updates.dismissToast"
        >
          <IconX :size="13" :stroke-width="1.8" />
        </button>
      </aside>
    </Transition>
  </Teleport>
</template>

<script setup>
import { computed } from 'vue'
import {
  IconAlertTriangle,
  IconArrowUpRight,
  IconCheck,
  IconDownload,
  IconLoader2,
  IconRefresh,
  IconX,
} from '@tabler/icons-vue'
import { UPDATE_PHASE, useAppUpdateStore } from '../../stores/appUpdate.js'

const updates = useAppUpdateStore()

const visible = computed(() => updates.toastVisible && [
  UPDATE_PHASE.AVAILABLE,
  UPDATE_PHASE.DOWNLOADING,
  UPDATE_PHASE.INSTALLING,
  UPDATE_PHASE.READY,
  UPDATE_PHASE.RESTARTING,
  UPDATE_PHASE.ERROR,
].includes(updates.phase))

const showsProgress = computed(() => [
  UPDATE_PHASE.DOWNLOADING,
  UPDATE_PHASE.INSTALLING,
].includes(updates.phase))

const icon = computed(() => {
  if ([UPDATE_PHASE.DOWNLOADING, UPDATE_PHASE.INSTALLING, UPDATE_PHASE.RESTARTING].includes(updates.phase)) {
    return IconLoader2
  }
  if (updates.phase === UPDATE_PHASE.READY) return IconCheck
  if (updates.phase === UPDATE_PHASE.ERROR) return IconAlertTriangle
  return IconArrowUpRight
})

const title = computed(() => {
  switch (updates.phase) {
    case UPDATE_PHASE.AVAILABLE: return `${versionLabel(updates.updateVersion)} is available`
    case UPDATE_PHASE.DOWNLOADING: return 'Updating Mimir'
    case UPDATE_PHASE.INSTALLING: return 'Installing update'
    case UPDATE_PHASE.READY: return `${versionLabel(updates.updateVersion)} is ready`
    case UPDATE_PHASE.RESTARTING: return 'Restarting Mimir'
    case UPDATE_PHASE.ERROR: return 'Update needs attention'
    default: return 'Mimir update'
  }
})

const copy = computed(() => {
  switch (updates.phase) {
    case UPDATE_PHASE.AVAILABLE: return `${updates.handoff}. Download the signed update when you are ready.`
    case UPDATE_PHASE.DOWNLOADING:
      return updates.progress === null ? 'Downloading the signed update…' : `Downloading — ${updates.progress}%`
    case UPDATE_PHASE.INSTALLING: return 'Verifying and installing the signed update…'
    case UPDATE_PHASE.READY: return 'Restart when you are ready. Mimir will save your work first.'
    case UPDATE_PHASE.RESTARTING: return 'Saving your work before restart…'
    case UPDATE_PHASE.ERROR: return updates.errorMessage
    default: return ''
  }
})

const action = computed(() => {
  if (updates.phase === UPDATE_PHASE.AVAILABLE) {
    return { label: 'Update', run: updates.installUpdate }
  }
  if (updates.phase === UPDATE_PHASE.READY) {
    return { label: 'Restart', run: updates.restartToUpdate }
  }
  if (updates.phase === UPDATE_PHASE.ERROR) {
    return {
      label: updates.errorStage === 'restart' ? 'Try restart' : 'Try again',
      run: updates.retry,
    }
  }
  if (updates.phase === UPDATE_PHASE.DOWNLOADING) {
    return { label: updates.progress === null ? 'Working…' : `${updates.progress}%`, disabled: true, run: noOp }
  }
  if (updates.phase === UPDATE_PHASE.INSTALLING) {
    return { label: 'Working…', disabled: true, run: noOp }
  }
  return null
})

function versionLabel(value) {
  if (!value) return 'A new version'
  return value.startsWith('v') ? value : `v${value}`
}

function noOp() {}
</script>

<style scoped>
.update-toast {
  position: fixed;
  right: 18px;
  bottom: 28px;
  z-index: 180;
  display: grid;
  grid-template-columns: 28px minmax(0, 1fr) auto 24px;
  width: min(390px, calc(100vw - 36px));
  min-height: 62px;
  align-items: center;
  gap: 9px;
  padding: 10px 9px 10px 10px;
  border: 1px solid var(--color-rule);
  border-radius: 6px;
  background: var(--color-surface);
  box-shadow: 0 10px 28px color-mix(in srgb, var(--color-ink) 15%, transparent);
  color: var(--color-ink);
}

.update-toast-error {
  border-color: color-mix(in srgb, var(--color-rem) 48%, var(--color-rule));
}

.update-toast-icon {
  display: grid;
  width: 28px;
  height: 28px;
  place-items: center;
  border: 1px solid var(--color-rule-light);
  border-radius: 50%;
  background: var(--color-chrome-mid);
  color: var(--color-accent);
}

.update-toast-error .update-toast-icon {
  color: var(--color-rem);
}

.update-toast-title {
  overflow: hidden;
  color: var(--color-ink);
  font-family: var(--font-sans);
  font-size: 11px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.update-toast-copy {
  margin-top: 2px;
  color: var(--color-ink-3);
  font-family: var(--font-sans);
  font-size: 9.5px;
  line-height: 1.35;
}

.update-toast-progress {
  height: 2px;
  margin-top: 7px;
  overflow: hidden;
  background: var(--color-rule-light);
}

.update-toast-progress span {
  display: block;
  width: 0;
  height: 100%;
  background: var(--color-accent);
  transition: width 160ms ease;
}

.update-toast-progress-scan {
  width: 38%;
  animation: update-toast-scan 1s ease-in-out infinite alternate;
}

.update-toast-action {
  min-height: 27px;
  padding: 0 9px;
  border: 1px solid var(--color-accent);
  border-radius: 4px;
  background: var(--color-accent-soft);
  color: var(--color-ink);
  font-family: var(--font-sans);
  font-size: 9.5px;
  font-weight: 600;
  white-space: nowrap;
}

.update-toast-action:hover:not(:disabled) {
  background: var(--color-accent);
  color: var(--color-surface);
}

.update-toast-action:focus-visible,
.update-toast-dismiss:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 2px;
}

.update-toast-action:disabled {
  border-color: var(--color-rule-light);
  background: var(--color-chrome-mid);
  color: var(--color-ink-3);
  cursor: default;
}

.update-toast-dismiss {
  display: grid;
  width: 24px;
  height: 24px;
  place-items: center;
  border-radius: 3px;
  color: var(--color-ink-3);
}

.update-toast-dismiss:hover {
  background: var(--color-chrome-mid);
  color: var(--color-ink);
}

.update-toast-spinner {
  animation: update-toast-spin 800ms linear infinite;
}

.update-toast-enter-active,
.update-toast-leave-active {
  transition: opacity 150ms ease, transform 150ms ease;
}

.update-toast-enter-from,
.update-toast-leave-to {
  opacity: 0;
  transform: translateY(8px);
}

@keyframes update-toast-spin {
  to { transform: rotate(360deg); }
}

@keyframes update-toast-scan {
  from { transform: translateX(-100%); }
  to { transform: translateX(264%); }
}

@media (prefers-reduced-motion: reduce) {
  .update-toast-spinner,
  .update-toast-progress-scan {
    animation: none;
  }

  .update-toast-enter-active,
  .update-toast-leave-active,
  .update-toast-progress span {
    transition: none;
  }
}
</style>
