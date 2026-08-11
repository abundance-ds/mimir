<template>
  <div class="updates-page">
    <section class="updates-release" aria-labelledby="updates-release-title">
      <div class="updates-heading">
        <div class="updates-mark" aria-hidden="true">
          <IconArrowUpRight :size="15" :stroke-width="1.7" />
        </div>
        <div>
          <h2 id="updates-release-title">Mimir</h2>
          <p>Signed updates from the Mimir GitHub release.</p>
        </div>
      </div>

      <div class="version-handoff" :class="`version-handoff-${updates.phase}`">
        <span class="version-caption">Version</span>
        <span class="version-value">{{ updates.handoff }}</span>
        <span class="version-state">
          <component
            :is="stateIcon"
            :size="13"
            :stroke-width="1.8"
            :class="stateIconClass"
            aria-hidden="true"
          />
          {{ stateLabel }}
        </span>
      </div>

      <div class="update-action-slot" aria-live="polite" aria-atomic="true">
        <div class="update-action-copy">
          <p class="update-status">{{ statusCopy }}</p>
          <p v-if="updates.releaseNotes && hasReleaseNotes" class="update-notes">
            {{ updates.releaseNotes }}
          </p>
          <details v-if="updates.phase === UPDATE_PHASE.ERROR && updates.errorDetail" class="update-detail">
            <summary>Technical details</summary>
            <code>{{ updates.errorDetail }}</code>
          </details>
        </div>

        <div v-if="showsProgress" class="update-progress" aria-hidden="true">
          <span
            class="update-progress-fill"
            :class="{ 'update-progress-indeterminate': updates.progress === null }"
            :style="updates.progress === null ? undefined : { width: `${updates.progress}%` }"
          />
        </div>

        <div class="update-actions">
          <button
            v-if="action"
            type="button"
            class="update-button"
            :class="{ 'update-button-primary': action.primary }"
            :disabled="action.disabled"
            @click="action.run"
          >
            <IconLoader2
              v-if="action.busy"
              :size="13"
              :stroke-width="1.8"
              class="update-spinner"
              aria-hidden="true"
            />
            <component
              :is="action.icon"
              v-else-if="action.icon"
              :size="13"
              :stroke-width="1.8"
              aria-hidden="true"
            />
            {{ action.label }}
          </button>
        </div>
      </div>
    </section>

    <p class="updates-footnote">
      Mimir checks after launch. It downloads only after you select Update, and it restarts only when you ask.
    </p>
  </div>
</template>

<script setup>
import { computed, onMounted } from 'vue'
import {
  IconAlertTriangle,
  IconArrowUpRight,
  IconCheck,
  IconDownload,
  IconLoader2,
  IconRefresh,
  IconRotateClockwise,
} from '@tabler/icons-vue'
import { UPDATE_PHASE, useAppUpdateStore } from '../../../stores/appUpdate.js'

const updates = useAppUpdateStore()

const showsProgress = computed(() => [
  UPDATE_PHASE.DOWNLOADING,
  UPDATE_PHASE.INSTALLING,
].includes(updates.phase))
const hasReleaseNotes = computed(() => [
  UPDATE_PHASE.AVAILABLE,
  UPDATE_PHASE.DOWNLOADING,
  UPDATE_PHASE.INSTALLING,
  UPDATE_PHASE.READY,
].includes(updates.phase))

const stateLabel = computed(() => {
  switch (updates.phase) {
    case UPDATE_PHASE.CHECKING: return 'Checking'
    case UPDATE_PHASE.AVAILABLE: return 'Available'
    case UPDATE_PHASE.DOWNLOADING: return progressLabel.value
    case UPDATE_PHASE.INSTALLING: return 'Installing'
    case UPDATE_PHASE.READY: return 'Ready'
    case UPDATE_PHASE.RESTARTING: return 'Restarting'
    case UPDATE_PHASE.CURRENT: return 'Up to date'
    case UPDATE_PHASE.ERROR: return 'Needs attention'
    case UPDATE_PHASE.UNSUPPORTED: return 'Release builds only'
    default: return 'Ready to check'
  }
})

const stateIcon = computed(() => {
  if ([UPDATE_PHASE.CHECKING, UPDATE_PHASE.DOWNLOADING, UPDATE_PHASE.INSTALLING, UPDATE_PHASE.RESTARTING].includes(updates.phase)) {
    return IconLoader2
  }
  if ([UPDATE_PHASE.CURRENT, UPDATE_PHASE.READY].includes(updates.phase)) return IconCheck
  if (updates.phase === UPDATE_PHASE.ERROR) return IconAlertTriangle
  if (updates.phase === UPDATE_PHASE.AVAILABLE) return IconArrowUpRight
  return IconRefresh
})

const stateIconClass = computed(() => ({
  'update-spinner': [UPDATE_PHASE.CHECKING, UPDATE_PHASE.DOWNLOADING, UPDATE_PHASE.INSTALLING, UPDATE_PHASE.RESTARTING].includes(updates.phase),
  'state-good': [UPDATE_PHASE.CURRENT, UPDATE_PHASE.READY].includes(updates.phase),
  'state-error': updates.phase === UPDATE_PHASE.ERROR,
  'state-accent': updates.phase === UPDATE_PHASE.AVAILABLE,
}))

const progressLabel = computed(() => (
  updates.progress === null ? 'Downloading' : `Downloading ${updates.progress}%`
))

const statusCopy = computed(() => {
  switch (updates.phase) {
    case UPDATE_PHASE.CHECKING:
      return 'Checking the signed release feed…'
    case UPDATE_PHASE.CURRENT:
      return `${versionLabel(updates.currentVersion)} is the newest version.`
    case UPDATE_PHASE.AVAILABLE:
      return `${versionLabel(updates.updateVersion)} is ready to download.`
    case UPDATE_PHASE.DOWNLOADING:
      return updates.progress === null
        ? 'Downloading the signed update…'
        : `Downloading the signed update — ${updates.progress}%`
    case UPDATE_PHASE.INSTALLING:
      return 'Verifying and installing the update…'
    case UPDATE_PHASE.READY:
      return `${versionLabel(updates.updateVersion)} is installed and ready.`
    case UPDATE_PHASE.RESTARTING:
      return 'Saving your work and restarting Mimir…'
    case UPDATE_PHASE.ERROR:
      return updates.errorMessage
    case UPDATE_PHASE.UNSUPPORTED:
      return 'Update checks are available in installed release builds.'
    default:
      return `You have ${versionLabel(updates.currentVersion)}.`
  }
})

const action = computed(() => {
  switch (updates.phase) {
    case UPDATE_PHASE.CHECKING:
      return { label: 'Checking…', disabled: true, busy: true, run: noOp }
    case UPDATE_PHASE.AVAILABLE:
      return {
        label: `Update to ${versionLabel(updates.updateVersion)}`,
        primary: true,
        icon: IconDownload,
        run: updates.installUpdate,
      }
    case UPDATE_PHASE.DOWNLOADING:
      return { label: progressLabel.value, disabled: true, busy: true, run: noOp }
    case UPDATE_PHASE.INSTALLING:
      return { label: 'Installing…', disabled: true, busy: true, run: noOp }
    case UPDATE_PHASE.READY:
      return {
        label: 'Restart Mimir',
        primary: true,
        icon: IconRotateClockwise,
        run: updates.restartToUpdate,
      }
    case UPDATE_PHASE.RESTARTING:
      return { label: 'Restarting…', disabled: true, busy: true, run: noOp }
    case UPDATE_PHASE.ERROR:
      return {
        label: updates.errorStage === 'restart' ? 'Try restart again' : 'Try again',
        icon: IconRefresh,
        run: updates.retry,
      }
    case UPDATE_PHASE.UNSUPPORTED:
      return null
    case UPDATE_PHASE.CURRENT:
      return { label: 'Check again', icon: IconRefresh, run: updates.checkForUpdate }
    default:
      return { label: 'Check for updates', icon: IconRefresh, run: updates.checkForUpdate }
  }
})

onMounted(() => {
  void updates.loadVersion()
})

function versionLabel(value) {
  if (!value) return 'v—'
  return value.startsWith('v') ? value : `v${value}`
}

function noOp() {}
</script>

<style scoped>
.updates-page {
  width: min(100%, 480px);
  padding-top: 2px;
}

.updates-release {
  border-block: 1px solid var(--color-rule-light);
  padding: 16px 0 15px;
}

.updates-heading {
  display: flex;
  align-items: center;
  gap: 10px;
}

.updates-mark {
  display: grid;
  width: 28px;
  height: 28px;
  place-items: center;
  border: 1px solid var(--color-rule);
  border-radius: 5px;
  color: var(--color-accent);
  background: var(--color-chrome-mid);
}

.updates-heading h2 {
  margin: 0;
  color: var(--color-ink);
  font-family: var(--font-sans);
  font-size: 12px;
  font-weight: 600;
}

.updates-heading p {
  margin: 2px 0 0;
  color: var(--color-ink-3);
  font-family: var(--font-sans);
  font-size: 10px;
}

.version-handoff {
  display: grid;
  grid-template-columns: 56px minmax(132px, 1fr) auto;
  align-items: center;
  min-height: 38px;
  margin-top: 16px;
  border-block: 1px solid var(--color-rule-light);
  color: var(--color-ink-2);
}

.version-caption {
  color: var(--color-ink-3);
  font-family: var(--font-sans);
  font-size: 9px;
  text-transform: uppercase;
  letter-spacing: 1.2px;
}

.version-value {
  color: var(--color-ink);
  font-family: var(--font-mono);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.version-state {
  display: inline-flex;
  align-items: center;
  justify-content: flex-end;
  gap: 5px;
  color: var(--color-ink-3);
  font-family: var(--font-sans);
  font-size: 10px;
  white-space: nowrap;
}

.state-good { color: var(--color-add); }
.state-error { color: var(--color-rem); }
.state-accent { color: var(--color-accent); }

.update-action-slot {
  min-height: 93px;
  padding-top: 13px;
}

.update-action-copy {
  min-height: 38px;
}

.update-status,
.update-notes {
  margin: 0;
  font-family: var(--font-sans);
  font-size: 10.5px;
  line-height: 1.45;
}

.update-status { color: var(--color-ink-2); }

.update-notes {
  display: -webkit-box;
  margin-top: 4px;
  overflow: hidden;
  color: var(--color-ink-3);
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.update-detail {
  margin-top: 5px;
  color: var(--color-rem);
  font-family: var(--font-sans);
  font-size: 9px;
}

.update-detail summary { cursor: pointer; }

.update-detail code {
  display: block;
  margin-top: 5px;
  overflow-wrap: anywhere;
  color: var(--color-ink-3);
  font-family: var(--font-mono);
  line-height: 1.45;
  user-select: text;
}

.update-progress {
  height: 2px;
  margin: 2px 0 11px;
  overflow: hidden;
  background: var(--color-rule-light);
}

.update-progress-fill {
  display: block;
  width: 0;
  height: 100%;
  background: var(--color-accent);
  transition: width 160ms ease;
}

.update-progress-indeterminate {
  width: 38%;
  animation: update-progress-scan 1s ease-in-out infinite alternate;
}

.update-actions {
  display: flex;
  min-height: 28px;
  align-items: flex-end;
}

.update-button {
  display: inline-flex;
  min-height: 28px;
  align-items: center;
  gap: 6px;
  padding: 0 10px;
  border: 1px solid var(--color-rule);
  border-radius: 4px;
  background: var(--color-chrome-mid);
  color: var(--color-ink-2);
  font-family: var(--font-sans);
  font-size: 10px;
  font-weight: 500;
}

.update-button:hover:not(:disabled) {
  border-color: var(--color-accent);
  color: var(--color-ink);
}

.update-button:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 2px;
}

.update-button:disabled {
  cursor: default;
  opacity: 0.68;
}

.update-button-primary {
  border-color: var(--color-accent);
  background: var(--color-accent-soft);
  color: var(--color-ink);
}

.update-button-primary:hover:not(:disabled) {
  background: var(--color-accent);
  color: var(--color-surface);
}

.update-spinner {
  animation: update-spin 800ms linear infinite;
}

.updates-footnote {
  width: min(100%, 410px);
  margin: 13px 0 0;
  color: var(--color-ink-3);
  font-family: var(--font-sans);
  font-size: 9.5px;
  line-height: 1.5;
}

@keyframes update-spin {
  to { transform: rotate(360deg); }
}

@keyframes update-progress-scan {
  from { transform: translateX(-100%); }
  to { transform: translateX(264%); }
}

@media (prefers-reduced-motion: reduce) {
  .update-spinner,
  .update-progress-indeterminate {
    animation: none;
  }

  .update-progress-fill {
    transition: none;
  }
}
</style>
