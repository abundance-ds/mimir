<template>
  <section data-tracker-settings class="font-sans text-ink">
    <div class="border-t border-rule-light">
      <SettingToggle
        data-attr="data-tracker-enabled"
        label="Enabled"
        :model-value="tracker.enabled"
        :disabled="tracker.loading"
        @update:model-value="toggleEnabled"
      />

      <template v-if="tracker.enabled">
        <SettingToggle
          data-attr="data-tracker-armed"
          label="Collect activity"
          :model-value="tracker.armed"
          @update:model-value="toggleArmed"
        />
        <SettingToggle
          label="Start at login"
          :model-value="config.launchAtLogin"
          @update:model-value="save({ launchAtLogin: $event })"
        />
        <SettingToggle
          label="Save window titles"
          :model-value="config.collectWindowTitles"
          :action-label="needsAccess ? 'Open Settings' : ''"
          @update:model-value="save({ collectWindowTitles: $event })"
          @action="requestAccess"
        />

        <SettingToggle
          label="Save browser domains"
          :model-value="config.collectBrowserDomains"
          @update:model-value="save({ collectBrowserDomains: $event })"
        />
        <SettingToggle
          label="AI classification"
          :model-value="config.classificationEnabled"
          @update:model-value="save({ classificationEnabled: $event })"
        />

        <template v-if="config.classificationEnabled">
          <SettingToggle
            nested
            label="Use window titles for AI"
            :model-value="config.includeWindowTitlesInAi"
            @update:model-value="save({ includeWindowTitlesInAi: $event })"
          />
          <NumberSetting
            data-attr="data-tracker-cost-cap"
            nested
            label="Daily AI budget"
            suffix="USD"
            :model-value="config.dailyCostCapUsd"
            :minimum="0"
            :maximum="100"
            :step="0.05"
            @commit="saveNumeric('dailyCostCapUsd', $event, 0, 100)"
          />
        </template>

        <SettingToggle
          label="Drift reminders"
          :model-value="config.nudgesEnabled"
          @update:model-value="save({ nudgesEnabled: $event })"
        />
        <NumberSetting
          v-if="config.nudgesEnabled"
          data-attr="data-tracker-grace"
          nested
          label="Reminder delay"
          suffix="min"
          :model-value="config.nudgeGraceMinutes"
          :minimum="0"
          :maximum="240"
          @commit="saveNumeric('nudgeGraceMinutes', $event, 0, 240)"
        />
      </template>
    </div>

    <p v-if="visibleError" class="mt-3 text-[11px] text-rem" role="alert">
      {{ visibleError }}
    </p>

    <div class="mt-5 border-t border-rule-light pt-3">
      <button
        v-if="!importOpen"
        type="button"
        data-tracker-import-open
        class="h-8 text-[11px] font-medium text-ink-3 hover:text-ink focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
        @click="importOpen = true"
      >
        Import Argus history…
      </button>

      <div v-else data-tracker-import-panel class="max-w-lg">
        <div class="flex items-center gap-3">
          <h3 class="min-w-0 flex-1 text-[12px] font-semibold text-ink">Import Argus history</h3>
          <button
            type="button"
            class="h-7 px-2 text-[11px] text-ink-3 hover:bg-chrome-mid hover:text-ink"
            @click="closeImport"
          >
            Cancel
          </button>
        </div>

        <template v-if="tracker.enabled">
          <div class="mt-3 flex items-center gap-3 border-y border-rule-light py-3">
            <span class="min-w-0 flex-1 text-[11px] text-ink-2">Turn Tracker off before import.</span>
            <button
              type="button"
              class="h-8 border border-rule px-3 text-[11px] font-medium text-ink-2 hover:bg-chrome-mid hover:text-ink"
              @click="toggleEnabled(false)"
            >
              Turn off
            </button>
          </div>
        </template>

        <template v-else>
          <button
            v-if="!preview"
            type="button"
            data-tracker-import-preview
            :disabled="importBusy"
            class="mt-3 h-8 border border-rule px-3 text-[11px] font-medium text-ink-2 hover:bg-chrome-mid hover:text-ink disabled:opacity-40"
            @click="previewImport"
          >
            {{ importBusy ? 'Reading…' : 'Inspect data' }}
          </button>

          <template v-else>
            <p data-tracker-import-summary class="mt-3 text-[11px] text-ink-2">
              {{ preview.totalBlocks.toLocaleString() }} activities and
              {{ preview.totalClassifications.toLocaleString() }} rules.
            </p>
            <p v-for="item in preview.diagnostics" :key="item" class="mt-1 text-[11px] text-rem">{{ item }}</p>
            <p v-if="preview.alreadyImported" class="mt-2 text-[11px] text-ink-3">Already imported.</p>
            <button
              v-else
              type="button"
              data-tracker-import
              :disabled="importBusy"
              class="mt-3 h-8 border border-accent/40 bg-accent px-3 text-[11px] font-semibold text-accent-ink hover:bg-accent-2 disabled:opacity-40"
              @click="runImport"
            >
              {{ importBusy ? 'Importing…' : 'Import' }}
            </button>
          </template>
        </template>

        <p v-if="importReport" class="mt-3 text-[11px] text-ink-2" role="status">
          Imported {{ importReport.importedBlocks.toLocaleString() }} activities and
          {{ importReport.importedClassifications.toLocaleString() }} rules.
        </p>
        <p v-if="error" class="mt-3 text-[11px] text-rem" role="alert">{{ error }}</p>
      </div>
    </div>
  </section>
</template>

<script setup>
import { computed, defineComponent, h, onMounted, ref } from 'vue'
import { useTrackerStore } from '../../../stores/tracker.js'

const SettingToggle = defineComponent({
  inheritAttrs: false,
  props: {
    label: { type: String, required: true },
    modelValue: { type: Boolean, default: false },
    disabled: { type: Boolean, default: false },
    nested: { type: Boolean, default: false },
    dataAttr: { type: String, default: '' },
    actionLabel: { type: String, default: '' },
  },
  emits: ['update:modelValue', 'action'],
  setup(props, { emit }) {
    return () => h('div', {
      class: ['setting-row', props.nested ? 'tracker-dependent' : ''],
    }, [
      h('span', { class: 'setting-label' }, props.label),
      props.actionLabel ? h('button', {
        type: 'button',
        'data-tracker-access-required': '',
        'data-tracker-request-access': '',
        class: 'mr-2 h-7 px-2 text-[10px] text-ink-3 hover:bg-chrome-mid hover:text-ink focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent',
        onClick: () => emit('action'),
      }, props.actionLabel) : null,
      h('button', {
        type: 'button',
        role: 'switch',
        'aria-label': props.label,
        'aria-checked': props.modelValue,
        disabled: props.disabled,
        ...(props.dataAttr ? { [props.dataAttr]: '' } : {}),
        class: ['toggle-switch', props.modelValue ? 'toggle-on' : '', 'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent disabled:opacity-40'],
        onClick: () => emit('update:modelValue', !props.modelValue),
      }, [h('span', { class: 'toggle-knob', 'aria-hidden': 'true' })]),
    ])
  },
})

const NumberSetting = defineComponent({
  inheritAttrs: false,
  props: {
    label: { type: String, required: true },
    suffix: { type: String, default: '' },
    modelValue: { type: Number, required: true },
    minimum: { type: Number, required: true },
    maximum: { type: Number, required: true },
    step: { type: Number, default: 1 },
    dataAttr: { type: String, default: '' },
    nested: { type: Boolean, default: false },
  },
  emits: ['commit'],
  setup(props, { emit }) {
    return () => h('label', {
      class: ['setting-row', props.nested ? 'tracker-dependent' : ''],
    }, [
      h('span', { class: 'setting-label' }, props.label),
      h('span', { class: 'flex items-center gap-2' }, [
        h('input', {
          type: 'number',
          value: props.modelValue,
          min: props.minimum,
          max: props.maximum,
          step: props.step,
          ...(props.dataAttr ? { [props.dataAttr]: '' } : {}),
          class: 'h-7 w-20 border border-rule bg-surface px-2 text-right font-mono text-[10px] text-ink outline-none focus:border-accent',
          onChange: event => emit('commit', event),
        }),
        props.suffix ? h('span', { class: 'w-7 text-[10px] text-ink-3' }, props.suffix) : null,
      ]),
    ])
  },
})

const tracker = useTrackerStore()
const error = ref('')
const preview = ref(null)
const importReport = ref(null)
const importBusy = ref(false)
const importOpen = ref(false)
const config = computed(() => tracker.status.config)
const needsAccess = computed(() => (
  tracker.status.permissions.accessibilityRequired
  && !tracker.status.permissions.accessibility
))
const visibleError = computed(() => (
  error.value || tracker.error || tracker.status.diagnostic || tracker.status.autostartDiagnostic || ''
))

onMounted(() => tracker.initialize().catch(cause => { error.value = message(cause) }))

async function toggleEnabled(value = !tracker.enabled) {
  await act(() => tracker.setEnabled(value))
}

async function toggleArmed(value = !tracker.armed) {
  await act(() => tracker.setArmed(value))
}

async function requestAccess() {
  await act(() => tracker.requestAccessibility())
}

async function save(patch) {
  await act(() => tracker.updateConfig(patch))
}

async function saveNumeric(key, event, minimum, maximum) {
  const raw = String(event.target.value || '').trim()
  const value = Number(raw)
  if (!raw || !Number.isFinite(value)) {
    event.target.value = String(config.value[key])
    return
  }
  await save({ [key]: Math.min(maximum, Math.max(minimum, value)) })
}

function closeImport() {
  importOpen.value = false
  preview.value = null
  importReport.value = null
  error.value = ''
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
.tracker-dependent {
  padding-left: 14px;
}
</style>
