<template>
  <section data-tracker-settings class="border-b border-rule-light bg-surface">
    <div class="grid gap-0 min-[560px]:grid-cols-[minmax(0,1fr)_190px]">
      <div class="px-3 py-3">
        <div class="flex items-start gap-3">
          <span
            class="mt-1 size-2 shrink-0 rounded-full"
            :class="tracker.enabled ? 'bg-add' : 'bg-ink-4'"
            aria-hidden="true"
          />
          <div class="min-w-0 flex-1">
            <p class="text-[10px] font-semibold text-ink">
              {{ tracker.enabled ? 'Collector enabled' : 'Collector off' }}
            </p>
            <p class="mt-0.5 text-[9px] leading-relaxed text-ink-3">
              {{ tracker.enabled
                ? 'Mimir keeps collecting after its window closes. Quit Mimir to stop the native runtime.'
                : 'No sampling, privacy prompts, AI calls, notifications, or menu-bar item run while off.' }}
            </p>
          </div>
          <button
            type="button"
            role="switch"
            data-tracker-enabled
            :aria-checked="tracker.enabled"
            :disabled="tracker.loading"
            class="relative h-5 w-9 shrink-0 border border-rule bg-chrome-mid focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent disabled:opacity-40"
            :class="{ 'border-accent bg-accent-soft': tracker.enabled }"
            @click="toggleEnabled"
          >
            <span
              class="absolute top-[2px] size-3.5 border border-rule bg-surface"
              :class="tracker.enabled ? 'left-[17px] border-accent' : 'left-[2px]'"
            />
            <span class="sr-only">{{ tracker.enabled ? 'Disable Tracker' : 'Enable Tracker' }}</span>
          </button>
        </div>

        <div
          v-if="tracker.enabled && needsAccess"
          data-tracker-access-required
          class="mt-3 flex items-start gap-2 border border-rem/25 bg-rem/5 px-2.5 py-2"
        >
          <IconLockAccess :size="13" class="mt-px shrink-0 text-rem" />
          <div class="min-w-0 flex-1">
            <p class="text-[9px] font-semibold text-ink">Window access is required</p>
            <p class="mt-0.5 text-[9px] leading-relaxed text-ink-3">
              macOS Accessibility lets Tracker read the front window title. Permission is requested only after enabling.
            </p>
          </div>
          <button
            type="button"
            data-tracker-request-access
            class="h-6 shrink-0 border border-rem/35 px-2 text-[9px] font-semibold text-rem hover:bg-rem/10"
            @click="requestAccess"
          >
            Open settings
          </button>
        </div>

        <p v-if="error || tracker.error" class="mt-2 text-[9px] text-rem" role="alert">
          {{ error || tracker.error }}
        </p>
        <p v-else-if="tracker.status.diagnostic" class="mt-2 text-[9px] text-rem" role="status">
          {{ tracker.status.diagnostic }}
        </p>
        <p v-else-if="tracker.status.autostartDiagnostic" class="mt-2 text-[9px] text-rem" role="status">
          {{ tracker.status.autostartDiagnostic }}
        </p>
      </div>

      <div class="border-t border-rule-light px-3 py-3 min-[560px]:border-l min-[560px]:border-t-0">
        <p class="font-mono text-[9px] uppercase tracking-[0.12em] text-ink-4">Runtime</p>
        <p class="mt-1 font-mono text-[10px] text-ink">{{ modeLabel }}</p>
        <p v-if="tracker.enabled && config.launchAtLogin" class="mt-1 text-[9px] text-ink-4">
          Login launch {{ tracker.status.launchAtLoginActive ? 'active' : 'pending' }}
        </p>
        <button
          v-if="tracker.enabled"
          type="button"
          data-tracker-armed
          class="mt-2 h-6 w-full border border-rule px-2 text-[9px] font-semibold text-ink-2 hover:border-accent/50 hover:bg-accent-soft"
          @click="toggleArmed"
        >
          {{ tracker.armed ? 'Pause collection' : 'Resume collection' }}
        </button>
      </div>
    </div>

    <details v-if="tracker.enabled" class="border-t border-rule-light">
      <summary class="cursor-pointer px-3 py-2 font-mono text-[9px] font-semibold uppercase tracking-[0.12em] text-ink-3 hover:bg-chrome-mid">
        Privacy, classification, and nudges
      </summary>
      <div class="grid border-t border-rule-light min-[620px]:grid-cols-2">
        <div class="divide-y divide-rule-light">
          <SettingToggle
            label="Launch Mimir at login"
            detail="Keeps the all-day timeline continuous; closing the window still leaves Tracker running."
            :model-value="config.launchAtLogin"
            @update:model-value="save({ launchAtLogin: $event })"
          />
          <SettingToggle
            label="Window titles"
            detail="Persist the title of the active window."
            :model-value="config.collectWindowTitles"
            @update:model-value="save({ collectWindowTitles: $event })"
          />
          <SettingToggle
            label="Browser domains"
            detail="Optional per-browser Automation access. Full URLs are never stored."
            :model-value="config.collectBrowserDomains"
            @update:model-value="save({ collectBrowserDomains: $event })"
          />
          <SettingToggle
            label="AI classification"
            detail="Batch unknown apps through Mimir’s configured model and keychain."
            :model-value="config.classificationEnabled"
            @update:model-value="save({ classificationEnabled: $event })"
          />
          <SettingToggle
            label="Send titles to AI"
            detail="Off by default. App and domain metadata still classify."
            :model-value="config.includeWindowTitlesInAi"
            @update:model-value="save({ includeWindowTitlesInAi: $event })"
          />
        </div>
        <div class="divide-y divide-rule-light border-t border-rule-light min-[620px]:border-l min-[620px]:border-t-0">
          <SettingToggle
            label="Drift nudges"
            detail="Notification after the grace period, with lunch and deep-work protection."
            :model-value="config.nudgesEnabled"
            @update:model-value="save({ nudgesEnabled: $event })"
          />
          <label class="grid grid-cols-[1fr_78px] items-center gap-3 px-3 py-2">
            <span>
              <span class="block text-[9px] font-semibold text-ink-2">Timezone</span>
              <span class="mt-0.5 block text-[9px] text-ink-4">Reports, lunch, and end-of-day rules.</span>
            </span>
            <input
              :value="config.timezone"
              data-tracker-timezone
              class="h-7 border border-rule bg-surface px-1.5 font-mono text-[9px] text-ink outline-none focus:border-accent"
              @change="save({ timezone: $event.target.value })"
            >
          </label>
          <label class="grid grid-cols-[1fr_78px] items-center gap-3 px-3 py-2">
            <span>
              <span class="block text-[9px] font-semibold text-ink-2">Nudge grace</span>
              <span class="mt-0.5 block text-[9px] text-ink-4">Minutes of protected leisure first.</span>
            </span>
            <input
              :value="config.nudgeGraceMinutes"
              data-tracker-grace
              type="number"
              min="0"
              max="240"
              class="h-7 border border-rule bg-surface px-1.5 font-mono text-[9px] text-ink outline-none focus:border-accent"
              @change="save({ nudgeGraceMinutes: Number($event.target.value) })"
            >
          </label>
          <label class="grid grid-cols-[1fr_78px] items-center gap-3 px-3 py-2">
            <span>
              <span class="block text-[9px] font-semibold text-ink-2">Daily AI cap</span>
              <span class="mt-0.5 block text-[9px] text-ink-4">USD; 0 disables paid calls.</span>
            </span>
            <input
              :value="config.dailyCostCapUsd"
              data-tracker-cost-cap
              type="number"
              min="0"
              max="100"
              step="0.05"
              class="h-7 border border-rule bg-surface px-1.5 font-mono text-[9px] text-ink outline-none focus:border-accent"
              @change="save({ dailyCostCapUsd: Number($event.target.value) })"
            >
          </label>
        </div>
      </div>
    </details>

    <details class="border-t border-rule-light">
      <summary class="cursor-pointer px-3 py-2 font-mono text-[9px] font-semibold uppercase tracking-[0.12em] text-ink-3 hover:bg-chrome-mid">
        Move history from Argus
      </summary>
      <div class="border-t border-rule-light px-3 py-3">
        <p class="text-[9px] leading-relaxed text-ink-3">
          Reads <code class="font-mono">~/.argus/activities.json</code> and classifications into SQLite.
          Source files stay untouched. Disable Tracker before importing to prevent overlapping timelines.
        </p>
        <div class="mt-2 flex flex-wrap items-center gap-2">
          <button
            type="button"
            data-tracker-import-preview
            :disabled="importBusy"
            class="h-7 border border-rule px-2.5 text-[9px] font-semibold text-ink-2 hover:bg-chrome-mid disabled:opacity-40"
            @click="previewImport"
          >
            Inspect Argus data
          </button>
          <button
            v-if="preview && !preview.alreadyImported"
            type="button"
            data-tracker-import
            :disabled="importBusy || tracker.enabled"
            class="h-7 border border-accent/40 bg-accent px-2.5 text-[9px] font-semibold text-accent-ink hover:bg-accent-2 disabled:opacity-40"
            @click="runImport"
          >
            Import {{ preview.totalBlocks.toLocaleString() }} blocks
          </button>
          <span v-if="importBusy" class="font-mono text-[9px] text-ink-4">Reading…</span>
        </div>
        <div v-if="preview" data-tracker-import-summary class="mt-2 border border-rule-light bg-chrome-high px-2.5 py-2">
          <p class="font-mono text-[9px] text-ink-2">
            {{ preview.totalBlocks.toLocaleString() }} blocks ·
            {{ preview.totalClassifications.toLocaleString() }} rules ·
            {{ preview.alreadyImported ? 'already imported' : 'ready' }}
          </p>
          <p v-for="item in preview.diagnostics" :key="item" class="mt-1 text-[9px] text-ink-3">{{ item }}</p>
        </div>
        <p v-if="importReport" class="mt-2 text-[9px] text-add" role="status">
          Imported {{ importReport.importedBlocks.toLocaleString() }} blocks and
          {{ importReport.importedClassifications.toLocaleString() }} classifications.
        </p>
      </div>
    </details>
  </section>
</template>

<script setup>
import { computed, defineComponent, h, onMounted, ref } from 'vue'
import { IconLockAccess } from '@tabler/icons-vue'
import { useTrackerStore } from '../../../stores/tracker.js'

const SettingToggle = defineComponent({
  props: {
    label: { type: String, required: true },
    detail: { type: String, default: '' },
    modelValue: { type: Boolean, default: false },
  },
  emits: ['update:modelValue'],
  setup(props, { emit }) {
    return () => h('label', {
      class: 'flex cursor-pointer items-start gap-3 px-3 py-2 hover:bg-chrome-mid',
    }, [
      h('span', { class: 'min-w-0 flex-1' }, [
        h('span', { class: 'block text-[9px] font-semibold text-ink-2' }, props.label),
        h('span', { class: 'mt-0.5 block text-[9px] leading-relaxed text-ink-4' }, props.detail),
      ]),
      h('input', {
        type: 'checkbox',
        checked: props.modelValue,
        class: 'mt-0.5 size-3.5 accent-accent',
        onChange: event => emit('update:modelValue', event.target.checked),
      }),
    ])
  },
})

const tracker = useTrackerStore()
const error = ref('')
const preview = ref(null)
const importReport = ref(null)
const importBusy = ref(false)
const config = computed(() => tracker.status.config)
const needsAccess = computed(() => (
  tracker.status.permissions.accessibilityRequired
  && !tracker.status.permissions.accessibility
))
const modeLabel = computed(() => ({
  disabled: 'Off',
  'needs-access': 'Needs access',
  paused: 'Paused',
  armed: 'Armed',
  break: 'Break running',
  unsupported: 'Unsupported platform',
  error: 'Needs attention',
})[tracker.mode] || tracker.mode)

onMounted(() => tracker.initialize().catch(cause => { error.value = message(cause) }))

async function toggleEnabled() {
  await act(() => tracker.setEnabled(!tracker.enabled))
}

async function toggleArmed() {
  await act(() => tracker.setArmed(!tracker.armed))
}

async function requestAccess() {
  await act(() => tracker.requestAccessibility())
}

async function save(patch) {
  await act(() => tracker.updateConfig(patch))
}

async function previewImport() {
  importBusy.value = true
  error.value = ''
  try {
    preview.value = await tracker.previewImport({ timezone: config.value.timezone })
  } catch (cause) {
    error.value = message(cause)
  } finally {
    importBusy.value = false
  }
}

async function runImport() {
  importBusy.value = true
  error.value = ''
  try {
    importReport.value = await tracker.importArgus({ timezone: config.value.timezone })
    await tracker.refresh()
  } catch (cause) {
    error.value = message(cause)
  } finally {
    importBusy.value = false
  }
}

async function act(operation) {
  error.value = ''
  try {
    await operation()
  } catch (cause) {
    error.value = message(cause)
  }
}

function message(cause) {
  return cause instanceof Error ? cause.message : String(cause || 'Tracker settings could not be saved.')
}
</script>

<style scoped>
button:focus-visible,
summary:focus-visible {
  outline: 1px solid var(--color-accent);
  outline-offset: -1px;
}
</style>
